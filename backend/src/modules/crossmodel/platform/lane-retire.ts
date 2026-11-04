/**
 * lane-retire — R6 ACTS (lane lifecycle area C1, 2026-10-21).
 *
 * WHY: nothing retired an idle TOP-LEVEL lane by default. The run-reaper's
 * child rules (e)/(h) key on parentChatId, so ticket / family lanes, Fleet-
 * spawned lanes and every other parentless lane were never reaped; the
 * idle-chat archiver is a per-folder opt-in (only one prod folder set it); the
 * R6 retire scan (session-topology-outcomes) only wrote telemetry. Prod probe
 * LLC1021 (2026-10-21): 49 R6 candidates over 64 projects, 258 of 311 R6 rows
 * in 7 d still unarchived, 47 of them in folders with the archiver off.
 *
 * WHAT: the R6 scan hands its candidates here. A candidate is archived — through
 * platform.service archiveChat, so every guard / audit / hook / todo-unassign
 * side effect stays uniform — only when ALL of these hold on a FRESH read:
 *   1 not a supervisor                    8 no active, unexpired share link
 *   2 nothing running (satellite running / 9 not the standing engineering lane
 *     provisioning, or an agent run         (PLATFORM_ENGINEER_CHAT_ID)
 *     queued | running | interrupted)     10 not the CURRENT lane of a ticket
 *   3 no enabled schedule (any author —      still open / in progress / queued /
 *     an owner-armed cadence is never        reopened / awaiting verification
 *     paused or cancelled here)              (the ticket dispatcher owns it)
 *   4 its charter is closed (charterOpen)  11 idle ≥ LANE_RETIRE_IDLE_MS (7 d):
 *   5 it holds no open assigned todo          the newest of chat creation, agent
 *   6 its title is not pinned by a human      run update, message (any role) and
 *   7 its folder is not archived (a folder    receipt — never chat.updatedAt,
 *     restore must bring back what it hid)    which machine writes bump
 *                                           12 no human message in 14 d (a
 *                                              user row whose origin is not a
 *                                              machine origin)
 *                                           13 it is PROVEN machine-spawned
 * Review fixer (2026-10-21) — four more, each a fresh batched read that reads
 * BLOCKING when it fails:
 *  14 no open todo assigned to it in ANY project (the index's todo leg is
 *     project-scoped; a cross-project assignment would be unassigned by the
 *     archive and wake the other project's supervisor);
 *  15 not waiting on the owner — no open owner question, no pending unexpired
 *     confirmation (the answer would re-route to a supervisor);
 *  16 no LIVE descendant (≤ 3 levels: a queued / running / interrupted run, an
 *     enabled schedule, a running / provisioning satellite) — archiving pauses
 *     the result hook that descendant reports through;
 *  17 never RESTORED — neither it nor a descendant carries the restore marker
 *     archiveChat writes on a restore (lane-family-facts). A restored lane is
 *     the owner's; without this the next pass archived it (and its cascade)
 *     again within 6 h.
 * Second review fixer (2026-10-21):
 *  18 no INBOUND INTEGRATION — an active ChatWebhook or an enabled non-system
 *     event hook targeting it (archiving pauses those hooks and a webhook send
 *     to an archived chat answers 409 — the payload is dropped);
 *  17b the RESTORE AUDIT: a lane every other rule admits is re-read against the
 *     `chat.restore` Activity rows (readRestoreAuditChats) — a restore made
 *     before the marker shipped, or while its readers were off, counts too;
 *  the pass cap counts the CASCADE: LANE_RETIRE_MAX_PER_PASS bounds the lanes
 *     archived plus the idle children their archive cascade takes (one shared
 *     budget handed to archiveChat).
 * Machine-spawn proof (`proveMachineSpawned`; the SAME rules the display-parent
 * backfill uses — keep them identical):
 *   p1 a delegation_tasks row with childChatId = the chat and kind 'ticket', or
 *      kind 'session' with origin 'machine' (the ledger exists since 2026-10-08);
 *   p2 a ticket names it: context.dispatchedTo = the chat, or context.previousLanes
 *      contains it (fresh lanes, family lanes, legacy batch sessions);
 *   p3 its parentChatId is a Fleet / Project Supervisor chat;
 *   p4 its FIRST user message carries metadata.origin agent | webhook | schedule |
 *      hook | machine (missing / 'user' = human) — a 'webhook' first message
 *      is not proof while the chat carries a ChatWebhook row (the owner armed
 *      that webhook; second review fixer).
 * NOT proof: chat_coding_state.titleSource — the web client's new-chat path
 * sends the title 'New chat', which stamps 'spawn-param' — and a session made
 * through the platform REST API with an API key (no prompt origin, its first
 * message reads 'user'). Those count as OWNER-CREATED and stay: an owner's chat
 * is archived only by the idle-chat archiver in a folder that opted in.
 *
 * Bounded: ≤ LANE_RETIRE_EVAL_MAX_PER_PASS candidates evaluated and ≤
 * LANE_RETIRE_MAX_PER_PASS archived per pass, the evaluation window rotating by
 * lane id so a long tail of ineligible candidates cannot starve the rest.
 * Candidates come from `collectRetireCandidates` — a CODING-lanes-only walk of
 * the project by id (≤ LANE_RETIRE_SCAN_MAX_PAGES pages of 200 per pass,
 * resuming where a capped pass stopped), never the placement index's 200
 * most-recently-updated chats, which plain chats crowd and which the long-idle
 * lanes this module retires fall off first.
 * Archiving is reversible (Restore / archive_chat archived:false). Every export
 * NEVER throws. Telemetry loop_metrics `lane_retired` {phase: archived | pass}.
 * Kill switch LANE_IDLE_RETIRE_DISABLED=1 (session-topology.ts reads it): the
 * R6 scan is observe-only again.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { getArchiveHiddenProjectIds } from '../archive-scope';
import { LOOP_METRIC_KINDS, recordLoopMetric } from './loop-metrics.service';
import { buildLaneIndex, laneIdleRetireDisabled, retireCandidates, SESSION_TOPOLOGY_MAX_LANES, type LaneIndexRow } from './session-topology';
import {
  readLaneFamilyFacts, readInboundIntegrations, proveMachineSpawned, isHumanUserRow, shareLinkIsActive,
  MACHINE_FIRST_ORIGINS, LANE_OWNING_TICKET_STATUSES, LANE_HUMAN_WINDOW_MS, archiveCascadeDisabled, type MachineSpawnProof, type RestoreAuditCache,
} from './lane-family-facts';

export { laneIdleRetireDisabled };
// Moved to the lane-family-facts leaf (second review fixer 2026-10-21) so the
// archive cascade and the ticket drain read the same rules without this
// module's session-topology chain; re-exported here unchanged.
export { proveMachineSpawned, isHumanUserRow, shareLinkIsActive, MACHINE_FIRST_ORIGINS, LANE_OWNING_TICKET_STATUSES, type MachineSpawnProof };

// ── Tunables ─────────────────────────────────────────────────────────────────

/** A lane must be this idle (newest run / message / receipt / creation) before it is archived. */
export const LANE_RETIRE_IDLE_MS = 7 * 86400_000;
/** A human message inside this window keeps the lane (the lane-family-facts LANE_HUMAN_WINDOW_MS). */
export const LANE_RETIRE_HUMAN_WINDOW_MS = LANE_HUMAN_WINDOW_MS;
/** Chats archived per pass, total — the retired lanes AND the idle children their archive cascade takes (second review fixer). */
export const LANE_RETIRE_MAX_PER_PASS = 25;
/** Candidates evaluated per pass, total (the window rotates by lane id). */
export const LANE_RETIRE_EVAL_MAX_PER_PASS = 150;
/** The acting scan's project discovery: projects with a coding chat updated in this window … */
export const LANE_RETIRE_PROJECT_LOOKBACK_MS = 180 * 86400_000;
/** … newest first, at most this many. */
export const LANE_RETIRE_MAX_PROJECTS = 100;
/** Cap on the 14-day user-row read; a full page with no human row found reads human (fail-safe). */
export const LANE_RETIRE_HUMAN_ROWS_CAP = 5000;
/** Candidate-scan pages (of SESSION_TOPOLOGY_MAX_LANES coding lanes, by id) per project per pass. */
export const LANE_RETIRE_SCAN_MAX_PAGES = 10;
const OPEN_TODO_STATUSES = ['pending', 'in_progress', 'blocked'];

// ── Types ────────────────────────────────────────────────────────────────────

export type LaneRetireReason =
  | 'supervisor' | 'running' | 'schedule' | 'live_child' | 'charter_open' | 'open_todos' | 'awaiting_owner' | 'title_pinned'
  | 'owner_restored' | 'archived_folder' | 'share_link' | 'inbound_integration' | 'standing_lane' | 'ticket_owned' | 'not_idle' | 'human_recent'
  | 'owner_created' | 'eligible';

/** The fresh per-lane read the evaluator decides on (the index row is only the hint). */
export interface LaneRetireFacts {
  isSupervisor: boolean;
  satelliteStatus: string | null;
  /** an agent run queued | running | interrupted */
  liveRun: boolean;
  enabledSchedules: number;
  /** an unarchived descendant (≤ 3 levels) with a live run / enabled schedule / running satellite */
  liveDescendant: boolean;
  /** an open todo assigned to it in ANY project (the index's todo leg is project-scoped) */
  openTodos: boolean;
  /** an open owner question or a pending, unexpired confirmation on it */
  awaitingOwner: boolean;
  titlePinned: boolean;
  /** it, or a descendant, was restored from the archive (the lane-family-facts marker) */
  ownerRestored: boolean;
  archivedFolder: boolean;
  shareLinkActive: boolean;
  /** an active ChatWebhook, or an enabled non-system event hook targeting it (lane-family-facts readInboundIntegrations) */
  inboundIntegration: boolean;
  standingLane: boolean;
  ticketOwned: boolean;
  /** newest of chat.createdAt, agent_run.updatedAt, crossmodel_messages.createdAt (any role), run_tool_receipts.createdAt */
  lastActivityAt: Date | null;
  humanRecent: boolean;
  /** absent / null = no machine-spawn proof (owner-created) */
  proof?: MachineSpawnProof | null;
  projectId: string | null;
  parentChatId: string | null;
  userId: string;
}

export interface LaneRetireCandidate { lane: LaneIndexRow; projectId: string; userId: string }

export interface LaneRetireVerdict {
  laneId: string;
  title: string;
  projectId: string;
  userId: string;
  eligible: boolean;
  /** a LaneRetireReason, or 'unverified' when the fresh read did not land (chat gone / archived / read failed) */
  reason: LaneRetireReason | 'unverified';
  proof: MachineSpawnProof | null;
  idleDays: number | null;
  parentChatId: string | null;
}

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * The retire verdict for one lane. Pure. Skip reasons are checked in a fixed
 * order (the first that applies is the reason); `eligible` only when none does.
 */
export function evaluateLaneRetire(lane: LaneIndexRow, facts: LaneRetireFacts, now: Date = new Date()): { eligible: boolean; reason: LaneRetireReason } {
  const skip = (reason: LaneRetireReason) => ({ eligible: false, reason });
  if (lane.isSupervisor || facts.isSupervisor) return skip('supervisor');
  if (lane.running || facts.liveRun || facts.satelliteStatus === 'running' || facts.satelliteStatus === 'provisioning') return skip('running');
  if (lane.enabledSchedules > 0 || facts.enabledSchedules > 0) return skip('schedule');
  if (facts.liveDescendant) return skip('live_child');
  if (lane.charterOpen) return skip('charter_open');
  if (lane.goalIds.length > 0 || facts.openTodos) return skip('open_todos');
  if (facts.awaitingOwner) return skip('awaiting_owner');
  if (lane.titlePinned || facts.titlePinned) return skip('title_pinned');
  if (facts.ownerRestored) return skip('owner_restored');
  if (facts.archivedFolder) return skip('archived_folder');
  if (facts.shareLinkActive) return skip('share_link');
  if (facts.inboundIntegration) return skip('inbound_integration');
  if (facts.standingLane) return skip('standing_lane');
  if (facts.ticketOwned) return skip('ticket_owned');
  if (!facts.lastActivityAt || now.getTime() - facts.lastActivityAt.getTime() < LANE_RETIRE_IDLE_MS) return skip('not_idle');
  if (facts.humanRecent) return skip('human_recent');
  if (!facts.proof) return skip('owner_created');
  return { eligible: true, reason: 'eligible' };
}

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});
/** A read that fails answers null. A thunk also catches a synchronous throw (a client missing the model). */
async function leg<T>(p: Promise<T> | (() => Promise<T>)): Promise<T | null> {
  try { return await (typeof p === 'function' ? p() : p); } catch { return null; }
}
const standingLaneId = (): string => String(process.env.PLATFORM_ENGINEER_CHAT_ID ?? '').trim();

// ── Facts (fresh, batched) ───────────────────────────────────────────────────

/**
 * The fresh per-lane read for the evaluator. A chat that is gone or already
 * archived (or whose chat read failed) is absent from the map. Every other leg
 * that fails reads BLOCKING for its lanes (live run, schedule, share link,
 * archived folder, ticket-owned, not idle, human, open todo, awaiting owner,
 * live descendant, restored, inbound integration) — a lane is never archived on a read we did not
 * get. Never throws.
 */
export async function gatherLaneRetireFacts(ids: string[], now: Date = new Date()): Promise<Map<string, LaneRetireFacts>> {
  const out = new Map<string, LaneRetireFacts>();
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return out;
  const chats = await leg(prisma.crossModelChat.findMany({
    where: { id: { in: want }, archivedAt: null },
    select: { id: true, userId: true, projectId: true, parentChatId: true, isSupervisor: true, isProjectSupervisor: true, titlePinned: true, createdAt: true },
  }));
  if (!chats?.length) return out;
  const live = chats.map((c) => c.id);
  const d14 = new Date(now.getTime() - LANE_RETIRE_HUMAN_WINDOW_MS);
  const [states, liveRuns, schedules, shares, owning, runMax, msgMax, receiptMax, userRows, openTodos, ownerQuestions, confirmations, family, inbound] = await Promise.all([
    leg(prisma.chatCodingState.findMany({ where: { id: { in: live } }, select: { id: true, status: true } })),
    leg(prisma.agentRun.findMany({ where: { sessionId: { in: live }, status: { in: ['queued', 'running', 'interrupted'] } }, select: { sessionId: true } })),
    leg(prisma.codingSchedule.groupBy({ by: ['sessionId'], where: { sessionId: { in: live }, enabled: true }, _count: { _all: true } } as any) as Promise<any[]>),
    leg(prisma.chatShareLink.findMany({ where: { chatId: { in: live } }, select: { chatId: true, isActive: true, expiresAt: true } })),
    leg(prisma.userFeatureRequest.findMany({
      where: { status: { in: [...LANE_OWNING_TICKET_STATUSES] }, OR: live.map((id) => ({ context: { path: ['dispatchedTo'], equals: id } })) },
      select: { context: true },
    })),
    leg(prisma.agentRun.groupBy({ by: ['sessionId'], where: { sessionId: { in: live } }, _max: { updatedAt: true } } as any) as Promise<any[]>),
    leg(prisma.crossModelMessage.groupBy({ by: ['chatId'], where: { chatId: { in: live } }, _max: { createdAt: true } } as any) as Promise<any[]>),
    leg(prisma.runToolReceipt.groupBy({ by: ['chatId'], where: { chatId: { in: live } }, _max: { createdAt: true } } as any) as Promise<any[]>),
    leg(prisma.crossModelMessage.findMany({ where: { chatId: { in: live }, role: 'user', createdAt: { gte: d14 } }, select: { chatId: true, metadata: true }, take: LANE_RETIRE_HUMAN_ROWS_CAP })),
    // Review fixer (2026-10-21): open todos in ANY project, the owner-parked lanes, the family.
    leg(() => prisma.projectTodo.findMany({ where: { assigneeChatId: { in: live }, status: { in: OPEN_TODO_STATUSES } }, select: { assigneeChatId: true } })),
    leg(() => prisma.ownerQuestion.findMany({ where: { chatId: { in: live }, status: 'open' }, select: { chatId: true } })),
    leg(() => prisma.pendingConfirmation.findMany({ where: { chatId: { in: live }, status: 'pending', expiresAt: { gt: now } }, select: { chatId: true } })),
    readLaneFamilyFacts(live),
    // Second review fixer (2026-10-21): an owner-armed inbound integration (webhook / wake hook).
    readInboundIntegrations(live),
  ]);
  // Archived folders — one read per owner; a failed read hides every folder of that owner.
  const hiddenByUser = new Map<string, Set<string> | null>();
  for (const u of [...new Set(chats.map((c) => c.userId))]) {
    const hidden = await leg(getArchiveHiddenProjectIds(u));
    hiddenByUser.set(u, hidden ? new Set(hidden) : null);
  }
  const stateBy = new Map((states ?? []).map((s: any) => [s.id, String(s.status ?? '')]));
  const liveSet = new Set((liveRuns ?? []).map((r: any) => String(r.sessionId)));
  const schedBy = new Map((schedules ?? []).map((r: any) => [String(r.sessionId), Number(r._count?._all ?? 0)]));
  const shareBy = new Map((shares ?? []).map((s: any) => [String(s.chatId), s]));
  const ownedSet = new Set((owning ?? []).map((r: any) => String(asRecord(r.context).dispatchedTo ?? '')).filter(Boolean));
  const maxBy = (rows: any[] | null, key: string, field: string): Map<string, Date> => {
    const m = new Map<string, Date>();
    for (const r of rows ?? []) { const v = r?._max?.[field]; if (v) m.set(String(r[key]), new Date(v)); }
    return m;
  };
  const runAt = maxBy(runMax, 'sessionId', 'updatedAt');
  const msgAt = maxBy(msgMax, 'chatId', 'createdAt');
  const receiptAt = maxBy(receiptMax, 'chatId', 'createdAt');
  const humanSet = new Set<string>();
  for (const r of userRows ?? []) if (isHumanUserRow(r.metadata)) humanSet.add(String(r.chatId));
  const humanCapped = !!userRows && userRows.length >= LANE_RETIRE_HUMAN_ROWS_CAP;
  const todoSet = new Set((openTodos ?? []).map((t: any) => String(t.assigneeChatId ?? '')).filter(Boolean));
  const ownerSet = new Set([...(ownerQuestions ?? []), ...(confirmations ?? [])].map((r: any) => String(r.chatId ?? '')).filter(Boolean));
  const standing = standingLaneId();
  for (const c of chats) {
    const hidden = hiddenByUser.get(c.userId);
    const activity = [c.createdAt, runAt.get(c.id), msgAt.get(c.id), receiptAt.get(c.id)].filter((d): d is Date => !!d);
    out.set(c.id, {
      isSupervisor: c.isSupervisor === true || c.isProjectSupervisor === true,
      satelliteStatus: states ? (stateBy.get(c.id) ?? null) : 'running',
      liveRun: liveRuns ? liveSet.has(c.id) : true,
      enabledSchedules: schedules ? (schedBy.get(c.id) ?? 0) : 1,
      liveDescendant: family ? family.liveRoots.has(c.id) : true,
      openTodos: openTodos ? todoSet.has(c.id) : true,
      awaitingOwner: ownerQuestions && confirmations ? ownerSet.has(c.id) : true,
      titlePinned: c.titlePinned === true,
      ownerRestored: family ? family.restoredRoots.has(c.id) : true,
      archivedFolder: hidden == null ? true : !!(c.projectId && hidden.has(c.projectId)),
      shareLinkActive: shares ? shareLinkIsActive(shareBy.get(c.id), now) : true,
      inboundIntegration: inbound ? inbound.has(c.id) : true,
      standingLane: !!standing && c.id === standing,
      ticketOwned: owning ? ownedSet.has(c.id) : true,
      // A failed activity leg reads "active now" — never idle on a missing read.
      lastActivityAt: runMax && msgMax && receiptMax ? new Date(Math.max(...activity.map((d) => d.getTime()))) : now,
      humanRecent: !userRows ? true : humanSet.has(c.id) || humanCapped,
      projectId: c.projectId ?? null,
      parentChatId: c.parentChatId ?? null,
      userId: c.userId,
    });
  }
  return out;
}

// ── Archive ──────────────────────────────────────────────────────────────────

/**
 * Archive ONE lane through archiveChat (source 'lane_retire' on the audit row).
 * Re-reads archivedAt first. A 4xx refusal (a run started / a schedule got
 * enabled in the race window) is a skip, never a throw.
 */
export async function archiveIdleLane(opts: { userId: string; chatId: string; cascadeBudget?: { remaining: number }; restoreAuditCache?: RestoreAuditCache }): Promise<{ archived: boolean; skip?: string }> {
  try {
    const fresh = await prisma.crossModelChat.findUnique({ where: { id: opts.chatId }, select: { archivedAt: true, userId: true } });
    if (!fresh || fresh.userId !== opts.userId) return { archived: false, skip: 'gone' };
    if (fresh.archivedAt) return { archived: false, skip: 'already_archived' };
    const { archiveChat } = await import('./platform.service');
    // Third review (2026-10-22): the cascade applies this module's own idle bar (7 d) to every child.
    // Fifth review (2026-10-22): + the pass's restore-audit memo (the cascade's children are read once per pass).
    await archiveChat({ userId: opts.userId, chatId: opts.chatId, source: 'lane_retire', ...(opts.cascadeBudget ? { cascadeBudget: opts.cascadeBudget } : {}), cascadeIdleMs: LANE_RETIRE_IDLE_MS, ...(opts.restoreAuditCache ? { restoreAuditCache: opts.restoreAuditCache } : {}) });
    return { archived: true };
  } catch (err: any) {
    const status = Number(err?.statusCode);
    if (status && status < 500) {
      logger.info(`lane-retire: chat ${opts.chatId} refused (${status}: ${err?.message ?? err}) — skipped`);
      return { archived: false, skip: `refused_${status}` };
    }
    logger.warn(`lane-retire: chat ${opts.chatId} archive attempt failed (non-fatal): ${err?.message ?? err}`);
    return { archived: false, skip: 'error' };
  }
}

// ── Candidates (the acting scan's own walk) ──────────────────────────────────

/** Per-project resume point for a scan capped at LANE_RETIRE_SCAN_MAX_PAGES (the last lane id it reached). */
const scanCursorByProject = new Map<string, string>();
export function __resetLaneRetireScanCursorsForTests(): void { scanCursorByProject.clear(); }

/**
 * The R6 candidates of ONE project for the acting pass: every CODING lane,
 * walked by id in pages of SESSION_TOPOLOGY_MAX_LANES (buildLaneIndex `scan`
 * mode — plain chats never fill a page, no plan reads), ≤
 * LANE_RETIRE_SCAN_MAX_PAGES pages per pass; a capped walk resumes after its
 * last lane next pass and starts over once it reaches the end. A PARTIAL page
 * (a failed / timed-out leg) feeds nothing (the walk passes it again next
 * time); a page whose chat read failed ends the walk. `persistCursor: false`
 * (the read-only preview) leaves the resume point alone. Never throws.
 */
export async function collectRetireCandidates(
  projectId: string, userId: string, now: Date = new Date(), opts: { persistCursor?: boolean } = {},
): Promise<{ candidates: LaneRetireCandidate[]; pages: number; partialPages: number; truncated: boolean }> {
  const candidates: LaneRetireCandidate[] = [];
  let pages = 0;
  let partialPages = 0;
  let truncated = false;
  const persist = opts.persistCursor !== false;
  let afterId: string | null = scanCursorByProject.get(projectId) ?? null;
  try {
    for (;;) {
      if (pages >= LANE_RETIRE_SCAN_MAX_PAGES) { truncated = true; break; }
      const index = await buildLaneIndex(projectId, userId, { now, scan: { afterId } });
      pages++;
      if (index.partial) partialPages++;
      if (!index.lanes.length) break;
      if (!index.partial) {
        const byId = new Map(index.lanes.map((l) => [l.laneId, l]));
        for (const c of retireCandidates(index.lanes, { now })) {
          const lane = byId.get(c.laneId);
          if (lane) candidates.push({ lane, projectId, userId });
        }
      }
      if (index.lanes.length < SESSION_TOPOLOGY_MAX_LANES) { afterId = null; break; }
      afterId = index.lanes[index.lanes.length - 1].laneId;
    }
    if (persist) {
      if (truncated && afterId) scanCursorByProject.set(projectId, afterId);
      else scanCursorByProject.delete(projectId);
    }
  } catch (err: any) {
    logger.warn(`lane-retire: candidate scan for project ${projectId} failed (non-fatal): ${err?.message ?? err}`);
  }
  return { candidates, pages, partialPages, truncated };
}

// ── Pass ─────────────────────────────────────────────────────────────────────

/** The rotating evaluation window's cursor (the last lane id the previous pass reached). */
let retireCursor: string | null = null;
export function __resetLaneRetireCursorForTests(): void { retireCursor = null; }

/** The evaluation window over the candidates: sorted by lane id, starting after the cursor, wrapping. Pure. */
export function rotateRetireWindow<T extends { lane: { laneId: string } }>(candidates: T[], cursor: string | null, max: number): T[] {
  const sorted = [...candidates].sort((a, b) => (a.lane.laneId < b.lane.laneId ? -1 : a.lane.laneId > b.lane.laneId ? 1 : 0));
  const start = cursor ? sorted.findIndex((c) => c.lane.laneId > cursor) : 0;
  const from = start < 0 ? 0 : start;
  return [...sorted.slice(from), ...sorted.slice(0, from)].slice(0, max);
}

/**
 * Verdicts for a candidate list — READ-ONLY (the preview script and the pass
 * share it). Proof is read only for lanes every other rule already admits.
 */
export async function previewLaneRetire(candidates: LaneRetireCandidate[], now: Date = new Date()): Promise<LaneRetireVerdict[]> {
  const byId = new Map<string, LaneRetireCandidate>();
  for (const c of candidates) if (!byId.has(c.lane.laneId)) byId.set(c.lane.laneId, c);
  const ids = [...byId.keys()];
  const facts = await gatherLaneRetireFacts(ids, now);
  const first = ids.map((id) => {
    const f = facts.get(id);
    return { id, f, verdict: f ? evaluateLaneRetire(byId.get(id)!.lane, f, now) : null };
  });
  // Only lanes that fail on the proof alone need it read.
  const needProof = first.filter((x) => x.verdict?.reason === 'owner_created').map((x) => x.id);
  const proofs = needProof.length ? await proveMachineSpawned(needProof) : new Map<string, MachineSpawnProof>();
  const finals = first.map(({ id, f, verdict }) => {
    const c = byId.get(id)!;
    const proof = proofs.get(id) ?? null;
    const final = f && verdict ? (verdict.reason === 'owner_created' ? evaluateLaneRetire(c.lane, { ...f, proof }, now) : verdict) : null;
    return { id, f, proof, final };
  });
  // Second review fixer (2026-10-21) — the RESTORE AUDIT, for the lanes every
  // other rule admits only (it reads the owners' Activity rows): a `chat.restore`
  // newer than the last `chat.archive`, on the lane or a descendant, is a restore
  // the marker never recorded (made before the marker shipped, or while every
  // marker reader was off). A failed read keeps them all (fail-safe).
  const eligibleIds = finals.filter((x) => x.final?.eligible).map((x) => x.id);
  if (eligibleIds.length) {
    const audit = await readLaneFamilyFacts(eligibleIds, { restoreAudit: true, now });
    for (const x of finals) {
      if (!x.final?.eligible || !x.f) continue;
      if (!audit || audit.restoredRoots.has(x.id)) x.final = evaluateLaneRetire(byId.get(x.id)!.lane, { ...x.f, proof: x.proof, ownerRestored: true }, now);
    }
  }
  return finals.map(({ id, f, proof, final }) => {
    const c = byId.get(id)!;
    const idleDays = f?.lastActivityAt ? Math.floor((now.getTime() - f.lastActivityAt.getTime()) / 86400_000) : null;
    return {
      laneId: id, title: c.lane.title, projectId: c.projectId, userId: c.userId,
      eligible: !!final?.eligible, reason: final ? final.reason : 'unverified', proof, idleDays, parentChatId: f?.parentChatId ?? null,
    };
  });
}

/**
 * One acting pass: evaluate ≤ LANE_RETIRE_EVAL_MAX_PER_PASS candidates (the
 * rotating window), archive eligible ones while the pass budget lasts
 * (LANE_RETIRE_MAX_PER_PASS chats, the lanes AND the children their cascade
 * takes), write one
 * `lane_retired` row per archived lane + one per pass. Never throws.
 */
export async function retireIdleLanes(candidates: LaneRetireCandidate[], now: Date = new Date()): Promise<{ considered: number; archived: number; cascaded: number; skipped: Record<string, number> }> {
  const skipped: Record<string, number> = {};
  let considered = 0;
  let archived = 0;
  // Second review fixer (2026-10-21): ONE pass-wide budget — every lane this
  // pass archives costs 1, and archiveChat's cascade spends the same budget on
  // each idle child it takes (a root's cascade used to be uncounted: 25 roots ×
  // 25 children × 3 levels).
  const budget = { remaining: LANE_RETIRE_MAX_PER_PASS };
  let cascaded = 0;
  if (laneIdleRetireDisabled()) return { considered, archived, cascaded, skipped };
  // Fifth review (2026-10-22): one restore-audit memo per pass for every cascade the pass starts (cascade on only).
  const passAuditCache: RestoreAuditCache | undefined = archiveCascadeDisabled() ? undefined : new Map();
  try {
    const window = rotateRetireWindow(candidates, retireCursor, LANE_RETIRE_EVAL_MAX_PER_PASS);
    considered = window.length;
    const verdicts = await previewLaneRetire(window, now);
    let lastArchived: string | null = null;
    let capHit = false;
    for (const v of verdicts) {
      if (!v.eligible) { skipped[v.reason] = (skipped[v.reason] ?? 0) + 1; continue; }
      if (budget.remaining <= 0) { capHit = true; skipped.pass_cap = (skipped.pass_cap ?? 0) + 1; continue; }
      // The root's own archive is paid for up front; its cascade spends the rest of the budget.
      budget.remaining--;
      const before = budget.remaining;
      const r = await archiveIdleLane({ userId: v.userId, chatId: v.laneId, cascadeBudget: budget, ...(passAuditCache ? { restoreAuditCache: passAuditCache } : {}) });
      if (!r.archived) { budget.remaining = before + 1; const k = r.skip ?? 'error'; skipped[k] = (skipped[k] ?? 0) + 1; continue; }
      cascaded += Math.max(0, before - budget.remaining);
      archived++;
      lastArchived = v.laneId;
      logger.info(`lane-retire: archived idle lane ${v.laneId} (project ${v.projectId}, idle ${v.idleDays ?? '?'} d, proof ${v.proof})`);
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.LANE_RETIRED, sessionId: v.laneId, meta: { phase: 'archived', proof: v.proof, idleDays: v.idleDays, projectId: v.projectId, parentChatId: v.parentChatId } });
    }
    // Cursor: a capped pass resumes right after the last lane it archived (the
    // capped eligible ones come first next time); otherwise past the window, or
    // back to the start when the window covered every candidate.
    retireCursor = capHit ? lastArchived : (window.length < candidates.length && window.length ? window[window.length - 1].lane.laneId : null);
  } catch (err: any) {
    logger.warn(`lane-retire: pass failed (non-fatal): ${err?.message ?? err}`);
  }
  try {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.LANE_RETIRED, meta: { phase: 'pass', considered, archived, cascaded, skipped } });
  } catch { /* telemetry never blocks */ }
  return { considered, archived, cascaded, skipped };
}

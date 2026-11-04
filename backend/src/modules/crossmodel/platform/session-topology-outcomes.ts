/**
 * session-topology-outcomes — the +24 h LABEL of every session-topology
 * placement decision (SESSION_TITLES_TOPOLOGY design §B; worker cron every
 * SESSION_TOPOLOGY_OUTCOMES_INTERVAL_SEC).
 *
 * Reads loop_metrics `session_topology` rows older than the label window that
 * have no `session_topology_outcome` row yet (meta.decisionKey — the metric row
 * id) and writes ONE outcome row each:
 *   spawn  — WRONG (actual 'reuse') iff a duplicate lane was spawned for the
 *            same goal inside 24 h; CORRECT iff the spawned lane reached its
 *            first mutating receipt ≤ SPAWN_TTFR_MAX_SEC (10 min, measured from
 *            the FIRST agent run's start — never from chat creation, which
 *            includes provisioning and the wait for a prompt) AND did not end
 *            one-run-no-PR; otherwise (slow, or one run and no PR) the row is
 *            measured but `actual` stays null — the evidence does not say which
 *            placement would have been right, so the gate never learns 'merge'
 *            from it (fixer 2026-09-27). `oneRunNoPr` is judged only once the
 *            lane has ≥ 2 runs (⇒ false) or ≥ SPAWN_ONE_RUN_MIN_AGE_MS (48 h)
 *            have passed; a single mid-work run younger than that DEFERS the row;
 *   reuse / merge — correct iff the target lane minted a mutating receipt
 *            inside the window AND no duplicate lane was spawned for the goal;
 *   retire — correct iff the lane received no message for 72 h (labelled only
 *            once 72 h have passed);
 *   schedule — LABELLED (fixer 2026-09-27): when the spawn proceeded anyway
 *            (observe-only), correct iff the spawned lane behaved like a watch
 *            (no PR receipt inside 24 h); when it was refused, correct iff a
 *            schedule was armed on the caller inside 24 h AND the caller spawned
 *            no lane for the same goal text inside 24 h. The gate never chooses
 *            'schedule', so no gate outcome rides these rows.
 * A row that carried a decision-gate stash is ALSO labelled through
 * recordDecisionOutcome (question `placement`; actual = the placement that
 * would have been correct) so the readiness ruler / auto-demote see it — only
 * when `actual` is known.
 *
 * Bounded (OUTCOMES_BATCH rows per pass, rows ≤ 7 days old), never throws;
 * SESSION_TOPOLOGY_DISABLED silences it (no decisions are written then anyway).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { LOOP_METRIC_KINDS, recordLoopMetric } from './loop-metrics.service';
import { recordDecisionOutcome, reconstructDecision } from './decision-gate';
import { PLATFORM_MUTATING_TOOLS } from './platform-tool-names';
import { buildLaneIndex, retireCandidates, sessionTopologyDisabled, sessionTopologyOverlapMin, normalizeGoalWords, jaccard, laneIdleRetireDisabled } from './session-topology';
import { collectRetireCandidates, retireIdleLanes, LANE_RETIRE_PROJECT_LOOKBACK_MS, LANE_RETIRE_MAX_PROJECTS, type LaneRetireCandidate } from './lane-retire';

// ── R6 retire scan (observe rows + LANE-IDLE-RETIRE acts) ────────────────────

export const RETIRE_SCAN_MAX_PROJECTS = 50;
export const RETIRE_SCAN_LOOKBACK_MS = 30 * 24 * 3600_000;
export const RETIRE_SCAN_DEDUPE_MS = 24 * 3600_000;

/**
 * The R6 scan: per project with recent coding lanes, the lanes that hold no
 * open charter, no enabled schedule, are not running and minted no mutating
 * receipt for > 6 h are RETIRE candidates — one `session_topology` row (site
 * 'scan', rule R6) per lane per 24 h, exactly as before.
 *
 * LANE-IDLE-RETIRE (2026-10-21): the scan then ACTS — lane-retire.ts
 * `collectRetireCandidates` walks each project's CODING lanes by id (a
 * non-partial page feeds it; the observe rows above still come from the
 * placement index, unchanged) and `retireIdleLanes` archives only a PROVEN
 * machine-spawned lane idle ≥ 7 d (≤ 25 per pass). The placement index holds
 * only the 200 most-recently-updated chats of any kind, so in a folder of 700
 * plain chats the long-idle lanes were never seen (review fixer 2026-10-21).
 * Project discovery widens to the 100 most recently active projects over 180 d
 * (was 50, unordered, 30 d — a long-idle lane's project had aged out).
 * LANE_IDLE_RETIRE_DISABLED=1 restores the observe-only scan byte-for-byte.
 * Never throws.
 */
export async function runSessionTopologyRetireScanOnce(now: Date = new Date()): Promise<string> {
  if (sessionTopologyDisabled()) return 'retire scan disabled';
  const acting = !laneIdleRetireDisabled();
  try {
    // Second review fixer (2026-10-21): the acting discovery is a groupBy with a
    // real LIMIT — `distinct` runs in memory in Prisma 7, so the findMany pulled
    // 180 days of coding chats to keep 100 projects.
    const recent: Array<{ projectId: string | null; userId: string }> = acting
      ? ((await (prisma.crossModelChat as any).groupBy({
        by: ['projectId', 'userId'],
        where: { archivedAt: null, projectId: { not: null }, codingState: { isNot: null }, updatedAt: { gte: new Date(now.getTime() - LANE_RETIRE_PROJECT_LOOKBACK_MS) } },
        _max: { updatedAt: true },
        orderBy: { _max: { updatedAt: 'desc' } },
        take: LANE_RETIRE_MAX_PROJECTS,
      })) as Array<{ projectId: string | null; userId: string }>).map((r) => ({ projectId: r.projectId, userId: r.userId }))
      : await prisma.crossModelChat.findMany({
        where: { archivedAt: null, projectId: { not: null }, codingState: { isNot: null }, updatedAt: { gte: new Date(now.getTime() - RETIRE_SCAN_LOOKBACK_MS) } },
        select: { projectId: true, userId: true }, distinct: ['projectId'], take: RETIRE_SCAN_MAX_PROJECTS,
      });
    if (!recent.length) return 'retire scan: no projects';
    const seenRows = await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.SESSION_TOPOLOGY, createdAt: { gte: new Date(now.getTime() - RETIRE_SCAN_DEDUPE_MS) } },
      select: { meta: true }, take: 5000,
    }).catch(() => []);
    const seen = new Set<string>(seenRows.map((r) => asRecord(r.meta)).filter((m) => m.rule === 'R6').map((m) => String(m.targetChatId ?? '')).filter(Boolean));
    let candidates = 0;
    const toRetire: LaneRetireCandidate[] = [];
    for (const p of recent) {
      if (!p.projectId) continue;
      const index = await buildLaneIndex(p.projectId, p.userId, { now });
      for (const c of retireCandidates(index.lanes, { now })) {
        if (seen.has(c.laneId)) continue;
        candidates++;
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SESSION_TOPOLOGY, sessionId: c.laneId,
          meta: { site: 'scan', rule: 'R6', verdict: 'retire', targetChatId: c.laneId, projectId: p.projectId, source: 'rule', enforced: false, signals: { idleSec: c.idleSec }, goalText: c.title.slice(0, 120) },
        });
      }
      // The acting feed: its own coding-lanes-only walk (a partial page — a failed /
      // timed-out leg — never feeds an archive; its columns may read empty on a read
      // that never landed).
      if (acting) toRetire.push(...(await collectRetireCandidates(p.projectId, p.userId, now)).candidates);
    }
    if (!acting) return `retire scan: ${candidates} candidate(s) (observe-only) over ${recent.length} project(s)`;
    const r = await retireIdleLanes(toRetire, now);
    return `retire scan: ${candidates} candidate(s) (observe-only) over ${recent.length} project(s), archived ${r.archived}`;
  } catch (err: any) {
    logger.warn(`session-topology retire scan failed (non-fatal): ${err?.message ?? err}`);
    return 'retire scan: failed (non-fatal)';
  }
}

export const SESSION_TOPOLOGY_OUTCOMES_JOB_ID = 'session-topology-outcomes';
export const SESSION_TOPOLOGY_OUTCOMES_INTERVAL_SEC = 6 * 3600;
export const OUTCOMES_BATCH = 200;
export const OUTCOME_WINDOW_MS = 24 * 3600_000;
export const RETIRE_WINDOW_MS = 72 * 3600_000;
export const OUTCOME_MAX_AGE_MS = 7 * 24 * 3600_000;
export const SPAWN_TTFR_MAX_SEC = 600;
/** A single run with no PR counts as "one-run-no-PR" only once the lane is this old (a long first run is mid-work at 24 h). */
export const SPAWN_ONE_RUN_MIN_AGE_MS = 48 * 3600_000;

const MUTATING_RECEIPT_TOOLS = [...PLATFORM_MUTATING_TOOLS, 'open_pull_request', 'merge_pull_request', 'run_command'];
const asRecord = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});

export interface TopologyOutcomeFacts {
  ttfrSec: number | null;
  runs: number;
  hasPr: boolean;
  oneRunNoPr: boolean | null;
  duplicateSpawned24h: boolean;
  targetReceiptInWindow: boolean | null;
  reactivatedAfterRetire: boolean | null;
  scheduleArmed: boolean | null;
  /** schedule verdict, spawn proceeded (observe-only): did the spawned lane open / merge a PR inside 24 h? null = no spawn. */
  spawnedLanePr?: boolean | null;
  /** schedule verdict: did the caller spawn a lane for the same goal text inside 24 h (the decision's own spawn excluded)? */
  watchLaneSpawned24h?: boolean;
  /** spawn verdict: the single run is still mid-work (runs ≤ 1, no PR, younger than SPAWN_ONE_RUN_MIN_AGE_MS) — label later. */
  deferSpawn?: boolean;
}

/** The verdict's correctness + the placement that WOULD have been right. Pure. */
export function judgeTopologyOutcome(verdict: string, f: TopologyOutcomeFacts): { correct: boolean | null; actual: string | null } {
  switch (verdict) {
    case 'spawn': {
      // A duplicate owner is the one outcome that names the right placement.
      if (f.duplicateSpawned24h) return { correct: false, actual: 'reuse' };
      if (f.ttfrSec == null && f.oneRunNoPr == null) return { correct: null, actual: null };
      const ok = (f.ttfrSec != null && f.ttfrSec <= SPAWN_TTFR_MAX_SEC) && f.oneRunNoPr !== true;
      // Slow / one-run-no-PR: the placement did not pay off, but nothing says
      // reuse or merge would have — keep the gate label unknown (pure).
      return ok ? { correct: true, actual: 'spawn' } : { correct: false, actual: null };
    }
    case 'reuse': case 'merge': {
      if (f.targetReceiptInWindow == null) return { correct: null, actual: null };
      const ok = f.targetReceiptInWindow && !f.duplicateSpawned24h;
      return { correct: ok, actual: ok ? verdict : 'spawn' };
    }
    case 'retire': {
      if (f.reactivatedAfterRetire == null) return { correct: null, actual: null };
      return { correct: !f.reactivatedAfterRetire, actual: f.reactivatedAfterRetire ? 'reuse' : 'retire' };
    }
    case 'schedule': {
      // Observe-only: the spawn went ahead — a lane that opened a PR was real work, not a watch.
      if (f.spawnedLanePr != null) return { correct: !f.spawnedLanePr, actual: f.spawnedLanePr ? 'spawn' : 'schedule' };
      if (f.scheduleArmed == null) return { correct: null, actual: null };
      const ok = f.scheduleArmed && !f.watchLaneSpawned24h;
      return { correct: ok, actual: ok ? 'schedule' : 'spawn' };
    }
    default:
      return { correct: null, actual: null };
  }
}

async function firstMutatingReceipt(chatId: string, after: Date): Promise<Date | null> {
  const r = await prisma.runToolReceipt.findFirst({ where: { chatId, ok: true, tool: { in: MUTATING_RECEIPT_TOOLS }, createdAt: { gte: after } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }).catch(() => null);
  return r?.createdAt ?? null;
}

async function factsFor(meta: Record<string, any>, decidedAt: Date, now: Date): Promise<TopologyOutcomeFacts> {
  const f: TopologyOutcomeFacts = { ttfrSec: null, runs: 0, hasPr: false, oneRunNoPr: null, duplicateSpawned24h: false, targetReceiptInWindow: null, reactivatedAfterRetire: null, scheduleArmed: null };
  const windowEnd = new Date(decidedAt.getTime() + OUTCOME_WINDOW_MS);
  const goalId = typeof meta.goalId === 'string' ? meta.goalId : null;
  const projectId = typeof meta.projectId === 'string' ? meta.projectId : null;
  const spawned = typeof meta.spawnedChatId === 'string' ? meta.spawnedChatId : null;
  const target = typeof meta.targetChatId === 'string' ? meta.targetChatId : null;
  if (goalId && projectId) {
    const dup = await prisma.crossModelChat.count({ where: { projectId, charterGoalId: goalId, archivedAt: null, createdAt: { gte: decidedAt, lte: windowEnd }, ...(spawned ? { id: { not: spawned } } : {}) } }).catch(() => 0);
    f.duplicateSpawned24h = dup > 0;
  }
  if (meta.verdict === 'spawn' && spawned) {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: spawned }, select: { createdAt: true } }).catch(() => null);
    const born = chat?.createdAt ?? decidedAt;
    // TTFR clock = the FIRST agent run's start (fixer 2026-09-27) — chat
    // creation includes workspace provisioning and any wait for the prompt.
    const firstRun = await prisma.agentRun.findFirst({ where: { sessionId: spawned }, orderBy: { createdAt: 'asc' }, select: { startedAt: true, createdAt: true } }).catch(() => null);
    const clock = firstRun?.startedAt ?? firstRun?.createdAt ?? born;
    const first = await firstMutatingReceipt(spawned, clock);
    f.ttfrSec = first ? Math.max(0, Math.round((first.getTime() - clock.getTime()) / 1000)) : null;
    f.runs = await prisma.agentRun.count({ where: { sessionId: spawned } }).catch(() => 0);
    f.hasPr = (await prisma.runToolReceipt.count({ where: { chatId: spawned, ok: true, tool: { in: ['open_pull_request', 'merge_pull_request'] } } }).catch(() => 0)) > 0;
    const oldEnough = now.getTime() - born.getTime() >= SPAWN_ONE_RUN_MIN_AGE_MS;
    // ≥ 2 runs ⇒ not a one-run lane; else judged only once 48 h have passed.
    f.oneRunNoPr = f.runs >= 2 ? false : oldEnough ? !f.hasPr : null;
    f.deferSpawn = !f.duplicateSpawned24h && f.runs <= 1 && !f.hasPr && !oldEnough;
  }
  if (meta.verdict === 'schedule') {
    if (spawned) {
      // Observe-only: the spawn happened anyway — did the lane do PR-class work?
      f.spawnedLanePr = (await prisma.runToolReceipt.count({ where: { chatId: spawned, ok: true, tool: { in: ['open_pull_request', 'merge_pull_request'] }, createdAt: { lte: windowEnd } } }).catch(() => 0)) > 0;
    } else if (typeof meta.callerChatId === 'string' && projectId) {
      // Refused: did the caller spawn a lane for the same goal text anyway?
      const goalWords = normalizeGoalWords(meta.goalText);
      const spawnedLanes = goalWords.size ? await prisma.crossModelChat.findMany({
        where: { projectId, parentChatId: meta.callerChatId, archivedAt: null, createdAt: { gte: decidedAt, lte: windowEnd } },
        select: { title: true }, take: 50,
      }).catch(() => []) : [];
      const bar = sessionTopologyOverlapMin();
      f.watchLaneSpawned24h = spawnedLanes.some((c) => jaccard(goalWords, normalizeGoalWords(c.title)) >= bar);
    }
  }
  if ((meta.verdict === 'reuse' || meta.verdict === 'merge') && target) {
    const r = await firstMutatingReceipt(target, decidedAt);
    f.targetReceiptInWindow = !!(r && r.getTime() <= windowEnd.getTime());
  }
  if (meta.verdict === 'retire' && target) {
    if (now.getTime() - decidedAt.getTime() >= RETIRE_WINDOW_MS) {
      const n = await prisma.crossModelMessage.count({ where: { chatId: target, createdAt: { gte: decidedAt, lte: new Date(decidedAt.getTime() + RETIRE_WINDOW_MS) } } }).catch(() => 0);
      f.reactivatedAfterRetire = n > 0;
    }
  }
  if (meta.verdict === 'schedule' && typeof meta.callerChatId === 'string') {
    const n = await (prisma as any).codingSchedule.count({ where: { sessionId: meta.callerChatId, createdAt: { gte: decidedAt, lte: windowEnd } } }).catch(() => 0);
    f.scheduleArmed = n > 0;
  }
  return f;
}

/** One pass. Returns the ≤200-char summary for cron_jobs.lastStatus. Never throws. */
export async function runSessionTopologyOutcomesOnce(now: Date = new Date()): Promise<string> {
  if (sessionTopologyDisabled()) return 'disabled';
  try {
    const rows = await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.SESSION_TOPOLOGY, createdAt: { lte: new Date(now.getTime() - OUTCOME_WINDOW_MS), gte: new Date(now.getTime() - OUTCOME_MAX_AGE_MS) } },
      orderBy: { createdAt: 'asc' }, take: OUTCOMES_BATCH, select: { id: true, sessionId: true, meta: true, createdAt: true },
    });
    if (!rows.length) return 'no decisions to label';
    const labelled = await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.SESSION_TOPOLOGY_OUTCOME, createdAt: { gte: new Date(now.getTime() - OUTCOME_MAX_AGE_MS - OUTCOME_WINDOW_MS) } },
      select: { meta: true }, take: 5000,
    }).catch(() => []);
    const done = new Set<string>(labelled.map((r) => String(asRecord(r.meta).decisionKey ?? '')).filter(Boolean));
    let written = 0; let deferred = 0; let gateLabelled = 0;
    for (const row of rows) {
      if (done.has(row.id)) continue;
      const meta = asRecord(row.meta);
      const verdict = String(meta.verdict ?? '');
      // A retire decision waits for its 72 h window before it is judged.
      if (verdict === 'retire' && now.getTime() - row.createdAt.getTime() < RETIRE_WINDOW_MS) { deferred++; continue; }
      const facts = await factsFor(meta, row.createdAt, now);
      // A spawn whose single run is still mid-work waits for the 48 h one-run window (fixer 2026-09-27).
      if (verdict === 'spawn' && facts.deferSpawn) { deferred++; continue; }
      const { correct, actual } = judgeTopologyOutcome(verdict, facts);
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.SESSION_TOPOLOGY_OUTCOME, sessionId: row.sessionId ?? undefined,
        meta: { decisionKey: row.id, decisionId: meta.decisionId ?? null, rule: meta.rule ?? null, verdict, source: meta.source ?? 'rule', targetChatId: meta.targetChatId ?? null, spawnedChatId: meta.spawnedChatId ?? null, goalId: meta.goalId ?? null, projectId: meta.projectId ?? null, ...facts, correct, actual },
      });
      written++;
      if (meta.stash && actual) {
        try {
          const decision = reconstructDecision(meta.stash);
          if (decision) {
            recordDecisionOutcome(decision, 'session_topology', {
              question: 'placement', actual, acted: meta.source === 'gate', sessionId: row.sessionId ?? undefined,
              note: `topology ${meta.rule ?? '?'} ${verdict}: ${correct ? 'correct' : 'wrong'}`, extra: { site: meta.site ?? null, rule: meta.rule ?? null, ruleVerdict: verdict, ...facts },
            });
            gateLabelled++;
          }
        } catch { /* a bad stash never blocks the pass */ }
      }
    }
    const summary = `session-topology-outcomes: ${written} labelled (${gateLabelled} gate rows), ${deferred} deferred of ${rows.length} candidates`;
    logger.info(summary);
    return summary.slice(0, 200);
  } catch (err: any) {
    const msg = `session-topology-outcomes: pass failed (non-fatal): ${err?.message ?? err}`;
    logger.warn(msg);
    return msg.slice(0, 200);
  }
}

/**
 * Memory Maintenance — the nightly "dream cycle" for user memory.
 *
 * WHY (2026-07-05): user memory only ever GREW. Facts extracted turn-by-turn
 * accumulate duplicates ("location" vs "lives_in"), contradictions (old diet
 * next to corrected diet), ephemera ("currently preparing for X" months later),
 * and project-specific leaks — and nothing ever cleaned them up unless the user
 * explicitly rejected a topic mid-chat. Stale/wrong facts then fed the
 * relevance gate and prompts forever.
 *
 * WHAT: a scheduled background sweep (once per ~24h across all instances,
 * Redis-lock deduped for blue/green) that, per user with recently-changed
 * memory:
 *   1. Programmatically re-scrubs flat facts against the user's persistent
 *      rejections (defense in depth — extraction already does this).
 *   2. Runs an LLM consolidation pass (utility model) that merges duplicates,
 *      resolves contradictions in favor of the newest information, and deletes
 *      stale/ephemeral/project-specific entries.
 *   3. Applies STRICT anti-hallucination guards before saving: the LLM may
 *      only remove/merge — output values whose topical tokens don't appear in
 *      the input, or wipes of most of the memory, are rejected wholesale and
 *      the original facts are kept.
 *   4. Cleans the structured UserContextState: scrubs it against rejections
 *      and clears `currentFocus`/`recentTopics` when the memory has been idle
 *      for 14+ days (they describe "current" activity; stale ones are exactly
 *      the facts that get randomly volunteered).
 *
 * Only users whose memory changed since their last dream are processed, so
 * steady-state cost is proportional to active users. Bookkeeping lives in the
 * facts JSON under `__dream` (no schema migration needed).
 *
 * 2026-10-20 memory upgrade:
 *  - PER-ITEM OPS: the consolidation used to ask the model to RE-EMIT every
 *    fact as JSON under a 900-token budget — any user with more than a few
 *    dozen facts got truncated JSON, JSON.parse threw, and the failure was a
 *    debug log (the same whole-object-rewrite defect class as the profile
 *    parse_error bursts). The model now answers ONLY changes —
 *    {"merge": […], "update": {…}, "remove": […]} or {} — applied to the
 *    scrubbed facts under the SAME two guards (max-drop, no-invention), and
 *    every call records a `memory_extraction` outcome row (source 'dream').
 *    MEMORY_STATE_OPS_DISABLED=1 restores the whole-object prompt + parse.
 *  - EVERY ACTIVE USER: the hourly tick takes a per-TICK lock (55 min) and
 *    dreams every eligible user (memory changed since that user's last dream,
 *    last dream ≥ 20 h ago, outside the quiet period) until the tick deadline;
 *    leftovers are picked up next tick. It used to take a 20 h global lock and
 *    process at most 30 users, so past 30 changed users some never dreamt.
 *    DREAM_ALL_ACTIVE_USERS_DISABLED=1 restores the 30-cap + 20 h cycle lock.
 *  - FACT VERSIONS: a merged / normalised / removed fact is closed in
 *    user_memory_fact_versions ('consolidated', replacedBy `key:<into>`), never
 *    lost without a trace; the prompt shows "(since YYYY-MM-DD)" per fact.
 */

import prisma from '../../config/database';
import redisClient from '../../config/redis';
import logger from '../../utils/logger';
import { utilityChat } from '../../utils/utility-llm';
import { storeGet, storePut } from './memory/context-store';
import { syncUserFactRows } from './memory/user-facts.service';
import { buildRejectionKeywords, scrubUserContextState } from './langgraph/memory.graph';
import { dreamCodingProjects } from './coding/coding-memory.service';
import { UserContextState } from './langgraph/types';
import { topicalTokens } from './memory-relevance';
import { recordMemoryMutation, countVisibleFacts, recordExtractionOutcome, parseModelJson, extractionDetailOf } from './memory/memory-audit';
import { recordLoopMetric } from './platform/loop-metrics.service';
import { recordFactVersions, getFactMeta, factVersionsEnabled, factSinceSuffix, FACT_RECENCY_RULE } from './memory/fact-versions';

const TICK_INTERVAL_MS = 60 * 60 * 1000;          // check hourly...
const INITIAL_TICK_DELAY_MS = 5 * 60 * 1000;      // first check 5 min after boot
const CYCLE_LOCK_KEY = 'crossmodel:memory-dream:cycle-lock';
const CYCLE_LOCK_TTL_S = 20 * 60 * 60;            // ...but run at most once per ~20h across all instances
// 2026-07-08: lowered 50 → 30. Worst case is ceil(N/DREAM_CONCURRENCY)*DREAM_USER_TIMEOUT_MS;
// at 50 users that is ceil(50/4)*90s ≈ 18.75 min, long enough to overlap the next hourly
// tick and contend with other 6am-window background LLM work. 30 caps it at ceil(30/4)*90s
// ≈ 11.25 min while still draining the active-user set across successive daily cycles.
const MAX_USERS_PER_CYCLE = 30;                   // bound LLM load per cycle
const DREAM_CONCURRENCY = 4;                       // users consolidated in parallel per batch (bounds provider load)
const CYCLE_TOTAL_DEADLINE_MS = 12 * 60 * 1000;  // 2026-07-08: hard cap — stop starting new batches past 12 min
// Hard per-user ceiling so one hung consolidation (LLM stall, slow DB write) can't
// pin a batch slot and stall the whole Promise.allSettled batch. Comfortably above
// the 45s LLM timeout inside consolidateFactsWithLLM plus the two DB ops.
const DREAM_USER_TIMEOUT_MS = 90 * 1000;
const QUIET_PERIOD_MS = 30 * 60 * 1000;           // skip memory updated in the last 30 min (user may be mid-session)
const STALE_FOCUS_MS = 14 * 24 * 60 * 60 * 1000;  // clear currentFocus/recentTopics after 14 idle days
const MIN_FACTS_FOR_LLM_PASS = 2;                 // nothing to consolidate below this
// 2026-09-21 (owner: "I only see 3 facts"): one night's consolidation may drop
// at most this share of a memory (min 1 fact). A merge of true duplicates
// rarely removes more than a third; the LLM's "project-specific" rule was the
// likelier way a power user's profile shrank 16 → 3 with no trail.
const MAX_DREAM_DROP_RATIO = 0.34;

// ── 2026-10-20: every active user, one per-TICK lock ──
const TICK_LOCK_KEY = 'crossmodel:memory-dream:tick-lock';
const TICK_LOCK_TTL_S = 55 * 60;                  // just under the hourly tick: one instance per tick
const USER_DREAM_MIN_GAP_MS = 20 * 60 * 60 * 1000; // at most one dream per user per ~20h
const DREAM_UNCHANGED_TOLERANCE_MS = 10_000;      // the dream's own save bumps @updatedAt just past lastRunAt
const SCAN_PAGE_SIZE = 500;
const SCAN_MAX_PAGES = 400;                        // 200k memory rows — a runaway-loop bound, not a cap in practice
/** Output budget of the per-item ops answer — bounded by the CHANGES, not by the memory's size. */
export const DREAM_OPS_BUDGET_TOKENS = 1500;
// f177 (2026-10-21 audit): a merge-heavy ops answer clipped at the 1500 cap —
// one bigger-budget retry budget for exactly the finishReason='length' clip.
export const DREAM_OPS_LENGTH_RETRY_BUDGET_TOKENS = 4000;

/** DREAM_ALL_ACTIVE_USERS_DISABLED=1 restores the 30-user cap + 20 h global cycle lock. */
function dreamAllActiveUsersEnabled(): boolean {
  return process.env.DREAM_ALL_ACTIVE_USERS_DISABLED !== '1';
}
/** MEMORY_STATE_OPS_DISABLED=1 restores the whole-object consolidation prompt + parse. */
function dreamStateOpsEnabled(): boolean {
  return process.env.MEMORY_STATE_OPS_DISABLED !== '1';
}

// Guard B's safe canonicalization allowlist (see consolidateFactsLegacy) — shared by both paths.
const SAFE_CANONICAL_TOKENS = new Set([
  'canada', 'usa', 'america', 'united', 'states', 'kingdom', 'britain',
  'england', 'scotland', 'wales', 'ireland', 'australia', 'zealand',
  'europe', 'european', 'north', 'south', 'east', 'west', 'central',
]);

interface DreamBookkeeping {
  lastRunAt?: string;
  lastRemovedCount?: number;
}

interface DreamLLMResult {
  facts?: Record<string, string>;
  removed?: Array<{ key: string; reason: string }>;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startMemoryDreamScheduler(): void {
  if (process.env.MEMORY_DREAM_DISABLED === '1') {
    logger.info('memory-maintenance: dream cycle DISABLED via MEMORY_DREAM_DISABLED=1');
    return;
  }
  logger.info('memory-maintenance: starting memory dream scheduler (hourly check, ~daily cycle)');

  const initial = setTimeout(() => {
    runDreamCycle().catch(err => logger.warn(`memory-maintenance: initial dream cycle failed: ${err.message}`));
  }, INITIAL_TICK_DELAY_MS);
  initial.unref();

  const interval = setInterval(() => {
    runDreamCycle().catch(err => logger.warn(`memory-maintenance: dream cycle failed: ${err.message}`));
  }, TICK_INTERVAL_MS);
  interval.unref();
}

/**
 * Run one dream TICK if the cross-instance tick lock is free (the worker cron
 * calls this hourly). Every eligible user is dreamt until the tick deadline;
 * leftovers are picked up by the next tick. `force` skips the lock.
 * Exported for manual/one-off invocation (e.g. from a script or ops endpoint).
 * DREAM_ALL_ACTIVE_USERS_DISABLED=1 → the pre-2026-10-20 capped cycle.
 */
export async function runDreamCycle(force = false): Promise<void> {
  if (!dreamAllActiveUsersEnabled()) return runDreamCycleCapped(force);

  const tickStart = Date.now();
  if (!force) {
    // NX lock: one instance (blue / green / worker) per hourly tick.
    const acquired = await redisClient
      .set(TICK_LOCK_KEY, new Date().toISOString(), { NX: true, EX: TICK_LOCK_TTL_S })
      .catch(() => null);
    if (!acquired) return;
  }

  let eligible: DreamCandidate[] = [];
  try {
    eligible = await scanEligibleUsers(tickStart);
  } catch (err: any) {
    logger.warn(`memory-maintenance: dream tick — scanning user memories failed (non-fatal): ${err?.message ?? err}`);
  }
  // Longest-waiting first (never-dreamt users lead), then the most recently changed.
  eligible.sort((x, y) => (x.lastRunMs - y.lastRunMs) || (y.updatedAt.getTime() - x.updatedAt.getTime()));

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  for (let i = 0; i < eligible.length; i += DREAM_CONCURRENCY) {
    if (Date.now() - tickStart > CYCLE_TOTAL_DEADLINE_MS) {
      deferred = eligible.length - i; // still eligible next tick — nothing is lost
      break;
    }
    const batch = eligible.slice(i, i + DREAM_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(c =>
        withTimeout(
          dreamIfStillEligible(c.userId),
          DREAM_USER_TIMEOUT_MS,
          `dream timed out after ${DREAM_USER_TIMEOUT_MS / 1000}s`,
        )
      )
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') { if (r.value) processed++; else skipped++; }
      else {
        failed++;
        logger.warn(`memory-maintenance: dream failed for user ${batch[idx].userId} (non-fatal): ${r.reason?.message || r.reason}`);
      }
    });
  }
  logger.info(`memory-maintenance: dream tick — eligible ${eligible.length}, processed ${processed}${failed ? `, failed ${failed}` : ''}${skipped ? `, skipped ${skipped} (changed since the scan)` : ''}, deferred ${deferred}`);

  // Coding project dream — unchanged; it keeps its own per-project ~20h gap, so an
  // hourly call only dreams the projects that are due.
  try {
    const dreamed = await dreamCodingProjects();
    if (dreamed) logger.info(`memory-maintenance: coding project dream consolidated ${dreamed} project(s)`);
  } catch (err: any) {
    logger.warn(`memory-maintenance: coding project dream failed (non-fatal): ${err.message}`);
  }
}

interface DreamCandidate {
  userId: string;
  updatedAt: Date;
  /** last dream (ms epoch), 0 = never */
  lastRunMs: number;
}

/**
 * Per-USER eligibility (2026-10-20): visible facts, outside the quiet period,
 * changed since that user's last dream (10 s tolerance for the dream's own
 * save) and last dream ≥ 20 h ago (or never). Exported for tests.
 */
export function dreamEligibility(row: { facts: unknown; updatedAt: Date }, now: number): { lastRunMs: number } | null {
  const facts = (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts) ? row.facts : {}) as Record<string, any>;
  if (!Object.keys(facts).some(k => !k.startsWith('__'))) return null;
  const updatedMs = new Date(row.updatedAt).getTime();
  if (!Number.isFinite(updatedMs) || now - updatedMs < QUIET_PERIOD_MS) return null; // user may be mid-session
  const dream: DreamBookkeeping = facts.__dream && typeof facts.__dream === 'object' ? facts.__dream : {};
  const lastRunMs = dream.lastRunAt ? new Date(dream.lastRunAt).getTime() : NaN;
  if (Number.isFinite(lastRunMs)) {
    if (updatedMs <= lastRunMs + DREAM_UNCHANGED_TOLERANCE_MS) return null; // nothing changed since the last dream
    if (now - lastRunMs < USER_DREAM_MIN_GAP_MS) return null;                 // dreamt within the last ~20h
    return { lastRunMs };
  }
  return { lastRunMs: 0 };
}

/**
 * Dream one user from a FRESH read: a tick can run ~12 min, so the blob read at
 * scan time may be stale by the user's turn — and the dream's save replaces the
 * whole blob. A user who wrote since the scan (now inside the quiet period) is
 * skipped and picked up by a later tick. Returns whether it dreamt.
 */
async function dreamIfStillEligible(userId: string): Promise<boolean> {
  const row = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true, updatedAt: true } });
  if (!row || !dreamEligibility(row, Date.now())) return false;
  await dreamUserMemory(userId, (row.facts as Record<string, any>) || {}, row.updatedAt);
  return true;
}

/** Every user_memory row, paged by a stable id cursor (no take:500 truncation). */
async function scanEligibleUsers(now: number): Promise<DreamCandidate[]> {
  const out: DreamCandidate[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const rows: Array<{ id: string; userId: string; facts: unknown; updatedAt: Date }> = await prisma.userMemory.findMany({
      orderBy: { id: 'asc' },
      take: SCAN_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, userId: true, facts: true, updatedAt: true },
    });
    for (const row of rows) {
      const e = dreamEligibility(row, now);
      if (e) out.push({ userId: row.userId, updatedAt: new Date(row.updatedAt), lastRunMs: e.lastRunMs }); // facts re-read at dream time
    }
    if (rows.length < SCAN_PAGE_SIZE) break;
    cursor = rows[rows.length - 1].id;
  }
  return out;
}

/** The pre-2026-10-20 cycle: a 20 h global lock and at most MAX_USERS_PER_CYCLE users (DREAM_ALL_ACTIVE_USERS_DISABLED=1). */
async function runDreamCycleCapped(force: boolean): Promise<void> {
  if (!force) {
    // NX lock: only one instance (blue or green) dreams per ~20h window.
    const acquired = await redisClient
      .set(CYCLE_LOCK_KEY, new Date().toISOString(), { NX: true, EX: CYCLE_LOCK_TTL_S })
      .catch(() => null);
    if (!acquired) return; // another instance ran recently, or ran within this window
  }

  const rows = await prisma.userMemory.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 500,
    select: { userId: true, facts: true, updatedAt: true },
  });

  const now = Date.now();
  const candidates = rows.filter(row => {
    const facts = (row.facts as Record<string, any>) || {};
    const hasContent = Object.keys(facts).some(k => !k.startsWith('__'));
    if (!hasContent) return false;
    if (now - row.updatedAt.getTime() < QUIET_PERIOD_MS) return false; // user may be mid-session
    const dream: DreamBookkeeping = facts.__dream || {};
    if (dream.lastRunAt) {
      // Skip if nothing changed since the last dream. 10s tolerance covers the
      // dream's own save bumping @updatedAt just past lastRunAt.
      const lastRun = new Date(dream.lastRunAt).getTime();
      if (row.updatedAt.getTime() <= lastRun + 10_000) return false;
    }
    return true;
  }).slice(0, MAX_USERS_PER_CYCLE);

  if (candidates.length === 0) {
    logger.info('memory-maintenance: dream cycle — no user memories need cleaning');
    // Still run the coding project dream — project activity is independent of
    // whether any USER memories changed.
    try {
      const dreamed = await dreamCodingProjects();
      if (dreamed) logger.info(`memory-maintenance: coding project dream consolidated ${dreamed} project(s)`);
    } catch (err: any) {
      logger.warn(`memory-maintenance: coding project dream failed (non-fatal): ${err.message}`);
    }
    return;
  }

  logger.info(`memory-maintenance: dream cycle starting for ${candidates.length} user(s)`);
  // 2026-07-05: Process users with bounded concurrency instead of one-at-a-time.
  // The old sequential loop made one slow consolidation LLM call (up to 45s timeout)
  // block every subsequent user, so a full MAX_USERS_PER_CYCLE=50 cycle could span
  // 10-20 min of serial LLM latency. A small concurrency cap (mirrors the news
  // scheduler's BATCH_SIZE pattern) shortens wall-clock while staying gentle on the
  // utility-LLM provider — each dreamUserMemory already isolates its own failures.
  let cleaned = 0;
  // 2026-07-08: guard against a runaway cycle — if the batches are hitting the per-user
  // timeout in series the total can approach ceil(N/DREAM_CONCURRENCY)*DREAM_USER_TIMEOUT_MS.
  // Stop starting NEW batches once we cross CYCLE_TOTAL_DEADLINE_MS (in-flight batch still
  // finishes) so one slow night can't pin background LLM capacity into the next tick.
  const cycleStart = Date.now();
  for (let i = 0; i < candidates.length; i += DREAM_CONCURRENCY) {
    if (Date.now() - cycleStart > CYCLE_TOTAL_DEADLINE_MS) {
      logger.warn(`memory-maintenance: dream cycle exceeded ${CYCLE_TOTAL_DEADLINE_MS / 1000}s — deferring remaining ${candidates.length - i} user(s) to next cycle`);
      break;
    }
    const batch = candidates.slice(i, i + DREAM_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(row =>
        withTimeout(
          dreamUserMemory(row.userId, (row.facts as Record<string, any>) || {}, row.updatedAt),
          DREAM_USER_TIMEOUT_MS,
          `dream timed out after ${DREAM_USER_TIMEOUT_MS / 1000}s`,
        )
      )
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        cleaned++;
      } else {
        logger.warn(`memory-maintenance: dream failed for user ${batch[idx].userId} (non-fatal): ${r.reason?.message || r.reason}`);
      }
    });
  }
  logger.info(`memory-maintenance: dream cycle complete — processed ${cleaned}/${candidates.length} user(s)`);

  // Digby Code: consolidate recently-active projects' coding memory in the same
  // locked window (merge duplicate notes/commands, drop stale ones, refresh the
  // overview from recent session summaries). Failures never affect user dreams.
  try {
    const dreamed = await dreamCodingProjects();
    if (dreamed) logger.info(`memory-maintenance: coding project dream consolidated ${dreamed} project(s)`);
  } catch (err: any) {
    logger.warn(`memory-maintenance: coding project dream failed (non-fatal): ${err.message}`);
  }
}

// ── Per-user dream ────────────────────────────────────────────────────────────

/** Reject with `message` if `p` hasn't settled within `ms`. The timer is cleared
 *  when `p` settles so a resolved promise never leaves a dangling handle. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function dreamUserMemory(
  userId: string,
  rawFacts: Record<string, any>,
  memoryUpdatedAt: Date,
): Promise<void> {
  // f176: a malformed stored __rejections (legacy non-array shape — a bare string
  // has .length > 0 but no .join) wedged this user's dream cycle with
  // "rejections.join is not a function" every tick (prod error rows 2026-10-21,
  // n=4). Coerce at the read site: anything that is not a string array reads as
  // no rejections, and the next successful dream drops the malformed value.
  const rejections: string[] = Array.isArray(rawFacts.__rejections)
    ? rawFacts.__rejections.filter((r): r is string => typeof r === 'string')
    : [];
  const rejKw = buildRejectionKeywords(rejections);

  // ── 1. Programmatic rejection re-scrub (defense in depth) ──
  const plainFacts: Record<string, string> = {};
  let scrubbedCount = 0;
  const bannedKeys: string[] = []; // a banned-topic scrub is the user's own forget → its versions are purged
  for (const [k, v] of Object.entries(rawFacts)) {
    if (k.startsWith('__')) continue;
    const value = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
    if (!value.trim()) { scrubbedCount++; continue; } // drop empty values
    if (rejKw.size > 0) {
      const combined = `${k.toLowerCase()} ${value.toLowerCase()}`;
      let banned = false;
      for (const kw of rejKw) { if (combined.includes(kw)) { banned = true; break; } }
      if (banned) { scrubbedCount++; bannedKeys.push(k); continue; }
    }
    plainFacts[k] = value;
  }

  // ── 2. LLM consolidation pass ──
  let finalFacts = plainFacts;
  let removedByLLM: Array<{ key: string; reason: string }> = [];
  let mergedInto: Record<string, string> = {};
  let consolidationRejected: string | undefined;
  if (Object.keys(plainFacts).length >= MIN_FACTS_FOR_LLM_PASS) {
    const llmResult = await consolidateFactsWithLLM(userId, plainFacts, rejections);
    if (llmResult && 'rejected' in llmResult) {
      consolidationRejected = llmResult.rejected;
    } else if (llmResult) {
      finalFacts = llmResult.facts;
      removedByLLM = llmResult.removed;
      mergedInto = llmResult.mergedInto ?? {};
    }
  }

  // ── 3. Save (preserve internal keys, stamp bookkeeping) ──
  const removedTotal = scrubbedCount + removedByLLM.length;
  const changed = removedTotal > 0
    || Object.keys(finalFacts).length !== Object.keys(plainFacts).length
    || Object.entries(finalFacts).some(([k, v]) => plainFacts[k] !== v);

  const merged: Record<string, any> = { ...finalFacts };
  // Other internal bookkeeping (`__rebuild` status, future `__*` keys) rides
  // along untouched — the dream used to drop it, so the Memory tab lost its
  // "last rebuild" status every night.
  for (const [k, v] of Object.entries(rawFacts)) {
    if (k.startsWith('__') && k !== '__rejections' && k !== '__dream') merged[k] = v;
  }
  if (rejections.length > 0) merged.__rejections = rejections;
  merged.__dream = {
    lastRunAt: new Date().toISOString(),
    lastRemovedCount: removedTotal,
  } satisfies DreamBookkeeping;

  await prisma.userMemory.update({
    where: { userId },
    data: { facts: merged },
  });
  // Fact versions (2026-10-20): a merged / normalised / cleaned fact is CLOSED
  // ('consolidated', replacedBy `key:<into>` for a merge) — history kept. A banned
  // topic (the scrub, or a model removal for reason 'banned') is the user's own
  // forget → its versions are purged.
  void recordFactVersions({
    userId, before: rawFacts, after: merged, source: 'dream', removal: 'supersede', mergedInto,
    purgeKeys: [...bannedKeys, ...removedByLLM.filter((r) => r.reason === 'banned').map((r) => r.key)],
  }).catch(() => null);
  // keys whose value the consolidation set (a merge target or a normalisation) — audited as `added`
  const changedKeys = Object.keys(finalFacts).filter((k) => plainFacts[k] !== finalFacts[k]);
  if (removedTotal > 0 || consolidationRejected || Object.keys(finalFacts).length !== Object.keys(plainFacts).length || changedKeys.length > 0) {
    recordMemoryMutation({
      userId, source: 'dream',
      ...(changedKeys.length ? { added: changedKeys } : {}),
      removed: Object.keys(plainFacts).filter((k) => !(k in finalFacts)).concat(
        Object.keys(rawFacts).filter((k) => !k.startsWith('__') && !(k in plainFacts))),
      before: countVisibleFacts(rawFacts),
      after: countVisibleFacts(merged),
      ...(consolidationRejected ? { rejectedConsolidation: consolidationRejected } : {}),
    });
  }
  // Reconcile the semantic retrieval index to the consolidated blob
  // (fire-and-forget — dream runs off the hot path anyway).
  void syncUserFactRows(userId);

  if (changed) {
    const removedKeys = removedByLLM.map(r => `${r.key} (${r.reason})`).join('; ');
    logger.info(
      `memory-maintenance: dreamed user ${userId} — kept ${Object.keys(finalFacts).length}, ` +
      `removed ${removedTotal} fact(s)${removedKeys ? `: ${removedKeys}` : ''}`
    );
  }

  // ── 4. Structured context state cleanup ──
  await cleanContextState(userId, rejKw, memoryUpdatedAt);
}

type ConsolidationResult =
  | { facts: Record<string, string>; removed: Array<{ key: string; reason: string }>; mergedInto?: Record<string, string> }
  | { rejected: string }
  | null;

/**
 * LLM consolidation with strict anti-hallucination guards.
 * Returns null when the LLM output is unusable/unsafe — caller keeps originals.
 * Per-item ops by default; MEMORY_STATE_OPS_DISABLED=1 → the whole-object path.
 */
async function consolidateFactsWithLLM(
  userId: string,
  facts: Record<string, string>,
  rejections: string[],
): Promise<ConsolidationResult> {
  return dreamStateOpsEnabled()
    ? consolidateFactsWithOps(userId, facts, rejections)
    : consolidateFactsLegacy(userId, facts, rejections);
}

/** The pre-2026-10-20 whole-object consolidation (MEMORY_STATE_OPS_DISABLED=1) — prompt + parse unchanged. */
async function consolidateFactsLegacy(
  userId: string,
  facts: Record<string, string>,
  rejections: string[],
): Promise<{ facts: Record<string, string>; removed: Array<{ key: string; reason: string }> } | { rejected: string } | null> {
  const factsStr = Object.entries(facts).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  const prompt = `You are the nightly memory-cleanup process for an AI assistant. Review this user's stored facts and return a CLEANED version. Today's date: ${new Date().toISOString().slice(0, 10)}.

STORED FACTS:
${factsStr}
${rejections.length > 0 ? `\nPERMANENTLY BANNED TOPICS (facts touching these must be removed): ${rejections.join(', ')}\n` : ''}
CLEANING RULES — you may ONLY remove, merge, or normalize. NEVER invent new information:
1. MERGE duplicates/overlaps: keys that store the same thing (e.g. "location" and "lives_in") become ONE fact under the clearest key, keeping the most complete value.
2. RESOLVE contradictions: when two facts conflict, keep the one that reads as the newer/corrected state and remove the other. If you cannot tell which is newer, keep both.
3. REMOVE stale ephemera: facts that were only true at a moment in time and are clearly expired now — "currently preparing for…", "this week…", events/deadlines with past dates.
4. REMOVE one-off task context: a single request, a deadline that passed, a ticket/bid/PR id, this week's to-do. KEEP facts about the user's own businesses, products, employers, clients, long-running projects and recurring habits — for a professional those ARE who the user is. When unsure whether something is task context or part of who the user is, KEEP it.
5. REMOVE non-facts: assistant instructions, conversation fragments, questions, or anything that is not a durable statement about the user.
6. KEEP durable personal facts verbatim: name, occupation, location, language, family, long-standing preferences/interests. When in doubt, KEEP the fact unchanged.

Return ONLY valid JSON:
{"facts": {"key": "value", ...}, "removed": [{"key": "removed_key", "reason": "duplicate|contradiction|stale|project-specific|non-fact|banned"}]}`;

  let raw: string;
  try {
    raw = await utilityChat(
      [{ role: 'user', content: prompt }],
      { maxTokens: 900, temperature: 0.2, timeout: 45000, retryNotFound: true, contentOnly: true }
    );
  } catch (err: any) {
    logger.debug(`memory-maintenance: consolidation LLM call failed for ${userId}: ${err.message}`);
    return null;
  }
  if (!raw) return null;

  let parsed: DreamLLMResult;
  try {
    parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    logger.debug(`memory-maintenance: consolidation returned non-JSON for ${userId} — keeping originals`);
    return null;
  }
  if (!parsed.facts || typeof parsed.facts !== 'object' || Array.isArray(parsed.facts)) return null;

  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.facts)) {
    if (k.startsWith('__')) continue; // never let the LLM touch internal keys
    if (v == null) continue;
    const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (value.trim()) cleaned[k] = value.trim();
  }

  // ── Guard A: over-removal — one night may drop at most MAX_DREAM_DROP_RATIO of
  // a memory (min 1 fact). The old rule only caught a wipe below 25 % kept, so
  // 16 → 4 passed and the next night 4 → 3 passed again (2026-09-21).
  const inputCount = Object.keys(facts).length;
  const outputCount = Object.keys(cleaned).length;
  const maxDrop = Math.max(1, Math.floor(inputCount * MAX_DREAM_DROP_RATIO));
  if (inputCount >= 2 && inputCount - outputCount > maxDrop) {
    const why = `kept only ${outputCount}/${inputCount} facts (max drop ${maxDrop})`;
    logger.warn(`memory-maintenance: consolidation for ${userId} ${why} — rejected as unsafe, keeping originals`);
    return { rejected: why };
  }

  // ── Guard B: no invention — every topical token in the output must exist in the input.
  // Merging/rewording is fine (same tokens, new arrangement); new information is not.
  // 2026-07-09: two refinements to stop VALID consolidations being rejected:
  //  1. Safe canonicalization allowlist — merging "Vancouver, BC" + "location: Vancouver"
  //     into "Vancouver, BC, Canada" legitimately introduces "canada", a geographic
  //     completion, not a hallucinated fact. A curated set of country/canonical geo
  //     tokens is treated as non-novel so tidy geographic rollups aren't rejected.
  //  2. Minimum novel COUNT — a single novel topical token in one short field
  //     (ratio can trivially exceed 0.34 in a 2-token field) shouldn't nuke the whole
  //     batch. A genuine invention introduces multiple novel tokens, so require ≥2
  //     novel tokens AND the >34% ratio before rejecting. This still catches a
  //     wholesale invented field while tolerating one-token rewording/expansion.
  //     (SAFE_CANONICAL_TOKENS is module-level since 2026-10-20 — shared with the ops path.)
  const inputTokens = new Set(topicalTokens(Object.entries(facts).map(([k, v]) => `${k} ${v}`).join(' ')));
  for (const [k, v] of Object.entries(cleaned)) {
    const outTokens = topicalTokens(`${k.replace(/_/g, ' ')} ${v}`);
    const novel = outTokens.filter(t => !inputTokens.has(t) && !SAFE_CANONICAL_TOKENS.has(t));
    if (outTokens.length > 0 && novel.length >= 2 && novel.length / outTokens.length > 0.34) {
      logger.warn(`memory-maintenance: consolidation for ${userId} produced novel content in "${k}" (${novel.slice(0, 5).join(', ')}) — rejected, keeping originals`);
      return { rejected: `novel content in "${k}"` };
    }
  }

  const removed = Array.isArray(parsed.removed)
    ? parsed.removed.filter(r => r && typeof r.key === 'string').map(r => ({ key: r.key, reason: String(r.reason || 'cleaned') }))
    : [];
  return { facts: cleaned, removed };
}

// ── Per-item ops (2026-10-20) ─────────────────────────────────────────────────

/** The ops prompt: the same cleaning rules, but the answer is the CHANGES only. Exported for tests. */
export function buildDreamOpsPrompt(factsStr: string, rejections: string[], dated: boolean): string {
  return `You are the nightly memory-cleanup process for an AI assistant. Review this user's stored facts and answer with ONLY the changes needed to clean them. Today's date: ${new Date().toISOString().slice(0, 10)}.

STORED FACTS:
${factsStr}
${rejections.length > 0 ? `\nPERMANENTLY BANNED TOPICS (facts touching these must be removed): ${rejections.join(', ')}\n` : ''}
CLEANING RULES — you may ONLY remove, merge, or normalize. NEVER invent new information:
1. MERGE duplicates/overlaps: keys that store the same thing (e.g. "location" and "lives_in") become ONE fact under the clearest key, keeping the most complete value.
2. RESOLVE contradictions: when two facts conflict, keep the one that reads as the newer/corrected state and remove the other. If you cannot tell which is newer, keep both.
3. REMOVE stale ephemera: facts that were only true at a moment in time and are clearly expired now — "currently preparing for…", "this week…", events/deadlines with past dates.
4. REMOVE one-off task context: a single request, a deadline that passed, a ticket/bid/PR id, this week's to-do. KEEP facts about the user's own businesses, products, employers, clients, long-running projects and recurring habits — for a professional those ARE who the user is. When unsure whether something is task context or part of who the user is, KEEP it.
5. REMOVE non-facts: assistant instructions, conversation fragments, questions, or anything that is not a durable statement about the user.
6. KEEP durable personal facts verbatim: name, occupation, location, language, family, long-standing preferences/interests. When in doubt, KEEP the fact unchanged.
${dated ? `7. ${FACT_RECENCY_RULE}\n` : ''}
Answer with ONLY the changes as JSON — NEVER re-list facts you keep unchanged:
{"merge": [{"keys": ["<key_a>", "<key_b>"], "into": "<key_a>", "value": "<merged value>"}], "update": {"<key>": "<normalized value>"}, "remove": [{"key": "<key>", "reason": "duplicate|contradiction|stale|project-specific|non-fact|banned"}]}
Use the EXACT keys from STORED FACTS and leave out any field with no changes. If nothing needs cleaning, return {}`;
}

export interface AppliedDreamOps {
  facts: Record<string, string>;
  /** every input key absent from the output, with why (a merge or the model's remove reason) */
  removed: Array<{ key: string; reason: string }>;
  /** merged-away key → the key it now lives under */
  mergedInto: Record<string, string>;
  /** output keys whose value the ops set (new merge target or changed value) */
  changedKeys: string[];
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isFactKey = (k: unknown): k is string => typeof k === 'string' && k.trim().length > 0 && !k.startsWith('__');
/** An op value as a fact string ('' = none). A parroted "<placeholder>" from the prompt's example is none. */
function opValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = (typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();
  return /^<[^<>]*>$/.test(s) ? '' : s;
}

/**
 * Apply the model's {merge, update, remove} ops to the scrubbed facts. Pure.
 * Unknown keys (not in the input), internal `__` keys and malformed ops are
 * ignored; ops apply in the order merge → update → remove. Exported for tests.
 */
export function applyDreamOps(input: Record<string, string>, ops: any): AppliedDreamOps {
  const out: Record<string, string> = { ...input };
  const mergedInto: Record<string, string> = {};
  const removeReason = new Map<string, string>();
  const o = ops && typeof ops === 'object' && !Array.isArray(ops) ? ops : {};

  for (const op of Array.isArray(o.merge) ? o.merge : []) {
    if (!op || typeof op !== 'object') continue;
    const into = typeof op.into === 'string' ? op.into.trim() : '';
    if (!isFactKey(into) || /^<[^<>]*>$/.test(into)) continue;
    const listed: unknown[] = Array.isArray(op.keys) ? op.keys : [];
    const known = [...new Set(listed.filter((k): k is string => isFactKey(k) && hasOwn(out, k)))];
    if (!known.length) continue; // only unknown keys — ignored
    const value = opValue(op.value)
      || (hasOwn(out, into) ? out[into] : '')
      || known.map((k) => out[k]).sort((x, y) => y.length - x.length)[0];
    if (!value) continue;
    for (const k of known) {
      if (k === into) continue;
      delete out[k];
      mergedInto[k] = into;
      for (const [src, dst] of Object.entries(mergedInto)) if (dst === k) mergedInto[src] = into; // a→b then b→c ⇒ a→c
    }
    out[into] = value;
    delete mergedInto[into]; // a key that was merged away and is now a target lives again
  }

  if (o.update && typeof o.update === 'object' && !Array.isArray(o.update)) {
    for (const [k, v] of Object.entries(o.update as Record<string, unknown>)) {
      if (!isFactKey(k) || !hasOwn(out, k)) continue; // update only touches existing keys
      const value = opValue(v);
      if (value) out[k] = value;
    }
  }

  for (const r of Array.isArray(o.remove) ? o.remove : []) {
    const key = typeof r === 'string' ? r : r?.key;
    if (!isFactKey(key) || !hasOwn(out, key)) continue;
    delete out[key];
    removeReason.set(key, String((r && typeof r === 'object' && r.reason) || 'cleaned').slice(0, 40));
  }

  const finalMerged: Record<string, string> = {};
  for (const [src, dst] of Object.entries(mergedInto)) {
    // input facts only (an intermediate merge target never existed); a target removed later carries no link
    if (hasOwn(input, src) && !hasOwn(out, src) && hasOwn(out, dst)) finalMerged[src] = dst;
  }
  const removed = Object.keys(input)
    .filter((k) => !hasOwn(out, k))
    .map((k) => ({ key: k, reason: removeReason.get(k) ?? (finalMerged[k] ? `merged into ${finalMerged[k]}` : 'cleaned') }));
  const changedKeys = Object.keys(out).filter((k) => !hasOwn(input, k) || input[k] !== out[k]);
  return { facts: out, removed, mergedInto: finalMerged, changedKeys };
}

/**
 * Guard A (max drop) + Guard B (no invention) for applied ops — the whole-object
 * path's guards, per item. `reason` is audited (keys only, never values — the
 * memory-audit rule); `novel` (value words) goes to the log line only.
 */
export function dreamOpsGuardVerdict(input: Record<string, string>, applied: AppliedDreamOps): { reason: string; novel?: string[] } | null {
  const inputCount = Object.keys(input).length;
  const dropped = applied.removed.length; // keys removed + keys merged away
  const maxDrop = Math.max(1, Math.floor(inputCount * MAX_DREAM_DROP_RATIO));
  if (inputCount >= 2 && dropped > maxDrop) return { reason: `kept only ${inputCount - dropped}/${inputCount} facts (max drop ${maxDrop})` };
  const inputTokens = new Set(topicalTokens(Object.entries(input).map(([k, v]) => `${k} ${v}`).join(' ')));
  for (const k of applied.changedKeys) {
    const outTokens = topicalTokens(`${k.replace(/_/g, ' ')} ${applied.facts[k]}`);
    const novel = outTokens.filter(t => !inputTokens.has(t) && !SAFE_CANONICAL_TOKENS.has(t));
    if (outTokens.length > 0 && novel.length >= 2 && novel.length / outTokens.length > 0.34) {
      return { reason: `novel content in "${k}"`, novel: novel.slice(0, 5) };
    }
  }
  return null;
}

/**
 * Per-item ops consolidation: the model answers ONLY changes, so the answer is
 * bounded by the changes — a 120-fact memory no longer truncates the JSON.
 * Every call records a memory_extraction outcome (source 'dream').
 */
async function consolidateFactsWithOps(
  userId: string,
  facts: Record<string, string>,
  rejections: string[],
): Promise<ConsolidationResult> {
  const meta = factVersionsEnabled() ? await getFactMeta(userId) : null;
  let dated = false;
  const factsStr = Object.entries(facts).map(([k, v]) => {
    const since = factSinceSuffix(meta, k);
    if (since) dated = true;
    return `  ${k}: ${v}${since}`;
  }).join('\n');
  const prompt = buildDreamOpsPrompt(factsStr, rejections, dated);
  const startedAt = Date.now();
  // f177: which provider leg answered + its finish reason lands on EVERY
  // outcome row (the firing-45 pattern — a bare parse_error row is
  // unattributable: DeepSeek vs DashScope, length-clipped or not).
  let leg: string | undefined;
  let finishReason: string | undefined;
  let budgetUsed = DREAM_OPS_BUDGET_TOKENS;
  const outcome = (o: 'changed' | 'noop' | 'parse_error' | 'llm_error' | 'empty', detail?: string) =>
    recordExtractionOutcome({ userId, source: 'dream', outcome: o, ms: Date.now() - startedAt, budgetTokens: budgetUsed, ...(leg ? { leg } : {}), ...(finishReason ? { finishReason } : {}), ...(detail ? { detail } : {}) });

  const dreamMessages = [{ role: 'user' as const, content: prompt }];
  let raw: string;
  try {
    raw = await utilityChat(dreamMessages, {
      maxTokens: DREAM_OPS_BUDGET_TOKENS, temperature: 0.2, timeout: 45000, retryNotFound: true, contentOnly: true,
      onMeta: (m) => { leg = m.leg; finishReason = m.finishReason; },
    });
  } catch (err: any) {
    outcome('llm_error', String(err?.message ?? err));
    return null;
  }
  let parsed = raw && String(raw).trim() ? parseModelJson<Record<string, unknown>>(raw) : null;
  // f177 (2026-10-21 audit, prod row 11:38Z): a merge-heavy ops answer clipped
  // at the 1500 cap (the merge list cut mid-string → parse_error → the dream
  // kept the originals). For an active user the SAME long merge proposal
  // re-clips every dream, so their facts never consolidate — the truncation
  // twin of f176's rejections.join wedge. The clip signature is EXACTLY
  // finishReason='length' with a non-empty raw (mirrors the project_brief
  // brief_length_retry arm): retry ONCE at the bigger budget. A junk answer
  // with fr≠'length' never re-pays the call.
  // DREAM_OPS_LENGTH_RETRY_DISABLED=1 restores the single-attempt behavior.
  if (!parsed && String(raw ?? '').trim() && finishReason === 'length' && !process.env.DREAM_OPS_LENGTH_RETRY_DISABLED) {
    const clippedLeg = leg;
    try {
      const retryRaw = await utilityChat(dreamMessages, {
        maxTokens: DREAM_OPS_LENGTH_RETRY_BUDGET_TOKENS, temperature: 0.2, timeout: 45000, retryNotFound: true, contentOnly: true,
        onMeta: (m) => { leg = m.leg; finishReason = m.finishReason; },
      });
      raw = retryRaw;
      budgetUsed = DREAM_OPS_LENGTH_RETRY_BUDGET_TOKENS;
      parsed = String(raw).trim() ? parseModelJson<Record<string, unknown>>(raw) : null;
      recordLoopMetric({ kind: 'dream_ops_length_retry', meta: { userId, clippedLeg, retryLeg: leg, retryOutcome: parsed ? 'changed' : 'parse_error' } });
    } catch {
      // The retry failed too — raw/leg/finishReason/budgetUsed still describe
      // the clipped FIRST call, so the row below attributes that clip.
    }
  }
  if (!raw || !String(raw).trim()) { outcome('empty'); return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    outcome('parse_error', extractionDetailOf(raw));
    return null;
  }

  const applied = applyDreamOps(facts, parsed);
  const verdict = dreamOpsGuardVerdict(facts, applied);
  if (verdict) {
    logger.warn(`memory-maintenance: consolidation for ${userId} ${verdict.reason}${verdict.novel ? ` (${verdict.novel.join(', ')})` : ''} — rejected as unsafe, keeping originals`);
    outcome('noop', `guard rejected: ${verdict.reason}`);
    return { rejected: verdict.reason };
  }
  const changed = applied.removed.length > 0 || applied.changedKeys.length > 0;
  outcome(changed ? 'changed' : 'noop');
  return { facts: applied.facts, removed: applied.removed, mergedInto: applied.mergedInto };
}

/**
 * Clean the structured UserContextState in PostgresStore:
 * - scrub every field against the user's persistent rejections
 * - clear `currentFocus`/`recentTopics` when memory has been idle 14+ days
 *   (they describe CURRENT activity — long-idle values are stale by definition
 *   and are prime "randomly inserted memory" material)
 */
async function cleanContextState(
  userId: string,
  rejKw: Set<string>,
  memoryUpdatedAt: Date,
): Promise<void> {
  try {
    const state = await storeGet<UserContextState>([userId, 'memory'], 'contextState');
    if (!state) return;

    let updated: UserContextState = rejKw.size > 0 ? scrubUserContextState(state, rejKw) : { ...state };

    const idleMs = Date.now() - memoryUpdatedAt.getTime();
    if (idleMs > STALE_FOCUS_MS && (updated.currentFocus || (updated.recentTopics || []).length > 0)) {
      logger.info(`memory-maintenance: clearing stale currentFocus/recentTopics for ${userId} (idle ${Math.round(idleMs / 86400000)}d)`);
      updated = { ...updated, currentFocus: '', recentTopics: [] };
    }

    const changed = JSON.stringify(updated) !== JSON.stringify(state);
    if (changed) {
      await storePut([userId, 'memory'], 'contextState', updated as unknown as Record<string, unknown>);
      logger.debug(`memory-maintenance: cleaned context state for ${userId}`);
    }
  } catch (err: any) {
    logger.debug(`memory-maintenance: cleanContextState failed for ${userId} (non-fatal): ${err.message}`);
  }
}

export default { startMemoryDreamScheduler, runDreamCycle };

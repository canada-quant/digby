/**
 * Digby Code — CODING WORKER process (durability Phase 2, LEG 2a).
 *
 * Same image as the web backend, different entry: instead of serving HTTP this
 * process runs a 2 s claim tick against Postgres, claiming agent_runs rows
 * (FOR UPDATE SKIP LOCKED — blue/green overlap and replicas are safe) and
 * executing them via run-executor. Deploy survival is the point: a worker
 * SIGTERM marks its active runs shutdown-interrupted (checkpoints retained),
 * and the INCOMING color's worker claims + resumes them within seconds.
 *
 * Phase 3 adds the DURABLE CRON tier: the recurring background sweeps that
 * used to be in-process web setIntervals (news, feeds, memory dream, the two
 * reapers) plus the agent-run reaper are registered in the cron_jobs table at
 * boot and claimed/fired here via startCronLoop — see cron.service.ts.
 *
 * startWorker() is the testable seam (no Redis/Prisma connect, no signal
 * handlers); the main guard at the bottom wires the process together.
 */

import os from 'os';
import fs from 'fs';
// Fail-fast env validation at worker boot (same zod schema as server.ts): the
// worker does the credential injection for coding sessions, so a missing/
// short JWT_SECRET or DATABASE_URL must kill the boot loudly instead of
// silently degrading every session env (2026-08-20 env-wipe report).
import './config/env';
import prisma from './config/database';
import { connectRedis } from './config/redis';
import logger from './utils/logger';
import { claimNextRun } from './modules/crossmodel/coding/run-claim';
import type { ClaimedRun } from './modules/crossmodel/coding/run-claim';
import { executeClaimedRun } from './modules/crossmodel/coding/run-executor';
import { requeueRunWithBackoff } from './modules/crossmodel/coding/run-claim';
import { recordAttemptError } from './modules/crossmodel/coding/run-state';
import { cancelRun, markRunShutdownInterrupted, requestDrainYield } from './modules/crossmodel/coding/live-runs';
import { registerCronJob, startCronLoop, CronLoopHandle, retireOrphanCronJobs } from './modules/crossmodel/cron.service';
import { runNewsSweepOnce } from './modules/crossmodel/news.service';
import { runDreamCycle } from './modules/crossmodel/memory-maintenance.service';
import { runProjectDigestOnce } from './modules/crossmodel/fleet/project-digest.service';
import { isContainerMode, reapIdleContainers } from './modules/crossmodel/coding/container.service';
import { runWorktreeReapOnce, worktreeReapIntervalSec } from './modules/crossmodel/coding/project-workspace.service';
import { runAgentRunReaper } from './modules/crossmodel/coding/run-reaper';
import { runAttentionWatchdogOnce } from './modules/crossmodel/fleet/attention-watchdog.service';
import { runProjectStatusOnce } from './modules/crossmodel/fleet/project-status.service';
import { runLogSignalSweepOnce, LOG_SIGNAL_SWEEP_DISABLED_ENV } from './modules/crossmodel/fleet/log-signal-sweep.service';
import { runSessionHistorySyncOnce } from './modules/crossmodel/coding/session-history-sync.service';
import { runBranchJanitorOnce } from './modules/crossmodel/fleet/branch-janitor.service';
import { startWorktreeReadResponder } from './modules/crossmodel/coding/worktree-remote-read';
import { startBoxHealthReporter, workerDrainFile } from './modules/crossmodel/fleet/infra-watch.service';
import { startWorkerSlotPublisher } from './modules/crossmodel/coding/worker-slots';
import { READINESS_JOB_ID as DECISION_GATE_READINESS_JOB_ID, readinessIntervalSec as decisionGateReadinessIntervalSec } from './modules/crossmodel/platform/decision-gate-readiness';
import { LIVE_CHAT_AUDIT_JOB_ID, LIVE_CHAT_AUDIT_INTERVAL_SEC } from './modules/crossmodel/platform/live-chat-audit';
import { WINDOW_CLOSER_JOB_ID as COMPUTE_POLICY_WINDOW_CLOSER_JOB_ID, WINDOW_CLOSER_INTERVAL_SEC as COMPUTE_POLICY_WINDOW_CLOSER_INTERVAL_SEC } from './modules/crossmodel/platform/compute-policy-window-closer';
import { SESSION_TOPOLOGY_OUTCOMES_JOB_ID, SESSION_TOPOLOGY_OUTCOMES_INTERVAL_SEC } from './modules/crossmodel/platform/session-topology-outcomes';
import { INTERVENTION_OUTCOMES_JOB_ID, INTERVENTION_OUTCOMES_INTERVAL_SEC } from './modules/crossmodel/platform/intervention-outcomes';
import { ROLLOUT_JOB_ID as DECISION_GATE_ROLLOUT_JOB_ID, rolloutIntervalSec as decisionGateRolloutIntervalSec } from './modules/crossmodel/platform/decision-gate-rollout';
import { DELEGATION_RECONCILE_JOB_ID, DELEGATION_RECONCILE_INTERVAL_SEC } from './modules/crossmodel/platform/delegation-tasks-reconcile';
import { primeDecisionModesOnce } from './modules/crossmodel/platform/decision-gate';
import { refreshDecisionBackends } from './modules/crossmodel/platform/decision-gate-backends';
import { finishWorkerShutdown } from './modules/crossmodel/coding/worker-shutdown';
import { runWithTelemetryRun } from './utils/run-telemetry-context';

/** Compose healthcheck target: touched every tick — a wedged worker goes stale. */
const ALIVE_FILE = '/tmp/worker-alive';
/** stop() gives active runs this long to hit a step boundary + finalize. */
const STOP_WAIT_MS = 25_000;
/**
 * DRAIN on deploy (owner 2026-09-24 — "why is it waiting 24 minutes for a
 * question?"): every deploy wave (~10/day from lane merges) used to `docker
 * stop` the old worker after 45 s, shutdown-interrupting 2–4 running runs
 * each time; the runs re-claimed minutes later (lease expiry) and restarted
 * from checkpoint, and the owner's own turn sat "Queued" behind the churn.
 * On SIGTERM the worker now DRAINS: it stops claiming (runs + crons), keeps
 * its active runs to completion (their heartbeats keep their leases), and
 * exits when idle — the deploy script sends the signal without waiting and
 * the new worker claims everything new. Bounded by WORKER_DRAIN_MAX_MS
 * (default 6 h since iteration 12; was 2 h); past that the old interrupt path runs for the leftovers.
 * The marker file lets the deploy script tell a draining worker from a live
 * one (running_workers excludes it; a same-color redeploy waits for it).
 */
// ONE definition of the marker path (ticket 5fba7188): the deploy script probes
// this file to tell a draining worker from a live one, and the telemetry read
// probes it to label which build answered — three readers, one constant.
export { workerDrainFile };
export const DRAIN_FILE = workerDrainFile();
// 6 h since operator iteration 12 (2026-09-25): the deploy script now PARKS a
// draining worker instead of stopping it for its color, so the bound is the
// only thing that can still interrupt a long run — real runs last 4 h+.
export const DRAIN_MAX_MS_DEFAULT = 6 * 60 * 60 * 1000;
export function drainMaxMs(): number {
  const n = Number(process.env.WORKER_DRAIN_MAX_MS);
  return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : DRAIN_MAX_MS_DEFAULT;
}
/**
 * Soft drain yield (2026-10-19): after this long in drain, ask each still-active
 * run to hand off at its next step boundary instead of holding the retiring
 * worker to the 6 h bound (one run held a drainer the full 6 h on 2026-10-18).
 * The hard bound stays. DRAIN_YIELD_DISABLED=1 restores finish-in-place.
 */
const DRAIN_YIELD_AFTER_MS_DEFAULT = 25 * 60 * 1000;
export function drainYieldAfterMs(): number {
  const n = Number(process.env.DRAIN_YIELD_AFTER_MS);
  return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : DRAIN_YIELD_AFTER_MS_DEFAULT;
}
export function drainYieldDisabled(): boolean {
  return process.env.DRAIN_YIELD_DISABLED === '1';
}
/** audit 2026-10-08 W3-4: kill switch for the per-run ambient telemetry run id (see the claim tick). */
export function codingRunTelemetryIdDisabled(): boolean {
  const v = String(process.env.CODING_RUN_TELEMETRY_ID_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Durable cron (Phase 3) — the jobs this worker registers + serves. Each id is
 * claimed out of the cron_jobs table; intervals preserve the cadences the
 * in-process web schedulers used (see docs/durable-cron-phase3.md):
 *   news-prefetch     900 s   (news.service startNewsScheduler: 15-min interval)
 *   memory-dream      3600 s  (memory-maintenance: an hourly TICK under a 55-min Redis-NX
 *                              tick lock; every eligible user — changed since their
 *                              last dream, last dream ≥ 20 h ago — until the tick
 *                              deadline (2026-10-20; DREAM_ALL_ACTIVE_USERS_DISABLED=1
 *                              restores the 20 h cycle lock + 30-user cap). The coding
 *                              project dream rides each tick under its own 20 h gap.)
 *   project-digest    3600 s  (fleet/project-digest.service: hourly per-project
 *                              digest rollup → project_digests rows)
 *   container-reaper  3600 s  (container.service startContainerReaper: hourly)
 *   worktree-reaper   worktreeReapIntervalSec() (default 3600 s; WORKTREE_DISK_ADAPTIVE_DISABLED=1 → 21600 s)
 *   agent-run-reaper  300 s   (Phase 3: stale-lease reaper + GC — see run-reaper.ts)
 *   attention-watchdog 900 s  (fleet/attention-watchdog.service: consolidated
 *                              attention/blocked notices → supervisor threads)
 *   project-status    900 s   (fleet/project-status.service: deterministic
 *                              plain-language status card per PROJECT
 *                              supervisor chat — since 2026-09-29 posted ONLY
 *                              on a milestone change; hook events trigger the
 *                              check, this cron is the catch-all)
 *   idle-chat-archiver 3600 s (idle-chat-archiver: per-project auto-archive of
 *                              idle chats via archiveChat — ticket bb86cee8)
 *   session-history-sync 600 s (coding/session-history-sync.service: per-session
 *                              deterministic HISTORY.md → git plumbing in the
 *                              bare mirror, pushed to origin on the ONE
 *                              consolidated digby/session-history branch as
 *                              sessions/<sessionId>/HISTORY.md — owner 2026-09-14)
 *   branch-janitor    3600 s  (fleet/branch-janitor.service: deletes merged /
 *                              closed-PR / legacy session-history branches on
 *                              every managed GitHub repo; DB/API-only)
 *   log-signal-sweep  3600 s  (fleet/log-signal-sweep.service: fingerprints the
 *                              last 24h of app_error_logs warn/error rows by
 *                              normalized message; fires on recurrence (≥3
 *                              hours or ≥3 boot episodes) or a broken
 *                              suppression promise, files ONE deduped ticket
 *                              per fingerprint per ISO week and wakes the
 *                              Fleet Supervisor; DB+Redis-only — ticket
 *                              8a66441e)
 *   decision-gate-readiness 21600 s (platform/decision-gate-readiness.job: the
 *                              E1 flip-readiness report + stamp + one
 *                              decision_gate_readiness row per purpose;
 *                              DECISION_GATE_READINESS_INTERVAL_MIN; DB-only)
 */
const CRON_JOBS: ReadonlyArray<{ id: string; intervalSec: number }> = [
  { id: 'news-prefetch', intervalSec: 900 },
  // compute_policy window closer (audit 2026-09-26, H1): the `escalated:false` negative 30 min after an untapped answer.
  { id: COMPUTE_POLICY_WINDOW_CLOSER_JOB_ID, intervalSec: COMPUTE_POLICY_WINDOW_CLOSER_INTERVAL_SEC },
  // session-topology-outcomes (2026-09-27): the +24 h label of every placement decision + the observe-only R6 retire scan.
  { id: SESSION_TOPOLOGY_OUTCOMES_JOB_ID, intervalSec: SESSION_TOPOLOGY_OUTCOMES_INTERVAL_SEC },
  // supervisor-intervention-outcomes (INTERVENTION-OUTCOMES, 2026-10-20): the +6 h / +24 h label of every
  // supervisor lane intervention (≤ 150 labels a pass). DB-only — NOT volume-bound. Kill switch
  // SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED=1 (read inside).
  { id: INTERVENTION_OUTCOMES_JOB_ID, intervalSec: INTERVENTION_OUTCOMES_INTERVAL_SEC },
  // (feed-refresh 120 s was retired with the topic-feeds subsystem, ticket
  // 43c24152, 2026-10-20 — digests are coding_schedules rows now, swept by the
  // schedule sweeper; the orphan-GC below retires the row on deploy.)
  { id: 'memory-dream', intervalSec: 3600 },
  { id: 'project-digest', intervalSec: 3600 },
  // Post-deploy ticket verifier (ticket 6665fff6 — b4824553's lifecycle
  // half): re-measures awaiting_verification tickets' acceptance metrics
  // once their fix is live (merged ∧ deployed) and transitions them to
  // deployed_verified / reopened with the measured value attached.
  { id: 'ticket-postdeploy-verifier', intervalSec: 900 },
  // Premise register re-check (owner 2026-09-16, item 2): network-bound, its
  // OWN slot so a slow source can never delay the project digest (4-min
  // budget inside; kill-switch PREMISE_CHECK_DISABLED=1 read inside too).
  { id: 'premise-check', intervalSec: 3600 },
  { id: 'container-reaper', intervalSec: 3600 },
    { id: 'worktree-reaper', intervalSec: worktreeReapIntervalSec() },
  { id: 'agent-run-reaper', intervalSec: 300 },
  // agent_events retention (owner 2026-09-22): bounded PK-range deletes of rows
  // older than 30 days, ≤ 4 × 5,000 rows a tick — steady, never a DELETE storm.
  // Kill switch AGENT_EVENTS_RETENTION_DISABLED=1; dry run …_DRY_RUN=1 (inside).
  // The same tick then runs the T9 tiered compaction (≤ 2 × 2,000 ids; AGENT_EVENTS_COMPACTION_DISABLED=1).
  { id: 'agent-events-retention', intervalSec: 60 },
  { id: 'attention-watchdog', intervalSec: 900 },
  // Project status cards (owner ask 2026-09-14): DB-only, same cadence as the
  // watchdog; the service's own 60-min gate makes the extra firings no-ops.
  { id: 'project-status', intervalSec: 900 },
  // Session status cards (owner ask 2026-09-15): the per-session sibling —
  // DB-only, same cadence; the service's 60-min gate + no-change skip make
  // the extra firings no-ops.
  { id: 'session-status', intervalSec: 900 },
  // Burn-down throughput (2026-08-23): closures are deterministic bookkeeping
  // (closure-manifest.ts), and the ticket drain must fire on a CLOCK, not only
  // on filings — a quiet queue used to mean zero drainage.
  { id: 'ticket-closure-manifest', intervalSec: 600 },
  { id: 'ticket-drain', intervalSec: 1800 },
  { id: 'session-history-sync', intervalSec: 600 },
  // Nightly guard-strike adjudication (remediation P8, N6 second half):
  // deterministic heuristics + one bounded utilityChat batch write verdicts
  // onto last-24h guard_strike rows via adjudicateStrike. DB-only — safe on
  // any worker (incl. the 0-slot cron-only one).
  { id: 'strike-adjudication', intervalSec: 86400 },
  // 2026-10-04: the nightly live-chat audit — signals + decision replay over the last 24 h of real human turns.
  { id: LIVE_CHAT_AUDIT_JOB_ID, intervalSec: LIVE_CHAT_AUDIT_INTERVAL_SEC },
  // Per-project auto-archive of idle chats (ticket bb86cee8): archives chats
  // idle > the folder's autoArchiveIdleDays through platform.service
  // archiveChat (stamp + satellite flip + audit). DB-only.
  { id: 'idle-chat-archiver', intervalSec: 3600 },
  // Branch janitor (owner 2026-09-14: "the framework isnt automatically
  // deleting branches after they are merged"): hourly GitHub-API sweep that
  // deletes fully-merged / squash-merged / closed-PR lane branches and the
  // legacy per-session history mirrors. DB/API-only — NOT volume-bound.
  { id: 'branch-janitor', intervalSec: 3600 },
  // Log-signal sweep (ticket 8a66441e, 2026-10-16): the hourly read of
  // app_error_logs nothing else did — fingerprints warn/error rows by
  // normalized message, fires on recurrence (≥3 distinct hours OR ≥3
  // boot-episode clusters) or a broken suppression promise (quarantine/
  // backoff/once-per text repeating inside its promised window), files ONE
  // deduped ticket per fingerprint per ISO week and wakes the Fleet
  // Supervisor with the ids. DB + Redis only — NOT volume-bound.
  { id: 'log-signal-sweep', intervalSec: 3600 },
  // Proactive DeepSeek balance probe (nightly 2026-09-14, P5 ticket 2b7ceafa
  // class — the reactive billing latch only learns the balance is empty from
  // the first FAILED utility call): hourly GET api.deepseek.com/user/balance —
  // is_available:false or HTTP 401/402/403 latches the DeepSeek leg + files
  // the deduped owner-action ticket BEFORE any utility call fails; the
  // optional DEEPSEEK_BALANCE_WARN_FLOOR adds a low-balance early warning.
  // Pure outbound HTTPS + a deduped ticket — safe on every worker.
  { id: 'deepseek-balance-probe', intervalSec: 3600 },
  // Drive watch renewal (owner-confirmed cf_822011a4, 2026-09-29): daily tick
  // that re-creates channels expiring within 24h (or whose channel never
  // opened) and runs one incremental changes.list reconciliation per watch as
  // a fallback for missed push pings. Zero model spend — the pull runs no
  // model; only real changes fire wakes. Kill switch DRIVE_WATCH_RENEW_DISABLED=1.
  { id: 'drive-watch-renew', intervalSec: 86400 },
  // Decision-gate flip-readiness (E1 in-process, 2026-09-25): the E1 ruler
  // used to be a CLI the prod image could not run (no scripts/, no tsx). The
  // job recomputes the readiness report over the last DECISION_GATE_READINESS_
  // WINDOW_DAYS of decision_gate rows, stamps every purpose READY / NOT READY
  // (the E12 admission read) + stores the report the admin GET returns +
  // records one decision_gate_readiness row per purpose. Cadence
  // DECISION_GATE_READINESS_INTERVAL_MIN (default 360 → 21600 s); kill switch
  // DECISION_GATE_READINESS_JOB_DISABLED=1. DB-only (Postgres-leased, so ONE
  // worker runs a firing fleet-wide; the web boxes never run the cron loop)
  // — NOT volume-bound, so the 0-slot cron-only box A may claim it.
  { id: DECISION_GATE_READINESS_JOB_ID, intervalSec: decisionGateReadinessIntervalSec() },
  // decision-gate-rollout (rollout self-governance, 2026-09-27): the progressive
  // act-flip automaton — after each readiness firing, flips TIER-1 purposes with
  // a fresh MEASURED READY stamp to act through the admin PUT's own admission,
  // parks a purpose auto-demoted twice in 7 d, files ONE owner question per
  // ready tier-2/3 purpose. SystemSetting decision_gate_auto_rollout (default
  // ON); DECISION_GATE_AUTO_ROLLOUT_DRY_RUN=1; kill switch
  // DECISION_GATE_ROLLOUT_JOB_DISABLED=1. DB-only — NOT volume-bound.
  { id: DECISION_GATE_ROLLOUT_JOB_ID, intervalSec: decisionGateRolloutIntervalSec() },
  // user-mcp-health (ticket e294f9a4, 2026-10-06): re-probes every enabled
  // USER-ADDED MCP server whose nextCheckAt is due (healthy every 30 min, a
  // failing one on a 5 min → 6 h backoff), records degraded / unhealthy /
  // recovered and re-syncs its tool list. Outbound HTTPS + context-store rows
  // only — NOT volume-bound. Kill switches USER_MCP_DISABLED=1 (whole feature)
  // and USER_MCP_HEALTH_DISABLED=1 (probing only).
  { id: 'user-mcp-health', intervalSec: 300 },
  // visitor-analytics (owner 2026-10-07): first-party visitor analytics maintenance — deletes visit_events older
  // than VISIT_EVENTS_RETENTION_DAYS (default 400) + never-linked visitors unseen as long (always — privacy), and
  // rolls loop_metrics run_spend (kept 30 d) into spend_daily_rollups so the per-user "all" API cost survives the
  // loop_metrics sweep (SPEND_ROLLUP_DISABLED=1 skips the rollup). DB-only — NOT volume-bound.
  { id: 'visitor-analytics', intervalSec: 21600 },
  // delegation-reconcile (build 2026-10-08 D): the nightly readout of the SHADOW delegation ledger against each kind's
  // source of truth (agreement / missing parents / missing rows / stale) + the tool-intent journal's daily summary
  // (keys executed twice, orphaned pendings) + their retention. DB-only — NOT volume-bound. Kill switches
  // DELEGATION_TASKS_DISABLED=1 / TOOL_INTENT_JOURNAL_DISABLED=1 (read inside).
  { id: DELEGATION_RECONCILE_JOB_ID, intervalSec: DELEGATION_RECONCILE_INTERVAL_SEC },
  // capacity-probe (todo 0f58ddde, 2026-10-16 — the board-surface gap): the
  // shared coding box's SATURATION probes — deploy drainer pool occupancy
  // (docker ps name-epoch + agent_runs.workerId live counts) and per-container
  // dev-container memory (cgroup v2 WORKING SET, page-cache-corrected) — one
  // capacity_drainer_pool / capacity_dev_memory loop_metrics row per tick,
  // healthy included. The DB-only classifier that raises [INFRA ALERT —
  // capacity] from those rows rides the infra-watch sweep (section 5) on any
  // worker. Docker reads only work where DOCKER_HOST reaches the coding box's
  // socket proxy, so this is VOLUME-BOUND (box C); everywhere else the probe
  // fail-opens to NO row and the classifier's staleness bound handles it.
  // Kill switch CAPACITY_WATCH_DISABLED=1 (probe + classifier + drain metric).
  { id: 'capacity-probe', intervalSec: 900 },
  // memory-embed-backfill (ticket d7bf73c2, 2026-10-17): the repair cron for
  // NULL-embedding digby_memory rows — a DashScope 429 used to drop whole
  // stores keyword-only with no retry and no repair (Box C 2026-10-16:
  // "0/7 row(s) stored keyword-only … throttled"). Every 15 min it re-embeds
  // the oldest NULL rows (≤ 50/tick, 10-min minimum age, 7-day max age,
  // per-row provider-reject cooldown) and writes vectors in place, guarded by
  // AND embedding IS NULL. DB-only — NOT volume-bound. Kill switch
  // MEMORY_EMBED_BACKFILL_DISABLED=1 (the service re-checks it too).
  { id: 'memory-embed-backfill', intervalSec: 900 },
  // framework-signal-sweep (2026-10-16): hourly DB-only scan that files deduped bug_report tickets
  // (raw markers that survive renderer cleaning, incomplete owner cards, recurring log signatures,
  // admin frustration). Kill switch FRAMEWORK_SIGNAL_SWEEP_DISABLED=1 (read inside).
  { id: 'framework-signal-sweep', intervalSec: 3600 },
  // ci-watch (CI-WATCH 2026-10-20): the no-LLM CI watch over lane-pushed shas — every 5 min, ≤ 30 GitHub
  // reads a pass with the lane owner's token; a completed red sha wakes the LANE first (one direct wake with
  // the failing checks), then — still red with the lane idle / past a 2 h hold — tells the project
  // supervisor once (ci_failed). DB + GitHub API only — NOT volume-bound. Kill switch CI_WATCH_DISABLED=1.
  { id: 'ci-watch', intervalSec: 300 },
  // memory-archive-retention (2026-10-20 memory wave): the cold tier's end of life — archived
  // digby_memory rows (moved there by the scope cap instead of deleted) are dropped after 30 d
  // (session scope) / 365 d (every other scope), ≤ 10 × 5000 rows per window per pass.
  // DB-only — NOT volume-bound. Never throws; a missing archive table is a quiet no-op.
  { id: 'memory-archive-retention', intervalSec: 86400 },
  // learnings-dream (2026-10-20 memory wave): the scheduled dream over each project's LEARNINGS INDEX
  // (coding/learnings-dream.ts) — near-duplicate learning rows merged into one, ≤ 30 % absorbed per pass,
  // each project at most every 7 d. The repo file is never touched (the cron box has no worktree).
  // DB + utility model only — NOT volume-bound. Kill switch LEARNINGS_DREAM_DISABLED=1 (read inside).
  { id: 'learnings-dream', intervalSec: 86400 },
  // merge-intents (MERGE-INTENT-AWAIT 2026-10-20): the harness-owned waits — every 2 min it re-runs every merge
  // gate on the exact head of each queued merge intent (≤ 10 a pass; a PR read + a check-runs read each, the full
  // gate only once CI is complete) and merges at green, then re-probes the await_condition wakes (≤ 20 a pass);
  // each outcome wakes the lane ONCE. DB + GitHub API only — NOT volume-bound. Kill switches
  // MERGE_INTENT_QUEUE_DISABLED=1 / AWAIT_CONDITION_DISABLED=1 (read inside the pass).
  { id: 'merge-intents', intervalSec: 120 },
];

/**
 * Review 2026-09-13 issue 8: crons that touch the coding-workspaces VOLUME or
 * the session containers. Only the box that OWNS the volume (the worker with
 * CODING_WORKER_CONCURRENCY > 0 — box C) may register/claim them; a 0-slot
 * cron-only worker (box A) holds a stale pre-split COPY of the volume and a
 * DOCKER_HOST pointing at C, so a claim there deletes the wrong dirs, nulls
 * the shared DB path for C's real dir (the 177-orphan incident), and would
 * converge C's dev containers to A's host-derived memory ceiling. DB-only
 * sweeps (digests, drain, adjudication, the agent-run reaper) stay claimable
 * on every worker.
 */
export const VOLUME_BOUND_CRON_JOBS: ReadonlySet<string> = new Set([
  'session-history-sync',
  'worktree-reaper',
  'container-reaper',
  // capacity-probe (todo 0f58ddde, 2026-10-16): docker reads only work where
  // DOCKER_HOST reaches the coding box's filtered socket proxy — box C. A
  // 0-slot worker claiming it would docker-ps against C anyway (same DOCKER_HOST
  // reasoning as container-reaper) but the rows must come from ONE box's
  // clock-skew-free epoch parse, and a claim on box A would starve box C's
  // probe cadence — same shape as the 177-orphan gate.
  'capacity-probe',
]);

/** job id → sweep. Guards that lived in the old start* wrappers ride along. */
function buildCronHandlers(): Record<string, () => Promise<void | string>> {
  return {
    'news-prefetch': () => runNewsSweepOnce(),
    'memory-dream': async () => {
      if (process.env.MEMORY_DREAM_DISABLED === '1') return; // the old start* guard
      await runDreamCycle();
    },
    'project-digest': async () => {
      if (process.env.PROJECT_DIGEST_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern)
      await runProjectDigestOnce();
    },
    'ticket-postdeploy-verifier': async () => {
      if (process.env.TICKET_POSTDEPLOY_VERIFIER_DISABLED === '1') return; // kill-switch (PROJECT_DIGEST_DISABLED pattern; the service re-checks it too)
      const { runTicketPostdeployVerifierOnce } = await import('./modules/crossmodel/feedback/ticket-postdeploy-verifier.service');
      return runTicketPostdeployVerifierOnce(); // ≤200-char summary → cron_jobs.lastStatus (session-history-sync pattern)
    },
    'premise-check': async () => {
      if (process.env.PREMISE_CHECK_DISABLED === '1') return; // kill-switch (PROJECT_DIGEST_DISABLED pattern; the service re-checks it too)
      const { runPremiseCheckOnce } = await import('./modules/crossmodel/platform/premise-register');
      await runPremiseCheckOnce();
    },
    'container-reaper': async () => {
      if (!isContainerMode()) return; // startContainerReaper didn't even start otherwise
      await reapIdleContainers();
      // Shared tailnet dev containers (3ba5d35d): reap only when the owner
      // disabled the feature (or vanished) — they deliberately outlive sessions.
      // Then (4ed6eb2e): in the same quiet sweep, upgrade legacy (pre-scoping)
      // dev containers to per-session egress scoping and repair dead shims —
      // both are no-ops unless CODING_EGRESS_SECRET is set.
      const { reapDisabledDevContainers, upgradeLegacyEgressContainers, convergeDevContainerCeilings, convergeDevContainerMounts } = await import('./modules/crossmodel/coding/dev-container.service');
      await reapDisabledDevContainers();
      await upgradeLegacyEgressContainers();
      // build 2026-10-08 ISO: per-user subtree mounts — recreate (idle only) a dev container whose
      // workspace mounts drifted from its plan; a no-op unless CODING_WORKSPACE_PER_USER_SUBTREE is on.
      await convergeDevContainerMounts();
      // Ticket c12239c1 ASK #3: converge every RUNNING dev container to the
      // host-derived memory ceiling (floor 12g, cap host−4 GiB) — a config/host
      // change must not be a no-op for containers created earlier.
      await convergeDevContainerCeilings();
    },
    'worktree-reaper': () => runWorktreeReapOnce(),
    'agent-run-reaper': async () => {
      await runAgentRunReaper();
      // Night-window ticket-lane kick (22:00 PT). No-ops outside the start
      // hour and never fails the reaper. The 30-min ticket-drain alone can
      // miss the window open by up to 30 min.
      try {
        const { maybeKickNightTicketDrain } = await import('./modules/crossmodel/feedback/ticket-dispatch.service');
        await maybeKickNightTicketDrain();
      } catch { /* night-window kick must never fail the reaper */ }
    },
    'agent-events-retention': async () => {
      if (process.env.AGENT_EVENTS_RETENTION_DISABLED === '1') return; // kill-switch (the service re-checks it too)
      const { runAgentEventsRetentionOnce, runAgentEventsCompactionOnce } = await import('./modules/crossmodel/coding/agent-events-retention.service');
      await runAgentEventsRetentionOnce();
      // Tiered compaction inside the window (audit 2026-10-06 T9-2): reasoning rows, all-but-last context, screenshot /
      // image bytes, complete.parts — bounded PK ranges, its own cursor. AGENT_EVENTS_COMPACTION_DISABLED=1 (inside).
      await runAgentEventsCompactionOnce();
    },
    'attention-watchdog': async () => {
      if (process.env.ATTENTION_WATCHDOG_DISABLED === '1') return; // kill-switch (PROJECT_DIGEST_DISABLED pattern)
      await runAttentionWatchdogOnce();
    },
    'project-status': async () => {
      if (process.env.PROJECT_STATUS_UPDATES_DISABLED === '1') return; // kill-switch (PROJECT_DIGEST_DISABLED pattern; the service re-checks it too)
      await runProjectStatusOnce();
    },
    'session-status': async () => {
      if (process.env.SESSION_STATUS_UPDATES_DISABLED === '1') return; // kill-switch (same pattern; the service re-checks it too)
      const { runSessionStatusOnce } = await import('./modules/crossmodel/coding/session-status.service');
      await runSessionStatusOnce();
    },
    'ticket-closure-manifest': async () => {
      const { applyClosureManifest } = await import('./modules/crossmodel/feedback/closure-manifest');
      await applyClosureManifest();
    },
    'ticket-drain': async () => {
      const { drainOpenTicketsToLane } = await import('./modules/crossmodel/feedback/ticket-dispatch.service');
      await drainOpenTicketsToLane();
      // SHARED-PROJECT-DISPATCH (2026-10-20): a ticket HELD for an admin (another account's) > 2 h raises ONE owner
      // card (Approve / Keep held / Dismiss) and the answer is applied here — bounded (≤ 1 new card a pass, ≤ 3 open),
      // DB + owner-question writes only, never throws. Kill switch HELD_TICKET_ESCALATION_DISABLED=1 (read inside).
      const { runHeldTicketEscalationOnce } = await import('./modules/crossmodel/feedback/held-ticket-escalation');
      await runHeldTicketEscalationOnce();
    },
    // capacity-probe (todo 0f58ddde): box-C saturation probes → loop_metrics
    // rows; the infra-watch sweep's capacity classifier (section 5) reads them
    // DB-only on any worker. Fail-open by design: an unavailable docker
    // socket writes NO row (never a false healthy, never a throw).
    'capacity-probe': async () => {
      if (process.env.CAPACITY_WATCH_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern; the probe re-checks it too)
      const { probeDrainerPool, probeDevMemory } = await import('./modules/crossmodel/fleet/capacity-watch.service');
      await probeDrainerPool();
      await probeDevMemory();
      return 'capacity probes recorded'; // ≤200-char lastStatus (FO firing 15 pattern)
    },
    'memory-embed-backfill': async () => {
      // Ticket d7bf73c2: repair NULL-embedding digby_memory rows. Never
      // throws; returns the ≤200-char pass summary for cron_jobs.lastStatus
      // (session-history-sync pattern). Kill switch re-checked inside.
      const { runMemoryEmbedBackfillOnce } = await import('./modules/crossmodel/memory/embed-backfill.service');
      return runMemoryEmbedBackfillOnce();
    },
    'session-history-sync': async () => {
      if (process.env.SESSION_HISTORY_SYNC_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern)
      // Return the pass summary for cron_jobs.lastStatus (FO firing 15 — the
      // cron tick's status pass-through); runSessionHistorySyncOnce NEVER
      // throws and returns a ≤200-char "synced N, … , no mirror N, skipped N".
      return runSessionHistorySyncOnce();
    },    'strike-adjudication': async () => {
      if (process.env.STRIKE_ADJUDICATION_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern)
      const { runStrikeAdjudicationOnce } = await import('./modules/crossmodel/fleet/strike-adjudication.service');
      await runStrikeAdjudicationOnce(); // logs its own one-line summary
    },
    'idle-chat-archiver': async () => {
      if (process.env.IDLE_CHAT_ARCHIVER_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern)
      const { runIdleChatArchiverOnce } = await import('./modules/crossmodel/idle-chat-archiver');
      await runIdleChatArchiverOnce(); // logs its own one-line summary
    },
    'branch-janitor': async () => {
      if (process.env.BRANCH_JANITOR_DISABLED === '1') return; // kill-switch (PROJECT_DIGEST_DISABLED pattern; the service re-checks it too)
      await runBranchJanitorOnce(); // logs its own one-line summary; BRANCH_JANITOR_DRY_RUN=1 only logs
    },
    'log-signal-sweep': async () => {
      if (process.env[LOG_SIGNAL_SWEEP_DISABLED_ENV] === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern; the sweep re-checks it too)
      // Never throws; returns the ≤200-char pass summary for cron_jobs.lastStatus
      // (session-history-sync pattern).
      return runLogSignalSweepOnce();
    },
    'deepseek-balance-probe': async () => {
      if (process.env.DEEPSEEK_BALANCE_PROBE_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern)
      const { probeDeepSeekBalance } = await import('./utils/utility-llm');
      logger.info(`deepseek-balance-probe: ${await probeDeepSeekBalance()}`); // one-line summary (branch-janitor pattern)
    },
    'drive-watch-renew': async () => {
      if (process.env.DRIVE_WATCH_RENEW_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern)
      const { renewDriveWatches } = await import('./modules/crossmodel/google/drive-watch.service');
      const r = await renewDriveWatches();
      logger.info(`drive-watch-renew: checked ${r.checked}, renewed ${r.renewed}, renewFailed ${r.renewFailed}, fired ${r.fired}`); // one-line summary
    },
    [LIVE_CHAT_AUDIT_JOB_ID]: async () => {
      // 2026-10-04: nightly hardening over REAL human chats — LIVE_CHAT_AUDIT_DISABLED=1 inside (+ _TICKETS_DISABLED = report only).
      const { runLiveChatAuditOnce } = await import('./modules/crossmodel/platform/live-chat-audit');
      return runLiveChatAuditOnce();
    },
    [COMPUTE_POLICY_WINDOW_CLOSER_JOB_ID]: async () => {
      // Audit 2026-09-26 (H1): the compute_policy window-closed NEGATIVE — kill switch inside.
      const { runComputePolicyWindowCloserOnce } = await import('./modules/crossmodel/platform/compute-policy-window-closer');
      return runComputePolicyWindowCloserOnce();
    },
    [SESSION_TOPOLOGY_OUTCOMES_JOB_ID]: async () => {
      // Session topology (2026-09-27): +24 h placement labels + the observe-only R6 retire scan — kill switches inside.
      const { runSessionTopologyOutcomesOnce, runSessionTopologyRetireScanOnce } = await import('./modules/crossmodel/platform/session-topology-outcomes');
      const a = await runSessionTopologyOutcomesOnce();
      const b = await runSessionTopologyRetireScanOnce();
      return `${a}; ${b}`.slice(0, 200);
    },
    [INTERVENTION_OUTCOMES_JOB_ID]: async () => {
      // INTERVENTION-OUTCOMES (2026-10-20): +6 h / +24 h labels of supervisor lane interventions — kill switch inside.
      const { runInterventionOutcomesOnce } = await import('./modules/crossmodel/platform/intervention-outcomes');
      return runInterventionOutcomesOnce();
    },
    [DECISION_GATE_READINESS_JOB_ID]: async () => {
      if (process.env.DECISION_GATE_READINESS_JOB_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern; the job re-checks it too)
      const { runDecisionGateReadinessOnce } = await import('./modules/crossmodel/platform/decision-gate-readiness.job');
      // Never throws; returns the ≤200-char pass summary for cron_jobs.lastStatus (session-history-sync pattern).
      return runDecisionGateReadinessOnce();
    },
    'user-mcp-health': async () => {
      if (process.env.USER_MCP_DISABLED === '1' || process.env.USER_MCP_HEALTH_DISABLED === '1') return; // kill-switches (the sweep re-checks USER_MCP_DISABLED too)
      const { runUserMcpHealthSweepOnce } = await import('./modules/crossmodel/user-mcp/user-mcp.service');
      // Never throws; returns the ≤200-char pass summary for cron_jobs.lastStatus.
      return runUserMcpHealthSweepOnce();
    },
    'visitor-analytics': async () => {
      const { runVisitorAnalyticsMaintenanceOnce } = await import('./modules/crossmodel/visitors/visitor-analytics.service');
      // Never throws; returns the ≤200-char pass summary for cron_jobs.lastStatus.
      return runVisitorAnalyticsMaintenanceOnce();
    },
    [DECISION_GATE_ROLLOUT_JOB_ID]: async () => {
      if (process.env.DECISION_GATE_ROLLOUT_JOB_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern; the job re-checks it too)
      const { runDecisionGateRolloutOnce } = await import('./modules/crossmodel/platform/decision-gate-rollout');
      // Never throws; returns the ≤200-char pass summary for cron_jobs.lastStatus.
      return runDecisionGateRolloutOnce();
    },
    [DELEGATION_RECONCILE_JOB_ID]: async () => {
      // build 2026-10-08 D: the SHADOW delegation ledger + tool-intent journal readout — kill switches inside.
      const { runDelegationReconcileOnce } = await import('./modules/crossmodel/platform/delegation-tasks-reconcile');
      return runDelegationReconcileOnce();
    },
    'framework-signal-sweep': async () => {
      const { runFrameworkSignalSweepOnce } = await import('./modules/crossmodel/fleet/framework-signal-sweep');
      return runFrameworkSignalSweepOnce();
    },
    'ci-watch': async () => {
      if (process.env.CI_WATCH_DISABLED === '1') return; // kill-switch (MEMORY_DREAM_DISABLED pattern; the pass re-checks it too)
      const { runCiWatchOnce } = await import('./modules/crossmodel/coding/ci-watch.service');
      // Never throws; returns the ≤200-char pass summary for cron_jobs.lastStatus.
      return runCiWatchOnce();
    },
    'memory-archive-retention': async () => {
      const { runMemoryArchiveRetention } = await import('./modules/crossmodel/memory/memory-archive');
      const r = await runMemoryArchiveRetention();
      return `archive retention: deleted ${r.deleted} row(s)`; // ≤200-char lastStatus
    },
    'learnings-dream': async () => {
      const { runLearningsDreamCycle } = await import('./modules/crossmodel/coding/learnings-dream');
      const r = await runLearningsDreamCycle(); // never throws; a no-op under LEARNINGS_DREAM_DISABLED=1
      return `learnings dream: ${r.projects} project(s), ${r.clusters} cluster(s), ${r.absorbed} absorbed`;
    },
    'merge-intents': async () => {
      // MERGE-INTENT-AWAIT (2026-10-20): both kill switches are read inside the pass (each half stands down alone).
      const { runHarnessWaitsOnce } = await import('./modules/crossmodel/coding/merge-intent.service');
      // Never throws; returns the ≤200-char pass summary for cron_jobs.lastStatus.
      return runHarnessWaitsOnce();
    },
  };
}

export interface WorkerHandle {
  stop: () => Promise<void>;
  /** Drain on deploy (2026-09-24): no new claims, active runs finish in place, resolves when idle (or past maxMs after interrupting leftovers). */
  drain: (opts?: { maxMs?: number; pollMs?: number; yieldAfterMs?: number }) => Promise<{ drained: number; interrupted: number; ms: number }>;
}

/** CODING_WORKER_CONCURRENCY as configured — 0 is valid (cron-only box A);
 *  absent/invalid keeps the old default of 2. */
export function configuredConcurrency(): number {
  const rawConc = parseInt(process.env.CODING_WORKER_CONCURRENCY || '', 10);
  return Number.isFinite(rawConc) && rawConc >= 0 ? rawConc : 2;
}

export function startWorker(opts?: { tickMs?: number; concurrency?: number; cronTickMs?: number }): WorkerHandle {
  const tickMs = opts?.tickMs ?? 2_000;
  // 0 is a VALID setting (2026-08-26 coding-box split): a 0-slot worker runs
  // the durable cron tier (watchdog/digests/drain — Postgres-leased, no
  // duplication) but never claims runs — box A's role after sessions moved to
  // the dedicated coding box C. Absent/invalid env keeps the old default.
  const concurrency = opts?.concurrency ?? configuredConcurrency();
  const workerId = `worker-${os.hostname()}-${process.pid}`;
  const active = new Map<string, string>(); // runId → sessionId
  let stopped = false;
  let ticking = false;

  // ── Durable cron (Phase 3) ─────────────────────────────────────────────
  // Register this worker's jobs (upsert — never clobbers nextRunAt/lastFiredAt)
  // then start the claim loop alongside the run-claim tick. Boot registration
  // is only the FAST path (Phase-3 review H2): the loop itself re-registers
  // every job every 60 s (see CRON_REREGISTER_MS), so a transient boot-time
  // failure here just delays the first registration by up to a minute — the
  // table self-heals; this call is no longer load-bearing.
  // Workspace-volume-bound crons never run on a 0-slot (cron-only) worker:
  // box A's stale pre-split mirrors made session-history-sync fail 6/25 every
  // pass it won the claim (expired embedded push tokens → auth failures; one
  // missing mirror dir → spawn git ENOENT; 2026-09-08). The gate must be at
  // the CLAIM level — a handler no-op would still consume the firing and
  // starve box C from syncing that tick — so the job is simply absent from
  // this worker's registration + claim list; C claims it exclusively.
  // Review 2026-09-13 issue 8: the same gate now covers EVERY disk-touching
  // cron (VOLUME_BOUND_CRON_JOBS), not just session-history-sync — the
  // worktree reaper fired on box A against its stale 48G copy and nulled the
  // shared DB paths, orphaning C's real dirs.
  const cronJobs = concurrency === 0
    ? CRON_JOBS.filter(j => !VOLUME_BOUND_CRON_JOBS.has(j.id))
    : CRON_JOBS;
  // Decision-gate caches primed at boot (audit 2026-09-26 gate-runtime-1: a
  // fresh worker's first asks fell to the env default mode — a store 'off'
  // purpose leaked one shadow call per container). decide() itself awaits the
  // same deduped prime, so the first ask never runs ahead of it; bounded +
  // fail-open (env chain) inside.
  void Promise.allSettled([primeDecisionModesOnce(), refreshDecisionBackends()]);
  const cronRegistration = Promise.all(
    cronJobs.map(j => registerCronJob(j.id, j.intervalSec)),
  ).then(
    () => logger.info(`cron: registered ${cronJobs.length} jobs (${cronJobs.map(j => j.id).join(', ')})`),
    err => logger.error(`cron: boot job registration failed (the cron loop re-registers every 60s — self-healing): ${err?.message ?? err}`),
  );
  const cronLoop: CronLoopHandle = startCronLoop(workerId, buildCronHandlers(), cronJobs, opts?.cronTickMs ?? 5_000);

  // Self-host setup hardening (2026-10-20): the feed sweep / news scheduler
  // read the instance-setup leaf's web-search state — prime its admin-store
  // note in this process (no-op when BRIGHTDATA_API_TOKEN is set).
  import('./modules/crossmodel/platform/search-provider-config')
    .then((m) => m.startWebSearchStorePrimer())
    .catch((err) => logger.warn(`web-search store primer did not start: ${err?.message || err}`));

  // (Feed boot maintenance — entry-cap prune + title cleanup — was retired with
  // the topic-feeds subsystem, ticket 43c24152, 2026-10-20.)
  // audit 2026-10-08 W3-4 (plumbing F10): retire cron rows NO worker serves (the stale `box-health` row since
  // 09-18). The FULL code list, never this box's filtered one; 7-day overdue floor; CRON_ORPHAN_GC_DISABLED=1.
  void cronRegistration.then(() => retireOrphanCronJobs(CRON_JOBS.map(j => j.id))).catch(() => {});

  const touchAlive = () => {
    try {
      if (fs.existsSync(ALIVE_FILE)) fs.utimesSync(ALIVE_FILE, new Date(), new Date());
      else fs.writeFileSync(ALIVE_FILE, String(Date.now()));
    } catch { /* the healthcheck touch is best-effort — never kill the tick over it */ }
  };

  // ff262da5: worker-local deferral counters for run admission (runId →
  // consecutive admissions deferred). Bounded (cleared when a run finally
  // executes or the row leaves the queue) so it can never grow unbounded.
  const admissionDeferrals = new Map<string, number>();

  const admitClaimedRun = async (claim: ClaimedRun, worker: string): Promise<boolean> => {
    const { devContainerMemoryAdmission } = await import('./modules/crossmodel/coding/dev-container.service');
    // The claim carries sessionId only; the dev container is keyed by USER
    // (digby-dev-<userId12>). Resolve session → owner once (cached per call;
    // a miss / disabled dev container → admit — per-session containers run
    // with their own --memory cap and are not this ticket's starvation class).
    const state = await prisma.chatCodingState.findUnique({ where: { id: claim.sessionId }, select: { userId: true } }).catch(() => null);
    const userId = state?.userId;
    if (!userId) return true;
    const probe = await devContainerMemoryAdmission(userId);
    if (probe.admit || !probe.reason) { admissionDeferrals.delete(claim.id); return true; }
    const deferred = (admissionDeferrals.get(claim.id) ?? 0) + 1;
    const maxDeferrals = Math.max(1, Number(process.env.RUN_ADMISSION_MAX_DEFERRALS) || 10);
    if (deferred > maxDeferrals) {
      admissionDeferrals.delete(claim.id);
      logger.warn(`coding worker ${worker}: run ${claim.id} admission ESCAPE after ${maxDeferrals} deferrals — admitting at ${probe.workingSetPct?.toFixed(1)}% working set (a persistently starved container must never wedge the queue; ff262da5)`);
      return true;
    }
    admissionDeferrals.set(claim.id, deferred);
    const backoffMs = Math.min(30_000 * 2 ** Math.max(0, deferred - 1), 600_000);
    await requeueRunWithBackoff(claim.id, backoffMs, probe.reason);
    logger.warn(`coding worker ${worker}: run ${claim.id} (session ${claim.sessionId}) NOT admitted — ${probe.reason}; requeued notBefore=+${Math.round(backoffMs / 1000)}s (deferral ${deferred}/${maxDeferrals})`);
    return false;
  };

  const tick = async () => {
    touchAlive();
    if (stopped) return;
    // Claim until the queue is empty or every slot is busy. Claim ERRORS (DB
    // hiccup) just end this tick — the worker stays alive and retries next tick.
    while (active.size < concurrency) {
      // Reserve the LAST slot for interactive (user-origin) runs — machine
      // work (schedules/batches/hooks) may occupy at most concurrency-1 slots,
      // so a human typing into a session never waits behind a full machine
      // fleet (2026-08-26 owner report). ONLY when there IS a spare slot to
      // reserve: with concurrency 1, active.size >= concurrency-1 is 0>=0 =
      // ALWAYS true, so interactiveOnly was permanently on and machine-origin
      // runs (schedule/hook/agent/webhook) were never claimed — silently, no
      // error anywhere (found 2026-08-30 fleet audit). A single-slot worker
      // must serve everything.
      const lastSlot = concurrency > 1 && active.size >= concurrency - 1;
      let claim: ClaimedRun | null = null;
      try {
        claim = await claimNextRun(workerId, { interactiveOnly: lastSlot });
      } catch (err: any) {
        logger.error(`coding worker ${workerId}: claim failed (retrying next tick): ${err.message}`);
        return;
      }
      if (!claim) return;
      // ff262da5 (todo 4ecfd309, 2026-10-16): RUN admission control. Before a
      // claimed run executes its first tool (every tool exec rides the shared
      // dev container), check that container's memory working set: above the
      // threshold (default 85%) the run goes BACK to the queue with an
      // escalating notBefore backoff (30s → 60s → 120s … capped 10 min) — the
      // Borg/K8s admission model, queue instead of OOM. Bounded escape: after
      // RUN_ADMISSION_MAX_DEFERRALS (default 10) consecutive deferrals of the
      // SAME run, admit anyway — a persistently starved container must never
      // wedge the queue. Fail-open on every probe error. Kill switch
      // RUN_ADMISSION_DISABLED=1.
      try {
        const admitted = await admitClaimedRun(claim, workerId);
        if (!admitted) { continue; }
      } catch (err: any) {
        logger.warn(`coding worker ${workerId}: admission check failed for run ${claim.id} (fail-open, executing): ${String(err?.message ?? err).slice(0, 120)}`);
      }
      active.set(claim.id, claim.sessionId);
      // audit 2026-10-08 W3-4 (plumbing F10): the run executes inside an ambient
      // TELEMETRY run (the agent_runs id) so every loop_metrics row of its session
      // that names no runId — context_compaction above all (650 rows, 0 runIds on
      // one lane) — is attributable per run. An explicit runId always wins.
      // CODING_RUN_TELEMETRY_ID_DISABLED=1 restores the bare call.
      const claimed = claim;
      const runIt = () => executeClaimedRun(claimed);
      void (codingRunTelemetryIdDisabled() ? runIt() : runWithTelemetryRun({ runId: claimed.id, sessionId: claimed.sessionId }, runIt))
        .catch(err => {
          logger.error(`coding worker ${workerId}: run ${claim!.id} crashed: ${err?.message ?? err}`);
          // Overnight forensics fix 4: a harness exception here IS the
          // attempt's terminal cause — the row keeps its lease until expiry
          // and gets re-claimed, and without this record the run eventually
          // dies 'attempts exhausted' with the WHY living only in this log
          // line. Stash it on the row (appended — first cause preserved).
          void recordAttemptError(claim!.id, `harness exception: ${err?.message ?? err}`, claim!.attempts).catch(() => {});
        })
        .finally(() => active.delete(claim!.id));
    }
  };

  const fire = () => {
    if (ticking || stopped) return; // no re-entrant ticks (a stalled claim spans ticks)
    ticking = true;
    void tick().finally(() => { ticking = false; });
  };

  logger.info(`coding worker ${workerId} started (concurrency ${concurrency}, tick ${tickMs}ms)`);
  fire(); // claim immediately — don't sit out the first interval
  const timer = setInterval(fire, tickMs);
  (timer as any).unref?.();
  // Infra watch (owner 2026-09-18): EVERY worker reports its own box's disk /
  // memory / load as a box_health row every 15 min — a per-process interval,
  // not a durable cron (a claimed cron runs on ONE worker per firing, so box C
  // never reported when box A's cron-only worker won the claim; first live
  // sweep 18:39Z). Kill-switch INFRA_WATCH_DISABLED=1 is read inside.
  const stopBoxHealth = startBoxHealthReporter('worker');
  // Live slot registry (2026-10-20): publish this worker's coding slots to
  // Redis every 30 s so the project-supervisor spawn ceiling — evaluated on
  // the WEB boxes, where CODING_WORKER_CONCURRENCY is deliberately not
  // forwarded — tracks the coding box's real slot count instead of a
  // hard-coded 24 (coding/worker-slots.ts). A 0-slot worker publishes
  // nothing; the entry is cleared on stop / drain. Kill switch
  // WORKER_SLOT_REGISTRY_DISABLED=1.
  const stopSlotPublisher = startWorkerSlotPublisher({ workerId, concurrency });

  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    cronLoop.stop(); // stop claiming cron jobs (an in-flight sweep finishes or its lease expires)
    stopBoxHealth();
    stopSlotPublisher(); // sync: clears the interval, removes the entry best-effort
    await cronRegistration.catch(() => {}); // never let a pending boot write outlive stop()
    const stopStartedAt = Date.now();
    logger.info(`coding worker ${workerId}: shutdown — interrupting ${active.size} active run(s): ${[...active.keys()].join(', ') || 'none'}`);
    // Cooperative shutdown: the executor's finalizer maps shutdown-interrupted to
    // resumable 'interrupted' (checkpoint RETAINED); cancelRun makes the agent
    // loop bail at its next step boundary. The session rows stay status='running'
    // — a live worker claims + resumes them.
    const marked = active.size;
    for (const [runId, sessionId] of active) {
      logger.info(`coding worker ${workerId}: marking run ${runId} (session ${sessionId}) shutdown-interrupted + cancelling`);
      markRunShutdownInterrupted(sessionId);
      cancelRun(sessionId);
    }
    const deadline = Date.now() + STOP_WAIT_MS;
    while (active.size && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    // Shutdown bookkeeping (feedback d64f6f08): how many runs the mark/cancel
    // pass covered vs how many drained within the STOP_WAIT_MS budget — the
    // leftovers stay 'running' until their lease expires and a live worker
    // re-claims them via the stale-lease branch.
    const leftover = [...active.entries()];
    logger.info(`coding worker ${workerId}: shutdown summary — marked ${marked} run(s), drained ${marked - active.size}, still active ${active.size}${leftover.length ? ` (${leftover.map(([runId]) => runId).join(', ')})` : ''} after ${Date.now() - stopStartedAt}ms`);
    if (active.size) {
      logger.warn(`coding worker ${workerId}: ${active.size} run(s) still active after ${STOP_WAIT_MS}ms — ${leftover.map(([runId, sessionId]) => `${runId} (session ${sessionId})`).join(', ')} — their leases expire and a live worker re-claims them`);
    }
  };

  /**
   * Drain (see DRAIN_FILE note): no new claims, active runs finish, exit when
   * idle. Resolves with what happened; never throws.
   */
  const drain = async (opts?: { maxMs?: number; pollMs?: number; yieldAfterMs?: number }): Promise<{ drained: number; interrupted: number; ms: number }> => {
    const t0 = Date.now();
    stopped = true;
    clearInterval(timer);
    cronLoop.stop();
    stopBoxHealth();
    stopSlotPublisher(); // a draining worker's slots are leaving — stop counting them (sync, best-effort removal)
    await cronRegistration.catch(() => {});
    try { fs.writeFileSync(DRAIN_FILE, String(t0)); } catch { /* best-effort marker */ }
    const initial = active.size;
    logger.info(`coding worker ${workerId}: DRAINING — no new claims; ${initial} active run(s) finish in place: ${[...active.keys()].join(', ') || 'none'}`);
    const maxMs = opts?.maxMs ?? drainMaxMs();
    const pollMs = opts?.pollMs ?? 1_000;
    const yieldAfterMs = opts?.yieldAfterMs ?? drainYieldAfterMs();
    const yieldAsked = new Set<string>();
    let lastLog = t0;
    while (active.size && Date.now() - t0 < maxMs) {
      touchAlive(); // stay 'healthy' for docker while draining — this is not a dead worker
      if (Date.now() - lastLog >= 60_000) {
        lastLog = Date.now();
        logger.info(`coding worker ${workerId}: draining — ${active.size} run(s) still active after ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      if (!drainYieldDisabled() && Date.now() - t0 >= yieldAfterMs) {
        for (const [runId, sessionId] of active) {
          if (yieldAsked.has(runId)) continue;
          yieldAsked.add(runId);
          logger.info(`coding worker ${workerId}: drain yield — asking run ${runId} (session ${sessionId}) to hand off at its next step`);
          requestDrainYield(sessionId);
        }
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    const leftover = active.size;
    if (leftover) {
      logger.warn(`coding worker ${workerId}: drain bound ${maxMs}ms reached with ${leftover} run(s) still active — interrupting them (checkpoints retained)`);
      await stop();
    }
    const done = { drained: initial - leftover, interrupted: leftover, ms: Date.now() - t0 };
    logger.info(`coding worker ${workerId}: drain complete — ${done.drained} finished in place, ${done.interrupted} interrupted, ${done.ms}ms`);
    try { fs.rmSync(DRAIN_FILE, { force: true }); } catch { /* best-effort */ }
    return done;
  };

  return { stop, drain };
}

/* ====================================================================
 * Main guard — process wiring (untested by unit tests; keep it thin).
 * ==================================================================== */
if (require.main === module) {
  // DELIBERATE deviation from server.ts (which exits on unhandledRejection in
  // production): a single run's stray rejection must NOT kill the worker — it
  // would interrupt every OTHER run it hosts. Executions are tracked in
  // `active` and their errors are handled per-run; anything that escapes is
  // logged and the claim loop keeps ticking.
  process.on('unhandledRejection', (reason: any) => {
    logger.error('coding worker unhandledRejection (continuing):', {
      message: reason?.message || String(reason),
      stack: reason?.stack,
      source: 'unhandledRejection',
    });
  });

  void (async () => {
    await connectRedis();
    await prisma.$connect();
    logger.info('✅ coding worker: Redis + database connected');

    const worker = startWorker();
    // Live Files-tab reads for the web boxes (owner 2026-09-17): only a box
    // with coding slots hosts worktrees — a 0-slot cron-only worker (box A)
    // still mounts a STALE pre-split copy of the volume and must never answer.
    const readResponder = configuredConcurrency() > 0
      ? await startWorktreeReadResponder().catch((err: any) => {
        logger.warn(`worktree remote-read: responder did not start — ${err?.message ?? err}`);
        return null;
      })
      : null;

    const shutdown = async (signal: string) => {
      await readResponder?.stop().catch(() => {}); // the NEW worker answers Files-tab reads from here on
      logger.info(`${signal} received — DRAINING: no new claims, active run(s) finish in place, exit when idle (WORKER_DRAIN_MAX_MS bound)`);
      await worker.drain();
      // audit 2026-10-08 W3-1 (plumbing F1): await the finished runs' follow-up
      // work (hook emits, memory folds, project decisions) and flush the
      // loop-metrics buffer (their run_spend / run_tokens rows) BEFORE the
      // disconnect. Bounded; WORKER_SHUTDOWN_FLUSH_DISABLED=1 skips it.
      await finishWorkerShutdown({ workerId: `worker-${os.hostname()}-${process.pid}`, signal, mode: 'drain' });
      await prisma.$disconnect();
      process.exit(0);
    };
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
  })().catch(err => {
    logger.error('❌ coding worker failed to start:', err);
    process.exit(1);
  });
}

# Durable cron (Phase 3) — DB cron_jobs + worker-claimed schedulers

> Status: implemented. Phase 1 (`agent_runs`/`agent_events`, checkpoints) shipped
> in #74; Phase 2 (worker claim tier) in #75. Phase 3 gives the recurring
> BACKGROUND sweeps the same durability: they no longer float as in-process web
> `setInterval`s — the worker claims them out of Postgres.

## Problem

The web process owned five recurring sweeps as floating intervals (news
prefetch, feed refresh, memory dream, container reaper, worktree reaper). A
deploy killed them mid-flight; nothing recorded when they last fired, so a
crash-looping instance meant silently-stale news/feeds/memory, and blue/green
overlap relied on ad-hoc Redis-NX locks alone.

## `cron_jobs` table

Migration `20260724200000_cron_jobs` (additive-only):

```sql
CREATE TABLE "cron_jobs" (
    "id" TEXT NOT NULL,
    "intervalSec" INTEGER NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "workerId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cron_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cron_jobs_enabled_nextRunAt_idx" ON "cron_jobs"("enabled", "nextRunAt");
```

## Claim semantics (`cron.service.ts`)

- **Register** — `registerCronJob(id, intervalSec)` at worker boot: upsert whose
  `update` touches ONLY `intervalSec` (a worker reboot must not re-arm a job or
  erase its fire history); `create` sets `nextRunAt = now + interval`. Boot
  registration is only the FAST path (review H2): the loop re-registers ALL
  jobs every 60 s (`CRON_REREGISTER_MS`), so a transient boot-time failure
  self-heals instead of silently retiring the job.
- **Claim** — `claimDueCronJob(workerId)`: pick the oldest due enabled
  lease-free row (`nextRunAt <= now`, `leaseExpiresAt IS NULL OR < now`), then
  a guarded `updateMany` re-asserting id + enabled + still-due + lease-free,
  setting `leaseExpiresAt = now + 10 min` + `workerId`. `count === 1` wins;
  `count === 0` means another worker (blue/green overlap, replicas) claimed it
  first — never a double-fire.
- **Finish** — `finishCronJob(id, ok, status)`: `lastFiredAt = now`,
  `lastStatus` (truncated 200, `ERROR: `-prefixed on failure), lease + workerId
  cleared, and **`nextRunAt = now + intervalSec` anchored at FINISH time**.
- **Loop** — `startCronLoop(workerId, handlers, tickMs = 5000)`: each tick
  claims ONE job and awaits its handler. A throwing handler marks the job
  failed but `nextRunAt` still advances (no hot-loop). A claimed id with no
  handler is finished `'no handler'`. Claim errors (DB hiccup) end the tick;
  the loop never dies.

### Misfire catch-up

After downtime (deploy, crash) `nextRunAt` is in the past, so the job is due
the moment any worker ticks — it fires **exactly once**, and finish-time
anchoring re-arms it from the completion moment. The missed intervals are
never replayed (no thundering herd), and per-fire cost stays flat.

A worker crash *mid-handler* leaves the 10-min lease; another worker re-claims
after expiry and the sweep runs again. Each sweep's pre-existing Redis-NX
dedupe (news tick lock, memory-dream 20h cycle lock, feed fetch locks) is kept
deliberately: it bounds true duplicates during the deploy overlap when
old-color web (in-process scheduler) and the new worker coexist for a few
minutes.

## The cron jobs (inventory as of 2026-08-31 — `worker.ts` `CRON_JOBS`)

| id                | intervalSec | sweep (module export)                              | cadence source (old web scheduler)                        |
|-------------------|------------:|----------------------------------------------------|-----------------------------------------------------------|
| `news-prefetch`   |         900 | `runNewsSweepOnce()` — news.service.ts             | `startNewsScheduler` 15-min `setInterval`                 |
| `feed-refresh`    |         120 | `runFeedSweepOnce()` — feed.service.ts             | `startFeedScheduler` 2-min `setInterval`                  |
| `memory-dream`    |        3600 | `runDreamCycle()` — memory-maintenance.service.ts  | `startMemoryDreamScheduler` hourly tick (its own 20h Redis-NX lock keeps actual cycles ~daily; `MEMORY_DREAM_DISABLED=1` honored) |
| `project-digest`  |        3600 | `runProjectDigestOnce()` — fleet/project-digest.service.ts | new (fleet layer: hourly per-project digest rollup → `project_digests` rows; `PROJECT_DIGEST_DISABLED=1` kill-switch) |
| `container-reaper`|        3600 | `reapIdleContainers()` — container.service.ts (same pass also reaps disabled dev containers + upgrades legacy egress shims) | `startContainerReaper` hourly (no-op unless `isContainerMode()`) |
| `worktree-reaper` |       21600 | `runWorktreeReapOnce()` — project-workspace.service.ts | `startWorktreeReaper` 6h `setInterval`                |
| `agent-run-reaper`|         300 | `runAgentRunReaper()` — coding/run-reaper.ts       | new in Phase 3                                            |
| `attention-watchdog` |      900 | `runAttentionWatchdogOnce()` — fleet/attention-watchdog.service.ts | new (fleet layer: consolidated attention/blocked notices → supervisor threads; `ATTENTION_WATCHDOG_DISABLED=1` kill-switch) |
| `ticket-closure-manifest` | 600 | `applyClosureManifest()` — feedback/closure-manifest.ts | new (2026-08-23 burn-down throughput: closures are deterministic bookkeeping) |
| `ticket-drain`    |        1800 | `drainOpenTicketsToLane()` — feedback/ticket-dispatch.service.ts | new (2026-08-23 burn-down throughput: the drain fires on a CLOCK, not only on filings) |
| `session-history-sync` |   600 | `runSessionHistorySyncOnce()` — coding/session-history-sync.service.ts | new (2026-09-02: per-session deterministic `HISTORY.md` → git plumbing in the bare mirror; **2026-09-14: ONE `digby/session-history` branch per repo with `sessions/<sessionId>/HISTORY.md`** — the legacy per-session `digby/session-history/<sessionId>` branches are deleted on the first consolidated pass, archived/reaped sessions are pruned from the tree; `SESSION_HISTORY_SINGLE_BRANCH_DISABLED=1` restores per-session branches; unchanged-blob skip; `SESSION_HISTORY_SYNC_DISABLED=1` kill-switch; **2026-10-16 ticket 5eb035d6: projects archived/gone from the owner's account (own row, a removed row, or an archived ancestor folder) are skipped with one info log — restoring the project resumes sync; and 3 consecutive terminal-auth push refusals disable a repo's sync durably (Redis streak shared by every worker process, one info log at the crossing, the quarantine warn suppressed from then on, one re-probe push per 24h, a landed push resumes it; `SESSION_HISTORY_SYNC_AUTH_DISABLE_DISABLED=1` restores the quarantine-only behavior)**) |
| `project-status`  |         900 | `runProjectStatusOnce()` — fleet/project-status.service.ts | new (2026-09-14: deterministic hourly plain-language status card per project supervisor chat — 60-min gate lives in the service; `PROJECT_STATUS_UPDATES_DISABLED=1`) |
| `session-status`  |         900 | `runSessionStatusOnce()` — coding/session-status.service.ts | new (2026-09-15: the per-CODING-SESSION sibling — one card in the session's own chat for every session that ran in the last hour, only when the status changed (no "no change" stub); written via `appendCodingMessage` (dual-write); `SESSION_STATUS_UPDATES_DISABLED=1`) |
| `branch-janitor`  |        3600 | `runBranchJanitorOnce()` — fleet/branch-janitor.service.ts | new (2026-09-14: deletes fully-merged / squash-merged / closed-PR framework-prefixed branches and legacy session-history mirrors in every live project's GitHub repo; never default/protected/open-PR head-or-base/<2 h tips/foreign prefixes; 50 deletions per pass; `BRANCH_JANITOR_DISABLED=1`, `BRANCH_JANITOR_DRY_RUN=1`) |
| `log-signal-sweep` | 3600 | `runLogSignalSweepOnce()` — fleet/log-signal-sweep.service.ts | new (2026-10-16, ticket 8a66441e: the hourly read of `app_error_logs` nothing else did — groups the last 24 h of warn/error rows by NORMALIZED message (ids/uuids/hex/timestamps/numbers stripped) and files ONE deduped ticket per fingerprint per ISO week when RULE 1 fires (≥3 distinct hours OR ≥3 boot-episode clusters — the silence-gap proxy for a worker boot, since in-memory suppression state dies with the process) or RULE 2 (a suppression-promise message — quarantin/backing off/suppress/once per/cooldown — repeating inside its promised window, the session-history quarantine class); delivers ONE `[INFRA ALERT — recurring log signals]` wake per day to the Fleet Supervisor with the ticket ids, only when a ticket was FILED or BUMPED that pass (or a pure spike with tickets off) — a pass that merely cites a week-key-cached ticket stays quiet (adversarial-review N1, c2548827c); Redis-NX week key + stable title (`log-signal: <fingerprint>`) so feedback's 90-day exact dedup BUMPS the standing ticket in later weeks; loop_metrics kind `log_signal_sweep`; `LOG_SIGNAL_SWEEP_DISABLED=1` whole sweep, `LOG_SIGNAL_SWEEP_TICKETS_DISABLED=1` tickets only; **2026-10-18 ticket 885614de: fingerprints (ingress at `normalizeLogMessage` AND at every render: title, description line, INFRA ALERT wake prompt, loop-metric `top[]`), the description's raw example-message excerpt and the wake prompt are run through the shared secret-shape redactor (`platform/secret-scan.ts redactSecrets`) PLUS a sweep-local structural layer for the base64url/JWT class (round 2, cross-family review finding: the shared set is prefix/label-based and a bare `eyJ…`/`Bearer dGhpc…` token survived it verbatim — JWT shape, credential-cued ≥24-char and bare ≥40-char mixed-case base64url runs are now redacted at the sweep seam only, NOT in `SECRET_PATTERNS`, which also feeds the commit-time secret gate). KNOWN RESIDUAL (accepted, documented): non-credential sensitive tokens — internal ids and hostnames (e.g. an RDS endpoint) — still ride fingerprints/excerpts; they are not credential-shaped and redacting them would collapse distinct classes (the kill switch `LOG_SIGNAL_SECRET_REDACT_DISABLED=1` restores the verbatim pre-fix behaviour including this residual, and also covers the round-2 structural layer; forwarded backend + worker)**. ONE-TIME dedup note: a fingerprint whose pre-fix title carried a mangled partial token is a NEW title post-fix — feedback's 90-day exact-title pass files a fresh row for that class once (the standing pre-fix row stops being bumped; close it by hand when the successor lands). The ticket's "read the rows yourself" step still returns the RAW stored message (view `errors` / `app_error_logs` selects message unredacted) — grep a NON-token fragment, not the token; **2026-10-17 ticket aad94ed4: NEW filings additionally capped at `LOG_SIGNAL_TICKETS_PER_DAY` (default 5) per UTC DAY across all workers — a Redis INCR-first day counter (`log-signal-sweep:filed:<YYYY-MM-DD>`, 26 h TTL) whose reservation is refunded on failed, thrown, or deduped inserts; dedup BUMPS are budget-exempt (exact-title peek), a capped pass stamps loop_metrics meta `capped:true`+`dayCap` and defers the remaining fingerprints to the next day; the knob is forwarded to the backend+worker containers**; DB + Redis only — claimable on every worker incl. the 0-slot cron-only box) |
| `idle-chat-archiver` |     3600 | `runIdleChatArchiverOnce()` — idle-chat-archiver.ts | new (2026-09-14, ticket bb86cee8: per-project auto-archive of idle chats — folders with `autoArchiveIdleDays` set get chats idle past that window archived THROUGH platform.service `archiveChat` (archivedAt stamp + satellite flip + audit, fully reversible); skips supervisor/project-supervisor chats, enabled schedules, active share links, running/provisioning satellites; 200-candidate cap per pass; `IDLE_CHAT_ARCHIVER_DISABLED=1` kill-switch) |
| `deepseek-balance-probe` | 3600 | `probeDeepSeekBalance()` — utils/utility-llm.ts | new (2026-09-14, nightly firing 29 / ticket 2b7ceafa class: PROACTIVE complement to the reactive billing latch — hourly GET `api.deepseek.com/user/balance`; `is_available:false` or HTTP 401/402/403 latches the DeepSeek utility leg + files the deduped P5 owner-action billing ticket BEFORE the first failed utility call; `DEEPSEEK_BALANCE_WARN_FLOOR` (default 0=off) files a DISTINCT P3 low-balance early-warning ticket; transient/malformed shapes are warn-only, never tickets; `DEEPSEEK_BALANCE_PROBE_DISABLED=1` kill-switch) |
| `memory-embed-backfill` | 900 | `runMemoryEmbedBackfillOnce()` — memory/embed-backfill.service.ts | new (2026-10-17, ticket d7bf73c2: the repair cron for NULL-embedding `digby_memory` rows — a DashScope 429 used to drop whole memStore batches keyword-only with no retry and no repair (Box C 2026-10-16: "0/7 row(s) stored keyword-only … throttled"). Every 15 min it re-embeds the oldest NULL rows and writes vectors in place, guarded by `AND embedding IS NULL` (never overwrites a fresher vector). Bounded: ≤ 50 rows/tick (`MEMORY_EMBED_BACKFILL_BATCH_SIZE`, clamp 1..200), one embed call per row, `remainingNull`/`totalRows` in the metric meta are counted FROM THE DATABASE (the once-per-process warn understates the loss), rows ≥ 10 min old only (never races the store path's in-call 429 backoff), rows > `MEMORY_EMBED_BACKFILL_MAX_AGE_DAYS` (default **120** since 2026-11-01 — was 7, which made rows older than a week permanently unreachable: measured NULL rows ran to ~95 days old) stay keyword-only forever. The repair embeds through a PINNED spec (`RAG_EMBED_AUTHORITATIVE_SPEC`, default = the same embeddings seat the LIVE query leg uses, so repaired vectors stay findable by it; falling back to DashScope `text-embedding-v4`) rather than blindly following the seat, so a hanging seat cannot block the repair; unknown pins throw instead of guessing a vector space. Per-row budget is 8 s (`BACKFILL_EMBED_TIMEOUT_MS`) so a 50-row batch (400 s worst case) always lands inside the 8-min tick deadline, provider-REJECTED rows (400/413/422) go on a 1 h in-process cooldown so one poison input burns one call per hour, not one per tick; the row loop STOPS on the first 429 (the cron never feeds the throttle it repairs — the remaining rows ride the next tick) and on an 8-min tick deadline (backfill.service.ts `BACKFILL_TICK_DEADLINE_MS` < the 10-min cron lease, so a slow pass never lapses into a second worker's claim). Companion: the 429-aware in-call backoff in memory/embed-failure.ts (`UNIFIED_MEMORY_EMBED_429_RETRIES=2`, `UNIFIED_MEMORY_EMBED_429_RETRY_DISABLED=1`; Retry-After honoured within a 10 s budget PER WAIT and CUMULATIVELY). loop_metrics kind `memory_embed_backfill`; `MEMORY_EMBED_BACKFILL_DISABLED=1` kill-switch; DB-only — claimable on every worker incl. the 0-slot cron-only box) |

The web process keeps `startCodingScheduleSweeper()` (already DB-backed with
its own atomic claim + inherent catch-up) and the two boot-time durability
passes (`sweepOrphanedRunningSessions`, `reconcileOrphanedRuns`). The legacy
`start*` exports remain in their modules for reference but are no longer
called by `server.ts`.

Feed boot maintenance (entry-cap prune + messy-title cleanup) moved to the
worker boot with the feed job — its Redis-NX guards (6h / 24h TTL) already
dedupe across instances, so a plain boot call is safe.

## `agent-run-reaper` rules (every 5 min; all best-effort, logged with counts)

1. **Resume-window expiry** (runs FIRST so rule 2 heals same-pass):
   `interrupted` agent_runs with `updatedAt` older than **7 days** → `failed`
   (`error='resume window expired'`, checkpoint dropped, lease cleared).
2. **Orphaned running sessions** → `ready`: sessions stuck `status='running'`
   with no claimable agent_runs row (`queued`/`interrupted`/`running`) and no
   Redis session lock — the continuous version of the Phase-2 boot sweep
   (`sweepOrphanedRunningSessions`, reused verbatim). Review-H1 hardening:
   the sweep FAILS CLOSED (a claimable-lookup DB error or a Redis lock-check
   error aborts the whole pass — never catch-to-`[]`/catch-to-`0`) and skips
   sessions whose `updatedAt` is younger than `ORPHAN_SWEEP_GRACE_MS` (2 min),
   the queue/claim window in which a just-flipped `running` session's row/lock
   appears. The matching producer-side fix: the `ready→running` busy-gate
   moved INTO `queueAgentRun`'s transaction (it throws `SessionBusyError` on a
   busy session), so a `running`-with-no-row window no longer exists.
3. **Event GC**: delete `agent_events` whose run is terminal
   (`completed`/`failed`/`cancelled`) with `finishedAt` older than **30 days**,
   ≤ 5000 rows per pass (a backlog drains over successive passes).

## Supervision endpoint

`GET /api/crossmodel/coding/cron-status` (app-level JWT guard + `rejectChild`,
same as every coding route):

```json
{
  "success": true,
  "data": {
    "jobs": [ { "id": "feed-refresh", "intervalSec": 120, "nextRunAt": "…",
                "lastFiredAt": "…", "lastStatus": "ok", "leaseExpiresAt": null,
                "workerId": null, "enabled": true, "createdAt": "…", "updatedAt": "…" } ],
    "runs": { "queued": 2, "running": 1, "interrupted": 0,
              "failedLast24h": 3, "completedLast24h": 7 }
  }
}
```

The ops proof that crons fire after deploys: `lastFiredAt` keeps advancing and
`workerId` flips to the new color's worker id.

## Files

**New:** `backend/src/modules/crossmodel/cron.service.ts` ·
`backend/src/modules/crossmodel/coding/run-reaper.ts` · migration
`20260724200000_cron_jobs` · tests `cron.service.test.ts`,
`coding/run-reaper.test.ts`, `coding/cron-status.test.ts`.

**Modified:** `schema.prisma` (CronJob model) · `worker.ts` (job table,
registration, cron loop in start/stop) · `server.ts` (five `start*` calls
removed — durable cron lives in the worker now) · `news.service.ts`
(`runNewsSweepOnce`) · `feed.service.ts` (`runFeedSweepOnce` +
`runFeedStartupMaintenanceOnce`) · `project-workspace.service.ts`
(`runWorktreeReapOnce`) · `coding.controller.ts` + `coding.routes.ts`
(`GET /coding/cron-status`) · `worker.test.ts` (cron wiring).

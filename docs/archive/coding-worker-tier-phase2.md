# Coding worker tier (durability Phase 2) — design

> Status: implementing. Phase 1 (`agent_runs` + `agent_events`, write-ahead
> checkpoints, SSE cursor resume) shipped in #74. Phase 2 moves execution OUT of
> the web process into a worker that claims runs from Postgres, so a deploy
> auto-resumes in-flight coding sessions instead of waiting for the user to
> send another message.

## Problem

Phase 1 makes runs resumable, but the web process still owns execution: the
agent loop is a floating in-process promise. On deploy the old color is killed
after the drain window; every in-flight run goes `interrupted` and sits there
until a human sends a message. Nothing claims them.

## Architecture

Two roles, same image, same DB/Redis:

- **web** (`dist/server.js`): HTTP only for coding. POST /run *queues* a run
  row; GET /stream *tails* `agent_events` from Postgres. Owns no execution.
- **worker** (`dist/worker.js`, new): claim loop + the moved `executeRun`.
  Claims runs, holds the Redis session lock, heartbeats the lease, executes the
  agent loop, finalizes. Multiple workers (blue + green overlap, or replicas)
  are safe via `FOR UPDATE SKIP LOCKED`.

### Run lifecycle (claimable states)

`agent_runs.status` transitions:

```
POST /run ──► queued ──claim──► running ──► completed | failed | cancelled
                 ▲                 │
                 │                 ├─SIGTERM──► interrupted (checkpoint kept) ─┐
                 │                 ├─crash────► (stays running, lease expires) ┤
                 │                 │                                           │
                 └──requeue────────┴────────── claim (auto-resume) ◄───────────┘
                  (lock held / no checkpoint+input, attempts<cap)
```

Claim query (single atomic statement, one row per call):

```sql
UPDATE "agent_runs"
SET status='running', "workerId"=$1, "heartbeatAt"=now(),
    "leaseExpiresAt"=now() + ($2)::interval, attempts=attempts+1
WHERE id = (
  SELECT id FROM "agent_runs"
  WHERE (status='queued' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now()))
     OR status='interrupted'
     OR (status='running' AND "leaseExpiresAt" < now())
  ORDER BY "createdAt" LIMIT 1
  FOR UPDATE SKIP LOCKED
) RETURNING *;
```

(Implemented as SELECT … FOR UPDATE SKIP LOCKED + update inside one interactive
transaction — same semantics. The queued branch's `leaseExpiresAt` doubles as a
NOT-BEFORE: fresh rows carry NULL → immediately claimable; a lock-contention
requeue sets now+15 s → the row can't spin. See "Review fixes (H1/H2)".)

Claimed-row handling by shape:

| row shape                                    | action                                                        |
|----------------------------------------------|---------------------------------------------------------------|
| `queued` + checkpoint (adopted at queue time) | resume from checkpoint; new input message via history+notice  |
| `queued`, no checkpoint                       | fresh run from `input`                                        |
| `interrupted` + checkpoint                    | auto-resume in place (deploy survival — the core win)         |
| `interrupted`, no checkpoint, has `input`     | SIGTERM before the first checkpoint → restart cold from input |
| `interrupted`, no checkpoint, no input        | mark failed → session `ready` (un-brick safety net)           |
| stale `running` + checkpoint                  | crash recovery: resume from checkpoint                        |
| stale `running`, no checkpoint, has `input`   | crashed before first checkpoint → restart cold (attempts+1)   |
| stale `running`, no checkpoint, no input      | mark failed (safety net; shouldn't occur)                     |

`attempts` capped at 3 → then `failed` with `error='attempts exhausted'`.

### Queue-time checkpoint adoption

`queueAgentRun(sessionId, input)` (in a transaction): read the session's
interrupted rows `FOR UPDATE`, latest first → supersede exactly those rows
(`failed`, 'superseded by a newer run') and copy the first non-null checkpoint
onto the new queued row (atomic — see "Review fixes (H1/H2)"). This
preserves Phase 1's exact "new message resumes the interrupted run" semantics
while leaving exactly ONE claimable row per session. Session flips to
`status='running'` at queue time (so all existing `ensureRunnable`/`busy`
checks keep working unchanged); worker flips it back to `ready` at finalize.

### Execution ownership

- The per-session Redis lock (`session-run-lock.ts`) stays the worktree mutex,
  now held by the WORKER at execution start. Lock already held → requeue the
  row (`queued`) instead of executing (guards the two-rows-one-session race).
- `ensureRunnable` (worktree re-provision), user-message persist, title gen,
  history load, `runCodingAgent`, partial-transcript persist, lock refresh +
  `heartbeatAgentRun` every 2.5 min, finalize + session `ready`: all move
  verbatim from the controller into `run-executor.ts`.
- `runCodingAgent` input unchanged (`resumeFrom`, `onCheckpoint`,
  harness-notice userMessage on resume). usageRunId rides the checkpoint, so
  usage commits stay idempotent across workers.

### SSE = Postgres tail (web is stateless)

`GET /coding/sessions/:id/stream` no longer subscribes to an in-process
registry (there is never a local run on web). New tail mode:

1. Find the session's active run (`queued`/`running`, latest `createdAt`).
2. Poll `getAgentEventsAfter(runId, cursor)` every 750 ms; write rows as
   `id: <seq>` + `data:` (same shapes as today — no frontend change).
3. End on a terminal event (`complete`/`error`) or when the run row goes
   terminal with no new events (honest end; never fabricate `complete` for a
   live run).
4. No active run → replay the LATEST run's events from `agent_events`
   (replaces the 30-second in-memory ring retention with durable replay), else
   send the current honest empty-complete.
5. While `queued`-not-yet-claimed there are no events: stream stays open on
   the existing SSE heartbeat + emits one synthetic `progress` event
   ("queued — waiting for a worker") so the UI shows life.

Cursor semantics (`Last-Event-ID` / `?after_seq=`, `init` resets) unchanged.
`attachResponse`/`awaitCrossInstanceRun` for coding are deleted (~180 lines).

### Cross-process cancel + steer (Redis, in `session-run-lock.ts`)

- Stop: POST /stop → `SET coding:session:cancel:{id} 1 EX 600`. Worker polls it
  every 2 s per active run → sets the local `cancelRun` flag + `DEL`s the key;
  the loop bails at the next step boundary → finalize `cancelled`.
- Steer: POST steer → `RPUSH coding:session:steer:{id} {text,images}`. The
  executor's `injectSystem` drains via bounded LPOP loop (cap 20, same merge
  logic + MAX_IMAGES cap as the in-memory version it replaces).

### Worker process

- New entry `backend/src/worker.ts`: connect Redis + Prisma, then a 2 s claim
  tick claiming up to `CODING_WORKER_CONCURRENCY` free slots (default 2);
  executions tracked in a local Map. Touches `/tmp/worker-alive` each tick
  (compose healthcheck).
- SIGTERM: stop claiming → `markRunShutdownInterrupted` on active runs (their
  finalizers map to `interrupted`, checkpoint retained) → wait ≤ 25 s for
  step-boundary checkpoints → exit. Force-kill is safe regardless: lease
  expiry makes the rows claimable by any live worker.
- Session rows are left `status='running'` on worker SIGTERM (the run IS still
  logically running — a new worker resumes it within seconds). The orphan
  sweeper learns the guard below instead.

### Orphan sweeper guard

`sweepOrphanedRunningSessions` (boot-time, coding-data.service) currently
flips lock-less `running` sessions to `ready`. Teach it: skip sessions that
have a claimable `agent_runs` row (queued / interrupted-with-checkpoint /
stale-running) — a worker will pick them up. `reconcileOrphanedRuns` stays as
a boot-time safety net (worker claiming makes it mostly redundant).

### Migration (hand-written; no DB in container)

`agent_runs` += `input JSONB NULL` (`{message, images, userId}`),
`"workerId" TEXT NULL`, `attempts INTEGER NOT NULL DEFAULT 0`, plus a
composite index on `(status, "leaseExpiresAt")` for the claim query.
Additive/nullable only → old-color code keeps working against the new schema
during the deploy overlap (old `running` rows hold live leases → never claimed
by new workers; if old web is SIGTERMed mid-run its `interrupted` rows are
auto-resumed by the new worker — the migration itself demos the feature).

### Deploy topology

`docker-compose.app.yml` gains a `worker` service: same build, `command: node
dist/worker.js`, no ports, same env + `coding_workspaces` volume +
`DOCKER_HOST`, `stop_grace_period: 45s`, healthcheck on a fresh
`/tmp/worker-alive`. The blue-green script needs NO changes: `up -d` on the
inactive color starts its worker (claiming from shared Postgres immediately —
safe), `down --timeout 30` on the old color SIGTERMs its worker, whose
interrupted runs are claimed by the new one. Web flips as before.

### Idempotency (judgment call)

Phase 1's step-granularity resume stays: a `dispatch` checkpoint is trimmed to
its step's `preModel` state on resume (at-least-once per in-flight turn;
completed steps never re-run — their results are in the transcript). A
fine-grained tool-call journal is deliberately NOT in Phase 2: the tools here
(file writes, git ops, shell) are re-runnable, and a replay journal adds
large complexity for the narrow mid-tool-call crash window.

## Files

**New:** `backend/src/worker.ts` · `coding/run-claim.ts` (claim SQL + row-shape
mapping) · `coding/run-executor.ts` (moved executeRun + Redis cancel/steer) ·
migration `20260724120000_agent_run_worker_claim` · tests `run-claim.test.ts`,
`run-executor.test.ts`, `worker.test.ts`, stream-tailer test.

**Modified:** `schema.prisma` · `run-state.ts` (queueAgentRun + adoption txn,
getActiveRunForSession, markRunFailed, ATTEMPTS_CAP) · `session-run-lock.ts`
(cancel + steer channels) · `coding-stream.controller.ts` (queue-only POST,
SSE tailer, Redis stop/steer; delete executeRun/beginRun/reserveLockBegin/
awaitCrossInstanceRun/interruptActiveCodingRuns) · `server.ts` (drop
interruptActiveCodingRuns) · `coding-data.service.ts` (sweeper guard) ·
`package.json` (`worker` script) · `docker-compose.app.yml` (worker service).

## Tests (jest; mock prisma@config/database, redis@config/redis, error-handler)

- claim: state-shape mapping pure-tested (all 6 row shapes); attempts cap →
  failed; `$queryRaw` claim wrapper passes through rows; requeue-on-lock-held.
- executor: lock-fail → requeue; cancel key → cancelled finalize; steer RPUSH
  drained via injectSystem; resume path passes resumeFrom + harness notice;
  completed finalize nulls checkpoint + session ready.
- stream tailer: ordered replay, cursor dedupe, terminal end, queued-wait
  progress, honest end on terminal-without-event.
- queue path: POST /run → queued row + session running + 409 on concurrent.
- worker: tick claims up to free slots; SIGTERM stops claiming + interrupts.

## Review fixes (H1/H2)

- **Lock-requeue spin (H1):** every claim does `attempts+1`, and a row stuck behind a long-running run of its own session spun claim→lock-fail→requeue every 2 s until it died 'attempts exhausted' without executing. Fixes: the executor classifies BEFORE taking the session lock (an over-cap row fails without touching the lock), and `requeueRun` compensates the claim-time increment (`attempts − 1`) + sets `leaseExpiresAt = now+15 s` as a NOT-BEFORE (the claim query's queued branch only matches `leaseExpiresAt IS NULL OR < now()`), so lock contention is neither an attempt nor a spin.
- **Atomic checkpoint adoption (H1):** `queueAgentRun`'s findFirst-then-supersede raced a concurrent claim (supersede matches 0 rows, checkpoint still adopted → two live rows share one checkpoint). Now the txn reads the session's interrupted rows `SELECT ... ORDER BY "createdAt" DESC FOR UPDATE` first, supersedes exactly those, and adopts the first non-null checkpoint — row locks make read+transition atomic (a claimed row is no longer `interrupted`, so it can't match).
- **NULL-checkpoint brick (H2):** a worker SIGTERM before the first checkpoint finalized `interrupted` with NULL checkpoint — unclaimable, sweeper-skipped, Stop-proof. Now: the claim query matches ALL interrupted rows; `classifyClaim` maps interrupted-no-checkpoint to `fresh` (with input) or `fail` (no input → session `ready`), and the same no-input guard tightens stale-`running`; an executor shutdown-interrupted run that never wrote a checkpoint cold-retries as `queued` via `requeueRun` instead of finalizing `interrupted`. The sweeper/stop-unstick bare-`interrupted` checks stay as-is — every interrupted row is now claimable and self-healing.

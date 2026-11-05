> **2026-09-24:** port 22 is closed to the internet. The ec2-ops / deploy / healthcheck / infrastructure workflows open it for their own runner IP through `.github/actions/ssh-gate` (GitHub OIDC → IAM role `example-github-actions-ssh-gate`) and close it in an always-step. Operators use SSH over AWS Session Manager (`aws ssm start-session --document-name AWS-StartSSHSession`).

# Remote Ops Runbook (driving the EC2s without direct SSH)

> Read this first when you need to inspect or fix the running servers from a
> Claude-Code-on-the-web session. It captures the constraints + the durable
> tooling so you don't have to re-derive any of it.

## Isolation boundary (self-hosted / Edge vs THIS production instance)

> Owner standing requirement (ticket c75b5f34): a self-hosted or Edge Digby
> instance self-improves on ITS OWN copy only — this runbook's targets (the
> example-org/crossmodel repo, the ca-central-1 RDS instance, the prod EC2
> boxes, every secret below) belong to PRODUCTION and are never shared.

- `DIGBY_INSTANCE` names the instance kind: unset or `prod` = production
  (this deployment — every default in this runbook stands); `selfhost` /
  `edge` / any other value = a NON-prod instance. The backend and worker
  resolve their loop targets from the instance's OWN environment
  (`SELF_REPO`, `GITHUB_REPO_SLUG`, `INFRA_WATCH_REPO`, `DATABASE_URL`,
  `DEPLOY_HEALTH_PROBE_BASE_URL`, `SELFHOST_PUBLIC_URL`) via the import-free
  leaf `backend/src/modules/crossmodel/platform/instance-targets.ts`.
- On a non-prod instance the production repo is NEVER a fallback: the
  repo-target resolvers answer nothing when unconfigured, and resolving
  `example-org/crossmodel` hard-fails with an `ISOLATION BOUNDARY` error —
  including at the publish choke points (`git_push`, `open_pull_request`,
  `merge_pull_request`, `check_ci`) and in `scripts/deploy/red-window-guard.sh`
  / `scripts/backup/digby-backup.sh` (the prod RDS endpoint is never a
  fallback there either).
- `docker-compose.selfhost.yml` sets `DIGBY_INSTANCE=selfhost` and runs its
  OWN postgres/redis (its own `DATABASE_URL`), separate from prod's
  `docker-compose.app.yml` + RDS. No AWS creds, EC2 hosts, or SSH keys are
  forwarded to a self-hosted stack — updates are its own `git pull` +
  rebuild, not a prod deploy.
- Operators: if a self-hosted instance ever asks you to point it at a prod
  target, refuse and point it at its own fork/env instead. Never widen a
  non-prod instance toward production.

## The core constraint

The Claude-Code-on-the-web execution container **cannot open outbound SSH
(port 22)** — only 443 is reachable. So you **cannot `ssh` to the EC2s directly**,
no matter what key you have. Every "go onto the server and do X" must run from a
**GitHub Actions runner**, which *can* reach port 22 and already holds the EC2
private keys as repo secrets. GitHub Actions is the jump host.

Second constraint: the **GitHub MCP token cannot `workflow_dispatch`** (no
`actions: write`) — but the **coding-session `$GITHUB_TOKEN` env var CAN**
(`POST /repos/example-org/crossmodel/actions/workflows/ec2-ops.yml/dispatches`
with `{"ref":"<branch>"}` → 204, runs the scripts from ANY branch ref — the
zero-deploy way to iterate read-only diagnostics). ⚠ That applies to
Digby's own coding sessions (box C). A Claude-Code-on-the-web session is
different (verified 2026-10-20): its `GITHUB_TOKEN` is an all-access PAT for
reads and pushes (`GET /user` → the owner, repo permissions admin), but every
`…/dispatches` POST — curl with the PAT, `gh workflow run`, the GitHub MCP tool —
is answered 403 "Resource not accessible by integration" by the session's
agent proxy, which intercepts api.github.com (a proxy-generated 415 there
carried a docs.anthropic.com URL). From such a session, push-to-path is the
only trigger: a `scripts/ec2-ops/**` commit on main (which also costs one
deploy wave of identical images — the ops(WS1020) run 411 shape). Otherwise trigger workflows
by **pushing a commit** that touches the workflow's trigger paths. Read results
via REST (`actions/runs?branch=…` → `/runs/:id/jobs` → `/jobs/:id/logs`) or the
GitHub MCP `get_job_logs` tool.

## The fleet (web A+B, coding C)

Operator call graph, rollback tree, and env-change rules: [INFRA_CODE_MAP.md](INFRA_CODE_MAP.md).

| Role | Host secret | User | Path | Runs |
|------|-------------|------|------|------|
| **PROD** (live digby.ai) | `EC2_HOST` (= **203.0.113.10**, ca-central-1 instance A; stateless app B = 203.0.113.11 behind the ALB — see AGENTS.md) | `ubuntu` | `/opt/crossmodel` | App only — blue/green Docker stack, redis, MCPs. App DB is AWS RDS (`example-db…ca-central-1`) — the on-box `admin-postgres-prod` container is RETIRED |
| **CODING** (box C) | `scripts/ec2-ops/extra-hosts` (= **203.0.113.15** / priv 10.0.0.15, `i-0123456789abcdef0` m7i-flex.2xlarge) | `ubuntu` | `/opt/crossmodel` | Coding plane: workspace volume, docker-proxy, session containers, worker @ 32 slots (env-overrides.env, one-shot CC0902). Playbook ROLE=coding-c |
| ~~DEV / AUTOPILOT~~ | retired 2026-07-20 — ec2-ops.yml is **prod-only** now | — | — | — |

SSH key secret: `EC2_SSH_KEY` (prod fleet; coding box C uses the same
`crossmodel-prod` key, baked in at launch). `EC2_DEV_SSH_KEY` is retired with
the dev box. ~~Rule of thumb: autopilot/systemd/kanban = DEV/`paul`.~~
(historical — the dev box was retired 2026-07-20; everything here is PROD/`ubuntu`.)

## The remote-ops harness

`.github/workflows/ec2-ops.yml` + `scripts/ec2-ops/`:

- **`scripts/ec2-ops/diagnostics.sh`** — read-only health snapshot (host vitals,
  containers, health endpoints, feedback/autopilot tables, live-store liveness).
  It has only a `prod` branch, and the workflow runs it on **`EC2_HOST` only**.
  **Never put mutating commands here.**
- **`scripts/ec2-ops/playbook.sh`** — the editable "do a fix" script, guarded by
  `$ROLE`. The workflow runs it on prod (`EC2_HOST`, ROLE=prod), on coding
  box C (`scripts/ec2-ops/extra-hosts`, ROLE=coding-c) and — read-only only — on
  web box B (the SECOND `EC2_HOSTS` entry, ROLE=prod-b; the dedicated
  "Playbook (web box B, read-only)" step never runs the prod role on B).
  Default = read-only:
  marker-guarded one-shots reset to read-only notes once fired (the full block
  stays recoverable from git history) + Slack/Asana MCP container and
  backend→MCP reachability assertions. The `dev` branch survives only as an
  unreachable marker — `ec2-ops.yml` has not invoked ROLE=dev since the
  2026-07-20 autopilot teardown.
- **`ec2-ops.yml`** — transports each script over SSH by **scp'ing it to
  `/tmp/digby-ec2ops-<name>.$GITHUB_RUN_ID.sh` and executing it FROM DISK**
  (`ssh -n <host> "ROLE=… bash /tmp/… < /dev/null"`), so it always runs the
  just-pushed version (no deploy-lag dependency). NEVER reintroduce
  `ssh … "bash -s" < script`: under bash-over-stdin the script source is the
  remote shell's stdin and any stdin-reading command in the script
  (`docker run/exec -i`, `cat`, nested `ssh`, …) eats subsequent SCRIPT lines —
  blocks silently never execute while the run exits 0 (ticket 795cc5fb;
  observed on runs 33281622184 / 33282007898 / 33282152750).

### Sentinel gate (false "ran clean" protection)
`playbook.sh` self-reports its on-disk sha256 at start and prints
`=== playbook <role>-section done ===` + `=== playbook done (ROLE=<role>) ===`
sentinels at the end of each role section and the file. The PROD playbook step
greps the run log for all three (sha match + prod-section + final) and **fails
the workflow** if any is missing; the coding-c step warns. If the gate fails,
treat the run as NOT executed — re-run or investigate before trusting any block
in it. A successful gate is the only "ran clean" signal.

### Fleet-settle gate (both roles)
The RUNNER computes fleet settled-ness and hands it to the playbook as
`LL1E16_SETTLED=1|0` (the `settle` step: `gh run list --workflow=deploy.yml` on
main). Unset = `0` = CLOSED, so a block can never fire mid-wave from a bare
shell. **Both** role invocations pass it — `prod` AND `coding-c`
(2026-11-04: coding-c was missing it, so a settle-gated block in that branch
could only ever defer; fixed in `ec2-ops.yml`).
Because `scripts/ec2-ops/**` counts as RUNTIME for `deploy-path-filter.sh`, a
push here also starts a deploy wave — and `ec2-ops` runs concurrently, so the
probe legitimately sees a wave in flight and the block DEFERS without consuming
its marker. **Arm by `workflow_dispatch`, not by a second push**: dispatch
`ec2-ops.yml` once the deploy view reports settled.

### How to run diagnostics
Push any trivial edit under `scripts/ec2-ops/**` or to `ec2-ops.yml`. Then:
read the latest `ec2-ops.yml` run's job log via MCP `get_job_logs`
(`return_content: true`).

### How to apply a fix
1. Edit `scripts/ec2-ops/playbook.sh`; put commands in the matching `$ROLE`
   branch (`prod`, `coding-c` for the coding box, or `prod-b` for the second
   web box — `prod-b` is read-only-only by contract: no staging, no file
   writes, no docker create/run there; keep `prod` for genuine
   emergencies; normal app changes go through `deploy.yml`).
2. Commit and push to `main` (on the work branch: `git push origin <branch>:main`).
3. The push auto-triggers `ec2-ops.yml`. Find the run with MCP
   `actions_list` (workflow `ec2-ops.yml`), then `get_job_logs`.
4. Reset the playbook placeholder back to no-op when the fix is confirmed.

### Reading results (MCP)
```
actions_list  list_workflow_runs  resource_id=ec2-ops.yml  → newest run id
actions_list  list_workflow_jobs  resource_id=<run id>     → job id + per-step status
get_job_logs  job_id=<job id>  return_content=true  tail_lines=400
```
`list_workflow_runs` responses are huge — if it overflows, the result is saved to
a file; slice it with python by character range rather than re-fetching.

## Deploys (the normal path for app/code changes)

Push to `main` → `deploy.yml` runs blue/green across the prod fleet: it loops
`EC2_HOSTS` (A `203.0.113.10` first — it owns `prisma migrate deploy`, which
`deploy-blue-green.sh` runs automatically on every deploy — then B
`203.0.113.11`; falls back to the legacy `EC2_HOST` when unset) and rsyncs +
deploys + health-gates each host in turn. Coding box C is **not** in
`EC2_HOSTS` (it runs no web stack) — a separate "Deploy coding box (extra
hosts)" step rsyncs the repo (excluding `.env`) to each host listed in
`scripts/ec2-ops/extra-hosts` and runs `scripts/deploy/deploy-coding-worker.sh`;
a C failure only warns, it never rolls back the web fleet. (The old dev-box
sync — rsync + the "Align dev EC2 git to deployed commit" step — was deleted
with the 2026-07-20 autopilot teardown; see the comment left in `deploy.yml`.)

**Test-gate CI reuse (T2b, 2026-10-17):** the Test gate no longer re-runs
the full suite unconditionally. The gate job probes
`scripts/deploy/ci-verdict-probe.sh` — does this sha already have a
completed CI run? `green` (e.g. the batch-train fast-forward, whose full
suite ran once on the batch branch) skips the duplicate invocation and the
deploy proceeds on the reused verdict; `red` fails the run loudly via the
`red-ci-stop` job (red CI never deploys); `none` (ordinary push: the
push-CI run is still in progress at gate time; API-landed sha: no CI at
all) runs the suite in the deploy exactly as before. The probe is
fail-open: an unanswerable API always means "run the suite".

**Box C deploy batching (ticket ed057f9d, 2026-10-16).** deploy-coding-worker.sh
now rate-limits its own rollouts and never evicts a drainer with live runs
just to make room. Two box-env switches (both kill-switched):

| Variable | Default | What it does |
|---|---|---|
| `WORKER_DRAIN_SLOT_WAIT_MAX_SEC` | `600` | When a park would cross `WORKER_MAX_DRAINERS`: run-FREE parked drainers are evicted immediately (garbage), then the script WAITS (bounded, poll `WORKER_DRAIN_SLOT_POLL_SEC` = 30 s) for a live drainer to exit. Only past the bound does the unchanged cap eviction fire — the wave never hangs. 600, not 900+: the wait runs inside the Deploy job, whose `updated_at` freezes at job start — `deploy-watchdog.sh` arm 1 cancels at 90 min of no job progress. Live-run source: the run LEASE in `agent_runs` (workerId = the drainer's container id — stable across the park rename; psql via ephemeral `pgvector/pgvector:pg16 --network host` with a worker container's `DATABASE_URL`), falling back to the drainer's own `draining — N run(s) still active` log line; both failing → treated as LIVE (fail-safe, `probe=unknown` marker). |
| `WORKER_ROLLOUT_MIN_INTERVAL_SEC` | `1800` | At most one box-C worker rollout per window: a wave whose inputs changed but whose last rollout is younger defers the rebuild (prints `worker-rollout-window: deferred`) and writes NO stamp — the next wave re-evaluates. The undeployed hash ages in `/opt/crossmodel-local/coding-worker-pending.{hash,at}`; `WORKER_ROLLOUT_MAX_STALE_SEC` (7200, auto ≥ 2× the window) FORCES a rollout when a burst of waves would otherwise keep the rollout-age young forever. Never defers when C has no live worker. A deferred worker honestly reports its build sha — the fleet deploy view's `classifyWorkerLag` shows the lag as "real", bounded by the window, by design. |

Kill switches: `WORKER_DRAIN_SLOT_WAIT_DISABLED=1` (instant eviction again),
`WORKER_ROLLOUT_WINDOW_DISABLED=1` (every-wave rollout — also the manual
force-roll override:
`sudo env WORKER_ROLLOUT_WINDOW_DISABLED=1 bash scripts/deploy/deploy-coding-worker.sh`
— the plain `sudo VAR=… bash …` form depends on sudoers `setenv`). These are
CODE defaults: the CI ssh step forwards no environment to the box script
(sudo env_reset drops it) — a persistent override goes in the box's
env-overrides.env or `/etc/environment`. Note the window also delays
secrets-only changes (the f670b63b class) by up to *window + gap-to-next-wave*
(~55 min at the observed 25-min wave cadence; the MAX_STALE bound only bites
on a persisting hash) — for a credential-rotation incident use the kill
switch / manual force-roll above. A deferred wave reads as workerLag kind
`real` in the fleet deploy view, and its canned reason says the box-C deploy
step "failed or was skipped" — that reason is misleading for a deferral:
check the run log for `worker-rollout-window: deferred`. The coalesce gate is
NOT this: it batches whole deploy runs; this batches the box-C rebuilds
inside runs the gate already let through.

### A migration failed: P3009 / P3018 (2026-10-22)

`deploy-blue-green.sh` runs `prisma migrate deploy` on box A. A migration that
FAILS is recorded as failed in `_prisma_migrations`, and every later
`migrate deploy` then refuses with **P3009** ("migrate found failed
migrations") — even after main is reset and the migration file is gone — so
the whole pipeline wedges until the row is resolved.

- **Lost lock wait (automatic, fourth + fifth reviews 2026-10-22):** Prisma 7
  does NOT run a migration file as one transaction — statements before a
  failing one stay COMMITTED — so a bare `55P03` (lock_not_available) proves
  nothing. The automatic recovery in `scripts/deploy/migrate-lock-recovery.sh`
  therefore acts only on an ATOMIC in-place lock-retry migration: the file
  carries `-- digby-lock-retry: atomic` and is ONE `DO $$ … $$;` block
  (`migrate-lock-recovery.test.sh` lints every file that claims it), and its
  exhausted loop raises `55P03` with `[digby-lock-retry]` in the message (the
  shape in `20261021120000_chat_display_parent`: wait WITHOUT queueing while a
  holder cannot release in time — a transaction open ≥ 2 s (pg_dump,
  idle-in-transaction), a prepared transaction, an anti-wraparound autovacuum,
  or another role's session whose details the migrating role may not see —
  otherwise request the lock for ≤ 250 ms (1.5 s when a plain autovacuum holds
  it, so Postgres cancels it), 120 s budget, the holders named in the error).
  The classification is privilege-independent (prod migrates as the app role
  `admin`, which has no `pg_read_all_stats`: `pg_stat_activity` then hides
  xact_start / state / query / backend_type of every other role's session and
  of every autovacuum worker — only `pid` and `usesysid` stay visible; an
  autovacuum is the holder with NO user, an anti-wraparound one is known by
  the table's freeze age, and an autovacuum a 1.5 s request already lost
  against is never queued against again), and every `pg_locks` read names this
  database (a copy made from it as a TEMPLATE keeps the same relation OIDs).
  On that shape the helper runs `migrate resolve --rolled-back <name>` and
  retries `migrate deploy` ONCE (log line `lost a lock wait`) — except when the
  loop only WAITED behind a long holder (`(0 lock requests` in the error: the
  retry would wait behind the same holder for its whole budget), which is
  resolved and fails the deploy at once (`WITHOUT a retry`); a retry that loses
  too is resolved AGAIN before the deploy fails (`lost its lock wait AGAIN`),
  so the next deploy re-attempts instead of answering P3009. A P3009 an
  earlier deploy left (a resolve that failed, the switch on) is recovered the
  same way only after the read-only probe
  `backend/prisma/lock-recovery-probe.sql` (`prisma db execute --file`) says
  EVERY unresolved failed row's logs carry `[digby-lock-retry]` + `55P03`.
  A deploy KILLED mid-wait is NOT recovered automatically (see the manual
  path below). Anything else fails at once. `MIGRATE_LOCK_RECOVERY_DISABLED=1`
  (or `true` / `on`) turns it off: a repo Variable (`gh variable set
  MIGRATE_LOCK_RECOVERY_DISABLED --body 1` — `deploy.yml` forwards it to box A
  over the Blue-green step's stdin script), or a line in box A's
  `/opt/crossmodel-local/deploy-flags.env`. Migrations that take a heavy lock
  copy that shape (one statement, the marker line, the RAISE marker) — never a
  bare `SET lock_timeout` that fails the migration, and never extra statements
  next to the DO block. The nightly `pg_dump` (box A `digby-backup.timer`,
  08:30 UTC, ~14 min) holds ACCESS SHARE on every table: a heavy-lock
  migration that lands in that window waits its 120 s, is resolved, and fails
  the deploy cleanly (no retry — the next deploy applies it). Time budget: the
  migrate step's worst case that still SUCCEEDS is one lost 120 s loop + a
  resolve + a 120 s retry (≈ 4.5 min with the two container starts; it was
  ≈ 8.5 min with the earlier 240 s loop and its unconditional retry). It counts
  against the per-host 3300 s remote bound together with the did-it-work window
  and the research drain extension — a slow wave that also loses a lock wait
  can still reach that bound (rc 124 → the FAILED_HOST rollback), which is why
  a wait behind a long holder never retries in the same deploy.
- **A deploy KILLED mid-wait (manual):** a `prisma migrate deploy` that dies
  while the loop waits (box A reboot / OOM, a killed remote deploy, the
  `timeout 3300` TERM) leaves its `_prisma_migrations` row with `finished_at`,
  `rolled_back_at` AND `logs` all NULL, and the server-side session may carry
  on and ADD the column after its client died — the probe cannot tell, so every
  later deploy answers P3009 (the helper prints `killed mid-wait`). Wait until
  no backend still runs the migration (`pg_stat_activity` shows no
  `ALTER TABLE "crossmodel_chats"` / DO block), then read the schema
  (`information_schema.columns` for `displayParentChatId` on
  `crossmodel_chats`, through a `prodq.sh` one-shot), then ALWAYS
  `migrate resolve --rolled-back 20261021120000_chat_display_parent` —
  present or absent, the `ADD COLUMN IF NOT EXISTS` re-run no-ops or applies.
  Never `--applied` here: the deploy never flipped, so the ACTIVE container is
  the OLD image, which has no such migration directory (Prisma 7.10 P3017).
  Then re-run the deploy. Commands as in the next bullet.
- **Anything else (manual):** read the failed row first, then resolve it on
  box A through an ec2-ops playbook one-shot at the PROD anchor (no ssh).
  A migration is NOT one transaction: before marking it rolled back, check
  what it applied (`migrate status`, the row's `logs`, and the schema itself —
  an `information_schema` read through a `prodq.sh` one-shot) and undo or
  finish it by hand.
  ```bash
  cd /opt/crossmodel
  ACTIVE=$(cat /opt/crossmodel/.active-color)   # the serving colour (deploy-blue-green.sh ACTIVE_COLOR_FILE)
  sudo docker exec "admin-backend-${ACTIVE}" npx prisma migrate status            # names the failed migration
  # it applied NOTHING (checked above) → mark it rolled back:
  sudo docker exec "admin-backend-${ACTIVE}" npx prisma migrate resolve --rolled-back <migration_name>
  # it DID apply (you finished it by hand) → mark it applied instead:
  #   … npx prisma migrate resolve --applied <migration_name>
  ```
  Then re-run the deploy (`gh workflow run deploy.yml`). Never delete the
  `_prisma_migrations` row by hand.

### Deploy tuning switches (runner Variables, 2026-09-26)

The 2026-09-26 wave anatomy (runs 36200008105 / 36195616766: 48-59 min wall,
9-min from-scratch builds per web box, B's build waiting for A's whole phase,
a 60 s drain floor served at 0 runs) shipped a set of deploy-speed switches.
They are **runner env**, not box env: GitHub repository Variables that
`deploy.yml`'s "Blue-green deploy" step forwards over the same stdin script as
the smoke creds — `gh variable set NAME --body VALUE` (delete with
`gh variable delete NAME`); the next wave picks them up, no box staging. An
unset Variable is the script default. Everything is pinned by
`scripts/deploy/blue-green-speedups.test.sh` (CI shell-scripts job).

**Measured (2026-09-26):** the first wave after the merge, run 36209251894,
deployed in **17.7 min of deploy-job time** (28 min for the whole run incl.
queue) against the 49–59 min baseline — and that wave still built from the
dead cache, so the second wave is the one to compare. Box A's worker container
now runs the shared `digby-app-<colour>` image (no separate worker build on
the web boxes).

| Variable | Default | Item | What it does |
|---|---|---|---|
| `BUILDER_CACHE_KEEP` | `40GB` | #1 | BuildKit cache kept by the ONE post-build `docker builder prune --keep-storage` per box. The old 10 GB cap evicted the previous wave's layers every time (one wave writes ~10-12 GB; box B showed every `npm ci` record at usage count 1, unpruned box C at 21) — every build ran from scratch. Any docker size string; `10GB` restores the eviction. The ≥90 % pre-flight disk guard is unchanged. |
| `BUILDER_PRUNE_ONCE_DISABLED` | unset | #8 | `1` re-adds the second (end-of-deploy) builder prune (~17 s/box, redundant). |
| `DRAIN_SECONDS` | `10` | #8 | SSE-grace floor before the `/drain-status` poll (the poll exits at 0 chat runs; the floor used to be an unconditional 60 s). `60` restores; non-numeric → 10. |
| `WORKER_IMAGE_SHARED_DISABLED` | unset | #5 | `1` builds the worker image separately again. Default: `compose build backend frontend` — the worker service runs the backend tag (`docker-compose.app.yml` `image: ${APP_IMAGE:-digby-app-${BG_COLOR}}`, like relay), so bake exports one image fewer per box and box B (`ENABLE_WORKER=false`) builds no worker at all. Box C is unaffected: `deploy-coding-worker.sh` sets `APP_IMAGE` to its per-wave `crossmodel_<colour>_<epoch>-worker` name on every compose call. |
| `BACKEND_CHOWN_RECURSIVE` | unset | #2 | `1` restores `chown -R nodejs:nodejs /app` in `backend/Dockerfile` (a 108-120 s walk per backend build on the 2-vCPU boxes). Default: `COPY --chown` on the shipped trees + a non-recursive chown of `/app` and the workspace root; the entrypoint still chowns the mounted volume roots. Compose build arg — also honoured from the box `.env`. |
| `FRONTEND_CONTENT_BUST` | **`1` in prod since 2026-09-29 00:12Z** (repo Variable; unset = OFF) | #6 | `1` busts the frontend build on `sha256(frontend/)` (`scripts/deploy/frontend-bust-key.sh`) instead of the commit sha, so a backend-only wave reuses the cached `next build` (~3.5 min + export per box). Every web box hashes the same rsync'd tree ⇒ same key ⇒ the 2026-09-08 parity guarantee holds and the asset-parity gate is unchanged. `DEPLOY_SHA` (runtime, box_health) is still the commit. Owner enables after one observed wave with `#1` cached. |
| `PREBUILD_STATELESS` | **`1` in prod since 2026-09-29 00:12Z** (repo Variable; unset = OFF) | #3 | `1` pre-builds every later host's (B's) inactive-colour images in the background (`scripts/deploy/prebuild-inactive.sh` — `compose build` ONLY, never a running container) while host 1 (A) runs its phase; each host's own deploy waits for its pre-build first, so nothing overlaps on a box, and a failed pre-build only warns. `PREBUILD_STATELESS_DISABLED=1` is the kill switch (honoured by the script too). Expect B's "Build complete" within ~30 s of "Building images". **Image-build lock (batch-train T3g, 2026-10-17)**: the pre-build and `deploy-blue-green.sh` serialize every `compose build` on a box through the same `flock` (`/var/tmp/.digby-image-build.lock`, outside the rsync root) — the pre-build takes it non-blocking (busy ⇒ skip, its existing refusal class), the deploy bounded-blocking (`IMAGE_BUILD_LOCK_WAIT_SECONDS`, default 600; on timeout it WARNS and builds anyway — an orphaned pre-build from a cancelled/coalesced wave must never wedge a deploy). `IMAGE_BUILD_LOCK_DISABLED=1` is the lock's kill switch. |

Owner items NOT done in that wave (need an owner decision / guarded design):
**#4** early-retire B's live backend at wave start (needs a
`POST /drain-status/unretire` for failure/rollback paths — `coding/retiring.ts`
has none — or forwarding `DRAIN_MAX_RETIRING_SECONDS=300`), and **#7**
CI-built images pushed to ECR and pulled per box (registry + instance-role
auth, `DEPLOY_SHA`/`NEXT_PUBLIC_API_URL` baked in CI, the parity gate becomes
a digest check; prototype on box C first).

### Did-it-work gate (mandatory post-switch verification, T2d 2026-10-17)

Since 2026-10-17 every blue-green deploy must PROVE itself for ~5–10 minutes
after the nginx switch, before the old color is drained (owner answer
oq_e4f4e382: "Yes to both — autonomous deploy loop"). `deploy-blue-green.sh`
runs `scripts/deploy/did-it-work-gate.sh` between the post-flip checks and
the `.active-color` commit:

1. **Health** — `/api/health` healthy + frontend 200/304, every cycle
   (default 6 cycles × 60 s).
2. **Authenticated login/smoke** — `scripts/deploy-auth-smoke.sh` does a
   fresh login on cycle 1 (the token lives 15 m) and rechecks after.
3. **Error rate** — `scripts/deploy/did-it-work-probe.js`, run INSIDE the new
   backend container with the backend's own Prisma client, counts
   `app_error_logs` level=error since the switch against the SAME-DB,
   same-length pre-switch baseline: fail only above baseline × 5 (default)
   with ≥10 window rows (below the floor the comparison is noise — the boxes
   carry a standing error hum). A probe that cannot answer (DB unreachable)
   never fails the deploy by itself.

**On failure the deploy exits 42**, `revert_flip` restores nginx to the
verified color (its containers still run — the drain never began), the
workflow's auto-rollback runs `rollback.sh --to-live` (idempotent at that
point), and the `reset-main-on-did-it-work-failure` job pushes a REVERT of
the deploy's commits (`github.event.before..github.sha`) to main — an
ordinary commit, no force-push — so the next deploy cannot re-ship the failed
batch. Build/pre-flip/smoke failures keep the historical exit-1 semantics
(no switch happened, no main reset).

Tuning (runner Variables, forwarded by deploy.yml like the deploy-speed
switches — `gh variable set NAME --body VALUE`; unset = default; box env also
works for manual runs): `DID_IT_WORK_CYCLES` (6, clamp 1–30),
`DID_IT_WORK_INTERVAL_SECONDS` (60, 5–600), `DID_IT_WORK_BLIP_SECONDS` (30,
5–120), `DID_IT_WORK_WINDOW_MINUTES` (6, 1–30), `DID_IT_WORK_ERROR_FACTOR`
(5, 2–1000), `DID_IT_WORK_ERROR_ROWS_FLOOR` (10, 1–100000). Kill switch:
`DID_IT_WORK_DISABLED=1` skips the window with a loud warning — an emergency
lever only; unset (the default) the gate always runs. Timing budget: the
per-host remote timeout is 3300 s (55 min; slowest healthy phase 41.1 min +
~6-min window — a migration lock-wait recovery that still succeeds adds up to
~4.5 min on box A: one lost 120 s loop, a resolve, a 120 s retry; see "A
migration failed"), and `deploy-watchdog.sh` STALE_MINUTES rose 90→100 so the
sweep never cancels a healthy window-carrying run — a blip-heavy window
(retries add up to ~90 s/cycle) can approach the remote bound; keep CYCLES ×
INTERVAL well under it. If the gate cannot run at all (config error, missing
file), the deploy fails CLOSED — flip reverted, no main reset (exit 1
semantics). Pinned by `scripts/deploy/did-it-work-gate.test.sh`.

## Env flips must reach A, B AND C (and the store-backed alternative)

**Provider key rotation (2026-10-12):** update the GitHub secret and deploy — that is the whole path now. A and B get the key through the `.env` template; box C gets `MOONSHOT_API_KEY` / `DEEPSEEK_API_KEY` / `ZAI_API_KEY` / `DASHSCOPE_API_KEY` / `TYPESAFE_API_KEY` through the env-secrets heredoc (SECEOF). Do NOT stage a provider key through `env_override` unless GitHub secrets are out of reach: the overrides file is applied last and keeps winning after the secret is rotated (the 2026-10-12 one-time purge in `apply-env-overrides.sh` cleared the old ones).

**Secret-owned overrides (2026-10-20):** `CODING_EGRESS_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` and `GOOGLE_MCP_API_KEY` belong to the GitHub secrets. `apply-env-overrides.sh` purge #2 (`2026-10-20-secret-owned`) drops a box-local copy of `CODING_EGRESS_SECRET` once the deployed env carries a non-empty secret value. It drops a copy of one of the Google keys only when the copy is IDENTICAL to the deployed secret, so a mistyped or not-yet-updated secret never replaces the live value. Every key it keeps is named in the deploy log (never its value) and re-checked on each deploy until nothing is kept. To rotate one of these, update the GitHub secret and deploy; do not stage it through `env_override`. A manual run can skip the purge with `SECRET_OWNED_OVERRIDE_PURGE_DISABLED=1`.

`ec2-ops.yml`'s `env_override` dispatch input stages the KEY=VALUE line into
`/opt/crossmodel-local/env-overrides.env` on **box A only** (`secrets.EC2_HOST`).
Any setting the gated code reads from `process.env` runs on every box that
executes that path — the web backends on A **and** B (hooks fire from
`setImmediate` on emit in `hooks.service.ts`) and the sweeper/coding worker on
**C** — so a fleet-wide env flip (a `DECISION_GATE_MODE_<PURPOSE>` /
`DECISION_GATE_TEMP_<PURPOSE>` line, a provider key rotation, any
`*_DISABLED` kill switch) needs the SAME line staged on all three boxes: A via
the dispatch input, B and C by a playbook one-shot at the
`==ONE-SHOT-INSERT-POINT-PROD==` / `==ONE-SHOT-INSERT-POINT-CODING-C==` anchors
(same merge-not-replace idiom: `grep -q "^KEY=" "$F" && sed -i … || printf …
>> "$F"`), then the next deploy folds it in via `apply-env-overrides.sh`. Verify
with a count-only grep of `^KEY=` on each box — a line present on A alone is a
PARTIAL flip that shows up only as mixed values in telemetry (e.g.
`decision_gate` rows with both `mode:'act'` and `mode:'shadow'` for one
purpose). **Preferred for the decision gate:** the mode is a store-backed
instance setting since 2026-09-25 (WI-S) — Account → Admin → Endpoints → Model
roles → the Decision gate seat's "Gate mode per purpose" control (REST
`GET`/`PUT /api/crossmodel/admin/model-roles/decision-modes`): one row in the
context store, read by every box within its 30 s cache, so a flip is one save
and **fleet-wide by construction** — no env staging, no deploy. The stored mode
wins over env; `DECISION_GATE_STORE_MODE_DISABLED=1` on a box makes that box
ignore the row (env only) and `DECISION_GATE_DISABLED=1` still turns every
purpose off there. Telemetry stamps the winning source on each decision row
(`meta.modeSource`: `store` / `env_purpose` / `env_default` / `default`).
**Flip mechanics as practised (2026-09-26):** since the E12 admission (2026-09-25
evening) the PUT refuses `act` (409 naming the missing bar) unless a fresh
(≤ `DECISION_GATE_READINESS_MAX_AGE_DAYS` 7) `ready:true` stamp exists for the
purpose. The owner-directed first flips (00:20Z / 01:49Z / 02:05Z) were written
as the store row `['instance','decision-gate']/modes` via the app's `storePut`
inside `admin-backend` on box A (the scratchpad `flip-act.js` pattern) plus an
owner-override readiness stamp (`updatedBy owner-override:claude-loop`). The
6-h `decision-gate-readiness` cron (first firing 06:18Z) overwrites that stamp
with the measured verdict but never reverts a mode; the ONLY thing that moves a
purpose back to shadow is auto-demote (act-period labels only, n_act ≥ 30 AND the
Wilson 95% upper bound < bar − `DECISION_GATE_AUTO_DEMOTE_MARGIN`) or an admin
PUT. Verify a flip by `decision_gate` rows with `mode:'act'` + the consumer's
shed metric (`wake_parked reason:'triage'`, `schedule_sweep_skip`, …).

### Supervisor OFF switch from an ops session (2026-09-26)

The Fleet Supervisor / project supervisors OFF switch is a **store-backed
SystemSetting pair** (`fleet_supervisor_enabled`, `project_supervisors_enabled`;
`platform/supervisor-switch.ts`) — fleet-wide by construction, read by every box
within its 60 s cache, no env staging, no deploy. Normal path: Account → Admin →
Settings → Supervisors, or (admin token) `PUT /api/crossmodel/admin/settings/
fleet_supervisor_enabled` with body `{"value":"0"}` (ON: `{"value":"1"}`;
`GET /api/crossmodel/admin/settings/supervisors` reads both with since /
updatedBy / skipped). **If the UI/API is unreachable**, flip the row from inside
the active backend container on box A (a playbook one-shot at the
`==ONE-SHOT-INSERT-POINT-PROD==` anchor, or an SSM session):

```bash
# OFF (value '0'); ON is value '1'. The `_by` row is the audit trail the UI shows.
C=$(sudo docker ps --format '{{.Names}}' | grep -E '^admin-backend-(blue|green)$' | head -1)
sudo docker exec "$C" node -e '
  const { PrismaClient } = require("@prisma/client"); const p = new PrismaClient();
  (async () => {
    for (const [key, value] of [["fleet_supervisor_enabled","0"],["fleet_supervisor_enabled_by","ops:playbook"]]) {
      await p.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    console.log(await p.systemSetting.findMany({ where: { key: { in: ["fleet_supervisor_enabled","fleet_supervisor_enabled_by"] } } }));
    await p.$disconnect();
  })();'
```

The in-container write bypasses the controller, so it does NOT reset the Redis
skip counter (`supervisor_switch:skipped:fleet`) or write the `flipped`
telemetry row — acceptable for an emergency stop; the next admin PUT does both.
Every box picks the value up within 60 s (no restart). Verify with
`loop_metrics` rows kind `supervisor_switch` (`meta.action:'skipped'`, one per
entry point per 5 min) and `hook_events` rows `status='skipped:supervisor_off'`;
the Management Status card shows "Switched OFF" + the line. Env boot defaults
(`FLEET_SUPERVISOR_ENABLED` / `PROJECT_SUPERVISORS_ENABLED`) matter only when NO
row exists — the row always wins, so never stage the env as a flip.

## Backups

Three layers, all live since 2026-07-29 (nightly `pg_dump` timer on the box →
local dumps + S3 offsite via instance role, plus AWS Backup daily EBS snapshots).
Canonical source `scripts/backup/digby-backup.sh` + `deploy/digby-backup.{service,timer}`;
installed via marker-guarded ec2-ops one-shots (markers in `/var/tmp`). Architecture,
AWS resource IDs, restore runbooks, and the update path for the installed script:
**`docs/BACKUPS.md`**.

## Gotchas learned the hard way
- (historical) The kanban-watcher unit gotcha — `deploy/digby-kanban-watcher.service`
  had to mirror the **installed** unit on dev exactly (`User=paul`,
  `/home/paul/crossmodel`, memory/task caps, `NODE_OPTIONS`,
  `Requires=digby-kanban.service`) — died with the 2026-07-20 autopilot
  teardown; the file no longer exists in the repo.
- MCP GitHub scope is restricted to `example-org/crossmodel`. To touch other repos,
  use `mcp__claude-code-remote__list_repos` + `add_repo`.
- Commits from this environment show "Unverified" on GitHub (no GPG key in the
  container); the committer email is still correct. Don't force-push live `main`
  just to re-sign.
- **Known issue (noted 2026-09-01, ticket 795cc5fb) — silently skipped playbook
  blocks:** the ec2-ops one-shot channel could historically skip whole playbook
  blocks while the run exited 0 (bash-over-stdin transport: any stdin-reading
  command in the script ate later script lines). The scp + run-from-disk transport
  and the sentinel gate (see "The remote-ops harness" above) landed 2026-08-30 and
  close the class on PROD — but the coding-c step's sentinel checks are WARNINGS,
  not failures, and a green sentinel only proves the FILE ran end to end, not that
  your block did its work (a `/var/tmp` marker guard can legitimately no-op it).
  Always verify your block's own `== NAME ==` / `== END NAME ==` header lines in
  the run log before trusting that a one-shot fired.

## Compute-policy switches (2026-09-26 wave)

The depth / "Dig deeper" switches are `process.env` reads on the CHAT path,
which runs on the web backends of **A and B** (never C) — stage the same line on
both (A via the `env_override` input, B by a prod-section one-shot) or the fleet
answers with two behaviours. Server switches: `COMPUTE_POLICY_DISABLED`,
`RESEARCH_REQUEST_AUTOSTART_ENABLED` (audit 2026-09-26: the research_request
council marker is DEFAULT OFF — nothing consumes it; `…_DISABLED` still forces it off),
`DEPTH_BUDGET_DISABLED` (gate — names verified on cp/gate),
`DEPTH_BUDGET_RESEARCH_RUNG_DISABLED` — **DELETED 2026-10-30 (RSW-1 delete-with-ledger, goal 393f731e)**; the Dig-deeper
research rung always keeps its budget rail (umbrella `DEPTH_BUDGET_DISABLED` still disables it),
`DEPTH_BUDGET_BACKGROUND_DEADLINE_DISABLED` (the council deadline rail only); the 2026-09-26 audit
switches (`AUTO_ROUTE_ALLOWANCE_DISABLED`, `SUPERVISOR_AUTO_RESEARCH_ENABLED`,
`MACHINE_DEEP_RESEARCH_FLOOR_DISABLED`, `PATIENCE_AUTO_ONLY_REST_DISABLED`,
`PLATFORM_DEEP_RESEARCH_RESERVE_DISABLED`, `TELEGRAM_AUTO_ROUTE_DISABLED`,
`ESCALATION_REQUEUE_DISABLED`,
~~`ESCALATION_STAMP_DISABLED`~~, ~~`CHECKER_ROUTE_LATE_LABEL_DISABLED`~~, ~~`DRAFTS_AGREE_LATE_DISABLED`~~ (all three DELETED 2026-10-30, RSW-1 delete-with-ledger — NF_INERT, readers removed, the running stamp / late label / late drafts-agree pass are unconditional),
`COMPUTE_POLICY_MACHINE_ACT_ENABLED`,
`COMPUTE_POLICY_WINDOW_CLOSER_DISABLED` lives on A and C); `COMPUTE_POLICY_MACHINE_DISABLED` (2026-09-26 late —
supervisor / machine wakes stop asking the gate and run their preset rails;
`DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0` hard-disables the wake_effort act path); `ANSWER_FIRST_DISABLED`, `DIG_DEEPER_DISABLED`,
`UX_BEACON_DISABLED`, `SSE_EARLY_FLUSH_DISABLED`, `CHECK_ADDENDUM_DISABLED`
(harness — verified at merge against `chat-agent/compute-policy-wiring.ts`),
`COMPUTE_POLICY_LABELS_DISABLED` (cp/labels 2026-09-26: silences every
compute-policy outcome label — facts / escalated / escalated_late / reask_5m /
thumbs / drafts_agree / revision_material — without touching the decisions),
`REVISION_MATERIAL_CHECKED_LABELS_DISABLED` (audit 2026-09-26: a `checked` row
whose gate withheld the rewrite in act labels revision_material nothing again —
the pre-audit updated-only rule; default OFF labels it `acted:true`);
tunables `STAKES_WAIT_MS` (≤ 300000),
`COMPUTE_POLICY_TIMEOUT_MS` (300..1200), `DEPTH_BUDGET_MAX_USD` (0..50; 0 = no
bound), `DEPTH_BUDGET_MAX_BACKGROUND_MS` (60 s..40 min — enforced on the Dig-deeper
research rung's inline council (FINAL-TURN deadline) and, since the same audit,
on the Double Checker's harness kill + late reconcile wait through their 15-min
cap; shortening it in an incident takes effect on the next turn; kill switches
`DEPTH_BUDGET_BACKGROUND_BOUND_DISABLED=1` = the bare caps everywhere,
`DEPTH_BUDGET_BACKGROUND_DEADLINE_DISABLED=1` = the council deadline rail only),
`DECISION_GATE_THRESHOLD_COMPUTE_POLICY[_SIMPLE_LOOKUP|_STAKES|_CONTESTABLE|_RESEARCH_REQUEST]`,
`DECISION_GATE_THRESHOLD_DRAFTS_AGREE`, `DECISION_GATE_THRESHOLD_REVISION_MATERIAL`
(all documented in `.env.example`). The three gate purposes (`compute_policy`,
`drafts_agree`, `revision_material`) need NO env line: their modes are
store-backed and flip from Account → Admin → Endpoints → Model roles → Decision
gate (every box within 30 s); the `DECISION_GATE_MODE_*` lines are only the
fallback when the store row is unset. Rolling back the whole feature
server-side = `ANSWER_FIRST_DISABLED=1` + `DIG_DEEPER_DISABLED=1` on A and B (the
presets + the 300 s gate return byte-for-byte). NOTE (audit 2026-09-26): the
Advanced default depth does NOT pick the run while the always-Auto switch is on
— and production has run `patience_auto_only=1` since 2026-09-26 20:35Z: every
human send (an Advanced preset and guests included) is routed as Auto with the
preset kept as `routing.requestedMode` only. To make the Advanced preset pick
the run again, flip the switch OFF (Account → Admin → Settings → Depth policy,
or admin `PUT /api/crossmodel/admin/settings/patience_auto_only` body
`{"value":"0"}` — validated, idempotent, audited via `patience_auto_only_by`;
`GET /api/crossmodel/admin/settings/patience-auto-only` reads since / updatedBy).
Without the UI/API, the supervisor-switch in-container recipe above works with
the keys `patience_auto_only` / `patience_auto_only_by`.
(`DEPTH_POLICY_PUBLIC_DISABLED`, the display-only kill switch that used to
hide the Advanced-tab notice here, was RETIRED 2026-10-08 with the inert-switch
purge — see the switch registry's `removed:` ledger; it no longer reads
anywhere.)

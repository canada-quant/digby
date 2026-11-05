#!/usr/bin/env bash
# deploy-coding-worker.sh — coding-plane deploy for box C (example-ca-node).
#
# Box C runs ONLY the coding plane: the worker (CODING_WORKER_CONCURRENCY=32,
# set in /opt/crossmodel-local/env-overrides.env by playbook one-shot CC0902),
# docker-proxy, and session containers. It is NOT in EC2_HOSTS, so the main
# blue-green deploy never touches it — before this script existed, C's worker
# code went stale with every merge (found 2026-08-27: the #409 drain fix was
# live on A but absent from C's copy). deploy.yml rsyncs the repo here and
# runs this to rebuild + hand off ONLY the worker.
#
# Deliberately NOT deploy-blue-green.sh: no web stack, no nginx, no migrations
# (box A owns those), and --no-deps so compose can never resurrect the local
# postgres/redis/MCP strays that the initial migration compose-up created.
#
# v3 (2026-09-02, audit roadmap #5 — stop self-interrupting): the old
# `up -d --force-recreate worker` left a queue-processing gap for the whole
# build+recreate window and interrupted every in-flight run. Now the worker
# itself goes BLUE-GREEN: build + start the OPPOSITE color's worker (its own
# compose project, exactly how docker-compose.app.yml is parameterized), wait
# for it to go docker-HEALTHY (the compose healthcheck probes the worker's
# /tmp/worker-alive 2s heartbeat — healthy means the claim loop is ticking),
# and only THEN stop the old worker with its full stop_grace_period (45s:
# SIGTERM → runs marked shutdown-interrupted, checkpoints retained, ≤25s
# finalize wait). Interrupted rows are unconditionally claimable, so the
# already-live new worker re-claims them immediately — zero gap. Two workers
# overlapping is SAFE BY DESIGN: claims are single-transaction
# FOR UPDATE SKIP LOCKED (run-claim.ts), and the new container is a new worker
# GENERATION (workerId embeds the container hostname), so re-claims of the old
# worker's runs are attempt-COMPENSATED, not burned. Cron jobs are lease-
# claimed + Redis-NX-guarded — overlap-deduped (worker.ts boot comment).
# This works only because the app-compose volumes carry explicit global
# `name:`s and the network is external — both colors share them — and the
# worker publishes no ports. NOTE: `--scale worker=2` can never replace this:
# the service pins container_name, which compose refuses to scale.
#
# If the new worker fails its health-wait: it is removed, the OLD worker keeps
# running untouched, and we exit non-zero. deploy.yml wraps this script in
# `|| echo WARNING` — a failure here surfaces as a WARNING in the run log and
# never fails the web deploy. Re-running is idempotent (a half-done handoff is
# reconciled at startup: the older of two running workers is retired).
#
# Rebuild + handoff ONLY when the worker's actual inputs changed (2026-08-27,
# owner: "waiting for the worktree" got frequent — every merge bounced the
# worker and interrupted in-flight runs). v1 compared image ids, but BuildKit
# stamps fresh provenance metadata on every build, so the id differs even for
# identical content — the skip never fired. v2 hashed all of backend/ +
# compose file + box-local env overrides. v3 narrows the input set to what
# actually reaches the worker image (see the HASH block).
set -euo pipefail
cd /opt/crossmodel

HEALTH_TIMEOUT=420  # seconds; compose gate history: worker unhealthy at ~390s worst-case

# Merge box-local env (REDIS_URL -> box A, CODING_WORKER_CONCURRENCY=32, ...)
# into .env. The rsync excludes .env so the merged file survives the sync.
bash scripts/deploy/apply-env-overrides.sh
# Transient registry errors retry the worker build (2026-10-19).
if [ -f scripts/deploy/build-retry.sh ]; then
  # shellcheck source=scripts/deploy/build-retry.sh
  . scripts/deploy/build-retry.sh
else
  build_with_retry() { "$@"; }
fi

# The commit this rsync shipped (.deploy-sha rides with it) — compose
# interpolates it into the worker's DEPLOY_SHA so box_health rows report the
# sha the worker was built from (2026-09-18, get_fleet_telemetry deploy view).
# Deliberately NOT part of the rebuild-input hash below: a docs-only wave must
# keep skipping the rebuild, so a worker that skipped keeps reporting the sha
# it was actually built from — which is the honest answer.
export DEPLOY_SHA="$(cat /opt/crossmodel/.deploy-sha 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
# Exact-match on the two legal names so strays can never poison color detection.
running_workers() {
  # DRAIN (owner 2026-09-24): a worker that received its retire signal keeps
  # running until its active runs finish (marker /tmp/worker-draining inside
  # the container). It is NOT a live worker for color detection / reconcile.
  local n
  for n in $(docker ps --format '{{.Names}}' | grep -E '^admin-worker-(blue|green)$' || true); do
    if docker exec "$n" test -f /tmp/worker-draining >/dev/null 2>&1; then continue; fi
    printf '%s\n' "$n"
  done
}
container_draining() { # $1=name — running AND carrying the drain marker
  container_running "$1" && docker exec "$1" test -f /tmp/worker-draining >/dev/null 2>&1
}
# PARK (operator iteration 12, 2026-09-25): the drain retire worked, but the
# NEXT wave reused the drainer's color — it waited ≤900 s, then `docker stop`ped
# the drainer and every run still on it restarted ("lost its worker to a worker
# replacement": 6 runs in 24 h, one 4-hour run restarted on two consecutive
# waves). With waves ~45 min apart and runs that take hours, that was a
# livelock for long runs. Now a still-draining target is RENAMED out of the
# way (park_drainer) and the new worker comes up in a PER-WAVE compose
# project (crossmodel_<color>_<epoch>) — compose finds containers by project
# label, so a parked drainer (old label) is invisible to `up` and keeps
# finishing its runs until it exits on its own (restart=no; worker.ts drain
# bound). Bounded: past WORKER_MAX_DRAINERS parked drainers the OLDEST is
# interrupted (checkpoints retained); exited drainers + their per-wave images
# are pruned on every wave. WORKER_DRAIN_PARK_DISABLED=1 restores the wait.
WORKER_MAX_DRAINERS="${WORKER_MAX_DRAINERS:-4}"
draining_workers() { # every running PARKED drainer, oldest first: "<created> <name>"
  local n
  for n in $(docker ps --format '{{.Names}}' | grep -E '^admin-worker-(blue|green)-drain-[0-9]+$' || true); do
    printf '%s %s\n' "$(docker inspect -f '{{.Created}}' "$n" 2>/dev/null || echo 0)" "$n"
  done | sort
}
park_drainer() { # $1=name — free the color name; the drainer keeps finishing its runs, nothing is stopped
  local parked="$1-drain-$(date +%s)"
  echo "parking draining $1 as $parked (its runs finish in place; nothing is stopped)"
  docker rename "$1" "$parked" >/dev/null 2>&1 || true
}
# ── Drainer-slot WAIT (ticket ed057f9d, 2026-10-16) ──────────────────────────
# The cap eviction interrupted LIVE work to make room for a rebuild: measured
# 2026-10-16 13:05 PT, all 4 drainer slots busy, the oldest (green-drain-
# 1792176620) 99 minutes into its drain with 7 active runs — the NEXT backend
# wave would docker-stop it. Before parking TARGET (the park is what pushes
# count past cap), make room the SOTA way: evict run-FREE parked drainers
# immediately (they are garbage — a drain that finished its runs but never
# exited, or a stuck drain), then WAIT (bounded) for a live drainer to exit.
# Only past the bound does enforce_drainer_cap fire (unchanged, the bounded
# fallback of last resort — never unbounded, the wave must not hang).
# WORKER_DRAIN_SLOT_WAIT_DISABLED=1 restores the today path byte-for-byte.
WORKER_DRAIN_SLOT_WAIT_MAX_SEC="${WORKER_DRAIN_SLOT_WAIT_MAX_SEC:-600}"
WORKER_DRAIN_SLOT_POLL_SEC="${WORKER_DRAIN_SLOT_POLL_SEC:-30}"
# 600 s, NOT 900+: this wait runs INSIDE the Deploy job, whose `updated_at`
# freezes at job start — deploy-watchdog.sh cancels an in_progress run at
# 90 min of zero job progress (arm 1), and healthy jobs have hit 72.4 min
# before the box-C step even starts. A longer wait needs a STALE_MINUTES
# review first.
int_env() { # $1=value $2=default — numeric-or-default (an unparsable value
  case "$1" in        # under `set -u` arithmetic would kill the wave)
    ''|*[!0-9]*) echo "$2" ;;
    *) echo "$1" ;;
  esac
}
WORKER_DRAIN_SLOT_WAIT_MAX_SEC=$(int_env "$WORKER_DRAIN_SLOT_WAIT_MAX_SEC" 600)
WORKER_DRAIN_SLOT_POLL_SEC=$(int_env "$WORKER_DRAIN_SLOT_POLL_SEC" 30)
WORKER_DRAIN_SLOT_POLL_SEC=$(( WORKER_DRAIN_SLOT_POLL_SEC < 5 ? 5 : WORKER_DRAIN_SLOT_POLL_SEC ))

# Live-run count for one parked drainer. Source of truth = the run LEASE, not
# the name: workerId is `worker-<hostname>-<pid>` (backend/src/worker.ts) and
# the hostname is the docker SHORT CONTAINER ID, which `docker rename` never
# touches — so `docker inspect -f '{{.Id}}'` → first 12 hex is the stable join
# key across the park rename. A 'running' row whose leaseExpiresAt has LAPSED
# is already claimable by the live worker (run-claim.ts) — stopping the
# drainer loses nothing, so it must not count as live. Query shape mirrors
# scripts/check-worker-liveness.sh: ephemeral pgvector psql (no host psql on
# the boxes) with the DATABASE_URL of a WORKER container (box C runs no
# admin-backend-*). --network host: the sandbox egress guard REJECTS
# bridge→VPC/RDS, and a plain `docker run` lands on the default bridge.
# Fail-safe: probe failure → treat the drainer as LIVE (wait, bounded — the
# ticket exists because evictions kill runs; a redundant wait is cheap) with
# a loud probe=unknown marker.
drainer_live_runs() { # $1=container name → stdout: "<n> <source>" (db|logs|unknown)
  local cid n logs
  cid=$(docker inspect -f '{{.Id}}' "$1" 2>/dev/null | cut -c1-12 || true)
  if [ -n "$cid" ] && [ -n "$DRAINER_DB_URL" ]; then
    n=$(docker run --rm --network host pgvector/pgvector:pg16 psql "$DRAINER_DB_URL" \
          -t -A --no-psqlrc -c "SELECT count(*) FROM agent_runs WHERE status='running' AND \"workerId\" LIKE 'worker-${cid}-%' AND \"leaseExpiresAt\" > now()" \
          </dev/null 2>/dev/null || true)
    case "$n" in
      ''|*[!0-9]*) ;; # psql failed — fall through to the log leg
      *) printf '%s db\n' "$n"; return 0 ;;
    esac
  fi
  # Fallback leg: the drainer's own 60 s log line (worker.ts drain loop)
  #   "coding worker worker-<id>-<pid>: draining — N run(s) still active after Xs"
  logs=$(docker logs --tail 200 "$1" 2>&1 </dev/null | grep -E 'draining — [0-9]+ run\(s\) still active' | tail -1 || true)
  n=$(printf '%s' "$logs" | sed -n 's/.*draining — \([0-9]*\) run(s) still active.*/\1/p')
  case "$n" in
    ''|*[!0-9]*) printf '0 unknown\n' ;;
    *) printf '%s logs\n' "$n" ;;
  esac
}

parked_count() { # running PARKED drainers (docker ps counts only running)
  printf '%s\n' "$(draining_workers)" | grep -c . || true
}

ensure_drainer_slot() { # make room for TARGET's park; bounded, never unbounded
  local waited=0 rows oldest n probe live src
  [ "${WORKER_DRAIN_SLOT_WAIT_DISABLED:-0}" = "1" ] && { echo "drainer-slot: disabled (kill switch)"; return 0; }
  while :; do
    prune_drainers   # an exited drainer frees a slot (and its image)
    n=$(parked_count)
    [ "$n" -lt "$WORKER_MAX_DRAINERS" ] && return 0
    # EVERY iteration burns wait budget — eviction rounds included — so a
    # `docker stop` that cannot retire its container (wedged task, daemon
    # error) can never hot-spin: the bound still ends the loop and the
    # unchanged cap eviction takes over (adversarial review M1, ed057f9d).
    if [ "$waited" -ge "$WORKER_DRAIN_SLOT_WAIT_MAX_SEC" ]; then
      echo "WARNING: drainer-slot: timeout waited=$waited parked=$n — falling back to cap eviction (checkpoints retained)"
      return 0
    fi
    rows=$(draining_workers)
    oldest=$(printf '%s\n' "$rows" | head -1 | awk '{print $2}')
    [ -z "$oldest" ] && return 0
    probe=$(drainer_live_runs "$oldest")   # "<n> <source>"
    live=${probe%% *}
    src=${probe##* }
    if [ "$src" = "unknown" ]; then
      echo "WARNING: drainer-slot: probe=unknown (db+logs legs failed for $oldest) — treating parked as live"
    fi
    if [ "$live" = "0" ] && [ "$src" != "unknown" ]; then
      # Run-FREE parked drainer is garbage — evict it NOW, oldest first.
      # retire → docker stop → exited → the prune at loop top frees its slot
      # next round. No sleep on this branch: a WORKING eviction is instant;
      # a FAILING one is bounded by the budget check above.
      echo "drainer-slot: evicted-run-free $oldest (0 live runs, source=$src)"
      retire "$oldest"
    else
      [ "$waited" -eq 0 ] && echo "drainer-slot: wait-start parked=$n cap=${WORKER_MAX_DRAINERS} oldest=$oldest oldest_live_runs=$live source=$src"
      # Exit early ONLY on a DEFINITE exit: gone from `docker ps` entirely.
      # A failed drain-marker exec probe is NOT evidence of exit (review n2)
      # — in that case keep waiting, the bound still applies.
      if [ -n "${TARGET:-}" ] && ! container_running "$TARGET"; then
        echo "drainer-slot: target exited on its own mid-wait — no park needed"
        return 0
      fi
      sleep "$WORKER_DRAIN_SLOT_POLL_SEC"
      echo "drainer-slot: poll waited=$((waited + WORKER_DRAIN_SLOT_POLL_SEC)) parked=$(parked_count) oldest_live_runs=$live source=$src"
    fi
    waited=$((waited + WORKER_DRAIN_SLOT_POLL_SEC))
  done
}

# Resolve the DB URL once per script run (from the LIVE worker container —
# box C runs no admin-backend-*; the parked drainers hold the same env but
# the live one is the authoritative source and never carries the drain marker
# edge cases). Cheap: one docker exec.
resolve_drainer_db_url() {
  local w
  for w in $(running_workers); do
    DRAINER_DB_URL=$(docker exec "$w" sh -c 'printf %s "$DATABASE_URL"' </dev/null 2>/dev/null || true)
    [ -n "$DRAINER_DB_URL" ] && return 0
  done
  DRAINER_DB_URL=""
}

# ── Rollout WINDOW (ticket ed057f9d, 2026-10-16) ───────────────────────────
# At most one box-C worker rollout per window, enforced ON-BOX (never in CI —
# this cannot skip the web deploy or strand main). Called AFTER the input-hash
# skip (the hash genuinely changed) and BEFORE any compose call. Returns 0
# (defer this wave's rebuild) / 1 (roll out now). Guarantees:
#   · deferral never writes the STAMP — the hash check re-evaluates every
#     wave, so the first wave ≥ window after the last rollout deploys
#     (staleness bounded by window + inter-wave gap);
#   · the pending markers age the UNDEPLOYED hash: the same hash keeps its
#     first-seen .at; a DIFFERENT pending hash (a newer change superseded the
#     deferred one) refreshes .at; pending_age ≥ MAX_STALE forces a rollout
#     (a burst of waves would otherwise keep last-rollout-age young forever);
#   · no live worker → never defer (leave nothing workerless for a window);
#   · WORKER_ROLLOUT_WINDOW_DISABLED=1 → never defer (manual force-roll too).
# File paths / clock are env-overridable for the test harness (suffix _FILE,
# _NOW_EPOCH); prod defaults sit next to the input-hash stamp.
WORKER_ROLLOUT_MIN_INTERVAL_SEC=$(int_env "${WORKER_ROLLOUT_MIN_INTERVAL_SEC:-1800}" 1800)
WORKER_ROLLOUT_MAX_STALE_SEC=$(int_env "${WORKER_ROLLOUT_MAX_STALE_SEC:-7200}" 7200)
[ "$WORKER_ROLLOUT_MAX_STALE_SEC" -le "$WORKER_ROLLOUT_MIN_INTERVAL_SEC" ] \
  && WORKER_ROLLOUT_MAX_STALE_SEC=$((WORKER_ROLLOUT_MIN_INTERVAL_SEC * 2))
LAST_ROLLOUT_AT_FILE="${LAST_ROLLOUT_AT_FILE:-/opt/crossmodel-local/coding-worker-last-rollout.at}"
PENDING_HASH_FILE="${PENDING_HASH_FILE:-/opt/crossmodel-local/coding-worker-pending.hash}"
PENDING_AT_FILE="${PENDING_AT_FILE:-/opt/crossmodel-local/coding-worker-pending.at}"
rollout_window_deferred() { # $1=hash $2=has_live_worker(0|1) → 0 defer / 1 roll
  local hash="$1" has_worker="$2" now last_at last_age pend pend_at pend_age
  if [ "${WORKER_ROLLOUT_WINDOW_DISABLED:-0}" = "1" ]; then
    echo "worker-rollout-window: disabled (kill switch)"
    return 1
  fi
  if [ "$has_worker" != "1" ]; then
    echo "worker-rollout-window: bypass no-live-worker"
    return 1
  fi
  now="${ROLLOUT_NOW_EPOCH:-$(date +%s)}"
  last_at=$(cat "$LAST_ROLLOUT_AT_FILE" 2>/dev/null || echo 0)
  case "$last_at" in ''|*[!0-9]*) last_at=0 ;; esac
  last_age=$(( now - last_at ))
  pend_age=0
  if [ -f "$PENDING_HASH_FILE" ] && [ "$(cat "$PENDING_HASH_FILE" 2>/dev/null)" = "$hash" ]; then
    pend_at=$(cat "$PENDING_AT_FILE" 2>/dev/null || echo 0)
    case "$pend_at" in ''|*[!0-9]*) pend_at=0 ;; esac
    pend_age=$(( now - pend_at ))
  fi
  if [ "$pend_age" -ge "$WORKER_ROLLOUT_MAX_STALE_SEC" ]; then
    echo "worker-rollout-window: forced hash=${hash:0:12} pending_age=${pend_age}s >= max_stale=${WORKER_ROLLOUT_MAX_STALE_SEC}s"
    return 1
  fi
  if [ "$last_age" -lt "$WORKER_ROLLOUT_MIN_INTERVAL_SEC" ]; then
    echo "worker-rollout-window: deferred hash=${hash:0:12} last_rollout_age=${last_age}s min_interval=${WORKER_ROLLOUT_MIN_INTERVAL_SEC}s pending_age=${pend_age}s"
    if [ ! -f "$PENDING_HASH_FILE" ] || [ "$(cat "$PENDING_HASH_FILE" 2>/dev/null)" != "$hash" ]; then
      printf '%s\n' "$hash" > "$PENDING_HASH_FILE"
      printf '%s\n' "$now" > "$PENDING_AT_FILE"
    fi
    return 0
  fi
  return 1
}

enforce_drainer_cap() { # bound memory: beyond WORKER_MAX_DRAINERS parked drainers, the OLDEST are interrupted
  local rows n excess oldest
  rows=$(draining_workers)
  n=$(printf '%s\n' "$rows" | grep -c . || true)
  excess=$((n - WORKER_MAX_DRAINERS))
  [ "$excess" -gt 0 ] || return 0
  for oldest in $(printf '%s\n' "$rows" | head -n "$excess" | awk '{print $2}'); do
    echo "drainer cap ${WORKER_MAX_DRAINERS} exceeded (${n} parked) — interrupting oldest $oldest (docker stop, checkpoints retained)"
    retire "$oldest"
  done
}
prune_drainers() { # exited parked drainers → rm + best-effort removal of their per-wave image
  local n img
  for n in $(docker ps -a --filter status=exited --format '{{.Names}}' | grep -E '^admin-worker-(blue|green)-drain-[0-9]+$' || true); do
    img=$(docker inspect -f '{{.Config.Image}}' "$n" 2>/dev/null || true)
    echo "pruning exited drainer $n"
    docker rm "$n" >/dev/null 2>&1 || true
    if [ -n "$img" ]; then docker image rm "$img" >/dev/null 2>&1 || true; fi
  done
}
# Per-wave images (iteration 13): a plain-named worker that finished draining
# BEFORE its color was needed again is removed by the flip's `docker rm -f`
# with no image removal — every wave then left a 2.4 GB crossmodel_<color>_
# <epoch>-worker tag behind (3 tags after the first morning of parking). Remove
# every worker image no container references any more, EXCEPT the one built
# for this wave ($1 — no container references it until `up` runs).
prune_worker_images() { # $1=image to keep (this wave's build)
  local keep="${1:-}" used img
  used=$(docker ps -a --format '{{.Image}}' || true)
  for img in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^crossmodel_(blue|green)(_[0-9]+)?-worker:' || true); do
    [ "$img" = "$keep" ] && continue
    [ "${img%:latest}" = "$keep" ] && continue
    if printf '%s\n' "$used" | grep -qx "$img"; then continue; fi
    if printf '%s\n' "$used" | grep -qx "${img%:latest}"; then continue; fi
    echo "pruning unreferenced worker image $img"
    docker image rm "$img" >/dev/null 2>&1 || true
  done
}

# Wait for a draining container to exit on its own (bounded), then interrupt it.
# (Legacy path — used only under WORKER_DRAIN_PARK_DISABLED=1 since iteration 12.)
WORKER_DRAIN_WAIT_MAX_SEC="${WORKER_DRAIN_WAIT_MAX_SEC:-900}"
wait_drained_or_retire() { # $1=name
  local c="$1" waited=0
  while container_draining "$c" && [ "$waited" -lt "$WORKER_DRAIN_WAIT_MAX_SEC" ]; do
    [ $((waited % 60)) -eq 0 ] && echo "waiting for draining $c to finish its runs (${waited}s / ${WORKER_DRAIN_WAIT_MAX_SEC}s)"
    sleep 10; waited=$((waited + 10))
  done
  if container_running "$c"; then
    echo "draining $c still running after ${waited}s — interrupting its leftovers (docker stop, checkpoints retained)"
    retire "$c"
  else
    docker rm "$c" >/dev/null 2>&1 || true
  fi
}

# Existence probes. NEVER `docker ps | grep -q` directly: grep -q exits on the
# first match while docker is still writing (box C lists dozens of digby-code-*
# session containers) — the SIGPIPE turns a MATCH into exit 141 under pipefail.
# Buffering through a substitution lets docker finish before grep looks.
container_running() { # $1=name
  local names; names=$(docker ps --format '{{.Names}}' || true)
  printf '%s\n' "$names" | grep -qx "$1"
}
container_exists() { # $1=name, any state
  local names; names=$(docker ps -a --format '{{.Names}}' || true)
  printf '%s\n' "$names" | grep -qx "$1"
}

# DRAIN retire (owner 2026-09-24): send SIGTERM and DO NOT wait — the worker
# stops claiming and finishes its active runs in place, exiting when idle
# (backend/src/worker.ts drain()). The next same-color deploy waits for it
# (wait_drained_or_retire). WORKER_DRAIN_ON_DEPLOY_DISABLED=1 → old stop path.
retire_drain() { # $1=container
  if [ "${WORKER_DRAIN_ON_DEPLOY_DISABLED:-0}" = "1" ]; then retire "$1"; return; fi
  echo "draining $1 (SIGTERM, not waiting — it exits when its runs finish)"
  # `docker kill` marks the container manually-stopped so unless-stopped does
  # not resurrect it — clearing the policy makes that explicit either way (a
  # resurrected old-code worker would claim runs again).
  docker update --restart=no "$1" >/dev/null 2>&1 || true
  docker kill -s TERM "$1" >/dev/null 2>&1 || true
}

# Graceful retire: honor the container's compose-stamped StopTimeout (45s —
# SIGTERM → shutdown-interrupt + finalize) so in-flight runs checkpoint.
retire() { # $1=container
  local st
  st=$(docker inspect -f '{{.Config.StopTimeout}}' "$1" 2>/dev/null || echo '')
  case "$st" in ''|'<nil>'|0) st=45 ;; esac
  docker stop -t "$st" "$1" >/dev/null 2>&1 || true
  docker rm "$1" >/dev/null 2>&1 || true
}

# Health wait: docker-healthy = the worker's claim loop is actually ticking
# (the compose healthcheck stats /tmp/worker-alive, touched every 2s tick).
# Fails fast on exit/unhealthy/crash-loop instead of sitting out the timeout.
wait_healthy() { # $1=container $2=timeout-seconds; 0=healthy, 1=not
  local c="$1" t="$2" waited=0 st rc
  while [ "$waited" -le "$t" ]; do
    st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null) || st=gone
    case "$st" in
      healthy) echo "worker $c healthy after ${waited}s"; return 0 ;;
      unhealthy|gone|exited|dead)
        echo "worker $c health-wait: state=$st after ${waited}s" >&2; return 1 ;;
      running) # no compose healthcheck on the container (shouldn't happen) — boot log line is the fallback
        # (logs buffered into a var: grep -q closing a live pipe early would
        # turn a MATCH into a pipefail failure)
        if [ -n "$(docker logs "$c" --tail 500 2>&1 | grep -m1 'coding worker .* started' || true)" ]; then
          echo "worker $c has no healthcheck — boot line seen after ${waited}s"; return 0
        fi ;;
    esac
    rc=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null || echo 0)
    if [ "${rc:-0}" -gt 2 ]; then
      echo "worker $c is crash-looping (RestartCount=$rc)" >&2; return 1
    fi
    sleep 5; waited=$((waited + 5))
  done
  echo "worker $c not healthy after ${t}s" >&2; return 1
}

boot_line() { # keep the v2 boot-line log semantics (informational)
  # Logs buffered into a var first — `docker logs | grep -m1` under pipefail
  # can report failure on a real match when grep's early exit SIGPIPEs docker.
  local logs
  logs=$(docker logs "$1" --tail 50 2>&1 || true)
  printf '%s\n' "$logs" | grep -m1 'coding worker' \
    || { echo "WARNING: worker boot line not seen yet"; printf '%s\n' "$logs" | tail -5; }
}

# ---------------------------------------------------------------------------
# Detect the live worker. Adapt to whatever color/project it actually runs
# under — the migration brought C up ad hoc, so detect rather than assume.
# ---------------------------------------------------------------------------
# Reconcile a half-done handoff (previous run died between new-healthy and
# old-stop): if BOTH colors are running, retire the OLDER-created one — the
# newer one is the fresher code. Overlap until now was safe (SKIP LOCKED).
RW=$(running_workers)
if [ "$(printf '%s\n' "$RW" | grep -c . || true)" -ge 2 ]; then
  OLDEST=$(for w in $RW; do printf '%s %s\n' "$(docker inspect -f '{{.Created}}' "$w" 2>/dev/null || echo 0)" "$w"; done | sort | head -1 | awk '{print $2}')
  echo "RECONCILE: two workers running ($(echo "$RW" | tr '\n' ' ')) — retiring older $OLDEST"
  retire "$OLDEST"
  RW=$(running_workers)
fi

WN=$(printf '%s\n' "$RW" | grep -m1 . || true)
AC=${WN#admin-worker-}
[ -n "$WN" ] || AC=green
PROJ=""
[ -n "$WN" ] && PROJ=$(docker inspect "$WN" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
[ -n "$PROJ" ] || PROJ="crossmodel_${AC}"
BP=4001; FP=8248
[ "$AC" = "green" ] && { BP=4002; FP=8249; }
echo "coding-worker deploy: color=$AC project=$PROJ"

# ---------------------------------------------------------------------------
# Input hash — skip the whole build+handoff when nothing the worker image (or
# its runtime env) depends on has changed. v3 narrowed set, derived from
# backend/Dockerfile + backend/.dockerignore:
#   IN the image: src (→ dist via tsc), prisma/, package*.json,
#     prisma.config.ts, openapi.json, entrypoint.sh, Dockerfile, .dockerignore
#   NOT in the image (excluded): node_modules, dist, coverage, tests/, .env*,
#     *.log, editor dirs (all dockerignored) — plus *.md and *.test.ts.
#     Caveat, deliberate: tsc compiles src/**/*.test.ts into dist (tsconfig
#     only excludes the tests/ dir), so a test-only change technically alters
#     image bytes — but those compiled test files are runtime-inert (nothing
#     requires them), so they are NOT worth bouncing the worker over. Same for
#     the rare .md under prisma/ (copied but never read at runtime).
#   KEPT beyond backend/: docker-compose.app.yml (service definition — env
#     list, healthcheck, grace) + box-local env-overrides (runtime env) +
#     the deploy-managed env-secrets list (runtime env — ticket f670b63b:
#     env-secrets.env is folded into .env by apply-env-overrides.sh BEFORE
#     the overrides, so its values reach the worker ONLY through a recreate;
#     hashing it means a secrets-only change (a new GitHub secret, e.g. the
#     SMTP credentials) flips the hash and rebuilds the worker instead of
#     leaving it running with the OLD env — the 2026-09-27 gap: the SMTP
#     secrets landed at 21:28Z, the 21:28:55Z worker predated the fold and
#     kept EMPTY DIGBY_SMTP_* until an unrelated backend change rebuilt it).
# ---------------------------------------------------------------------------
HASH=$( { find backend -type f \
            -not -path '*/node_modules/*' \
            -not -path 'backend/dist/*' \
            -not -path 'backend/coverage/*' \
            -not -path 'backend/tests/*' \
            -not -path 'backend/.vscode/*' \
            -not -path 'backend/.idea/*' \
            -not -name '.env' -not -name '.env.*' \
            -not -name '.gitignore' \
            -not -name '*.test.ts' \
            -not -name '*.md' \
            -not -name '*.log' \
            -print0 | sort -z | xargs -0 sha256sum; \
          sha256sum docker-compose.app.yml; \
          sha256sum /opt/crossmodel-local/env-overrides.env 2>/dev/null || true; \
          sha256sum /opt/crossmodel-local/env-secrets.env 2>/dev/null || true; } \
        | sha256sum | cut -d' ' -f1)
STAMP=/opt/crossmodel-local/coding-worker-inputs.hash
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$HASH" ] \
   && container_running "admin-worker-${AC}"; then
  echo "worker inputs unchanged (${HASH:0:12}) — skipping build+recreate, worker keeps running"
  echo "coding-worker deploy done on $(hostname)"
  exit 0
fi

if rollout_window_deferred "$HASH" "$([ -n "$WN" ] && echo 1 || echo 0)"; then
  echo "coding-worker deploy done on $(hostname) (window-deferred — inputs pending rollout)"
  exit 0
fi
# A rollout is happening (or the window is disabled) — clear the pending markers.
rm -f "$PENDING_HASH_FILE" "$PENDING_AT_FILE"
now_epoch="${ROLLOUT_NOW_EPOCH:-$(date +%s)}"

# Safety net: an UNEXPECTED failure (set -e) mid-handoff must never leave two
# workers past script end — while the old worker is still running it stays
# authoritative and the half-born new one is removed.
NEW="" ; OLD=""
cleanup_on_error() {
  local code=$?
  if [ "$code" -ne 0 ] && [ -n "$NEW" ] && [ -n "$OLD" ] \
     && container_running "$OLD"; then
    echo "ERROR: coding-worker handoff aborted (exit $code) — removing $NEW; old worker $OLD keeps running" >&2
    docker rm -f "$NEW" >/dev/null 2>&1 || true
  fi
}
trap cleanup_on_error EXIT

if [ -z "$WN" ]; then
  # No worker running at all — nothing to overlap with or protect. Plain
  # deploy under the detected/default color (v2 behavior, minus the fixed
  # sleep: we gate on health). On failure the container is LEFT in place —
  # restart:unless-stopped may still self-heal it, and there is no old worker
  # a rollback could restore.
  BG_COLOR="$AC" BG_PORT_BACKEND="$BP" BG_PORT_FRONTEND="$FP" APP_IMAGE="${PROJ}-worker" \
    build_with_retry docker compose -p "$PROJ" -f docker-compose.app.yml build worker 2>&1 | tail -3
  BG_COLOR="$AC" BG_PORT_BACKEND="$BP" BG_PORT_FRONTEND="$FP" APP_IMAGE="${PROJ}-worker" \
    docker compose -p "$PROJ" -f docker-compose.app.yml up -d --no-deps --force-recreate worker 2>&1 | tail -3
  if ! wait_healthy "admin-worker-${AC}" "$HEALTH_TIMEOUT"; then
    echo "ERROR: fresh worker admin-worker-${AC} failed health-wait — left in place (no prior worker existed); NOT stamping" >&2
    exit 1
  fi
  boot_line "admin-worker-${AC}"
  echo "$HASH" > "$STAMP"
  echo "$now_epoch" > "$LAST_ROLLOUT_AT_FILE"
  echo "coding-worker deploy done on $(hostname)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Overlap handoff: old color keeps claiming while the new color builds, boots
# and goes healthy — then, and only then, the old one is gracefully retired.
# ---------------------------------------------------------------------------
NC=blue; NBP=4001; NFP=8248
[ "$AC" = "blue" ] && { NC=green; NBP=4002; NFP=8249; }
# Per-wave compose project (iteration 12): a parked drainer keeps its OLD
# project label, so `up` in a fresh project can never recreate or stop it.
NPROJ="crossmodel_${NC}_$(date +%s)"
[ "${WORKER_DRAIN_PARK_DISABLED:-0}" = "1" ] && NPROJ="crossmodel_${NC}"
TARGET="admin-worker-${NC}"
# deploy_speedups #5 (2026-09-26): docker-compose.app.yml's worker now defaults
# to the backend's tag (digby-app-<color>) so the web boxes build it once. On
# C the per-wave tag must survive: APP_IMAGE pins the worker image to the name
# compose used to derive itself (<project>-worker) — prune_worker_images /
# prune_drainers / a parked drainer's image all keep working unchanged. Every
# compose call touching the worker below carries it (an unset APP_IMAGE would
# make `up` look for digby-app-<color>, which never exists on C).
APP_IMAGE="${NPROJ}-worker"

if [ "$NPROJ" = "$PROJ" ]; then
  # Degenerate color/project mismatch (e.g. live container is named
  # admin-worker-green but labeled project crossmodel_blue): `up` in the flip
  # project would recreate/stop the OLD container BEFORE the new one is
  # healthy, so overlap is impossible in this state. Fall back to the v2
  # in-place recreate (brief gap, runs checkpoint + get re-claimed) and say so
  # loudly — this state wants a manual one-time fix.
  echo "WARNING: live worker $WN is labeled project $PROJ, which collides with flip target $NPROJ — overlap handoff impossible; falling back to in-place recreate (brief interruption)" >&2
  BG_COLOR="$AC" BG_PORT_BACKEND="$BP" BG_PORT_FRONTEND="$FP" APP_IMAGE="${PROJ}-worker" \
    build_with_retry docker compose -p "$PROJ" -f docker-compose.app.yml build worker 2>&1 | tail -3
  BG_COLOR="$AC" BG_PORT_BACKEND="$BP" BG_PORT_FRONTEND="$FP" APP_IMAGE="${PROJ}-worker" \
    docker compose -p "$PROJ" -f docker-compose.app.yml up -d --no-deps --force-recreate worker 2>&1 | tail -3
  if ! wait_healthy "admin-worker-${AC}" "$HEALTH_TIMEOUT"; then
    echo "ERROR: recreated worker admin-worker-${AC} failed health-wait; NOT stamping" >&2
    exit 1
  fi
  boot_line "admin-worker-${AC}"
  echo "$HASH" > "$STAMP"
  echo "$now_epoch" > "$LAST_ROLLOUT_AT_FILE"
  echo "coding-worker deploy done on $(hostname)"
  exit 0
fi

OLD="admin-worker-${AC}"
echo "coding-worker handoff: $OLD -> $TARGET (project $NPROJ)"

BG_COLOR="$NC" BG_PORT_BACKEND="$NBP" BG_PORT_FRONTEND="$NFP" APP_IMAGE="$APP_IMAGE" \
  build_with_retry docker compose -p "$NPROJ" -f docker-compose.app.yml build worker 2>&1 | tail -3

# A stale STOPPED container may hold the target name (failed past attempt, or
# the pre-handoff era's other color). It is provably not running (exact-match
# detection above found only $OLD), so clearing it is safe and keeps `up`
# from tripping on a name conflict across compose projects.
prune_drainers
if container_draining "$TARGET"; then
  if [ "${WORKER_DRAIN_PARK_DISABLED:-0}" = "1" ]; then
    # Legacy: bounded wait, then interrupt (the pre-iteration-12 livelock path).
    wait_drained_or_retire "$TARGET"
  else
    # The previous same-color worker is still draining its runs — move it out
    # of the way and let it finish; never stop it for a name. The SLOT WAIT
    # (ed057f9d) runs BEFORE the park (the park is what pushes count past
    # cap): run-FREE parked drainers are evicted immediately, then a BOUNDED
    # wait for a live one to exit — only past the bound does the unchanged
    # enforce_drainer_cap fire (bounded fallback, never unbounded).
    resolve_drainer_db_url
    TARGET="$TARGET" ensure_drainer_slot
    park_drainer "$TARGET"
    enforce_drainer_cap
  fi
fi
if container_exists "$TARGET"; then
  docker rm -f "$TARGET" >/dev/null
fi
prune_worker_images "${NPROJ}-worker"
# BuildKit cache, size-bounded like boxes A/B (deploy-blue-green.sh): box C
# never pruned it and held ~35 GB (2026-10-18). Keeps the most recently used
# layers, so the next wave's build stays cached. Never blocks the deploy.
docker builder prune -f --keep-storage "${BUILDER_CACHE_KEEP:-40GB}" >/dev/null 2>&1 || true

NEW="$TARGET"  # arm the error trap — from here a stray failure removes $NEW
BG_COLOR="$NC" BG_PORT_BACKEND="$NBP" BG_PORT_FRONTEND="$NFP" APP_IMAGE="$APP_IMAGE" \
  docker compose -p "$NPROJ" -f docker-compose.app.yml up -d --no-deps worker 2>&1 | tail -3

if ! wait_healthy "$NEW" "$HEALTH_TIMEOUT"; then
  echo "ERROR: new worker $NEW failed health-wait — rolling back: $NEW removed, $OLD untouched and still serving; NOT stamping (next deploy retries)" >&2
  retire "$NEW"   # graceful, in case it claimed runs while booting
  NEW=""          # already handled — keep the exit trap quiet
  exit 1
fi
boot_line "$NEW"

# New worker is live and claiming — retire the old one. Its active runs get
# shutdown-interrupted (checkpoints retained) within the 45s grace and are
# immediately re-claimed by $NEW (interrupted rows are always claimable;
# cross-generation re-claims are attempt-compensated).
echo "retiring $OLD (drain: its active runs finish in place; no interruption)"
retire_drain "$OLD"
NEW=""  # handoff committed — the error trap must never remove the live worker

echo "$HASH" > "$STAMP"
echo "$now_epoch" > "$LAST_ROLLOUT_AT_FILE"
echo "coding-worker deploy done on $(hostname)"

# ── Sandbox egress guard (owner security fix 2026-09-24): every session/dev
#    container on this box runs model-written code on the default bridge and
#    must not reach the VPC (Redis, MCP, SSH, RDS, peers' ports) or IMDS.
#    Idempotent; installs the boot unit; non-fatal for the deploy itself.
DIGBY_VPC_CIDR="${DIGBY_VPC_CIDR:-10.60.0.0/16}" bash "$(dirname "$0")/sandbox-egress-guard.sh" --install-unit \
  || echo "coding-worker deploy: WARN sandbox egress guard failed (re-applied by the boot unit / next wave)"

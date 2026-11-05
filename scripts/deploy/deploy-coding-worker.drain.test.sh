#!/usr/bin/env bash
# deploy-coding-worker.drain.test.sh — pins the DRAIN retire (owner 2026-09-24:
# deploys used to docker-stop the old worker after 45 s, interrupting every
# running run; the owner's own turn sat "Queued" 24 min behind the churn).
# A PATH-injected `docker` shim records calls. Pins: running_workers() excludes
# a container carrying /tmp/worker-draining; retire_drain sends SIGTERM via
# `docker kill -s TERM` and never `docker stop`; the kill switch restores stop;
# wait_drained_or_retire returns once the container exits and interrupts only
# past the bound.
set -u
cd "$(dirname "$0")"
SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok: $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

cat > "$SBX/docker" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case "$1" in
  ps)
    if [[ "$*" == *"{{.Image}}"* ]]; then printf '%s\n' $USED_IMAGES; exit 0; fi
    if [[ " $* " == *" -a "* ]]; then printf '%s\n' $ALL_NAMES; else printf '%s\n' $RUNNING_NAMES; fi ;;
  images) printf '%s\n' $IMAGE_NAMES ;;
  exec)
    # docker exec <name> test -f /tmp/worker-draining → 0 when the name is in DRAINING_NAMES
    n="$2"; [[ " $DRAINING_NAMES " == *" $n "* ]] && exit 0; exit 1 ;;
  inspect) echo "45" ;;
  *) exit 0 ;;
esac
S
chmod +x "$SBX/docker"
export DOCKER_LOG="$SBX/log" ALL_NAMES="" RUNNING_NAMES="" DRAINING_NAMES="" USED_IMAGES="" IMAGE_NAMES=""
# Load only the helper functions from the script (everything before the RW= detection line).
HELPERS=$(sed -n '1,/^RW=\$(running_workers)/p' ./deploy-coding-worker.sh | sed '$d' | grep -v -E '^cd /opt/crossmodel|apply-env-overrides|^export DEPLOY_SHA|^set -euo')
# The helper block ends on a comment line — terminate it with a newline so the
# appended call is not swallowed by that comment.
HELPERS="$HELPERS"$'\n'

echo "1. running_workers() excludes a draining container"
: > "$DOCKER_LOG"
OUT=$(PATH="$SBX:$PATH" RUNNING_NAMES="admin-worker-blue admin-worker-green" DRAINING_NAMES="admin-worker-blue" bash -c "${HELPERS}running_workers")
check "only the live worker is listed" "admin-worker-green" "$OUT"

echo "2. retire_drain sends SIGTERM without stopping; the kill switch restores docker stop"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" bash -c "${HELPERS}retire_drain admin-worker-blue" >/dev/null
check "kill -s TERM sent" 1 "$(grep -c '^kill -s TERM admin-worker-blue$' "$DOCKER_LOG")"
check "no docker stop" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"
check "restart policy cleared before the signal" 1 "$(grep -c '^update --restart=no admin-worker-blue$' "$DOCKER_LOG")"
check "update precedes kill" 1 "$(grep -n '^update --restart=no\|^kill -s TERM' "$DOCKER_LOG" | head -1 | grep -c update)"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" WORKER_DRAIN_ON_DEPLOY_DISABLED=1 bash -c "${HELPERS}retire_drain admin-worker-blue" >/dev/null
check "kill switch → docker stop" 1 "$(grep -c '^stop -t 45 admin-worker-blue$' "$DOCKER_LOG")"

echo "3. wait_drained_or_retire: exited container → rm only; still draining past the bound → stop"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" RUNNING_NAMES="" bash -c "${HELPERS}wait_drained_or_retire admin-worker-blue" >/dev/null
check "not running → no stop" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"
check "not running → rm" 1 "$(grep -c '^rm admin-worker-blue$' "$DOCKER_LOG")"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" RUNNING_NAMES="admin-worker-blue" DRAINING_NAMES="admin-worker-blue" WORKER_DRAIN_WAIT_MAX_SEC=0 bash -c "${HELPERS}wait_drained_or_retire admin-worker-blue" >/dev/null
check "past the bound → docker stop" 1 "$(grep -c '^stop -t 45 admin-worker-blue$' "$DOCKER_LOG")"

echo "4. park_drainer (iteration 12): the drainer is RENAMED, never stopped"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" bash -c "${HELPERS}park_drainer admin-worker-blue" >/dev/null
check "rename issued" 1 "$(grep -c '^rename admin-worker-blue admin-worker-blue-drain-[0-9]*$' "$DOCKER_LOG")"
check "no docker stop" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"
check "no docker kill" 0 "$(grep -c '^kill ' "$DOCKER_LOG")"

echo "5. running_workers() ignores parked drainers; draining_workers() lists only them"
OUT=$(PATH="$SBX:$PATH" RUNNING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green admin-worker-blue-drain-1700000002" bash -c "${HELPERS}running_workers")
check "live worker only" "admin-worker-green" "$OUT"
OUT=$(PATH="$SBX:$PATH" RUNNING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green admin-worker-blue-drain-1700000002" bash -c "${HELPERS}draining_workers | awk '{print \$2}' | tr '\n' ' '")
check "parked drainers listed" "admin-worker-blue-drain-1700000001 admin-worker-blue-drain-1700000002 " "$OUT"

echo "6. enforce_drainer_cap: beyond WORKER_MAX_DRAINERS the OLDEST parked drainers are interrupted, the rest untouched"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" RUNNING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003" WORKER_MAX_DRAINERS=2 bash -c "${HELPERS}enforce_drainer_cap" >/dev/null
check "exactly one stop" 1 "$(grep -c '^stop ' "$DOCKER_LOG")"
check "the oldest is the one stopped" 1 "$(grep -c '^stop -t 45 admin-worker-blue-drain-1700000001$' "$DOCKER_LOG")"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" RUNNING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green" WORKER_MAX_DRAINERS=4 bash -c "${HELPERS}enforce_drainer_cap" >/dev/null
check "under the cap → nothing stopped" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"

echo "7. prune_drainers: exited parked drainers are removed with their image; the live worker is never touched"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" ALL_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green admin-worker-blue" RUNNING_NAMES="admin-worker-green" bash -c "${HELPERS}prune_drainers" >/dev/null
check "exited drainer removed" 1 "$(grep -c '^rm admin-worker-blue-drain-1700000001$' "$DOCKER_LOG")"
check "live worker untouched" 0 "$(grep -c '^rm admin-worker-green$' "$DOCKER_LOG")"
check "plain-named container untouched" 0 "$(grep -c '^rm admin-worker-blue$' "$DOCKER_LOG")"
check "image removal attempted" 1 "$(grep -c '^image rm ' "$DOCKER_LOG")"

echo "8. flip path: per-wave project + park; the kill switch restores the wait path"
FLIP=$(sed -n '/^NC=blue; NBP=4001; NFP=8248$/,/^NEW="\$TARGET"/p' ./deploy-coding-worker.sh | sed '$d')
: > "$DOCKER_LOG"
OUT=$(cd "$SBX" && PATH="$SBX:$PATH" AC=green BP=4002 FP=8249 PROJ=crossmodel_green WN=admin-worker-green RUNNING_NAMES="admin-worker-green admin-worker-blue" ALL_NAMES="admin-worker-green admin-worker-blue" DRAINING_NAMES="admin-worker-blue" bash -c "${HELPERS}${FLIP}"$'\n''echo NPROJ=$NPROJ' 2>&1)
check "fresh per-wave project name" 1 "$(printf '%s\n' "$OUT" | grep -c '^NPROJ=crossmodel_blue_[0-9]*$')"
check "draining target parked" 1 "$(grep -c '^rename admin-worker-blue admin-worker-blue-drain-' "$DOCKER_LOG")"
check "target never stopped" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"
: > "$DOCKER_LOG"
OUT=$(cd "$SBX" && PATH="$SBX:$PATH" WORKER_DRAIN_PARK_DISABLED=1 WORKER_DRAIN_WAIT_MAX_SEC=0 AC=green BP=4002 FP=8249 PROJ=crossmodel_green WN=admin-worker-green RUNNING_NAMES="admin-worker-green admin-worker-blue" ALL_NAMES="admin-worker-green admin-worker-blue" DRAINING_NAMES="admin-worker-blue" bash -c "${HELPERS}${FLIP}"$'\n''echo NPROJ=$NPROJ' 2>&1)
check "kill switch → legacy project name" 1 "$(printf '%s\n' "$OUT" | grep -c '^NPROJ=crossmodel_blue$')"
check "kill switch → wait path stops past the bound" 1 "$(grep -c '^stop -t 45 admin-worker-blue$' "$DOCKER_LOG")"

echo "9. prune_worker_images (iteration 13): unreferenced per-wave + legacy worker images go; referenced ones and this wave's build stay"
: > "$DOCKER_LOG"
PATH="$SBX:$PATH" IMAGE_NAMES="crossmodel_green_1790326170-worker:latest crossmodel_blue-worker:latest crossmodel_green-worker:latest crossmodel_blue_1790400000-worker:latest digby-app-blue:latest" USED_IMAGES="crossmodel_green_1790326170-worker digby-app-blue" bash -c "${HELPERS}prune_worker_images crossmodel_blue_1790400000-worker" >/dev/null
check "legacy blue tag pruned" 1 "$(grep -c '^image rm crossmodel_blue-worker:latest$' "$DOCKER_LOG")"
check "legacy green tag pruned" 1 "$(grep -c '^image rm crossmodel_green-worker:latest$' "$DOCKER_LOG")"
check "live worker's image kept" 0 "$(grep -c '^image rm crossmodel_green_1790326170-worker' "$DOCKER_LOG")"
check "this wave's build kept" 0 "$(grep -c '^image rm crossmodel_blue_1790400000-worker' "$DOCKER_LOG")"
check "non-worker images never touched" 0 "$(grep -c '^image rm digby-app' "$DOCKER_LOG")"
check "exactly two removals" 2 "$(grep -c '^image rm ' "$DOCKER_LOG")"

# ── Ticket ed057f9d (2026-10-16): drainer-slot WAIT + rollout WINDOW ────────
# The docker shim needs three more verbs for the new probes:
#   inspect -f {{.Id}} <name>       → stable container id (12 hex, rename-safe)
#   logs --tail 200 <name>          → DRAINER_LOGS_<slug> (worker.ts drain line)
#   run --rm --network host pgvector/pgvector:pg16 psql <url> -t -A ... -c <sql>
#                                    → DRAINER_DB_COUNT (or fail → log fallback)
# and `exec <name> sh -c 'printf %s "$DATABASE_URL"'` for resolve_drainer_db_url.
drain_slug(){ printf '%s' "$1" | tr -c 'a-zA-Z0-9' '_'; }
export -f drain_slug
cat > "$SBX/docker" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case "$1" in
  ps)
    if [[ "$*" == *"{{.Image}}"* ]]; then printf '%s\n' $USED_IMAGES; exit 0; fi
    if [[ " $* " == *" -a "* ]]; then printf '%s\n' $ALL_NAMES; else
      # running = RUNNING_NAMES minus what a previous stop/rm retired
      # (file-based: each docker call is its own process, env won't flow back)
      for n in $RUNNING_NAMES; do
        grep -qxF "$n" "$STOPPED_FILE" 2>/dev/null || echo "$n"
      done
      exit 0; fi ;;
  images) printf '%s\n' $IMAGE_NAMES ;;
  exec)
    n="$2"
    if [ "$3" = "test" ]; then [[ " $DRAINING_NAMES " == *" $n "* ]] && exit 0; exit 1; fi
    if [ "$3" = "sh" ]; then printf 'postgres://test-db'; exit 0; fi
    exit 0 ;;
  inspect)
    if [ "$2" = "-f" ] && [ "$3" = "{{.Id}}" ]; then
      # stable per-name pseudo-id (rename does NOT change it in real docker)
      case "$4" in *drain-*) printf '%s\n' "$(echo "$4" | sed -E 's/-drain-[0-9]+$//; s/admin-worker-//')aaaaaaaaa01" ;; *) echo "bbbbbbbbbbbb01" ;; esac; exit 0; fi
    if [ "$2" = "-f" ]; then echo "45"; exit 0; fi
    echo "45" ;;
  stop|rm)
    # record the retired container so the next `docker ps` in the SAME loop
    # observes the slot freed (prune_drainers / ensure_drainer_slot recount)
    n="$2"; [ "$1" = "stop" ] && n="$3"
    if [ -n "$n" ]; then printf '%s\n' "$n" >> "$STOPPED_FILE"; fi
    exit 0 ;;
  logs)
    # name position varies: `docker logs --tail 200 <name>` vs `docker logs <c> --tail 500`
    n="$2"; [ "$2" = "--tail" ] && n="$4"
    eval "printf '%s\n' \"\${DRAINER_LOG_$(drain_slug "$n"):-}\""; exit 0 ;;
  run)
    # --network host is REQUIRED: the sandbox egress guard rejects the default
    # bridge → the db leg fails → the log fallback engages (pinned in test 11).
    if [[ "$*" == *"--network host"* && "$*" == *"agent_runs"* ]]; then
      if [ -n "${DRAINER_DB_FAIL:-}" ]; then exit 1; fi
      echo "${DRAINER_DB_COUNT:-3}"; exit 0
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
S
export DRAINER_DB_URL="" DRAINER_DB_COUNT="" DRAINER_DB_FAIL=""
: > "$SBX/stopped"; export STOPPED_FILE="$SBX/stopped"

echo "10. ensure_drainer_slot (ed057f9d): run-FREE parked drainer evicted immediately; a live one NEVER stopped before the bound"
: > "$DOCKER_LOG"
# 4 parked drainers (cap full), oldest run-FREE → evicted now, no wait, no sleep
OUT=$(PATH="$SBX:$PATH" DRAINER_DB_URL="postgres://test-db" DRAINER_DB_COUNT=0 WORKER_MAX_DRAINERS=4 \
  RUNNING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004 admin-worker-green" \
  DRAINING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004" \
  TARGET=admin-worker-blue WORKER_DRAIN_SLOT_POLL_SEC=5 \
  bash -c "${HELPERS}ensure_drainer_slot" 2>&1)
check "run-free oldest evicted immediately" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: evicted-run-free admin-worker-blue-drain-1700000001')"
check "eviction retires (stops) it" 1 "$(grep -c '^stop -t 45 admin-worker-blue-drain-1700000001$' "$DOCKER_LOG")"
check "no wait started" 0 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: wait-start')"
check "no timeout fallback" 0 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: timeout')"

echo "11. ensure_drainer_slot: live drainers → BOUNDED wait, never an unbounded hang; probe failure → log fallback then unknown-as-live"
: > "$DOCKER_LOG"; : > "$STOPPED_FILE"
# All 4 parked, ALL live (db says 7); TARGET draining (real flip shape) →
# wait loop with poll markers, then the bounded timeout falls back to
# enforce_drainer_cap (the wave never hangs).
OUT=$(PATH="$SBX:$PATH" DRAINER_DB_URL="postgres://test-db" DRAINER_DB_COUNT=7 WORKER_MAX_DRAINERS=4 \
  WORKER_DRAIN_SLOT_WAIT_MAX_SEC=10 WORKER_DRAIN_SLOT_POLL_SEC=5 \
  RUNNING_NAMES="admin-worker-blue admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004" \
  DRAINING_NAMES="admin-worker-blue admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004" \
  TARGET=admin-worker-blue \
  bash -c "${HELPERS}ensure_drainer_slot" 2>&1)
check "wait started with live-run count" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: wait-start parked=4 cap=4 oldest=admin-worker-blue-drain-1700000001 oldest_live_runs=7')"
check "no live drainer stopped during the wait" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"
check "poll marker emitted" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: poll waited=5')"
check "bounded timeout reached, fallback named" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: timeout waited=10')"
# db leg fails (no --network host / psql down) → log fallback leg greps the
# worker's own drain line; both fail → unknown, treated as LIVE (wait, never evict)
: > "$DOCKER_LOG"; : > "$STOPPED_FILE"
# oldest (alphabetical by name) is blue-drain-1700000003 — the drain log line
# env var must sit on the drainer the probe actually reads
export DRAINER_LOG_admin_worker_blue_drain_1700000003="coding worker worker-x: draining — 5 run(s) still active after 60s"
OUT=$(PATH="$SBX:$PATH" DRAINER_DB_URL="" DRAINER_DB_FAIL=1 WORKER_MAX_DRAINERS=4 \
  WORKER_DRAIN_SLOT_WAIT_MAX_SEC=5 WORKER_DRAIN_SLOT_POLL_SEC=5 \
  RUNNING_NAMES="admin-worker-blue admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004 admin-worker-blue-drain-1700000005" \
  DRAINING_NAMES="admin-worker-blue admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004 admin-worker-blue-drain-1700000005" \
  TARGET=admin-worker-blue \
  bash -c "${HELPERS}ensure_drainer_slot" 2>&1)
check "db down → log leg found live runs (5)" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: wait-start.*oldest_live_runs=5 source=logs')"
check "log-leg live drainer never stopped" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"
# BOTH legs fail → probe=unknown, treated as live, waited (no blind eviction).
# WAIT_MAX=5/POLL=5 → round 1 warns + polls; round 2 hits the budget check
# FIRST (it runs before the probe) → exactly one probe=unknown warning.
: > "$DOCKER_LOG"; : > "$STOPPED_FILE"
export DRAINER_LOG_admin_worker_blue_drain_1700000003=""
OUT=$(PATH="$SBX:$PATH" DRAINER_DB_URL="" DRAINER_DB_FAIL=1 WORKER_MAX_DRAINERS=4 \
  WORKER_DRAIN_SLOT_WAIT_MAX_SEC=5 WORKER_DRAIN_SLOT_POLL_SEC=5 \
  RUNNING_NAMES="admin-worker-blue admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004 admin-worker-blue-drain-1700000005" \
  DRAINING_NAMES="admin-worker-blue admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004 admin-worker-blue-drain-1700000005" \
  TARGET=admin-worker-blue \
  bash -c "${HELPERS}ensure_drainer_slot" 2>&1)
check "both probes fail → probe=unknown warning" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: probe=unknown')"
check "unknown-as-live → NOT evicted before the bound" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"

echo "12. ensure_drainer_slot: slot frees mid-wait (drainer exits) → returns without stopping anything"
: > "$DOCKER_LOG"; : > "$STOPPED_FILE"
# poll 1: full, live → sleep; the harness then drops one drainer from RUNNING
# before poll 2: prune frees the slot and the wait returns.
OUT=$(PATH="$SBX:$PATH" DRAINER_DB_URL="postgres://test-db" DRAINER_DB_COUNT=2 WORKER_MAX_DRAINERS=4 \
  WORKER_DRAIN_SLOT_WAIT_MAX_SEC=60 WORKER_DRAIN_SLOT_POLL_SEC=5 \
  RUNNING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004 admin-worker-green" \
  DRAINING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004" \
  TARGET=admin-worker-blue \
  bash -c "${HELPERS}
sleep() { RUNNING_NAMES=\"admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004 admin-worker-green\"; DRAINING_NAMES=\"admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004\"; }
ensure_drainer_slot" 2>&1)
check "wait started" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: wait-start')"
check "freed by exit — nothing stopped" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"
check "no timeout" 0 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: timeout')"

echo "13. ensure_drainer_slot: kill switch restores today's path (park + cap eviction with no wait)"
: > "$DOCKER_LOG"; : > "$STOPPED_FILE"
OUT=$(PATH="$SBX:$PATH" DRAINER_DB_URL="postgres://test-db" DRAINER_DB_COUNT=7 WORKER_MAX_DRAINERS=4 WORKER_DRAIN_SLOT_WAIT_DISABLED=1 \
  RUNNING_NAMES="admin-worker-blue-drain-1700000001 admin-worker-green" DRAINING_NAMES="admin-worker-blue-drain-1700000001" \
  TARGET=admin-worker-blue bash -c "${HELPERS}ensure_drainer_slot" 2>&1)
check "kill switch → disabled marker" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: disabled (kill switch)')"
check "kill switch → no wait/evict/probe markers" 0 "$(printf '%s\n' "$OUT" | grep -cE 'drainer-slot: (wait-start|poll|timeout|evicted-run-free|probe=unknown)')"
check "kill switch → nothing stopped by the gate itself" 0 "$(grep -c '^stop ' "$DOCKER_LOG")"

echo "14. rollout window (ed057f9d): young last rollout → DEFER (no stamp, pending markers written); kill switch + no-live-worker bypass; stale pending → FORCED rollout"
W=$SBX/window; mkdir -p "$W"
NOW=1792185000
echo $((NOW-100)) > $W/last.at   # last rollout 100 s ago (< 1800)
# (a) young last rollout → deferred
: > "$DOCKER_LOG"
OUT=$(PATH="$SBX:$PATH" LAST_ROLLOUT_AT_FILE=$W/last.at PENDING_HASH_FILE=$W/pending.hash PENDING_AT_FILE=$W/pending.at \
  ROLLOUT_NOW_EPOCH=$NOW WORKER_ROLLOUT_MIN_INTERVAL_SEC=1800 \
  bash -c "${HELPERS}rollout_window_deferred deadbeef1234 1" 2>&1); rc=$?
check "young rollout → deferred marker" 1 "$(printf '%s\n' "$OUT" | grep -c '^worker-rollout-window: deferred hash=deadbeef1234 last_rollout_age=100s')"
check "deferred branch rc=0" 0 "$rc"
check "pending hash recorded" "deadbeef1234" "$(cat $W/pending.hash)"
check "pending age stamped (NOW)" "$NOW" "$(cat $W/pending.at 2>/dev/null || echo missing)"
# — the exit code check above is brittle across subshells; verify by rc
PATH="$SBX:$PATH" LAST_ROLLOUT_AT_FILE=$W/last.at PENDING_HASH_FILE=$W/pending.hash PENDING_AT_FILE=$W/pending.at \
  ROLLOUT_NOW_EPOCH=$NOW WORKER_ROLLOUT_MIN_INTERVAL_SEC=1800 bash -c "${HELPERS}rollout_window_deferred deadbeef5678 1" >/dev/null 2>&1
check "deferred branch rc=0" 0 "$?"
# (b) same pending hash aged past MAX_STALE → FORCED (no deferral) — a burst
# of waves can never keep last-rollout-age young and strand the change
echo $((NOW - 8000)) > $W/pending.at
OUT=$(PATH="$SBX:$PATH" LAST_ROLLOUT_AT_FILE=$W/last.at PENDING_HASH_FILE=$W/pending.hash PENDING_AT_FILE=$W/pending.at \
  ROLLOUT_NOW_EPOCH=$NOW WORKER_ROLLOUT_MIN_INTERVAL_SEC=1800 WORKER_ROLLOUT_MAX_STALE_SEC=7200 \
  bash -c "${HELPERS}rollout_window_deferred deadbeef5678 1" 2>&1); rc=$?
check "aged pending → forced rollout marker" 1 "$(printf '%s\n' "$OUT" | grep -c '^worker-rollout-window: forced hash=deadbeef5678 pending_age=8000s')"
check "forced → rc=1 (roll out now)" 1 "$rc"
# (c) different pending hash (newer change) → .at refreshed to first-seen NOW
echo $((NOW - 8000)) > $W/pending.at
echo "cafe0000abcd" > $W/pending.hash
PATH="$SBX:$PATH" LAST_ROLLOUT_AT_FILE=$W/last.at PENDING_HASH_FILE=$W/pending.hash PENDING_AT_FILE=$W/pending.at \
  ROLLOUT_NOW_EPOCH=$NOW WORKER_ROLLOUT_MIN_INTERVAL_SEC=1800 bash -c "${HELPERS}rollout_window_deferred deadbeef5678 1" >/dev/null 2>&1
check "newer hash → pending.age refreshed" "$NOW" "$(cat $W/pending.at)"
check "newer hash → pending.hash replaced" "deadbeef5678" "$(cat $W/pending.hash)"
# (d) kill switch → never defer
OUT=$(PATH="$SBX:$PATH" LAST_ROLLOUT_AT_FILE=$W/last.at PENDING_HASH_FILE=$W/pending.hash PENDING_AT_FILE=$W/pending.at \
  ROLLOUT_NOW_EPOCH=$NOW WORKER_ROLLOUT_WINDOW_DISABLED=1 bash -c "${HELPERS}rollout_window_deferred deadbeef5678 1" 2>&1); rc=$?
check "kill switch → disabled marker" 1 "$(printf '%s\n' "$OUT" | grep -c '^worker-rollout-window: disabled')"
check "kill switch → rc=1 (roll out)" 1 "$rc"
# (e) no live worker → never defer (never leave the box workerless)
echo $((NOW-100)) > $W/last.at
OUT=$(PATH="$SBX:$PATH" LAST_ROLLOUT_AT_FILE=$W/last.at PENDING_HASH_FILE=$W/pending.hash PENDING_AT_FILE=$W/pending.at \
  ROLLOUT_NOW_EPOCH=$NOW bash -c "${HELPERS}rollout_window_deferred deadbeef5678 0" 2>&1); rc=$?
check "no live worker → bypass marker" 1 "$(printf '%s\n' "$OUT" | grep -c '^worker-rollout-window: bypass no-live-worker')"
check "no live worker → rc=1 (roll out)" 1 "$rc"
# (f) last rollout older than the window → roll out (no marker noise)
echo $((NOW - 3600)) > $W/last.at
OUT=$(PATH="$SBX:$PATH" LAST_ROLLOUT_AT_FILE=$W/last.at PENDING_HASH_FILE=$W/pending.hash PENDING_AT_FILE=$W/pending.at \
  ROLLOUT_NOW_EPOCH=$NOW bash -c "${HELPERS}rollout_window_deferred deadbeef5678 1" 2>&1); rc=$?
check "outside window → rc=1, silent" 1 "$rc"
check "outside window → no marker" 0 "$(printf '%s\n' "$OUT" | grep -c 'worker-rollout-window:')"
# (g) unparsable env → the numeric default (int_env), never a crashed wave
rm -f $W/pending.hash $W/pending.at; echo $((NOW-100)) > $W/last.at
OUT=$(PATH="$SBX:$PATH" LAST_ROLLOUT_AT_FILE=$W/last.at PENDING_HASH_FILE=$W/pending.hash PENDING_AT_FILE=$W/pending.at \
  ROLLOUT_NOW_EPOCH=$NOW WORKER_ROLLOUT_MIN_INTERVAL_SEC="not-a-number" \
  bash -c "${HELPERS}rollout_window_deferred deadbeef5678 1" 2>&1); rc=$?
check "garbage MIN_INTERVAL → default 1800 applied (age 100 < 1800 → defer)" 0 "$rc"

echo "15. flip path integrates the slot wait: park happens AFTER a slot is free; the park itself never stops anything (regression of test 8's shape)"
FLIP=$(sed -n '/^NC=blue; NBP=4001; NFP=8248$/,/^NEW="\$TARGET"/p' ./deploy-coding-worker.sh | sed '$d')
: > "$DOCKER_LOG"; : > "$STOPPED_FILE"
OUT=$(cd "$SBX" && PATH="$SBX:$PATH" DRAINER_DB_URL="postgres://test-db" DRAINER_DB_COUNT=7 \
  AC=green BP=4002 FP=8249 PROJ=crossmodel_green WN=admin-worker-green \
  RUNNING_NAMES="admin-worker-green admin-worker-blue admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004" \
  ALL_NAMES="" \
  DRAINING_NAMES="admin-worker-blue admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004" \
  WORKER_MAX_DRAINERS=4 WORKER_DRAIN_SLOT_WAIT_MAX_SEC=0 \
  bash -c "${HELPERS}${FLIP}"$'\n''echo NPROJ=$NPROJ' 2>&1)
check "slot wait ran before the park (timeout path, bounded)" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: timeout waited=0')"
check "target still parked despite full pool (bounded fallback)" 1 "$(grep -c '^rename admin-worker-blue admin-worker-blue-drain-' "$DOCKER_LOG")"
check "the park stopped nothing" 0 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: evicted-run-free')"

echo "16. ensure_drainer_slot (review M1, ed057f9d): a FAILING docker stop (wedged task / daemon error) can never hot-spin — every iteration burns wait budget, the bound still ends the loop"
# Shim with file-based state EXCEPT stop/rm, which fail and leave the
# drainer in `ps` forever (the production failure shape).
cat > "$SBX/docker-m1" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case "$1" in
  ps)
    if [[ "$*" == *"{{.Image}}"* ]]; then printf '%s\n' $USED_IMAGES; exit 0; fi
    if [[ " $* " == *" -a "* ]]; then printf '%s\n' $ALL_NAMES; else
      for n in $RUNNING_NAMES; do grep -qxF "$n" "$STOPPED_FILE" 2>/dev/null || echo "$n"; done
      exit 0; fi ;;
  exec)
    n="$2"
    if [ "$3" = "test" ]; then [[ " $DRAINING_NAMES " == *" $n "* ]] && exit 0; exit 1; fi
    if [ "$3" = "sh" ]; then printf 'postgres://test-db'; exit 0; fi
    exit 0 ;;
  inspect)
    if [ "$2" = "-f" ] && [ "$3" = "{{.Id}}" ]; then echo "aaaaaaaaaabb"; exit 0; fi
    echo "45" ;;
  stop|rm) exit 1 ;;   # WEDGED docker: stop/rm fail, the container never leaves ps
  logs) exit 0 ;;
  run) exit 1 ;;
  *) exit 0 ;;
esac
S
chmod +x "$SBX/docker-m1"
: > "$DOCKER_LOG"; : > "$STOPPED_FILE"
OUT=$(PATH="$SBX:$PATH" DRAINER_DB_URL="" DRAINER_DB_FAIL=1 WORKER_MAX_DRAINERS=4 \
  WORKER_DRAIN_SLOT_WAIT_MAX_SEC=10 WORKER_DRAIN_SLOT_POLL_SEC=5 \
  RUNNING_NAMES="admin-worker-blue admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004" \
  DRAINING_NAMES="admin-worker-blue admin-worker-blue-drain-1700000001 admin-worker-green-drain-1700000002 admin-worker-blue-drain-1700000003 admin-worker-green-drain-1700000004" \
  TARGET=admin-worker-blue \
  timeout 60 bash -c "${HELPERS}ensure_drainer_slot" 2>&1); rc=$?
check "wedged stop → loop still returns (no hang)" 0 "$rc"
check "wedged stop → bounded timeout fired" 1 "$(printf '%s\n' "$OUT" | grep -c 'drainer-slot: timeout waited=10')"
# the wait branch (unknown-as-live) sleeps every round — a wedged-stop case on
# the EVICT branch must not spin without bound either: rounds are budgeted.
n_evict=$(printf '%s\n' "$OUT" | grep -c 'evicted-run-free')
check "wedged stop → eviction attempts bounded (≤ wait/poll rounds + 1)" 1 "$([ "$n_evict" -le 3 ] && echo 1 || echo 0)"

echo; echo "passed=$PASS failed=$FAIL"; [ "$FAIL" = 0 ]

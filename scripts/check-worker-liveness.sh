#!/bin/bash
# check-worker-liveness.sh — runs ON the app box (invoked via ssh 'bash -s').
#
# Verdict on whether THIS box's coding-session worker can claim agent runs:
#   OK ...      exit 0 — worker healthy (or intentionally off with no fresh work)
#   DOWN ...    exit 1 — runs need claiming and nothing is claiming them (act!)
#   UNKNOWN ... exit 2 — couldn't tell (caller must NOT treat this as down)
#
# Why this exists: 2026-07-30/31 — the ca-central-1 cutover's "worker handoff"
# stopped this box's worker while DNS still pointed at it; every coding run sat
# unclaimed for ~21h while the HTTP-only deploy-healthcheck stayed green the
# whole time. This probe checks the thing users actually feel: can queued /
# interrupted agent runs get claimed RIGHT NOW?
#
# Read-only: docker inspect + one psql count query. No mutations.
set -uo pipefail

cd /opt/crossmodel 2>/dev/null || { echo "UNKNOWN repo-missing (/opt/crossmodel)"; exit 2; }

# ── Intended state ────────────────────────────────────────────────────────────
# deploy-blue-green.sh sources the same flag file (defaults = single-box: true).
ENABLE_WORKER=true
[ -f /opt/crossmodel-local/deploy-flags.env ] && . /opt/crossmodel-local/deploy-flags.env
AC=$(cat .active-color 2>/dev/null || echo blue)
WORKER="admin-worker-${AC}"

# ── Container + docker-level health ───────────────────────────────────────────
# The worker compose service has a healthcheck (touches /tmp/worker-alive every
# 2s tick; unhealthy if mtime >15s stale) — so "running unhealthy" == wedged
# process, which Docker alone will never restart (restart: unless-stopped only
# acts on exit).
# NOTE on < /dev/null + sudo -n everywhere: this script is delivered via
# ssh 'bash -s', i.e. bash READS THE SCRIPT FROM STDIN incrementally. Any
# command here that consumes stdin (docker exec -i forwarding the pipe, sudo
# prompting) would eat the unread remainder of the script — bash then hits EOF
# and exits 0 without ever printing a verdict (review finding, 2026-07-31).
CSTATE=$(sudo -n docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}nohealthcheck{{end}}' "$WORKER" 2>/dev/null < /dev/null || echo "missing")

# ── Run-queue state (single query; on failure → UNKNOWN, never guess) ─────────
# Live store = the backend container's OWN DATABASE_URL (RDS since the
# 2026-07-31 cutover). NEVER query the on-box admin-postgres-prod: it is
# RETIRED (stopped 2026-08-19, restart=no) — stopped made this probe report
# UNKNOWN forever (worker gate dark), and when it was left running it served a
# frozen 2026-08-01 snapshot whose 0-activity gate reported false-OK. This
# probe was the last holdout still reading it (pre-cutover leftover); the
# RDS-aware pattern below matches scripts/ec2-ops/diagnostics.sh.
# fresh_running : 'running' rows with a live heartbeat (worker beats every 150s;
#                 lease 6min) — >0 proves a worker is actively working.
# interrupted   : unconditionally claimable — only piles up when no worker ticks.
# old_queued    : claimable for >20min — safe from busy-slot false positives when
#                 combined with fresh_running=0 (busy slots => fresh heartbeats).
# activity_6h   : rows created in the last 6h = "is this DB receiving run
#                 traffic at all". The LIVENESS GATE below: no recent activity
#                 means the box is idle (zero user impact — the next queued run
#                 reopens the window and alerts within 15min) or RETIRED/frozen
#                 mid-migration (2026-07-31: the old prod box's DB froze when
#                 the fleet's data moved to ca-central-1; its interrupted/queued
#                 residue must NOT alarm forever).
# psql via an ephemeral pgvector container (the image diagnostics.sh uses,
# already pulled on the boxes). -c needs no stdin — no -i (see the bash -s
# note above; -i would let the docker CLI forward/eat the script's own
# stdin). sudo -n: fail fast, never prompt. < /dev/null everywhere.
BE_URL="$(sudo -n docker exec "admin-backend-${AC}" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null < /dev/null || true)"
if [ -z "$BE_URL" ]; then
  OTHER=$([ "$AC" = "blue" ] && echo green || echo blue)
  BE_URL="$(sudo -n docker exec "admin-backend-${OTHER}" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null < /dev/null || true)"
fi
COUNTS=""
if [ -n "$BE_URL" ]; then
  COUNTS=$(sudo -n docker run --rm pgvector/pgvector:pg16 psql "$BE_URL" -t -A -F' ' --no-psqlrc -c "
SELECT
  (SELECT count(*) FROM agent_runs WHERE status='running' AND \"heartbeatAt\" > now() - interval '6 minutes'),
  (SELECT count(*) FROM agent_runs WHERE status='interrupted'),
  (SELECT count(*) FROM agent_runs WHERE status='queued' AND (\"leaseExpiresAt\" IS NULL OR \"leaseExpiresAt\" < now()) AND \"createdAt\" < now() - interval '20 minutes'),
  (SELECT count(*) FROM agent_runs WHERE \"createdAt\" > now() - interval '6 hours');
" 2>/dev/null < /dev/null)
fi
if [ -z "$COUNTS" ]; then
  echo "UNKNOWN db-unreachable container=[$CSTATE] flag=$ENABLE_WORKER"
  exit 2
fi
read -r FRESH_RUN INTERRUPTED OLD_QUEUED ACTIVITY_6H <<<"$COUNTS"
echo "state: flag=$ENABLE_WORKER color=$AC container=[$CSTATE] fresh_running=$FRESH_RUN interrupted=$INTERRUPTED old_queued=$OLD_QUEUED activity_6h=$ACTIVITY_6H"
UNCLAIMED=$(( INTERRUPTED + OLD_QUEUED ))

if [ "$ACTIVITY_6H" = "0" ]; then
  echo "OK no run activity in 6h — box idle or DB inactive/retired (container=$CSTATE, flag=$ENABLE_WORKER, residue: interrupted=$INTERRUPTED old_queued=$OLD_QUEUED)"
  exit 0
fi

if [ "$ENABLE_WORKER" = "true" ]; then
  case "$CSTATE" in
    "running healthy"|"running nohealthcheck")
      # Container alive — but is it actually claiming? (covers worker running
      # against the wrong DB, claim loop deadlocked, etc.)
      if [ "$FRESH_RUN" = "0" ] && [ "$UNCLAIMED" -gt 0 ]; then
        echo "DOWN worker-alive-but-not-claiming (fresh_running=0, unclaimed=$UNCLAIMED)"
        exit 1
      fi
      echo "OK worker running (container=$CSTATE, fresh_running=$FRESH_RUN, unclaimed=$UNCLAIMED)"
      exit 0
      ;;
    "running unhealthy")
      echo "DOWN worker-wedged (container running but compose healthcheck failing)"
      exit 1
      ;;
    *)
      echo "DOWN worker-not-running (container=$CSTATE)"
      exit 1
      ;;
  esac
fi

# ENABLE_WORKER=false — intentional on stateless fleet boxes (worker lives on the
# primary). Reaching here means the DB IS receiving fresh run work (activity gate
# above), so a flag-disabled box with live traffic is the 2026-07-31 incident
# signature (handoff ran before the DNS flip). A RUNNING worker with a stale
# flag=false is healthy (that's the state right after the healthcheck's own
# restart arm recovers an incident) — flag reconciliation is a human/runbook
# action, not a reason to churn redeploys.
case "$CSTATE" in
  "running healthy"|"running nohealthcheck")
    if [ "$FRESH_RUN" = "0" ] && [ "$UNCLAIMED" -gt 0 ]; then
      echo "DOWN worker-disabled-but-live-traffic and not claiming (flag=false, container=$CSTATE, fresh_running=0, unclaimed=$UNCLAIMED)"
      exit 1
    fi
    echo "OK worker running despite flag=false (STALE FLAG — set ENABLE_WORKER=true in /opt/crossmodel-local/deploy-flags.env or the next deploy stops it; fresh_running=$FRESH_RUN, unclaimed=$UNCLAIMED)"
    exit 0
    ;;
  *)
    echo "DOWN worker-disabled-but-live-traffic (flag=false, container=$CSTATE, activity_6h=$ACTIVITY_6H) — this box is still serving live run traffic; restart the worker or finish the cutover (DNS flip + repoint the healthcheck's EC2_HOST secret)"
    exit 1
    ;;
esac

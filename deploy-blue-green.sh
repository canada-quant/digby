#!/bin/bash
# deploy-blue-green.sh — Zero-downtime blue-green deployment for CrossModel
# Architecture: one color pair (blue/green) per host. deploy.yml runs this
# script on each web host in EC2_HOSTS (A, then B). The coding box is a
# separate deploy.yml step (scripts/ec2-ops/extra-hosts → deploy-coding-worker.sh).
# Shared services (redis, adminer, MCPs, STT) run continuously. Postgres in
# docker-compose.base.yml starts only when RUN_POSTGRES_BASE=true; production
# app data lives in RDS.
# Nginx upstream switch provides instant traffic cutover
#
# Usage: ./deploy-blue-green.sh
#
# ── Deploy-speed switches (2026-09-26 wave anatomy, deploy_speedups #1/#2/#5/#6/#8)
# All are RUNNER env — repo Variables forwarded by deploy.yml's blue-green step
# (`gh variable set NAME --body VALUE`); unset = the default named here. Pinned
# by scripts/deploy/blue-green-speedups.test.sh; documented in docs/REMOTE_OPS.md.
#   BUILDER_CACHE_KEEP=40GB           #1 BuildKit cache kept by the post-build prune
#                                        (was 10GB — one wave writes ~10-12 GB, so the
#                                        previous wave's layers were evicted every time
#                                        and every build ran from scratch). Any docker
#                                        size string; 10GB restores the old eviction.
#   BUILDER_PRUNE_ONCE_DISABLED=1     #8 re-adds the second (end-of-deploy) builder
#                                        prune; default = ONE prune per box, post-build.
#   DRAIN_SECONDS=10                  #8 SSE-grace floor before /drain-status polling
#                                        (was 60; the poll already exits at 0 runs).
#                                        DRAIN_SECONDS=60 restores the old floor.
#   WORKER_IMAGE_SHARED_DISABLED=1    #5 build the worker image separately again
#                                        (default: `compose build backend frontend` —
#                                        the worker runs the backend image, like relay).
#   BACKEND_CHOWN_RECURSIVE=1         #2 restore `chown -R nodejs:nodejs /app` in
#                                        backend/Dockerfile (compose build arg; can
#                                        also be set in the box .env).
#   FRONTEND_CONTENT_BUST=1           #6 DEFAULT OFF — bust the frontend build on the
#                                        sha256 of frontend/ (scripts/deploy/
#                                        frontend-bust-key.sh) instead of the commit
#                                        sha; DEPLOY_SHA stays the runtime env.
#   (PREBUILD_STATELESS=1 — #3, DEFAULT OFF — lives in deploy.yml: the runner
#    pre-builds the stateless boxes' images in the background while host 1
#    deploys; scripts/deploy/prebuild-inactive.sh. PREBUILD_STATELESS_DISABLED=1
#    is its kill switch.)

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
COMPOSE_DIR="/opt/crossmodel"
BASE_COMPOSE="${COMPOSE_DIR}/docker-compose.base.yml"
APP_COMPOSE="${COMPOSE_DIR}/docker-compose.app.yml"
ACTIVE_COLOR_FILE="${COMPOSE_DIR}/.active-color"
UPSTREAM_CONF="/etc/nginx/upstream-active.conf"
# Floor: how long to keep old containers alive after switch (SSE grace).
# 2026-09-26 (deploy_speedups #8): 60 → 10. The floor was unconditional — 4/10
# A-drains and 2/10 B-drains ended at exactly 60 s with 0 runs, i.e. the whole
# minute was the sleep. The app-observed poll below already exits the moment
# /drain-status reports 0 chat runs; 10 s keeps the SSE reconnect grace. A
# non-numeric value falls back to 10 (a bad Variable must not break a
# post-commit drain under set -e).
DRAIN_SECONDS="${DRAIN_SECONDS:-10}"
case "$DRAIN_SECONDS" in ''|*[!0-9]*) DRAIN_SECONDS=10 ;; esac
# deploy_speedups #1 (2026-09-26): BuildKit cache retained by the post-build
# prune. See the prune site below for the measured eviction story.
BUILDER_CACHE_KEEP="${BUILDER_CACHE_KEEP:-40GB}"
[ -n "$BUILDER_CACHE_KEEP" ] || BUILDER_CACHE_KEEP=40GB
# Upper bound of the app-observed drain (feedback 56159c5a): after the floor,
# the OLD backend's /drain-status is polled until its in-flight chat runs hit
# 0 — the old fixed 60s sleep killed mid-answer chat turns several times a day.
# Never FATAL: on timeout/unreadable endpoint the deploy proceeds exactly like
# before (teardown's SIGTERM ritual requeues whatever was still running).
# 2026-09-11: 600 → 1200. The Fleet Supervisor runs on glm-5.3 at reasoning
# max — a wake is 8–16 min (a 07:39Z deploy interrupted one at the 600 s cap
# and re-ran it from scratch). The cap only binds while a run is in flight.
# 2026-09-18 evening: 1200 → 600 and the retiring budget 1800 → 900. The
# deploy-resume brief (PR #862) changed what a kill costs: an interrupted
# turn re-fires WITH its executed-tool receipts ("ALREADY EXECUTED: do not
# repeat") instead of from scratch, while the long budgets had pushed every
# wave to 49–73 min (four waves measured 2026-09-18) — and the 1800 s budget
# still killed a run in wave 414b9cce. The retiring gate (no new machine
# starts on the old colour) stays; the budget bounds only the tail of runs
# already in flight. This cap applies to PRE-endpoint builds (no retire).
DRAIN_MAX_SECONDS=${DRAIN_MAX_SECONDS:-600}
# When the old backend confirmed RETIRING (2026-09-18 — it starts no new
# machine runs and no longer sweeps schedules/hooks), the only thing left to
# wait for is the runs already in flight: 900 s covers the p50 supervisor
# wake; a longer one is interrupted with its resume brief and finishes on the
# new colour.
DRAIN_MAX_RETIRING_SECONDS=${DRAIN_MAX_RETIRING_SECONDS:-900}
# WI-G (2026-09-25) — bounded ONE-TIME extension of the RETIRING budget.
# DEFAULT OFF: with DRAIN_RETIRING_EXTENSION_SECONDS unset/0 the drain below is
# byte-for-byte today's behaviour (the extension block never touches
# DRAIN_BUDGET). When set (>0) and the retiring budget runs out with runs still
# active, the budget is extended ONCE by this many seconds — ONLY if the old
# backend's /drain-status reports "extensionEligible":true, i.e. every
# remaining chat run is a supervisor-class machine wake that made a tool call
# within its progress window (120 s — chat-agent/drain-status.ts) and nothing
# else is pending. Total wait is capped at DRAIN_RETIRING_TOTAL_CAP_SECONDS
# (1500 s). A wedged run, a user turn, or a late cross-check never extends.
# Suggested value when enabling: 600 (900 + 600 = the 1500 s cap).
DRAIN_RETIRING_EXTENSION_SECONDS=${DRAIN_RETIRING_EXTENSION_SECONDS:-0}
DRAIN_RETIRING_TOTAL_CAP_SECONDS=${DRAIN_RETIRING_TOTAL_CAP_SECONDS:-1500}
# 2026-10-20 — deep research has NO wall clock (backend chat-agent/council-dispatch.ts researchNoWallClock): a
# research council can legitimately outlive the 900 s retiring budget, and the cut requeued it to re-run from its
# receipts. A RESEARCH-ONLY one-time extension, ON by default: when the retiring budget runs out and the old
# backend's /drain-status says "researchExtensionEligible":true — at least one remaining run is a deep-research
# council that is still PROGRESSING (a model / tool event inside its stall window) and every other remaining run is
# a progressing research council or supervisor wake — the budget is extended ONCE by this many seconds, capped at
# DRAIN_RETIRING_TOTAL_CAP_SECONDS (900 + 600 = the 1500 s cap). No research run in flight ⇒ the flag is false and
# the drain is byte-for-byte the one above; a STALLED council never extends. DRAIN_RESEARCH_EXTENSION_SECONDS=0
# turns it off (the GitHub repo Variable of that name — deploy.yml forwards it; an unset Variable arrives as '' and
# keeps the default); the backend's RESEARCH_NO_WALL_CLOCK_DISABLED=1 reports the flag false. The supervisor-wake
# extension above keeps its own default (0).
DRAIN_RESEARCH_EXTENSION_SECONDS=${DRAIN_RESEARCH_EXTENSION_SECONDS:-600}
# 2026-08-07: raised 120→240 — must sit ABOVE docker's unhealthy point
# (backend start_period 90s + 6×10s retries ≈ 150s) so a slow-booting but
# healthy container is seen 'healthy' before docker gives up on it.
# 2026-08-31: raised 240→420 with the worker healthcheck's start_period
# (45s→240s, ticket dcf9056a): the worker's docker unhealthy point moved to
# ~390s (240 + 10×15s) after ~190s loaded-box worker boots raced the old
# ~195s point in 2 consecutive deploys. This ceiling must stay ABOVE every
# tier's unhealthy point (worker ~390s; backend ~390s since ticket ccaab266
# raised its start_period 240s→300s after the ~326s loaded-boot failures;
# frontend/relay ~80s) so a genuinely-broken container still fails fast on
# 'unhealthy' instead of timing the gate out — and above the slowest-normal
# time-to-healthy.
# 2026-09-01 (ticket ccaab266): raised 420→560 with the backend healthcheck's
# start_period (240s→420s): loaded-box backend boots reached ~326s and raced
# the ~330s unhealthy point in 2 consecutive deploys (33505472300,
# 33511018130). Tier unhealthy points are now backend ~510s, worker ~390s —
# 560s keeps ~50s of margin above the slowest tier's fail-fast point.
HEALTH_TIMEOUT=560  # Max seconds to wait for new containers to be healthy
HEALTH_INTERVAL=3   # Seconds between health check polls

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# >>> drain_extension_budget — pure budget math, extracted verbatim by
# scripts/deploy/blue-green-drain-extension.test.sh (keep the markers).
# Usage: drain_extension_budget BUDGET EXTENSION CAP DRAIN_JSON [FLAG] → prints
# the new budget: BUDGET unchanged unless EXTENSION > 0 AND the /drain-status
# payload says "FLAG":true (FLAG defaults to extensionEligible; the research
# extension passes researchExtensionEligible); then min(BUDGET + EXTENSION, CAP),
# never below BUDGET. Everything non-numeric is treated as "no extension".
drain_extension_budget() {
    local budget="$1" ext="${2:-0}" cap="${3:-0}" json="${4:-}" flag="${5:-extensionEligible}" new
    case "$ext" in ''|*[!0-9]*) echo "$budget"; return;; esac
    case "$cap" in ''|*[!0-9]*) echo "$budget"; return;; esac
    case "$flag" in ''|*[!A-Za-z]*) echo "$budget"; return;; esac
    [ "$ext" -gt 0 ] || { echo "$budget"; return; }
    printf '%s' "$json" | grep -q "\"${flag}\":true" || { echo "$budget"; return; }
    new=$((budget + ext))
    [ "$new" -gt "$cap" ] && new=$cap
    [ "$new" -lt "$budget" ] && new=$budget
    echo "$new"
}
# <<< drain_extension_budget

# ── Box-local deploy flags (multi-box ca-central-1) ──────────────────────────
# Optional file OUTSIDE the rsync root, written at instance bootstrap (see
# scripts/canada-migration/user-data-app-b.yaml). Defaults preserve the
# original single-box behavior exactly.
#   ENABLE_STATEFUL=false   — instance B: postgres/redis/adminer live on A;
#                             only stateless base services are started here
#   ENABLE_MIGRATIONS=false — instance B: only A runs prisma migrate deploy
#   ENABLE_WORKER=false     — instance B: exactly one worker fleet (on A)
#   RUN_POSTGRES_BASE=false — DB moved to RDS: start every stateful base
#                             service EXCEPT the docker postgres container
ENABLE_STATEFUL=true
ENABLE_MIGRATIONS=true
ENABLE_WORKER=true
RUN_POSTGRES_BASE=true
BOX_FLAGS="/opt/crossmodel-local/deploy-flags.env"
[ -f "$BOX_FLAGS" ] && . "$BOX_FLAGS"
if [ "$ENABLE_STATEFUL" != "true" ] || [ "$ENABLE_MIGRATIONS" != "true" ] || [ "$ENABLE_WORKER" != "true" ] || [ "$RUN_POSTGRES_BASE" != "true" ]; then
    log "⚙️  Box flags: STATEFUL=$ENABLE_STATEFUL MIGRATIONS=$ENABLE_MIGRATIONS WORKER=$ENABLE_WORKER POSTGRES_BASE=$RUN_POSTGRES_BASE"
fi

# ── Where "external" post-flip checks are aimed ─────────────────────────────
# Default: the public domain (correct once DNS points at this fleet). During
# the ca-central-1 cutover the domain still resolved to the OLD box, and a
# concurrent prod restart there made these checks fail a perfectly good deploy
# (2026-07-29 fleet deploy false-alarm). The workflow therefore sets
# PUBLIC_CHECK_IP=127.0.0.1: curl --resolve pins SNI+Host to the public domain
# while connecting to THIS box's own nginx — verifying the box just deployed.
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-digby.ai}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://$PUBLIC_DOMAIN}"
PUBLIC_CHECK_IP="${PUBLIC_CHECK_IP:-}"
PUBLIC_RESOLVE_ARGS=()
if [ -n "$PUBLIC_CHECK_IP" ]; then
    PUBLIC_RESOLVE_ARGS=(--resolve "$PUBLIC_DOMAIN:443:$PUBLIC_CHECK_IP")
    log "🎯 External checks pinned to this box (--resolve $PUBLIC_DOMAIN:443:$PUBLIC_CHECK_IP)"
fi

# ── Authenticated smoke test plumbing ─────────────────────────────────────────
# scripts/deploy-auth-smoke.sh logs in the canonical agent test user and probes an
# authenticated route (401 unauth / 200 + exactly one cm_access cookie authed).
# Resolved relative to THIS script so it works regardless of the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH_SMOKE="${SCRIPT_DIR}/scripts/deploy-auth-smoke.sh"
# Holds the smoke user's access token between the pre-flip and post-flip checks.
# Created 600 by the smoke script; removed on every exit path.
SMOKE_TOKEN_FILE=$(mktemp)
trap 'rm -f "$SMOKE_TOKEN_FILE"' EXIT

cd "$COMPOSE_DIR"

# ── Determine active/inactive color ────────────────────────────────────────────
# The .active-color file is the source of truth for the last VERIFIED-GOOD
# color. It is only committed after every post-flip gate passes (see the
# "Commit new color" step below) — rollback.sh --to-live restores nginx to
# this color, so it must never name an unverified one. If a deploy
# has NEVER succeeded since the file was lost, rollback.sh has nothing to read
# and aborts ("No .active-color file found"). To stay self-healing: when the file
# is missing, DETECT the live color from the running containers and re-seed it so
# rollback always has a valid target.
if [ -f "$ACTIVE_COLOR_FILE" ]; then
    ACTIVE=$(cat "$ACTIVE_COLOR_FILE")
    log "📖 Active color from state file: $ACTIVE"
else
    if sudo docker ps --filter "name=admin-backend-green" --filter "status=running" -q | grep -q .; then
        ACTIVE="green"
    elif sudo docker ps --filter "name=admin-backend-blue" --filter "status=running" -q | grep -q .; then
        ACTIVE="blue"
    else
        ACTIVE="blue"
    fi
    echo "$ACTIVE" | sudo tee "$ACTIVE_COLOR_FILE" > /dev/null
    log "📖 No state file — detected live color and re-seeded: $ACTIVE"
fi

case "$ACTIVE" in
    blue)  INACTIVE="green";  BLUE_PORT_BACKEND=4001;  BLUE_PORT_FRONTEND=8248;  GREEN_PORT_BACKEND=4002;  GREEN_PORT_FRONTEND=8249;  BLUE_PORT_RELAY=4301;  GREEN_PORT_RELAY=4302 ;;
    green) INACTIVE="blue";   BLUE_PORT_BACKEND=4001;  BLUE_PORT_FRONTEND=8248;  GREEN_PORT_BACKEND=4002;  GREEN_PORT_FRONTEND=8249;  BLUE_PORT_RELAY=4301;  GREEN_PORT_RELAY=4302 ;;
    *)     log "❌ Unknown active color: $ACTIVE"; exit 1 ;;
esac

log "🎯 Active: $ACTIVE → Deploying to: $INACTIVE"

# ── Ensure base services are running ───────────────────────────────────────────
# Self-heal docker-compose rename-artifact orphans first. When `compose up`
# recreates a base service (e.g. slack-mcp-prod), it briefly renames the old
# container to "<short-id>_<name>". If a prior `up` was interrupted (a failed or
# concurrent deploy), that temp-named container lingers and is no longer tracked
# by compose — the next recreate then dies with:
#   Error response from daemon: No such container: <id>_slack-mcp-prod
# which, under `set -e`, kills the whole deploy before it can switch colors.
# Force-remove any such artifacts (they are never the live container) so the
# base `up` below can recreate cleanly. Matches "<hex>_<base-service>-prod".
log "🧹 Removing any docker-compose rename-artifact orphans..."
ORPHANS=$(sudo docker ps -a --format '{{.Names}}' \
    | grep -E '^[0-9a-f]+_(slack-mcp-prod|asana-mcp-prod|google-mcp-prod|github-mcp-prod|x-mcp-prod|mcp-gateway-prod|admin-(postgres|redis|adminer|stt)-prod)$' || true)
if [ -n "$ORPHANS" ]; then
    echo "$ORPHANS" | while read -r c; do
        [ -n "$c" ] && { log "   ↳ removing orphan: $c"; sudo docker rm -f "$c" 2>/dev/null || true; }
    done
else
    log "   ✅ no rename-artifact orphans found"
fi

log "🔍 Checking base services..."

# ── Base build-context image rebuild check (FO firing 10b, 2026-09-23) ────────
# Eight base services are BUILD-context images (docker-compose.base.yml:
# google-mcp github-mcp x-mcp slack-mcp asana-mcp digby-mcp brightdata-mcp
# browser-service — ea3ad8a8, the hosted hardened browser).
# `compose up -d` never rebuilds a build: image — it starts whatever
# crossmodel-<svc> image already exists — so 32d0ebc8's google-mcp write tools
# shipped, the wave went green, and prod kept serving the 2026-06-17 image
# (missing slides.js entirely; on-box /opt/crossmodel/google-mcp/src had it).
# A service is rebuilt ONLY when its context's content hash changed since the
# last successful build (stamp kept in /var/tmp — OUTSIDE the rsync root, so
# deploys never delete it — same convention as the ec2-ops install markers).
# A missing stamp means rebuild — the designed bootstrap that repairs pre-fix
# drift. A needed-but-failed build FAILS the deploy (the 9da289ea rule: new
# code must never ride a green wave on a stale image). Kill switch:
# BASE_REBUILD_DISABLED=1 restores the old start-only behavior.
BASE_BUILD_SERVICES="google-mcp github-mcp x-mcp slack-mcp asana-mcp digby-mcp brightdata-mcp browser-service"
# Bound the per-wave rebuild work (firing-10c follow-up): the first post-fix
# wave bootstraps from SEVEN missing stamps — 3 never-built contexts (github,
# x, asana mcp) plus 4 changed — and the blue-green script runs under a
# 3300 s `timeout` (2700 before T2d 2026-10-17 — the did-it-work window
# rides inside it) whose total budget a healthy wave already consumes
# ~46 min of (wave 35896314716). An unbounded 7× rebuild could blow the cap
# and fail an otherwise-good deploy. The bound is a QUEUE, not a skip: the
# priority order fronts the service whose drift is owner-visible
# (google-mcp — the 32d0ebc8 write tools), and a service that does not fit
# the bound keeps its changed/missing stamp, so the NEXT wave rebuilds it —
# the class converges over a few waves instead of risking the cap. Tunable:
# BASE_REBUILD_MAX (default 2; 0 = old start-only behavior).
BASE_REBUILD_MAX="${BASE_REBUILD_MAX:-2}"
if [ "${BASE_REBUILD_DISABLED:-0}" != "1" ] && [ "${BASE_REBUILD_MAX}" -ge 1 ]; then
    STAMP_DIR=/var/tmp/.digby-base-img-stamps
    sudo mkdir -p "$STAMP_DIR"
    # context_of <svc> — the build: context from docker-compose.base.yml
    # (brightdata-mcp builds from ./mcp-gateway, NOT ./brightdata-mcp).
    context_of() {
        awk -v svc="  $1:" '
            $0 == svc { in_svc = 1; next }
            /^  [a-z0-9-]+:$/ { in_svc = 0 }
            in_svc && $1 == "context:" { gsub(/["'"'"']/, "", $2); print $2; exit }
        ' "$BASE_COMPOSE"
    }
    FAILED_BASE=""
    REBUILT=0
    for SVC in $BASE_BUILD_SERVICES; do
        CTX_REL="$(context_of "$SVC")"
        if [ -z "$CTX_REL" ] || [ ! -d "$COMPOSE_DIR/${CTX_REL#./}" ]; then
            log "⚠️  $SVC: no build context ('$CTX_REL') — skipping rebuild check"
            continue
        fi
        CTX="$COMPOSE_DIR/${CTX_REL#./}"
        HASH="$(cd "$CTX" && find . -type f \
                \( -name '*.ts' -o -name '*.js' -o -name '*.json' -o -name '*.sh' -o -name 'Dockerfile' \) \
                -not -path './node_modules/*' -not -path './dist/*' -not -path './.git/*' -print0 \
                | sort -z | xargs -r -0 sha256sum | sha256sum | cut -c1-16)"
        [ -n "$HASH" ] || HASH="empty"
        STAMP="$STAMP_DIR/$SVC.content"
        OLD="$(sudo cat "$STAMP" 2>/dev/null || echo none)"
        if [ "$OLD" = "$HASH" ]; then
            log "✅ $SVC context unchanged ($HASH) — no rebuild"
            continue
        fi
        if [ "$REBUILT" -ge "$BASE_REBUILD_MAX" ]; then
            log "⏭️  $SVC needs a rebuild ($OLD → $HASH) but this wave's BASE_REBUILD_MAX=$BASE_REBUILD_MAX is spent — leaving the stamp unset so the NEXT wave rebuilds it"
            continue
        fi
        log "🔨 $SVC context changed ($OLD → $HASH) — rebuilding base image"
        if sudo docker compose -f "$BASE_COMPOSE" build "$SVC"; then
            echo "$HASH" | sudo tee "$STAMP" >/dev/null
            REBUILT=$((REBUILT + 1))
            log "✅ $SVC image rebuilt ($HASH) — recreating container"
            sudo docker compose -f "$BASE_COMPOSE" up -d --no-deps --force-recreate "$SVC" \
                || { log "❌ $SVC recreate failed after rebuild"; FAILED_BASE=1; }
        else
            log "❌ $SVC image build FAILED — aborting: new code must not ride a stale image (9da289ea)"
            FAILED_BASE=1
        fi
    done
    [ -n "$FAILED_BASE" ] && { log "❌ base image rebuild failed — aborting before color switch"; exit 1; }
fi

if [ "$ENABLE_STATEFUL" = "true" ]; then
    if [ "$RUN_POSTGRES_BASE" = "true" ]; then
        sudo docker compose -f "$BASE_COMPOSE" up -d

        # Wait for postgres to be healthy (base compose has healthcheck)
        for i in $(seq 1 30); do
            if sudo docker ps --filter "name=admin-postgres-prod" --format '{{.Status}}' | grep -q "(healthy)"; then
                log "✅ postgres is healthy"
                break
            fi
            sleep 2
        done
    else
        # DB lives on RDS (2026-07-31 cutover): start every stateful base
        # service EXCEPT the docker postgres container, so a plain `up -d`
        # can never boot it again here. redis stays (instance B points at it).
        # --no-deps (2026-08-19): adminer declares depends_on: postgres, so
        # without it compose STARTED the RDS-retired postgres anyway (seen
        # live in deploy run 32290298565: "admin-postgres-prod Started").
        log "   RUN_POSTGRES_BASE=false — DB on RDS; stateful base WITHOUT docker postgres"
        sudo docker compose -f "$BASE_COMPOSE" up -d --no-deps \
            redis adminer docker-socket-proxy google-mcp github-mcp x-mcp slack-mcp asana-mcp digby-mcp brightdata-mcp browser-service stt
    fi
else
    # Stateless box (instance B): postgres/redis/adminer run on the primary
    # box only. Start the stateless base fleet explicitly so a plain `up -d`
    # can never boot a second postgres/redis here.
    log "   ENABLE_STATEFUL=false — stateless base services only (DB/Redis on primary box)"
    sudo docker compose -f "$BASE_COMPOSE" up -d \
        docker-socket-proxy google-mcp github-mcp x-mcp slack-mcp asana-mcp digby-mcp brightdata-mcp browser-service stt
fi

# ── Sandbox egress guard (owner security fix 2026-09-24) ─────────────────────
# Coding sandboxes on the default bridge must not reach the VPC or IMDS
# (scripts/deploy/sandbox-egress-guard.sh — idempotent, installs a boot unit).
# Non-fatal: a guard hiccup must never block a deploy; the boot unit and the
# next wave re-apply it.
log "🛡  Applying the sandbox egress guard..."
sudo DIGBY_VPC_CIDR="${DIGBY_VPC_CIDR:-10.60.0.0/16}" bash "${COMPOSE_DIR}/scripts/deploy/sandbox-egress-guard.sh" --install-unit \
    || log "   ⚠️ sandbox egress guard failed (non-fatal — re-applied by the boot unit / next wave)"

# ── Pre-flight disk guard (issue #266 — the durable fix) ─────────────────────
# This IS the proven-safe ec2-ops emergency disk-prune block (one-shots
# 2026-07-29d/e/f, commits 56fa1f6/8b691bf/c2caa08, + 2026-08-19a on branch
# digby/ops-disk-prune-20260819) moved into the standard pre-deploy path, so a
# filling disk can never again block the pipeline (5 manual emergency prunes
# to date; a FULL disk breaks running services — 2026-08-19: Redis BGSAVE
# failures rejected app writes → /stream/register 503s while /health stayed
# green). Guard BEFORE building: ≥90% → run the proven-safe prune set:
#   · docker builder prune -af  — ALL BuildKit cache (acceptable HERE: this
#                                 guard only fires when the disk is critical;
#                                 normally the cache IS reused — see the
#                                 bounded post-build prune below)
#   · docker image prune -af    — every image not referenced by ANY container.
#                                 Running AND stopped containers keep theirs:
#                                 the live color, the pre-flip rollback target,
#                                 and digby-code session containers are
#                                 untouched. (Base-image layers may be re-pulled
#                                 on the next build — accepted one-time cost,
#                                 only when the disk is already critical.)
#   · journalctl vacuum to 100M
# NO container prune, NO volume prune (data + rollback targets stay).
# Still ≥95% after pruning → abort loudly rather than wound the box.
DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "${DISK_PCT:-0}" -ge 90 ]; then
    log "⚠️  Root disk at ${DISK_PCT}% — running the proven-safe pre-flight prune (issue #266)..."
    sudo docker system df 2>/dev/null | sed 's/^/   before: /' || true
    sudo docker builder prune -af 2>&1 | tail -2 | sed 's/^/   /' || true
    sudo docker image prune -af 2>&1 | tail -2 | sed 's/^/   /' || true
    sudo journalctl --vacuum-size=100M >/dev/null 2>&1 || true
    DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
    log "   Root disk now at ${DISK_PCT}%"
    sudo docker system df 2>/dev/null | sed 's/^/   after:  /' || true
fi
if [ "${DISK_PCT:-0}" -ge 95 ]; then
    log "❌ Root disk still at ${DISK_PCT}% after the full proven-safe prune — aborting BEFORE the build."
    log "   Free space manually (docker system df -v; check volumes/images) and redeploy."
    exit 1
fi

# ── Build new images for inactive color ────────────────────────────────────────
log "🔨 Building images for $INACTIVE..."

# Set env vars for the app compose file
if [ "$INACTIVE" = "blue" ]; then
    export BG_COLOR=blue BG_PORT_BACKEND=$BLUE_PORT_BACKEND BG_PORT_FRONTEND=$BLUE_PORT_FRONTEND BG_PORT_RELAY=$BLUE_PORT_RELAY
else
    export BG_COLOR=green BG_PORT_BACKEND=$GREEN_PORT_BACKEND BG_PORT_FRONTEND=$GREEN_PORT_FRONTEND BG_PORT_RELAY=$GREEN_PORT_RELAY
fi

# Layer-cached build (2026-08-31 speed pass): the old `--no-cache` + immediate
# `builder prune -af` pairing rebuilt EVERY layer from scratch on every deploy
# (30+ min even for UI-only changes). With caching on, an unchanged service
# (e.g. backend on a frontend-only push) builds in seconds, and the Dockerfiles'
# npm/Next cache-mounts keep even cache-busted installs fast. Disk stays safe:
# the bounded until=24h prune below + the pre-flight ≥90% full prune above.
# DEPLOY_SHA (2026-09-08): per-deploy frontend cache bust so both web boxes
# rebuild identical bundles from the same rsync'd source. The file ships with
# the rsync (written by deploy.yml from GITHUB_SHA); the timestamp fallback
# still busts when it's absent.
DEPLOY_SHA="$(cat /opt/crossmodel/.deploy-sha 2>/dev/null || date -u +%s)"
# deploy_speedups #6 (2026-09-26, DEFAULT OFF): FRONTEND_CONTENT_BUST=1 busts
# the frontend build on the CONTENT of frontend/ (scripts/deploy/
# frontend-bust-key.sh — sha256 over the build context; the same rsync'd tree
# on every web box ⇒ the same key ⇒ cross-box parity is kept and the parity
# gate is unchanged) instead of on the commit sha, so a backend-only wave
# reuses its cached `next build` (~3.5 min + export per box). Only the BUILD
# ARG changes: DEPLOY_SHA (the commit) stays the runtime env below. Any helper
# failure falls back to DEPLOY_SHA — today's behaviour.
FRONTEND_BUST_KEY="$DEPLOY_SHA"
if [ "${FRONTEND_CONTENT_BUST:-0}" = "1" ]; then
    FRONTEND_BUST_KEY="$(bash "${COMPOSE_DIR}/scripts/deploy/frontend-bust-key.sh" "${COMPOSE_DIR}/frontend" 2>/dev/null || true)"
    [ -n "$FRONTEND_BUST_KEY" ] || FRONTEND_BUST_KEY="$DEPLOY_SHA"
    log "🔑 Frontend cache-bust key: ${FRONTEND_BUST_KEY} (FRONTEND_CONTENT_BUST=1 — content hash; unchanged frontend/ ⇒ cached next build)"
fi
# deploy_speedups #5 (2026-09-26): build ONLY backend + frontend. The worker
# service runs the backend image (docker-compose.app.yml: image
# digby-app-${BG_COLOR}, exactly like relay), so bake no longer exports a
# second ~100 s worker image — and box B, which never runs a worker
# (ENABLE_WORKER=false), no longer builds one at all. `up -d` starts the worker
# from the already-built tag (compose builds on `up` only when the image is
# missing). WORKER_IMAGE_SHARED_DISABLED=1 restores the full-service build.
BUILD_SERVICES="backend frontend"
if [ "${WORKER_IMAGE_SHARED_DISABLED:-0}" = "1" ]; then
    BUILD_SERVICES=""
    log "   WORKER_IMAGE_SHARED_DISABLED=1 — building every service (worker image built separately)"
fi

# ── Image-build lock (batch-train T3g, 2026-10-17) ───────────────────────────
# Serializes THIS deploy's builds against every other builder on the box —
# chiefly prebuild-inactive.sh (deploy_speedups #3), whose pgrep guard is
# start-time only, and whose ORPHANED instances (a cancelled/coalesced wave
# drops the ssh transport; the remote `timeout 1800`-wrapped build keeps
# running) would otherwise overlap this build on the box's one BuildKit
# builder. BOUNDED-blocking: this is the deploy's OWN build — skipping it is
# impossible — so we wait up to IMAGE_BUILD_LOCK_WAIT_SECONDS (default 600 =
# the DRAIN_MAX_SECONDS p50 wake bound) for the holder, then warn and build
# anyway (a deploy must never wedge on a stuck pre-build; the overlap cost is
# duplicated layers, not corruption — BuildKit builds are content-addressed
# and concurrent-safe, the 2026-10-17 T3g diagnosis). prebuild-inactive.sh
# takes the SAME lock non-blocking (skip = its refusal class). The lock file
# lives in /var/tmp — OUTSIDE the rsync root, the base-image stamp convention
# (a lock inside /opt/crossmodel would be deleted mid-hold by this wave's own
# `rsync --delete`). IMAGE_BUILD_LOCK overrides the path (tests). Kill switch:
# IMAGE_BUILD_LOCK_DISABLED=1 (the prebuild's pgrep guard alone remains).
# Pinned by scripts/deploy/blue-green-speedups.test.sh.
IMAGE_BUILD_LOCK="${IMAGE_BUILD_LOCK:-/var/tmp/.digby-image-build.lock}"
if [ "${IMAGE_BUILD_LOCK_DISABLED:-0}" != "1" ]; then
    if ! exec 9>>"$IMAGE_BUILD_LOCK" 2>/dev/null; then
        log "⚠️  cannot open $IMAGE_BUILD_LOCK (lock DISABLED from here — building unsynchronized; the prebuild's own pgrep guard still refuses to start beside this deploy)"
    elif ! flock -w "${IMAGE_BUILD_LOCK_WAIT_SECONDS:-600}" 9; then
        log "⚠️  image-build lock still held after ${IMAGE_BUILD_LOCK_WAIT_SECONDS:-600}s — building anyway (an orphaned pre-build must never wedge the deploy)"
    fi
fi

# A transient registry error (Docker Hub 502, 2026-10-18) retries the build;
# a real build failure still fails at once (scripts/deploy/build-retry.sh).
if [ -f "${COMPOSE_DIR}/scripts/deploy/build-retry.sh" ]; then
    # shellcheck source=scripts/deploy/build-retry.sh
    . "${COMPOSE_DIR}/scripts/deploy/build-retry.sh"
else
    build_with_retry() { "$@"; }
fi
# shellcheck disable=SC2086  # BUILD_SERVICES is a deliberate word list
build_with_retry sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" BG_PORT_RELAY="$BG_PORT_RELAY" DEPLOY_SHA="$FRONTEND_BUST_KEY" BACKEND_CHOWN_RECURSIVE="${BACKEND_CHOWN_RECURSIVE:-0}" \
    docker compose -p "crossmodel_${INACTIVE}" -f "$APP_COMPOSE" build $BUILD_SERVICES

log "✅ Build complete for $INACTIVE"

# Prune only cache older than 24h, HERE (not at end-of-deploy: failed deploys
# skipped that step). Same-day cache is what makes merge-wave deploys fast —
# it stays. The 2026-08-19 disk fills came from --no-cache writing ~6GB of
# write-only cache per deploy plus a prune that never matched same-day cache;
# cached builds write only their deltas, and the pre-flight guard covers the
# critical case.
# Bounded by SIZE, not age (owner 2026-09-18 "does our auto prune work?"):
# ~10 waves/day each left their same-day layers under the old until=24h
# filter, and BuildKit cache had grown to 25-32 GB per box — the single
# biggest reclaimable block when box A hit 99%. --keep-storage keeps the most
# recently used layers (same-day reuse intact) and evicts the rest.
# 2026-09-26 (deploy_speedups #1): 10GB → ${BUILDER_CACHE_KEEP:-40GB}. The
# 10 GB cap was the ROOT CAUSE of the 9-minute builds: one wave's three-image
# build writes ~10-12 GB, so this prune evicted the previous wave's early
# layers every time — box B's `docker buildx du` showed every `COPY
# package*.json` / `npm ci` record at usage count 1, while unpruned box C
# showed the same records at usage count 21. Only 2 of ~43 steps were CACHED
# per wave; npm ci ran three times (65-92 s each) on unchanged lockfiles.
# 40 GB holds ~3 waves on the 1 TB volumes; the ≥90% pre-flight guard above
# still bounds the critical case. This is the ONE builder prune per box
# (deploy_speedups #8) — the end-of-deploy repeat is behind
# BUILDER_PRUNE_ONCE_DISABLED=1.
log "🧹 Pruning builder cache beyond ${BUILDER_CACHE_KEEP} (most recently used layers are kept)..."
sudo docker builder prune -f --keep-storage "$BUILDER_CACHE_KEEP" 2>/dev/null | tail -1 || true

# ── Run database migrations before starting new app containers ─────────────────
if [ "$ENABLE_MIGRATIONS" = "true" ]; then
    log "🗄️  Running database migrations..."
    # A migration that loses a lock wait (55P03) is resolved as rolled back and
    # retried ONCE instead of wedging every later deploy on P3009 — only an
    # ATOMIC in-place lock-retry migration ("-- digby-lock-retry: atomic", its
    # RAISE carrying "[digby-lock-retry]"), checked against this repo's
    # migrations dir; a retry that loses too is resolved again so the next
    # deploy re-attempts; a P3009 left by an earlier deploy is recovered the same
    # way after the read-only probe backend/prisma/lock-recovery-probe.sql says
    # every failed row is such a lost wait
    # (scripts/deploy/migrate-lock-recovery.sh; MIGRATE_LOCK_RECOVERY_DISABLED=1
    # runs migrate deploy once — the pre-2026-10-22 step).
    if [ -f "${COMPOSE_DIR}/scripts/deploy/migrate-lock-recovery.sh" ]; then
        # shellcheck source=scripts/deploy/migrate-lock-recovery.sh
        . "${COMPOSE_DIR}/scripts/deploy/migrate-lock-recovery.sh"
        export MIGRATE_LOCK_MIGRATIONS_DIR="${COMPOSE_DIR}/backend/prisma/migrations"
        export MIGRATE_LOCK_PROBE_FILE="prisma/lock-recovery-probe.sql"
    else
        migrate_deploy_with_lock_recovery() { "$@" migrate deploy; }
    fi
    migrate_deploy_with_lock_recovery sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" BG_PORT_RELAY="$BG_PORT_RELAY" \
        docker compose -p "crossmodel_${INACTIVE}" -f "$APP_COMPOSE" run --rm backend npx prisma
    log "✅ Migrations complete"
else
    log "⏭️  ENABLE_MIGRATIONS=false — skipping prisma migrate (primary box owns migrations; it deploys first)"
fi

# ── Start new containers ──────────────────────────────────────────────────────
log "🚀 Starting $INACTIVE containers..."
# DEPLOY_SHA rides into the RUNTIME env too (2026-09-18): backend + worker
# report it in box_health rows so the Fleet Supervisor's get_fleet_telemetry
# deploy view can tell which boxes run main head without a human ssh.
if [ "$ENABLE_WORKER" = "true" ]; then
    sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" BG_PORT_RELAY="$BG_PORT_RELAY" DEPLOY_SHA="$DEPLOY_SHA" \
        docker compose -p "crossmodel_${INACTIVE}" -f "$APP_COMPOSE" up -d
else
    log "   ENABLE_WORKER=false — starting backend+frontend+relay only (worker runs on the primary box)"
    sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" BG_PORT_RELAY="$BG_PORT_RELAY" DEPLOY_SHA="$DEPLOY_SHA" \
        docker compose -p "crossmodel_${INACTIVE}" -f "$APP_COMPOSE" up -d backend frontend relay
fi

# ── Wait for health checks ──────────────────────────────────────────────────
wait_for_healthy() {
    local container_name="$1"
    local label="$2"
    local waited=0
    while [ $waited -lt $HEALTH_TIMEOUT ]; do
        STATUS=$(sudo docker inspect --format='{{.State.Health.Status}}' "$container_name" 2>/dev/null || echo "not_found")
        if [ "$STATUS" = "healthy" ]; then
            log "   ✅ $label is healthy ($(($waited))s)"
            return 0
        fi
        if [ "$STATUS" = "unhealthy" ]; then
            log "   ❌ $label health check FAILED"
            sudo docker logs "$container_name" --tail 30 2>/dev/null || true
            return 1
        fi
        sleep "$HEALTH_INTERVAL"
        waited=$((waited + HEALTH_INTERVAL))
    done
    log "   ❌ $label did not become healthy within ${HEALTH_TIMEOUT}s"
    sudo docker logs "$container_name" --tail 30 2>/dev/null || true
    return 1
}

# A stack that fails the pre-flip health gate is not serving traffic (nginx
# still points at the live color; auto-rollback only restores routing) — but it
# KEEPS RUNNING, doubling box load and making every subsequent deploy's boot
# slower (the 2026-08-14 chain of 3 consecutive slow-boot deploy failures).
# Stop it so the next attempt gets the box's full resources. Containers are
# only STOPPED (not removed) so their logs stay available for debugging.
stop_failed_stack() {
    log "🧹 Stopping failed ${INACTIVE} stack so it doesn't keep consuming box resources..."
    sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" BG_PORT_RELAY="$BG_PORT_RELAY" \
        docker compose -p "crossmodel_${INACTIVE}" -f "$APP_COMPOSE" stop || true
}

log "🏥 Waiting for health checks..."
wait_for_healthy "admin-backend-${INACTIVE}" "backend-${INACTIVE}" || { stop_failed_stack; exit 1; }
wait_for_healthy "admin-frontend-${INACTIVE}" "frontend-${INACTIVE}" || { stop_failed_stack; exit 1; }
# Digby Edge relay: holds edge tunnels + serves the admin proxy — a dead relay
# must gate the flip or every paired edge goes offline silently on this box.
wait_for_healthy "admin-relay-${INACTIVE}" "relay-${INACTIVE}" || { stop_failed_stack; exit 1; }
# The coding worker executes agent runs; if it crash-loops, coding sessions
# queue forever while /health stays green — gate the flip on it too.
# (Skipped on stateless boxes where the worker runs on the primary box only.)
if [ "$ENABLE_WORKER" = "true" ]; then
    wait_for_healthy "admin-worker-${INACTIVE}" "worker-${INACTIVE}" || { stop_failed_stack; exit 1; }
else
    log "   ⏭️  ENABLE_WORKER=false — skipping worker health gate"
fi

# ── Verify endpoints ────────────────────────────────────────────────────────
log "🔍 Verifying $INACTIVE endpoints..."

if [ "$INACTIVE" = "blue" ]; then
    BE_PORT=$BLUE_PORT_BACKEND
    FE_PORT=$BLUE_PORT_FRONTEND
    RY_PORT=$BLUE_PORT_RELAY
else
    BE_PORT=$GREEN_PORT_BACKEND
    FE_PORT=$GREEN_PORT_FRONTEND
    RY_PORT=$GREEN_PORT_RELAY
fi

BE_HEALTH=$(curl -s --max-time 10 "http://localhost:${BE_PORT}/health" 2>/dev/null || echo '{"status":"error"}')
FE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:${FE_PORT}" 2>/dev/null || echo "000")
RY_HEALTH=$(curl -s --max-time 10 "http://localhost:${RY_PORT}/health" 2>/dev/null || echo '{"status":"error"}')

log "   Backend (${BE_PORT}): $BE_HEALTH"
log "   Frontend (${FE_PORT}): HTTP $FE_CODE"

# Same teardown contract as the container-health gates above (#238): a stack
# that fails endpoint verification must not keep consuming the box, and must
# not remain a target any rollback path could route traffic to.
echo "$BE_HEALTH" | grep -q '"healthy"' || { log "❌ Backend $INACTIVE not healthy"; stop_failed_stack; exit 1; }
echo "$RY_HEALTH" | grep -q '"healthy"' || { log "❌ Relay $INACTIVE not healthy"; stop_failed_stack; exit 1; }
[ "$FE_CODE" = "200" ] || [ "$FE_CODE" = "304" ] || { log "❌ Frontend $INACTIVE not serving (HTTP $FE_CODE)"; stop_failed_stack; exit 1; }

# ── Authenticated smoke gate (pre-flip, FATAL) ──────────────────────────────
# The /health + frontend gate above never makes an authenticated request — that
# blind spot let the 2026-07-23 duplicate `cm_access` Set-Cookie regression
# (stacked router.use(authenticate) → response headers > nginx proxy buffer →
# 502s on /api/crossmodel/coding/*) ship through a green deploy. Log in as the
# canonical smoke account (`scripts/deploy-auth-smoke.sh` mode `new`) directly
# against the NEW color's backend port and verify an authenticated route
# returns 200 with exactly one cm_access cookie. Register-once is gated by
# SMOKE_ALLOW_REGISTER=1.
log "🔐 Running authenticated smoke test against $INACTIVE (http://localhost:${BE_PORT})..."
if ! bash "$AUTH_SMOKE" new "http://localhost:${BE_PORT}" "$SMOKE_TOKEN_FILE"; then
    log "❌ Authenticated smoke FAILED on $INACTIVE — aborting BEFORE traffic switch"
    # MANDATORY TEARDOWN: nginx never flipped, so the workflow's auto-rollback
    # (`rollback.sh --to-live`) correctly no-ops here. A MANUAL bare
    # `rollback.sh` now refuses non-RUNNING/unhealthy targets (2026-08-16
    # guard), but tear the failed stack down anyway — defense in depth, and it
    # frees the box's resources for the next attempt.
    log "🛑 Tearing down failed $INACTIVE stack (auto-rollback must not find it)..."
    sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" BG_PORT_RELAY="$BG_PORT_RELAY" \
        docker compose -p "crossmodel_${INACTIVE}" -f "$APP_COMPOSE" down --timeout 30 2>/dev/null || true
    for name in "admin-backend-${INACTIVE}" "admin-frontend-${INACTIVE}" "admin-worker-${INACTIVE}" "admin-relay-${INACTIVE}"; do
        sudo docker rm -f "$name" 2>/dev/null || true
    done
    exit 1
fi
log "✅ Authenticated smoke passed on $INACTIVE (pre-flip)"

# ── Switch nginx upstream ──────────────────────────────────────────────────────
log "🔄 Switching nginx upstream to $INACTIVE..."

sudo tee "$UPSTREAM_CONF" > /dev/null << EOF
set \$backend_upstream backend_${INACTIVE};
set \$frontend_upstream frontend_${INACTIVE};
set \$relay_upstream relay_${INACTIVE};
EOF

sudo nginx -t && sudo nginx -s reload
log "✅ Nginx switched to $INACTIVE (hot reload)"

# ── Post-flip verification through the domain (FATAL) ────────────────────────
# .active-color still names the OLD color here — it is only committed after
# EVERY post-flip gate below passes (just before drain). That ordering is what
# makes a post-flip failure recoverable: `rollback.sh --to-live` restores nginx
# to the .active-color color, so the file must keep naming the last VERIFIED
# color until the new one proves itself. (Before 2026-08-13 the file was
# rewritten at flip time, which turned --to-live into a no-op exactly when a
# post-flip gate failed — the just-failed color kept serving prod.)
#
# revert_flip: on a post-flip gate failure, restore nginx to the old color
# ourselves (the old $ACTIVE stack is still running — drain has not started) so
# even a MANUAL deploy run ends safe; the workflow's `rollback.sh --to-live`
# then no-ops idempotently. Tear down the failed stack only once nginx is
# actually off it — if the flip-back reload fails, leave the containers up (the
# running nginx may still route to them) and let --to-live retry the flip.
revert_flip() {
    log "⏪ Post-flip gate failed — flipping nginx back to $ACTIVE..."
    sudo tee "$UPSTREAM_CONF" > /dev/null << EOF
set \$backend_upstream backend_${ACTIVE};
set \$frontend_upstream frontend_${ACTIVE};
set \$relay_upstream relay_${ACTIVE};
EOF
    if sudo nginx -t && sudo nginx -s reload; then
        log "✅ nginx restored to $ACTIVE — tearing down failed $INACTIVE stack..."
        sudo BG_COLOR="$BG_COLOR" BG_PORT_BACKEND="$BG_PORT_BACKEND" BG_PORT_FRONTEND="$BG_PORT_FRONTEND" BG_PORT_RELAY="$BG_PORT_RELAY" \
            docker compose -p "crossmodel_${INACTIVE}" -f "$APP_COMPOSE" down --timeout 30 2>/dev/null || true
        for name in "admin-backend-${INACTIVE}" "admin-frontend-${INACTIVE}" "admin-worker-${INACTIVE}" "admin-relay-${INACTIVE}"; do
            sudo docker rm -f "$name" 2>/dev/null || true
        done
    else
        # Reload failed — the RUNNING nginx still routes to $INACTIVE. Put the
        # conf file back in sync with that reality: --to-live compares the conf
        # file against .active-color, so only a NEW-vs-OLD mismatch makes it
        # retry the flip-back (tee + nginx -t + reload) itself.
        sudo tee "$UPSTREAM_CONF" > /dev/null << EOF
set \$backend_upstream backend_${INACTIVE};
set \$frontend_upstream frontend_${INACTIVE};
set \$relay_upstream relay_${INACTIVE};
EOF
        log "❌ nginx flip-back reload FAILED — leaving $INACTIVE containers up; rollback.sh --to-live will retry the flip"
    fi
}

sleep 3
EXT_HEALTH=$(curl -s "${PUBLIC_RESOLVE_ARGS[@]}" --max-time 10 "$PUBLIC_BASE_URL/api/health" 2>/dev/null || echo '{"status":"error"}')
log "🌐 External health check: $EXT_HEALTH"
echo "$EXT_HEALTH" | grep -q '"healthy"' || { log "❌ External health check FAILED post-flip"; revert_flip; exit 1; }

# Through-nginx authenticated recheck with the pre-flip smoke user's token. This
# exercises the exact path that 502'd on 2026-07-23 (authenticated
# /api/crossmodel/coding/* via nginx) — the pre-flip check hits the backend port
# directly and cannot see nginx proxy-buffer overflows.
log "🔐 Re-running authenticated smoke through $PUBLIC_BASE_URL ..."
if ! SMOKE_RESOLVE_IP="$PUBLIC_CHECK_IP" bash "$AUTH_SMOKE" recheck "$PUBLIC_BASE_URL" "$SMOKE_TOKEN_FILE"; then
    log "❌ Authenticated smoke FAILED through domain post-flip — reverting flip"
    revert_flip
    exit 1
fi

# ── Did-it-work gate (T2d, ticket b4824553; MANDATORY post-switch window) ────
# ~5–10 min of health + authenticated login/smoke + error-rate watching, run
# BEFORE .active-color is committed to the new color and BEFORE the old color
# is drained. This placement preserves the 2026-08-13 ordering invariant that
# makes rollback.sh --to-live correct: .active-color keeps naming the OLD
# (last-verified) color for the whole window, so:
#   - gate FAILS   → revert_flip restores nginx to $ACTIVE itself (its
#                    containers still run — drain never began) and tears down
#                    the failed stack; the workflow's rollback.sh --to-live
#                    then no-ops (nginx == file). Exit 42 tells the workflow
#                    this failed AFTER the switch → also reset main.
#   - deploy DIES mid-window (runner kill / timeout)
#                  → file still names $ACTIVE, nginx points at the new color
#                    → --to-live flips traffic back to the running, verified
#                    old color. This is exactly the pre-existing recoverable
#                    window of the post-flip checks — the gate only EXTENDS it.
#   - gate PASSES  → the commit below names the color that just proved itself
#                    for minutes under real traffic; drain proceeds.
# Exit 42 is exclusively this gate's code: it distinguishes "failed BEFORE
# traffic moved" (exit 1 — today's semantics, no main reset) from "failed
# AFTER the switch, mid-window" (42 — roll back AND reset main to the
# pre-deploy commit).
DID_IT_WORK_EPOCH=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if IS_DID_IT_WORK=1 DID_IT_WORK_CONTAINER="admin-backend-${INACTIVE}" \
   DID_IT_WORK_EPOCH="$DID_IT_WORK_EPOCH" \
   PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
   PUBLIC_CHECK_IP="$PUBLIC_CHECK_IP" \
   DID_IT_WORK_CYCLES="${DID_IT_WORK_CYCLES:-}" \
   DID_IT_WORK_INTERVAL_SECONDS="${DID_IT_WORK_INTERVAL_SECONDS:-}" \
   DID_IT_WORK_WINDOW_MINUTES="${DID_IT_WORK_WINDOW_MINUTES:-}" \
   DID_IT_WORK_ERROR_FACTOR="${DID_IT_WORK_ERROR_FACTOR:-}" \
   DID_IT_WORK_ERROR_ROWS_FLOOR="${DID_IT_WORK_ERROR_ROWS_FLOOR:-}" \
   DID_IT_WORK_DISABLED="${DID_IT_WORK_DISABLED:-}" \
   bash "${SCRIPT_DIR}/scripts/deploy/did-it-work-gate.sh"; then
    log "✅ did-it-work window passed — committing the new color as live"
else
    rc=$?
    if [ "$rc" -eq 2 ]; then
        log "⚠️ did-it-work gate inactive (rc=2) — continuing (manual/legacy deploy path)"
    elif [ "$rc" -eq 42 ]; then
        log "❌ did-it-work gate FAILED (rc=42) — flipping nginx back to $ACTIVE and rolling back"
        revert_flip
        exit 42
    else
        # rc=3 (gate cannot run) or anything unexpected: fail CLOSED — revert
        # the flip, never let an unverifiable new color keep traffic — but with
        # TODAY's exit-1 semantics: the workflow rolls back and NO main reset
        # (an infra problem is not a code verdict; review m1, 2026-10-17).
        log "❌ did-it-work gate could not run (rc=$rc) — flipping nginx back to $ACTIVE, failing the deploy WITHOUT a main reset"
        revert_flip
        exit 1
    fi
fi

# ── Commit new color as live (all post-flip gates + the did-it-work window
# passed) ──────────────────────────────────────────────────────────────────────
# Written BEFORE drain: from here the old stack is destroyed, so the new color
# is the only survivor and rollback --to-live must treat it as live (a failure
# in the post-drain final checks below has nothing left to flip back to).
echo "$INACTIVE" | sudo tee "$ACTIVE_COLOR_FILE" > /dev/null
log "💾 Active color saved: $INACTIVE"

# ── Drain old color (bounded, app-observed — feedback 56159c5a) ───────────────
# Old behavior: a blind fixed 60s sleep — every in-flight CHAT run on the old
# color died mid-answer at teardown (detached chat runs live in the web
# process). Current behavior: sleep the DRAIN_SECONDS floor (default 10s;
# DRAIN_SECONDS=60 restores the historical minute) so SSE clients get a
# reconnect grace, then poll the OLD backend's /drain-status until its active
# chat runs hit 0, bounded at DRAIN_MAX_SECONDS. NEVER FATAL: the new color is
# already committed live above (a post-commit failure has nothing to flip back
# to), so a timeout or an unreadable endpoint only logs and proceeds — the old
# color's SIGTERM ritual requeues whatever was still running onto the new one.
OLD_BE_PORT=$([ "$ACTIVE" = "blue" ] && echo "$BLUE_PORT_BACKEND" || echo "$GREEN_PORT_BACKEND")
OLD_CONTAINER="admin-backend-${ACTIVE}"

log "⏳ Draining old $ACTIVE environment (floor ${DRAIN_SECONDS}s, max ${DRAIN_MAX_SECONDS}s)..."
log "   Active SSE connections continue on old containers during drain"

# RETIRE FIRST (2026-09-18 — the deploy-replay tax): the old backend kept
# STARTING machine runs during the drain (instant hook delivery from its own
# finishing runs, queue drains, schedule firings), so the drain never
# converged — the 18:16Z wave waited the full budget for a Fleet Supervisor
# wake that began AFTER the flip and then killed it (38 replays on 09-17).
# Marking the old backend retiring makes startDetachedChatRun refuse
# machine-triggered starts (they park/queue for the new colour); in-flight
# runs finish; user turns already route to the new colour. Localhost-bound
# like /drain-status. Never fatal — a pre-endpoint build just drains as before.
RETIRE_JSON=$(curl -s --max-time 5 -X POST "http://localhost:${OLD_BE_PORT}/drain-status/retire" 2>/dev/null || true)
DRAIN_BUDGET=$DRAIN_MAX_SECONDS
DRAIN_RETIRING=0
if echo "$RETIRE_JSON" | grep -q '"retiring":true'; then
    DRAIN_BUDGET=$DRAIN_MAX_RETIRING_SECONDS
    DRAIN_RETIRING=1
    log "   Old $ACTIVE backend marked RETIRING — no new machine runs start there; in-flight runs finish (budget ${DRAIN_BUDGET}s)"
else
    log "   /drain-status/retire unavailable on old $ACTIVE (pre-endpoint build?) — plain drain (budget ${DRAIN_BUDGET}s)"
fi
if sudo docker ps --filter "name=${OLD_CONTAINER}" --filter "status=running" -q | grep -q .; then
    log "   Old backend is still running — active connections will complete"
fi

# The SSE-grace floor (DRAIN_SECONDS — 10 s since 2026-09-26, deploy_speedups
# #8; DRAIN_SECONDS=60 restores the historical minute). The poll below exits
# the moment the old backend reports 0 chat runs.
sleep "$DRAIN_SECONDS"

drain_waited=$DRAIN_SECONDS
drain_seen=0
drain_extended=0
while [ "$drain_waited" -lt "$DRAIN_BUDGET" ]; do
    DRAIN_JSON=$(curl -s --max-time 5 "http://localhost:${OLD_BE_PORT}/drain-status" 2>/dev/null || true)
    ACTIVE_RUNS=$(echo "$DRAIN_JSON" | sed -n 's/.*"activeRuns":\([0-9][0-9]*\).*/\1/p')
    if [ -z "$ACTIVE_RUNS" ]; then
        if [ "$drain_seen" -eq 0 ]; then
            # Endpoint unreachable or a pre-endpoint build (the FIRST deploy
            # with this script drains an old color that has no /drain-status):
            # the historical fixed wait was already served — proceed as before.
            log "   /drain-status unavailable on old $ACTIVE (pre-endpoint build?) — fixed ${DRAIN_SECONDS}s floor served; proceeding"
        else
            log "   /drain-status went unreadable mid-drain — proceeding (teardown requeue covers any live runs)"
        fi
        break
    fi
    drain_seen=1
    if [ "$ACTIVE_RUNS" = "0" ]; then
        log "✅ Old $ACTIVE drained — 0 active chat runs (${drain_waited}s)"
        break
    fi
    log "   … $ACTIVE_RUNS chat run(s) still active on old $ACTIVE (${drain_waited}s elapsed, max ${DRAIN_BUDGET}s)"
    sleep 10
    drain_waited=$((drain_waited + 10))
    # Deep-research extension (2026-10-20) — ONCE, when the retiring budget is
    # about to run out, and ONLY while the latest /drain-status (≤10 s old) says
    # a research council is still progressing ("researchExtensionEligible":true).
    # With no research run in flight the flag is false and this block is silent
    # (the WI-G block below then runs exactly as before). Capped at
    # DRAIN_RETIRING_TOTAL_CAP_SECONDS. Never fatal, never more than once.
    if [ "$drain_waited" -ge "$DRAIN_BUDGET" ] && [ "$drain_extended" -eq 0 ] && [ "$DRAIN_RETIRING" -eq 1 ] && [ "${DRAIN_RESEARCH_EXTENSION_SECONDS:-0}" -gt 0 ] 2>/dev/null && printf '%s' "$DRAIN_JSON" | grep -q '"researchExtensionEligible":true'; then
        drain_extended=1
        NEW_DRAIN_BUDGET=$(drain_extension_budget "$DRAIN_BUDGET" "$DRAIN_RESEARCH_EXTENSION_SECONDS" "$DRAIN_RETIRING_TOTAL_CAP_SECONDS" "$DRAIN_JSON" researchExtensionEligible)
        if [ "$NEW_DRAIN_BUDGET" -gt "$DRAIN_BUDGET" ]; then
            log "⏳ Retiring budget ${DRAIN_BUDGET}s reached with a progressing deep-research council on old $ACTIVE — extending ONCE to ${NEW_DRAIN_BUDGET}s (cap ${DRAIN_RETIRING_TOTAL_CAP_SECONDS}s; DRAIN_RESEARCH_EXTENSION_SECONDS=${DRAIN_RESEARCH_EXTENSION_SECONDS})"
            DRAIN_BUDGET=$NEW_DRAIN_BUDGET
        else
            log "   Retiring budget ${DRAIN_BUDGET}s reached — no research extension (the cap is reached)"
        fi
    fi
    # WI-G bounded retiring extension — DEFAULT OFF. With
    # DRAIN_RETIRING_EXTENSION_SECONDS=0 (the default) the last test below is
    # false and this block never runs, so DRAIN_BUDGET is exactly what it was.
    # Otherwise, ONCE, when the retiring budget is about to run out: extend it
    # only if the latest /drain-status (≤10 s old) says every remaining run is
    # a progressing supervisor wake ("extensionEligible":true), capped at
    # DRAIN_RETIRING_TOTAL_CAP_SECONDS. Never fatal, never more than once.
    if [ "$drain_waited" -ge "$DRAIN_BUDGET" ] && [ "$drain_extended" -eq 0 ] && [ "$DRAIN_RETIRING" -eq 1 ] && [ "${DRAIN_RETIRING_EXTENSION_SECONDS:-0}" -gt 0 ] 2>/dev/null; then
        drain_extended=1
        NEW_DRAIN_BUDGET=$(drain_extension_budget "$DRAIN_BUDGET" "$DRAIN_RETIRING_EXTENSION_SECONDS" "$DRAIN_RETIRING_TOTAL_CAP_SECONDS" "$DRAIN_JSON")
        if [ "$NEW_DRAIN_BUDGET" -gt "$DRAIN_BUDGET" ]; then
            log "⏳ Retiring budget ${DRAIN_BUDGET}s reached with $ACTIVE_RUNS progressing supervisor wake(s) — extending ONCE to ${NEW_DRAIN_BUDGET}s (cap ${DRAIN_RETIRING_TOTAL_CAP_SECONDS}s; DRAIN_RETIRING_EXTENSION_SECONDS=${DRAIN_RETIRING_EXTENSION_SECONDS})"
            DRAIN_BUDGET=$NEW_DRAIN_BUDGET
        else
            log "   Retiring budget ${DRAIN_BUDGET}s reached — no extension (remaining run(s) are not all progressing supervisor wakes, or the cap is reached)"
        fi
    fi
done
if [ "$drain_seen" -eq 1 ] && [ "${ACTIVE_RUNS:-0}" != "0" ] && [ "$drain_waited" -ge "$DRAIN_BUDGET" ]; then
    log "⚠️ Drain budget exhausted with $ACTIVE_RUNS chat run(s) still active on old $ACTIVE — proceeding; the SIGTERM ritual requeues them on the new color"
fi

# ── Stop old containers ────────────────────────────────────────────────────────
log "🛑 Stopping old $ACTIVE containers..."
sudo docker compose -p "crossmodel_${ACTIVE}" -f "$APP_COMPOSE" down --timeout 30 2>/dev/null || true

# Force remove if still lingering
for name in "admin-backend-${ACTIVE}" "admin-frontend-${ACTIVE}" "admin-worker-${ACTIVE}" "admin-relay-${ACTIVE}"; do
    sudo docker rm -f "$name" 2>/dev/null || true
done
log "✅ Old $ACTIVE containers removed"

# ── Cleanup ────────────────────────────────────────────────────────────────────
log "🧹 Cleaning up old Docker images..."
sudo docker image prune -a -f --filter "until=1h" 2>/dev/null || true
# deploy_speedups #8 (2026-09-26): the builder cache was already pruned once
# right after the build (the site that also covers failed deploys); this
# second walk cost ~17 s per box for nothing. BUILDER_PRUNE_ONCE_DISABLED=1
# restores it.
if [ "${BUILDER_PRUNE_ONCE_DISABLED:-0}" = "1" ]; then
    sudo docker builder prune -f --keep-storage "$BUILDER_CACHE_KEEP" 2>/dev/null || true
fi
log "✅ Cleanup complete"

# ── Final health verification ─────────────────────────────────────────────────
sleep 5
FINAL_HEALTH=$(curl -s "${PUBLIC_RESOLVE_ARGS[@]}" --max-time 10 "$PUBLIC_BASE_URL/api/health" 2>/dev/null || echo '{"status":"error"}')
FINAL_FE=$(curl -s "${PUBLIC_RESOLVE_ARGS[@]}" -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_BASE_URL" 2>/dev/null || echo "000")
# One retry: the frontend can be mid-restart for a beat right after cleanup
# (the 2026-07-29 502 taught us to distinguish a blip from a broken deploy).
if [ "$FINAL_FE" != "200" ] && [ "$FINAL_FE" != "304" ]; then
    sleep 5
    FINAL_FE=$(curl -s "${PUBLIC_RESOLVE_ARGS[@]}" -o /dev/null -w "%{http_code}" --max-time 10 "$PUBLIC_BASE_URL" 2>/dev/null || echo "000")
fi

log "=========================================="
log "🏁 DEPLOY COMPLETE"
log "   Active: $INACTIVE"
log "   Old: $ACTIVE (stopped)"
log "   Backend: $FINAL_HEALTH"
log "   Frontend: HTTP $FINAL_FE"
log "=========================================="

echo "$FINAL_HEALTH" | grep -q '"healthy"' || { log "❌ Final health check FAILED!"; exit 1; }
[ "$FINAL_FE" = "200" ] || [ "$FINAL_FE" = "304" ] || { log "❌ Final frontend check FAILED (HTTP $FINAL_FE)"; exit 1; }

log "✅ All checks passed — zero-downtime deploy successful!"
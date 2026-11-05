#!/usr/bin/env bash
# did-it-work-gate.sh — MANDATORY BLOCKING post-switch verification window
# (T2d, todo ea2483a8 / goal 0039c142, charter ticket b4824553; owner answer
# oq_e4f4e382 2026-10-16: "Yes to both — autonomous deploy loop").
#
# Runs inside deploy-blue-green.sh AFTER the nginx switch has passed its
# external health + authenticated recheck, and BEFORE the old color is
# drained. For ~5–10 minutes it watches the traffic-serving NEW color:
#   1. /api/health healthy + frontend HTTP 200/304 — every cycle
#   2. authenticated login/smoke (scripts/deploy-auth-smoke.sh) — fresh login
#      on cycle 1, token recheck after (access tokens live 15m > window)
#   3. error rate: app_error_logs level=error since the switch vs the SAME-DB
#      10-min pre-switch baseline (scripts/deploy/did-it-work-probe.js, run
#      inside the new backend container with the backend's own Prisma client)
#
# Any hard failure exits 42 — deploy-blue-green.sh flips nginx back to the
# verified color (revert_flip) and the workflow runs rollback.sh --to-live +
# resets main to the pre-deploy commit. 42 is ONLY this gate's code: a build,
# pre-flip or smoke failure keeps today's exit-1 semantics (no main reset —
# those never switched traffic).
#
# Activation: deploy-blue-green.sh exports IS_DID_IT_WORK=1 when the deploy is
# a switch that must prove itself (unset → exit 2, caller proceeds with legacy
# behavior). Kill switch: DID_IT_WORK_DISABLED=1 skips the window with a loud
# warning — an EMERGENCY lever for when the gate itself would block an urgent
# deploy; unset (the default) the gate ALWAYS runs. It is deliberately not a
# GitHub Variable: the owner confirmed the gate as standing policy.
#
# Fail-safe direction: the error-rate probe "unknown" (DB unreachable, probe
# crash) is retried and NEVER fails the deploy by itself — rolling back prod
# on a measurement we could not take trades a maybe-broken new version for a
# known-good one that was ALREADY verified by health + authenticated smoke.
# Those two stay hard-fatal in every configuration.
#
# Tuning (env, forwarded by deploy-blue-green.sh):
#   DID_IT_WORK_CYCLES            default 6
#   DID_IT_WORK_INTERVAL_SECONDS  default 60   (cycle spacing)
#   DID_IT_WORK_BLIP_SECONDS      default 30   (in-cycle re-probe after a blip)
#   DID_IT_WORK_WINDOW_MINUTES    default 6    (also the baseline look-back)
#   DID_IT_WORK_ERROR_FACTOR      default 5    (window rate must exceed
#                                               baseline × factor to fail)
#   DID_IT_WORK_ERROR_ROWS_FLOOR  default 10   (below it: not enough signal)
#
# Exit codes (pinned by did-it-work-gate.test.sh):
#   0  pass (or skipped via kill switch)
#   2  not active (IS_DID_IT_WORK unset — legacy manual-run contract)
#   3  gate cannot run (config error / missing file) — the caller fails CLOSED
#      (reverts the flip) but does NOT reset main: an infra problem, not a
#      code verdict (review m1, 2026-10-17)
#  42  VERDICT FAIL — roll back AND reset main (health, authenticated smoke,
#      or error rate)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH_SMOKE="${AUTH_SMOKE:-${SCRIPT_DIR}/../deploy-auth-smoke.sh}"
PROBE="${DID_IT_WORK_PROBE:-${SCRIPT_DIR}/did-it-work-probe.js}"

log() { echo "[did-it-work] $*"; }

int_env() { # $1 var name, $2 default, $3 min, $4 max — empty/non-numeric → default, then clamped
  local v="${!1:-}"
  case "$v" in ''|*[!0-9]*) v="$2" ;; esac
  if [ "$v" -lt "$3" ]; then v="$3"; fi
  if [ "$v" -gt "$4" ]; then v="$4"; fi
  echo "$v"
}
# Clamps are load-bearing (review m2, 2026-10-17): CYCLES=500 would outlive the
# 3300 s remote bound and die mid-window as rc=124 (rollback, no verdict).
CYCLES="$(int_env DID_IT_WORK_CYCLES 6 1 30)"
INTERVAL="$(int_env DID_IT_WORK_INTERVAL_SECONDS 60 5 600)"
BLIP_SECONDS="$(int_env DID_IT_WORK_BLIP_SECONDS 30 5 120)"
WINDOW_MINUTES="$(int_env DID_IT_WORK_WINDOW_MINUTES 6 1 30)"
ERROR_FACTOR="$(int_env DID_IT_WORK_ERROR_FACTOR 5 2 1000)"
ROWS_FLOOR="$(int_env DID_IT_WORK_ERROR_ROWS_FLOOR 10 1 100000)"

# ── Activation contract ───────────────────────────────────────────────────────
if [ "${IS_DID_IT_WORK:-0}" != "1" ]; then
    log "IS_DID_IT_WORK not set — not a did-it-work deploy (exit 2, caller keeps legacy flow)"
    exit 2
fi
if [ "${DID_IT_WORK_DISABLED:-0}" = "1" ]; then
    echo "::warning::[did-it-work] DID_IT_WORK_DISABLED=1 — post-switch window SKIPPED by kill switch (health+auth already verified pre-drain)"
    log "kill switch active — skipping"
    exit 0
fi

for req in PUBLIC_BASE_URL DID_IT_WORK_EPOCH DID_IT_WORK_CONTAINER; do
    [ -n "${!req:-}" ] || { log "❌ missing required env $req"; exit 3; }
done
[ -f "$AUTH_SMOKE" ] || { log "❌ auth smoke script not found: $AUTH_SMOKE"; exit 3; }
[ -f "$PROBE" ] || { log "❌ probe not found: $PROBE"; exit 3; }

# Pin connections to the box just deployed when PUBLIC_CHECK_IP is set (same
# derivation as deploy-auth-smoke.sh build_resolve_args: keep SNI/Host from
# the base URL, point the TCP connection at this box).
RESOLVE_ARGS=()
if [ -n "${PUBLIC_CHECK_IP:-}" ]; then
    _scheme=$(printf '%s' "$PUBLIC_BASE_URL" | sed -E 's|^([a-zA-Z]+)://.*|\1|')
    _host=$(printf '%s' "$PUBLIC_BASE_URL" | sed -E 's|^[a-zA-Z]+://([^:/]+).*|\1|')
    if [ "$_scheme" = "http" ]; then _port=80; else _port=443; fi
    RESOLVE_ARGS=(--resolve "${_host}:${_port}:${PUBLIC_CHECK_IP}")
fi

fail_gate() { # $1 = which check failed
    echo "::error::[did-it-work] FAILED: $1 — rolling back (exit 42)"
    log "❌ FAILED: $1"
    exit 42
}

health_ok() {
    local h c
    h=$(curl -s ${RESOLVE_ARGS[@]+"${RESOLVE_ARGS[@]}"} --max-time 10 "$PUBLIC_BASE_URL/api/health" 2>/dev/null || echo '{"status":"error"}')
    echo "$h" | grep -q '"healthy"' || return 1
    c=$(curl -s ${RESOLVE_ARGS[@]+"${RESOLVE_ARGS[@]}"} -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_BASE_URL" 2>/dev/null || echo "000")
    [ "$c" = "200" ] || [ "$c" = "304" ]
}

auth_ok() { # $1 = mode (new|recheck)
    SMOKE_RESOLVE_IP="${PUBLIC_CHECK_IP:-}" bash "$AUTH_SMOKE" "$1" "$PUBLIC_BASE_URL" "$TOKEN_FILE"
}

# run_probe — exec did-it-work-probe.js inside the new backend container
# (prodq.sh pattern: docker cp + docker exec -w /app; env is passed per-exec,
# smoke credentials NEVER reach the probe). Exit: 0 ok, 1 fail, 3 unknown.
run_probe() {
    local rc=0 name="diw_$(date +%s%N)_$RANDOM.js"
    sudo docker cp "$PROBE" "${DID_IT_WORK_CONTAINER}:/tmp/$name" >/dev/null 2>&1 || { return 3; }
    sudo docker exec -w /app \
        -e SWITCH_EPOCH_UTC="$DID_IT_WORK_EPOCH" \
        -e WINDOW_MINUTES="$WINDOW_MINUTES" \
        -e DID_IT_WORK_ERROR_FACTOR="$ERROR_FACTOR" \
        -e DID_IT_WORK_ERROR_ROWS_FLOOR="$ROWS_FLOOR" \
        "$DID_IT_WORK_CONTAINER" node "/tmp/$name" || rc=$?
    sudo docker exec "$DID_IT_WORK_CONTAINER" rm -f "/tmp/$name" >/dev/null 2>&1 || true
    [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || [ "$rc" -eq 3 ] || rc=3
    return "$rc"
}

TOKEN_FILE=$(mktemp)
trap 'rm -f "$TOKEN_FILE"' EXIT
chmod 600 "$TOKEN_FILE"

log "🚦 post-switch did-it-work window: ${CYCLES} cycles × ${INTERVAL}s (~$((CYCLES * INTERVAL))s) against $PUBLIC_BASE_URL"
log "   epoch=$DID_IT_WORK_EPOCH container=$DID_IT_WORK_CONTAINER error-factor=$ERROR_FACTOR rows-floor=$ROWS_FLOOR"

probe_answered=0
for cycle in $(seq 1 "$CYCLES"); do
    log "── cycle ${cycle}/${CYCLES} ──"

    if ! health_ok; then
        log "health blip — re-probing in ${BLIP_SECONDS}s"
        sleep "$BLIP_SECONDS"
        health_ok || fail_gate "health check (api/health or frontend) failed in cycle ${cycle}"
    fi

    mode="recheck"
    [ "$cycle" -eq 1 ] && mode="new"
    if ! auth_ok "$mode"; then
        # Re-login FRESH on the blip retry (review m3, 2026-10-17): a blip-heavy
        # window can outlive the cycle-1 token (JWT_EXPIRES_IN=15m), and a stale
        # token would 401 a healthy deploy — the retry mints a new one.
        log "auth blip — fresh login + re-probe in ${BLIP_SECONDS}s"
        sleep "$BLIP_SECONDS"
        auth_ok new || auth_ok recheck || fail_gate "authenticated smoke failed in cycle ${cycle}"
    fi

    rc=0; run_probe || rc=$?
    if [ "$rc" -eq 3 ]; then
        log "probe unknown — one retry in ${BLIP_SECONDS}s"
        sleep "$BLIP_SECONDS"
        rc=0; run_probe || rc=$?
    fi
    case "$rc" in
        0) probe_answered=1 ;;
        1) probe_answered=1; fail_gate "error rate above baseline × ${ERROR_FACTOR} in cycle ${cycle}" ;;
        *) log "::warning::[did-it-work] error-rate probe still unknown in cycle ${cycle} (rc=$rc) — continuing on health+auth evidence" ;;
    esac

    [ "$cycle" -lt "$CYCLES" ] && sleep "$INTERVAL"
done

if [ "$probe_answered" -eq 0 ]; then
    echo "::warning::[did-it-work] error-rate probe NEVER answered — passing on health + authenticated-smoke evidence only (probe observability gap, not a deploy failure)"
fi
log "✅ did-it-work window passed — new color keeps traffic"
exit 0

#!/usr/bin/env bash
# Regression test — blue-green health-gate budget invariants (ticket dcf9056a, 2026-08-31).
#
# The 2026-08-31 deploy block: the worker's docker healthcheck budget
# (start_period 45s + interval 15s × retries 10 → docker declares the container
# 'unhealthy' at ~195s) collided with a ~190s loaded-box boot. deploy-blue-green.sh's
# wait_for_healthy fail-fasts on the first 'unhealthy' reading, so the gate killed
# 2 consecutive deploys SECONDS before the worker went live (auto-rollback kept
# prod safe on the old color throughout).
#
# The 2026-08-31 deploy block #2 (ticket e1479b24): the BACKEND's healthcheck
# budget (start_period 120s + 9×10s → unhealthy at ~210s) collided with a
# >204s loaded-box boot on host A — deploy 33376975655's backend passed at
# 201s (9s margin) and deploy 33379305472's failed mid-boot at ~205s. Same
# fail-fast mechanism as the worker incident above, one service over.
#
# Invariants asserted, per tier in docker-compose.app.yml against deploy-blue-green.sh:
#   1. FAIL-FAST WINS:  start_period + interval×retries  <  HEALTH_TIMEOUT
#      A genuinely-broken container must be caught by the 'unhealthy' fail-fast
#      branch BEFORE the gate's own ceiling — the invariant HEALTH_TIMEOUT's
#      comment documents ("must sit ABOVE docker's unhealthy point").
#   2. BOOT HEADROOM (worker only): start_period ≥ 240s
#      Docker must not declare 'unhealthy' during a slow-but-normal boot:
#      2026-08-31 observed ~190s; a start_period above that means zero counted
#      failures during boot, then interval×retries of tolerance on top.
#   3. BOOT HEADROOM (backend only): start_period ≥ 240s
#      2026-08-31 observed 201s pass / >204s fail (ticket e1479b24).
#
# Plain-bash idiom, mirrors scripts/deploy/apply-env-overrides.test.sh.
# Run from anywhere: bash scripts/deploy/blue-green-health-budget.test.sh

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/docker-compose.app.yml"
DEPLOY="$ROOT/deploy-blue-green.sh"

failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }

for f in "$COMPOSE" "$DEPLOY"; do
  [ -f "$f" ] || { bad "missing file: $f"; echo "$failures invariant(s) violated" >&2; exit 1; }
done

HEALTH_TIMEOUT=$(sed -n 's/^HEALTH_TIMEOUT=\([0-9][0-9]*\).*/\1/p' "$DEPLOY" | head -1)
if [ -z "$HEALTH_TIMEOUT" ]; then
  bad "could not parse HEALTH_TIMEOUT from $DEPLOY"
  echo "$failures invariant(s) violated" >&2
  exit 1
fi

# Print one healthcheck field (integer seconds) for a service block, or nothing.
# Service headers are exactly 2-space-indented `name:` lines; healthcheck fields
# sit deeper inside the same block.
hc() {
  awk -v svc="$1" -v field="$2" '
    $0 == "  " svc ":" { in_svc = 1; next }
    /^  [a-z0-9-]+:$/ { in_svc = 0 }
    in_svc && $1 == field ":" {
      v = $2; gsub(/[^0-9]/, "", v); print v; exit
    }
  ' "$COMPOSE"
}

check_tier() {
  local svc="$1" sp iv rt point
  sp=$(hc "$svc" start_period); iv=$(hc "$svc" interval); rt=$(hc "$svc" retries)
  if [ -z "$sp" ] || [ -z "$iv" ] || [ -z "$rt" ]; then
    bad "$svc: missing healthcheck numbers (start_period='$sp' interval='$iv' retries='$rt') — the gate waits on this tier"
    return
  fi
  point=$((sp + iv * rt))
  if [ "$point" -lt "$HEALTH_TIMEOUT" ]; then
    ok "$svc: unhealthy point ${point}s (${sp} + ${iv}×${rt}) < HEALTH_TIMEOUT ${HEALTH_TIMEOUT}s — broken $svc fails fast, not times out"
  else
    bad "$svc: unhealthy point ${point}s (${sp} + ${iv}×${rt}) must stay BELOW HEALTH_TIMEOUT ${HEALTH_TIMEOUT}s — otherwise a broken $svc stalls the gate to the ceiling instead of failing fast"
  fi
}

for tier in backend frontend relay worker; do
  check_tier "$tier"
done

WORKER_SP=$(hc worker start_period)
if [ -n "$WORKER_SP" ] && [ "$WORKER_SP" -ge 240 ]; then
  ok "worker: start_period ${WORKER_SP}s ≥ 240s — above the 2026-08-31 ~190s loaded boot (ticket dcf9056a)"
else
  bad "worker: start_period '${WORKER_SP:-?}s' must be ≥240s — docker declared a ~190s normal boot 'unhealthy' at ~195s and blocked 2 consecutive deploys (ticket dcf9056a)"
fi

BACKEND_SP=$(hc backend start_period)
if [ -n "$BACKEND_SP" ] && [ "$BACKEND_SP" -ge 240 ]; then
  ok "backend: start_period ${BACKEND_SP}s ≥ 240s — above the 2026-08-31 >204s loaded boot (ticket e1479b24)"
else
  bad "backend: start_period '${BACKEND_SP:-?}s' must be ≥240s — docker declared a >204s normal boot 'unhealthy' at ~205s and failed deploy 33379305472 (ticket e1479b24)"
fi

if [ "$failures" -eq 0 ]; then
  echo "blue-green health-budget invariants OK"
else
  echo "$failures invariant(s) violated" >&2
  exit 1
fi

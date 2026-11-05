#!/usr/bin/env bash
# deploy-wedge-bounds.test.sh — static pins for the 2026-09-20 deploy-wedge
# fixes (feedback ticket 6d8d8beb).
#
# INCIDENT: two consecutive deploy runs (35532250231 sha 56894514,
# 35533974170 sha 14abeeeb) wedged mid "Deploy CrossModel" job on 2026-09-20
# evening UTC — a live-but-hung phase (ssh keepalives, added 2026-08-31, only
# kill DEAD transports; an on-box docker build/pull stall or a stalled rsync
# keeps the session alive forever) — and held the serialized deploy-production
# concurrency group until manual agent cancels (20:16Z / 21:10Z). The deploy
# watchdog FIRED mid-wedge at 21:05Z and correctly declined to cancel the
# 46-min-silent run: STALE_MINUTES=150 was deliberately ABOVE the Deploy
# job's timeout-minutes:120, so the watchdog could never beat the server-side
# kill — the threshold inversion, not the cron, was the gap (though the same
# day showed multi-hour GitHub schedule drops: 06:54Z → 12:13Z silent).
#
# Invariants asserted (a regression on any one re-opens the wedge class):
#   1. deploy.yml's per-host blue-green driver runs the remote script under a
#      REMOTE-side timeout (kills the on-box tree in place — a runner-side
#      kill would orphan the script mid-flip and race the auto-rollback).
#   2. deploy.yml's repo rsync carries a runner-side timeout (orphan-safe:
#      closing the transport ends the remote rsync).
#   3. deploy-watchdog.sh's default STALE_MINUTES is 100 — ABOVE the longest
#      observed healthy Deploy job (72.4 min + ~12 min did-it-work window
#      since T2d 2026-10-17) and BELOW the
#      Deploy job's timeout-minutes:120, so the watchdog beats the
#      server-side kill while never cancelling a healthy run.
#   4. deploy-watchdog.yml schedules TWO offset cron grids (GitHub schedule
#      drops are per-event; two independent grids halve the silent window).
#   5. The Deploy job's 120-min outer bound stays in place (the watchdog is
#      an optimization over it, never a replacement).
#
# Plain-bash idiom, mirrors blue-green-health-budget.test.sh.
# Run from anywhere: bash scripts/deploy/deploy-wedge-bounds.test.sh

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_YML="$ROOT/.github/workflows/deploy.yml"
WATCHDOG_YML="$ROOT/.github/workflows/deploy-watchdog.yml"
WATCHDOG_SH="$ROOT/scripts/deploy/deploy-watchdog.sh"

failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }

# 1. Remote-side timeout on the per-host blue-green driver (ticket 6d8d8beb).
# 2026-10-17 (T2d, ticket b4824553): 2700 → 3300 — the mandatory post-switch
# did-it-work window adds ~6 min per host after the flip; the old 45-min bound
# sat ~4 min above the slowest observed healthy phase (41.1 min) and would now
# time a healthy deploy out mid-window.
if grep -q 'timeout --signal=TERM --kill-after=30 3300 bash deploy-blue-green.sh' "$DEPLOY_YML"; then
  ok "blue-green driver bounded by a remote-side 55-min timeout"
else
  bad "deploy.yml blue-green driver lost its remote-side timeout wrap"
fi

# 2. Runner-side timeout on the repo rsync.
if grep -q 'timeout --signal=TERM --kill-after=10 1200 rsync' "$DEPLOY_YML"; then
  ok "repo rsync bounded by a runner-side 20-min timeout"
else
  bad "deploy.yml rsync lost its runner-side timeout wrap"
fi

# 3. Watchdog default STALE_MINUTES == 100 (parse the actual default, never a
#    literal grep that a comment could satisfy).
stale=$(grep -m1 '^STALE_MINUTES="\${STALE_MINUTES:-[0-9]*}"$' "$WATCHDOG_SH" | grep -o '[0-9]*')
if [ "$stale" = "100" ]; then
  ok "watchdog default STALE_MINUTES is 100"
else
  bad "watchdog default STALE_MINUTES is '$stale' (want 100)"
fi

# 3b. 100 sits strictly between the healthy-job max (72.4 + ~12 did-it-work)
#     and the job timeout.
if [ -n "$stale" ] && [ "$stale" -gt 84 ] && [ "$stale" -lt 120 ]; then
  ok "84 (healthy max + did-it-work window) < STALE_MINUTES ($stale) < 120 (job timeout)"
else
  bad "STALE_MINUTES '$stale' outside the (84, 120) safety band"
fi

# 4. Two offset cron grids on the watchdog schedule.
cron_n=$(grep -c "^    - cron: '" "$WATCHDOG_YML")
if [ "$cron_n" = "2" ]; then
  ok "deploy-watchdog.yml carries two cron grids"
else
  bad "deploy-watchdog.yml carries $cron_n cron grid(s) — want 2"
fi

# 5. The Deploy job's 120-min server-side outer bound is intact.
if grep -q 'timeout-minutes: 120' "$DEPLOY_YML"; then
  ok "Deploy job keeps its 120-min timeout-minutes outer bound"
else
  bad "Deploy job timeout-minutes:120 missing — the outer bound regressed"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "deploy-wedge-bounds tests OK"
else
  echo "$failures assertion(s) failed" >&2
  exit 1
fi

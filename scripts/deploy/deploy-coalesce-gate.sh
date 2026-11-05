#!/usr/bin/env bash
# deploy-coalesce-gate.sh — the "Skip if a newer deploy is queued" gate,
# extracted from .github/workflows/deploy.yml (nightly shortfall hunt
# 2026-10-15, goal b3f240e4). Called by the gate job with GH_TOKEN/RUN_ID/REPO
# env and $GITHUB_OUTPUT; writes superseded=yes|no.
#
# WHAT THE GATE IS FOR (unchanged since PR #573, 2026-09-01, owner: "can't we
# just catch up everything in one big deploy"): with the serialized
# deploy-production queue, N pushes used to mean N full ~19-min deploys
# through STALE shas. When this run's turn comes, the gate checks whether a
# NEWER run of the deploy workflow is still waiting. If so, this run's sha is
# stale — the whole deploy job is skipped (~30 s instead of ~19 min) and the
# newest run deploys everything in ONE go. Never deadlocks: a skipped run
# completes in seconds, releasing the queue for the next.
#
# WHY THE EXTRACTION (2026-10-15): the inline gate had been silently disabled
# in production. Live evidence (gate logs, this hunt):
#   run 38732795715 (2026-10-15T12:11:48Z), run 38758671580 (15:15:16Z) and
#   run 38762990699 (15:44:40Z) all printed
#     "newer queued: {"message":"Resource not accessible by integration",
#      …,"status":"403"}0 · newer in-progress: {…403…}0 · newer pending: {…403…}0"
#   on EVERY probe. Three defects stacked:
#   1. PERMISSIONS: the gate job declared no permissions block, so it ran on
#      the repo-default read-only GITHUB_TOKEN with NO actions:read — the
#      runs listing 403s ("Resource not accessible by integration"). Fixed
#      in deploy.yml (gate job: actions: read), not here.
#   2. ERROR MASKING: `gh api … 2>/dev/null || echo 0` made that 403
#      byte-identical to "no newer runs" — the exact class ticket 0cea589d
#      fixed in verify-wave.sh ("an AUTH failure byte-identical to
#      cause=empty_wave"). Here the gh JSON body landed IN the variable and
#      still "succeeded", so the || never even fired.
#   3. CORRUPT COUNT: [ "{…403…}0" -gt 0 ] is bash's integer-test ERROR
#      path — errors out FALSE, so the gate answered superseded=no on every
#      run, silently, with the log line sitting there in plain sight.
#   Net: coalescing never fired (0 sub-minute/skipped deploy runs in the
#   last 200), every merge wave paid N serialized stale-sha deploys, and the
#   broken gate was invisible because it "worked" (deploy still ran).
#
#   Same law as deploy-watchdog.sh (tickets 4b432e90/e1ccaa80) and
#   verify-wave.sh (0cea589d): a probe that cannot answer must FAIL LOUD,
#   never fail toward a quiet default. Here the fail-safe direction is
#   superseded=no (deploy anyway) + a ::warning:: so the regression is
#   observable from the Actions summary: a wrongly-SKIPPED deploy would
#   leave prod on an old sha with NOTHING to redeploy it, which is strictly
#   worse than a redundant ~19-min deploy of an already-superseded sha.
#   deploy-watchdog.sh stays the un-wedging safety net for queue health.
#
# The client-side .path filter: GitHub IGNORES the workflow_id query param on
# the repo-wide runs endpoint (verified live 2026-09-18, tickets
# 4b432e90/e1ccaa80: filename AND numeric-id forms both returned
# CI/healthcheck runs). Unfiltered counts would count every newer queued
# CI/healthcheck run as a "newer deploy" — a false supersede that could skip
# a deploy without deploying anything.
#
# The pending hole (adversarial review of the deploy-watchdog fix,
# live-verified 2026-09-18 on run 35295308698): a concurrency-BLOCKED deploy
# run reports status=pending — invisible to the status=queued AND
# status=in_progress listings. A single UNFILTERED snapshot with a
# .status != "completed" filter covers queued, pending, waiting, requested,
# in_progress and any future non-terminal status in ONE call (one call, one
# failure surface — three per-status calls were three chances to miss one).
#
# Usage (deploy.yml gate job):
#   env: GH_TOKEN/RUN_ID/REPO, run: bash scripts/deploy/deploy-coalesce-gate.sh
# Requires: gh, jq. Harness: scripts/deploy/deploy-coalesce-gate.test.sh.
set -u

DEPLOY_PATH=${DEPLOY_PATH:-.github/workflows/deploy.yml}

log()  { echo "coalesce-gate: $*"; }
warn() { echo "::warning::coalesce-gate: $*"; }

require_numeric() { # $1=value $2=label — a gated count that is not a
  case "$1" in     # non-negative integer means the probe result was
    ''|*[!0-9]*)  # partial/corrupt (e.g. an API error body glued onto it)
      warn "$2 unparsable ('$1') — probe FAILED; defaulting superseded=no (deploy anyway) so a broken probe can never strand main; fix the probe (permissions? gh api?) — do NOT ignore this warning"
      echo "superseded=no" >> "${GITHUB_OUTPUT:-/dev/null}"
      exit 0 ;;
  esac
}

[ -n "${RUN_ID:-}" ] || { warn "RUN_ID unset — probe unusable; defaulting superseded=no (deploy anyway)"; echo "superseded=no" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 0; }
[ -n "${REPO:-}" ]  || { warn "REPO unset — probe unusable; defaulting superseded=no (deploy anyway)";   echo "superseded=no" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 0; }

# --- ONE unfiltered snapshot, gh failure made loud --------------------------
# Exit code captured BEFORE any if-negation (0cea589d law: stderr alone would
# make an auth/HTTP failure look like an empty answer). gh prints its own
# error to stderr; rc!=0 bails with a warning instead of trusting any body
# (the live 2026-10-15 403s printed the error body to stdout with rc=1, and
# the old `|| echo 0` glued a 0 onto it — BOTH shapes must land here).
SNAPSHOT=$(gh api "repos/$REPO/actions/runs?per_page=100" 2>&1)
GH_RC=$?
if [ "$GH_RC" -ne 0 ]; then
  warn "gh api failed rc=$GH_RC — coalescing probe FAILED, defaulting superseded=no (deploy anyway): $(printf '%s' "$SNAPSHOT" | head -c 200)"
  echo "superseded=no" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi
# A body that does not decode as the runs listing is the same failure class.
if ! RUNS_JSON=$(printf '%s' "$SNAPSHOT" | jq -e '.workflow_runs' 2>/dev/null); then
  warn "snapshot did not decode to a runs listing — probe FAILED, defaulting superseded=no (deploy anyway): $(printf '%s' "$SNAPSHOT" | head -c 200)"
  echo "superseded=no" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

# --- Count newer non-terminal runs of THIS workflow, client-side -----------
# .path filter (workflow_id param is ignored by GitHub) + .id > RUN_ID +
# .status != "completed" (the pending hole: ANY non-terminal status counts).
NEWER=$(printf '%s' "$RUNS_JSON" | jq -r \
  --arg p "$DEPLOY_PATH" --argjson me "$RUN_ID" \
  '[.[] | select(.path == $p) | select(.id > $me) | select(.status != "completed")] | length')
require_numeric "$NEWER" "newer-non-terminal count"

log "newer non-terminal deploy runs (queued/pending/waiting/requested/in_progress/…): $NEWER (run $RUN_ID, snapshot $(printf '%s' "$RUNS_JSON" | jq -r 'length') runs, path-filtered to $DEPLOY_PATH)"

if [ "$NEWER" -gt 0 ]; then
  echo "This run's sha is STALE — a newer deploy is already waiting. Skipping; the newest run deploys everything in one go."
  echo "superseded=yes" >> "${GITHUB_OUTPUT:-/dev/null}"
else
  echo "superseded=no" >> "${GITHUB_OUTPUT:-/dev/null}"
fi

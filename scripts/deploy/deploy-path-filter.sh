#!/usr/bin/env bash
# deploy-path-filter.sh — "docs-only pushes skip the production deploy"
# (framework audit 2026-10-15, todo 03bdbf26): 29 of 66 deploy waves in 72 h
# shipped no runtime change (~20 min + a backend restart each — blue-green
# "succeeded" while nothing changed, and every restart is a live-traffic
# blip). This script decides, for the sha a deploy run woke on, whether the
# push touched any RUNTIME file: if not (.digby/**, docs/**, memory-bank/**,
# *.md, test files only), the deploy job is skipped — CI still runs on its
# own push trigger, and a manual workflow_dispatch always deploys.
#
# DESIGN (the coalesce-gate law, scripts/deploy/deploy-coalesce-gate.sh):
# the decision lives in a TESTED script, never inline YAML — the inline
# coalesce gate ran silently broken for weeks because it had zero test
# coverage. Harness: scripts/deploy/deploy-path-filter.test.sh (runs in
# ci.yml's shell-scripts loop like every scripts/deploy/*.test.sh).
#
# NOT paths-ignore (deliberate — 2026-10-16):
#   1. A trigger filter makes the deploy run row NEVER EXIST. The whole
#      safety net counts deploy.yml runs client-side: the coalesce gate's
#      "newer run waiting" probe and the watchdog's orphan re-dispatch arm
#      (scripts/deploy/deploy-watchdog.sh) would go blind exactly when a
#      docs wave lands mid-queue.
#   2. deploy-healthcheck.yml's workflow_run trigger needs a completed
#      deploy run to fire its post-deploy stabilization check.
#   3. A deploy-PATH change that itself touched only docs would never get
#      deployed. A job-level skip keeps the row: green, logged, countable,
#      and the workflow_dispatch escape hatch re-deploys main on demand.
#
# FAIL-SAFE DIRECTION: unknown ⇒ deploy. A wrongly-SKIPPED deploy strands
# main with nothing to redeploy it (the coalesce gate's law); a redundant
# ~19-min deploy of an unchanged sha is the status quo we are optimizing,
# never an outage. Every unanswerable case (no git, bad rev, empty diff
# listing) defaults to runtime=yes.
#
# Usage (deploy.yml gate job, after actions/checkout):
#   bash scripts/deploy/deploy-path-filter.sh            # decides for HEAD
#   BEFORE_SHA=... AFTER_SHA=... bash ...                # explicit pair
# Writes runtime=yes|no to $GITHUB_OUTPUT and echoes the same to stdout.
# Env: BEFORE_SHA / AFTER_SHA (default: HEAD^..HEAD), DEPLOY_EVENT (github
# event_name; anything != push deploys — the escape hatch), GITHUB_OUTPUT.
set -u

log()  { echo "path-filter: $*"; }
warn() { echo "::warning::path-filter: $*"; }

runtime_yes() { # $1 = reason (always deploy)
  log "runtime=yes — $1"
  echo "runtime=yes" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
}
runtime_no() { # $1 = reason (skip deploy)
  log "runtime=no — $1"
  echo "runtime=no" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
}

# THE MANUAL ESCAPE HATCH: workflow_dispatch ALWAYS deploys — a docs-only
# push that genuinely must deploy (env change riding a docs wave, a box
# drifted off main, an owner "redeploy now") is one manual dispatch away,
# which is also why the filter must never be a trigger paths-ignore.
# (Must run AFTER the function definitions: bash cannot call a function
# before its definition line — the first cut sat above them, errored to
# stderr, and fell through to classify the push anyway. Pinned by the
# workflow_dispatch leg of the harness.)
[ "${DEPLOY_EVENT:-}" = "push" ] || runtime_yes "event '${DEPLOY_EVENT:-unknown}' is not a push — manual dispatch / schedule always deploys (the escape hatch)"

command -v git >/dev/null 2>&1 || runtime_yes "git not found (runner without checkout?) — cannot decide, deploying"
command -v awk >/dev/null 2>&1 || runtime_yes "awk not found — cannot classify, deploying"

AFTER="${AFTER_SHA:-HEAD}"
# No BEFORE_SHA → HEAD^ (the push that woke this run). An empty diff against
# a missing parent means git cannot answer → deploy (fail-safe).
if [ -z "${BEFORE_SHA:-}" ]; then
  git rev-parse --verify --quiet "${AFTER}^" >/dev/null 2>&1 \
    || runtime_yes "no parent commit for ${AFTER} (initial push / shallow) — cannot diff, deploying"
  BEFORE="${AFTER}^"
else
  git rev-parse --verify --quiet "$BEFORE_SHA" >/dev/null 2>&1 \
    || runtime_yes "BEFORE_SHA '$BEFORE_SHA' unresolvable — cannot diff, deploying"
  BEFORE="$BEFORE_SHA"
fi

# --- List changed files. git diff-tree reads the commit pair directly; an
# empty listing on a real commit pair is a probe failure, not "no changes".
CHANGED=$(git diff-tree --no-commit-id --name-only -r "$BEFORE" "$AFTER" 2>/dev/null)
if [ -z "$CHANGED" ]; then
  runtime_yes "empty diff listing for $BEFORE..$AFTER — probe failure or empty commit, deploying"
fi

# --- The skip set (todo 03bdbf26): .digby/**, docs/**, memory-bank/**,
# *.md anywhere, and test files (*.test.ts / *.test.sh / *.test.tsx / *.spec.ts
# / backend tests/**). Anything else is runtime. Deny by default: a file that
# matches NO rule deploys. THE SET ITSELF lives in
# scripts/deploy/runtime-skip-set.awk — shared verbatim with
# deploy-strand-probe.sh (ticket a4309ef9) so the two questions ("is this
# push runtime?" / "is anything undeployed runtime?") can never drift.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
RUNTIME_FILES=$(printf '%s\n' "$CHANGED" | awk -f "$SCRIPT_DIR/runtime-skip-set.awk")
AWK_RC=$?
[ "$AWK_RC" -ne 0 ] && runtime_yes "awk classifier died rc=$AWK_RC - cannot classify, deploying"
# (`next`, never `continue`: awk's main block is NOT a loop - gawk FATALS on
# `continue` outside a loop, which killed the first cut of this filter with
# EVERY push classified docs-only. The rc check above makes ANY future awk
# death fail OPEN toward deploy instead of silently skipping.)

if [ -n "$RUNTIME_FILES" ]; then
  N=$(printf '%s\n' "$RUNTIME_FILES" | wc -l | tr -d ' ')
  log "runtime files (${N}): $(printf '%s' "$RUNTIME_FILES" | head -5 | tr '\n' ' ')$( [ "$N" -gt 5 ] && echo ' …')"
  echo "runtime=yes" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

# --- THE STRAND GUARD (ticket a4309ef9, 2026-10-16) -------------------------
# The push's own diff is docs-only — but the push may be SITTING ON
# undeployed runtime changes: reproduce-live 2026-10-16, merge c67577e9e (29
# runtime files) → deploy wave 38912911194 CANCELLED before its gate ran
# (one-running+one-pending rule) → the docs-only successor push's carrier
# run 38913411207 answered runtime=no from HEAD^..HEAD, skipped its Deploy
# job, and concluded SUCCESS — main stranded with nothing in any safety net
# (the carrier is green; deploy-watchdog.sh's re-dispatch arm fires only on
# cancelled|timed_out). Guard: before answering no, ask the tested probe
# scripts/deploy/deploy-strand-probe.sh whether anything RUNTIME is
# undeployed in last-delivered..HEAD.
#
# The guard needs the Actions API (GH_TOKEN + REPO, both passed by
# deploy.yml's pf step). WITHOUT them the guard is INERT and the answer is
# the pre-guard one (runtime=no) plus a ::warning:: — never a silent no-op
# (a CI misconfig that drops the env would otherwise quietly re-open the
# strand hole). Pinned by the harness: no-creds docs-only → no + warning.
STRAND_PROBE="$SCRIPT_DIR/deploy-strand-probe.sh"
if [ ! -f "$STRAND_PROBE" ]; then
  runtime_yes "strand probe script missing at $STRAND_PROBE — cannot prove nothing is undeployed, deploying (fail-open)"
fi
if [ -z "${GH_TOKEN:-}" ] || [ -z "${REPO:-}" ]; then
  # Inside GitHub Actions the pf step ALWAYS passes both (deploy.yml) —
  # missing creds there means a workflow mis-edit, and the safe answer is
  # DEPLOY (fail-open: a wrongly-skipped deploy strands main). A genuinely
  # local run (no GITHUB_ACTIONS) stays inert + warning: the operator is
  # standing right there and the push-diff answer is honest local output.
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    runtime_yes "strand guard UNUSABLE in CI (GH_TOKEN/REPO missing from the gate env — deploy.yml mis-edit?) — deploying (fail-open)"
  fi
  warn "strand guard inert (GH_TOKEN/REPO not set — local or unauthenticated run): answering from the push diff alone; CI runs the full guard"
  N=$(printf '%s\n' "$CHANGED" | wc -l | tr -d ' ')
  runtime_no "docs/test-only push ($N files: .digby/ docs/ memory-bank/ *.md tests; strand guard inert) — production deploy SKIPPED (CI still runs; workflow_dispatch deploys)"
fi
PROBE_OUT=$(REPO="$REPO" GH_TOKEN="$GH_TOKEN" HEAD_SHA="$AFTER" bash "$STRAND_PROBE" 2>&1)
PROBE_ANSWER=$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^stranded=//p' | tail -1)
case "$PROBE_ANSWER" in
  no)  : ;; # nothing undeployed — fall through to runtime=no
  yes)
    # the probe's own walk log (which run delivered, what's undeployed) is
    # the ONLY way to debug a spurious catch-up deploy from the Actions
    # summary — surface it, never swallow it (adversarial-review finding)
    printf '%s\n' "$PROBE_OUT" | sed 's/^/path-filter: [strand-guard] /'
    runtime_yes "strand guard: undeployed runtime changes sit under this docs-only push (cancelled deployable wave upstream) — deploying to un-strand main"
    ;;
  *)   runtime_yes "strand probe unanswerable ('$PROBE_ANSWER') — deploying (fail-open)" ;;
esac

N=$(printf '%s\n' "$CHANGED" | wc -l | tr -d ' ')
runtime_no "docs/test-only push ($N files: .digby/ docs/ memory-bank/ *.md tests; strand guard clear) — production deploy SKIPPED (CI still runs; workflow_dispatch deploys)"

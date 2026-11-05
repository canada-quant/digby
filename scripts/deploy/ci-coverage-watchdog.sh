#!/usr/bin/env bash
# ci-coverage-watchdog.sh — never let a main HEAD land with ZERO CI (feedback
# ticket fb707538, 2026-10-06; incident: the roster waves e8fcfb8d/54e097cb).
#
# INCIDENT CLASS: commits landed on main through the Contents/PR REST dispatch
# path (single-parent squash "merge: K…" lands, direct base-branch PUTs) create
# NO refs/heads push event — GitHub's `push: branches: [main]` trigger never
# fires for them, so those heads carry ZERO CI. 13 of the 25 newest main
# commits at diagnosis time (2026-10-06 22:00Z) had no CI at all, including
# the code wave whose broken roster test made two deploy runs fail (the DEPLOY
# was the first CI-equivalent run on that code). The platform's own merge gate
# passed those merges as `ci: no_ci (repo has no CI)` — a verdict written for
# docs repos — so nothing flagged the gap.
#
# THIS SWEEP is the backstop: every 15 minutes (two offset cron grids —
# scheduled runs are best-effort), if main HEAD has zero CI coverage, dispatch
# the CI workflow on main (workflow_dispatch added to ci.yml for exactly this
# call — GITHUB_TOKEN's actions:write + workflow_dispatch is the documented
# exception to the no-recursive-triggers rule, the deploy-watchdog's proven
# pattern).
#
# WHAT COUNTS AS COVERED (adversarial review 0bdc8200, BLOCKING self-masking
# finding, 2026-10-07): coverage is derived from THE CI WORKFLOW'S OWN RUNS,
# never from repo-wide check-run counts. A repo-wide count self-masks in one
# direction — the watchdog's own scheduled run (and every other scheduled
# sweep: deploy-watchdog, healthchecks) attaches ITS check-runs at main HEAD,
# so a head whose CI never ran can still read >0 and the rescue never fires —
# and is lossy in the other (the four REST-landed shas aec4b477c/cae452485/
# 2df912915/2221dca4 sat at ZERO check-runs for hours while dozens of
# scheduled sweeps ran). The CI-scoped signal is immune to both: a run counts
# only when its .path is the CI workflow AND its .head_sha is the head, with
# the sweep's OWN run excluded by id (defense-in-depth — the path filter
# already excludes it, since this sweep's own path is ci-coverage-watchdog.yml).
# This is the same client-side path filter deploy-watchdog.sh uses (FILTER
# NOTE there: GitHub IGNORES the workflow_id query param on the repo-wide
# runs endpoint — verified live 2026-09-18 — so the filter must be
# client-side). The repo-wide check-run count is deliberately NOT read at all.
#
# WHY NOT `actions/runs?head_sha=X`: that query parameter is LOSSY for
# freshly-created runs (verified live 2026-10-06: zero rows returned twice
# while the CI run existed; the branch-listing probe found it). "Zero CI runs
# at HEAD" is therefore established by an EMPTY client-side-filtered list out
# of the plain repo-wide newest-runs listing, never by a head_sha= query
# answering zero.
#
# THE PAGE-BOUNDARY PROOF: the coverage listing is per_page=100 of the NEWEST
# runs. A covering CI run at the head could exist yet fall outside the page
# only if 100+ runs were created after it — impossible for a run at a head
# that still IS main HEAD unless the head landed before the page's oldest run.
# So the sweep compares the page's OLDEST run created_at against the head's
# COMMIT DATE: oldest <= head-landed proves every run created after the
# landing is on the page, making "zero CI runs at head" a proof, not an
# approximation. When it cannot be proven the sweep warns and aborts
# (fail-safe) — that head stays unrescued by the watchdog, but the merge gate
# (same ticket) refuses no_ci, so the class is still caught.
#
# The DAILY BUDGET uses its own event-filtered listing
# (`?event=workflow_dispatch`, client-side path-filtered to the CI workflow):
# CI dispatch runs are rare (this watchdog is their only systematic source,
# ≤ MAX_PER_DAY a day by design), so 100 of them cover many days — and when
# the page cannot be proven to reach 24h back, the budget is a LOWER bound, so
# the sweep aborts rather than dispatch past an unprovable cap (fail-safe
# toward the cost cap).
#
# HARD RULES (mirroring scripts/deploy/deploy-watchdog.sh):
#   - NEVER dispatch when main HEAD already has CI: a run of the CI workflow
#     (any event, own run excluded) at the head's sha, or a legacy combined
#     STATUS on it. Re-running CI on covered heads is pure cost.
#   - NEVER cancel anything (this watchdog only ADDS coverage).
#   - ONE dispatch per sha: a CI run existing at the sha is covered forever.
#   - FAIL-SAFE: any API error or unparsable count aborts the sweep with a
#     ::warning:: and exit 0 — never dispatch on partial data.
#
# Requires: gh (GH_TOKEN with actions:write), jq, GNU date. The test harness
# (scripts/deploy/ci-coverage-watchdog.test.sh) PATH-shims gh (recording every
# URL it is asked for) and drives NOW_EPOCH + GITHUB_RUN_ID, so all
# filtering/decision logic is exercised with the real jq — and the harness
# pins the two design decisions above: the sweep NEVER reads the repo-wide
# check-run count, and NEVER issues a head_sha= runs query.
#
# Env: REPO (owner/name — required), MAIN_BRANCH (main), CI_WORKFLOW
# (ci.yml — dispatch target), CI_WORKFLOW_PATH
# (.github/workflows/ci.yml — the client-side path-filter key for coverage
# and the daily budget), MAX_PER_DAY (6 — the backstop cadence: a busy
# REST-dispatch day should not mint more than 6 rescue runs; the REST path's
# real fix is the gate refusing no_ci, this is the safety net), DRY_RUN (0),
# GITHUB_RUN_ID (injected by Actions — this sweep's own run, EXCLUDED from
# the coverage count so the watchdog can never mask itself; empty or
# non-numeric = local/test run, nothing to exclude), NOW_EPOCH (testing
# override — bounds the 24h dispatch-budget window).

set -u

# Hard prereqs — a missing binary must FAIL LOUD (red run), never silently
# no-op the watchdog.
for bin in gh jq date; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ci-coverage-watchdog: required binary '$bin' not found" >&2; exit 2; }
done

REPO="${REPO:-}"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
CI_WORKFLOW="${CI_WORKFLOW:-ci.yml}"
CI_WORKFLOW_PATH="${CI_WORKFLOW_PATH:-.github/workflows/$CI_WORKFLOW}"
MAX_PER_DAY="${MAX_PER_DAY:-6}"
DRY_RUN="${DRY_RUN:-0}"
OWN_RUN_ID="${GITHUB_RUN_ID:-}"
NOW="${NOW_EPOCH:-$(date -u +%s)}"

log()  { echo "ci-coverage-watchdog: $*"; }
warn() { echo "::warning::ci-coverage-watchdog: $*"; }

# A gated count that is not a non-negative integer means the snapshot was
# partial/corrupt — abort WITHOUT acting (fail-safe, never fail-open).
require_numeric() { # $1=value $2=label
  case "$1" in
    ''|*[!0-9]*) warn "$2 count unparsable ('$1') — sweep aborted (fail-safe)"; exit 0 ;;
  esac
}

# MAX_PER_DAY must be a positive integer (adversarial-review N1: a non-numeric
# value would make the budget test error out and fall through = fail-OPEN
# toward dispatch).
case "$MAX_PER_DAY" in
  ''|*[!0-9]*|0) warn "MAX_PER_DAY ('$MAX_PER_DAY') is not a positive integer — sweep aborted (fail-safe)"; exit 0 ;;
esac

# The own-run id as a jq number (0 = nothing to exclude; run ids start at 1).
OWN_RUN_ID_JSON=0
case "$OWN_RUN_ID" in
  ''|*[!0-9]*) OWN_RUN_ID_JSON=0 ;;
  *) OWN_RUN_ID_JSON="$OWN_RUN_ID" ;;
esac

if [ -z "$REPO" ]; then
  echo "ci-coverage-watchdog: REPO (owner/name) is required" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 1. main HEAD: sha + commit date (the landing time for the page-boundary
#    proof below).
# ---------------------------------------------------------------------------
HEAD_JSON=$(gh api "repos/$REPO/commits/$MAIN_BRANCH" 2>/dev/null) || {
  warn "api error reading main HEAD — sweep aborted (fail-safe)"
  exit 0
}
HEAD_SHA=$(printf '%s' "$HEAD_JSON" | jq -r '.sha' 2>/dev/null)
if [ -z "$HEAD_SHA" ] || [ "$HEAD_SHA" = "null" ]; then
  warn "main HEAD sha unparsable — sweep aborted (fail-safe)"
  exit 0
fi
HEAD_EPOCH=$(printf '%s' "$HEAD_JSON" | jq -r '.commit.committer.date | sub("\\+00:00"; "Z") | fromdateiso8601' 2>/dev/null)
require_numeric "${HEAD_EPOCH:-}" "head commit epoch"

# ---------------------------------------------------------------------------
# 2. Legacy combined STATUSES on the head — a status-only head counts as
#    covered (a third-party status reporter is coverage of the same class as
#    check-runs, and it cannot be triggered by this sweep, so it cannot
#    self-mask). The repo-wide CHECK-RUN count is deliberately NOT read:
#    scheduled sweeps attach their own check-runs at main HEAD and pollute it
#    (the BLOCKING self-masking finding — see the header).
# ---------------------------------------------------------------------------
STATUS_N=$(gh api "repos/$REPO/commits/$HEAD_SHA/status" --jq '.statuses | length' 2>/dev/null)
require_numeric "${STATUS_N:-}" "combined-statuses"
if [ "$STATUS_N" -gt 0 ]; then
  log "main HEAD $HEAD_SHA is covered ($STATUS_N statuses) — nothing to do"
  exit 0
fi

# Zero statuses is also the DOCS-REPO shape (no CI configured at all). Only
# rescue when the repo REALLY has the CI workflow: read ci.yml off the head.
# (An API error here is indistinguishable from absent — it takes the
# docs-repo no-op path, which is fail-CLOSED for the rescue: no dispatch on
# partial data; the next sweep retries.)
CI_YML=$(gh api "repos/$REPO/contents/.github/workflows/$CI_WORKFLOW?ref=$HEAD_SHA" --jq '.path' 2>/dev/null)
if [ "$CI_YML" != ".github/workflows/$CI_WORKFLOW" ]; then
  log "main HEAD $HEAD_SHA has no CI and no $CI_WORKFLOW on the ref — docs-repo shape, nothing to do"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. THE COVERAGE PAGE — one repo-wide listing of the newest 100 runs
#    (default sort: created, descending). No head_sha= query, no workflow_id
#    param — both are lossy/ignored (see header); all filtering is
#    client-side. ci_at_head counts runs of the CI WORKFLOW (any event) at
#    the head's sha, the sweep's own run excluded.
# ---------------------------------------------------------------------------
CI_RUNS_JSON=$(gh api "repos/$REPO/actions/runs?per_page=100" 2>/dev/null) || {
  warn "api error reading repo runs — sweep aborted (fail-safe)"
  exit 0
}
PAGE_ANALYSIS=$(printf '%s' "$CI_RUNS_JSON" | jq -r \
  --arg sha "$HEAD_SHA" --arg path "$CI_WORKFLOW_PATH" \
  --argjson own "$OWN_RUN_ID_JSON" --argjson now "$NOW" '
  def epoch: sub("\\+00:00"; "Z") | fromdateiso8601;
  {
    total:        ([.workflow_runs[]?] | length),
    oldest_epoch: ([.workflow_runs[]? | select(.created_at != null) | (.created_at | epoch)] | min // 0),
    ci_at_head:   ([.workflow_runs[]? | select(.path == $path) | select(.head_sha == $sha) | select(.id != $own)] | length)
  }' 2>/dev/null)
if [ -z "$PAGE_ANALYSIS" ]; then
  warn "runs page unparsable — sweep aborted (fail-safe)"
  exit 0
fi

CI_AT_HEAD=$(printf '%s' "$PAGE_ANALYSIS" | jq -r '.ci_at_head' 2>/dev/null)
require_numeric "${CI_AT_HEAD:-}" "ci runs at head"
if [ "$CI_AT_HEAD" -gt 0 ]; then
  log "main HEAD $HEAD_SHA already has $CI_AT_HEAD CI workflow run(s) — covered"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Page-boundary proof (see header): the page's oldest run must predate the
#    head's landing, else a covering CI run could sit outside the page and
#    "zero at head" is unproven. total==0 (empty repo) yields oldest 0, which
#    always passes.
# ---------------------------------------------------------------------------
OLDEST_EPOCH=$(printf '%s' "$PAGE_ANALYSIS" | jq -r '.oldest_epoch' 2>/dev/null)
require_numeric "${OLDEST_EPOCH:-}" "oldest page run epoch"
if [ "$OLDEST_EPOCH" -gt "$HEAD_EPOCH" ]; then
  warn "the newest 100 runs are all NEWER than main HEAD $HEAD_SHA landed — cannot prove the head is uncovered; sweep aborted (fail-safe, retry next sweep)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. DAILY BUDGET: CI dispatches (event workflow_dispatch on the CI workflow)
#    in the trailing 24h, from the event-filtered listing (dispatch runs are
#    rare, so 100 of them cover many days). When the page cannot be proven to
#    reach 24h back, the count is a LOWER bound — abort rather than dispatch
#    past an unprovable cap.
# ---------------------------------------------------------------------------
DISPATCH_JSON=$(gh api "repos/$REPO/actions/runs?event=workflow_dispatch&per_page=100" 2>/dev/null) || {
  warn "api error reading dispatch runs — sweep aborted (fail-safe)"
  exit 0
}
BUDGET_ANALYSIS=$(printf '%s' "$DISPATCH_JSON" | jq -r \
  --arg path "$CI_WORKFLOW_PATH" --argjson now "$NOW" '
  def epoch: sub("\\+00:00"; "Z") | fromdateiso8601;
  {
    total:          ([.workflow_runs[]?] | length),
    oldest_epoch:   ([.workflow_runs[]? | select(.created_at != null) | (.created_at | epoch)] | min // 0),
    dispatches_24h: ([.workflow_runs[]? | select(.path == $path) | select(.created_at != null)
                      | select((.created_at | epoch) > ($now - 86400))] | length)
  }' 2>/dev/null)
if [ -z "$BUDGET_ANALYSIS" ]; then
  warn "dispatch page unparsable — sweep aborted (fail-safe)"
  exit 0
fi
BUDGET_TOTAL=$(printf '%s' "$BUDGET_ANALYSIS" | jq -r '.total' 2>/dev/null)
require_numeric "${BUDGET_TOTAL:-}" "dispatch page total"
BUDGET_OLDEST=$(printf '%s' "$BUDGET_ANALYSIS" | jq -r '.oldest_epoch' 2>/dev/null)
require_numeric "${BUDGET_OLDEST:-}" "oldest dispatch run epoch"
if [ "$BUDGET_TOTAL" -ge 100 ] && [ "$BUDGET_OLDEST" -gt $((NOW - 86400)) ]; then
  warn "100 dispatch runs and the oldest is <24h old — the daily budget window is unprovable; sweep aborted (fail-safe toward the cost cap)"
  exit 0
fi
DISPATCHES_24H=$(printf '%s' "$BUDGET_ANALYSIS" | jq -r '.dispatches_24h' 2>/dev/null)
require_numeric "${DISPATCHES_24H:-}" "dispatches 24h"
if [ "$DISPATCHES_24H" -ge "$MAX_PER_DAY" ]; then
  warn "daily rescue budget spent ($DISPATCHES_24H >= $MAX_PER_DAY) — main HEAD $HEAD_SHA stays UNCOVERED; the REST-land path needs the merge-gate fix"
  exit 0
fi

# ---------------------------------------------------------------------------
# 6. DISPATCH CI on main (the rescue).
# ---------------------------------------------------------------------------
log "main HEAD $HEAD_SHA has ZERO CI workflow runs and zero statuses while $CI_WORKFLOW exists — dispatching CI"
if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN: would dispatch $CI_WORKFLOW on $MAIN_BRANCH (sha $HEAD_SHA)"
  exit 0
fi
gh api -X POST "repos/$REPO/actions/workflows/$CI_WORKFLOW/dispatches" \
  -f "ref=$MAIN_BRANCH" >/dev/null 2>&1 || {
  warn "dispatch POST failed — sweep aborted (fail-safe); the next sweep retries"
  exit 0
}
log "dispatched $CI_WORKFLOW on $MAIN_BRANCH (rescue for $HEAD_SHA)"

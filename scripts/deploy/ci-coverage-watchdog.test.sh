#!/usr/bin/env bash
# ci-coverage-watchdog.test.sh — offline harness for
# scripts/deploy/ci-coverage-watchdog.sh (feedback ticket fb707538, 2026-10-06;
# review-hardened 2026-10-07 per adversarial review 0bdc8200).
#
# Mirrors scripts/deploy/deploy-watchdog.test.sh: PATH-shim gh with canned
# JSON per URL (real jq does all the filtering), drive the script's decisions
# and assert on its output + whether the dispatch POST fired. Never touches
# the network.
#
# The incident this pins (fb707538): main heads landed via the Contents/PR
# REST dispatch path carry ZERO CI (no push event → no
# `push: branches: [main]` CI trigger); the deploy was the first
# CI-equivalent run on that code. The watchdog must dispatch CI exactly for
# that shape and for nothing else.
#
# The BLOCKING self-masking finding this pins (adversarial review 0bdc8200):
# coverage derived from repo-wide CHECK-RUN counts is polluted by every
# scheduled sweep's own check-runs at main HEAD — the watchdog masks itself
# and never rescues. The hardened script derives coverage ONLY from the CI
# workflow's own runs (client-side .path filter, own run excluded by id) and
# from legacy combined statuses. The harness therefore records every URL the
# script asks for and asserts the two design invariants: the repo-wide
# check-run count is NEVER read, and a head_sha= runs query is NEVER issued
# (that parameter is lossy for freshly-created runs — verified live
# 2026-10-06).

set -u
cd "$(dirname "$0")"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok: $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }
check() { # $1=condition $2=label
  if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi
}

SCRIPT=./ci-coverage-watchdog.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ── the gh shim: canned responses per URL, --jq piped through REAL jq,
#    POSTs recorded, every requested URL logged (for the design-invariant
#    assertions). Env knobs per case: GH_HEAD_JSON (sha + committer date),
#    GH_STATUS_JSON, GH_NO_CI_YML (ci.yml probe fails), GH_RUNS_JSON (the
#    repo-wide newest-runs page), GH_DISPATCH_RUNS_JSON (the
#    event=workflow_dispatch budget page), GH_OWN_RUN_ID (the sweep's own
#    GITHUB_RUN_ID), GH_FAIL_URL (a URL substring whose call must fail).
make_gh() {
  cat > "$TMP/gh" <<'EOF'
#!/usr/bin/env bash
# gh api [flags] URL [flags] [--jq EXPR] — find the URL (the arg containing
# '/'), honour --jq with real jq, record a dispatch when -X POST is present.
url=""
jq_expr=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then jq_expr="$a"; fi
  prev="$a"
  case "$a" in api|-X|POST|-f|--jq) continue ;; esac
  case "$a" in repos/*) url="$a" ;; esac
done
case "$*" in
  *"-X POST"*) mode=POST ;;
  *) mode=GET ;;
esac
printf '%s\n' "$url" >> "${SHIM_URLS:-/dev/null}"
if [ -n "${GH_FAIL_URL:-}" ] && [[ "$url" == *"$GH_FAIL_URL"* ]]; then
  echo "gh: api error" >&2; exit 1
fi
resp=""
case "$mode|$url" in
  "GET|repos/o/r/commits/main") resp="$GH_HEAD_JSON" ;;
  "GET|repos/o/r/commits/$GH_HEAD_SHA/status") resp="${GH_STATUS_JSON:-{\"statuses\":[]}}" ;;
  "GET|repos/o/r/contents/.github/workflows/ci.yml?ref=$GH_HEAD_SHA")
    if [ -n "${GH_NO_CI_YML:-}" ]; then echo "not found" >&2; exit 1; fi
    resp="${GH_CONTENTS_JSON:-{\"path\":\".github/workflows/ci.yml\"}}" ;;
  "GET|repos/o/r/actions/runs?per_page=100") resp="${GH_RUNS_JSON:-{\"workflow_runs\":[]}}" ;;
  "GET|repos/o/r/actions/runs?event=workflow_dispatch&per_page=100") resp="${GH_DISPATCH_RUNS_JSON:-{\"workflow_runs\":[]}}" ;;
  "POST|repos/o/r/actions/workflows/ci.yml/dispatches") echo "POSTED" >> "$SHIM_POSTS" ; exit 0 ;;
  *) echo "UNEXPECTED gh call: $* (url=$url)" >&2; exit 1 ;;
esac
if [ -n "$jq_expr" ]; then
  printf '%s' "$resp" | jq -r "$jq_expr"
else
  printf '%s' "$resp"
fi
EOF
  chmod +x "$TMP/gh"
}

run_case() { # env already set
  rm -f "$TMP/posts" "$TMP/urls"
  export SHIM_POSTS="$TMP/posts"
  export SHIM_URLS="$TMP/urls"
  PATH="$TMP:$PATH" REPO=o/r DRY_RUN="${DRY_RUN:-0}" NOW_EPOCH=1791318000 \
    GITHUB_RUN_ID="${GH_OWN_RUN_ID:-}" bash "$SCRIPT" 2>"$TMP/err" >"$TMP/out"
  RC=$?
}

# warn() writes ::warning:: to STDOUT — search both streams.
saw() { grep -q "$1" "$TMP/out" 2>/dev/null || grep -q "$1" "$TMP/err" 2>/dev/null; }
posted() { [ -f "$TMP/posts" ] && grep -q . "$TMP/posts"; }

COVERED_SHA="1111111111111111111111111111111111111111"
UNCOVERED_SHA="2222222222222222222222222222222222222222"
OTHER_SHA="3333333333333333333333333333333333333333"
# NOW_EPOCH 1791318000 = 2026-10-06T20:00:00Z. The head "landed" at 19:00Z
# (committer date) — one hour before the sweep.
HEAD_AT="2026-10-06T19:00:00Z"
# A repo-wide page whose OLDEST run predates the head's landing — the
# page-boundary proof shape (every run created after the landing is on the
# page, so "zero CI runs at head" is a proof).
OLD_DEPLOY_RUN='{"id":700,"path":".github/workflows/deploy.yml","head_sha":"'"$OTHER_SHA"'","created_at":"2026-10-06T17:00:00Z","event":"push"}'
DEFAULT_RUNS='{"workflow_runs":['"$OLD_DEPLOY_RUN"']}'
export GH_HEAD_SHA=$UNCOVERED_SHA
export GH_HEAD_JSON='{"sha":"'"$UNCOVERED_SHA"'","commit":{"committer":{"date":"'"$HEAD_AT"'"}}}'

echo "== case 1: covered head — a CI workflow run at the sha means covered, nothing to do =="
export GH_RUNS_JSON='{"workflow_runs":[{"id":701,"path":".github/workflows/ci.yml","head_sha":"'"$UNCOVERED_SHA"'","created_at":"2026-10-06T19:05:00Z","event":"push"},'"$OLD_DEPLOY_RUN"']}'
unset GH_STATUS_JSON GH_NO_CI_YML GH_DISPATCH_RUNS_JSON GH_OWN_RUN_ID || true
make_gh; run_case
grep -q "already has 1 CI workflow run" "$TMP/out"; check $? "CI-run-bearing head logs coverage"
! posted; check $? "no dispatch when a CI run already exists at the head"

echo "== case 2: THE SELF-MASKING REPRO — scheduled sweeps (incl. the sweep's OWN run) at the head do NOT count as coverage =="
# The BLOCKING finding shape: this sweep's own run (id 555) and a
# deploy-watchdog sweep both ran at main HEAD — a repo-wide CHECK-RUN count
# would read >0 and the rescue would never fire. The CI-scoped signal must
# still dispatch.
export GH_OWN_RUN_ID=555
GH_RUNS_JSON='{"workflow_runs":[{"id":555,"path":".github/workflows/ci-coverage-watchdog.yml","head_sha":"'"$UNCOVERED_SHA"'","created_at":"2026-10-06T19:58:00Z","event":"schedule"},'
GH_RUNS_JSON="$GH_RUNS_JSON"'{"id":901,"path":".github/workflows/deploy-watchdog.yml","head_sha":"'"$UNCOVERED_SHA"'","created_at":"2026-10-06T19:30:00Z","event":"schedule"},'
GH_RUNS_JSON="$GH_RUNS_JSON""$OLD_DEPLOY_RUN"
GH_RUNS_JSON="$GH_RUNS_JSON"']}'
export GH_RUNS_JSON
  printf "%s" "$GH_RUNS_JSON" | jq -e . >/dev/null 2>&1 && echo "DEBUG: JSON VALID" >&2 || echo "DEBUG: JSON INVALID" >&2
make_gh; run_case
grep -q "dispatched ci.yml on main (rescue for" "$TMP/out"; check $? "the rescue fires despite sweeps at the head (0bdc8200 BLOCKING)"
posted; check $? "the dispatch POST reached the API (self-masking fixed)"
# Design invariants, pinned on the URL log: the repo-wide check-run count is
# NEVER read, and the lossy head_sha= runs query is NEVER issued.
! grep -q "check-runs" "$TMP/urls"; check $? "the sweep never reads the repo-wide check-run count"
! grep -q "head_sha=" "$TMP/urls"; check $? "the sweep never issues the lossy head_sha= runs query"

echo "== case 3: an own-run id collision on the CI path is still excluded (defense-in-depth) =="
# Even a run that somehow carries the CI workflow path AND the head sha is
# excluded when it IS the sweep's own run id — the watchdog must not mask
# itself through any listing pollution.
export GH_RUNS_JSON='{"workflow_runs":[{"id":555,"path":".github/workflows/ci.yml","head_sha":"'"$UNCOVERED_SHA"'","created_at":"2026-10-06T19:58:00Z","event":"schedule"},'"$OLD_DEPLOY_RUN"']}'
make_gh; run_case
grep -q "dispatched ci.yml on main" "$TMP/out"; check $? "own-run exclusion holds even on a CI-path collision"
unset GH_OWN_RUN_ID

echo "== case 4: THE INCIDENT SHAPE — zero CI runs, zero statuses, ci.yml exists → DISPATCH =="
export GH_RUNS_JSON="$DEFAULT_RUNS"
make_gh; run_case
grep -q "dispatched ci.yml on main (rescue for" "$TMP/out"; check $? "the rescue dispatch fires (fb707538)"
posted; check $? "the dispatch POST reached the API (fb707538)"

echo "== case 5: docs-repo shape (no ci.yml on the ref) — never dispatch =="
export GH_NO_CI_YML=1
make_gh; run_case
grep -q "docs-repo shape, nothing to do" "$TMP/out"; check $? "docs repo declines"
! posted; check $? "no dispatch on a docs repo"
unset GH_NO_CI_YML

echo "== case 6: statuses-only head counts as covered =="
export GH_STATUS_JSON='{"statuses":[{"state":"success"}]}'
make_gh; run_case
grep -q "is covered" "$TMP/out"; check $? "statuses-only head is covered"
! posted; check $? "no dispatch on a statuses-only head"
unset GH_STATUS_JSON

echo "== case 7: page-boundary proof — newest 100 runs all NEWER than the head's landing → fail-safe abort =="
# If every run on the page was created after the head landed, a covering CI
# run could sit outside the page: "zero at head" is unproven, so the sweep
# must abort rather than dispatch on an approximation.
export GH_HEAD_JSON='{"sha":"'"$UNCOVERED_SHA"'","commit":{"committer":{"date":"2026-10-06T10:00:00Z"}}}'
export GH_RUNS_JSON='{"workflow_runs":[{"id":702,"path":".github/workflows/deploy.yml","head_sha":"'"$OTHER_SHA"'","created_at":"2026-10-06T12:00:00Z","event":"push"},{"id":703,"path":".github/workflows/ci.yml","head_sha":"'"$OTHER_SHA"'","created_at":"2026-10-06T11:00:00Z","event":"pull_request"}]}'
make_gh; run_case
saw "cannot prove the head is uncovered"; check $? "unprovable page aborts fail-safe"
! posted; check $? "no dispatch on an unprovable page"
export GH_HEAD_JSON='{"sha":"'"$UNCOVERED_SHA"'","commit":{"committer":{"date":"'"$HEAD_AT"'"}}}'

echo "== case 8: daily budget spent — warn, never dispatch =="
GH_DISPATCH_RUNS_JSON='{"workflow_runs":['
for t in 15:00:00 14:00:00 13:00:00 12:00:00 11:00:00 10:00:00; do
  GH_DISPATCH_RUNS_JSON="$GH_DISPATCH_RUNS_JSON"'{"id":1,"path":".github/workflows/ci.yml","created_at":"2026-10-06T'"$t"'Z"},'
done
GH_DISPATCH_RUNS_JSON="${GH_DISPATCH_RUNS_JSON%,}"
GH_DISPATCH_RUNS_JSON="$GH_DISPATCH_RUNS_JSON]}"
export GH_DISPATCH_RUNS_JSON
make_gh; run_case
saw "daily rescue budget spent (6 >= 6)"; check $? "budget-spent warning fires"
! posted; check $? "no dispatch past the daily budget"

echo "== case 9: an OLD dispatch (outside 24h) does NOT count against the budget =="
export GH_DISPATCH_RUNS_JSON='{"workflow_runs":[{"id":1,"path":".github/workflows/ci.yml","created_at":"2026-10-05T10:00:00Z"}]}'
make_gh; run_case
grep -q "dispatched ci.yml on main" "$TMP/out"; check $? "an old dispatch leaves budget for the rescue"
unset GH_DISPATCH_RUNS_JSON

echo "== case 10: a non-CI dispatch does not count (path filter) =="
export GH_DISPATCH_RUNS_JSON='{"workflow_runs":[{"id":1,"path":".github/workflows/deploy-watchdog.yml","created_at":"2026-10-06T17:00:00Z"}]}'
make_gh; run_case
grep -q "dispatched ci.yml on main" "$TMP/out"; check $? "deploy-watchdog dispatches never consume the CI budget"
unset GH_DISPATCH_RUNS_JSON

echo "== case 11: non-numeric MAX_PER_DAY aborts fail-safe (review N1 — never fail-open past the cost cap) =="
PATH="$TMP:$PATH" REPO=o/r NOW_EPOCH=1791318000 MAX_PER_DAY=six bash "$SCRIPT" >"$TMP/out" 2>"$TMP/err"; RC=$?
saw "MAX_PER_DAY ('six') is not a positive integer"; check $? "non-numeric budget aborts"
[ "$RC" = "0" ]; check $? "the abort exits 0 (fail-safe, red-free)"

echo "== case 12: API error reading main HEAD — fail-safe, no dispatch =="
export GH_FAIL_URL="commits/main"
make_gh; run_case
saw "api error reading main HEAD"; check $? "API error aborts fail-safe"
[ "$RC" = "0" ]; check $? "fail-safe exits 0"
! posted; check $? "no dispatch on an API error"
unset GH_FAIL_URL

echo "== case 13: unparsable runs page — fail-safe =="
export GH_RUNS_JSON='{"bogus":'
make_gh; run_case
saw "unparsable"; check $? "unparsable page aborts fail-safe"
! posted; check $? "no dispatch on an unparsable page"
unset GH_RUNS_JSON || true

echo "== case 14: DRY_RUN logs the dispatch without POSTing =="
export GH_RUNS_JSON="$DEFAULT_RUNS"
export DRY_RUN=1
make_gh; run_case
grep -q "DRY_RUN: would dispatch" "$TMP/out"; check $? "DRY_RUN logs the would-be dispatch"
! posted; check $? "DRY_RUN never POSTs"
unset DRY_RUN

echo "== case 15: missing REPO fails loud =="
PATH="$TMP:$PATH" bash "$SCRIPT" >"$TMP/out" 2>"$TMP/err"; RC=$?
[ "$RC" = "2" ]; check $? "missing REPO exits 2 (fail loud)"
grep -q "REPO (owner/name) is required" "$TMP/err"; check $? "the error names the requirement"

echo
echo "ci-coverage-watchdog tests: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]

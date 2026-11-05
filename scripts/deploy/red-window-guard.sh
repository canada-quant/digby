#!/usr/bin/env bash
# red-window-guard.sh — block merges to main while main's latest deploy run is
# red (feedback ticket 1df1fe00; incident 2026-09-24).
#
# INCIDENT: deploy run 36020518228 (sha afdbe811, security hardening) FAILED
# at 15:42:09Z and opened a red window; a framework-maintainer branch was
# merged to main during that window (Actions run 36024468981, sha a18fef4f,
# created 16:01:52Z) and its deploy failed too (run 36024741906 timeline);
# the first fix-attempt deploy (run 36024741906, sha 8f03e2b5) then also
# failed — failures stacking on an already-red pipeline, all four boxes
# stuck on dfefb963 while main advanced. Merges are allowed while red, so
# every merge author must REMEMBER the coordination rule; this check turns
# it into a repo invariant that binds ALL merge authors (including lanes no
# supervisor steers).
#
# MODES
#   check (default) — for pull_request on main-targeting PRs: exit 1 with an
#     actionable message when main's latest COMPLETED deploy.yml run ON MAIN
#     HEAD concluded failure (the red window). GATING REALITY (PR #1035
#     adversarial review B1, verified live): the check run lands on the PR
#     HEAD SHA, and the platform's merge gate (self-merge.service.ts G2)
#     refuses any check run not in success|neutral|skipped — so for LANE
#     merges (merge_pull_request, the sanctioned agent path) this check is
#     HARD the moment this workflow reaches main: no owner action needed,
#     which is the ticket's "binds ALL merge authors" ask. Owner merges via
#     the GitHub UI see it as advisory (branch protection / required checks
#     are UNAVAILABLE on the current GitHub plan — rulesets API 403s). The
#     legitimate merge-while-red escape hatch is the PR label `deploy-fix`.
#     JOB-LEVEL FAIL-OPEN: the script's fail-open arms protect the script,
#     not the job — a crashed/killed script or a checkout flake would fail
#     the CHECK and wedge every lane merge. The workflow wrapper therefore
#     blocks ONLY on a genuine red verdict: exit 1 AND the RWGDECISION=red
#     sentinel line. Anything else (any other exit code, crash, missing
#     sentinel) leaves the check green with a warning.
#     FAILS OPEN (exit 0) on: no completed runs yet, the newest completed
#     run being success/cancelled/timed_out (cancelled = a coalesced wave —
#     the newer run carries the commit), any deploy run still ACTIVE
#     (queued/in_progress/pending — window UNPROVEN, and blocking in-flight
#     would deadlock the queue behind every ~30-min deploy), an API/network
#     error, or an unresolvable main HEAD. A broken check must never wedge
#     the team's merges.
#   status — print the one-line window state (human/agent probe; exit 0
#     except on curl/API hard failure, exit 2).
#
# OVERRIDE: the legitimate merge-while-red case is a deploy-fix PR iterating
#     toward green. A PR label containing `deploy-fix` short-circuits to
#     neutral. Label lookup is best-effort and fails OPEN.
#
# SELECTION RULE: the latest completed deploy.yml run ON MAIN by CONCLUSION
#   time (updated_at — a long-running older run can conclude after a newer
#   one). There is NO head_sha==HEAD condition in the executed jq: the
#   any-active arm provides that protection instead — a failure on a
#   superseded sha while ANY run is still pending/queued/in_progress means
#   the window is UNPROVEN, not red; with nothing active at all the newest
#   completed run IS the freshest signal, whatever sha it ran (see the jq
#   precedence below). The TS merge-time mirror
#   (backend/src/modules/crossmodel/coding/red-window-merge-gate.ts,
#   ticket 2bccefe0) pins this rule — do not "fix" either side alone.
#
# Auth: gh reads GH_TOKEN/GITHUB_TOKEN from the environment natively; the
#   workflow injects it. No flags needed here.
#
# Run from anywhere: bash scripts/deploy/red-window-guard.sh check|status
set -u

# Isolation boundary (ticket c75b5f34): the repo comes from THIS environment.
# Production (DIGBY_INSTANCE unset/empty/prod) keeps the historical default; a
# NON-prod instance must configure its OWN repo — unset, or set to the
# production repo, is a HARD FAIL (never a silent production fallback).
if [ "${DIGBY_INSTANCE:-prod}" != "prod" ]; then
  REPO="${REPO:-${GITHUB_REPO_SLUG:-}}"
  # Normalize like the leaf's normalizeGithubRepoTarget (review F5 item 2):
  # lowercase + strip an optional github.com URL wrapper / .git / trailing
  # slash. `example-org/crossmodel` resolves to the PRODUCTION repo on the
  # GitHub API (verified live by the reviewer), so a case-sensitive literal
  # match here was a bypass into prod.
  REPO="$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's#^https?://github\.com/##; s#^git@github\.com:##; s#\.git/*$##; s#/*$##')"
  case "$REPO" in
    "")
      echo "red-window-guard: ISOLATION BOUNDARY — DIGBY_INSTANCE=${DIGBY_INSTANCE} has no repo configured (REPO/GITHUB_REPO_SLUG unset) — refusing to fall back to the production repo (ticket c75b5f34)." >&2
      exit 3
      ;;
    example-org/crossmodel)
      echo "red-window-guard: ISOLATION BOUNDARY — DIGBY_INSTANCE=${DIGBY_INSTANCE} refuses the production repo $REPO. Set GITHUB_REPO_SLUG (or REPO) to this instance's own repo." >&2
      exit 3
      ;;
  esac
else
  REPO="${REPO:-${GITHUB_REPO_SLUG:-example-org/crossmodel}}"
fi
DPATH=".github/workflows/deploy.yml"
LABEL_TOKEN="deploy-fix"

MODE="${1:-check}"

die() { echo "red-window-guard: $*" >&2; exit 2; }

# ── ONE unfiltered Actions snapshot feeds every decision (single-source
#    doctrine, same as deploy-watchdog.sh).
SNAP_FILE="$(mktemp)"
trap 'rm -f "$SNAP_FILE"' EXIT
if ! gh api "repos/${REPO}/actions/runs?per_page=100" > "$SNAP_FILE" 2>/dev/null; then
  echo "red-window-guard: Actions API unreachable — failing OPEN (merge allowed)."
  [ "$MODE" = "status" ] && exit 2
  exit 0
fi

HEAD_SHA="$(gh api "repos/${REPO}/branches/main" --jq .commit.sha 2>/dev/null || echo '')"
if [ -z "$HEAD_SHA" ]; then
  echo "red-window-guard: could not resolve main HEAD — failing OPEN (merge allowed)."
  [ "$MODE" = "status" ] && exit 2
  exit 0
fi

# ── Window state. Precedence (all over deploy.yml runs with head_branch=main):
#    1. any run ACTIVE (status != completed)  → unproven        (fail open)
#    2. no completed run                      → clean           (fresh repo)
#    3. newest completed (by CONCLUSION time, updated_at):
#         conclusion == failure → RED (exit 1) — regardless of sha: main's
#           deploy pipeline's latest word is a failure. The incident shape is
#           failure-on-HEAD (afdbe811), but failure-on-an-older-sha with
#           nothing newer completed is the same red window — main advanced
#           past a failed deploy and nothing has proven it green since.
#         otherwise            → clean (success / cancelled coalesced wave /
#           timed_out — never auto-blocked; the watchdog's re-dispatch arm
#           owns cancelled|timed_out recovery).
read -r STATE CONCLUSION RUN_ID RUN_SHA CONCLUDED_AT <<< "$(jq -r \
  --arg dpath "$DPATH" '
  .workflow_runs
  | map(select(.path == $dpath and .head_branch == "main"))
  | if any(.status != "completed") then
      "unproven none none none none"
    else
      (map(select(.status == "completed"))
       | sort_by(.updated_at) | reverse | .[0])
      // null
      | if . == null then
          "clean none none none none"
        elif .conclusion == "failure" then
          "red \(.conclusion) \(.id) \(.head_sha[0:8]) \(.updated_at)"
        else
          "clean \(.conclusion // "none") \(.id) \(.head_sha[0:8]) \(.updated_at)"
        end
    end
' "$SNAP_FILE")"

case "$MODE" in
  status)
    echo "red-window: state=${STATE} last_completed=${CONCLUSION} run=${RUN_ID} sha=${RUN_SHA} concluded=${CONCLUDED_AT} head=${HEAD_SHA:0:8}"
    exit 0
    ;;
  check) ;;
  *) die "unknown mode: $MODE (use check|status)" ;;
esac

# ── Override label: `deploy-fix`-containing label on the PR short-circuits.
if [ -n "${PR_NUMBER:-}" ] && [ "$PR_NUMBER" != "false" ]; then
  LABELS="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.labels | map(.name) | join(",")' 2>/dev/null || echo '')"
  case ",${LABELS}," in
    *"${LABEL_TOKEN}"*)
      echo "red-window-guard: OVERRIDE label '${LABEL_TOKEN}' present on PR #${PR_NUMBER} — merge allowed (deploy-fix iteration)."
      exit 0
      ;;
  esac
fi

case "$STATE" in
  red)
    echo "RED WINDOW: main's latest deploy.yml run #${RUN_ID} (sha ${RUN_SHA}, main HEAD ${HEAD_SHA:0:8}) concluded ${CONCLUSION} at ${CONCLUDED_AT}."
    echo "Merging now stacks this PR's deploy onto a broken pipeline (2026-09-24 incident: three consecutive failed deploys, boxes stuck while main advanced)."
    echo "Fix main's deploy FIRST — a deploy-fix PR may carry the '${LABEL_TOKEN}' label to merge while red — then re-run this check."
    # Sentinel (PR #1035 review B1): the workflow wrapper blocks the CHECK
    # only on a genuine red verdict — exit 1 AND this exact line. A crashed
    # or killed script must leave the check green (job-level fail-open).
    echo "RWGDECISION=red"
    exit 1
    ;;
  unproven)
    echo "red-window-guard: a deploy.yml run on main is in flight — window UNPROVEN, failing OPEN (merge allowed)."
    exit 0
    ;;
  clean)
    echo "red-window-guard: no red window (last completed deploy on main: ${CONCLUSION}, run ${RUN_ID}). Merge allowed."
    exit 0
    ;;
  *)
    echo "red-window-guard: unknown state '${STATE}' — failing OPEN (merge allowed)."
    exit 0
    ;;
esac

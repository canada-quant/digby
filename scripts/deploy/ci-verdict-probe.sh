#!/usr/bin/env bash
# ci-verdict-probe.sh — does this exact sha already have a CI verdict the
# deploy gate can REUSE, instead of running the suite a second time?
#
# T2b (todo f06afbfe, 2026-10-17; PR #1639). The batch train runs the full
# suite ONCE on the batch branch (T2a's `batch/**` push trigger) and the
# fast-forward to main carries those commits, so the deploy's Test gate can
# skip a duplicate run when that sha is already green. The probe filters by
# HEAD SHA, never by branch: a CI run on `batch/<ts>` counts for the sha the
# FF lands on main.
#
# CONTRACT (2026-10-19 — the none-race that shipped red sha 4dde9db; the
# no-deadlock revision the same day):
# the deploy WAITS for this sha's own CI workflow runs to finish and requires
# a completed success. It does not self-run the suite just because CI was
# still in progress (or cancelled) when a PUSH-triggered gate started.
#
#   green — ANY completed CI run on the sha concluded success (a later red
#           of the same sha does not un-green it: flaky infra, any-success).
#           The deploy skips its own suite.
#   red   — CI FAILED on the sha and still failed after ONE automatic re-run
#           of its failed jobs (a flake gets one retry, so it no longer stops
#           a deploy). The red-ci-stop job fails the run; nothing ships.
#   wait  — CI has not given a verdict on the code: still running after the
#           bounded wait, cancelled, skipped or timed out. The deploy is
#           SKIPPED and the run concludes success — never a failed run, so
#           it cannot open a red window that blocks every lane merge.
#           deploy-watchdog.sh arm 4 sees the success-with-skip run on main
#           and re-dispatches within one sweep (15 min), by which point CI
#           has finished.
#   none  — NO CI workflow run exists for the sha (empty listing, or only
#           non-CI workflows such as Deploy), OR the first read could not
#           be answered, OR this is a workflow_dispatch whose CI is not green
#           (a dispatch never waits — it is the escape hatch). The deploy
#           runs its own full suite and logs `CI-VERDICT FALLBACK`.
#
# OPERATOR OVERRIDE: workflow_dispatch input `ci_gate=selfrun` (env CI_GATE)
# skips the probe and runs the deploy's own full suite even on a red CI
# verdict — for a main CI broken by infrastructure, never untested code.
#
# Waits: CI_VERDICT_WAIT_SEC (default 1200) for the first verdict, then
# CI_VERDICT_RERUN_WAIT_SEC (default 600) after a re-run. The gate job's
# 40-minute timeout holds both. CI_VERDICT_RERUN=0 disables the re-run.
# 2026-10-22: the first wait was 480 s — shorter than main CI on a backend
# change (~13 min) — so every backend merge deferred to the watchdog's cron,
# and GitHub left that cron unfired 00:42Z → 03:20Z: #1878 sat merged and
# undeployed. The wait now outlasts CI (~1.5x) so a push deploys on its own;
# `wait` stays the fallback for a CI that is genuinely stuck.
# Tests set the waits to 0.
#
# Output: `ci_verdict=green|red|wait|none` on $GITHUB_OUTPUT (and a log line).
# Exit 0 always — the WORKFLOW decides.
#
# Needs: gh (authed; actions:write for the re-run), python3. Env: GH_TOKEN,
# REPO (owner/name), HEAD_SHA. Optional: EVENT_NAME, CI_GATE,
# CI_WORKFLOW_PATH (default .github/workflows/ci.yml — matched against the
# run's path OR name "CI").
set -uo pipefail

verdict() {
  # $1 = green|red|wait|none, $2 = human reason (logged, not exported).
  local v="$1" msg="$2"
  if [ "$v" = "none" ]; then
    echo "::warning::CI-VERDICT FALLBACK — $msg"
    echo "CI-VERDICT FALLBACK — $msg"
  fi
  if [ "$v" = "wait" ]; then
    echo "::notice::CI-VERDICT WAIT — $msg"
  fi
  echo "ci-verdict: $v — $msg"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "ci_verdict=$v" >> "$GITHUB_OUTPUT"
  fi
  exit 0
}

# No CI verdict on the code yet. A push defers (wait — the watchdog
# re-dispatches); a dispatch never waits, it runs its own suite.
undecided() {
  if [ "${EVENT_NAME:-push}" = "workflow_dispatch" ]; then
    verdict none "$1 — workflow_dispatch runs its own suite instead of waiting"
  fi
  verdict wait "$1 — deploy deferred (run stays green; the deploy watchdog re-dispatches once CI finishes)"
}

if [ "${CI_GATE:-auto}" = "selfrun" ]; then
  verdict none "operator override ci_gate=selfrun — the deploy runs its own full suite"
fi

[ -n "${GH_TOKEN:-}" ] && [ -n "${REPO:-}" ] && [ -n "${HEAD_SHA:-}" ] || \
  verdict none "probe env missing (GH_TOKEN/REPO/HEAD_SHA) — falling back to the deploy's own suite"
command -v gh >/dev/null 2>&1 || \
  verdict none "gh not on PATH — falling back to the deploy's own suite"
command -v python3 >/dev/null 2>&1 || \
  verdict none "python3 not on PATH — falling back to the deploy's own suite"

CI_WORKFLOW_PATH="${CI_WORKFLOW_PATH:-.github/workflows/ci.yml}"
# Defaults fit the gate job's 25-minute timeout. Non-digits fall back.
WAIT_SEC=1200
case "${CI_VERDICT_WAIT_SEC:-}" in
  ''|*[!0-9]*) ;;
  *) WAIT_SEC="$CI_VERDICT_WAIT_SEC" ;;
esac
RERUN_WAIT_SEC=600
case "${CI_VERDICT_RERUN_WAIT_SEC:-}" in
  ''|*[!0-9]*) ;;
  *) RERUN_WAIT_SEC="$CI_VERDICT_RERUN_WAIT_SEC" ;;
esac
RERUN_DONE=0

TMP_JSON="$(mktemp)"
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_JSON" "$TMP_OUT"' EXIT

START="$(date +%s)"
DEADLINE=$((START + WAIT_SEC))
SEEN_PENDING=0

classify() {
  # Writes one token to $TMP_OUT: green | none | pending | red:<conclusion>
  # JSON is a FILE argument — never stdin (a heredoc would steal it).
  CI_WORKFLOW_PATH="$CI_WORKFLOW_PATH" python3 - "$TMP_JSON" "$TMP_OUT" <<'PY'
import json, os, re, sys
src, dst = sys.argv[1], sys.argv[2]
path = os.environ.get("CI_WORKFLOW_PATH", ".github/workflows/ci.yml")
try:
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    runs = data.get("workflow_runs") or []
except Exception as e:
    with open(dst, "w", encoding="utf-8") as f:
        f.write("error:" + type(e).__name__)
    sys.exit(0)
ours = [r for r in runs if (r.get("path") == path or r.get("name") == "CI")]
def emit(token):
    with open(dst, "w", encoding="utf-8") as f:
        f.write(token)
if not ours:
    emit("none")
elif any(r.get("status") == "completed" and r.get("conclusion") == "success" for r in ours):
    emit("green")
elif any(r.get("status") != "completed" for r in ours):
    emit("pending")
else:
    newest = max(ours, key=lambda r: r.get("updated_at") or "")
    c = re.sub(r"[^A-Za-z0-9_]", "", str(newest.get("conclusion") or "unknown")) or "unknown"
    if c == "failure":
        rid = re.sub(r"[^0-9]", "", str(newest.get("id") or ""))
        att = re.sub(r"[^0-9]", "", str(newest.get("run_attempt") or "1")) or "1"
        emit("fail:" + (rid or "0") + ":" + att)
    else:
        emit("wait:" + c)
PY
}

while true; do
  NOW="$(date +%s)"
  if ! gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=100" >"$TMP_JSON" 2>"$TMP_OUT.gh"; then
    if [ "$SEEN_PENDING" = "1" ]; then
      undecided "CI was in progress on $HEAD_SHA but a later read failed"
    fi
    verdict none "gh api actions/runs failed for $HEAD_SHA — falling back to the deploy's own suite"
  fi
  classify
  CLASS="$(cat "$TMP_OUT" 2>/dev/null || true)"
  case "$CLASS" in
    green)
      verdict green "a completed CI run on $HEAD_SHA concluded success — reusing it"
      ;;
    none)
      verdict none "no CI workflow run exists for $HEAD_SHA — falling back to the deploy's own suite"
      ;;
    pending)
      if [ "$NOW" -ge "$DEADLINE" ]; then
        undecided "CI still not completed on $HEAD_SHA after the wait"
      fi
      SEEN_PENDING=1
      REMAIN=$((DEADLINE - NOW))
      SLEEP=15
      if [ "$REMAIN" -lt "$SLEEP" ]; then SLEEP="$REMAIN"; fi
      if [ "$SLEEP" -lt 1 ]; then SLEEP=1; fi
      echo "ci-verdict: pending — CI on $HEAD_SHA not completed yet; waiting ${SLEEP}s (${REMAIN}s left)"
      sleep "$SLEEP"
      ;;
    fail:*)
      REST="${CLASS#fail:}"
      RUN_ID="${REST%%:*}"
      ATTEMPT="${REST##*:}"
      # One automatic re-run of the failed jobs: a flaky test must not stop
      # the deploy (and, through the red window, every lane merge). A run
      # already re-run once (attempt >= 2) is a real red.
      if [ "$RERUN_DONE" = "0" ] && [ "${CI_VERDICT_RERUN:-1}" != "0" ] && [ "${ATTEMPT:-1}" -lt 2 ] && [ "${RUN_ID:-0}" != "0" ]; then
        if gh api -X POST "repos/$REPO/actions/runs/$RUN_ID/rerun-failed-jobs" >/dev/null 2>"$TMP_OUT.gh"; then
          RERUN_DONE=1
          SEEN_PENDING=1
          DEADLINE=$(( $(date +%s) + RERUN_WAIT_SEC ))
          echo "::notice::CI failed on $HEAD_SHA (run $RUN_ID) — re-running its failed jobs once before deciding"
          echo "ci-verdict: rerun — CI run $RUN_ID failed; re-running failed jobs (waiting up to ${RERUN_WAIT_SEC}s)"
          if [ "$RERUN_WAIT_SEC" -gt 0 ]; then sleep 15; fi
          continue
        fi
        echo "ci-verdict: re-run request for run $RUN_ID failed — treating the failure as final"
      fi
      if [ "$RERUN_DONE" = "1" ]; then RR="after one automatic re-run"; else RR="no re-run left"; fi
      verdict red "CI failed on $HEAD_SHA (run $RUN_ID, attempt $ATTEMPT, $RR) — skipping deploy"
      ;;
    wait:*)
      undecided "newest completed CI run on $HEAD_SHA concluded ${CLASS#wait:} (not a verdict on the code)"
      ;;
    error:*)
      if [ "$SEEN_PENDING" = "1" ]; then
        undecided "CI was in progress on $HEAD_SHA but the listing became unreadable (${CLASS#error:})"
      fi
      verdict none "could not parse actions/runs for $HEAD_SHA (${CLASS#error:}) — falling back to the deploy's own suite"
      ;;
    *)
      if [ "$SEEN_PENDING" = "1" ]; then
        undecided "CI was in progress on $HEAD_SHA but classification failed"
      fi
      verdict none "could not classify actions/runs for $HEAD_SHA — falling back to the deploy's own suite"
      ;;
  esac
done

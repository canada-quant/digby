#!/usr/bin/env bash
# deploy-strand-probe.sh — "is anything RUNTIME undeployed on main?" (ticket
# a4309ef9, 2026-10-16). Answers the question deploy-path-filter.sh cannot
# ask from the push's own incremental diff: whether runtime changes sit
# UNDER the current push in last-delivered..HEAD — undeployed because a
# deployable wave was cancelled (GitHub's one-running+one-pending rule) and
# the survivor push happened to be docs-only.
#
# THE BUG (reproduced live 2026-10-16, all ids verbatim from the ticket):
# merge c67577e9e (29 runtime files) landed 14:05:01Z → its deploy wave
# 38912911194 was CANCELLED 14:08:51Z before its gate job ever started
# (empty jobs list) → the newer push's run 38913411207 — a docs/learnings
# -only commit DIRECTLY ON TOP of the merge — answered runtime=no from its
# own HEAD^..HEAD diff, skipped its Deploy job, and concluded SUCCESS. Net:
# main stranded, boxes one deploy behind, live tarball pre-fix, NOTHING in
# the safety net saw it (the carrier run is green; the watchdog's
# re-dispatch arm fired only on cancelled|timed_out). Manual
# `gh workflow run "Deploy to AWS EC2" --ref main` (38917861836, success
# 15:15Z) un-stranded it.
#
# HOW THIS SCRIPT ANSWERS IT — no state of its own, all from the Actions
# API (the on-box /opt/crossmodel-local/deployed-sha marker is SSH-only —
# port 22 is closed to the internet and the ssh-gate lives in the deploy
# job, so the gate job cannot read it):
#   1. Walk completed deploy.yml runs, NEWEST by conclusion time
#      (updated_at — the same law as deploy-watchdog.sh arm 3), asking the
#      per-run jobs API one question: did this run's "Deploy CrossModel"
#      job conclude success? The FIRST such run's head_sha is the LAST
#      DELIVERED sha — the only source of truth readable from CI that a
#      skipped job cannot forge (live-verified: carrier 38913411207 shows
#      Deploy CrossModel conclusion "skipped" while the run itself
#      concludes success; cancelled wave 38912911194 has an empty jobs
#      list — a missing job row is "not delivered", never a failure).
#   2. If HEAD == that sha, nothing is undeployed: answer no.
#   3. Else classify compare(lastDelivered...HEAD) with the SAME skip set
#      as deploy-path-filter.sh (scripts/deploy/runtime-skip-set.awk — one
#      definition, zero drift). Any runtime file ⇒ answer yes (stranded).
#
# BELT-AND-BRACES: deploy-path-filter.sh calls this probe ONLY when its own
# incremental diff is docs-only (a runtime=yes answer stands unchanged —
# the probe never downgrades a deploy), and deploy-watchdog.sh arm 4 asks
# the same probe for the success-with-skip case — two independent legs, one
# tested truth.
#
# KNOWN COST (fail-open direction, by design): a docs-only push that lands
# while a runtime wave is still DEPLOYING also probes stranded=yes (the
# wave has not concluded, so the walk sees the older delivered sha) and
# queues a redundant catch-up deploy behind it. A redundant ~19-min deploy
# is never an outage; a wrongly-skipped one strands main — the exact
# asymmetry deploy-path-filter.sh is built on.
#
# BOUNDS / FAIL-SAFE: any probe failure — gh error, unparsable body, no
# deploy job found, a compare that cannot answer, the walk exhausting its
# run budget without finding a delivered sha — answers YES (stranded ⇒
# deploy). The walk budget (MAX_DEPLOY_RUNS, default 40 × the 100-run
# listing) covers ~2 days of this repo's push cadence; beyond it something
# unusual is happening and the only safe answer is "deploy". Typical cost:
# 1–3 jobs calls (newest delivered, one skipped carrier, one cancelled
# wave) — the walk stops at the FIRST delivered run.
#
# Usage (deploy-path-filter.sh strand guard; deploy-watchdog.sh arm 4):
#   REPO=owner/name GH_TOKEN=… bash scripts/deploy/deploy-strand-probe.sh [HEAD_SHA]
# Env: REPO (required), GH_TOKEN (required in CI), HEAD_SHA (arg overrides),
#      DEPLOY_WORKFLOW_PATH (.github/workflows/deploy.yml),
#      DEPLOY_JOB_NAME ("Deploy CrossModel"), MAX_DEPLOY_RUNS (40),
#      GITHUB_OUTPUT (optional).
# Writes stranded=yes|no to $GITHUB_OUTPUT and stdout; exit 0 always (an
# answer, never an error — callers must never crash on a probe leg).
set -u

log()  { echo "strand-probe: $*"; }
warn() { echo "::warning::strand-probe: $*"; }

probe_yes() { # $1 = reason — undeployed runtime OR any probe failure
  log "stranded=yes — $1"
  echo "stranded=yes" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "stranded=yes"
  exit 0
}
probe_no() { # $1 = reason — nothing runtime undeployed
  log "stranded=no — $1"
  echo "stranded=no" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "stranded=no"
  exit 0
}

REPO="${REPO:-}"
DEPLOY_PATH="${DEPLOY_WORKFLOW_PATH:-.github/workflows/deploy.yml}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-${DEPLOY_PATH##*/}}"   # deploy.yml — the path-form listing key
DEPLOY_JOB="${DEPLOY_JOB_NAME:-Deploy CrossModel}"
MAX_RUNS="${MAX_DEPLOY_RUNS:-40}"

[ -n "$REPO" ] || probe_yes "REPO unset — probe unusable, deploying is the only safe answer"
command -v gh >/dev/null 2>&1 || probe_yes "gh not found — probe unusable, deploying is the only safe answer"
command -v jq >/dev/null 2>&1 || probe_yes "jq not found — probe unusable, deploying is the only safe answer"
case "$MAX_RUNS" in ''|*[!0-9]*) probe_yes "MAX_DEPLOY_RUNS '$MAX_RUNS' not a number — deploying";; esac

HEAD_ARG="${1:-${HEAD_SHA:-}}"
if [ -z "$HEAD_ARG" ]; then
  command -v git >/dev/null 2>&1 || probe_yes "no HEAD sha (arg/env) and no git — cannot decide, deploying"
  HEAD_ARG=$(git rev-parse HEAD 2>/dev/null) || probe_yes "git rev-parse HEAD failed — cannot decide, deploying"
fi
log "probing last-delivered..HEAD for ${HEAD_ARG:0:12}"

# ---------------------------------------------------------------------------
# 1. Walk completed deploy.yml runs (newest-first by conclusion time) until
#    one shows the Deploy job concluded success. The WORKFLOW-SCOPED listing
#    (path form repos/{repo}/actions/workflows/deploy.yml/runs — live-
#    verified 2026-10-16: returns ONLY that workflow's runs, 100 per page)
#    is preferred over the repo-wide listing: the repo-wide page is mostly
#    scheduled watchdog/healthcheck noise, which could push the last
#    delivered deploy run off page 1 on a quiet day (the ?workflow_id=
#    QUERY PARAM on the repo-wide endpoint is the form GitHub ignores — the
#    deploy-watchdog law; the PATH form is a different endpoint and works).
#    Fallback: the repo-wide listing + client-side .path filter. Both
#    shapes feed the same walk. status=completed is a valid server-side
#    filter (live-verified); the client-side .path filter stays on BOTH
#    paths as cheap defense-in-depth.
# ---------------------------------------------------------------------------
WALK_JSON=''
for LISTING in \
  "repos/$REPO/actions/workflows/$DEPLOY_WORKFLOW/runs?per_page=100&status=completed" \
  "repos/$REPO/actions/runs?per_page=100&status=completed"; do
  WALK_JSON=$(gh api "$LISTING" 2>/dev/null) && break
  WALK_JSON=''
done
[ -n "$WALK_JSON" ] || probe_yes "gh api runs listing failed (workflow-scoped and repo-wide) — probe unusable, deploying"
RUNS_LIST=$(printf '%s' "$WALK_JSON" | jq -r --arg p "$DEPLOY_PATH" --argjson m "$MAX_RUNS" '
  [.workflow_runs[] | select(.path == $p)]
  | sort_by(.updated_at) | reverse
  | .[0:$m]
  | .[] | "\(.id) \(.head_sha)"' 2>/dev/null)
[ $? -eq 0 ] || probe_yes "runs listing unparsable — probe unusable, deploying"
[ -n "$RUNS_LIST" ] || probe_yes "no completed deploy.yml runs in snapshot — cannot prove anything is deployed, deploying"

LAST_DELIVERED=''
WALKED=0
while read -r RID RSHA; do
  [ -n "${RID:-}" ] || continue
  WALKED=$((WALKED + 1))
  JOBS_JSON=$(gh api "repos/$REPO/actions/runs/$RID/jobs?per_page=100" 2>/dev/null)
  [ $? -eq 0 ] || probe_yes "gh api jobs for run $RID failed — probe unusable, deploying"
  # The deploy job's conclusion is the ONLY truth: run-level success means
  # nothing (the carrier run concludes success with its Deploy job skipped
  # — the live 38913411207 shape) and a cancelled wave has an EMPTY jobs
  # list (38912911194) — a missing job row is "not delivered", never a
  # probe failure. `first // "missing"` always emits a value, so a parse
  # error is the only failure path.
  DELIVERED=$(printf '%s' "$JOBS_JSON" | jq -r --arg j "$DEPLOY_JOB" '
    [.jobs[] | select(.name == $j) | .conclusion] | first // "missing"' 2>/dev/null)
  [ $? -eq 0 ] || probe_yes "jobs listing for run $RID unparsable — probe unusable, deploying"
  if [ "$DELIVERED" = "success" ]; then
    LAST_DELIVERED="$RSHA"
    log "run $RID delivered ${RSHA:0:12} (Deploy job success)"
    break
  fi
  [ -n "$DELIVERED" ] || DELIVERED="(no Deploy job row — cancelled before gate?)"
  log "run $RID (sha ${RSHA:0:12}) did not deliver — Deploy job conclusion: $DELIVERED"
done <<EOF
$RUNS_LIST
EOF

if [ -z "$LAST_DELIVERED" ]; then
  probe_yes "no run with a successful Deploy job in the last $WALKED completed deploy runs — cannot prove anything is deployed, deploying"
fi

# ---------------------------------------------------------------------------
# 2. Already delivered? (Also the loop's own protection the sweep after a
#    rescue: HEAD == last delivered ⇒ nothing undeployed.)
# ---------------------------------------------------------------------------
[ "$LAST_DELIVERED" = "$HEAD_ARG" ] && probe_no "HEAD ${HEAD_ARG:0:12} is the last delivered sha — nothing undeployed"

# ---------------------------------------------------------------------------
# 3. Classify compare(lastDelivered...HEAD) with the shared skip set.
#    The compare API caps .files at 300 per page (documented); a 300-file
#    page means the range's tail is unreadable ⇒ answer yes (stranded) —
#    runtime undeployed beyond reasonable doubt, the fail-open direction.
#    Status+count come out of ONE jq pass whose rc is checked, so a garbage
#    body can never fall through to "no files" (that would BE the strand
#    bug again); a body that decodes but LACKS the .files key entirely (an
#    API shape change / truncated body) is UNANSWERABLE on any non-identical
#    status ⇒ yes — only a PRESENT-but-empty files list means "nothing
#    changed" (the empty-commit case) and answers no. `behind` cannot
#    happen for a main push but stays in the deploy set — unknown ⇒ deploy.
# ---------------------------------------------------------------------------
CMP=$(gh api "repos/$REPO/compare/${LAST_DELIVERED}...${HEAD_ARG}" 2>/dev/null)
[ $? -eq 0 ] || probe_yes "compare ${LAST_DELIVERED:0:12}...${HEAD_ARG:0:12} failed — cannot classify, deploying"
CMP_SUMMARY=$(printf '%s' "$CMP" | jq -r '.status, (if has("files") then (.files | length) else -1 end)' 2>/dev/null)
[ $? -eq 0 ] || probe_yes "compare body unparsable — cannot classify, deploying"
{ read -r CMP_STATUS; read -r N_FILES; } <<EOF
$CMP_SUMMARY
EOF
case "${CMP_STATUS:-}" in
  identical) probe_no "compare identical — HEAD is the delivered sha" ;;
  ahead|diverged|behind) ;;
  *) probe_yes "compare status '${CMP_STATUS:-<none>}' unanswerable — deploying" ;;
esac
case "${N_FILES:-}" in
  -1) probe_yes "compare body has no .files key on status '$CMP_STATUS' — unanswerable, deploying" ;;
  ''|*[!0-9]*) probe_yes "compare file count '${N_FILES:-<none>}' unparsable — deploying" ;;
esac
[ "$N_FILES" -ge 300 ] && probe_yes "compare page at the 300-file cap — the range's tail is unreadable, treat as runtime (deploying)"

FILES=$(printf '%s' "$CMP" | jq -r '(.files // [])[] | .filename // empty' 2>/dev/null)
[ $? -eq 0 ] || probe_yes "compare files unparsable — deploying"
[ -n "$FILES" ] || probe_no "compare answered zero changed files between ${LAST_DELIVERED:0:12} and ${HEAD_ARG:0:12} — nothing to deploy"

# The same skip set as the path filter (runtime-skip-set.awk): one
# definition, zero drift — a diverged set would make the filter's guard and
# the watchdog's arm disagree about "runtime".
PROBE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
RUNTIME_FILES=$(printf '%s\n' "$FILES" | awk -f "$PROBE_DIR/runtime-skip-set.awk")
AWK_RC=$?
[ "$AWK_RC" -ne 0 ] && probe_yes "skip-set classifier died rc=$AWK_RC — cannot classify, deploying"

if [ -n "$RUNTIME_FILES" ]; then
  N=$(printf '%s\n' "$RUNTIME_FILES" | wc -l | tr -d ' ')
  probe_yes "runtime undeployed: $N runtime file(s) between last-delivered ${LAST_DELIVERED:0:12} and ${HEAD_ARG:0:12}: $(printf '%s' "$RUNTIME_FILES" | head -5 | tr '\n' ' ')$( [ "$N" -gt 5 ] && echo ' …')"
else
  probe_no "only docs/test files between last-delivered ${LAST_DELIVERED:0:12} and ${HEAD_ARG:0:12} — nothing runtime undeployed"
fi

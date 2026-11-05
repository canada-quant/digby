#!/usr/bin/env bash
# deploy-watchdog.sh — un-wedge the serialized deploy queue (feedback tickets
# 4b432e90 / e1ccaa80; incident 2026-09-18).
#
# INCIDENT: deploy run 35282575521 froze mid "Blue-green deploy" step at
# 23:33:42Z and held the `deploy-production` concurrency group for ~2h11m
# (manual agent cancel 00:44:36Z). While it held the group, the queued fix
# deploy 35288230774 was silently CANCELLED at 00:25:48Z by GitHub's
# one-running+one-pending rule (a newer push's deploy run took the single
# pending slot), and NOTHING re-triggered a deploy of main until the frozen
# run was killed by hand — prod served the old build the whole time
# (blue-green design kept it healthy) with a stop-order-violating bug live.
# Root enabler: NO timeout-minutes anywhere in .github/workflows (GitHub's
# 360-min default), and nothing watching deploy-run PROGRESS — the 15-min
# Deployment Health Check watches prod health, which stays green on the old
# color during a wedge.
#
# 2026-09-20 INCIDENT (ticket 6d8d8beb): two consecutive deploy runs
# (35532250231, 35533974170) wedged mid "Deploy CrossModel" job — a
# live-but-hung ON-BOX phase (ssh keepalives only kill DEAD transports) —
# and held the serialized queue until manual agent cancels (20:16Z/21:10Z).
# This sweep FIRED at 21:05Z mid-wedge and correctly declined to cancel a
# 46-min-silent run under the 150-min threshold — the threshold inversion
# (150 > the 120-min job timeout) was the gap, not the cron (though the
# same day showed multi-hour GitHub schedule drops: 06:54Z → 12:13Z
# silent — the watchdog.yml grid is now doubled). Fixes: STALE_MINUTES
# 150 → 90 and a 45-min remote-side timeout on the per-host blue-green
# phase (plus a 20-min runner-side rsync bound) in deploy.yml. (2026-10-17,
# T2d: the remote timeout is 55 min and STALE_MINUTES 100 — the did-it-work
# window adds ~12 min to a healthy 2-host wave; see the default's site.)
#
# SWEEP (every 15 min via .github/workflows/deploy-watchdog.yml) — ONE
# unfiltered snapshot of the repo's recent runs feeds every decision below
# (see FILTER NOTE), so the arms can never disagree about fleet state:
#   1. STALE-RUN CANCEL — cancel any IN_PROGRESS run of the deploy workflow
#      whose updated_at is older than STALE_MINUTES (default 100). updated_at
#      advances only on JOB transitions — live-verified 2026-09-18: it froze
#      at the Deploy job's start for that job's ENTIRE 60.6 min on run
#      35291148017 — and healthy Deploy jobs have run as long as 72.4 min
#      (run 35182962283, found by the adversarial reviewer). 2026-09-20
#      incident (ticket 6d8d8beb): the 150-min default — deliberately ABOVE
#      the 120-min job timeout — meant this arm could never beat the
#      server-side kill: the sweep FIRED mid-wedge at 21:05Z (run
#      35533974170, 46 min silent) and correctly declined while the
#      serialized queue held. With the per-host blue-green phase now bounded
#      on-box (55-min remote timeout in deploy.yml since T2d 2026-10-17,
#      holding the did-it-work window), 100 min of zero job
#      progress is past the longest observed healthy job (72.4 min + ~12 min
#      window ≈ 84) with ~18% margin —
#      wedged or orphaned, never healthy — and beats the job timeout by
#      30 min. Cancelling the head releases the group and a queued/pending
#      run auto-starts (verified live: cancel 00:44:36Z → the waiting run's
#      jobs started 00:44:39Z).
#   2. ORPHAN RE-DISPATCH — if NO deploy.yml run is ACTIVE (see PENDING
#      HOLE) AND the newest completed deploy.yml run (by conclusion time,
#      i.e. updated_at — NOT created_at; a long-running older-created run
#      can conclude after a newer one) concluded cancelled|timed_out with
#      head_sha == current main HEAD AND fewer than REDISPATCH_MAX_PER_WINDOW
#      (default 2) cancelled|timed_out runs for that sha were created in the
#      last REDISPATCH_WINDOW_MINUTES (default 120) → workflow_dispatch
#      deploy.yml on main. `failure` conclusions are NEVER auto-retried: a
#      failing deploy is a real defect for a human/agent (and the
#      healthcheck's own redeploy arm covers prod-down), not something a
#      retry of the same sha can fix.
#   3. STRAND DETECTOR (ticket a4309ef9, 2026-10-16) — the SUCCESS-WITH-SKIP
#      strand: newest completed run concluded SUCCESS on main HEAD, but its
#      Deploy job was SKIPPED (the path filter's docs-only skip) while
#      undeployed runtime changes sit underneath (a cancelled deployable
#      wave the docs push superseded). Live 2026-10-16: carrier 38913411207
#      green-with-skip over cancelled wave 38912911194, main stranded until
#      a manual dispatch. The arm asks the SAME tested probe the path
#      filter's strand guard uses (deploy-strand-probe.sh) whether anything
#      runtime is undeployed; if yes → workflow_dispatch deploy.yml on main.
#      STRAND_DETECTOR_DISABLED=1 is the kill switch.
#
# THE PENDING HOLE (adversarial-review BLOCKING finding, live-verified
# 2026-09-18 on run 35295308698): a concurrency-BLOCKED deploy run reports
# status "pending" — invisible to BOTH the status=queued AND
# status=in_progress API listings (observed for ~22 min before it flipped
# pending→in_progress). An ACTIVE count built from those two listings reads
# 0 while a healthy run waits for the queue — and a re-dispatch in that
# window engages GitHub's one-running+one-pending rule, CANCELLING the
# healthy waiting run: the exact catastrophe this script exists to prevent.
# So ACTIVE is computed client-side as `.status != "completed"` over the
# unfiltered snapshot — queued, pending, waiting, requested, in_progress and
# any future non-terminal status all count. (The deploy.yml "Skip if a
# newer deploy is queued" gate had the same blind spot between 2026-09-01
# and 2026-09-18; it now queries status=pending too.)
#
# FILTER NOTE: GitHub IGNORES the workflow_id query param on the repo-wide
# runs endpoint (verified live 2026-09-18 — filename and numeric-id forms
# both returned CI/healthcheck runs), so every listing is filtered
# client-side on .path == DEPLOY_WORKFLOW_PATH. The deploy.yml gate had the
# unfiltered form of that bug from 2026-09-01 to 2026-09-18.
#
# HARD RULES:
#   - NEVER cancel a healthy in-progress deploy (ticket e1ccaa80's gate:
#     cancelling a healthy one is NOT cleared — the 90-min threshold, above
#     the longest observed healthy Deploy job (72.4 min, run 35182962283),
#     IS the zero-progress proof).
#   - NEVER dispatch while any deploy run is active — a fresh dispatch would
#     take the one pending slot and (per the one-pending rule) could CANCEL a
#     healthy queued/pending run.
#   - FAIL-SAFE: any API error OR unparsable count aborts the sweep with a
#     ::warning:: and exit 0 — no cancels, no dispatches on partial data
#     (adversarial review: an empty retry-cap count made bash's integer test
#     error out and the `if` fall through = fail-OPEN toward dispatch; every
#     gated count is now validated numeric first).
#   - Runs of OTHER workflows are never touched (FILTER NOTE).
#
# KNOWN CEILING: per_page=100 for the snapshot. Non-completed deploy runs
# can't exceed ~2 by the concurrency rule, and 100 runs covers many hours of
# this repo's push cadence for the completed/window views (measured ~12/h
# during the 2026-09-17 merge wave). A busier future repo should page.
#
# Requires: gh (GH_TOKEN with actions:write), jq, GNU date. The test harness
# (scripts/deploy/deploy-watchdog.test.sh) PATH-shims gh and drives
# NOW_EPOCH, so all filtering/decision logic is exercised with the real jq.
#
# Env: REPO (owner/name — required), MAIN_BRANCH (main), DEPLOY_WORKFLOW
# (deploy.yml — dispatch target), DEPLOY_WORKFLOW_PATH
# (.github/workflows/deploy.yml — client-side filter key), STALE_MINUTES
# (90 — above the 72.4-min healthy-job max, below the 120-min job timeout),
# REDISPATCH_WINDOW_MINUTES (120), REDISPATCH_MAX_PER_WINDOW (2 — counts DEAD
# cancelled|timed_out runs for the sha tolerated in the window: the FIRST
# dead run triggers one auto-dispatch, the SECOND silences the watchdog for
# that sha; i.e. default = exactly one auto-retry per sha per 2h),
# DRY_RUN (0 — 1 logs actions without POSTing), NOW_EPOCH (testing override).

set -u

# Hard prereqs — a missing binary must FAIL LOUD (red run), never silently
# no-op the watchdog (silent no-ops are the failure class this script exists
# to kill). Transient API/parse failures further down stay warn+exit-0
# fail-safe.
for bin in gh jq date; do
  command -v "$bin" >/dev/null 2>&1 || { echo "watchdog: required binary '$bin' not found" >&2; exit 2; }
done

REPO="${REPO:-}"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-deploy.yml}"
DEPLOY_PATH="${DEPLOY_WORKFLOW_PATH:-.github/workflows/deploy.yml}"
DEPLOY_JOB_NAME="${DEPLOY_JOB_NAME:-Deploy CrossModel}"
# 2026-10-17 (T2d, ticket b4824553): 90 → 100. The mandatory post-switch
# did-it-work window adds ~6 min per host (~12 min on the 2-host wave), so a
# healthy Deploy job now runs up to ~84 min (72.4-min historical max + 12);
# the old 90 left only ~6 min of margin before the watchdog would cancel a
# HEALTHY deploy mid-flight. 100 keeps the original ~18-min healthy margin
# and stays well below the 120-min job timeout.
STALE_MINUTES="${STALE_MINUTES:-100}"
WINDOW_MIN="${REDISPATCH_WINDOW_MINUTES:-120}"
MAX_REDISPATCH="${REDISPATCH_MAX_PER_WINDOW:-2}"
DRY_RUN="${DRY_RUN:-0}"
NOW="${NOW_EPOCH:-$(date -u +%s)}"

log()  { echo "watchdog: $*"; }
warn() { echo "::warning::watchdog: $*"; }
# A gated count that is not a non-negative integer means the snapshot was
# partial/corrupt — abort the sweep WITHOUT acting (fail-safe, never fail-
# open toward cancel/dispatch).
require_numeric() { # $1=value $2=label
  case "$1" in
    ''|*[!0-9]*) warn "$2 count unparsable ('$1') — sweep aborted (fail-safe)"; exit 0 ;;
  esac
}

if [ -z "$REPO" ]; then
  echo "watchdog: REPO (owner/name) is required" >&2
  exit 2
fi

iso_to_epoch() { date -u -d "$1" +%s; }

# ---------------------------------------------------------------------------
# ONE unfiltered snapshot — every decision below derives from it client-side.
# ---------------------------------------------------------------------------
ALL_JSON=$(gh api "repos/$REPO/actions/runs?per_page=100") || {
  warn "api error listing runs — sweep aborted (fail-safe)"
  exit 0
}

# ---------------------------------------------------------------------------
# 1. STALE-RUN CANCEL (in_progress only — a pending/queued run has not
#    started; cancelling it would kill the rescue, not the wedge)
# ---------------------------------------------------------------------------
IP_TOTAL=$(printf '%s' "$ALL_JSON" | jq -r --arg p "$DEPLOY_PATH" \
  '[.workflow_runs[] | select(.path == $p) | select(.status == "in_progress")] | length')
require_numeric "$IP_TOTAL" "in_progress"
STALE_N=0
CANCELLED_OK=0

while IFS='|' read -r rid rupdated rsha; do
  [ -n "$rid" ] || continue
  UP_EPOCH=$(iso_to_epoch "$rupdated") || { warn "unparsable updated_at '$rupdated' on run $rid — skipping it"; continue; }
  STALE_FOR=$(( (NOW - UP_EPOCH) / 60 ))
  if [ "$STALE_FOR" -gt "$STALE_MINUTES" ]; then
    STALE_N=$((STALE_N + 1))
    log "run $rid (sha $rsha) updated_at $rupdated = ${STALE_FOR}m with zero job progress (> ${STALE_MINUTES}m) — WEDGED"
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY_RUN: would cancel run $rid"
      CANCELLED_OK=$((CANCELLED_OK + 1))
    elif gh api -X POST "repos/$REPO/actions/runs/$rid/cancel" >/dev/null 2>&1; then
      log "CANCELLED wedged deploy run $rid"
      CANCELLED_OK=$((CANCELLED_OK + 1))
    else
      warn "cancel POST for run $rid failed (already terminal?) — treating it as still active"
    fi
  fi
done < <(printf '%s' "$ALL_JSON" | jq -r --arg p "$DEPLOY_PATH" \
  '.workflow_runs[] | select(.path == $p) | select(.status == "in_progress") | "\(.id)|\(.updated_at)|\(.head_sha[0:12])"')

# ---------------------------------------------------------------------------
# 2. Is anything still active? ACTIVE = every deploy run whose status is not
#    "completed" (THE PENDING HOLE — see header), minus the runs we just
#    cancelled. Queued/pending runs auto-start when the head leaves.
# ---------------------------------------------------------------------------
NONCOMPLETED=$(printf '%s' "$ALL_JSON" | jq -r --arg p "$DEPLOY_PATH" \
  '[.workflow_runs[] | select(.path == $p) | select(.status != "completed")] | length')
require_numeric "$NONCOMPLETED" "active"

ACTIVE=$(( NONCOMPLETED - CANCELLED_OK ))
log "deploy runs: in_progress=$IP_TOTAL active(non-completed)=$NONCOMPLETED wedged=$STALE_N cancelled-this-sweep=$CANCELLED_OK"
if [ "$ACTIVE" -gt 0 ]; then
  log "active deploy runs remain ($ACTIVE incl. any pending/queued) — nothing more to do"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. ORPHAN RE-DISPATCH — nothing active: did main HEAD's deploy die silently?
#    Newest completed run BY CONCLUSION TIME (updated_at), not created_at.
# ---------------------------------------------------------------------------
NEWEST=$(printf '%s' "$ALL_JSON" | jq -r --arg p "$DEPLOY_PATH" \
  '[.workflow_runs[] | select(.path == $p) | select(.status == "completed")]
   | sort_by(.updated_at) | reverse
   | (.[0] // empty) | "\(.conclusion)|\(.head_sha)|\(.id)"')

if [ -z "$NEWEST" ]; then
  log "no completed deploy runs found in the snapshot — nothing to evaluate; deploy queue healthy"
  exit 0
fi
N_CONCLUSION=${NEWEST%%|*}; REST=${NEWEST#*|}
N_SHA=${REST%%|*}; N_ID=${REST##*|}
log "no active deploy runs; newest completed deploy run $N_ID concluded '$N_CONCLUSION' (sha ${N_SHA:0:12})"

case "$N_CONCLUSION" in
  cancelled|timed_out) ;;
  success)
    # Do NOT exit here — arm 4 (strand detector) must inspect this run's
    # Deploy job: a SUCCESS run whose Deploy job was SKIPPED can still be
    # sitting on undeployed runtime changes (ticket a4309ef9, the live
    # carrier 38913411207 shape). Arm 4 exits "queue healthy" when the job
    # actually delivered.
    ;;
  *)
    log "conclusion '$N_CONCLUSION' is not auto-retried (cancelled|timed_out only — failures need a human/agent)"
    exit 0
    ;;
esac

MAIN_RESP=$(gh api "repos/$REPO/branches/$MAIN_BRANCH") || {
  warn "api error resolving $MAIN_BRANCH HEAD — re-dispatch skipped (fail-safe)"
  exit 0
}
MAIN_SHA=$(printf '%s' "$MAIN_RESP" | jq -r '.commit.sha')
if [ -z "$MAIN_SHA" ] || [ "$MAIN_SHA" = "null" ]; then
  warn "could not parse $MAIN_BRANCH HEAD sha — re-dispatch skipped (fail-safe)"
  exit 0
fi
if [ "$N_SHA" != "$MAIN_SHA" ]; then
  log "orphaned run's sha ${N_SHA:0:12} != $MAIN_BRANCH HEAD ${MAIN_SHA:0:12} — a newer sha owns the next deploy; not re-dispatching"
  exit 0
fi

if [ "$N_CONCLUSION" = "cancelled" ] || [ "$N_CONCLUSION" = "timed_out" ]; then
  # --- arm 3 only: the newest completed run DIED. (Success runs fall
  # through to arm 4 below — a green run row does not prove delivery.)
  # Retry cap: never auto-dispatch more than MAX_REDISPATCH times per sha per
  # window. Window math is client-side on created_at (no API-side `created`
  # filter — one less production-only failure mode; a 100-run page covers many
  # hours of this repo's push cadence).
  SINCE_EPOCH=$(( NOW - WINDOW_MIN * 60 ))
  RETRY_N=$(printf '%s' "$ALL_JSON" | jq -r --arg p "$DEPLOY_PATH" --arg s "$MAIN_SHA" --argjson since "$SINCE_EPOCH" \
    '[.workflow_runs[] | select(.path == $p) | select(.head_sha == $s)
      | select(.status == "completed") | select(.conclusion == "cancelled" or .conclusion == "timed_out")
      | select(.created_at | sub("\\.[0-9]+Z$"; "Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime >= $since)] | length')
  require_numeric "$RETRY_N" "retry-cap"

  if [ "$RETRY_N" -ge "$MAX_REDISPATCH" ]; then
    log "retry cap reached: $RETRY_N cancelled/timed_out runs for ${MAIN_SHA:0:12} in ${WINDOW_MIN}m (max $MAX_REDISPATCH) — NOT re-dispatching; leaving the trail for a human/agent"
    exit 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: would RE-DISPATCH $DEPLOY_WORKFLOW on $MAIN_BRANCH (orphaned '$N_CONCLUSION' run $N_ID, sha ${MAIN_SHA:0:12}, retry $RETRY_N/$MAX_REDISPATCH)"
    exit 0
  fi
  if gh api -X POST "repos/$REPO/actions/workflows/$DEPLOY_WORKFLOW/dispatches" -f "ref=$MAIN_BRANCH" >/dev/null 2>&1; then
    log "RE-DISPATCHED $DEPLOY_WORKFLOW on $MAIN_BRANCH — orphaned '$N_CONCLUSION' run $N_ID for ${MAIN_SHA:0:12} (retry $RETRY_N/$MAX_REDISPATCH in ${WINDOW_MIN}m)"
  else
    warn "dispatch POST failed — nothing re-triggered; next sweep re-evaluates"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. STRAND DETECTOR (ticket a4309ef9, 2026-10-16) — the SUCCESS-WITH-SKIP
#    strand: nothing active, newest completed deploy run concluded SUCCESS
#    for main HEAD, but its Deploy job was SKIPPED (path filter: docs-only
#    push) and that push sits on UNDEPLOYED runtime changes — the cancelled
#    deployable wave underneath. Live shape (all verbatim from the ticket):
#    carrier 38913411207 concluded success with `Deploy CrossModel`
#    conclusion "skipped" (the run row is green, so arm 3 above said
#    "queue healthy" and exited), cancelled wave 38912911194 never gated
#    (empty jobs list), main served the pre-fix build until a manual
#    workflow_dispatch (38917861836) un-stranded it. This arm closes the
#    loop: for a SUCCESS newest run on main HEAD, check the Deploy job's
#    conclusion; if it did NOT deliver (skipped/cancelled/anything but
#    success), ask the SAME tested probe the path filter consults
#    (scripts/deploy/deploy-strand-probe.sh) whether anything runtime is
#    undeployed in last-delivered..HEAD — if yes, re-dispatch.
#
#    LOOP BOUNDS (three, all real; adversarial review F3 corrected the
#    earlier "same cap as arm 3" claim): (1) the healthy path terminates at
#    the first rescue — a workflow_dispatch ALWAYS deploys (the filter's
#    escape hatch), so the next sweep's newest completed run has
#    Deploy=success and arm 4 exits healthy; (2) a rescue that DIES
#    (cancelled/timed_out) IS bounded by arm 3's retry cap (dead runs for
#    the sha in the window — every dead rescue adds one), so a wedged
#    rescue loop escalates to arm 3's cap and stops; (3) a probe
#    permanently answering stranded=yes while the newest run stays
#    success-with-skip costs one redundant deploy per sweep, bounded ONLY
#    by STRAND_DETECTOR_DISABLED=1 — the kill switch, the same posture as
#    every other watchdog arm. DRY_RUN-aware.
# ---------------------------------------------------------------------------
if [ "${STRAND_DETECTOR_DISABLED:-0}" = "1" ]; then
  log "strand detector disabled (STRAND_DETECTOR_DISABLED=1) — skipping arm 4"
  exit 0
fi
# Newest completed run is a SUCCESS on main HEAD (arm 3 exited above for
# cancelled|timed_out) — did it actually DELIVER?
NJOBS=$(gh api "repos/$REPO/actions/runs/$N_ID/jobs?per_page=100" 2>/dev/null) || {
  warn "api error listing jobs for run $N_ID — strand check aborted (fail-safe)"
  exit 0
}
DEPLOY_JOB_CONCL=$(printf '%s' "$NJOBS" | jq -r --arg j "$DEPLOY_JOB_NAME" '
  [.jobs[] | select(.name == $j) | .conclusion] | first // "missing"' 2>/dev/null)
case "$DEPLOY_JOB_CONCL" in
  success)
    log "newest run $N_ID delivered (Deploy job success) — deploy queue healthy"
    exit 0
    ;;
  skipped)
    log "newest run $N_ID is success-with-skip (Deploy job skipped — docs-only push at main HEAD)"
    ;;
  missing)
    # An empty/missing jobs list on a SUCCESS run: the cancelled-wave shape
    # (38912911194) or a probe failure. Ask the probe — it walks the run
    # list itself and fail-opens to stranded=yes if it cannot answer.
    log "newest run $N_ID has no Deploy job row (cancelled-before-gate or probe gap) — asking the strand probe"
    ;;
  *)
    log "newest run $N_ID Deploy job conclusion '$DEPLOY_JOB_CONCL' (not success, not skipped) — asking the strand probe"
    ;;
esac

# The same probe the path filter's strand guard uses — one tested truth for
# "is anything runtime undeployed on main HEAD?" (GH_TOKEN is exported by
# the workflow env; the probe fail-opens to stranded=yes).
PROBE_OUT=$(REPO="$REPO" GH_TOKEN="${GH_TOKEN:-}" HEAD_SHA="$MAIN_SHA" \
  bash "$(dirname "$(readlink -f "$0")")/deploy-strand-probe.sh" 2>/dev/null)
PROBE_ANSWER=$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^stranded=//p' | tail -1)
case "$PROBE_ANSWER" in
  yes) : ;; # stranded — fall through to the dispatch below
  no)
    log "strand probe says nothing runtime undeployed — deploy queue healthy (docs-only run, fully delivered ancestry)"
    exit 0
    ;;
  *)
    warn "strand probe unanswerable ('$PROBE_ANSWER') — sweep aborted (fail-safe, no dispatch)"
    exit 0
    ;;
esac

log "STRAND DETECTED: newest deploy run $N_ID concluded success but its Deploy job did not deliver, and runtime changes are undeployed on ${MAIN_SHA:0:12} — re-dispatching"
if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN: would RE-DISPATCH $DEPLOY_WORKFLOW on $MAIN_BRANCH (strand: success-with-skip run $N_ID, sha ${MAIN_SHA:0:12})"
  exit 0
fi
if gh api -X POST "repos/$REPO/actions/workflows/$DEPLOY_WORKFLOW/dispatches" -f "ref=$MAIN_BRANCH" >/dev/null 2>&1; then
  log "RE-DISPATCHED $DEPLOY_WORKFLOW on $MAIN_BRANCH — STRAND RESCUE (success-with-skip run $N_ID, sha ${MAIN_SHA:0:12})"
else
  warn "dispatch POST failed — nothing re-triggered; next sweep re-evaluates"
fi
exit 0

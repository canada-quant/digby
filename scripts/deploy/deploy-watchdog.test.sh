#!/usr/bin/env bash
# deploy-watchdog.test.sh — regression harness for deploy-watchdog.sh
# (feedback tickets 4b432e90 / e1ccaa80; 2026-09-18 wedge incident;
# adversarial-review rework 2026-09-18).
#
# PATH-injected `gh` shim serves ONE canned unfiltered Actions-API snapshot
# and records every POST; the REAL jq executes the script's filters, so the
# decision logic — including the client-side .path filter (GitHub IGNORES the
# workflow_id query param, verified live 2026-09-18) and the
# `.status != "completed"` ACTIVE gate — is exercised end to end. NOW_EPOCH
# is injected for deterministic time math. No network needed.
#
# Pins the incident contract AND the adversarial-review findings:
#   - a healthy in-progress deploy is NEVER cancelled (ticket e1ccaa80's gate),
#   - a zero-progress in-progress run past STALE_MINUTES IS cancelled,
#   - PENDING HOLE (BLOCKING review finding, live-verified on run 35295308698):
#     a concurrency-blocked run reports status=pending, invisible to
#     queued/in_progress listings — it MUST count as active and suppress
#     re-dispatch (else the dispatch cancels a healthy waiting run via the
#     one-pending rule),
#   - a queued run suppresses re-dispatch (it auto-starts when the head leaves),
#   - the orphan hole (nothing active + newest completed cancelled|timed_out on
#     main HEAD) re-dispatches — tonight's exact failure,
#   - newest-completed is chosen by CONCLUSION time (updated_at), not created_at,
#   - failure conclusions are never auto-retried,
#   - the per-sha retry cap stops dispatch loops,
#   - runs of other workflows are invisible to every decision,
#   - DRY_RUN logs but never POSTs; API failure AND corrupt JSON both abort
#     fail-safe (never fail-open toward cancel/dispatch).
#
# Run from anywhere: bash scripts/deploy/deploy-watchdog.test.sh
set -u
command -v jq >/dev/null 2>&1 || { echo "deploy-watchdog.test.sh: jq is required (preinstalled on CI ubuntu runners)" >&2; exit 1; }
cd "$(dirname "$0")"
SCRIPT=./deploy-watchdog.sh
SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()   { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

MAIN=aaaa1111bbbb2222cccc3333dddd4444eeee5555
OTHER=9999888877776666555544443333222211110000
DPATH=.github/workflows/deploy.yml
CPATH=.github/workflows/ci.yml
NOW=$(date -u -d '2026-09-18 02:00:00Z' +%s)

ago() { date -u -d "@$(( NOW - $1 * 60 ))" +%Y-%m-%dT%H:%M:%SZ; }   # $1=minutes ago

# mkrun <id> <path> <status> <conclusion|null> <sha> <created> <updated>
mkrun() {
  local concl="$4"; [ "$concl" = "null" ] || concl="\"$concl\""
  printf '{"id":%s,"name":"x","path":"%s","status":"%s","conclusion":%s,"head_sha":"%s","created_at":"%s","updated_at":"%s"}' \
    "$1" "$2" "$3" "$concl" "$5" "$6" "$7"
}
wrap() { local n=$#; printf '{"total_count":%s,"workflow_runs":[%s]}' "$n" "$(IFS=,; echo "$*")"; }

# --- gh shim ---------------------------------------------------------------
mkdir -p "$SBX/shim"
cat > "$SBX/shim/gh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "api" ] || { echo "gh-shim: unsupported: $*" >&2; exit 1; }
shift
method=GET; endpoint=''
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift 2 ;;
    -f|-F|--field|--raw-field|--jq|-q|-H|--header) shift 2 ;;
    --input) shift 2 ;;
    *) endpoint="$1"; shift ;;
  esac
done
if [ "${FIXTURE_API_FAIL:-0}" = "1" ] && [ "$method" = "GET" ]; then
  echo "gh: HTTP 502: api error (fixture)" >&2; exit 1
fi
case "$method $endpoint" in
  "GET repos/octo/test/actions/runs?per_page=100") cat "$FIX/all.json" ;;
  "GET repos/octo/test/branches/main")             cat "$FIX/branches.json" ;;
  # arm 4 (strand detector, ticket a4309ef9): per-run jobs + the strand
  # probe's own calls (workflow-scoped listing preferred, repo-wide
  # fallback, compare) — served from $FIX/strand/ fixtures the strand legs
  # set up; a MISSING fixture is an unhandled endpoint (the shim exits 1),
  # which the probe fail-opens on — so legs that don't reach arm 4 never
  # depend on these files existing. GET-call markers go to calls.log, NOT
  # post.log (nposts counts post.log only — the existing legs' contracts).
  "GET repos/octo/test/actions/runs/"*"/jobs?per_page=100")
    rid=${endpoint#repos/octo/test/actions/runs/}; rid=${rid%/jobs?per_page=100}
    echo "jobs $rid" >> "$FIX/calls.log"
    cat "$FIX/jobs-$rid.json" ;;
  "GET repos/octo/test/actions/workflows/deploy.yml/runs?per_page=100&status=completed")
    echo "wf-listing" >> "$FIX/calls.log"
    cat "$FIX/strand-wfruns.json" ;;
  "GET repos/octo/test/actions/runs?per_page=100&status=completed")
    echo "repowide-listing" >> "$FIX/calls.log"
    cat "$FIX/strand-runs.json" ;;
  "GET repos/octo/test/compare/"*)
    echo "compare" >> "$FIX/calls.log"
    cat "$FIX/strand-compare.json" ;;
  "POST repos/octo/test/actions/runs/"*"/cancel")
    rid=${endpoint#repos/octo/test/actions/runs/}; rid=${rid%/cancel}
    echo "cancel $rid" >> "$FIX/post.log" ;;
  "POST repos/octo/test/actions/workflows/deploy.yml/dispatches")
    echo "dispatch" >> "$FIX/post.log" ;;
  *) echo "gh-shim: unhandled: $method $endpoint" >&2; exit 1 ;;
esac
EOF
chmod +x "$SBX/shim/gh"

FIX="$SBX/fix"; mkdir -p "$FIX"
reset() {
  : > "$FIX/post.log"
  : > "$FIX/calls.log" 2>/dev/null || true
  wrap > "$FIX/all.json"
  printf '{"commit":{"sha":"%s"}}' "$MAIN" > "$FIX/branches.json"
  unset FIXTURE_API_FAIL
}

JQD=$(dirname "$(command -v jq)")
run_watchdog() { # $1 = extra env assignments → rc; captures $FIX/{stdout,stderr}
  env -i PATH="$SBX/shim:$JQD:/usr/bin:/bin" HOME="$SBX" \
    FIX="$FIX" REPO=octo/test MAIN_BRANCH=main NOW_EPOCH="$NOW" \
    FIXTURE_API_FAIL="${FIXTURE_API_FAIL:-0}" \
    $1 bash "$SCRIPT" > "$FIX/stdout" 2> "$FIX/stderr"
}

posts()  { cat "$FIX/post.log"; }
nposts() { grep -c . "$FIX/post.log" || true; }

echo "== case 1: healthy in-progress deploy + newest completed success => no actions =="
reset
wrap "$(mkrun 501 "$DPATH" in_progress null "$MAIN" "$(ago 30)" "$(ago 5)")" \
     "$(mkrun 500 "$DPATH" completed success "$OTHER" "$(ago 200)" "$(ago 170)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "no POSTs" 0 "$(nposts)"
check "logs active runs remain" yes "$(grep -q 'active deploy runs remain' "$FIX/stdout" && echo yes || echo no)"

echo "== case 2: wedged in-progress run + PENDING deploy waiting (the blocking review finding) => cancel only, NO dispatch =="
reset
wrap "$(mkrun 601 "$DPATH" in_progress null "$MAIN" "$(ago 300)" "$(ago 200)")" \
     "$(mkrun 602 "$DPATH" pending null "$MAIN" "$(ago 60)" "$(ago 60)")" \
     "$(mkrun 500 "$DPATH" completed success "$OTHER" "$(ago 400)" "$(ago 380)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "cancelled the wedged run id" "cancel 601" "$(posts)"
check "log names the wedge" yes "$(grep -q 'WEDGED' "$FIX/stdout" && echo yes || echo no)"

echo "== case 3: wedged run cancelled, nothing else active, newest completed = cancelled main HEAD => cancel + re-dispatch =="
reset
wrap "$(mkrun 701 "$DPATH" in_progress null "$MAIN" "$(ago 300)" "$(ago 200)")" \
     "$(mkrun 700 "$DPATH" completed cancelled "$MAIN" "$(ago 320)" "$(ago 40)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "cancel then dispatch" "cancel 701
dispatch" "$(posts)"
check "log announces re-dispatch" yes "$(grep -q 'RE-DISPATCHED' "$FIX/stdout" && echo yes || echo no)"

echo "== case 4: orphan hole (nothing active, newest completed cancelled on main HEAD, out-of-window cancels ignored) => dispatch =="
reset
wrap "$(mkrun 800 "$DPATH" completed cancelled "$MAIN" "$(ago 40)" "$(ago 35)")" \
      "$(mkrun 799 "$DPATH" completed cancelled "$MAIN" "$(ago 500)" "$(ago 495)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "exactly one dispatch" "dispatch" "$(posts)"
check "window filter: only the in-window cancel counted (retry 1/2)" yes \
  "$(grep -q 'retry 1/2' "$FIX/stdout" && echo yes || echo no)"

echo "== case 5: retry cap — newest cancelled + one prior cancelled in-window => NO dispatch =="
reset
wrap "$(mkrun 900 "$DPATH" completed cancelled "$MAIN" "$(ago 30)" "$(ago 25)")" \
      "$(mkrun 899 "$DPATH" completed cancelled "$MAIN" "$(ago 90)" "$(ago 85)")" \
      "$(mkrun 898 "$DPATH" completed success "$OTHER" "$(ago 400)" "$(ago 380)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "no POSTs at cap" 0 "$(nposts)"
check "cap logged" yes "$(grep -q 'retry cap reached' "$FIX/stdout" && echo yes || echo no)"

echo "== case 6: newest completed = failure => never auto-retried =="
reset
wrap "$(mkrun 910 "$DPATH" completed failure "$MAIN" "$(ago 30)" "$(ago 25)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "no POSTs on failure" 0 "$(nposts)"
check "failure-not-retried logged" yes "$(grep -q 'not auto-retried' "$FIX/stdout" && echo yes || echo no)"

echo "== case 7: other workflows invisible — stale CI run not cancelled; healthy deploy untouched =="
reset
wrap "$(mkrun 920 "$CPATH" in_progress null "$MAIN" "$(ago 600)" "$(ago 400)")" \
      "$(mkrun 921 "$DPATH" in_progress null "$MAIN" "$(ago 10)" "$(ago 2)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "no cancel of foreign/healthy runs" 0 "$(nposts)"

echo "== case 8: DRY_RUN — full decision chain logged, zero POSTs =="
reset
wrap "$(mkrun 930 "$DPATH" in_progress null "$MAIN" "$(ago 300)" "$(ago 200)")" \
     "$(mkrun 929 "$DPATH" completed cancelled "$MAIN" "$(ago 320)" "$(ago 315)")" > "$FIX/all.json"
run_watchdog "DRY_RUN=1"; rc=$?
check "exit 0" 0 "$rc"
check "no POSTs in dry run" 0 "$(nposts)"
check "would-cancel logged" yes "$(grep -q 'DRY_RUN: would cancel run 930' "$FIX/stdout" && echo yes || echo no)"
check "would-dispatch logged" yes "$(grep -q 'DRY_RUN: would RE-DISPATCH' "$FIX/stdout" && echo yes || echo no)"

echo "== case 9: API failure => fail-safe (exit 0, warning, no actions) =="
reset
wrap "$(mkrun 940 "$DPATH" in_progress null "$MAIN" "$(ago 300)" "$(ago 200)")" > "$FIX/all.json"
export FIXTURE_API_FAIL=1
run_watchdog ""; rc=$?
unset FIXTURE_API_FAIL
check "exit 0 on api failure" 0 "$rc"
check "no POSTs on api failure" 0 "$(nposts)"
check "warning emitted" yes "$(grep -q '^::warning::watchdog: api error' "$FIX/stdout" && echo yes || echo no)"

echo "== case 10: orphan cancelled run for a STALE sha ( != main HEAD ) => no dispatch =="
reset
wrap "$(mkrun 950 "$DPATH" completed cancelled "$OTHER" "$(ago 30)" "$(ago 25)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "no dispatch for stale sha" 0 "$(nposts)"
check "sha-mismatch logged" yes "$(grep -q '!= main HEAD' "$FIX/stdout" && echo yes || echo no)"

echo "== case 11: fractional-second timestamps + timed_out conclusion handled =="
reset
printf '{"total_count":2,"workflow_runs":[{"id":960,"name":"x","path":"%s","status":"completed","conclusion":"timed_out","head_sha":"%s","created_at":"2026-09-18T01:30:00.123Z","updated_at":"2026-09-18T01:35:00Z"},{"id":959,"name":"x","path":"%s","status":"completed","conclusion":"success","head_sha":"%s","created_at":"2026-09-18T00:00:00Z","updated_at":"2026-09-18T00:30:00Z"}]}' \
  "$DPATH" "$MAIN" "$DPATH" "$OTHER" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "timed_out orphan re-dispatched" "dispatch" "$(posts)"

echo "== case 12: PENDING-HOLE pin — pending deploy + cancelled-main orphan => NO dispatch, NO cancel (review finding) =="
reset
wrap "$(mkrun 970 "$DPATH" pending null "$MAIN" "$(ago 20)" "$(ago 20)")" \
      "$(mkrun 969 "$DPATH" completed cancelled "$MAIN" "$(ago 90)" "$(ago 80)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "no POSTs while a run is pending" 0 "$(nposts)"
check "pending counted as active" yes "$(grep -q 'active deploy runs remain' "$FIX/stdout" && echo yes || echo no)"

echo "== case 13: newest-completed chosen by CONCLUSION time (updated_at), not created_at =="
reset
# A: created 10m ago (newer attempt) but concluded 40m ago, success, OTHER sha.
# B: created 60m ago (older attempt) but concluded 5m ago, cancelled, MAIN sha.
# updated_at ordering picks B => orphan dispatch; created_at ordering would pick A and wrongly report healthy.
wrap "$(mkrun 981 "$DPATH" completed success "$OTHER" "$(ago 10)" "$(ago 40)")" \
      "$(mkrun 980 "$DPATH" completed cancelled "$MAIN" "$(ago 60)" "$(ago 5)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "dispatch fires for the most-recently-CONCLUDED cancelled main run" "dispatch" "$(posts)"

echo "== case 14: corrupt snapshot JSON => fail-safe (warning, exit 0, zero POSTs — never fail-open toward dispatch) =="
reset
printf '{broken json' > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0 on corrupt json" 0 "$rc"
check "no POSTs on corrupt json" 0 "$(nposts)"
check "unparsable warning emitted" yes "$(grep -q 'unparsable' "$FIX/stdout" && echo yes || echo no)"

echo "== case 15: queued run suppresses dispatch (auto-starts when the head leaves) =="
reset
wrap "$(mkrun 991 "$DPATH" in_progress null "$MAIN" "$(ago 300)" "$(ago 200)")" \
      "$(mkrun 992 "$DPATH" queued null "$MAIN" "$(ago 60)" "$(ago 60)")" \
      "$(mkrun 990 "$DPATH" completed cancelled "$MAIN" "$(ago 320)" "$(ago 310)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "cancelled wedged head" "cancel 991" "$(posts)"
check "queued run suppressed dispatch" yes "$(grep -q '^dispatch$' "$FIX/post.log" && echo no || echo yes)"

echo "== case 13 (ticket 6d8d8beb — 2026-09-20 incident replay): in_progress deploy silent 110m — past the 100m threshold (90 before T2d 2026-10-17: the did-it-work window stretched healthy runs ~12 min), BELOW the 120m job timeout — IS cancelled (the old 150m default never fired here; runs 35532250231/35533974170 held the queue to manual cancels) =="
reset
wrap "$(mkrun 993 "$DPATH" in_progress null "$MAIN" "$(ago 140)" "$(ago 110)")" \
     "$(mkrun 500 "$DPATH" completed success "$OTHER" "$(ago 400)" "$(ago 380)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "cancelled the 110m-silent run" "cancel 993" "$(posts)"
check "log names the wedge" yes "$(grep -q 'WEDGED' "$FIX/stdout" && echo yes || echo no)"

echo "== case 14 (ticket 6d8d8beb margin pin): in_progress deploy silent 80m — above the 72.4m healthy max, BELOW the 100m threshold — is NOT cancelled =="
reset
wrap "$(mkrun 994 "$DPATH" in_progress null "$MAIN" "$(ago 100)" "$(ago 80)")" \
     "$(mkrun 500 "$DPATH" completed success "$OTHER" "$(ago 400)" "$(ago 380)")" > "$FIX/all.json"
run_watchdog ""; rc=$?
check "exit 0" 0 "$rc"
check "80m-silent run left alone" 0 "$(nposts)"
check "active run logged" yes "$(grep -q 'active deploy runs remain' "$FIX/stdout" && echo yes || echo no)"

echo "== case 16 (ticket a4309ef9, live 2026-10-16): STRAND — newest completed SUCCESS at main HEAD, Deploy job SKIPPED, runtime undeployed under it → arm 4 RE-DISPATCHES =="
# The reproduced shape, verbatim: carrier run (success, Deploy job skipped)
# over a cancelled wave (empty jobs) over a delivered run at an older sha,
# with runtime files between delivered and HEAD.
DELIVERED=aaaaaaaa111111111111111111111111111111
# strand_setup <compare-files-json> — builds the arm-4 fixture stack
strand_setup() {
  reset
  wrap "$(mkrun 983 "$DPATH" completed success "$MAIN" "$(ago 40)" "$(ago 30)")" \
       "$(mkrun 982 "$DPATH" completed cancelled "$MAIN" "$(ago 60)" "$(ago 55)")" \
       "$(mkrun 981 "$DPATH" completed success "$DELIVERED" "$(ago 300)" "$(ago 280)")" > "$FIX/all.json"
  # carrier 983's jobs: Deploy CrossModel SKIPPED (the docs-only carrier)
  printf '{"total_count":3,"jobs":[{"name":"Skip if a newer deploy is queued","status":"completed","conclusion":"success"},{"name":"Test gate","status":"completed","conclusion":"skipped"},{"name":"Deploy CrossModel","status":"completed","conclusion":"skipped"}]}' > "$FIX/jobs-983.json"
  # the strand probe's fixtures (arm 4 invokes it): walk sees carrier(983,
  # skipped) → cancelled wave(982, no jobs row) → delivered(981) → compare
  # delivered..MAIN has runtime files ⇒ stranded=yes ⇒ dispatch
  cp "$FIX/all.json" "$FIX/strand-wfruns.json"
  printf '{"total_count":0,"jobs":[]}' > "$FIX/jobs-982.json"
  printf '{"total_count":2,"jobs":[{"name":"Skip if a newer deploy is queued","status":"completed","conclusion":"success"},{"name":"Deploy CrossModel","status":"completed","conclusion":"success"}]}' > "$FIX/jobs-981.json"
  printf '{"status":"ahead","ahead_by":1,"behind_by":0,"files":%s}' "$1" > "$FIX/strand-compare.json"
}
STRAND_RUNTIME='[{"filename":"backend/src/service.ts"},{"filename":"docs/notes.md"},{"filename":"frontend/app/page.tsx"}]'
strand_setup "$STRAND_RUNTIME"
run_watchdog ""; rc=$?
check "strand leg: exit 0" 0 "$rc"
check "strand leg: DISPATCH fired" "yes" "$(grep -q '^dispatch$' "$FIX/post.log" && echo yes || echo no)"
check "strand detected log" yes "$(grep -q 'STRAND DETECTED' "$FIX/stdout" && echo yes || echo no)"
check "strand rescue log names the carrier" yes "$(grep -q 'success-with-skip run 983' "$FIX/stdout" && echo yes || echo no)"
check "no cancel in the strand leg" "no" "$(grep -q '^cancel ' "$FIX/post.log" && echo yes || echo no)"

echo "== case 17 (a4309ef9): SUCCESS newest run that DELIVERED → no dispatch (arm 4's healthy exit) =="
reset
wrap "$(mkrun 983 "$DPATH" completed success "$MAIN" "$(ago 40)" "$(ago 30)")" > "$FIX/all.json"
printf '{"total_count":3,"jobs":[{"name":"Skip if a newer deploy is queued","status":"completed","conclusion":"success"},{"name":"Test gate / Backend tests","status":"completed","conclusion":"success"},{"name":"Deploy CrossModel","status":"completed","conclusion":"success"}]}' > "$FIX/jobs-983.json"
run_watchdog ""; rc=$?
check "delivered leg: exit 0" 0 "$rc"
check "delivered leg: no dispatch" 0 "$(nposts)"
check "delivered log" yes "$(grep -q 'delivered (Deploy job success)' "$FIX/stdout" && echo yes || echo no)"

echo "== case 18 (a4309ef9): docs-only carrier, everything delivered beneath → probe says no → no dispatch =="
reset
wrap "$(mkrun 983 "$DPATH" completed success "$MAIN" "$(ago 40)" "$(ago 30)")" \
     "$(mkrun 981 "$DPATH" completed success "$MAIN" "$(ago 300)" "$(ago 280)")" > "$FIX/all.json"
printf '{"total_count":3,"jobs":[{"name":"Skip if a newer deploy is queued","status":"completed","conclusion":"success"},{"name":"Deploy CrossModel","status":"completed","conclusion":"skipped"}]}' > "$FIX/jobs-983.json"
cp "$FIX/all.json" "$FIX/strand-wfruns.json"
printf '{"total_count":2,"jobs":[{"name":"Deploy CrossModel","status":"completed","conclusion":"success"}]}' > "$FIX/jobs-981.json"
# last delivered == HEAD (981 at MAIN): probe answers no at the identity
# check; compare never consulted
printf '{"status":"identical","files":[]}' > "$FIX/strand-compare.json"
run_watchdog ""; rc=$?
check "docs-carrier fully delivered: exit 0" 0 "$rc"
check "docs-carrier fully delivered: no dispatch" 0 "$(nposts)"
check "probe-healthy log" yes "$(grep -q 'nothing runtime undeployed' "$FIX/stdout" && echo yes || echo no)"

echo "== case 19 (a4309ef9): STRAND_DETECTOR_DISABLED=1 → no dispatch (kill switch) =="
strand_setup "$STRAND_RUNTIME"
run_watchdog "STRAND_DETECTOR_DISABLED=1"; rc=$?
check "kill switch: exit 0" 0 "$rc"
check "kill switch: no dispatch" 0 "$(nposts)"
check "kill switch logged" yes "$(grep -q 'strand detector disabled' "$FIX/stdout" && echo yes || echo no)"

echo "== case 20 (a4309ef9): DRY_RUN — strand logged, zero POSTs =="
strand_setup "$STRAND_RUNTIME"
run_watchdog "DRY_RUN=1"; rc=$?
check "dry-run strand: exit 0" 0 "$rc"
check "dry-run strand: no POSTs" 0 "$(nposts)"
check "dry-run would-dispatch logged" yes "$(grep -q 'DRY_RUN: would RE-DISPATCH' "$FIX/stdout" && echo yes || echo no)"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "deploy-watchdog tests OK ($PASS assertions)"
else
  echo "$FAIL assertion(s) failed ($PASS passed)" >&2
  exit 1
fi

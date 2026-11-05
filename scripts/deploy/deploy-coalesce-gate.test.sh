#!/usr/bin/env bash
# deploy-coalesce-gate.test.sh — regression harness for
# scripts/deploy/deploy-coalesce-gate.sh (nightly shortfall hunt 2026-10-15,
# goal b3f240e4). PATH-injected `gh` shim serves ONE canned Actions-API
# snapshot; the REAL jq executes the script's filters, so the decision logic
# — client-side .path filter, .id > RUN_ID, .status != "completed"
# non-terminal coverage — runs end to end. No network needed.
#
# PINS THE 2026-10-15 INCIDENT (all three live shapes):
#   - THE 403: the gate job's gh api 403'd "Resource not accessible by
#     integration" on every probe (runs 38732795715 / 38758671580 /
#     38762990699, 2026-10-15) and the old inline code glued `|| echo 0`
#     onto the error body; the corrupted count then hit bash's integer-test
#     ERROR path, which errors out FALSE — superseded=no, silently, every
#     run. The extracted script must instead: exit superseded=no (deploy
#     anyway — a wrongly-SKIPPED deploy strands main with nothing to
#     redeploy it) AND emit a ::warning:: so the regression is observable
#     from the Actions summary.
#   - gh rc!=0 (auth/HTTP) — never counted as "no newer runs" quietly.
#   - rc=0 but a body that does not decode to a runs listing — same.
#   - a count that is not a non-negative integer — same (require_numeric).
#
# PINS THE GATE CONTRACT (unchanged since PR #573):
#   - newer QUEUED deploy run → superseded=yes (the merge-wave catch-up),
#   - newer PENDING (concurrency-blocked) deploy run → superseded=yes
#     (the pending hole, live-verified 2026-09-18 on run 35295308698),
#   - newer WAITING / REQUESTED deploy run → superseded=yes (status-blind
#     spot of the old three-per-status probes — ANY non-terminal counts),
#   - newer run of ANOTHER workflow (CI/healthcheck) → superseded=no
#     (GitHub ignores the workflow_id param; client-side .path filter),
#   - OLDER non-terminal deploy run → superseded=no (id ordering),
#   - newer COMPLETED deploy run → superseded=no (terminal, not waiting),
#   - nothing newer at all → superseded=no, no warning,
#   - RUN_ID/REPO unset → superseded=no + warning (never a hard failure).
#
# Run from anywhere: bash scripts/deploy/deploy-coalesce-gate.test.sh
set -u
command -v jq >/dev/null 2>&1 || { echo "deploy-coalesce-gate.test.sh: jq is required (preinstalled on CI ubuntu runners)" >&2; exit 1; }
cd "$(dirname "$0")"
SCRIPT=./deploy-coalesce-gate.sh
SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()   { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

REPO=octo/test
DPATH=.github/workflows/deploy.yml
CPATH=.github/workflows/ci.yml
ME=5000  # this run's id; "newer" = id > ME

# THE LIVE 403 BODY (run 38732795715 gate log, 2026-10-15T12:11:48Z) — kept
# verbatim-in-substance; the old inline gate logged it glued to a 0.
LIVE_403='{"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/actions/workflow-runs#list-workflow-runs-for-a-repository","status":"403"}'

# mkrun <id> <path> <status> [conclusion]
mkrun() {
  local concl="null"; [ "${4:-}" != "" ] && [ "$4" != "null" ] && concl="\"$4\""
  printf '{"id":%s,"name":"x","path":"%s","status":"%s","conclusion":%s}' "$1" "$2" "$3" "$concl"
}
wrap() { local n=$#; printf '{"total_count":%s,"workflow_runs":[%s]}' "$n" "$(IFS=,; echo "$*")"; }

# --- gh shim ---------------------------------------------------------------
mkdir -p "$SBX/shim"
cat > "$SBX/shim/gh" <<EOF
#!/usr/bin/env bash
[ "\$1" = "api" ] || { echo "gh-shim: unsupported: \$*" >&2; exit 1; }
if [ "\${FIXTURE_API_FAIL:-0}" = "1" ]; then
  # the live shape: error body on STDOUT, rc=1 — the old
  # \$(gh api … 2>/dev/null || echo 0) glued a 0 onto exactly this
  printf '%s' '$LIVE_403'
  echo "gh: exit status 1" >&2
  exit 1
fi
if [ "\${FIXTURE_GARBAGE:-0}" = "1" ]; then
  printf 'not-json-at-all'
  exit 0
fi
if [ "\${FIXTURE_NO_RUNS_KEY:-0}" = "1" ]; then
  printf '{"total_count":0}'
  exit 0
fi
cat "\$FIX/all.json"
EOF
chmod +x "$SBX/shim/gh"
FIX="$SBX/fix"; mkdir -p "$FIX"

JQD=$(dirname "$(command -v jq)")

# run_gate <extra env assignments> — captures stdout/stderr + GITHUB_OUTPUT
run_gate() {
  rm -f "$SBX/out" "$SBX/ghout"
  env -i PATH="$SBX/shim:$JQD:/usr/bin:/bin" HOME="$SBX" FIX="$FIX" \
    RUN_ID="$ME" REPO="$REPO" GITHUB_OUTPUT="$SBX/ghout" \
    $1 bash "$SCRIPT" > "$SBX/out" 2> "$SBX/err"
}
superseded() { grep -c '^superseded=' "$SBX/ghout" >/dev/null 2>&1 && sed -n 's/^superseded=//p' "$SBX/ghout"; }
warned()     { grep -q '::warning::coalesce-gate' "$SBX/out" && echo yes || echo no; }

reset() { unset FIXTURE_API_FAIL FIXTURE_GARBAGE FIXTURE_NO_RUNS_KEY; FIXTURE_API_FAIL=0; FIXTURE_GARBAGE=0; FIXTURE_NO_RUNS_KEY=0; }

# --- 1. nothing newer → deploy (no warning) ---------------------------------
reset
wrap "$(mkrun 4999 "$DPATH" in_progress)" > "$FIX/all.json"
run_gate ""
check "quiet queue → superseded=no"        "no" "$(superseded)"
check "quiet queue → no warning"           "no" "$(warned)"

# --- 2. newer QUEUED deploy run → skip (the merge-wave catch-up) ------------
reset
wrap "$(mkrun 4999 "$DPATH" in_progress)" "$(mkrun 5001 "$DPATH" queued)" > "$FIX/all.json"
run_gate ""
check "newer queued → superseded=yes"      "yes" "$(superseded)"
check "newer queued → no warning"          "no" "$(warned)"

# --- 3. newer PENDING (concurrency-blocked) run → skip (the pending hole) ---
reset
wrap "$(mkrun 4998 "$DPATH" in_progress)" "$(mkrun 5002 "$DPATH" pending)" > "$FIX/all.json"
run_gate ""
check "newer pending → superseded=yes"     "yes" "$(superseded)"

# --- 4. newer WAITING / REQUESTED run → skip (old probes were status-blind) -
reset
wrap "$(mkrun 5003 "$DPATH" waiting)" "$(mkrun 5004 "$DPATH" requested)" > "$FIX/all.json"
run_gate ""
check "newer waiting/requested → superseded=yes" "yes" "$(superseded)"

# --- 5. newer run of ANOTHER workflow → deploy (client-side .path filter) ---
reset
wrap "$(mkrun 4999 "$DPATH" in_progress)" "$(mkrun 5010 "$CPATH" queued)" "$(mkrun 5011 "$CPATH" in_progress)" > "$FIX/all.json"
run_gate ""
check "newer CI runs → superseded=no"      "no" "$(superseded)"
check "newer CI runs → no warning"         "no" "$(warned)"

# --- 6. OLDER non-terminal deploy run → deploy (id ordering) ----------------
reset
wrap "$(mkrun 4990 "$DPATH" queued)" "$(mkrun 4999 "$DPATH" in_progress)" > "$FIX/all.json"
run_gate ""
check "older non-terminal → superseded=no" "no" "$(superseded)"

# --- 7. newer COMPLETED deploy run → deploy (terminal, not waiting) ---------
reset
wrap "$(mkrun 4999 "$DPATH" in_progress)" "$(mkrun 5010 "$DPATH" completed success)" > "$FIX/all.json"
run_gate ""
check "newer completed → superseded=no"    "no" "$(superseded)"

# --- 8. THE 403 (live shape: body on stdout, rc=1) → deploy + WARNING -------
reset
FIXTURE_API_FAIL=1
run_gate "FIXTURE_API_FAIL=1"
check "403 rc=1 → superseded=no (deploy)"  "no"  "$(superseded)"
check "403 rc=1 → ::warning:: emitted"     "yes" "$(warned)"
check "403 rc=1 → warning names the rc"    "yes" "$(grep -q 'rc=1' "$SBX/out" && echo yes || echo no)"
check "403 rc=1 → warning quotes the 403 body" "yes" "$(grep -q 'Resource not accessible by integration' "$SBX/out" && echo yes || echo no)"

# --- 9. rc=0 but garbage body → deploy + WARNING (never a quiet default) ----
reset
run_gate "FIXTURE_GARBAGE=1"
check "garbage body → superseded=no"       "no"  "$(superseded)"
check "garbage body → ::warning:: emitted" "yes" "$(warned)"

# --- 10. rc=0 but no workflow_runs key → deploy + WARNING -------------------
reset
run_gate "FIXTURE_NO_RUNS_KEY=1"
check "no runs key → superseded=no"        "no"  "$(superseded)"
check "no runs key → ::warning:: emitted"  "yes" "$(warned)"

# --- 11. RUN_ID unset → deploy + WARNING (never a hard failure) -------------
reset
wrap "$(mkrun 5001 "$DPATH" queued)" > "$FIX/all.json"
rm -f "$SBX/ghout"
env -i PATH="$SBX/shim:$JQD:/usr/bin:/bin" HOME="$SBX" FIX="$FIX" \
  REPO="$REPO" GITHUB_OUTPUT="$SBX/ghout" bash "$SCRIPT" > "$SBX/out" 2> "$SBX/err"
check "RUN_ID unset → superseded=no"       "no"  "$(superseded)"
check "RUN_ID unset → ::warning:: emitted" "yes" "$(warned)"

# --- 12. GITHUB_OUTPUT always carries EXACTLY one superseded= line ----------
reset
wrap "$(mkrun 5001 "$DPATH" queued)" > "$FIX/all.json"
run_gate ""
check "one superseded= line written"       "1"   "$(grep -c '^superseded=' "$SBX/ghout")"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "deploy-coalesce-gate.test.sh: $PASS passed, $FAIL FAILED"
  exit 1
fi
echo "deploy-coalesce-gate.test.sh: $PASS passed, $FAIL failed"

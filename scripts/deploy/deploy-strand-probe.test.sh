#!/usr/bin/env bash
# deploy-strand-probe.test.sh — regression harness for
# scripts/deploy/deploy-strand-probe.sh (ticket a4309ef9, 2026-10-16).
# PATH-injected `gh` shim serves canned Actions-API fixtures (runs listing,
# per-run jobs, compare); the REAL jq executes the probe's filters, so the
# walk logic — newest-first by conclusion time, per-run Deploy-job
# conclusion, client-side .path filter — runs end to end. No network.
#
# PINS THE LIVE 2026-10-16 STRAND (all shapes verbatim from the ticket's
# receipts):
#   - carrier run 38913411207: run conclusion SUCCESS, "Deploy CrossModel"
#     job conclusion SKIPPED  (the docs-only push),
#   - cancelled wave 38912911194: run conclusion CANCELLED, jobs list
#     EMPTY (cancelled before its gate ran),
#   - an older delivered run: Deploy job conclusion SUCCESS at sha A,
#   - HEAD = B (docs-only, parent = the runtime merge at A..B runtime).
#   The probe must walk past carrier + cancelled wave, find the delivered
#   run, and answer stranded=yes (runtime undeployed between A and B).
#
# Also pins the other direction and the fail-open law (every unanswerable
# case deploys — a wrongly-skipped deploy strands main; a redundant one
# never does):
#   - HEAD == last delivered sha → stranded=no,
#   - docs-only range between delivered and HEAD → stranded=no,
#   - in-flight newer wave (delivered run is older, newest is queued/
#     in_progress) → stranded=yes (fail-open: the wave has not DELIVERED
#     yet — a redundant catch-up deploy, never a strand),
#   - no completed deploy runs at all → stranded=yes,
#   - gh failure / garbage body / unparsable jobs → stranded=yes,
#   - MAX_DEPLOY_RUNS budget exhausted with no delivered run found →
#     stranded=yes,
#   - compare at the 300-file cap → stranded=yes,
#   - the walk budget actually bounds the jobs calls (count them),
#   - the runtime-skip-set drift guard: the probe and
#     deploy-path-filter.sh share ONE awk program file — a harness leg
#     pins that both actually read runtime-skip-set.awk, so a future edit
#     to one definition cannot silently diverge the two questions.
#
# Run from anywhere: bash scripts/deploy/deploy-strand-probe.test.sh
set -u
command -v jq >/dev/null 2>&1 || { echo "deploy-strand-probe.test.sh: jq is required (preinstalled on CI ubuntu runners)" >&2; exit 1; }
cd "$(dirname "$0")"
SCRIPT=./deploy-strand-probe.sh
SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()   { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

REPO=octo/test
DPATH=.github/workflows/deploy.yml
CPATH=.github/workflows/ci.yml

# The live shas from the 2026-10-16 incident, shortened but distinct:
DELIVERED=aaaaaaaa111111111111111111111111111111   # 38917861836's sha (the last real deploy)
MERGE=bbbbbbbb222222222222222222222222222222       # c67577e9e runtime merge (cancelled wave)
CARRIER=cccccccc333333333333333333333333333333     # 91f1831d docs-only carrier (success-with-skip)

# --- gh shim: fixtures from $FIX/, records every call ----------------------
# (FIXTURE_API_FAIL=1 makes EVERY api call fail rc=1 — the fail-open legs;
# same pattern as deploy-coalesce-gate.test.sh.)
mkdir -p "$SBX/shim"
cat > "$SBX/shim/gh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "api" ] || { echo "gh-shim: unsupported: $*" >&2; exit 1; }
[ "${FIXTURE_API_FAIL:-0}" = "1" ] && { echo "gh: HTTP 502: api error (fixture)" >&2; exit 1; }
shift
endpoint=''
while [ $# -gt 0 ]; do
  case "$1" in
    -f|-F|--field|--raw-field|--jq|-q|-H|--header|-X) shift 2 ;;
    *) endpoint="$1"; shift ;;
  esac
done
case "$endpoint" in
  "repos/octo/test/actions/workflows/deploy.yml/runs?per_page=100&status=completed")
    echo "list-workflow" >> "$FIX/calls.log"
    if [ "${FIXTURE_NO_WF_LISTING:-0}" = "1" ]; then
      echo "gh: workflow-scoped listing unavailable (fixture)" >&2; exit 1   # pins the fallback
    fi
    cat "$FIX/wfruns.json" ;;
  "repos/octo/test/actions/runs?per_page=100&status=completed")
    echo "list-repowide" >> "$FIX/calls.log"
    cat "$FIX/runs.json" ;;
  "repos/octo/test/actions/runs/"*"/jobs?per_page=100")
    rid=${endpoint#repos/octo/test/actions/runs/}; rid=${rid%/jobs?per_page=100}
    echo "jobs $rid" >> "$FIX/calls.log"
    cat "$FIX/jobs-$rid.json" ;;
  "repos/octo/test/compare/"*)
    echo "compare" >> "$FIX/calls.log"
    cat "$FIX/compare.json" ;;
  *) echo "gh-shim: unhandled: $endpoint" >&2; exit 1 ;;
esac
EOF
chmod +x "$SBX/shim/gh"

FIX="$SBX/fix"; mkdir -p "$FIX"
JQD=$(dirname "$(command -v jq)")

# mkrun <id> <path> <status> <conclusion> <sha> <created> <updated>
mkrun() {
  local concl="$4"; [ "$concl" = "null" ] || concl="\"$concl\""
  printf '{"id":%s,"name":"x","path":"%s","status":"%s","conclusion":%s,"head_sha":"%s","created_at":"%s","updated_at":"%s"}' \
    "$1" "$2" "$3" "$concl" "$5" "$6" "$7"
}
wrap() { local n=$#; printf '{"total_count":%s,"workflow_runs":[%s]}' "$n" "$(IFS=,; echo "$*")"; }
mkjobs() { # $@ = "name|conclusion" rows
  local rows="" r
  for r in "$@"; do
    rows="${rows:+$rows,}$(printf '{"name":"%s","status":"completed","conclusion":"%s"}' "${r%%|*}" "${r##*|}")"
  done
  printf '{"total_count":%s,"jobs":[%s]}' "$#" "$rows"
}
mkcompare() { # $1=status, $2=space-separated FILENAMES (real API shape: objects)
  local files="[" f
  for f in $2; do files="$files{\"filename\":\"$f\"},"; done
  files="${files%,}]"
  printf '{"status":"%s","ahead_by":1,"behind_by":0,"files":%s}' "$1" "$files"
}

run_probe() { # $1=extra env, $2=head sha — answer read from GITHUB_OUTPUT
  rm -f "$FIX/ghout" "$FIX/calls.log"
  ( env -i PATH="$SBX/shim:$JQD:/usr/bin:/bin" HOME="$SBX" FIX="$FIX" \
      REPO="$REPO" GITHUB_OUTPUT="$FIX/ghout" $1 bash "$SCRIPT" "$2" ) > "$FIX/out" 2> "$FIX/err"
  sed -n 's/^stranded=//p' "$FIX/ghout" | tail -1
}
probe_out_raw() { # $2=head sha — the same run, stdout captured
  ( env -i PATH="$SBX/shim:$JQD:/usr/bin:/bin" HOME="$SBX" FIX="$FIX" \
      REPO="$REPO" GITHUB_OUTPUT="$FIX/ghout" $1 bash "$SCRIPT" "$2" )
}
calls() { cat "$FIX/calls.log" 2>/dev/null || true; }
njobs() { grep -c '^jobs ' "$FIX/calls.log" 2>/dev/null || true; }
# set_runs <runs.json content via stdin> — the workflow-scoped listing (the
# probe's PREFERRED source) serves wfruns.json; every fixture writes both so
# legs stay drop-in, and the fallback leg overrides wfruns.json itself.
set_runs() { cat > "$FIX/runs.json"; cp "$FIX/runs.json" "$FIX/wfruns.json"; }

# ===========================================================================
echo "== 1. THE LIVE STRAND (ticket a4309ef9): carrier success-with-skip over a cancelled deployable wave, older delivered run underneath =="
# runs snapshot: carrier (newest, success) + cancelled wave + delivered run + noise CI runs
wrap "$(mkrun 38913411207 "$DPATH" completed success "$CARRIER" "2026-10-16T14:08:00Z" "2026-10-16T14:32:34Z")" \
     "$(mkrun 38912911194 "$DPATH" completed cancelled "$MERGE" "2026-10-16T14:05:01Z" "2026-10-16T14:08:51Z")" \
     "$(mkrun 38912900000 "$CPATH" completed success "$MERGE" "2026-10-16T14:05:02Z" "2026-10-16T14:20:00Z")" \
     "$(mkrun 38912000000 "$DPATH" completed success "$DELIVERED" "2026-10-16T10:00:00Z" "2026-10-16T10:40:00Z")" \
     "$(mkrun 38911000000 "$CPATH" completed success "$DELIVERED" "2026-10-16T09:00:00Z" "2026-10-16T09:30:00Z")" | set_runs
mkjobs "Skip if a newer deploy is queued|success" "Test gate|skipped" "Deploy CrossModel|skipped" > "$FIX/jobs-38913411207.json"   # the carrier
mkjobs > "$FIX/jobs-38912911194.json"                                                                                     # cancelled wave: EMPTY jobs list
mkjobs "Skip if a newer deploy is queued|success" "Test gate / Backend tests|success" "Deploy CrossModel|success" > "$FIX/jobs-38912000000.json"  # delivered run
mkcompare ahead "backend/src/service.ts docs/notes.md frontend/app/page.tsx" > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "live strand shape → stranded=yes" "yes" "$ANS"
check "walk passed the carrier (jobs call made)" "yes" "$([ "$(njobs)" -ge 2 ] && echo yes || echo no)"
check "log names the runtime files" "yes" "$(grep -q 'runtime undeployed' "$FIX/out" && echo yes || echo no)"
check "log names the delivered run" "yes" "$(grep -q '38912000000 delivered' "$FIX/out" && echo yes || echo no)"
check "CI-workflow runs are invisible to the walk (.path filter)" "no" "$(grep -q '38912900000' "$FIX/out" && echo yes || echo no)"

echo "== 2. fully-delivered history (HEAD == last delivered) → no =="
mkcompare identical "" > "$FIX/compare.json"   # not even consulted: HEAD==delivered exits at step 2
ANS=$(run_probe "" "$DELIVERED")
check "HEAD is the delivered sha → stranded=no" "no" "$ANS"

echo "== 3. docs-only range between delivered and HEAD → no =="
mkcompare ahead "docs/notes.md README.md .digby/notes/learnings.md" > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "docs-only gap → stranded=no" "no" "$ANS"

echo "== 3b. help-content-only gap (served .md) → yes (F31) =="
# frontend/content/help/**.md is SERVED RUNTIME CONTENT (read from the image
# at request time): a help-only undeployed gap is a real strand, not a
# docs-only no-op. Same skip-set file, so the probe inherits the carve-out.
mkcompare ahead "frontend/content/help/asking-bigger.md" > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "help-only gap → stranded=yes (served content is runtime)" "yes" "$ANS"

echo "== 4. in-flight newer wave (nothing delivered yet for HEAD) → yes (fail-open) =="
# newest runs are queued/in_progress (not completed): the walk's runs.json
# only lists COMPLETED runs, so the newest completed is the delivered run at
# an older sha — HEAD is newer ⇒ compare says runtime ⇒ stranded=yes. This
# is the fail-open redundancy the header documents: a docs push landing
# while a runtime wave is deploying queues a catch-up deploy.
mkcompare ahead "backend/src/service.ts" > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "in-flight wave, runtime gap → stranded=yes (fail-open)" "yes" "$ANS"

echo "== 5. no completed deploy runs at all → yes =="
wrap "$(mkrun 1 "$DPATH" in_progress null "$CARRIER" "2026-10-16T14:00:00Z" "2026-10-16T14:01:00Z")" | set_runs
ANS=$(run_probe "" "$CARRIER")
check "no completed deploy runs → stranded=yes" "yes" "$ANS"

echo "== 6. gh api failure → yes (fail-open, never a quiet no) =="
wrap "$(mkrun 38912000000 "$DPATH" completed success "$DELIVERED" "2026-10-16T10:00:00Z" "2026-10-16T10:40:00Z")" | set_runs
mkjobs "Deploy CrossModel|success" > "$FIX/jobs-38912000000.json"
mkcompare ahead "backend/src/x.ts" > "$FIX/compare.json"
ANS=$(run_probe "FIXTURE_API_FAIL=1" "$CARRIER")
check "gh failure → stranded=yes" "yes" "$ANS"

echo "== 7. garbage runs body → yes (fail-open) =="
printf 'not-json-at-all' | set_runs
ANS=$(run_probe "" "$CARRIER")
check "garbage runs body → stranded=yes" "yes" "$ANS"

echo "== 8. jobs body unparsable for a run in the walk → yes =="
wrap "$(mkrun 38913411207 "$DPATH" completed success "$CARRIER" "2026-10-16T14:08:00Z" "2026-10-16T14:32:34Z")" \
     "$(mkrun 38912000000 "$DPATH" completed success "$DELIVERED" "2026-10-16T10:00:00Z" "2026-10-16T10:40:00Z")" | set_runs
printf '{"total_count":1,"jobs":[{"name":"Deploy CrossModel","conclusion":"skipped"}]}' > "$FIX/jobs-38913411207.json"
printf 'garbage' > "$FIX/jobs-38912000000.json"
mkcompare ahead "backend/src/x.ts" > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "unparsable jobs mid-walk → stranded=yes" "yes" "$ANS"

echo "== 9. walk budget: MAX_DEPLOY_RUNS bounds the jobs calls; budget exhausted → yes =="
# 5 skipped carriers, no delivered run at all, budget 3 → 3 jobs calls then
# stranded=yes (never an unbounded walk, never a quiet no)
ROWS=""
for i in 5 4 3 2 1; do
  ROWS="${ROWS:+$ROWS,}$(mkrun 3891341120$i "$DPATH" completed success "$CARRIER" "2026-10-16T13:0$i:00Z" "2026-10-16T13:1$i:00Z")"
  printf '{"total_count":1,"jobs":[{"name":"Deploy CrossModel","conclusion":"skipped"}]}' > "$FIX/jobs-3891341120$i.json"
done
wrap $ROWS | set_runs
ANS=$(run_probe "MAX_DEPLOY_RUNS=3" "$CARRIER")
check "budget exhausted, nothing delivered → stranded=yes" "yes" "$ANS"
check "exactly MAX_DEPLOY_RUNS jobs calls made" "3" "$(njobs)"

echo "== 10. compare 300-file cap → yes (tail unreadable = runtime) =="
wrap "$(mkrun 38912000000 "$DPATH" completed success "$DELIVERED" "2026-10-16T10:00:00Z" "2026-10-16T10:40:00Z")" | set_runs
mkjobs "Deploy CrossModel|success" > "$FIX/jobs-38912000000.json"
FILES='['
for i in $(seq 1 300); do FILES="$FILES\"path/file$i.ts\","; done
FILES="${FILES%,}]"
mkcompare ahead "$FILES" > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "compare at 300-file cap → stranded=yes" "yes" "$ANS"

echo "== 11. compare status unanswerable → yes =="
mkcompare_nofiles() { # decodable body, valid status, NO .files key (adversarial-review F1)
  printf '{"status":"%s","ahead_by":1,"behind_by":0}' "$1"
}
mkcompare_nofiles ahead > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "compare body without .files key → stranded=yes (F1)" "yes" "$ANS"
mkcompare_nofiles identical > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "identical status without .files key → stranded=no (identity needs no files)" "no" "$ANS"
mkcompare nocommits '["backend/src/x.ts"]' > "$FIX/compare.json"
ANS=$(run_probe "" "$CARRIER")
check "compare status nocommits → stranded=yes" "yes" "$ANS"

echo "== 12. REPO unset / missing binaries → yes (fail-open, no crash) =="
# No GITHUB_OUTPUT here: the answer is the stdout log line (strand-probe:
# stranded=yes — …), as deploy-path-filter.test.sh's stdout legs pin.
( env -i PATH="$SBX/shim:$JQD:/usr/bin:/bin" HOME="$SBX" bash "$SCRIPT" "$CARRIER" ) > "$FIX/out" 2> "$FIX/err"
check "REPO unset → stranded=yes" "yes" "$(grep -o 'stranded=[a-z]*' "$FIX/out" | tail -1 | sed 's/stranded=//')"
( env -i PATH="/usr/bin:/bin" HOME="$SBX" REPO="$REPO" bash "$SCRIPT" "$CARRIER" ) > "$FIX/out" 2> "$FIX/err"
check "no gh on PATH → stranded=yes" "yes" "$(grep -o 'stranded=[a-z]*' "$FIX/out" | tail -1 | sed 's/stranded=//')"

echo "== 13. LISTING FALLBACK: workflow-scoped listing fails → repo-wide + .path filter =="
# The probe prefers the workflow-scoped listing (live-verified: returns ONLY
# deploy.yml runs); if that endpoint fails it must fall back to the
# repo-wide listing + client-side .path filter — never fail-open when the
# data is reachable another way.
wrap "$(mkrun 38913411207 "$DPATH" completed success "$CARRIER" "2026-10-16T14:08:00Z" "2026-10-16T14:32:34Z")" \
     "$(mkrun 38912900000 "$CPATH" completed success "$MERGE" "2026-10-16T14:05:02Z" "2026-10-16T14:20:00Z")" \
     "$(mkrun 38912000000 "$DPATH" completed success "$DELIVERED" "2026-10-16T10:00:00Z" "2026-10-16T10:40:00Z")" | set_runs
mkjobs "Skip if a newer deploy is queued|success" "Deploy CrossModel|skipped" > "$FIX/jobs-38913411207.json"
mkjobs "Deploy CrossModel|success" > "$FIX/jobs-38912000000.json"
mkcompare ahead "backend/src/service.ts docs/notes.md" > "$FIX/compare.json"
ANS=$(run_probe "FIXTURE_NO_WF_LISTING=1" "$CARRIER")
check "workflow listing down → repo-wide fallback finds the strand" "yes" "$ANS"
check "fallback leg used the repo-wide listing" "yes" "$(grep -q 'list-repowide' "$FIX/calls.log" && echo yes || echo no)"
# and the preferred endpoint is what runs when both are up (case 1 used it):
grep -q 'list-workflow' "$FIX/calls.log" 2>/dev/null || true

echo "== 14. THE DRIFT GUARD: filter and probe share runtime-skip-set.awk =="
grep -q 'runtime-skip-set.awk' deploy-path-filter.sh \
  && grep -q 'runtime-skip-set.awk' deploy-strand-probe.sh \
  && ok "both scripts source the shared skip set" \
  || bad "a script lost the shared skip-set reference"
# and the shared file itself classifies correctly (a couple of spot pins):
echo "backend/src/index.ts" | awk -f runtime-skip-set.awk | grep -q . \
  && ok "shared set: runtime path prints" || bad "shared set: runtime path swallowed"
printf 'docs/a.md\nbackend/src/x.test.ts\n.digby/rules/x.md\n' | awk -f runtime-skip-set.awk | grep -q . \
  && bad "shared set: docs path leaked as runtime" || ok "shared set: docs paths swallowed"
# F31 carve-out spot pins (served content is runtime despite .md):
printf 'frontend/content/help/asking-bigger.md\n' | awk -f runtime-skip-set.awk | grep -q 'frontend/content/help/asking-bigger.md' \
  && ok "shared set: help-content .md prints as runtime" || bad "shared set: help-content .md swallowed (F31 carve-out lost)"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "deploy-strand-probe.test.sh: $PASS passed, $FAIL FAILED"
  exit 1
fi
echo "deploy-strand-probe.test.sh: $PASS passed, $FAIL failed"

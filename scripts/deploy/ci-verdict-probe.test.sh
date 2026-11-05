#!/usr/bin/env bash
# Regression test — CI-verdict reuse in the deploy Test gate (T2b, todo
# f06afbfe / goal 0039c142, batch-train landing program).
#
# The behavior this pins: deploy.yml's gate job probes whether the deploy
# commit already has a completed CI run (scripts/deploy/ci-verdict-probe.sh
# → ci_verdict=green|red|none). The Test gate job runs the suite ONLY on
# 'none' (no CI workflow run for the sha, or the probe's first read failed;
# all). 'green' skips the duplicate invocation (the batch-train fast-forward
# case — the train ran the full suite once on the batch branch, T2a) and the
# deploy proceeds on the reused green. 'red' fails the run LOUDLY via the
# red-ci-stop job — red CI never deploys and never looks like it did.
#
# Invariants:
#   A. bash -n parses the probe; the workflow YAML parses.
#   B. Probe verdicts with a PATH-stubbed gh (fixture JSON, real python3):
#      - a completed success CI run on the sha → green (EVEN when a later
#        run of the same sha failed — the any-success rule; same code, same
#        suite, a later red means flaky infra, not the commit)
#      - newest completed failure, no success → ONE re-run of its failed
#        jobs, then red if it still fails; attempt >= 2 → red, no re-run
#      - a success from a BATCH branch on the same sha → green (branch NOT
#        filtered — the T2a/T2b fast-forward contract)
#      - in-progress after the wait, cancelled / timed_out / skipped → wait
#        (skip the deploy, run stays green — never opens the red window)
#      - workflow_dispatch: an undecided CI → none (own suite); ci_gate=
#        selfrun → none even on a failure
#      - no CI workflow run / non-CI workflows only / empty listing / first
#        gh failure / missing env → none, logged `CI-VERDICT FALLBACK`
#   C. GITHUB_OUTPUT carries ci_verdict=… on every path.
#   D. Wiring (deploy.yml): gate declares ci_verdict output; test job runs
#      only on ci_verdict == 'none'; deploy job needs !cancelled() +
#      gate success + (green || test success) so a SKIPPED-because-green
#      test cannot cascade-skip the deploy; red-ci-stop job fails loudly on
#      'red'; the reset-main job stays output-gated (a skipped deploy emits
#      no output — no false reset on red).
#
# Plain-bash idiom, mirrors scripts/deploy/deploy-coalesce-gate.test.sh.
# Run from anywhere: bash scripts/deploy/ci-verdict-probe.test.sh

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE="$ROOT/scripts/deploy/ci-verdict-probe.sh"
YML="$ROOT/.github/workflows/deploy.yml"

failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

[ -f "$PROBE" ] || { bad "missing file: $PROBE"; exit 1; }
[ -f "$YML" ]   || { bad "missing file: $YML"; exit 1; }

# ── A. parse ──────────────────────────────────────────────────────────────────
bash -n "$PROBE" && ok "probe: bash -n" || bad "probe: bash -n"

# ── B. verdicts with a stubbed gh ─────────────────────────────────────────────
SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT

mkgh() { # $1 = OK | FAIL (runs listing); $2 = OK | FAIL (re-run POST)
  cat > "$SB/gh" <<EOF
#!/usr/bin/env bash
case " \$* " in
  *"rerun-failed-jobs"*)
    echo "\$*" >> "$SB/reruns"
    if [ "${2:-OK}" = "FAIL" ]; then exit 1; fi
    exit 0
    ;;
  *"actions/runs?head_sha="*)
    if [ "$1" = "FAIL" ]; then exit 1; fi
    cat "$SB/runs.json"
    ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$SB/gh"
}

run_probe() { # env set by caller; captures GITHUB_OUTPUT + the probe log
  rm -f "$SB/out" "$SB/log" "$SB/reruns"
  env PATH="$SB:$PATH" \
      GH_TOKEN=t REPO=octo/test HEAD_SHA=abc123 \
      CI_VERDICT_WAIT_SEC=0 CI_VERDICT_RERUN_WAIT_SEC=0 \
      EVENT_NAME="${EVENT_NAME:-push}" CI_GATE="${CI_GATE:-auto}" \
      GITHUB_OUTPUT="$SB/out" \
      bash "$PROBE" >"$SB/log" 2>&1
  grep '^ci_verdict=' "$SB/out" 2>/dev/null | head -1 | cut -d= -f2
}
log_has_fallback() { grep -q 'CI-VERDICT FALLBACK' "$SB/log"; }

runjson() { # $@ = workflow run objects (jq-free: build with printf)
  printf '{"workflow_runs":[%s]}' "$*"
}

# B1: a completed success CI run on the sha → green
cat > "$SB/runs.json" <<'EOF'
{"workflow_runs":[
  {"name":"CI","path":".github/workflows/ci.yml","status":"completed","conclusion":"success","head_branch":"batch/20261017","updated_at":"2026-10-17T01:00:00Z"},
  {"name":"Deploy to AWS EC2","path":".github/workflows/deploy.yml","status":"completed","conclusion":"success","head_branch":"main","updated_at":"2026-10-17T01:05:00Z"}
]}
EOF
mkgh OK
check "completed success on a BATCH branch (the FF reuse case) → green" green "$(run_probe)"

# B2: newest completed FAILURE (attempt 1), no success → ONE re-run, then red
cat > "$SB/runs.json" <<'EOF'
{"workflow_runs":[
  {"id":4242,"run_attempt":1,"name":"CI","path":".github/workflows/ci.yml","status":"completed","conclusion":"failure","head_branch":"main","updated_at":"2026-10-17T01:00:00Z"}
]}
EOF
check "newest completed failure that still fails after the re-run → red" red "$(run_probe)"
check "a failure re-runs its failed jobs exactly once" 1 "$(grep -c 'runs/4242/rerun-failed-jobs' "$SB/reruns" 2>/dev/null || echo 0)"
log_has_fallback && bad "failure verdict logged a self-run fallback" || ok "failure did not log CI-VERDICT FALLBACK"

# B2b: a failure already re-run once (attempt 2) → red, no further re-run
cat > "$SB/runs.json" <<'EOF'
{"workflow_runs":[
  {"id":4243,"run_attempt":2,"name":"CI","path":".github/workflows/ci.yml","status":"completed","conclusion":"failure","head_branch":"main","updated_at":"2026-10-17T01:00:00Z"}
]}
EOF
check "attempt-2 failure → red" red "$(run_probe)"
[ -s "$SB/reruns" ] && bad "attempt-2 failure was re-run again" || ok "attempt-2 failure not re-run"

# B2c: re-run disabled → red at once, no POST
check "CI_VERDICT_RERUN=0 → red" red "$(CI_VERDICT_RERUN=0 run_probe)"
[ -s "$SB/reruns" ] && bad "re-run fired with CI_VERDICT_RERUN=0" || ok "CI_VERDICT_RERUN=0 suppresses the re-run"

# B2d: the re-run POST fails → red (never a silent self-run)
cat > "$SB/runs.json" <<'EOF'
{"workflow_runs":[
  {"id":4244,"run_attempt":1,"name":"CI","path":".github/workflows/ci.yml","status":"completed","conclusion":"failure","head_branch":"main","updated_at":"2026-10-17T01:00:00Z"}
]}
EOF
mkgh OK FAIL
check "re-run POST failure → red" red "$(run_probe)"
mkgh OK

# B2e: the operator override — dispatch with ci_gate=selfrun → none even on a failure
check "workflow_dispatch ci_gate=selfrun on a failure → none (own suite)" none "$(EVENT_NAME=workflow_dispatch CI_GATE=selfrun run_probe)"

# B3: any success wins over a later failure (same sha, same suite — the
# later red is flaky infra, not the code; the runtime gates still guard)
cat > "$SB/runs.json" <<'EOF'
{"workflow_runs":[
  {"name":"CI","path":".github/workflows/ci.yml","status":"completed","conclusion":"success","head_branch":"main","updated_at":"2026-10-17T00:50:00Z"},
  {"name":"CI","path":".github/workflows/ci.yml","status":"completed","conclusion":"failure","head_branch":"main","updated_at":"2026-10-17T01:00:00Z"}
]}
EOF
check "earlier success + later failure (flaky infra) → green (any-success rule)" green "$(run_probe)"

# B4: only in-progress runs → red (wait expired; do not self-run)
cat > "$SB/runs.json" <<'EOF'
{"workflow_runs":[
  {"name":"CI","path":".github/workflows/ci.yml","status":"in_progress","conclusion":null,"head_branch":"main","updated_at":"2026-10-17T01:00:00Z"}
]}
EOF
check "in-progress only (ordinary push race, wait 0) → wait (skip, run stays green, do not self-run)" wait "$(run_probe)"
log_has_fallback && bad "in-progress logged a self-run fallback" || ok "in-progress did not log CI-VERDICT FALLBACK"
check "in-progress on a workflow_dispatch → none (a dispatch never waits)" none "$(EVENT_NAME=workflow_dispatch run_probe)"

# B5: non-CI workflows only → none (the filter is workflow-scoped)
cat > "$SB/runs.json" <<'EOF'
{"workflow_runs":[
  {"name":"Deploy to AWS EC2","path":".github/workflows/deploy.yml","status":"completed","conclusion":"success","head_branch":"main","updated_at":"2026-10-17T01:00:00Z"}
]}
EOF
check "only non-CI workflow runs → none" none "$(run_probe)"
log_has_fallback || bad "non-CI-only did not log CI-VERDICT FALLBACK"

# B6: newest completed is cancelled (no success) → red (skip; do not self-run)
cat > "$SB/runs.json" <<'EOF'
{"workflow_runs":[
  {"name":"CI","path":".github/workflows/ci.yml","status":"completed","conclusion":"cancelled","head_branch":"main","updated_at":"2026-10-17T01:00:00Z"}
]}
EOF
check "cancelled conclusion → wait (no verdict on the code; skip, never a red run)" wait "$(run_probe)"
log_has_fallback && bad "cancelled logged a self-run fallback" || ok "cancelled did not log CI-VERDICT FALLBACK"

# B7: empty listing → none
echo '{"workflow_runs":[]}' > "$SB/runs.json"
check "no runs at all → none" none "$(run_probe)"
log_has_fallback || bad "empty listing did not log CI-VERDICT FALLBACK"

# B8: gh api fails → none (fail-open)
mkgh FAIL
check "gh api failure → none (fail-open: never skip the test gate on an unreadable API)" none "$(run_probe)"
log_has_fallback || bad "gh failure did not log CI-VERDICT FALLBACK"

# B9: missing env → none
rm -f "$SB/out" "$SB/log"
env -u GH_TOKEN -u REPO -u HEAD_SHA PATH="$SB:$PATH" GITHUB_OUTPUT="$SB/out" \
    bash "$PROBE" >"$SB/log" 2>&1
check "missing env → none" none "$(grep -o 'ci_verdict=.*' "$SB/out" 2>/dev/null | head -1 | cut -d= -f2)"
log_has_fallback || bad "missing env did not log CI-VERDICT FALLBACK"

# ���─ D. wiring ─────────────────────────────────────────────────────────────────
grep -q 'ci_verdict: ${{ steps.civ.outputs.ci_verdict }}' "$YML" \
  && ok "wiring: gate job declares the ci_verdict output" \
  || bad "wiring: gate job must expose ci_verdict"

grep -q "needs.gate.outputs.ci_verdict == 'none'" "$YML" \
  && ok "wiring: test job runs the suite only when no completed verdict exists" \
  || bad "wiring: test job must gate on ci_verdict == 'none'"

grep -q "red-ci-stop" "$YML" && grep -q "needs.gate.outputs.ci_verdict == 'red'" "$YML" \
  && ok "wiring: red-ci-stop job fires on a red verdict" \
  || bad "wiring: red-ci-stop job missing or ungated"

# A `wait` verdict must reach NONE of test / red-ci-stop / deploy (the run
# concludes success with the deploy skipped; the watchdog re-dispatches).
grep -q "needs.gate.outputs.ci_verdict == 'wait'" "$YML" \
  && bad "wiring: no job may run on a wait verdict" \
  || ok "wiring: wait reaches no job (test=none only, stop=red only, deploy=green|test success)"

grep -qF "CI_GATE: \${{ github.event.inputs.ci_gate || 'auto' }}" "$YML" \
  && ok "wiring: workflow_dispatch ci_gate input is forwarded to the probe" \
  || bad "wiring: ci_gate input missing or not forwarded"

grep -qF "EVENT_NAME: \${{ github.event_name }}" "$YML" \
  && ok "wiring: the probe knows the triggering event" \
  || bad "wiring: EVENT_NAME not forwarded to the probe"

# The red-ci-stop job must actually FAIL (exit 1), not warn.
red_block=$(awk '/red-ci-stop:/{f=1} f{print} f&&/^  [a-z][a-z-]*:/{if(++j>1)exit}' "$YML")
echo "$red_block" | grep -q 'exit 1' \
  && ok "wiring: red-ci-stop exits 1 (the run concludes FAILURE, never a silent skip)" \
  || bad "wiring: red-ci-stop must exit 1"

# The deploy job must survive a SKIPPED-because-green test job and still
# honor gate failure / red verdicts.
grep -q '!cancelled() && needs.gate.result == '"'"'success'"'"'' "$YML" \
  && ok "wiring: deploy if has !cancelled() + gate success" \
  || bad "wiring: deploy if must keep !cancelled() + needs.gate.result == 'success'"

grep -q "needs.gate.outputs.ci_verdict == 'green' || needs.test.result == 'success'" "$YML" \
  && ok "wiring: deploy proceeds on reused green OR own green — red reaches neither" \
  || bad "wiring: deploy if must read (green || test success)"

# The reset-main job stays gated on the deploy OUTPUT (a skipped deploy
# emits no outputs — no false reset on a red-verdict run).
grep -q "needs.deploy.outputs.did_it_work_failed == '1'" "$YML" \
  && ok "wiring: reset-main still output-gated (skipped deploy ⇒ no output ⇒ no reset)" \
  || bad "wiring: reset-main lost its output gating"

echo
if [ "$failures" -eq 0 ]; then
  echo "ci-verdict-probe tests: all passed"
else
  echo "ci-verdict-probe tests: $failures invariant(s) violated" >&2
  exit 1
fi

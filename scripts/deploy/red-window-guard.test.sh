#!/usr/bin/env bash
# red-window-guard.test.sh — regression harness for red-window-guard.sh
# (feedback ticket 1df1fe00; 2026-09-24 red-window merge incident).
#
# PATH-injected `gh` shim serves canned Actions/branch/PR payloads — honoring
# the script's --jq projections — and the REAL jq executes the script's
# filters, so the decision logic is exercised end to end. PATH is EXPORTED
# before each run (a per-command PATH prefix does NOT reach command
# substitutions evaluated in the arguments — the harness's own first cut
# silently fell back to the real gh and every case "passed" fail-open).
# No network needed.
#
# Pins the incident contract:
#   - RED: newest completed deploy.yml run on main concluded failure → check
#     exits 1 with the actionable message (today's incident shape, both on
#     HEAD and on an older sha main advanced past with nothing newer green);
#   - CLEAN: newest completed succeeded, or cancelled (coalesced wave) → 0;
#   - UNPROVEN: any deploy.yml run on main still ACTIVE (in_progress / queued
#     / pending-hole) → fail-open, even when an OLDER completed run failed;
#   - fresh repo (no completed deploy runs) → 0;
#   - other workflows (ci.yml) and other branches are invisible;
#   - newest-by-CONCLUSION-time (updated_at) wins over created order;
#   - API unreachable → check fails OPEN (0), status exits 2;
#   - unresolvable main HEAD → fail-open;
#   - OVERRIDE: a PR label containing `deploy-fix` short-circuits a red
#     window; an unrelated label does not; a failing label lookup leaves the
#     window decision intact (red stays red);
#   - `status` mode exits 0 (with API) and prints the state line.
#
# Run from anywhere: bash scripts/deploy/red-window-guard.test.sh
set -u
command -v jq >/dev/null 2>&1 || { echo "red-window-guard.test.sh: jq is required (preinstalled on CI ubuntu runners)" >&2; exit 1; }
cd "$(dirname "$0")"
SCRIPT=./red-window-guard.sh
SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()   { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

HEAD=aaaa1111bbbb2222cccc3333dddd4444eeee5555
OLD=9999888877776666555544443333222211110000
DPATH=.github/workflows/deploy.yml
CPATH=.github/workflows/ci.yml

# The guard under test. PR_NUMBER rides through the environment.
# Isolation-boundary pinning (review F5 item 3): the 20 contract cases below
# are PROD-behavior cases — an operator box exporting DIGBY_INSTANCE=selfhost
# used to trip the script's exit-3 guard in every one of them (measured: 1/20
# passing). Pin the prod env here (REPO + DIGBY_INSTANCE) so the contract
# cases are hermetic; boundary cases override them per-case below.
run_guard(){
  DIGBY_INSTANCE="${RWG_DIGBY_INSTANCE:-prod}" \
  REPO="${RWG_REPO:-example-org/crossmodel}" \
  GITHUB_REPO_SLUG="${RWG_GITHUB_REPO_SLUG:-}" \
  PR_NUMBER="${PR_NUMBER:-}" bash "$SCRIPT" "${1:-check}" > "$SBX/out" 2>&1; echo $?; }
out(){ cat "$SBX/out"; }

# runs_json — emit an Actions snapshot: each arg
# "<status>:<conclusion>:<sha>:<branch>:<path>:<updated_at>" (the last field
# may contain colons; read assigns the remainder to the final var).
runs_json() {
  local items=() r
  for r in "$@"; do
    IFS=: read -r st cl sha br pa up <<< "$r"
    items+=("{ \"id\": 1, \"status\": \"${st}\", \"conclusion\": \"${cl}\", \"head_sha\": \"${sha}\", \"head_branch\": \"${br}\", \"path\": \"${pa}\", \"updated_at\": \"${up}\" }")
  done
  printf '{ "workflow_runs": [ %s ] }' "$(IFS=,; echo "${items[*]}")"
}

# mk_shim <runs-json> <head-sha|empty=fail> <labels-joined|empty=none> <api_fails>
#   The shim honors the guard's --jq projections: branches/main → the bare
#   sha; pulls/N → the comma-joined label names.
mk_shim() {
  cat > "$SBX/gh" <<EOF
#!/usr/bin/env bash
if [ "${4:-0}" = "1" ]; then exit 1; fi
case "\$2" in
  *actions/runs*)
    cat <<'JSON'
$1
JSON
    ;;
  *branches/main*)
    if [ -n "${2:-}" ]; then echo "${2}"; else exit 1; fi
    ;;
  *pulls/*)
    echo "${3:-}"
    ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$SBX/gh"
  # EXPORT, not a per-command prefix: command substitutions in argument lists
  # evaluate with the caller's PATH.
  export PATH="$SBX:$PATH"
}

T1="2026-09-24T15:42:09Z"; T2="2026-09-24T16:09:01Z"; T3="2026-09-24T20:54:31Z"

echo "== red-window-guard contract =="

# 1. RED — the incident shape: newest completed deploy on HEAD failed.
mk_shim "$(runs_json "completed:failure:${HEAD}:main:${DPATH}:${T1}")" "$HEAD" "" 0
check "RED window blocks (exit 1)" "$(PR_NUMBER= run_guard check)" "1"
grep -q "RED WINDOW" "$SBX/out" && ok "message names the RED WINDOW" || bad "message names the RED WINDOW"
# PR #1035 review B1: the RED verdict carries the sentinel line the workflow
# wrapper keys on — a crashed script (exit 1, no sentinel) must NOT block.
grep -qx 'RWGDECISION=red' "$SBX/out" && ok "red verdict carries RWGDECISION=red sentinel" || bad "red verdict carries RWGDECISION=red sentinel"

# 2. CLEAN — newest completed on HEAD succeeded. No sentinel on non-red.
mk_shim "$(runs_json "completed:success:${HEAD}:main:${DPATH}:${T3}")" "$HEAD" "" 0
check "success on HEAD → merge allowed" "$(run_guard check)" "0"
! grep -qx 'RWGDECISION=red' "$SBX/out" && ok "no sentinel on a clean verdict" || bad "no sentinel on a clean verdict"

# 3. CLEAN — cancelled (coalesced wave) never blocks.
mk_shim "$(runs_json "completed:cancelled:${HEAD}:main:${DPATH}:${T2}")" "$HEAD" "" 0
check "cancelled coalesced wave → merge allowed" "$(run_guard check)" "0"

# 4. UNPROVEN — an ACTIVE run shadows an older completed failure on HEAD.
mk_shim "$(runs_json "completed:failure:${HEAD}:main:${DPATH}:${T1}" "in_progress:null:${HEAD}:main:${DPATH}:${T2}")" "$HEAD" "" 0
check "in-flight run → UNPROVEN fail-open (older failure shadowed)" "$(run_guard check)" "0"

# 5. PENDING HOLE — a concurrency-blocked pending run counts as ACTIVE.
mk_shim "$(runs_json "completed:failure:${HEAD}:main:${DPATH}:${T1}" "pending:null:${HEAD}:main:${DPATH}:${T2}")" "$HEAD" "" 0
check "pending-hole run → fail-open" "$(run_guard check)" "0"

# 6. RED on an OLDER sha — main advanced past a failed deploy, nothing newer
#    completed: the same red window (the 2026-09-24 stack shape).
mk_shim "$(runs_json "completed:failure:${OLD}:main:${DPATH}:${T1}")" "$HEAD" "" 0
check "failure on older sha (nothing newer completed) → red" "$(run_guard check)" "1"

# 7. Fresh repo — no completed deploy runs at all.
mk_shim "$(runs_json "in_progress:null:${HEAD}:main:${DPATH}:${T2}")" "$HEAD" "" 0
check "no completed runs (fresh repo) → fail-open" "$(run_guard check)" "0"

# 8. Other workflows + other branches are invisible.
mk_shim "$(runs_json "completed:success:${HEAD}:main:${DPATH}:${T3}" "completed:failure:${HEAD}:main:${CPATH}:${T2}" "completed:failure:${OLD}:feature/x:${DPATH}:${T2}")" "$HEAD" "" 0
check "ci.yml + off-main failures invisible → merge allowed" "$(run_guard check)" "0"

# 9. NEWEST by CONCLUSION time (updated_at): an earlier failure under a later
#    success is not the signal.
mk_shim "$(runs_json "completed:failure:${OLD}:main:${DPATH}:${T1}" "completed:success:${HEAD}:main:${DPATH}:${T3}")" "$HEAD" "" 0
check "newest-by-conclusion wins (later success) → merge allowed" "$(run_guard check)" "0"

# 10. API unreachable → check fails OPEN; status exits 2.
mk_shim "" "$HEAD" "" 1
check "API unreachable → check fails OPEN" "$(run_guard check)" "0"
check "API unreachable → status exits 2" "$(run_guard status)" "2"

# 11. Unresolvable main HEAD → fail-open.
mk_shim "$(runs_json "completed:failure:${HEAD}:main:${DPATH}:${T1}")" "" "" 0
check "unresolvable HEAD → fail-open" "$(run_guard check)" "0"

# 12. OVERRIDE — a deploy-fix-containing label short-circuits a red window.
mk_shim "$(runs_json "completed:failure:${HEAD}:main:${DPATH}:${T1}")" "$HEAD" "deploy-fix" 0
check "deploy-fix label overrides red window" "$(PR_NUMBER=4242 run_guard check)" "0"

# 13. NO override — an unrelated label does not.
mk_shim "$(runs_json "completed:failure:${HEAD}:main:${DPATH}:${T1}")" "$HEAD" "enhancement" 0
check "unrelated label does NOT override" "$(PR_NUMBER=4242 run_guard check)" "1"

# 14. Label API failing (pulls/* errors) leaves the window decision intact.
cat > "$SBX/gh" <<EOF
#!/usr/bin/env bash
case "\$2" in
  *actions/runs*) cat <<'JSON'
$(runs_json "completed:failure:${HEAD}:main:${DPATH}:${T1}")
JSON
    ;;
  *branches/main*) echo "${HEAD}" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$SBX/gh"
export PATH="$SBX:$PATH"
check "label API failure → window still evaluated (red)" "$(PR_NUMBER=4242 run_guard check)" "1"

# 15. status mode prints the state line and exits 0.
mk_shim "$(runs_json "completed:failure:${HEAD}:main:${DPATH}:${T1}")" "$HEAD" "" 0
check "status mode exits 0" "$(run_guard status)" "0"
grep -q "state=red" "$SBX/out" && ok "status prints state=red" || bad "status prints state=red"

# 16. Isolation boundary (ticket c75b5f34, review F5): on a NON-prod
# instance the guard hard-fails exit 3 — unconfigured, the production repo
# by ANY spelling, and case variants that the GitHub API itself resolves to
# the production repo. It must also survive an ambient non-prod env for the
# legacy prod cases (the harness pins DIGBY_INSTANCE=prod above; this
# verifies the pinning itself).
RWG_DIGBY_INSTANCE=selfhost RWG_REPO= RWG_GITHUB_REPO_SLUG= run_guard check >/dev/null
check "non-prod + no repo → exit 3 (boundary)" "$(RWG_DIGBY_INSTANCE=selfhost RWG_REPO= RWG_GITHUB_REPO_SLUG= run_guard check)" "3"
grep -q "ISOLATION BOUNDARY" "$SBX/out" && ok "unconfigured refusal names the boundary" || bad "unconfigured refusal names the boundary"

check "non-prod + lowercase prod slug → exit 3" "$(RWG_DIGBY_INSTANCE=selfhost RWG_REPO=example-org/crossmodel run_guard check)" "3"
check "non-prod + UPPERCASE prod slug (API resolves it to prod) → exit 3" "$(RWG_DIGBY_INSTANCE=selfhost RWG_REPO=example-org/crossmodel run_guard check)" "3"
check "non-prod + prod slug with URL wrapper + .git + trailing slash → exit 3" "$(RWG_DIGBY_INSTANCE=selfhost RWG_REPO='https://github.com/example-org/crossmodel.git/' run_guard check)" "3"

# The two PROCEED cases need a window that is genuinely fail-open, not case
# 15's RED shim (which would correctly exit 1 past the boundary): install a
# fresh-repo shim (no completed runs) → the guard's documented fail-open 0.
mk_shim "$(runs_json)" "$HEAD" "" 0
check "non-prod + the instance's OWN repo → proceeds past the boundary (fail-open 0 on the fresh-repo shim)" "$(RWG_DIGBY_INSTANCE=selfhost RWG_REPO=acme/edge-digby run_guard check)" "0"
grep -q "ISOLATION BOUNDARY" "$SBX/out" && bad "own-repo case emitted a boundary refusal" || ok "own-repo case emitted no boundary refusal"
check "PROD + no REPO → historical default (fail-open 0 on the fresh-repo shim)" "$(RWG_DIGBY_INSTANCE=prod RWG_REPO= RWG_GITHUB_REPO_SLUG= run_guard check)" "0"

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]

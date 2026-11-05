#!/usr/bin/env bash
# verify-wave.test.sh — pins for verify-wave.sh (33rd f64 bake, FO f117;
# pending_runs pins added the same day from the f117 independent review):
# the FO opening check (merge-base ancestry + own-sha wave verdicts) baked as a
# greppable PASS/FAIL line, killing the abbreviated-head_sha trap that returned
# an empty wave indistinguishable from the token-event dispatch gap — AND the
# pending-run gap: conclusion:null runs are NOT green; a PASS certifies the
# wave CONCLUDED (red=0 AND pend=0).
# No network: GIT_BIN/GH_BIN are overridden with shims over a REAL temp git repo
# (real rev-parse/merge-base semantics), and gh api is a canned-JSON shim that
# REJECTS abbreviated shas — mirroring the live GitHub behavior the trap.
set -u
cd "$(dirname "$0")"
SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# --- real git repo: two commits, a branch carrying both, origin/main = first
git init -q "$SBX/repo"; cd "$SBX/repo"
git config user.email t@t; git config user.name t
echo a > f; git add f; git commit -qm base; BASE=$(git rev-parse HEAD)
echo b >> f; git commit -qam second; SECOND=$(git rev-parse HEAD)
echo c >> f; git commit -qam third; THIRD=$(git rev-parse HEAD)   # not on main
git branch -q main-at-base "$SECOND"  # main tip: SECOND is ancestor, THIRD is not
cd - >/dev/null

# git shim: wraps the real git against the temp repo (GIT_BIN must be ONE word)
cat > "$SBX/git-shim.sh" <<SHIM
#!/usr/bin/env bash
exec git -C "$SBX/repo" "\$@"
SHIM
chmod +x "$SBX/git-shim.sh"

# gh shim: serves runs JSON for the FULL sha only (abbreviated → empty wave,
# exactly the live trap). $GH_WAVES points at a dir of <full-sha>.json files.
cat > "$SBX/gh-shim.sh" <<'SHIM'
#!/usr/bin/env bash
# called as: gh-shim.sh api repos/<repo>/actions/runs?head_sha=<sha>&per_page=100
arg="$2"
sha="${arg##*head_sha=}"; sha="${sha%%&*}"
if [ -f "$GH_WAVES/$sha.json" ]; then cat "$GH_WAVES/$sha.json"; else echo '{"workflow_runs":[]}'; fi
SHIM
chmod +x "$SBX/gh-shim.sh"

VW() { # VW <main-ref> <sha...>
  local main="$1"; shift
  GIT_BIN="$SBX/git-shim.sh" GH_BIN="$SBX/gh-shim.sh" \
    VERIFY_WAVE_MAIN="$main" bash ./verify-wave.sh test/repo "$@"
}

# green wave for $SECOND: CI + Deploy success
mkdir -p "$SBX/waves"
cat > "$SBX/waves/$SECOND.json" <<EOF
{"workflow_runs":[
 {"id":111,"name":"CI","conclusion":"success"},
 {"id":112,"name":"Deploy to AWS EC2","conclusion":"success"},
 {"id":113,"name":"Deployment Health Check","conclusion":"success"}]}
EOF
export GH_WAVES="$SBX/waves"

echo "pass: ancestor + green wave"
out="$(VW main-at-base "$SECOND")"
echo "$out" | grep -q "VERDICT: PASS  $SECOND ancestor=ANCESTOR_OK runs=3 red=0 pend=0" && ok pass-green || { bad pass-green; echo "$out"; }

echo "fail: not an ancestor"
out="$(VW main-at-base "$THIRD")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "VERDICT: FAIL  $THIRD cause=not_ancestor" && ok fail-not-ancestor || { bad fail-not-ancestor; echo "$out"; }

echo "fail: unknown sha"
out="$(VW main-at-base deadbeefdeadbeefdeadbeefdeadbeefdeadbeef)"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "cause=unknown_sha" && ok fail-unknown-sha || { bad fail-unknown-sha; echo "$out"; }

echo "fail: red run in the wave"
cat > "$SBX/waves/$BASE.json" <<EOF
{"workflow_runs":[
 {"id":211,"name":"CI","conclusion":"success"},
 {"id":212,"name":"Deploy to AWS EC2","conclusion":"failure"}]}
EOF
out="$(VW main-at-base "$BASE")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "cause=red_runs ancestor=ANCESTOR_OK runs=2 red=1 pend=0" \
  && echo "$out" | grep -q "RED run 212 Deploy to AWS EC2 failure" \
  && ok fail-red-runs || { bad fail-red-runs; echo "$out"; }

echo "fail: abbreviated sha (the live trap) — shim serves empty, must NOT pass silently"
rm -f "$SBX/waves/$BASE.json"
out="$(VW main-at-base "${BASE:0:10}")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "cause=empty_wave" && grep -q "token-event gap" <<<"$out" \
  && ok fail-abbrev-trap || { bad fail-abbrev-trap; echo "$out"; }

echo "fail: gh api FAILS (auth outage) — gh_error, never empty_wave (ticket 0cea589d)"
cat > "$SBX/gh-fail.sh" <<'SHIM'
#!/usr/bin/env bash
echo "To get started with GitHub CLI, please run:  gh auth login" >&2
exit 1
SHIM
chmod +x "$SBX/gh-fail.sh"
out="$(GIT_BIN="$SBX/git-shim.sh" GH_BIN="$SBX/gh-fail.sh" \
  VERIFY_WAVE_MAIN=main-at-base bash ./verify-wave.sh test/repo "$SECOND")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "cause=gh_error rc=1" \
  && echo "$out" | grep -q "NOT the token-event gap" \
  && echo "$out" | grep -q "gh auth login" \
  && ok fail-gh-error || { bad fail-gh-error; echo "$out"; }

echo "gh_error names the rc and stderr head verbatim (rc=4, custom head)"
cat > "$SBX/gh-fail4.sh" <<'SHIM'
#!/usr/bin/env bash
echo "HTTP 502: bad gateway" >&2
exit 4
SHIM
chmod +x "$SBX/gh-fail4.sh"
out="$(GIT_BIN="$SBX/git-shim.sh" GH_BIN="$SBX/gh-fail4.sh" \
  VERIFY_WAVE_MAIN=main-at-base bash ./verify-wave.sh test/repo "$SECOND")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "cause=gh_error rc=4" && echo "$out" | grep -q "HTTP 502: bad gateway" \
  && ok gh-error-rc-stderr || { bad gh-error-rc-stderr; echo "$out"; }

echo "empty_wave stays empty_wave when gh SUCCEEDS with zero runs (rc=0 — the real dispatch gap)"
# $BASE is an ancestor whose wave file the abbrev-trap test just removed —
# the shim answers rc=0 with the empty wave (a genuine dispatch gap shape).
out="$(VW main-at-base "$BASE")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "cause=empty_wave" && ! grep -q "cause=gh_error" <<<"$out" \
  && ok empty-wave-still-real || { bad empty-wave-still-real; echo "$out"; }

echo "empty_wave downgrade: VERIFY_WAVE_EMPTY_OK=1"
out="$(VERIFY_WAVE_EMPTY_OK=1 GIT_BIN="$SBX/git-shim.sh" GH_BIN="$SBX/gh-shim.sh" \
  VERIFY_WAVE_MAIN=main-at-base bash ./verify-wave.sh test/repo "${BASE:0:10}")"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "VERDICT: PASS.*runs=0 red=0 pend=0 (empty_wave downgraded)" && ok empty-ok-downgrade || { bad empty-ok-downgrade; echo "$out"; }

echo "fail: pending run in the wave (conclusion null — the f117-review gap)"
cat > "$SBX/waves/$BASE.json" <<EOF
{"workflow_runs":[
 {"id":311,"name":"CI","conclusion":"success"},
 {"id":312,"name":"Deploy to AWS EC2","conclusion":null,"status":"in_progress"}]}
EOF
out="$(VW main-at-base "$BASE")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "cause=pending_runs ancestor=ANCESTOR_OK runs=2 red=0 pend=1" \
  && echo "$out" | grep -q "PEND run 312 Deploy to AWS EC2 in_progress" \
  && ok fail-pending-runs || { bad fail-pending-runs; echo "$out"; }

echo "pending downgrade: VERIFY_WAVE_PENDING_OK=1"
out="$(VERIFY_WAVE_PENDING_OK=1 GIT_BIN="$SBX/git-shim.sh" GH_BIN="$SBX/gh-shim.sh" \
  VERIFY_WAVE_MAIN=main-at-base bash ./verify-wave.sh test/repo "$BASE")"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "VERDICT: PASS.*runs=2 red=0 pend=1 (pending_runs downgraded" \
  && ok pending-ok-downgrade || { bad pending-ok-downgrade; echo "$out"; }

echo "fail: red beats pending (mixed wave reports red_runs, not pending_runs)"
cat > "$SBX/waves/$BASE.json" <<EOF
{"workflow_runs":[
 {"id":411,"name":"CI","conclusion":"failure"},
 {"id":412,"name":"Deploy to AWS EC2","conclusion":null,"status":"in_progress"}]}
EOF
out="$(VW main-at-base "$BASE")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -q "cause=red_runs ancestor=ANCESTOR_OK runs=2 red=1 pend=1" \
  && echo "$out" | grep -q "RED run 411 CI failure" \
  && ok red-beats-pending || { bad red-beats-pending; echo "$out"; }

echo "two shas in one call: mixed verdicts, rc=1"
out="$(VW main-at-base "$SECOND" "$THIRD")"; rc=$?
[ $rc -eq 1 ] && echo "$out" | grep -c "VERDICT: PASS" | grep -q 1 && echo "$out" | grep -c "VERDICT: FAIL" | grep -q 1 \
  && ok two-shas-mixed || { bad two-shas-mixed; echo "$out"; }

echo "usage: no sha"
out="$(bash ./verify-wave.sh test/repo 2>&1)"; rc=$?
[ $rc -eq 2 ] && grep -q usage <<<"$out" && ok usage || { bad usage; echo "$out"; }

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

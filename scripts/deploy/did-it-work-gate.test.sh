#!/usr/bin/env bash
# Regression test — did-it-work gate (T2d, todo ea2483a8 / goal 0039c142,
# charter ticket b4824553; owner answer oq_e4f4e382: "Yes to both —
# autonomous deploy loop").
#
# The gate this pins: after the blue-green switch, deploy-blue-green.sh runs
# scripts/deploy/did-it-work-gate.sh for ~5–10 minutes (health + authenticated
# login/smoke + error rate vs the pre-switch baseline) BEFORE .active-color is
# committed and the old color drained. A hard failure exits 42 →
# deploy-blue-green.sh reverts the flip, the workflow runs rollback.sh
# --to-live (idempotent) and pushes a revert of the deploy's commits to main.
#
# Invariants:
#   A. bash -n / node --check parse everything touched.
#   B. Activation: IS_DID_IT_WORK unset → exit 2 (legacy path, no gating);
#      DID_IT_WORK_DISABLED=1 → exit 0 with a ::warning (kill switch, loud).
#   C. Behavior with PATH-stubbed curl / deploy-auth-smoke.sh / sudo-docker:
#      - healthy + probe ok                     → exit 0, cycles = 1 fresh
#        login (mode new) then rechecks
#      - health failing twice (blip re-probe)   → exit 42
#      - auth smoke failing twice               → exit 42
#      - probe rc=1 (error rate over baseline)  → exit 42
#      - probe rc=3 both tries (unknown)        → exit 0 with a warning —
#        NEVER roll back prod on a measurement the probe could not take
#   D. The probe itself (real node, fixture DB module via DID_IT_WORK_DB_MODULE):
#      window > baseline × factor over the floor → exit 1; below floor → 0;
#      equal rate → 0; DB throw → 3; missing epoch → 3.
#   E. Wiring: deploy-blue-green.sh calls the gate BETWEEN the post-flip
#      recheck and the .active-color commit (the --to-live ordering
#      invariant), propagates exit 42 as its own exit 42 after revert_flip,
#      and forwards every tuning var with :- defaults (set -euo pipefail
#      safe). deploy.yml: remote timeout 3300; rc==42 → DID_IT_WORK_FAILED
#      env + did_it_work_failed output; reset-main job gated on that output,
#      pushes a REVERT (no --force, no +ref), carries contents:write ONLY on
#      that job; ci.yml's shell-scripts glob covers did-it-work-gate.test.sh.
#
# Plain-bash idiom, mirrors scripts/deploy/blue-green-speedups.test.sh.
# Run from anywhere: bash scripts/deploy/did-it-work-gate.test.sh

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/deploy/did-it-work-gate.sh"
PROBE="$ROOT/scripts/deploy/did-it-work-probe.js"
BLUE="$ROOT/deploy-blue-green.sh"
YML="$ROOT/.github/workflows/deploy.yml"
CI="$ROOT/.github/workflows/ci.yml"

failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

for f in "$GATE" "$PROBE" "$BLUE" "$YML" "$CI"; do
  [ -f "$f" ] || { bad "missing file: $f"; echo "$failures invariant(s) violated" >&2; exit 1; }
done

# ── A. parse ──────────────────────────────────────────────────────────────────
bash -n "$GATE"    && ok "gate: bash -n"    || bad "gate: bash -n"
bash -n "$BLUE"    && ok "deploy-blue-green.sh: bash -n" || bad "deploy-blue-green.sh: bash -n"
node --check "$PROBE" >/dev/null 2>&1 && ok "probe: node --check" || bad "probe: node --check"

# ── B. activation contract ────────────────────────────────────────────────────
out=$(env -u IS_DID_IT_WORK bash "$GATE" 2>/dev/null); rc=$?
check "inactive (IS_DID_IT_WORK unset) → exit 2" 2 "$rc"
check "inactive message names the contract" 1 "$(echo "$out" | grep -c 'IS_DID_IT_WORK not set')"

out=$(IS_DID_IT_WORK=1 DID_IT_WORK_DISABLED=1 \
      PUBLIC_BASE_URL=https://digby.ai DID_IT_WORK_EPOCH=2026-10-17T00:00:00Z \
      DID_IT_WORK_CONTAINER=admin-backend-green \
      bash "$GATE" 2>/dev/null); rc=$?
check "kill switch → exit 0" 0 "$rc"
check "kill switch warns loudly" 1 "$(echo "$out" | grep -c 'DID_IT_WORK_DISABLED=1')"

out=$(IS_DID_IT_WORK=1 bash "$GATE" 2>/dev/null); rc=$?
check "active but missing required env → exit 3 (config error; caller fails CLOSED without a main reset)" 3 "$rc"

# ── C. behavior with stubs ────────────────────────────────────────────────────
SB="$(mktemp -d)"
DB_FIXTURE="$SB/db.js"
trap 'rm -rf "$SB"' EXIT

mkstub_curl() { # $1 = health body, $2 = fe code
  cat > "$SB/curl" <<EOF
#!/usr/bin/env bash
# stub curl: /api/health → $1, everything else (frontend) → $2
case " \$* " in
  *"/api/health"*) printf '%s' '$1'; exit 0 ;;
  *) echo '$2'; exit 0 ;;
esac
EOF
  chmod +x "$SB/curl"
}

mkstub_auth() { # $1 = rc (0 pass, 1 fail); records modes
  cat > "$SB/deploy-auth-smoke.sh" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$SB/auth-modes"
exit $1
EOF
  chmod +x "$SB/deploy-auth-smoke.sh"
}

# stub sudo: docker cp/rm succeed; docker exec re-exports the -e K=V pairs
# the gate passes and runs the REAL probe with the fixture DB module — the
# probe's true verdict (ok/fail/unknown) flows through the gate exactly as in
# production, only the container hop is faked.
mkstub_sudo() {
  cat > "$SB/sudo" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "docker" ] && [ "\$2" = "exec" ]; then
  args=("\$@")
  i=0
  while [ \$i -lt \${#args[@]} ]; do
    if [ "\${args[\$i]}" = "-e" ]; then
      i=\$((i + 1))
      export "\${args[\$i]}"
    fi
    i=\$((i + 1))
  done
  export DID_IT_WORK_DB_MODULE="$DB_FIXTURE"
  exec node "$PROBE"
fi
exit 0
EOF
  chmod +x "$SB/sudo"
}

# fixture DB module: counts injected via DIW_W (window) / DIW_B (baseline);
# the baseline query carries BOTH gte and lt, the window query only gte.
mk_db_fixture() { # $1 = window rows, $2 = baseline rows
  cat > "$DB_FIXTURE" <<EOF
const w = $1, b = $2;
module.exports = { default: { appErrorLog: { count: async ({ where }) => {
  return (where.createdAt.gte && where.createdAt.lt) ? b : w;
} } } };
EOF
}

run_gate() {
  env PATH="$SB:$PATH" \
      IS_DID_IT_WORK=1 \
      AUTH_SMOKE="$SB/deploy-auth-smoke.sh" \
      PUBLIC_BASE_URL=https://digby.ai \
      DID_IT_WORK_EPOCH="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      DID_IT_WORK_CONTAINER=admin-backend-green \
      DID_IT_WORK_CYCLES=2 DID_IT_WORK_INTERVAL_SECONDS=1 DID_IT_WORK_BLIP_SECONDS=1 \
      bash "$GATE" 2>/dev/null
}

# C1: healthy + probe ok → 0; first cycle logs in fresh (new), second rechecks
mkstub_curl '{"status":"healthy"}' 200
mkstub_auth 0
mkstub_sudo
mk_db_fixture 2 2
rm -f "$SB/auth-modes"
out=$(run_gate); rc=$?
check "healthy + probe ok → exit 0" 0 "$rc"
check "cycle 1 uses a fresh login (mode new)" 1 "$(head -1 "$SB/auth-modes" | grep -c '^new$')"
check "cycle 2 reuses the token (mode recheck)" 1 "$(tail -1 "$SB/auth-modes" | grep -c '^recheck$')"

# C2: health failing → 42 (blip re-probe exhausted)
mkstub_curl '{"status":"error"}' 000
out=$(run_gate); rc=$?
check "health failing twice → exit 42" 42 "$rc"

# C3: health ok, auth failing → 42
mkstub_curl '{"status":"healthy"}' 200
mkstub_auth 1
out=$(run_gate); rc=$?
check "authenticated smoke failing twice → exit 42" 42 "$rc"

# C4: health+auth ok, probe rc=1 (error rate over baseline) → 42
mkstub_auth 0
mk_db_fixture 500 1
out=$(run_gate); rc=$?
check "probe verdict fail (rate over baseline×factor) → exit 42" 42 "$rc"

# C5: probe unknown both tries (docker unreachable) → pass with warning
cat > "$SB/sudo" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$SB/sudo"
out=$(run_gate); rc=$?
check "probe unknown (docker down) both tries → exit 0 (no rollback on an unmeasurable rate)" 0 "$rc"

# ── D. the probe itself (real node) ───────────────────────────────────────────
probe_run() { # env via arguments of the caller
  SWITCH_EPOCH_UTC="$1" WINDOW_MINUTES="${2:-6}" DID_IT_WORK_DB_MODULE="$DB_FIXTURE" \
    node "$PROBE" 2>/dev/null; echo "rc=$?"
}

cat > "$DB_FIXTURE" <<'EOF'
// D fixtures read counts from env: DIW_W (window), DIW_B (baseline)
const w = Number(process.env.DIW_W || 0), b = Number(process.env.DIW_B || 0);
module.exports = { default: { appErrorLog: { count: async ({ where }) => {
  return where.createdAt.gte && where.createdAt.lt ? b : w;
} } } };
EOF

EPOCH_6M_AGO=$(date -u -d '-6 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-6M +%Y-%m-%dT%H:%M:%SZ)

out=$(DIW_W=500 DIW_B=1 probe_run "$EPOCH_6M_AGO" 6); rc=${out##*rc=}
check "probe: error storm (500 vs 1) → exit 1" 1 "$rc"
check "probe: fail verdict names the factor" 1 "$(echo "$out" | grep -c 'VERDICT=fail')"

out=$(DIW_W=3 DIW_B=1 probe_run "$EPOCH_6M_AGO" 6); rc=${out##*rc=}
check "probe: below the meaning floor → exit 0" 0 "$rc"

out=$(DIW_W=50 DIW_B=50 probe_run "$EPOCH_6M_AGO" 6); rc=${out##*rc=}
check "probe: equal rates → exit 0" 0 "$rc"

out=$(SWITCH_EPOCH_UTC= probe_run "" 6); rc=${out##*rc=}
check "probe: missing epoch → exit 3 (unknown)" 3 "$rc"

cat > "$DB_FIXTURE" <<'EOF'
module.exports = { default: { appErrorLog: { count: async () => { throw new Error('db down'); } } } };
EOF
out=$(probe_run "$EPOCH_6M_AGO" 6); rc=${out##*rc=}
check "probe: DB unreachable → exit 3 (unknown)" 3 "$rc"

# ── E. wiring ─────────────────────────────────────────────────────────────────
# E1: the gate runs AFTER the post-flip auth recheck and BEFORE the
# .active-color commit (the rollback.sh --to-live ordering invariant).
gate_line=$(grep -n 'did-it-work-gate.sh' "$BLUE" | head -1 | cut -d: -f1)
commit_line=$(grep -n 'Active color saved' "$BLUE" | head -1 | cut -d: -f1)
recheck_line=$(grep -n 'Re-running authenticated smoke through' "$BLUE" | head -1 | cut -d: -f1)
[ -n "$gate_line" ] && [ -n "$commit_line" ] && [ -n "$recheck_line" ] \
  && [ "$recheck_line" -lt "$gate_line" ] && [ "$gate_line" -lt "$commit_line" ] \
  && ok "wiring: gate sits between the post-flip recheck and the .active-color commit" \
  || bad "wiring: gate placement wrong (recheck=$recheck_line gate=$gate_line commit=$commit_line)"

# E2: exit 42 propagates (the workflow's reset-main contract) after revert_flip.
grep -q 'revert_flip' "$BLUE" && grep -A2 'did-it-work gate FAILED' "$BLUE" | grep -q 'exit 42' \
  && ok "wiring: gate failure → revert_flip + exit 42" \
  || bad "wiring: gate failure must revert the flip and exit 42"

# E3: tuning vars forwarded with :- defaults (set -euo pipefail safe).
grep -q 'DID_IT_WORK_CYCLES="${DID_IT_WORK_CYCLES:-}"' "$BLUE" \
  && grep -q 'DID_IT_WORK_DISABLED="${DID_IT_WORK_DISABLED:-}"' "$BLUE" \
  && ok "wiring: tuning vars forwarded with :- defaults" \
  || bad "wiring: tuning var forwarding must use :- defaults (set -u)"

# E3a (ticket 7186006f, 2026-10-17): PUBLIC_BASE_URL must ride the invocation
# env prefix — it is an UNEXPORTED script variable (set at :164), so without
# this line the gate's required-env loop exits 3 (fail-closed) on EVERY wave
# and the deploy pipeline is down fleet-wide. Pinned hard: never regress.
grep -q 'PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \\' "$BLUE" \
  && ok "wiring: PUBLIC_BASE_URL passed to the gate (7186006f — pipeline-down regression pin)" \
  || bad "wiring: PUBLIC_BASE_URL missing from the gate invocation env prefix (7186006f)"

# E4: deploy.yml remote timeout raised to fit the window.
grep -q 'timeout --signal=TERM --kill-after=30 3300 bash deploy-blue-green.sh' "$YML" \
  && ok "wiring: remote timeout 3300 (window fits)" \
  || bad "wiring: remote timeout must be 3300"

# E5: rc==42 captured → env + output.
grep -q 'DID_IT_WORK_FAILED=1' "$YML" && grep -q 'did_it_work_failed=1.*GITHUB_OUTPUT\|did_it_work_failed=1" >> "\$GITHUB_OUTPUT"' "$YML" \
  && ok "wiring: rc 42 captured as DID_IT_WORK_FAILED env + job output" \
  || bad "wiring: rc 42 must be captured for the reset job"

# E6: reset-main job exists, gated on the output, no force push.
grep -q 'reset-main-on-did-it-work-failure' "$YML" \
  && grep -q "needs.deploy.outputs.did_it_work_failed == '1'" "$YML" \
  && ok "wiring: reset-main job gated on did_it_work_failed output" \
  || bad "wiring: reset-main job missing or ungated"

# E6a (review B1, 2026-10-17): the reset job must check out github.sha (the
# deployed tip) as the revert's base — checking out github.event.before (the
# range's own base) makes `git revert before..sha` a guaranteed no-op that
# still reports success. Pin the correct ref.
reset_block=$(awk '/reset-main-on-did-it-work-failure:/{f=1} f{print} f&&/^  [a-z][a-z-]*:/{if(++j>1)exit}' "$YML")
echo "$reset_block" | grep -q "ref: \${{ github.sha }}" \
  && ! echo "$reset_block" | grep -q "ref: \${{ github.event.before }}" \
  && ok "wiring: reset job reverts ON TOP of the deployed tip (github.sha, not the range base)" \
  || bad "wiring: reset job must check out github.sha (review B1 — event.before base makes the revert a no-op)"

# E6b: the push succeeding is not proof main moved — the ls-remote assertion
# must be present.
echo "$reset_block" | grep -q 'git ls-remote origin refs/heads/main' \
  && ok "wiring: reset job verifies main actually moved (ls-remote)" \
  || bad "wiring: reset job lacks the main-actually-moved assertion"

if grep -q 'git push origin "HEAD:refs/heads/main"' "$YML" && ! grep -qE 'git push.*(--force|\+refs/heads/main)' "$YML"; then
  ok "wiring: reset push is a normal commit push (no force)"
else
  bad "wiring: reset push must never force"
fi
grep -q 'git revert --no-commit' "$YML" \
  && ok "wiring: reset uses git revert (history preserved)" \
  || bad "wiring: reset must revert, not rewrite"

# E7: contents:write ONLY on the reset job.
write_block=$(awk '/reset-main-on-did-it-work-failure:/{f=1} f{print} f&&/^  [a-z]/&&!/reset-main/{exit}' "$YML" | grep -c 'contents: write')
[ "$write_block" -ge 1 ] && ok "wiring: reset job carries contents: write" || bad "wiring: reset job lacks contents: write"

# E8: ci.yml shell-scripts glob runs this harness (scripts/deploy/*.test.sh).
grep -q 'scripts/deploy/\*.test.sh' "$CI" \
  && ok "wiring: ci.yml shell-scripts job covers did-it-work-gate.test.sh" \
  || bad "wiring: ci.yml must run scripts/deploy/*.test.sh"

echo
if [ "$failures" -eq 0 ]; then
  echo "did-it-work-gate tests: all passed"
else
  echo "did-it-work-gate tests: $failures invariant(s) violated" >&2
  exit 1
fi

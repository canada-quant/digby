#!/usr/bin/env bash
# deploy-path-filter.test.sh — regression harness for
# scripts/deploy/deploy-path-filter.sh (framework audit 2026-10-15, todo
# 03bdbf26). Builds REAL git commit pairs in a temp repo (no shims needed —
# the script's only dependency is git) and asserts the decision in BOTH
# directions plus every fail-open edge.
#
# PINS THE AUDIT FINDING: 29 of 66 deploy waves in 72 h shipped no runtime
# change (~20 min + a backend restart each). The pin has two legs:
#   - docs/test-only push → runtime=no (deploy SKIPPED — the fix),
#   - runtime push → runtime=yes (deploy RUNS — never over-skip: a skipped
#     deploy strands main with nothing to redeploy it).
#
# Edge pins (the fail-safe law of deploy-coalesce-gate.sh: unknown ⇒ deploy):
#   - mixed push (docs + runtime) → deploy (deny by default),
#   - BEFORE_SHA/AFTER_SHA that does not resolve → deploy,
#   - HEAD with no parent (initial push / shallow clone) → deploy,
#   - empty diff listing → deploy (probe failure is never "no changes"),
#   - *.md at repo ROOT and DEEP (README.md, backend/foo.md) → skip,
#   - backend/src/**.test.ts AND backend/tests/** → skip,
#   - .github/** (workflow file itself) → DEPLOY (a deploy-config change
#     must reach prod's deploy definition),
#   - scripts/deploy/*.sh (non-test) → DEPLOY (deploy runtime tooling),
#   - GITHUB_OUTPUT missing → still answers on stdout (never crashes).
#
# Run from anywhere: bash scripts/deploy/deploy-path-filter.test.sh
set -u
command -v git >/dev/null 2>&1 || { echo "deploy-path-filter.test.sh: git is required" >&2; exit 1; }
cd "$(dirname "$0")"
SCRIPT=./deploy-path-filter.sh

SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()   { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

# run_filter <repo> <extra env> — runs the script with cwd=repo, captures
# stdout + the GITHUB_OUTPUT file. GITHUB_ACTIONS/GH_TOKEN/REPO are ALWAYS
# unset here: the harness itself runs inside CI (GITHUB_ACTIONS=true), and
# the docs-only legs pin the LOCAL guard contract (inert + warning); the
# CI-context contracts (creds missing in Actions ⇒ fail-open; probe
# consulted when creds present) are pinned explicitly by the section-13
# legs against the GUARD_DIR copy.
run_filter() {
  rm -f "$SBX/ghout"
  # DEPLOY_EVENT defaults to push (later assignments in $2 win): unset, the
  # script fail-opens to deploy — pinned by leg 13 below — so every push leg
  # must say so explicitly.
  ( cd "$1" && env -u BEFORE_SHA -u AFTER_SHA -u GITHUB_OUTPUT -u DEPLOY_EVENT \
      -u GH_TOKEN -u REPO -u GITHUB_ACTIONS \
      GITHUB_OUTPUT="$SBX/ghout" DEPLOY_EVENT=push $2 bash "$OLDPWD/$SCRIPT" ) > "$SBX/out" 2> "$SBX/err"
}
decision() { sed -n 's/^runtime=//p' "$SBX/ghout"; }
stdout_dec(){ grep -o 'runtime=[a-z]*' "$SBX/out" | tail -1; }

# mkrepo — a temp git repo with an initial commit; returns its path.
mkrepo() {
  local d="$SBX/r$RANDOM$RANDOM"
  mkdir -p "$d"
  git -C "$d" init -q -b main
  git -C "$d" -C "$d" config user.email t@t && git -C "$d" config user.name t
  echo base > "$d/README.md"
  git -C "$d" add -A && git -C "$d" commit -qm base
  printf '%s' "$d"
}

# commit_pair <repo> <files...> — makes ONE new commit touching the given
# paths (created empty/deleted-and-recreated so content never matters) and
# prints "BEFORE AFTER".
commit_pair() {
  local d="$1"; shift
  local before=$(git -C "$d" rev-parse HEAD)
  for f in "$@"; do
    mkdir -p "$d/$(dirname "$f")"
    printf 'x%d\n' "$RANDOM" > "$d/$f"
  done
  git -C "$d" add -A && git -C "$d" commit -qm "touch $*"
  printf '%s %s' "$before" "$(git -C "$d" rev-parse HEAD)"
}

# --- 1. THE FIX: docs/test-only push → skip -------------------------------
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/notes.md" ".digby/rules/00-current-state.md" "memory-bank/x.md" "README.md" "backend/src/foo.test.ts" "scripts/deploy/x.test.sh")
run_filter "$d" ""
check "docs/test-only push → runtime=no" "no" "$(decision)"
check "docs/test-only push → stdout echoes" "runtime=no" "$(stdout_dec)"

# --- 1b. THE ESCAPE HATCH: workflow_dispatch ALWAYS deploys -----------------
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
run_filter "$d" "DEPLOY_EVENT=workflow_dispatch"
check "workflow_dispatch on docs-only → runtime=yes" "yes" "$(decision)"

d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
run_filter "$d" "DEPLOY_EVENT=push"
check "push event passthrough → runtime=no" "no" "$(decision)"

# --- 2. THE OTHER DIRECTION: runtime push → deploy -------------------------
d=$(mkrepo); read B A < <(commit_pair "$d" "backend/src/index.ts")
run_filter "$d" ""
check "runtime push (src) → runtime=yes" "yes" "$(decision)"

d=$(mkrepo); read B A < <(commit_pair "$d" "frontend/app/page.tsx")
run_filter "$d" ""
check "runtime push (frontend) → runtime=yes" "yes" "$(decision)"

d=$(mkrepo); read B A < <(commit_pair "$d" "package.json" "docker-compose.app.yml" "scripts/deploy/deploy-coding-worker.sh")
run_filter "$d" ""
check "runtime push (compose/deploy tooling) → runtime=yes" "yes" "$(decision)"

# --- 3. MIXED push (docs + runtime) → deploy (deny by default) -------------
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/a.md" "backend/src/service.ts")
run_filter "$d" ""
check "mixed push → runtime=yes" "yes" "$(decision)"

# --- 4. *.md DEEP and at ROOT; backend jest tree ----------------------------
d=$(mkrepo); read B A < <(commit_pair "$d" "backend/src/foo.md" "plans/bar.md" "backend/tests/unit/x.ts" "e2e/y.test.ts")
run_filter "$d" ""
check "deep .md + backend/tests + e2e tests → runtime=no" "no" "$(decision)"

# --- 4b. SERVED CONTENT: frontend/content/help/**.md is RUNTIME (F31) -------
# F31 shortfall (2026-10-21): frontend/lib/help-docs.ts reads content/help from
# the image at request time (Dockerfile COPYs content/ into the runtime image;
# the .md files are committed build artifacts synced from docs/). The generic
# /\.md$/ skip classified a help-only merge docs-only → no deploy → prod served
# stale /help until the next runtime wave. Pinned in BOTH directions: the
# mirror deploys; the docs/ SOURCE still skips (the image only changes when the
# committed mirror does).
d=$(mkrepo); read B A < <(commit_pair "$d" "frontend/content/help/asking-bigger.md")
run_filter "$d" ""
check "help-content-only push (.md, served) → runtime=yes" "yes" "$(decision)"

d=$(mkrepo); read B A < <(commit_pair "$d" "frontend/content/help/depth.md" "frontend/content/help/manifest.json")
run_filter "$d" ""
check "help doc + manifest push → runtime=yes" "yes" "$(decision)"

d=$(mkrepo); read B A < <(commit_pair "$d" "docs/ASKING_BIGGER.md")
run_filter "$d" ""
check "docs/ help SOURCE stays docs-only → runtime=no" "no" "$(decision)"

# --- 5. .github/** and non-test scripts → deploy ----------------------------
d=$(mkrepo); read B A < <(commit_pair "$d" ".github/workflows/ci.yml" ".github/actions/ssh-gate/action.yml")
run_filter "$d" ""
check ".github change → runtime=yes" "yes" "$(decision)"

d=$(mkrepo); read B A < <(commit_pair "$d" "scripts/deploy/deploy-watchdog.sh" "scripts/framework-audit/probe-x.js")
run_filter "$d" ""
check "non-test script change → runtime=yes" "yes" "$(decision)"

# --- 6. FAIL-OPEN: unresolvable sha pair → deploy ----------------------------
d=$(mkrepo)
run_filter "$d" "BEFORE_SHA=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef AFTER_SHA=HEAD"
check "unresolvable BEFORE_SHA → runtime=yes" "yes" "$(decision)"

# --- 7. FAIL-OPEN: no parent (initial commit / shallow) → deploy -------------
d2="$SBX/initial$RANDOM"; mkdir -p "$d2"; git -C "$d2" init -q -b main
git -C "$d2" config user.email t@t && git -C "$d2" config user.name t
echo x > "$d2/README.md"; git -C "$d2" add -A && git -C "$d2" commit -qm only
run_filter "$d2" ""
check "no-parent HEAD → runtime=yes" "yes" "$(decision)"

# --- 8. FAIL-OPEN: empty diff listing (same sha twice) → deploy --------------
d=$(mkrepo)
run_filter "$d" "BEFORE_SHA=HEAD AFTER_SHA=HEAD"
check "empty diff (same sha) → runtime=yes" "yes" "$(decision)"

# --- 9. spec.ts / spec.tsx / test.tsx variants -------------------------------
d=$(mkrepo); read B A < <(commit_pair "$d" "frontend/app/a.spec.ts" "frontend/app/b.test.tsx" "c.spec.js")
run_filter "$d" ""
check "spec/test variants → runtime=no" "no" "$(decision)"

# --- 10. an unexpected top-level file → deploy --------------------------------
d=$(mkrepo); read B A < <(commit_pair "$d" "LICENSE.txt" "cert.pem")
run_filter "$d" ""
check "unclassified file → runtime=yes" "yes" "$(decision)"

# --- 11. GITHUB_OUTPUT unset → answers on stdout, exit 0 ----------------------
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
rm -f "$SBX/ghout"
( cd "$d" && env -u GITHUB_OUTPUT -u GH_TOKEN -u REPO -u GITHUB_ACTIONS DEPLOY_EVENT=push bash "$OLDPWD/$SCRIPT" ) > "$SBX/out" 2>&1
RC=$?
check "GITHUB_OUTPUT unset → exit 0" "0" "$RC"
check "GITHUB_OUTPUT unset → stdout answers" "runtime=no" "$(stdout_dec)"

# --- 11b. DEPLOY_EVENT unset → fail-open deploy (unknown event never skips) ---
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
rm -f "$SBX/ghout"
( cd "$d" && env -u DEPLOY_EVENT -u GITHUB_OUTPUT bash "$OLDPWD/$SCRIPT" ) > "$SBX/out" 2>&1
check "DEPLOY_EVENT unset → runtime=yes (fail-open)" "runtime=yes" "$(stdout_dec)"

# --- 12. the workflow contract: exactly one runtime= line ---------------------
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
run_filter "$d" ""
check "one runtime= line written" "1" "$(grep -c '^runtime=' "$SBX/ghout")"

# ===========================================================================
# --- 13. THE STRAND GUARD (ticket a4309ef9, live 2026-10-16) -----------------
# The reproduced scenario end-to-end: a docs-only push whose PARENT is an
# undeployed runtime merge. The filter invokes the probe by ABSOLUTE path
# ($SCRIPT_DIR/deploy-strand-probe.sh), so a PATH shim cannot intercept it —
# instead these legs run a COPY of the real filter from a scratch dir that
# also holds a fixture probe. Real filter code, fake probe, real env
# contract (asserted by the fake), no network. The probe's own logic is
# pinned by deploy-strand-probe.test.sh — here only the WIRING is under
# test: env passing (REPO/GH_TOKEN/HEAD_SHA), answer parsing, fail-open.
# ===========================================================================
GUARD_DIR="$SBX/guard"; mkdir -p "$GUARD_DIR"
cp "$SCRIPT" "$GUARD_DIR/deploy-path-filter.sh"
cp ./runtime-skip-set.awk "$GUARD_DIR/runtime-skip-set.awk"

# mk_guard_probe <answer> — writes the fixture probe into $GUARD_DIR
mk_guard_probe() {
  cat > "$GUARD_DIR/deploy-strand-probe.sh" <<EOF
#!/usr/bin/env bash
# test double for deploy-strand-probe.sh (fixture answer: '$1')
[ -n "\${REPO:-}" ]     || { echo "shim: REPO missing" >&2; exit 9; }
[ -n "\${GH_TOKEN:-}" ] || { echo "shim: GH_TOKEN missing" >&2; exit 9; }
[ -n "\${HEAD_SHA:-}" ] || { echo "shim: HEAD_SHA missing" >&2; exit 9; }
[ -n "\${STRAND_FIXTURE_ANSWER:-}" ] || { echo "shim: no fixture answer" >&2; exit 9; }
echo "strand-probe: stranded=\$STRAND_FIXTURE_ANSWER — (fixture)"
echo "stranded=\$STRAND_FIXTURE_ANSWER"
exit 0
EOF
  chmod +x "$GUARD_DIR/deploy-strand-probe.sh"
}

# run_guard <repo> — filter copy + fixture probe; answer from GITHUB_OUTPUT
run_guard() {
  rm -f "$SBX/ghout"
  ( cd "$1" && env -u BEFORE_SHA -u AFTER_SHA -u GITHUB_OUTPUT -u DEPLOY_EVENT \
      GITHUB_OUTPUT="$SBX/ghout" DEPLOY_EVENT=push \
      GH_TOKEN=test-token REPO=octo/test \
      STRAND_FIXTURE_ANSWER="$2" ${3:-} bash "$GUARD_DIR/deploy-path-filter.sh" ) > "$SBX/out" 2> "$SBX/err"
  decision
}

# 13a. THE LIVE STRAND: docs-only push + probe says stranded → DEPLOY.
#      (merge c67577e9e's cancelled wave 38912911194 → carrier 38913411207
#      skipped its Deploy job — the exact shape this guard exists to catch.)
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
mk_guard_probe yes
run_guard "$d" yes > /dev/null
check "13a. docs-only push + stranded=yes → runtime=yes (THE FIX)" "yes" "$(decision)"
check "13a. log explains the un-strand" "yes" "$(grep -q 'strand guard: undeployed runtime' "$SBX/out" && echo yes || echo no)"
# the probe asserts the env contract itself (REPO/GH_TOKEN/HEAD_SHA) and
# dies rc=9 with a 'shim:' complaint if the filter dropped any of them —
# stderr must carry NO such complaint.
if grep -q 'shim:' "$SBX/err"; then bad "13a. probe env contract (REPO/GH_TOKEN/HEAD_SHA)"; else ok "13a. probe env contract (REPO/GH_TOKEN/HEAD_SHA)"; fi

# 13b. docs-only push + nothing undeployed → skip (the optimization SURVIVES)
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
run_guard "$d" no > /dev/null
check "13b. docs-only push + stranded=no → runtime=no (skip preserved)" "no" "$(decision)"

# 13c. docs-only push + probe UNANSWERABLE → deploy (fail-open, never a quiet skip)
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
run_guard "$d" "" > /dev/null
check "13c. probe unanswerable → runtime=yes (fail-open)" "yes" "$(decision)"

# 13d. probe script MISSING → deploy (fail-open) — no probe file in the dir
rm -f "$GUARD_DIR/deploy-strand-probe.sh"
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
run_guard "$d" yes > /dev/null
check "13d. probe missing → runtime=yes (fail-open)" "yes" "$(decision)"

# 13e. NO CI CREDENTIALS — LOCAL context (GITHUB_ACTIONS unset): guard
#      inert, answers the push diff alone + a ::warning:: — never a silent
#      no-op. (GITHUB_ACTIONS must be explicitly unset: the harness itself
#      runs inside CI, where it is always "true".)
mk_guard_probe yes   # probe restored (13d deleted it): the no-creds leg
                     # must NOT consult it at all — the warning is the pin
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
rm -f "$SBX/ghout"
( cd "$d" && env -u BEFORE_SHA -u AFTER_SHA -u GITHUB_OUTPUT -u DEPLOY_EVENT -u GH_TOKEN -u REPO -u GITHUB_ACTIONS \
    GITHUB_OUTPUT="$SBX/ghout" DEPLOY_EVENT=push bash "$GUARD_DIR/deploy-path-filter.sh" ) > "$SBX/out" 2> "$SBX/err"
check "13e. no-creds local docs-only → runtime=no (guard inert)" "no" "$(decision)"
check "13e. no-creds emits the guard-inert warning" "yes" "$(grep -q '::warning::path-filter: strand guard inert' "$SBX/out" && echo yes || echo no)"

# 13e-2. NO CI CREDENTIALS — CI CONTEXT (GITHUB_ACTIONS=true, creds missing
#        = a deploy.yml mis-edit): fail-OPEN to deploy. A wrongly-skipped
#        deploy strands main; a redundant one never does (adversarial
#        review F2).
d=$(mkrepo); read B A < <(commit_pair "$d" "docs/only.md")
rm -f "$SBX/ghout"
( cd "$d" && env -u BEFORE_SHA -u AFTER_SHA -u GITHUB_OUTPUT -u DEPLOY_EVENT -u GH_TOKEN -u REPO \
    GITHUB_OUTPUT="$SBX/ghout" DEPLOY_EVENT=push GITHUB_ACTIONS=true bash "$GUARD_DIR/deploy-path-filter.sh" ) > "$SBX/out" 2> "$SBX/err"
check "13e-2. no-creds IN CI → runtime=yes (fail-open, F2)" "yes" "$(decision)"
check "13e-2. CI no-creds names the mis-edit" "yes" "$(grep -q 'strand guard UNUSABLE in CI' "$SBX/out" && echo yes || echo no)"

# 13f. a RUNTIME push never consults the probe (the probe cannot DOWNGRADE
#      a deploy decision — only rescue a docs-skip). Probe returns no, but
#      a runtime file in the push must still deploy.
mk_guard_probe no
d=$(mkrepo); read B A < <(commit_pair "$d" "backend/src/service.ts")
run_guard "$d" no > /dev/null
check "13f. runtime push → runtime=yes regardless of probe" "yes" "$(decision)"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "deploy-path-filter.test.sh: $PASS passed, $FAIL FAILED"
  exit 1
fi
echo "deploy-path-filter.test.sh: $PASS passed, $FAIL failed"

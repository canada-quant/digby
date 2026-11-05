#!/usr/bin/env bash
# ci-scoping.test.sh — drift guard for PR test scoping (ticket d6f96c89).
#
# Guards the invariants of .github/workflows/ci.yml's PR scoping and
# .github/workflows/nightly-full-suite.yml, mirroring the guard pattern of
# integration-e2e-suites.test.sh (runs in ci.yml's Deploy shell-script
# tests job). The classification this guard pins:
#
#   pull_request  → backend/scripts/ci-scope-pr.sh decides: related-only
#                   jest (--findRelatedTests, 4-way shards) with FAIL-CLOSED
#                   fallback to the full suite
#   push to main/batch/**, workflow_call (deploy), workflow_dispatch →
#                   the FULL 4-shard suite, never scoped
#   nightly cron  → nightly-full-suite.yml runs the FULL suite on main
#                   with a failure-filing step
#
# Fails CI when either side drifts:
#   1. the scoped jest command exists and is ONLY reachable on the PR path;
#   2. the full-suite command stays EXACTLY as the push path runs it
#      (same ignore patterns, same 4-shard matrix);
#   3. the scoping wrapper keeps its fail-closed arms (kill switch,
#      missing-base, empty set, missing file, threshold);
#   4. the nightly workflow keeps schedule + dispatch + kill switch +
#      timeout + the failure-filing path;
#   5. the scoper's ignore list matches ci.yml's full-suite ignore list
#      (the T3h nightly-only classification is preserved on BOTH paths).
#
# Pure text/structure checks — no AWS, no docker, no node needed.
# Run from anywhere: bash scripts/deploy/ci-scoping.test.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI="$ROOT/.github/workflows/ci.yml"
NIGHTLY="$ROOT/.github/workflows/nightly-full-suite.yml"
SCOPER="$ROOT/backend/scripts/ci-scope-pr.sh"

failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }
contains() { if grep -qF "$2" "$1"; then ok "contains: $2"; else bad "$1 missing: $2"; fi; }
# present_at_least FILE NEEDLE MIN — a needle may legitimately appear on more
# than one line (the scoper states its ignore list in BOTH the array and the
# exec lines); what matters is that it appears at all.
present_at_least() { n="$(grep -cF -- "$3" "$2")"; if [ "$n" -ge "$4" ]; then ok "present: $3 (x$n)"; else bad "$2 needs >=$4 of: $3 (found $n)"; fi; }

[ -f "$CI" ] || { bad "missing $CI"; echo "$failures invariant(s) violated" >&2; exit 1; }
[ -f "$NIGHTLY" ] || { bad "missing $NIGHTLY (the nightly full-suite workflow must exist)"; echo "$failures invariant(s) violated" >&2; exit 1; }
[ -f "$SCOPER" ] || { bad "missing $SCOPER (the PR scoping wrapper must exist)"; echo "$failures invariant(s) violated" >&2; exit 1; }

NIGHTLY_SUITES="relay.integration cohesive.e2e moonshot.integration fleet-supervisor.e2e"

# ── 1. the backend job runs the scoper on PRs, the full suite otherwise ────
# The scoper is the PR-path jest entrypoint in the backend job's run step
# (the run block is an if/else on the event name; the job's
# working-directory is backend/, so the wrapper path is backend-relative):
contains "$CI" 'bash scripts/ci-scope-pr.sh' || bad "ci.yml backend job must call the scoper on the PR path"
contains "$CI" 'if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]' || bad "ci.yml must gate the scoper on the pull_request event"
check "ci.yml has exactly one full-suite jest line carrying --testPathIgnorePatterns (the else branch)" \
  "1" "$(grep -c -- 'npx jest --maxWorkers=2 --testPathIgnorePatterns' "$CI")"

# The scoper's own full-suite fallback keeps the EXACT full-suite command:
SCOPER_JEST_LINE="$(grep -n -- 'exec npx jest --maxWorkers=2 --testPathIgnorePatterns' "$SCOPER" | head -1)"
[ -n "$SCOPER_JEST_LINE" ] && ok "scoper full-suite fallback is the exact full-suite command" || bad "scoper missing the full-suite fallback jest line"

# The full-suite run in ci.yml (push/workflow_call/dispatch path) is unchanged:
CI_JEST_LINE="$(grep -n -- 'npx jest --maxWorkers=2 --testPathIgnorePatterns' "$CI" | head -1)"
[ -n "$CI_JEST_LINE" ] && ok "ci.yml keeps the full-suite jest line (push path)" || bad "ci.yml lost the full-suite jest line"

# ── 2. the scoper keeps its fail-closed arms ────────────────────────────────
for needle in \
  'CI_SCOPED_TESTS_DISABLED' \
  'CI_SCOPE_BASE_SHA missing' \
  'base sha' \
  'git diff against the base sha failed' \
  'force-full surface changed' \
  'empty change set' \
  'changed file missing from the checkout' \
  'outside src|scripts source scope' \
  'changed source files > threshold'; do
  contains "$SCOPER" "$needle" || bad "scoper lost fail-closed arm: $needle"
done
# Cross-family review #1/#2/#4 arms (2026-10-18): the jest-error fallback,
# the echoed scoped command, and the quoted-path arm.
for needle in \
  'jest exited non-zero on the scoped run' \
  'no Jest Test Suites summary on the scoped run' \
  'git-quoted (control-character) path in the change set'; do
  contains "$SCOPER" "$needle" || bad "scoper lost cross-family-review fail-closed arm: $needle"
done
check "scoper uses --findRelatedTests (the scoped mode exists)" "true" "$(grep -q -- '--findRelatedTests' "$SCOPER" && echo true || echo false)"
check "scoper uses --passWithNoTests (empty shards exit 0)" "true" "$(grep -q -- '--passWithNoTests' "$SCOPER" && echo true || echo false)"
check "scoper diffs with --no-renames (a rename must list BOTH sides — review B1)" "true" "$(grep -q -- '--no-renames' "$SCOPER" && echo true || echo false)"
# R3-1 (round-3 review): the flag pins above are comment-satisfiable — the
# flag name also appears in comments. Pin the EXACT exec'd command string
# instead: exactly ONE occurrence = the command line itself (comments quote
# it only in pieces).
check "scoper exec-line is exactly 'git -c core.quotePath=false diff --no-renames --name-only' (comment-proof — R3-1)" "1" "$(grep -cF 'git -c core.quotePath=false diff --no-renames --name-only' "$SCOPER")"
check "scoper diffs with core.quotePath=false (non-ASCII paths stay unquoted, not NEUTRAL-skipped)" "true" "$(grep -q -- 'core.quotePath=false' "$SCOPER" && echo true || echo false)"
check "scoper force-full list carries backend/eslint (N1 parity with verify-scoped.ts FORCE_FULL_PREFIXES)" "true" "$(grep -q 'backend/eslint' "$SCOPER" && echo true || echo false)"

# ── 3. ignore lists match: scoper == ci.yml full-suite == the T3h set ──────
for base in $NIGHTLY_SUITES; do
  check "scoper ignores $base (nightly-only, stays out of PR runs)" "true" "$(grep -qF "/$base.test.ts\$" "$SCOPER" && echo true || echo false)"
  check "ci.yml full-suite line ignores $base" "true" "$(printf '%s\n' "$CI_JEST_LINE" | grep -qF "/$base.test.ts\$" && echo true || echo false)"
done
check "scoper re-states /node_modules/ (the flag replaces jest's default)" "true" "$(grep -q "'/node_modules/'" "$SCOPER" && echo true || echo false)"
# Cross-family review #16: the whole-file pins above are ARRAY-SATISFIABLE —
# the scoper's full_suite fallback carries its own INLINE ignore list on the
# exec line, and a pattern dropped from the exec line ONLY (array intact)
# left the guard green while the fail-closed fallback ran the full suite
# WITHOUT the exclusion. Pin every pattern on the EXEC line itself.
for base in $NIGHTLY_SUITES; do
  check "scoper full_suite EXEC line ignores $base (array-satisfiable pin closed — review #16)" "true" "$(printf '%s\n' "$SCOPER_JEST_LINE" | grep -qF "/$base.test.ts\$" && echo true || echo false)"
done
check "scoper full_suite EXEC line re-states /node_modules/ (review #16)" "true" "$(printf '%s\n' "$SCOPER_JEST_LINE" | grep -q "'/node_modules/'" && echo true || echo false)"

# ── 4. the scoper is PR-path-only: the full suite runs on every other event ─
# The run block is an if/else on GITHUB_EVENT_NAME: the PR arm calls the
# scoper, the else arm runs the full suite (structure pinned in section 1).
check "ci.yml's else-branch full-suite line carries the shard split" "true" "$(printf '%s\n' "$CI_JEST_LINE" | grep -q -- '--shard=' && echo true || echo false)"
if grep -q 'bash scripts/ci-scope-pr.sh' "$CI" && grep -q 'npx jest --maxWorkers=2 --testPathIgnorePatterns' "$CI"; then
  ok "ci.yml keeps both paths: scoped wrapper (PR) + full suite (else)"
else
  bad "ci.yml must keep both paths: the scoper on the PR arm AND the full suite on the else arm"
fi

# ── 5. the nightly workflow keeps its schedule + alerting + kill switch ─────
check "nightly: FULL_SUITE_NIGHTLY_DISABLED kill-switch gate" "true" "$(grep -q "vars.FULL_SUITE_NIGHTLY_DISABLED != '1'" "$NIGHTLY" && echo true || echo false)"
check "nightly: scheduled (cron) trigger present" "true" "$(grep -q '^    - cron:' "$NIGHTLY" && echo true || echo false)"
check "nightly: workflow_dispatch escape hatch present" "true" "$(grep -q '^  workflow_dispatch' "$NIGHTLY" && echo true || echo false)"
check "nightly: job timeout bounded" "true" "$(grep -q 'timeout-minutes: 40' "$NIGHTLY" && echo true || echo false)"
check "nightly: concurrency group (never cancels a running night job)" "true" "$(grep -q 'group: nightly-full-suite' "$NIGHTLY" && echo true || echo false)"
contains "$NIGHTLY" 'bash scripts/deploy/ci-nightly-failure-file.sh' || bad "nightly: failure-filing step must call ci-nightly-failure-file.sh"
# the nightly runs the full suite (no scoping) with the same ignore list
check "nightly: runs the full suite with the shard split" "1" "$(grep -c -- '--shard=' "$NIGHTLY")"
for base in $NIGHTLY_SUITES; do
  check "nightly: ignores $base (they run in integration-e2e-nightly.yml, not duplicated)" "1" "$(grep -cF "/$base.test.ts\$" "$NIGHTLY")"
done

# ── 6. the failure-filing script exists and is a bash harness itself ────────
FILER="$ROOT/scripts/deploy/ci-nightly-failure-file.sh"
[ -f "$FILER" ] && ok "failure-filing script exists" || bad "missing $FILER"
contains "$FILER" 'gh issue create' || bad "failure-filing script must create an issue on failure"
# PARSE the filer (adversarial review d6f96c89 @83db8828, blocking finding 1:
# an apostrophe inside the :? word made the script unparseable — exit 2 — so
# every red night red-flagged the file-failure job and filed NO issue, while
# the grep-shaped checks above stayed green; only bash -n catches this class).
bash -n "$FILER" 2>/dev/null && ok "failure-filing script parses (bash -n)" || bad "failure-filing script does NOT parse (bash -n) — the file-failure job would fail without filing"

# The same class can hide in ANY deploy script the CI shell-scripts job runs
# via `bash "$t"` (ci.yml globs scripts/deploy/*.test.sh but ALSO sources the
# helpers those tests call — ci-scope-pr.sh, ci-nightly-failure-file.sh —
# and a broken non-.test.sh helper breaks its callers at runtime, not at
# grep time). Sweep ALL shell scripts the repo ships under scripts/ and
# backend/scripts/: a parse failure anywhere is a fail here.
for f in "$ROOT"/scripts/deploy/*.sh "$ROOT"/backend/scripts/*.sh; do
  [ -e "$f" ] || continue
  bash -n "$f" 2>/dev/null || bad "deploy script does NOT parse (bash -n): ${f#"$ROOT"/}"
done
ok "bash -n sweep of scripts/deploy/*.sh + backend/scripts/*.sh ran (any parse failure is listed above)"

# ── 7. BEHAVIORAL rename pin (adversarial review B1) ────────────────────────
# A scratch git repo where backend/src/foo.ts is renamed to bar.ts. With
# --no-renames the diff lists BOTH sides; the old side (backend/src/foo.ts)
# no longer exists in the checkout, so the scoper MUST fail closed to the
# FULL suite. Without --no-renames, rename detection lists only the NEW
# path, the run goes green-scoped, and a test that reaches the old module
# via a RUNTIME STRING (jest.requireActual('./foo') — invisible to tsc)
# rides that green while the full suite fails — the exact hole B1 proved.
# The stub npx captures the exec'd argv: full-suite shape, NOT scoped.
REN="$(mktemp -d "${TMPDIR:-/tmp}/ci-scope-b1.XXXXXX")" || { bad "could not mktemp for the rename probe"; REN=""; }
if [ -n "$REN" ]; then
  (
    set -eu
    cd "$REN"
    git init -q .
    git config user.email t@t.invalid
    git config user.name t
    mkdir -p backend/src stub
    printf 'export const foo = 1;\n' > backend/src/foo.ts
    git add -A
    git commit -qm base
    BASE="$(git rev-parse HEAD)"
    git mv backend/src/foo.ts backend/src/bar.ts
    git commit -qm rename
    cat > stub/npx <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$PROBE_OUT"
exit 0
STUB
    chmod +x stub/npx
    export PROBE_OUT="$REN/npx.argv"
    OUT="$(CI_SCOPE_BASE_SHA="$BASE" PATH="$REN/stub:$PATH" \
      bash "$ROOT/backend/scripts/ci-scope-pr.sh" 2>&1 || true)"
    case "$OUT" in
      *"CI_SCOPE_FULL: changed file missing from the checkout (deleted): backend/src/foo.ts"*) : ;;
      *) echo "rename probe scoper output: $OUT" >&2; exit 9 ;;
    esac
    grep -q -- '--findRelatedTests' "$PROBE_OUT" && exit 10  # must NOT run scoped
    grep -q -- '--shard=' "$PROBE_OUT" || exit 11            # full-suite shard shape
    grep -q -- '--testPathIgnorePatterns' "$PROBE_OUT" || exit 12
  )
  RC=$?
  if [ "$RC" -eq 0 ]; then
    ok "rename probe (B1): old side listed → scoper fail-closed to the FULL suite (behavioral, stubbed npx)"
  else
    bad "rename probe (B1): scoper did NOT fail closed on a rename (rc=$RC — details on stderr above)"
  fi
  rm -rf "$REN"
fi

# ── 8. BEHAVIORAL probes: cross-family review #1 (jest error → full suite) ──
# A scratch git repo with ONE changed backend source file; the stub npx
# FAILS (exit 7, no jest output at all — the CLI/findRelatedTests error
# class). The scoper MUST fall back to the full suite: full-suite argv shape
# in the probe + the CI_SCOPE_FULL reason line. exec'ing away (the pre-fix
# behavior) or red-and-stop both fail this probe.
JERR="$(mktemp -d "${TMPDIR:-/tmp}/ci-scope-jerr.XXXXXX")" || { bad "could not mktemp for the jest-error probe"; JERR=""; }
if [ -n "$JERR" ]; then
  (
    set -eu
    cd "$JERR"
    git init -q .
    git config user.email t@t.invalid
    git config user.name t
    mkdir -p backend/src stub
    printf 'export const foo = 1;\n' > backend/src/foo.ts
    git add -A
    git commit -qm base
    BASE="$(git rev-parse HEAD)"
    printf 'export const foo = 2;\n' > backend/src/foo.ts
    git add -A
    git commit -qm change
    cat > stub/npx <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$PROBE_OUT"
exit 7
STUB
    chmod +x stub/npx
    export PROBE_OUT="$JERR/npx.argv"
    OUT="$(CI_SCOPE_BASE_SHA="$BASE" PATH="$JERR/stub:$PATH" \
      bash "$ROOT/backend/scripts/ci-scope-pr.sh" 2>&1 || true)"
    case "$OUT" in
      *"CI_SCOPE_FULL: jest exited non-zero on the scoped run"*) : ;;
      *) echo "jest-error probe scoper output: $OUT" >&2; exit 9 ;;
    esac
    grep -q -- '--findRelatedTests' "$PROBE_OUT" && exit 10  # must NOT stop at the scoped attempt
    grep -q -- '--shard=' "$PROBE_OUT" || exit 11            # full-suite shard shape ran
    grep -q -- '--testPathIgnorePatterns' "$PROBE_OUT" || exit 12
  )
  RC=$?
  if [ "$RC" -eq 0 ]; then
    ok "jest-error probe (review #1): scoped run exits non-zero → scoper falls back to the FULL suite (behavioral, stubbed npx)"
  else
    bad "jest-error probe (review #1): scoper did NOT fall back to the full suite on a jest error (rc=$RC — details on stderr above)"
  fi
  rm -rf "$JERR"
fi

# ── 9. BEHAVIORAL probe: cross-family review #4 (git-quoted path → full) ────
# A scratch repo where a TAB-named backend source file changed. git C-quotes
# control-character paths even under core.quotePath=false, so the diff line
# arrives as "backend/src/tab\tname.ts" — the scoper must treat ANY
# leading-quote path as a scoping failure and run the FULL suite (the
# pre-fix behavior silently NEUTRAL-dropped it).
QPATH="$(mktemp -d "${TMPDIR:-/tmp}/ci-scope-qpath.XXXXXX")" || { bad "could not mktemp for the quoted-path probe"; QPATH=""; }
if [ -n "$QPATH" ]; then
  (
    set -eu
    cd "$QPATH"
    git init -q .
    git config user.email t@t.invalid
    git config user.name t
    mkdir -p backend/src stub
    printf 'export const foo = 1;\n' > backend/src/foo.ts
    printf 'export const tab = 1;\n' > $'backend/src/tab\tname.ts'
    git add -A
    git commit -qm base
    BASE="$(git rev-parse HEAD)"
    printf 'export const tab = 2;\n' > $'backend/src/tab\tname.ts'
    git add -A
    git commit -qm change
    cat > stub/npx <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$PROBE_OUT"
exit 0
STUB
    chmod +x stub/npx
    export PROBE_OUT="$QPATH/npx.argv"
    OUT="$(CI_SCOPE_BASE_SHA="$BASE" PATH="$QPATH/stub:$PATH" \
      bash "$ROOT/backend/scripts/ci-scope-pr.sh" 2>&1 || true)"
    case "$OUT" in
      *"CI_SCOPE_FULL: git-quoted (control-character) path in the change set"*) : ;;
      *) echo "quoted-path probe scoper output: $OUT" >&2; exit 9 ;;
    esac
    grep -q -- '--findRelatedTests' "$PROBE_OUT" && exit 10  # must NOT run scoped
    grep -q -- '--shard=' "$PROBE_OUT" || exit 11            # full-suite shard shape
    grep -q -- '--testPathIgnorePatterns' "$PROBE_OUT" || exit 12
  )
  RC=$?
  if [ "$RC" -eq 0 ]; then
    ok "quoted-path probe (review #4): control-character path → scoper fail-closed to the FULL suite (behavioral, stubbed npx)"
  else
    bad "quoted-path probe (review #4): scoper did NOT fail closed on a git-quoted path (rc=$RC — details on stderr above)"
  fi
  rm -rf "$QPATH"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "CI scoping invariants OK"
else
  echo "$failures invariant(s) violated" >&2
  exit 1
fi

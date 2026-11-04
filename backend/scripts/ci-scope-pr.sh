#!/usr/bin/env bash
# ci-scope-pr.sh — PR test scoping for ci.yml's backend shard matrix
# (feedback ticket d6f96c89, owner directive 2026-10-16 msg 0cd83ba8:
# "CI scoping: on PRs run related-only tests (--findRelatedTests) in
# parallel shards; run the FULL suite nightly on a schedule, not every PR.
# Keep typecheck+lint as the fast gate.")
#
# Runs INSIDE the CI runner (called by .github/workflows/ci.yml's backend
# job, from the backend/ working-directory) on pull_request events ONLY.
# Every push / workflow_call (deploy) / workflow_dispatch run executes the
# FULL 4-shard suite and never calls this script — deploys must never ride
# a scoped guess.
#
# WHAT IT DOES
#   1. Reads the changed-file set: `git diff --no-renames --name-only
#      <base>..HEAD` where <base> = the PR's BASE sha from the event payload
#      (github.event.pull_request.base.sha), fetched at depth 1 by the
#      workflow. The merge-ref checkout means HEAD is the PR AS MERGED —
#      a base that has since moved on main still yields a SUPERSET of the
#      PR's own changes (safe direction: more files → more tests).
#      --no-renames (adversarial review B1): a rename must list BOTH sides;
#      the deleted old side then trips the missing-file arm → full suite.
#   2. Classifies every changed file:
#        - FORCE_FULL surfaces (.github/workflows/, backend/prisma/,
#          backend/jest.config.js, backend/jest.global-setup.js,
#          backend/tsconfig.json, backend/package*.json, this script)
#          can change what EVERY test sees → full suite (mirror of
#          verify-scoped.ts FORCE_FULL_PREFIXES);
#        - backend/(src|scripts) source files that EXIST in the checkout
#          → scoped input. Existence is checked file-by-file because jest
#          --findRelatedTests SILENTLY DROPS nonexistent paths and still
#          exits 0 (verified on jest 29.7.0: a deleted source file or a
#          bad path yields "No tests found, exiting with code 0") — jest
#          cannot tell a scoped-empty run from a broken input, so the
#          scoper must;
#        - any OTHER backend file (outside src|scripts) → full suite
#          (fail closed: not a shape the scoper reasons about);
#        - files outside backend/ that are not force-full (docs, frontend)
#          → NEUTRAL for scoping: they are outside jest's import graph
#          (cross-tree contract reads via __dirname escapes DO exist —
#          ~22 test files, e.g. wall-of-text.test.ts reads
#          frontend/lib/wall-of-text.ts — and are backstopped by the
#          push-path full suite + the nightly, NOT by PR scoping; review
#          N2 ruling: do not force-full them, mixed PRs are the common
#          shape and frontend/** is a huge surface).
#   3. Runs `jest --findRelatedTests <files> --passWithNoTests
#      --testPathIgnorePatterns … --shard=k/4` — the SAME ignore list as
#      the full-suite run (the 4 nightly-only integration/e2e suites stay
#      OUT of per-PR runs — T3h classification preserved) and the SAME
#      4-way shard matrix, so the run log keeps the shard split and the
#      "Backend tests" job-name contract that strand-probe/watchdog
#      fixtures grep for.
#
# FAIL CLOSED — every scoping failure runs the FULL suite, never green on
# an unscoped guess (rule evidence.scoped-verify):
#   - not a pull_request event                      → full suite
#   - scoping kill switch (CI_SCOPED_TESTS_DISABLED) → full suite
#   - base sha missing / unfetchable / diff fails   → full suite
#   - a force-full surface changed                  → full suite
#   - no backend source file changed                → full suite
#   - any backend changed path does not exist       → full suite
#   - MORE_THAN full-threshold changed source files → full suite
#     (a huge diff is not a focused change; the threshold sits above the
#     point where the related set approaches the full suite anyway —
#     measured 2026-10-18: one widely-imported util expands to 1024 of
#     1223 suites)
# A full-suite fallback prints `CI_SCOPE_FULL: <reason>` to the log and
# runs the EXACT full-suite command the push path uses.
#
# Empty shards: `--passWithNoTests` makes a shard with zero related files
# exit 0 (verified on jest 29.7.0). The four shards' UNION is the whole
# related set, so a passing matrix means every related test ran.
#
# Invoked from the backend job's working-directory (backend/); resolves
# the repo root itself (git diff prints repo-ROOT-relative paths, so every
# path check happens at the root) and drops back into backend/ for the
# jest invocation (where node_modules lives).
#
# Tested by scripts/deploy/ci-scoping.test.sh (CI shell-scripts job) and
# pinned by backend/src/scripts/verify-scoped.test.ts.
set -u

# Fail-closed knobs (exported by the workflow or the harness).
BASE_SHA="${CI_SCOPE_BASE_SHA:-}"                    # PR base sha (event payload)
SCOPED_DISABLED="${CI_SCOPED_TESTS_DISABLED:-}"      # kill switch: any value = full suite
CHANGED_MAX="${CI_SCOPE_CHANGED_MAX:-120}"           # > this many changed files = full suite

# Resolve the repo root and go there — see the header note.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || ROOT=""
[ -n "$ROOT" ] && cd "$ROOT" || { echo "CI_SCOPE_FULL: cannot resolve the repo root — running the full 4-shard suite from backend/"; cd backend 2>/dev/null || true; }

# The nightly-only integration/e2e suites — IDENTICAL to the full-suite
# --testPathIgnorePatterns in ci.yml (pinned there by
# scripts/deploy/integration-e2e-suites.test.sh and here by
# scripts/deploy/ci-scoping.test.sh).
IGNORE_PATTERNS=('/node_modules/' '/src/relay/relay.integration.test.ts$' '/src/modules/crossmodel/cohesive.e2e.test.ts$' '/src/modules/crossmodel/integrations/moonshot.integration.test.ts$' '/src/modules/crossmodel/platform/fleet-supervisor.e2e.test.ts$')

full_suite() {  # $1 = reason
  echo "CI_SCOPE_FULL: $1 — running the full 4-shard suite"
  # ROOT-anchored (cross-family review #1): full_suite is also called AFTER
  # the scoped run has cd'd into backend/ — a bare `cd backend` would fail
  # there and exit 1 WITHOUT running the fallback. $ROOT is resolved once at
  # the top and never unset; the empty-ROOT arm keeps the original behavior.
  if [ -n "$ROOT" ]; then cd "$ROOT/backend" || exit 1; else cd backend || exit 1; fi
  exec npx jest --maxWorkers=2 --testPathIgnorePatterns '/node_modules/' '/src/relay/relay.integration.test.ts$' '/src/modules/crossmodel/cohesive.e2e.test.ts$' '/src/modules/crossmodel/integrations/moonshot.integration.test.ts$' '/src/modules/crossmodel/platform/fleet-supervisor.e2e.test.ts$' --shard="${SHARD_INDEX:-1}/${SHARD_TOTAL:-4}"
}

# ── 1. kill switch ──────────────────────────────────────────────────────────
[ -n "$SCOPED_DISABLED" ] && full_suite "kill switch CI_SCOPED_TESTS_DISABLED set"

# ── 2. changed-file set (the WHOLE tree, not just backend/) ────────────────
[ -z "$BASE_SHA" ] && full_suite "CI_SCOPE_BASE_SHA missing (not a pull_request event or payload unreadable)"
if ! BASE_SHA_RESOLVED="$(git rev-parse --verify -q "$BASE_SHA^{commit}")"; then
  full_suite "base sha $BASE_SHA not resolvable in the checkout (fetch failed or sha unreachable)"
fi
# --no-renames + core.quotePath=false (adversarial review B1 @6b5313a5): a
# rename MUST surface as BOTH sides (D old + A new) — with rename detection
# ON, --name-only lists only the NEW path, so the OLD path's importers are
# invisible to the existence check and a test that reaches the old module
# via a RUNTIME STRING (jest.requireActual('./foo'), jest.mock — invisible
# to tsc) rides a green scoped run while the full suite goes red. With
# --no-renames the deleted old side hits the missing-file arm → FULL suite
# (same law as verify-scoped.ts:129). core.quotePath=false keeps non-ASCII
# paths UNQUOTED: a quoted "na\303\257ve.ts" fails SOURCE_RE and would be
# silently NEUTRAL-skipped instead of fail-closed.
if ! CHANGED_ALL="$(git -c core.quotePath=false diff --no-renames --name-only "$BASE_SHA_RESOLVED"..HEAD 2>/dev/null)"; then
  full_suite "git diff against the base sha failed"
fi
[ -z "$CHANGED_ALL" ] && full_suite "empty change set (docs-only or non-code PR)"

# ── 3. classification ───────────────────────────────────────────────────────
# A change on any of these surfaces can alter what EVERY backend test sees
# (or the scoping itself) — the scoped path never applies.
FORCE_FULL_RE='^(\.github/workflows/|backend/prisma/|backend/jest\.config\.js|backend/jest\.global-setup\.js|backend/eslint\.config\.js|backend/tsconfig\.json|backend/package(-lock)?\.json|backend/scripts/ci-scope-pr\.sh)'
SOURCE_RE='^backend/(src|scripts)/.*\.[cm]?[jt]sx?$'

FILES=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if printf '%s' "$f" | grep -Eq "$FORCE_FULL_RE"; then
    full_suite "force-full surface changed: $f"
  fi
  # Cross-family review #4: core.quotePath=false only unquotes HIGH bytes —
  # git still C-quotes paths containing control characters
  # ("backend/src/tab\tname.ts"), and a quoted path fails SOURCE_RE, so it
  # would fall to the NEUTRAL arm and be silently dropped from the scoped
  # set. Any quoted path is a shape the scoper does not reason about →
  # fail closed to the full suite.
  case "$f" in
    '"'*) full_suite "git-quoted (control-character) path in the change set: $f" ;;
  esac
  case "$f" in
    backend/*) ;;
    *) continue ;;   # outside backend/ and not force-full → neutral (docs, frontend, …)
  esac
  if ! printf '%s' "$f" | grep -Eq "$SOURCE_RE"; then
    full_suite "changed backend file outside src|scripts source scope: $f"
  fi
  # Existence check file-by-file (repo-root-relative, like git's output):
  # jest silently drops missing paths and still exits 0.
  if [ ! -f "$f" ]; then
    full_suite "changed file missing from the checkout (deleted): $f"
  fi
  FILES+=("$f")
done <<EOF
$CHANGED_ALL
EOF

[ "${#FILES[@]}" -eq 0 ] && full_suite "no backend source file in the change set"
[ "${#FILES[@]}" -gt "$CHANGED_MAX" ] && full_suite "${#FILES[@]} changed source files > threshold $CHANGED_MAX (not a focused change)"

# ── 4. scoped run ───────────────────────────────────────────────────────────
# Quoted ARRAY expansion end-to-end: no word-splitting, no pathname globbing
# — a path containing whitespace or glob characters stays ONE argument (an
# unquoted list would split it into wrong inputs, which jest SILENTLY DROPS
# while exiting 0 — the exact silent-under-coverage hole fail-closed exists
# to prevent).
echo "CI_SCOPE_PR: ${#FILES[@]} changed backend source file(s) — related-only tests, shard ${SHARD_INDEX:-1}/${SHARD_TOTAL:-4}"
echo "CI_SCOPE_PR: files: $(printf '%s ' "${FILES[@]}")"
# Cross-family review #2: echo the exec'd command so the run log shows the
# literal --findRelatedTests + shard split (the acceptance evidence) — an
# exec'd argv is otherwise invisible to the log reader.
echo "CI_SCOPE_PR: npx jest --maxWorkers=2 --findRelatedTests <${#FILES[@]} file(s)> --passWithNoTests --testPathIgnorePatterns <nightly-only ignores> --shard=${SHARD_INDEX:-1}/${SHARD_TOTAL:-4}"
REL_FILES=()
for f in "${FILES[@]}"; do REL_FILES+=("${f#backend/}"); done
cd backend || exit 1
# Cross-family review #1 (spec (d) + acceptance 3): a scoped-run FAILURE must
# fall back to the FULL suite — never red-and-stop, never green-and-stop.
# --passWithNoTests makes a "No tests found" run exit 0, so jest exit codes
# alone cannot split "scoped red" (run the fallback) from "broken scoping
# input" (also run the fallback — a scoping failure). Two discriminators:
#   (a) jest's own exit code — read via PIPESTATUS[0]: a bare
#       `if ! npx jest | tee` would test TEE's status (always 0) and turn a
#       RED scoped run green (fail-open — the exact hole this closes);
#   (b) jest's "Test Suites:" summary line: every healthy scoped run —
#       including one whose related set is EMPTY in this shard
#       (--passWithNoTests) — prints
#         "Test Suites: N skipped, M passed|failed, K total"  (K >= 1).
#       A run with NO test summary (jest CLI error, a --findRelatedTests
#       error, an unparseable input path, …) never executed a test set we
#       can reason about = a scoping failure → the full suite.
TESTS_SUMMARY_FILE="$(mktemp "${TMPDIR:-/tmp}/ci-scope-summary.XXXXXX")" || full_suite "cannot create a summary temp file for the scoped run"
npx jest --maxWorkers=2 --findRelatedTests "${REL_FILES[@]}" --passWithNoTests --testPathIgnorePatterns "${IGNORE_PATTERNS[@]}" --shard="${SHARD_INDEX:-1}/${SHARD_TOTAL:-4}" 2>&1 | tee "$TESTS_SUMMARY_FILE"
JEST_RC="${PIPESTATUS[0]}"
if [ "$JEST_RC" -ne 0 ]; then
  full_suite "jest exited non-zero on the scoped run (rc=$JEST_RC — never green on an unscoped guess)"
else
  grep -Eq '^Test Suites: [0-9]+ (skipped, )?[0-9]+ (passed|failed), [0-9]+ total' "$TESTS_SUMMARY_FILE" \
    || full_suite "no Jest Test Suites summary on the scoped run (findRelatedTests/scoping error — never green on an unscoped guess)"
fi
exit 0

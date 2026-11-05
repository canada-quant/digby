#!/usr/bin/env bash
# integration-e2e-suites.test.sh — T3h drift guard (batch-train, 2026-10-17).
#
# The 4 integration/e2e suites (the repo's ENTIRE *.integration.test.ts /
# *.e2e.test.ts population under backend/) moved OUT of ci.yml's per-PR jest
# run into the nightly workflow integration-e2e-nightly.yml. Their unit
# siblings stay per-PR as the smoke subset.
#
# This guard fails CI when either side drifts:
#   1. a NEW *.integration.test.ts / *.e2e.test.ts file appears under
#      backend/src that is in NEITHER ci.yml's --testPathIgnorePatterns NOR
#      the nightly workflow's jest run list — a new suite must be
#      consciously classified per-PR vs nightly, never silently dropped;
#   2. ci.yml's ignore list and the nightly workflow's run list DISAGREE
#      (a suite ignored per-PR but not run nightly = lost coverage; a suite
#      run nightly but still per-PR = the exclusion is pointless);
#   3. the per-PR smoke subset disappears (relay-core.test.ts +
#      moonshot.k3-contract.test.ts must keep running in ci.yml);
#   4. the nightly workflow loses its kill switch gate or its schedule.
#
# Pure text/structure checks — no AWS, no docker, no node needed.
# Run from anywhere: bash scripts/deploy/integration-e2e-suites.test.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI="$ROOT/.github/workflows/ci.yml"
NIGHTLY="$ROOT/.github/workflows/integration-e2e-nightly.yml"

failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

[ -f "$CI" ] || { bad "missing $CI"; echo "$failures invariant(s) violated" >&2; exit 1; }
[ -f "$NIGHTLY" ] || { bad "missing $NIGHTLY (the nightly workflow must exist)"; echo "$failures invariant(s) violated" >&2; exit 1; }

# The classified nightly set — the 4 suites by name (T3h, 2026-10-17).
NIGHTLY_SUITES="relay.integration cohesive.e2e moonshot.integration fleet-supervisor.e2e"
SMOKE_SUITES="relay-core moonshot.k3-contract"

# 1. every *.integration/*.e2e test file under backend/src is classified
for f in $(cd "$ROOT" && find backend/src -name '*.integration.test.ts' -o -name '*.e2e.test.ts' | sort); do
  base="$(basename "$f" .test.ts)"
  case " $NIGHTLY_SUITES " in
    *" $base "*) ok "classified nightly: $base ($f)" ;;
    *) bad "UNCLASSIFIED integration/e2e suite: $f — add it to ci.yml's --testPathIgnorePatterns AND integration-e2e-nightly.yml's jest run list (or rename it if it is per-PR smoke)" ;;
  esac
done

# the reverse: every suite in the nightly list exists on disk
for base in $NIGHTLY_SUITES; do
  found="$(find "$ROOT/backend/src" -name "$base.test.ts" | head -1)"
  [ -n "$found" ] && ok "nightly suite exists on disk: $base" || bad "nightly suite MISSING on disk: $base.test.ts"
done

# 2. ci.yml's ignore list == the nightly run list == the classified set
# CI scoping (d6f96c89): the full-suite jest line now lives inside the
# backend job's if/else (scoped wrapper on pull_request, full suite
# otherwise) — it is indented and carries no `run: ` prefix, so the grep
# matches the jest invocation itself, not the step line.
CI_JEST_LINE="$(grep -n -- 'npx jest --maxWorkers=2 --testPathIgnorePatterns' "$CI" | head -1)"
check "ci.yml has exactly one jest run carrying --testPathIgnorePatterns" "1" "$(grep -c -- 'npx jest --maxWorkers=2 --testPathIgnorePatterns' "$CI")"
for base in $NIGHTLY_SUITES; do
  check "ci.yml ignores $base (it runs nightly, not per-PR)" "1" "$(printf '%s\n' "$CI_JEST_LINE" | grep -cF "/$base.test.ts\$")"
done
NIGHTLY_JEST_STEP="$(sed -n '/Run the 4 integration\/e2e suites (jest)/,/run: npx jest --runInBand/p' "$NIGHTLY" | grep 'run: npx jest' | head -1)"
[ -n "$NIGHTLY_JEST_STEP" ] && ok "nightly workflow runs the suites via jest" || bad "nightly workflow's jest step is missing"
for base in $NIGHTLY_SUITES; do
  check "nightly workflow runs $base" "1" "$(printf '%s\n' "$NIGHTLY_JEST_STEP" | grep -c "$base.test.ts")"
done
# node_modules must be re-stated in the ignore list (the flag replaces the default)
check "ci.yml re-states /node_modules/ in the ignore list (the flag replaces jest's default)" "1" "$(printf '%s\n' "$CI_JEST_LINE" | grep -c '/node_modules/')"

# 3. the per-PR smoke subset stays in ci.yml (they run per-PR — NOT in the ignore list)
for base in $SMOKE_SUITES; do
  check "smoke sibling $base is NOT ignored in ci.yml (stays per-PR)" "0" "$(printf '%s\n' "$CI_JEST_LINE" | grep -c "$base")"
  found="$(find "$ROOT/backend/src" -name "$base.test.ts" | head -1)"
  [ -n "$found" ] && ok "smoke sibling exists on disk: $base" || bad "smoke sibling MISSING on disk: $base.test.ts (the per-PR smoke subset is load-bearing)"
done

# 4. the nightly workflow keeps its kill switch + schedule + timeout
check "nightly: INTEGRATION_E2E_NIGHTLY_DISABLED kill-switch gate" "1" "$(grep -c "vars.INTEGRATION_E2E_NIGHTLY_DISABLED != '1'" "$NIGHTLY")"
check "nightly: scheduled (cron) trigger present" "1" "$(grep -c '^    - cron:' "$NIGHTLY")"
check "nightly: workflow_dispatch escape hatch present" "1" "$(grep -c '^  workflow_dispatch' "$NIGHTLY")"
check "nightly: job timeout bounded" "1" "$(grep -c 'timeout-minutes: 20' "$NIGHTLY")"
check "nightly: concurrency group (never cancels a running night job)" "1" "$(grep -c 'group: integration-e2e-nightly' "$NIGHTLY")"

echo
if [ "$failures" -eq 0 ]; then
  echo "integration/e2e suites classification OK"
else
  echo "$failures invariant(s) violated" >&2
  exit 1
fi

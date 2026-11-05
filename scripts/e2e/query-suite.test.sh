#!/usr/bin/env bash
# CI harness for scripts/e2e/query-suite.py — runs its OFFLINE self-test (the evaluator on
# synthetic runs, deterministic seeded sampling, the safe-tool catalog, the pacer, the report)
# plus --list / --dry-run. Never touches the network; the live suite is run by hand.
set -euo pipefail
cd "$(dirname "$0")"
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' query-suite.py  # syntax check without writing __pycache__
python3 query-suite.py --self-test
python3 query-suite.py --list >/dev/null
out=$(python3 query-suite.py --dry-run --n 12 --seed 5)
echo "$out" | head -1 | grep -q '^profile test · seed 5 · 12 cases' || { echo "dry-run header wrong: $(echo "$out" | head -1)"; exit 1; }
[ "$(python3 query-suite.py --dry-run --n 12 --seed 5)" = "$out" ] || { echo 'dry-run not deterministic for a seed'; exit 1; }
if DIGBY_E2E_EMAIL= DIGBY_E2E_PASSWORD= python3 query-suite.py --n 1 >/dev/null 2>&1; then echo 'live run without credentials must exit non-zero'; exit 1; fi
# the owner profile is read-only integrations, refuses anything else, and needs its own env names
if python3 query-suite.py --dry-run --profile owner --categories memory --n 1 >/dev/null 2>&1; then echo 'owner profile must refuse non-integration categories'; exit 1; fi
python3 query-suite.py --dry-run --profile owner --n 6 --seed 5 | tail -n +2 | grep -qv -- '-integrations-' && { echo 'owner profile sampled a non-integration case'; exit 1; }
if DIGBY_E2E_OWNER_EMAIL= DIGBY_E2E_OWNER_PASSWORD= python3 query-suite.py --profile owner --n 1 >/dev/null 2>&1; then echo 'owner live run without credentials must exit non-zero'; exit 1; fi
echo 'query-suite.test.sh: ok'

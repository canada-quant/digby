#!/usr/bin/env bash
# CI harness for scripts/e2e/model-bench.py (offline lead-model benchmark, 2026-10-04) — runs its OFFLINE self-test
# (title format, stratified no-noise sampling, the rotated interleaved plan, forced / diverted / failover attribution,
# the summary + report, the account guard; 2026-10-20 the task-kind twins of platform/task-kind.ts, the `k:<kind>`
# title token, the kind question set, --kinds / --per-kind) plus --dry-run and the usage refusals. Never touches the
# network; the live bench is run by hand (runbook docs/MODEL_BENCH.md).
set -euo pipefail
cd "$(dirname "$0")"
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' model-bench.py  # syntax check without writing __pycache__
python3 model-bench.py --self-test
out=$(python3 model-bench.py --dry-run --models glm-5.3,deepseek-flash --n 6 --seed 5 --run-id mbtest)
echo "$out" | head -1 | grep -q '^model-bench run mbtest · seed 5 · 6 questions × 2 models = 12 chats' || { echo "dry-run header wrong: $(echo "$out" | head -1)"; exit 1; }
[ "$(echo "$out" | tail -n +2 | wc -l)" -eq 6 ] || { echo 'dry-run must list one line per question'; exit 1; }
# 2026-10-20 review: only a KIND run (--kinds / --per-kind) titles its chats `… k:<kind>` — a default run's plan lines
# (which mirror the titles) carry no token, byte-identical to the pre-kind bench
if echo "$out" | tail -n +2 | grep -q '\] k:'; then echo "a default run must write plain titles (no k:<kind> token): $out"; exit 1; fi
[ "$(python3 model-bench.py --dry-run --models glm-5.3,deepseek-flash --n 6 --seed 5 --run-id mbtest)" = "$out" ] || { echo 'dry-run not deterministic for a seed'; exit 1; }
if python3 model-bench.py --dry-run --n 2 >/dev/null 2>&1; then echo '--models is required'; exit 1; fi
if python3 model-bench.py --dry-run --models glm-5.3 --run-id 'bad id' >/dev/null 2>&1; then echo 'a run id with a space must be refused'; exit 1; fi
if python3 model-bench.py --dry-run --models glm-5.3 --groups nosuchgroup >/dev/null 2>&1; then echo 'an unknown group must be refused'; exit 1; fi
# roster 2026-10-06 C-2: the TOOL-USING question set and --lanes (question families aimed at a lane)
tools=$(python3 model-bench.py --dry-run --models glm-5.3,deepseek-flash --n 4 --seed 5 --run-id mbtest --question-set tools)
echo "$tools" | head -1 | grep -q '^model-bench run mbtest · seed 5 · question set tools · 4 questions × 2 models' || { echo "tools dry-run header wrong: $(echo "$tools" | head -1)"; exit 1; }
if echo "$tools" | tail -n +2 | grep -q '\] k:'; then echo 'a --question-set tools run must write plain titles'; exit 1; fi
[ "$(echo "$tools" | tail -n +2 | grep -c '\[tools')" -eq 4 ] || { echo '--question-set tools must draw only the tool set'; exit 1; }
lanes=$(python3 model-bench.py --dry-run --models glm-5.3 --n 3 --seed 5 --run-id mbtest --lanes checked)
echo "$lanes" | head -1 | grep -q 'groups advice,compare,complex,health,math,money,opinion' || { echo "--lanes checked must restrict the groups: $(echo "$lanes" | head -1)"; exit 1; }
if echo "$lanes" | tail -n +2 | grep -q '\] k:'; then echo 'a --lanes run must write plain titles'; exit 1; fi
groups=$(python3 model-bench.py --dry-run --models glm-5.3 --n 4 --seed 5 --run-id mbtest --groups health,money)
[ "$(echo "$groups" | tail -n +2 | wc -l)" -eq 4 ] && ! echo "$groups" | tail -n +2 | grep -q '\] k:' || { echo "a --groups run must write plain titles: $groups"; exit 1; }
if python3 model-bench.py --dry-run --models glm-5.3 --lanes research >/dev/null 2>&1; then echo 'an unknown lane must be refused'; exit 1; fi
if python3 model-bench.py --dry-run --models glm-5.3 --question-set bogus >/dev/null 2>&1; then echo 'an unknown question set must be refused'; exit 1; fi
# 2026-10-20 TASK KINDS: --per-kind (K per kind, every kind by default) and --kinds (job families; code allowed)
perk=$(python3 model-bench.py --dry-run --models glm-5.3,deepseek-flash --per-kind 2 --seed 5 --run-id mbtest)
echo "$perk" | head -1 | grep -q '^model-bench run mbtest · seed 5 · question set kinds · kinds writing,code,analysis,lookup,advice,planning,explain · per kind 2 · 14 questions × 2 models = 28 chats' || { echo "per-kind dry-run header wrong: $(echo "$perk" | head -1)"; exit 1; }
[ "$(echo "$perk" | tail -n +2 | wc -l)" -eq 14 ] || { echo '--per-kind 2 over 7 kinds must list 14 questions'; exit 1; }
for k in writing code analysis lookup advice planning explain; do
  [ "$(echo "$perk" | tail -n +2 | grep -c "\] k:$k ")" -eq 2 ] || { echo "--per-kind 2 must give exactly 2 questions of kind $k"; exit 1; }
done
[ "$(python3 model-bench.py --dry-run --models glm-5.3,deepseek-flash --per-kind 2 --seed 5 --run-id mbtest)" = "$perk" ] || { echo 'per-kind dry-run not deterministic for a seed'; exit 1; }
kinds=$(python3 model-bench.py --dry-run --models glm-5.3 --kinds code --n 6 --seed 5 --run-id mbtest)
echo "$kinds" | head -1 | grep -q '^model-bench run mbtest · seed 5 · question set kinds · kinds code · groups code · 6 questions × 1 models' || { echo "--kinds dry-run header wrong: $(echo "$kinds" | head -1)"; exit 1; }
[ "$(echo "$kinds" | tail -n +2 | grep -c '^q[0-9]* \[code · code\] k:code ')" -eq 6 ] || { echo '--kinds code must ask code-flagged code questions only'; exit 1; }
if python3 model-bench.py --dry-run --models glm-5.3 --kinds research >/dev/null 2>&1; then echo 'an unknown kind must be refused'; exit 1; fi
if python3 model-bench.py --dry-run --models glm-5.3 --per-kind 0 >/dev/null 2>&1; then echo '--per-kind 0 must be refused'; exit 1; fi
if python3 model-bench.py --dry-run --models glm-5.3 --per-kind 2 --groups health >/dev/null 2>&1; then echo '--per-kind with --groups must be refused'; exit 1; fi
if python3 model-bench.py --dry-run --models glm-5.3 --per-kind 2 --lanes checked >/dev/null 2>&1; then echo '--per-kind with --lanes must be refused'; exit 1; fi
if DIGBY_E2E_EMAIL= DIGBY_E2E_PASSWORD= python3 model-bench.py --models glm-5.3 --n 1 >/dev/null 2>&1; then echo 'live run without credentials must exit non-zero'; exit 1; fi
# the account guard refuses BEFORE any network call (a login attempt would fail differently)
guard=$(DIGBY_E2E_EMAIL=someone@example.com DIGBY_E2E_PASSWORD=x DIGBY_E2E_BASE=https://digby.ai/api python3 model-bench.py --models glm-5.3 --n 1 2>&1 >/dev/null || true)
echo "$guard" | grep -q 'model-bench runs ONLY as claudebot@digby.ai' || { echo "a prod run as any account but the test account must be refused: $guard"; exit 1; }
if DIGBY_E2E_EMAIL= DIGBY_E2E_PASSWORD= python3 model-bench.py --cleanup-run mbtest >/dev/null 2>&1; then echo 'cleanup without credentials must exit non-zero'; exit 1; fi
echo 'model-bench.test.sh: ok'

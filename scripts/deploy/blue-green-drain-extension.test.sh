#!/usr/bin/env bash
# Regression test — blue-green RETIRING-budget extension (WI-G, 2026-09-25).
#
# The old colour's drain is bounded at DRAIN_MAX_RETIRING_SECONDS (900 s); a
# glm-5.3 reasoning-max supervisor wake runs 8–16 min, so the cut still landed
# ~3×/day. deploy-blue-green.sh may now extend the retiring budget ONCE —
# DEFAULT OFF — when /drain-status says every remaining run is a progressing
# supervisor wake, capped at DRAIN_RETIRING_TOTAL_CAP_SECONDS.
#
# Invariants pinned here (owner-guarded script; the extension must be inert by default):
#   1. bash -n parses the script.
#   2. DRAIN_RETIRING_EXTENSION_SECONDS defaults to 0 (OFF); the cap defaults to 1500.
#   3. DRAIN_MAX_RETIRING_SECONDS + the suggested 600 s extension never exceeds the cap.
#   4. drain_extension_budget (extracted verbatim between its markers) — the pure math:
#      ext 0 → unchanged; not eligible → unchanged; eligible → budget+ext capped;
#      garbage inputs → unchanged; the flag is matched only as "extensionEligible":true.
#   5. The loop guard tests DRAIN_RETIRING and drain_extended, and runs at most once.
#   6. (2026-10-20 — deep research has no wall clock) the RESEARCH-only extension:
#      DRAIN_RESEARCH_EXTENSION_SECONDS defaults to 600 (900 + 600 = the cap); it keys
#      ONLY on "researchExtensionEligible":true (drain_extension_budget's FLAG arg), runs
#      BEFORE the WI-G block, shares its once-per-drain latch, and never matches the
#      supervisor flag (nor the supervisor block the research flag).
#   7. (review 2026-10-20) its documented off switch is reachable through the deploy
#      pipeline: deploy.yml reads the repo Variable DRAIN_RESEARCH_EXTENSION_SECONDS and
#      exports it to the box (an unset Variable exports '' => the 600 s default; 0 => off),
#      and the box printf's %q count still matches its argument count.
#
# Plain-bash idiom, mirrors scripts/deploy/blue-green-health-budget.test.sh.
# Run from anywhere: bash scripts/deploy/blue-green-drain-extension.test.sh

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/deploy-blue-green.sh"

failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

[ -f "$DEPLOY" ] || { bad "missing file: $DEPLOY"; echo "$failures invariant(s) violated" >&2; exit 1; }

# 1. syntax
if bash -n "$DEPLOY" 2>/dev/null; then ok "deploy-blue-green.sh parses (bash -n)"; else bad "deploy-blue-green.sh has a syntax error"; fi

# 2. defaults
EXT_DEFAULT=$(sed -n 's/^DRAIN_RETIRING_EXTENSION_SECONDS=\${DRAIN_RETIRING_EXTENSION_SECONDS:-\([0-9][0-9]*\)}.*/\1/p' "$DEPLOY" | head -1)
CAP_DEFAULT=$(sed -n 's/^DRAIN_RETIRING_TOTAL_CAP_SECONDS=\${DRAIN_RETIRING_TOTAL_CAP_SECONDS:-\([0-9][0-9]*\)}.*/\1/p' "$DEPLOY" | head -1)
RET_DEFAULT=$(sed -n 's/^DRAIN_MAX_RETIRING_SECONDS=\${DRAIN_MAX_RETIRING_SECONDS:-\([0-9][0-9]*\)}.*/\1/p' "$DEPLOY" | head -1)
check "DRAIN_RETIRING_EXTENSION_SECONDS defaults to 0 (extension OFF ⇒ byte-identical drain)" "0" "${EXT_DEFAULT:-missing}"
check "DRAIN_RETIRING_TOTAL_CAP_SECONDS defaults to 1500" "1500" "${CAP_DEFAULT:-missing}"
if [ -n "$RET_DEFAULT" ] && [ -n "$CAP_DEFAULT" ] && [ $((RET_DEFAULT + 600)) -le "$CAP_DEFAULT" ]; then
  ok "retiring budget ${RET_DEFAULT}s + suggested 600s extension ≤ cap ${CAP_DEFAULT}s"
else
  bad "retiring budget '${RET_DEFAULT:-?}' + 600 must stay ≤ cap '${CAP_DEFAULT:-?}'"
fi

# 4. extract the pure function verbatim and exercise it
FN=$(sed -n '/^# >>> drain_extension_budget/,/^# <<< drain_extension_budget/p' "$DEPLOY")
if [ -z "$FN" ] || ! printf '%s\n' "$FN" | grep -q '^drain_extension_budget() {'; then
  bad "could not extract drain_extension_budget between its markers"
  echo "$failures invariant(s) violated" >&2; exit 1
fi
eval "$FN"

ELIGIBLE='{"activeRuns":1,"chatRuns":1,"lateCrossChecks":0,"retiring":true,"runs":[{"runId":"chat:abc","isSupervisorWake":true}],"extensionEligible":true}'
NOT_ELIGIBLE='{"activeRuns":1,"chatRuns":1,"lateCrossChecks":0,"retiring":true,"extensionEligible":false}'
PRE_WIG='{"activeRuns":1,"chatRuns":1,"lateCrossChecks":0,"retiring":true}'

check "ext=0 leaves the budget unchanged even when eligible" "900" "$(drain_extension_budget 900 0 1500 "$ELIGIBLE")"
check "eligible + ext=600 → 900+600 = 1500 (at the cap)" "1500" "$(drain_extension_budget 900 600 1500 "$ELIGIBLE")"
check "eligible + ext=600 under a 1200 cap → 1200" "1200" "$(drain_extension_budget 900 600 1200 "$ELIGIBLE")"
check "eligible + ext=300 → 1200" "1200" "$(drain_extension_budget 900 300 1500 "$ELIGIBLE")"
check "not eligible → unchanged" "900" "$(drain_extension_budget 900 600 1500 "$NOT_ELIGIBLE")"
check "pre-WI-G payload (no flag) → unchanged" "900" "$(drain_extension_budget 900 600 1500 "$PRE_WIG")"
check "empty payload (endpoint unreadable) → unchanged" "900" "$(drain_extension_budget 900 600 1500 "")"
check "non-numeric extension → unchanged" "900" "$(drain_extension_budget 900 abc 1500 "$ELIGIBLE")"
check "cap below the budget never shrinks it" "900" "$(drain_extension_budget 900 600 600 "$ELIGIBLE")"
check "flag must be the literal true (a quoted \"true\" is not)" "900" "$(drain_extension_budget 900 600 1500 '{"extensionEligible":"true"}')"
# 6. the research flag (FLAG arg)
RESEARCH_ELIGIBLE='{"activeRuns":1,"chatRuns":1,"lateCrossChecks":0,"retiring":true,"runs":[{"runId":"chat:r1","isResearchCouncil":true,"researchProgressing":true}],"extensionEligible":false,"researchExtensionEligible":true}'
RESEARCH_STALLED='{"activeRuns":1,"chatRuns":1,"lateCrossChecks":0,"retiring":true,"runs":[{"runId":"chat:r1","isResearchCouncil":true,"researchProgressing":false}],"extensionEligible":false,"researchExtensionEligible":false}'
check "research: eligible + ext=600 → 1500" "1500" "$(drain_extension_budget 900 600 1500 "$RESEARCH_ELIGIBLE" researchExtensionEligible)"
check "research: eligible + ext=900 is still capped at 1500" "1500" "$(drain_extension_budget 900 900 1500 "$RESEARCH_ELIGIBLE" researchExtensionEligible)"
check "research: a STALLED council → unchanged" "900" "$(drain_extension_budget 900 600 1500 "$RESEARCH_STALLED" researchExtensionEligible)"
check "research flag never satisfies the supervisor (default) flag" "900" "$(drain_extension_budget 900 600 1500 "$RESEARCH_ELIGIBLE")"
check "the supervisor flag never satisfies the research flag" "900" "$(drain_extension_budget 900 600 1500 "$ELIGIBLE" researchExtensionEligible)"
check "a non-alphabetic FLAG is refused (unchanged)" "900" "$(drain_extension_budget 900 600 1500 "$RESEARCH_ELIGIBLE" 'research.*')"
RES_DEFAULT=$(sed -n 's/^DRAIN_RESEARCH_EXTENSION_SECONDS=\${DRAIN_RESEARCH_EXTENSION_SECONDS:-\([0-9][0-9]*\)}.*/\1/p' "$DEPLOY" | head -1)
check "DRAIN_RESEARCH_EXTENSION_SECONDS defaults to 600 (research-only, ON)" "600" "${RES_DEFAULT:-missing}"
if [ -n "$RES_DEFAULT" ] && [ -n "$RET_DEFAULT" ] && [ -n "$CAP_DEFAULT" ] && [ $((RET_DEFAULT + RES_DEFAULT)) -le "$CAP_DEFAULT" ]; then
  ok "retiring budget ${RET_DEFAULT}s + research extension ${RES_DEFAULT}s ≤ cap ${CAP_DEFAULT}s"
else
  bad "retiring budget '${RET_DEFAULT:-?}' + research extension '${RES_DEFAULT:-?}' must stay ≤ cap '${CAP_DEFAULT:-?}'"
fi

# 5. the loop guard
GUARD=$(grep -c 'drain_extended" -eq 0 \] && \[ "\$DRAIN_RETIRING" -eq 1 \] && \[ "\${DRAIN_RETIRING_EXTENSION_SECONDS:-0}" -gt 0 \]' "$DEPLOY")
check "the extension block is guarded by drain_extended, DRAIN_RETIRING and a >0 extension (exactly one site)" "1" "$GUARD"
check "each extension block (research + WI-G) marks itself done before extending (one shared once-per-drain latch)" "2" "$(grep -c '^        drain_extended=1$' "$DEPLOY")"
RGUARD=$(grep -c 'drain_extended" -eq 0 \] && \[ "\$DRAIN_RETIRING" -eq 1 \] && \[ "\${DRAIN_RESEARCH_EXTENSION_SECONDS:-0}" -gt 0 \] 2>/dev/null && printf .%s. "\$DRAIN_JSON" | grep -q .\"researchExtensionEligible\":true.; then$' "$DEPLOY")
check "the research block is guarded by drain_extended, DRAIN_RETIRING, a >0 research extension AND the research flag (exactly one site)" "1" "$RGUARD"
check "the research block passes the research FLAG to drain_extension_budget" "1" "$(grep -c '"\$DRAIN_RESEARCH_EXTENSION_SECONDS" "\$DRAIN_RETIRING_TOTAL_CAP_SECONDS" "\$DRAIN_JSON" researchExtensionEligible)$' "$DEPLOY")"
R_LINE=$(grep -n 'DRAIN_RESEARCH_EXTENSION_SECONDS:-0}" -gt 0' "$DEPLOY" | head -1 | cut -d: -f1)
W_LINE=$(grep -n 'DRAIN_RETIRING_EXTENSION_SECONDS:-0}" -gt 0' "$DEPLOY" | head -1 | cut -d: -f1)
if [ -n "$R_LINE" ] && [ -n "$W_LINE" ] && [ "$R_LINE" -lt "$W_LINE" ]; then
  ok "the research block runs before the WI-G block (a supervisor-only drain sees the WI-G block exactly as before)"
else
  bad "the research block must precede the WI-G block (research line ${R_LINE:-?}, WI-G line ${W_LINE:-?})"
fi
check "DRAIN_RETIRING is set only when the retire POST confirmed" "1" "$(grep -c '^    DRAIN_RETIRING=1$' "$DEPLOY")"
check "the loop condition still bounds on DRAIN_BUDGET" "1" "$(grep -c '^while \[ "\$drain_waited" -lt "\$DRAIN_BUDGET" \]; do$' "$DEPLOY")"

# 7. the research extension's off switch rides the deploy pipeline (repo Variable -> box env)
YML="$ROOT/.github/workflows/deploy.yml"
check "deploy.yml reads DRAIN_RESEARCH_EXTENSION_SECONDS from repo Variables" "1" "$(grep -c '^          DRAIN_RESEARCH_EXTENSION_SECONDS: \${{ vars.DRAIN_RESEARCH_EXTENSION_SECONDS }}$' "$YML")"
PF_START=$(grep -n 'export BUILDER_CACHE_KEEP=%q' "$YML" | head -1 | cut -d: -f1)
check "deploy.yml exports DRAIN_RESEARCH_EXTENSION_SECONDS to the box" "1" "$(sed -n "${PF_START:-0}p" "$YML" | grep -c 'export DRAIN_RESEARCH_EXTENSION_SECONDS=%q')"
check "deploy.yml passes \$DRAIN_RESEARCH_EXTENSION_SECONDS as a printf argument" "1" "$(awk -v s="${PF_START:-0}" 'NR > s { if ($0 ~ /\| ssh /) exit; print }' "$YML" | grep -c '"\$DRAIN_RESEARCH_EXTENSION_SECONDS"')"
PF_Q=$(sed -n "${PF_START:-0}p" "$YML" | grep -o '%q' | wc -l | tr -d ' ')
PF_ARGS=$(awk -v s="${PF_START:-0}" 'NR > s { if ($0 ~ /\| ssh /) exit; print }' "$YML" | grep -o '"[^"]*"' | wc -l | tr -d ' ')
check "the box printf's %q count matches its argument count (a forwarded var never shifts the others)" "$PF_Q" "$PF_ARGS"
RES_LINE=$(grep '^DRAIN_RESEARCH_EXTENSION_SECONDS=\${DRAIN_RESEARCH_EXTENSION_SECONDS:-' "$DEPLOY" | head -1)
res_with() { ( unset DRAIN_RESEARCH_EXTENSION_SECONDS; export DRAIN_RESEARCH_EXTENSION_SECONDS="$1"; eval "$RES_LINE"; echo "$DRAIN_RESEARCH_EXTENSION_SECONDS" ); }
check "an unset repo Variable (exported as '') keeps the 600 s default" "600" "$(res_with '')"
check "the repo Variable DRAIN_RESEARCH_EXTENSION_SECONDS=0 turns the research extension off" "0" "$(res_with 0)"

if [ "$failures" -eq 0 ]; then
  echo "blue-green drain-extension invariants OK"
else
  echo "$failures invariant(s) violated" >&2
  exit 1
fi

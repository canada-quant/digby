#!/usr/bin/env bash
# xmcp-ensure-buildfail.43ea65de.test.sh — structural pin for the "Ensure
# x-mcp is running" failure-masking fix (ticket 43ea65de, 2026-09-22).
#
# The bug (pre-fix deploy.yml @ origin/main fa4a98006, lines 413-436): the
# step's remote ssh script had no `set -e`, so a FAILED `docker compose up -d
# --build x-mcp` fell through to the `sleep` + trailing `docker ps --format`
# status listing — and that last command's exit status (always 0) became the
# script's exit status → ssh returned 0 → the step went green with a stale or
# absent x-mcp container while every downstream step gated on `if: success()`.
# `docker compose up -d` can also exit 0 with a container that immediately
# exited, so the post-build RUNNING re-check is the real gate. The outer host
# loop additionally kept no failure accumulator, so an earlier host's ssh
# failure could be dropped by a later host's success. Residual angle (d) of
# the e3cb31c3 adversarial review (chat 99ac096d, msg c27c369b — MERGE-SAFE,
# non-blocking then); fixed here.
#
# This test fails if:
#   - the remote script loses `set -e`,
#   - either rebuild branch (not-running / changed-sources) loses its
#     post-build RUNNING re-verification (re-query + explicit exit 1),
#   - the host loop loses its failure accumulator or final FAILED gate,
#   - the step migrates out from between the "Detect x-mcp changes" gate and
#     the "Record deployed-sha marker" step (would re-break e3cb31c3),
#   - the e3cb31c3 gate-order suite itself stops passing.
# NEGATIVE CONTROL: the pre-fix Ensure-step bytes are embedded verbatim below
# and the same checks are run against them — they MUST fail (a pin that
# cannot detect the bug is worth nothing). Optionally pass a yaml path as $1
# to run the battery against any other deploy.yml copy (e.g. a full pre-fix
# file from `git show origin/main:.github/workflows/deploy.yml`; the test
# then exits 1 on it).
# Pure text structure — no AWS, docker, or root needed.
set -u
cd "$(dirname "$0")"
YML=${1:-../../.github/workflows/deploy.yml}
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

if [ ! -f "$YML" ]; then
  bad "deploy.yml not found at $YML"
  echo "xmcp-ensure-buildfail.43ea65de: $PASS passed, $FAIL failed"
  exit 1
fi

# run_checks — the full battery against whatever $YML points at. Called once
# for the real workflow file and once (in a subshell) for the negative
# control, so its FAIL output is parsed rather than propagated.
run_checks() {
  line_of() { grep -nF -- "$1" "$YML" | head -1 | cut -d: -f1; }
  GATE_LINE=$(line_of '- name: Detect x-mcp changes in this push')
  ENSURE_LINE=$(line_of '- name: Ensure x-mcp is running')
  MARKER_STEP_LINE=$(line_of '- name: Record deployed-sha marker')

  for v in GATE_LINE ENSURE_LINE MARKER_STEP_LINE; do
    eval "val=\$$v"
    case "$val" in ''|*[!0-9]*) bad "$v resolved (got [$val])";; *) ok "$v resolved ($val)";; esac
  done
  [ -n "$ENSURE_LINE" ] || return 0

  # --- the Ensure step block: name line .. line before the next step name --
  NEXT_STEP=$(awk -v l="$ENSURE_LINE" 'NR>l && /^      - name: /{print NR; exit}' "$YML")
  if [ -n "$NEXT_STEP" ]; then ENSURE_END=$((NEXT_STEP-1)); else ENSURE_END=$(wc -l < "$YML"); fi
  BLK=$(sed -n "${ENSURE_LINE},${ENSURE_END}p" "$YML")

  # --- the remote ssh script span: opening `ubuntu@$EC2_HOST "` .. the
  # closing quote line (which since the fix carries the `|| { … FAILED=1; }`
  # ssh-failure handler) ---------------------------------------------------
  SSH_LN=$(printf '%s\n' "$BLK" | grep -nF 'ubuntu@$EC2_HOST "' | head -1 | cut -d: -f1)
  CLOSE_LN=$(printf '%s\n' "$BLK" | grep -nF '" || {' | head -1 | cut -d: -f1)
  if [ -n "$SSH_LN" ] && [ -n "$CLOSE_LN" ] && [ "$CLOSE_LN" -gt "$SSH_LN" ]; then
    ok "remote script span resolved (block lines $SSH_LN..$CLOSE_LN)"
    REMOTE=$(printf '%s\n' "$BLK" | sed -n "${SSH_LN},${CLOSE_LN}p")
  else
    bad "remote script span unresolved — no '|| {' ssh-failure handler on the closing quote (open [$SSH_LN] close [$CLOSE_LN])"
    REMOTE=""
  fi

  # (a) set -e inside the remote script — a failed compose must abort it
  check "remote script sets -e" "1" "$(printf '%s\n' "$REMOTE" | grep -cF 'set -e')"

  # (b) post-build RUNNING verification in the not-running branch
  check "not-running branch: post-build RUNNING verification present" "1" \
    "$(printf '%s\n' "$REMOTE" | grep -cF 'not running after build')"
  check "not-running branch: verification exits 1" "1" \
    "$(printf '%s\n' "$REMOTE" | grep -A3 'not running after build' | grep -cF 'exit 1')"

  # (b) post-rebuild RUNNING verification in the changed-sources branch
  check "rebuild branch: post-rebuild RUNNING verification present" "1" \
    "$(printf '%s\n' "$REMOTE" | grep -cF 'not running after rebuild')"
  check "rebuild branch: verification exits 1" "1" \
    "$(printf '%s\n' "$REMOTE" | grep -A3 'not running after rebuild' | grep -cF 'exit 1')"

  # the RUNNING re-query must appear 3x: initial check + after build + after
  # rebuild (the skip branch correctly has none)
  check "running re-query count (initial + post-build + post-rebuild)" "3" \
    "$(printf '%s\n' "$REMOTE" | grep -cF 'XMCP=\$(sudo docker ps --filter name=x-mcp-prod --filter status=running -q)')"
  # exactly two explicit exit 1s in the remote script (one per rebuild branch)
  check "remote script explicit exit-1 count" "2" \
    "$(printf '%s\n' "$REMOTE" | grep -cF 'exit 1')"

  # (c) host-loop failure accumulator in the outer step script
  check "accumulator initialized (FAILED=0) exactly once" "1" "$(printf '%s\n' "$BLK" | grep -cF 'FAILED=0')"
  check "ssh failure latches the accumulator (FAILED=1; })" "1" "$(printf '%s\n' "$BLK" | grep -cF 'FAILED=1; }')"
  check "final FAILED gate present" "1" "$(printf '%s\n' "$BLK" | grep -cF '[ "$FAILED" -ne 0 ]')"
  check "final FAILED gate exits 1" "1" "$(printf '%s\n' "$BLK" | grep -A2 -- '-ne 0' | grep -cF 'exit 1')"

  FAILED0_LN=$(printf '%s\n' "$BLK" | grep -nF 'FAILED=0' | head -1 | cut -d: -f1)
  FOR_LN=$(printf '%s\n' "$BLK" | grep -nF 'for EC2_HOST' | head -1 | cut -d: -f1)
  GATEFAIL_LN=$(printf '%s\n' "$BLK" | grep -nF '[ "$FAILED" -ne 0 ]' | head -1 | cut -d: -f1)
  DONE_LN=$(printf '%s\n' "$BLK" | grep -nF 'done' | head -1 | cut -d: -f1)
  if [ -n "$FAILED0_LN" ] && [ -n "$FOR_LN" ] && [ "$FAILED0_LN" -lt "$FOR_LN" ]; then
    ok "accumulator initialized before the host loop"
  else
    bad "accumulator must be initialized before the host loop (init [$FAILED0_LN] loop [$FOR_LN])"
  fi
  if [ -n "$GATEFAIL_LN" ] && [ -n "$DONE_LN" ] && [ "$GATEFAIL_LN" -gt "$DONE_LN" ]; then
    ok "final FAILED gate sits after the host loop"
  else
    bad "final FAILED gate must sit after the host loop (gate [$GATEFAIL_LN] done [$DONE_LN])"
  fi

  # (d) step ordering — do not re-break e3cb31c3
  if [ -n "$GATE_LINE" ] && [ "$GATE_LINE" -lt "$ENSURE_LINE" ]; then
    ok "Detect gate ($GATE_LINE) runs before the Ensure step ($ENSURE_LINE)"
  else
    bad "Detect gate ($GATE_LINE) must run before the Ensure step ($ENSURE_LINE)"
  fi
  if [ -n "$MARKER_STEP_LINE" ] && [ "$ENSURE_LINE" -lt "$MARKER_STEP_LINE" ]; then
    ok "Ensure step ($ENSURE_LINE) runs before the Record-marker step ($MARKER_STEP_LINE)"
  else
    bad "Ensure step ($ENSURE_LINE) must run before the Record-marker step ($MARKER_STEP_LINE)"
  fi
  WRITE_LINE=$(grep -nF '> /tmp/deployed-sha.' "$YML" | head -1 | cut -d: -f1)
  if [ -n "$WRITE_LINE" ] && [ "$WRITE_LINE" -gt "$ENSURE_LINE" ]; then
    ok "marker write ($WRITE_LINE) still lands AFTER the Ensure step — e3cb31c3 intact"
  else
    bad "marker write ($WRITE_LINE) must land AFTER the Ensure step ($ENSURE_LINE) — the e3cb31c3 race"
  fi
}

# --- main battery against the target workflow file ---------------------------
run_checks

# (e) the e3cb31c3 gate-order suite must stay green (10/10 today; the count
# may grow — zero failures is the invariant). It always reads the repo's own
# ../../.github/workflows/deploy.yml regardless of any $1 override.
if E3CB_OUT=$(bash ./xmcp-gate-order.e3cb31c3.test.sh 2>&1); then
  E3CB_SUMMARY=$(printf '%s\n' "$E3CB_OUT" | tail -1)
  case "$E3CB_SUMMARY" in
    *", 0 failed") ok "e3cb31c3 gate-order suite still green ($E3CB_SUMMARY)";;
    *) bad "e3cb31c3 suite summary unexpected: $E3CB_SUMMARY";;
  esac
else
  bad "e3cb31c3 gate-order suite FAILED — this change re-broke the marker-ordering fix"
fi

# --- negative control: same checks against the PRE-FIX Ensure bytes --------
# Verbatim from origin/main fa4a98006 (.github/workflows/deploy.yml lines
# 413-436, before this fix). The battery MUST reject them.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
{
  cat <<'GATEEOF'
      - name: Detect x-mcp changes in this push
        id: xmcp
        run: |
          echo "changed=true" >> "$GITHUB_OUTPUT"
GATEEOF
  cat <<'ENSUREEOF'
      - name: Ensure x-mcp is running
        run: |
          HOSTS="${{ secrets.EC2_HOSTS }}"
          [ -z "$HOSTS" ] && HOSTS="${{ secrets.EC2_HOST }}"
          for EC2_HOST in $HOSTS; do
            ssh -i ~/.ssh/ec2-key.pem -o StrictHostKeyChecking=no ubuntu@$EC2_HOST "
              cd /opt/crossmodel
              XMCP=\$(sudo docker ps --filter name=x-mcp-prod --filter status=running -q)
              if [ -z \"\$XMCP\" ]; then
                echo '⚠️ x-mcp-prod not running — building & starting it now...'
                sudo docker compose -f docker-compose.base.yml up -d --build x-mcp
                sleep 10
                sudo docker ps --filter name=x-mcp-prod --format 'x-mcp: {{.Status}}'
              elif [ '${{ steps.xmcp.outputs.changed }}' = 'true' ]; then
                echo '✅ x-mcp-prod is running — x-mcp sources changed since last deploy, rebuilding...'
                sudo docker compose -f docker-compose.base.yml up -d --build x-mcp
                sleep 6
                sudo docker ps --filter name=x-mcp-prod --format 'x-mcp: {{.Status}}'
              else
                echo '✅ x-mcp-prod is running — no x-mcp changes in this push, skipping rebuild'
                sudo docker ps --filter name=x-mcp-prod --format 'x-mcp: {{.Status}}'
              fi
            "
          done
ENSUREEOF
  cat <<'MARKEREOF'
      - name: Record deployed-sha marker
        run: |
          echo '0000000000000000000000000000000000000000' > /tmp/deployed-sha.999
MARKEREOF
} > "$TMP/pre-fix-deploy.yml"

NEG_OUT=$( ( YML="$TMP/pre-fix-deploy.yml"; run_checks ) 2>&1 )
NEG_FAILS=$(printf '%s\n' "$NEG_OUT" | grep -c '^  FAIL:' || true)
if [ "${NEG_FAILS:-0}" -gt 0 ]; then
  ok "negative control: pre-fix Ensure bytes rejected ($NEG_FAILS checks failed, as they must)"
else
  bad "negative control: checks PASSED on pre-fix bytes — this pin cannot detect the 43ea65de bug"
fi

echo "xmcp-ensure-buildfail.43ea65de: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

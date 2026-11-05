#!/usr/bin/env bash
# gmcp-hmcp-ensure-buildfail.9da289ea.test.sh — structural pin for the
# "Ensure google-mcp is running" / "Ensure github-mcp is running"
# failure-masking fix (ticket 9da289ea, 2026-09-23; 43ea65de class).
#
# The bug (pre-fix deploy.yml @ origin/main 860091fb2, "Ensure google-mcp is
# running" / "Ensure github-mcp is running" steps): the remote ssh scripts had
# no `set -e`, so a FAILED `docker compose -f docker-compose.base.yml up -d
# google-mcp|github-mcp` (compose config error, image pull failure) fell
# through to the `sleep 10` + trailing `docker ps --format` status listing —
# and that last command's exit status (always 0) became the script's exit
# status → ssh returned 0 → the step went green with a stale or absent
# container while every downstream step gated on `if: success()`.
# `docker compose up -d` can also exit 0 with a container that immediately
# exited, so the post-start RUNNING re-query is the real gate. The outer host
# loop additionally kept no failure accumulator, so an earlier host's ssh
# failure could be dropped by a later host's success. Found as the residual
# NOTE of the 43ea65de adversarial review (chat df22678d, MERGE-SAFE
# 2026-09-23); the x-mcp sibling was fixed by PR #984 (ec3aa9eca2), these two
# steps were deliberately left out of that diff to keep it minimal.
#
# This test fails if, in EITHER sibling step:
#   - the remote script loses `set -e`,
#   - the not-running branch loses its post-start RUNNING re-verification
#     (re-query + explicit exit 1) or its `docker ps -a` failure diagnostics,
#   - the host loop loses its failure accumulator or final FAILED gate,
#   - the ssh failure handler (`|| { … FAILED=1; }`) on the closing quote
#     disappears (the remote-script span becomes unresolvable),
#   - either step disappears from the workflow entirely.
# It also fails if the 43ea65de x-mcp pin suite stops passing (this change
# must not touch the x-mcp step — one concern per PR).
# NEGATIVE CONTROL: the pre-fix bytes of BOTH sibling steps are embedded
# verbatim below and the same checks are run against them — they MUST fail (a
# pin that cannot detect the bug is worth nothing). Optionally pass a yaml
# path as $1 to run the battery against any other deploy.yml copy.
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
  echo "gmcp-hmcp-ensure-buildfail.9da289ea: $PASS passed, $FAIL failed"
  exit 1
fi

# step_block <step-name> — print the step's block (name line .. line before
# the next `      - name: `), or nothing if the step is absent.
step_block() {
  local LN
  LN=$(grep -nF -- "- name: $1" "$YML" | head -1 | cut -d: -f1)
  [ -n "$LN" ] || return 0
  local NEXT END TOT
  NEXT=$(awk -v l="$LN" 'NR>l && /^      - name: /{print NR; exit}' "$YML")
  TOT=$(wc -l < "$YML")
  if [ -n "$NEXT" ]; then END=$((NEXT-1)); else END=$TOT; fi
  sed -n "${LN},${END}p" "$YML"
}

# run_step_checks <step-name> <container-prefix> — the full battery for ONE
# sibling ensure-step. Called against the real workflow file (twice) and
# against the negative control (twice, in a subshell whose FAIL count is
# parsed rather than propagated).
run_step_checks() {
  STEP_NAME="$1"; SVC="$2"
  BLK=$(step_block "$STEP_NAME")
  if [ -z "$BLK" ]; then
    bad "$STEP_NAME: step not found in $YML"
    return 0
  fi
  ok "$STEP_NAME: step block resolved ($(printf '%s\n' "$BLK" | wc -l) lines)"

  # --- the remote ssh script span: opening `ubuntu@$EC2_HOST "` .. the
  # closing quote line (which since the fix carries the `|| { … FAILED=1; }`
  # ssh-failure handler) -----------------------------------------------
  SSH_LN=$(printf '%s\n' "$BLK" | grep -nF 'ubuntu@$EC2_HOST "' | head -1 | cut -d: -f1)
  CLOSE_LN=$(printf '%s\n' "$BLK" | grep -nF '" || {' | head -1 | cut -d: -f1)
  if [ -n "$SSH_LN" ] && [ -n "$CLOSE_LN" ] && [ "$CLOSE_LN" -gt "$SSH_LN" ]; then
    ok "$STEP_NAME: remote script span resolved (block lines $SSH_LN..$CLOSE_LN)"
    REMOTE=$(printf '%s\n' "$BLK" | sed -n "${SSH_LN},${CLOSE_LN}p")
  else
    bad "$STEP_NAME: remote script span unresolved — no '|| {' ssh-failure handler on the closing quote (open [$SSH_LN] close [$CLOSE_LN])"
    REMOTE=""
  fi

  # (a) set -e inside the remote script — a failed compose must abort it
  check "$STEP_NAME: remote script sets -e" "1" "$(printf '%s\n' "$REMOTE" | grep -cF 'set -e')"

  # (b) post-start RUNNING verification in the not-running branch
  check "$STEP_NAME: not-running branch: post-start RUNNING verification present" "1" \
    "$(printf '%s\n' "$REMOTE" | grep -cF 'not running after start')"
  check "$STEP_NAME: not-running branch: verification exits 1" "1" \
    "$(printf '%s\n' "$REMOTE" | grep -A4 'not running after start' | grep -cF 'exit 1')"
  check "$STEP_NAME: not-running branch: prints docker ps -a diagnostics" "1" \
    "$(printf '%s\n' "$REMOTE" | grep -cF "sudo docker ps -a --filter name=${SVC}-prod")"

  # the RUNNING re-query must appear 2x: initial check + after start
  # (the already-running branch correctly has none)
  check "$STEP_NAME: running re-query count (initial + post-start)" "2" \
    "$(printf '%s\n' "$REMOTE" | grep -cF "\$(sudo docker ps --filter name=${SVC}-prod --filter status=running -q)")"
  # exactly one explicit exit 1 in the remote script (not-running branch)
  check "$STEP_NAME: remote script explicit exit-1 count" "1" \
    "$(printf '%s\n' "$REMOTE" | grep -cF 'exit 1')"

  # (c) host-loop failure accumulator in the outer step script
  check "$STEP_NAME: accumulator initialized (FAILED=0) exactly once" "1" "$(printf '%s\n' "$BLK" | grep -cF 'FAILED=0')"
  check "$STEP_NAME: ssh failure latches the accumulator (FAILED=1; })" "1" "$(printf '%s\n' "$BLK" | grep -cF 'FAILED=1; }')"
  check "$STEP_NAME: final FAILED gate present" "1" "$(printf '%s\n' "$BLK" | grep -cF '[ "$FAILED" -ne 0 ]')"
  check "$STEP_NAME: final FAILED gate exits 1" "1" \
    "$(printf '%s\n' "$BLK" | grep -A2 '\[ "\$FAILED" -ne 0 \]' | grep -cF 'exit 1')"

  # (d) the closing-quote line must carry the ssh-failure handler — a bare
  # closing quote means the remote script's exit status is whatever the
  # trailing status listing returned (always 0: the mask itself)
  check "$STEP_NAME: closing quote carries the || handler (no bare-quote mask)" "1" \
    "$(printf '%s\n' "$BLK" | grep -cF '" || {')"
}

# --- main battery against the target workflow file ---------------------------
run_step_checks 'Ensure google-mcp is running' 'google-mcp'
run_step_checks 'Ensure github-mcp is running' 'github-mcp'

# (e) the 43ea65de x-mcp pin suite must stay green (22/22 today; the count
# may grow — zero failures is the invariant). This change must not touch the
# x-mcp step — one concern per PR. It always reads the repo's own
# ../../.github/workflows/deploy.yml regardless of any $1 override.
if XMCP_OUT=$(bash ./xmcp-ensure-buildfail.43ea65de.test.sh 2>&1); then
  XMCP_SUMMARY=$(printf '%s\n' "$XMCP_OUT" | tail -1)
  case "$XMCP_SUMMARY" in
    *", 0 failed") ok "43ea65de x-mcp pin suite still green ($XMCP_SUMMARY)";;
    *) bad "43ea65de suite summary unexpected: $XMCP_SUMMARY";;
  esac
else
  bad "43ea65de x-mcp pin suite FAILED — this change touched the x-mcp step or re-broke its fix"
fi

# --- negative control: same checks against the PRE-FIX sibling bytes --------
# Verbatim from origin/main 860091fb2 (.github/workflows/deploy.yml, the two
# sibling steps before this fix — no set -e, trailing `docker ps --format`
# listing, no accumulator). The battery MUST reject BOTH.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
{
  cat <<'GMCP'
      - name: Ensure google-mcp is running
        run: |
          HOSTS="${{ secrets.EC2_HOSTS }}"
          [ -z "$HOSTS" ] && HOSTS="${{ secrets.EC2_HOST }}"
          for EC2_HOST in $HOSTS; do
            ssh -i ~/.ssh/ec2-key.pem -o StrictHostKeyChecking=no ubuntu@$EC2_HOST "
              cd /opt/crossmodel
              GMCP=\$(sudo docker ps --filter name=google-mcp-prod --filter status=running -q)
              if [ -z \"\$GMCP\" ]; then
                echo '⚠️ google-mcp-prod not running — starting it now...'
                sudo docker compose -f docker-compose.base.yml up -d google-mcp
                sleep 10
                sudo docker ps --filter name=google-mcp-prod --format 'google-mcp: {{.Status}}'
              else
                echo '✅ google-mcp-prod is running'
                sudo docker ps --filter name=google-mcp-prod --format 'google-mcp: {{.Status}}'
              fi
            "
          done
GMCP
  cat <<'HMCP'
      - name: Ensure github-mcp is running
        run: |
          HOSTS="${{ secrets.EC2_HOSTS }}"
          [ -z "$HOSTS" ] && HOSTS="${{ secrets.EC2_HOST }}"
          for EC2_HOST in $HOSTS; do
            ssh -i ~/.ssh/ec2-key.pem -o StrictHostKeyChecking=no ubuntu@$EC2_HOST "
              cd /opt/crossmodel
              GMCP=\$(sudo docker ps --filter name=github-mcp-prod --filter status=running -q)
              if [ -z \"\$GMCP\" ]; then
                echo '⚠️ github-mcp-prod not running — starting it now...'
                sudo docker compose -f docker-compose.base.yml up -d github-mcp
                sleep 10
                sudo docker ps --filter name=github-mcp-prod --format 'github-mcp: {{.Status}}'
              else
                echo '✅ github-mcp-prod is running'
                sudo docker ps --filter name=github-mcp-prod --format 'github-mcp: {{.Status}}'
              fi
            "
          done
HMCP
} > "$TMP/pre-fix-deploy.yml"

NEG_OUT=$( ( YML="$TMP/pre-fix-deploy.yml"; \
             run_step_checks 'Ensure google-mcp is running' 'google-mcp'; \
             run_step_checks 'Ensure github-mcp is running' 'github-mcp' ) 2>&1 )
NEG_FAILS=$(printf '%s\n' "$NEG_OUT" | grep -c '^  FAIL:' || true)
if [ "${NEG_FAILS:-0}" -ge 8 ]; then
  ok "negative control: pre-fix sibling bytes rejected ($NEG_FAILS checks failed, as they must)"
else
  bad "negative control: too few checks failed on pre-fix bytes ($NEG_FAILS < 8) — this pin cannot detect the 9da289ea bug"
fi

echo "gmcp-hmcp-ensure-buildfail.9da289ea: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

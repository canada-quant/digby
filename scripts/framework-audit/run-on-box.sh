#!/bin/bash
# run-on-box.sh — run ONE framework-audit command on a production box through AWS Systems Manager.
#
# This is how the Framework Operator lane reaches production: no SSH key, no host password —
# the sandbox's AWS credentials (Account → Coding → Providers → AWS) plus SSM, which IAM gates
# and CloudTrail records.
#
# Usage:
#   scripts/framework-audit/run-on-box.sh A 'bash /opt/crossmodel/scripts/framework-audit/prodq.sh audit-live-state.js 2026-09-21T16:00:00Z'
#   scripts/framework-audit/run-on-box.sh A 'bash /opt/crossmodel/scripts/framework-audit/redis-readout.sh'
#   scripts/framework-audit/run-on-box.sh C 'bash /opt/crossmodel/scripts/framework-audit/box-readout.sh'
# Boxes: A = example-ca-primary (Redis, web, cron-only worker), B = example-ca-app-b (web), C = example-ca-node (worker).
# Output: the command's stdout. Exit code: 0 = remote command exited 0; 4 = remote command
# failed OR the SSM invocation failed (remote stderr relayed); 2 = usage; 3 = no CommandId.
#
# OUTPUT PAGING (2026-09-23, firing 6): one GetCommandInvocation returns at most ~24 KB of
# StandardOutputContent, so the single-shot fetch came back cut mid-JSON for any probe over
# that size — firing 6's audit-live-state read was 29,235 B and had to be re-pulled by hand
# through a box-side /tmp file. (The hand-rolled retry ALSO showed the trap to avoid: a
# per-LINE character slicer silently returns nothing for any range past the first line of
# pretty-printed JSON, because every line is short. Ranges here are always BYTE ranges —
# `tail -c +N | head -c C`.) The runner now wraps the command to park stdout/stderr in
# box-side temp files, reads a __ROB_RC__/__ROB_OUT__/__ROB_ERR__ trailer for the remote rc
# and byte counts, and pages the parked files back in ROB_CHUNK-byte follow-up SSM calls.
# Each page ends with a __ROB_PAGE_END__ sentinel so $() cannot eat real trailing newlines;
# the parked files are removed by a fire-and-forget cleanup command on exit.
#
# Reading MORE than one result cap: the lane harness caps a single command's returned output
# at the same ~24 KB order, so for a large probe either redirect to a file
# (`run-on-box.sh A '…' > audit.json`, then slice the file locally) or set
# ROB_RANGE="from[:to]" to print only that 1-based BYTE window of the remote output —
# `ROB_RANGE=20001: run-on-box.sh A '…'` shows the tail in one call.
#
# Knobs: ROB_CHUNK (default 20000) tunes the page size; ROB_PAGING_DISABLED=1 restores the
# verbatim single-shot passthrough (same semantics as before 2026-09-23, ~24 KB cap applies)
# for commands the wrapper cannot host (e.g. an unbalanced paren). The wrapped command runs
# inside a SUBSHELL — `( … )` — so a command with its own `exit` (the prodq idiom
# `prodq.sh probe.js; rc=$?; rm -f …; exit $rc`) ends the SUBSHELL, not the remote shell,
# and the trailer still prints (a brace group would let `exit` kill the trailer entirely —
# the fail-open path firing-6 caught live).
set -euo pipefail
box="${1:-}"; cmd="${2:-}"
[ -n "$box" ] && [ -n "$cmd" ] || { echo "usage: run-on-box.sh <A|B|C> '<command>'" >&2; exit 2; }
case "$box" in
  A|a) iid="i-0123456789abcdef0" ;;
  B|b) iid="i-0123456789abcdef0" ;;
  C|c) iid="i-0123456789abcdef0" ;;
  *) echo "unknown box $box (A|B|C)" >&2; exit 2 ;;
esac
region="${AWS_REGION:-${AWS_DEFAULT_REGION:-ca-central-1}}"
timeout_s="${SSM_TIMEOUT_S:-240}"

# ── STS preflight (FO firing 120 bake, 34rd f64) ────────────────────────────
# Live trap 2026-10-11 ~22:4xZ: the sandbox's stored AWS provider credential
# died (InvalidClientTokenId on plain STS) and run-on-box failed DEEP inside
# the status poll with a bare "UnrecognizedClientException ... GetCommandInvocation"
# — one forensic round burned distinguishing "my credential is dead" from
# "SSM broke / boxes broke". A plain sts get-caller-identity BEFORE any SSM
# call answers that in one shot, the same class as verify-wave.sh's opening
# check: name the failure mode at the seam instead of re-deriving it by eye.
# CREDENTIAL-CLASS failures only (InvalidClientTokenId / UnrecognizedClientException /
# ExpiredToken / SecurityToken) exit 5 with the refresh instruction — the ONLY
# thing this lane cannot fix (charter: the owner's stored provider credential).
# Any OTHER preflight failure (network, throttling, STS outage) is FAILOPEN:
# the original SSM path runs exactly as before, so the preflight can never
# make a previously-working run fail. Kill switch: RUN_ON_BOX_SKIP_STS_PREFLIGHT=1.
if [ "${RUN_ON_BOX_SKIP_STS_PREFLIGHT:-0}" != "1" ] && command -v aws >/dev/null 2>&1; then
  if ! rob_preflight="$(aws sts get-caller-identity --region "$region" --query Arn --output text 2>&1)"; then
    case "$rob_preflight" in
      *InvalidClientTokenId*|*UnrecognizedClientException*|*ExpiredToken*|*SecurityToken*)
        echo "run-on-box: AWS CREDENTIAL REJECTED (sts get-caller-identity):" >&2
        printf '%s\n' "$rob_preflight" >&2
        echo "run-on-box: the sandbox's stored AWS provider credential is invalid/rotated — refresh it" >&2
        echo "run-on-box: in Account → Coding → Providers → AWS. This is NOT an SSM permission issue and" >&2
        echo "run-on-box: NOT a box defect; NO SSM command was sent. (FO f120 bake; charter: the one" >&2
        echo "run-on-box: thing this lane cannot fix. Bypass: RUN_ON_BOX_SKIP_STS_PREFLIGHT=1.)" >&2
        exit 5 ;;
      *)
        echo "run-on-box: sts preflight failed (non-credential class) — proceeding fail-open:" >&2
        printf '%s\n' "$rob_preflight" >&2 ;;
    esac
  fi
fi

# ssm_run is always invoked inside $() — a SUBSHELL — so it cannot export variables to the
# caller. The last invocation's Status/CommandId travel through this state file instead.
rob_state="$(mktemp)"
rob_status=""; rob_cid=""
ssm_run() { # ssm_run '<remote command>' → prints that invocation's StandardOutputContent
  local rcmd="$1" params cid status
  params="$(python3 -c 'import json,sys; print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":[sys.argv[2]]}))' "$rcmd" "$timeout_s")"
  cid="$(aws ssm send-command --region "$region" --instance-ids "$iid" --document-name AWS-RunShellScript \
    --comment "framework-audit" --parameters "$params" --query 'Command.CommandId' --output text)"
  [ -n "$cid" ] || { echo "send-command returned no CommandId" >&2; exit 3; }
  status="Pending"
  for _ in $(seq 1 $((timeout_s / 2 + 10))); do
    status="$(aws ssm get-command-invocation --region "$region" --command-id "$cid" --instance-id "$iid" --query 'Status' --output text 2>/dev/null || echo Pending)"
    case "$status" in Success|Failed|Cancelled|TimedOut|Cancelling) break ;; esac
    sleep 2
  done
  printf '%s\t%s\n' "$status" "$cid" > "$rob_state"
  aws ssm get-command-invocation --region "$region" --command-id "$cid" --instance-id "$iid" --query 'StandardOutputContent' --output text
}
rob_last() { rob_status=""; rob_cid=""; { read -r rob_status rob_cid < "$rob_state"; } || true; }
relay_stderr() { # best-effort relay of the last invocation's StandardErrorContent
  [ -n "$rob_cid" ] || return 0
  aws ssm get-command-invocation --region "$region" --command-id "$rob_cid" --instance-id "$iid" --query 'StandardErrorContent' --output text >&2 || true
}

if [ "${ROB_PAGING_DISABLED:-0}" = "1" ]; then
  # Legacy single-shot path: verbatim command, single fetch (SSM/harness ~24 KB cap applies).
  out="$(ssm_run "$cmd")"; rob_last
  printf '%s\n' "$out"
  if [ "$rob_status" != "Success" ]; then
    echo "--- remote status: $rob_status" >&2
    relay_stderr
    exit 4
  fi
  exit 0
fi

# --- Paged path -------------------------------------------------------------
chunk="${ROB_CHUNK:-20000}"
park="/tmp/rob-$(date +%s)-$$.out"; perr="${park%.out}.err"
rob_cleanup() { # fire-and-forget: remove the box-side temp files and the local state file
  aws ssm send-command --region "$region" --instance-ids "$iid" --document-name AWS-RunShellScript \
    --comment "framework-audit-cleanup" \
    --parameters "$(python3 -c 'import json,sys; print(json.dumps({"commands":[sys.argv[1]]}))' "rm -f '$park' '$perr'")" >/dev/null 2>&1 || true
  rm -f "$rob_state"
  return 0
}
trap rob_cleanup EXIT

# page_file <file> <total-bytes> [from] [to] — print bytes [from, to] (1-based, defaults
# 1..total) of the parked file in chunk-byte pages, always BYTE ranges.
page_file() {
  local file="$1" total="$2" from="${3:-1}" to="${4:-$2}" pos len raw
  [ "$to" -gt "$total" ] 2>/dev/null && to="$total"
  pos="$from"
  while [ "$pos" -le "$to" ]; do
    len=$(( chunk < to - pos + 1 ? chunk : to - pos + 1 ))
    raw="$(ssm_run "tail -c +$pos '$file' | head -c $len; printf '__ROB_PAGE_END__'")" || raw=""
    rob_last
    if [ "$rob_status" != "Success" ] || [ -z "$raw" ]; then
      echo "--- run-on-box: page fetch failed at byte $pos of $file (status '${rob_status:-none}') — output truncated" >&2
      break
    fi
    printf '%s' "${raw%__ROB_PAGE_END__}"
    pos=$(( pos + len ))
  done
}

wrapped="( $cmd ) > '$park' 2>'$perr'; rc=\$?; printf '__ROB_RC__ %s\n__ROB_OUT__ %s\n__ROB_ERR__ %s\n' \"\$rc\" \"\$(wc -c < '$park')\" \"\$(wc -c < '$perr')\""
trailer="$(ssm_run "$wrapped")"; rob_last
if [ "$rob_status" != "Success" ]; then
  printf '%s\n' "$trailer"
  echo "--- remote status: $rob_status" >&2
  relay_stderr
  exit 4
fi
rc="$(printf '%s\n' "$trailer" | sed -n 's/^__ROB_RC__ //p' | tail -1)"
outb="$(printf '%s\n' "$trailer" | sed -n 's/^__ROB_OUT__ //p' | tail -1)"
errb="$(printf '%s\n' "$trailer" | sed -n 's/^__ROB_ERR__ //p' | tail -1)"
if [ -z "${rc:-}" ] || [ -z "${outb:-}" ] || [ -z "${errb:-}" ]; then
  # Exotic command swallowed the trailer (e.g. its own `exit`): fail open on what we got.
  echo "--- run-on-box: paging trailer missing — falling back to raw output (got: $(printf '%s' "$trailer" | head -c 120))" >&2
  printf '%s\n' "$trailer"
  exit 0
fi

range_from=1; range_to=""
if [ -n "${ROB_RANGE:-}" ]; then
  range_from="${ROB_RANGE%%:*}"
  [ "$ROB_RANGE" = "$range_from" ] || range_to="${ROB_RANGE#*:}"
  case "$range_from" in ''|*[!0-9]*) echo "--- run-on-box: bad ROB_RANGE '$ROB_RANGE' (want from[:to], 1-based bytes)" >&2; exit 2 ;; esac
  [ -z "$range_to" ] || case "$range_to" in *[!0-9]*) echo "--- run-on-box: bad ROB_RANGE '$ROB_RANGE' (want from[:to], 1-based bytes)" >&2; exit 2 ;; esac
fi

page_file "$park" "$outb" "$range_from" "${range_to:-$outb}"
printf '\n'

if [ "$rc" != "0" ]; then
  echo "--- remote status: Failed (rc $rc)" >&2
  [ "$errb" != "0" ] && { page_file "$perr" "$errb" >&2; printf '\n' >&2; }
  exit 4
fi
exit 0

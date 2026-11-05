#!/bin/bash
# perimeter-watch.sh — STANDING perimeter watch (owner steer 2026-09-24, commits
# afdbe811/2d80449b/bed64f3f). Read-only; runs from the operator sandbox (AWS
# creds present) and over SSM via run-on-box.sh — needs NO deploy wave.
#
#   bash scripts/framework-audit/perimeter-watch.sh
#
# (a) every box: iptables DOCKER-USER/INPUT must jump to the DIGIBY-SANDBOX
#     chains and digby-sandbox-egress-guard.service must be enabled (the wave
#     applies the rules directly; the enabled oneshot unit re-applies on reboot).
#     Raw `iptables -S` is fetched and parsed LOCALLY — remote grep through the
#     SSM wrapper mangles hyphenated patterns (FO steer-8 live catch, 2026-09-24:
#     `iptables -S DOCKER-USER | grep -c DIGBY` returned 0 while `| cat -A`
#     showed the jump rule; wc/cat/head all pass through fine).
# (b) SG digby-app-sg (sg-0123456789abcdef0): NO 0.0.0.0/0 ingress on 22 and
#     NO gha-<run>-<attempt>-<epoch> gate rule older than 6 h (accumulation =
#     a workflow's close step is not running — ssh-gate defect).
# (c) deploy.yml + ec2-ops.yml: a FAILURE whose failed step is the ssh gate
#     ('Open SSH for this runner' / 'Close SSH') is a perimeter defect (OIDC/
#     role/IP detection); other-step failures belong to their own lanes and are
#     reported as notes, not perimeter failures. Cancelled runs are the normal
#     concurrency-supersede shape and are ignored.
# (d) is a live-traffic read (coding-run network errors) — kept in
#     audit-live-state.js errors_4h, not here.
#
# Exit 0 = watch RAN (verdicts on stdout); individual failures print FAIL lines
# and set the verdict — the operator reads the verdict, never a bare rc.
set -uo pipefail
cd "$(dirname "$0")"

SG_ID="${PERIMETER_SG_ID:-sg-0123456789abcdef0}"
AWS_REGION="${AWS_REGION:-ca-central-1}"
REPO="${PERIMETER_REPO:-example-org/crossmodel}"
FAILS=0
NOTES=0
say()  { echo "perimeter: $*"; }
note() { echo "perimeter: note — $*"; NOTES=$((NOTES+1)); }
bad()  { echo "perimeter: FAIL — $*"; FAILS=$((FAILS+1)); }

# ── (a) iptables chains + unit on every box (raw fetch, local parse) ─────────
# Chain names are DIGBY-SANDBOX-EGRESS / DIGBY-SANDBOX-INPUT (the owner steer
# writes "DIGIBY" — one extra I — but the live `iptables -S` output and the
# guard script both spell it DIGBY; FO steer-8 live catch, 2026-09-24: a
# six-hour grep goose-chase over "transport mangling" was a typo'd pattern).
# Patterns are SINGLE TOKENS (no spaces) — multi-word patterns are fragile
# through the SSM round-trip.
for B in A B C; do
  RAW="$(./run-on-box.sh "$B" 'iptables -S DOCKER-USER 2>/dev/null; iptables -S INPUT 2>/dev/null | head -4; systemctl is-enabled digby-sandbox-egress-guard.service 2>/dev/null || echo not-installed' 2>/dev/null | tr -d '\r' || true)"
  EG="$(printf '%s\n' "$RAW" | grep -c 'DIGBY-SANDBOX-EGRESS' || true)"
  IN="$(printf '%s\n' "$RAW" | grep -c 'DIGBY-SANDBOX-INPUT' || true)"
  EN="$(printf '%s\n' "$RAW" | grep -c '^enabled$' || true)"
  if [ "$EG" -ge 1 ] && [ "$IN" -ge 1 ] && [ "$EN" -ge 1 ]; then
    say "box-$B: egress+input jump rules present, unit enabled"
  else
    bad "box-$B: egress_jump=${EG:-0} input_jump=${IN:-0} unit_enabled=${EN:-0}"
  fi
done

# ── (b) security-group gate hygiene ─────────────────────────────────────────
if command -v aws >/dev/null 2>&1; then
  RULES="$(aws ec2 describe-security-groups --group-ids "$SG_ID" --region "$AWS_REGION" --output json 2>/dev/null || true)"
  if [ -n "$RULES" ]; then
    VERDICT="$(python3 -c '
import json, sys, time
d = json.load(sys.stdin)
now = time.time()
open22, stale = [], []
for sg in d.get("SecurityGroups", []):
    for p in sg.get("IpPermissions", []):
        if p.get("FromPort") == 22 or p.get("ToPort") == 22:
            for r in p.get("IpRanges", []):
                cidr, desc = r.get("CidrIp",""), r.get("Description","")
                if cidr == "0.0.0.0/0": open22.append(cidr)
                if desc.startswith("gha-"):
                    try:
                        epoch = int(desc.rsplit("-",1)[1]); age_h = (now-epoch)/3600
                        if age_h > 6: stale.append(f"{desc} age={age_h:.1f}h")
                    except (ValueError, IndexError): stale.append(f"{desc} (unparseable epoch)")
print("OPEN22=" + (",".join(open22) or "none"))
print("STALE_GHA=" + (",".join(stale) or "none"))
' <<<"$RULES" 2>/dev/null || echo 'OPEN22=probe-error STALE_GHA=probe-error')"
    OPEN22="$(printf '%s\n' "$VERDICT" | sed -n 1p)"; STALE="$(printf '%s\n' "$VERDICT" | sed -n 2p)"
    case "$OPEN22" in OPEN22=none) say "SG $SG_ID: no 0.0.0.0/0 ingress on 22";; *) bad "SG $SG_ID has open 22: $OPEN22";; esac
    case "$STALE" in STALE_GHA=none) say "SG $SG_ID: no gha-* gate rule older than 6 h";; *) bad "SG $SG_ID stale gha-* gate rules: $STALE";; esac
  else
    bad "aws describe-security-groups returned nothing for $SG_ID (creds/region?)"
  fi
else
  bad "aws CLI not available — cannot check SG gate hygiene"
fi

# ── (c) workflow health at the ssh-gate step ────────────────────────────────
if command -v gh >/dev/null 2>&1; then
  for WF in deploy.yml ec2-ops.yml; do
    # Failed (not cancelled) runs in the last 10; for each, decide by STEP.
    FAILED_IDS="$(gh run list --repo "$REPO" --workflow="$WF" --limit 10 --json databaseId,conclusion --jq 'map(select(.conclusion=="failure")) | .[].databaseId' 2>/dev/null || true)"
    if [ -z "$FAILED_IDS" ]; then
      say "workflow $WF: no failed run in the last 10"
      continue
    fi
    for RID in $FAILED_IDS; do
      STEPS="$(gh run view "$RID" --repo "$REPO" --json jobs --jq '[.jobs[].steps[] | select(.conclusion=="failure") | .name] | join(";")' 2>/dev/null || true)"
      case "$STEPS" in
        *SSH*|*ssh-gate*)
          bad "workflow $WF run $RID failed at an SSH-gate step: $STEPS — read the step log (OIDC/role/IP detection)"
          ;;
        *)
          note "workflow $WF run $RID failed on non-gate step(s): ${STEPS:-unknown} — not a perimeter defect"
          ;;
      esac
    done
  done
else
  bad "gh CLI not available — cannot check workflow health"
fi

# ── verdict ─────────────────────────────────────────────────────────────────
if [ "$FAILS" = 0 ]; then
  echo "perimeter: VERDICT ok ($NOTES note(s))"
else
  echo "perimeter: VERDICT defective ($FAILS item(s), $NOTES note(s))"
fi
exit 0

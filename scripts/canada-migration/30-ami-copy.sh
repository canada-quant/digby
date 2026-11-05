#!/usr/bin/env bash
# 30-ami-copy.sh — snapshot the prod box (no reboot, zero prod impact) and copy
# the AMI to ca-central-1. This is the "golden image" the staging instance —
# and later the two prod instances — boot from.
#
# Timings: create-image ~5–15 min (50 GB gp3) · copy-image ~10–30 min
# (cross-region). Safe to re-run: reuses in-flight/available AMIs from state.env.
#
# Prod impact: NONE (--no-reboot; snapshot of a running box has a small chance
# of an inconsistent filesystem in the IMAGE only — irrelevant here because the
# real data sync at cutover is a fresh pg_dump, not this image).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/00-config.sh"
require_aws

STAMP=$(date +%Y%m%d-%H%M%S)

# The `aws ec2 wait image-available` waiter is capped at ~10 min — far too short
# for a 50 GB live-box snapshot or a cross-region copy. Poll patiently instead.
wait_image() { # $1 ami id · $2 region · $3 human label
  local id="$1" region="$2" label="$3" st
  for i in $(seq 1 90); do   # 90 × 30s = 45 min ceiling
    st=$(aws ec2 describe-images --image-ids "$id" --region "$region" \
      --query 'Images[0].State' --output text 2>/dev/null || echo "describe-error")
    case "$st" in
      available) log "✔ $label available: $id"; return 0 ;;
      failed|error|deregistered) die "$label entered state '$st'" ;;
    esac
    [ $((i % 4)) -eq 0 ] && log "   $label: $st ($((i/2)) min elapsed)"
    sleep 30
  done
  die "$label not available after 45 min"
}

# ── 1. Source AMI in us-east-1 ────────────────────────────────────────────────
SRC_AMI_ID=$(state_get SRC_AMI_ID)
if [ -n "$SRC_AMI_ID" ]; then
  S=$(aws ec2 describe-images --image-ids "$SRC_AMI_ID" --region "$PROD_REGION" \
      --query 'Images[0].State' --output text 2>/dev/null || echo "gone")
  log "source AMI $SRC_AMI_ID state: $S"
  [ "$S" = "gone" ] && SRC_AMI_ID=""
fi
if [ -z "$SRC_AMI_ID" ]; then
  SRC_AMI_ID=$(aws ec2 create-image --instance-id "$PROD_INSTANCE_ID" \
    --name "digby-prod-golden-$STAMP" \
    --description "Golden image of $PROD_INSTANCE_ID for ca-central-1 migration (no-reboot snapshot)" \
    --no-reboot --region "$PROD_REGION" \
    --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=digby-prod-golden-$STAMP},{Key=Project,Value=digby-ca}]" \
    --query 'ImageId' --output text)
  state_set SRC_AMI_ID "$SRC_AMI_ID"
  log "✔ create-image started: $SRC_AMI_ID (prod keeps running)"
fi
log "⏳ waiting for source AMI to become available..."
wait_image "$SRC_AMI_ID" "$PROD_REGION" "source AMI"

# ── 2. Cross-region copy ──────────────────────────────────────────────────────
CA_AMI_ID=$(state_get CA_AMI_ID)
if [ -n "$CA_AMI_ID" ]; then
  S=$(aws ec2 describe-images --image-ids "$CA_AMI_ID" --region "$CA_REGION" \
      --query 'Images[0].State' --output text 2>/dev/null || echo "gone")
  log "ca-central-1 AMI $CA_AMI_ID state: $S"
  [ "$S" = "available" ] && { log "✅ copy already available: $CA_AMI_ID"; exit 0; }
  [ "$S" = "gone" ] && CA_AMI_ID=""
fi
if [ -z "$CA_AMI_ID" ]; then
  CA_AMI_ID=$(aws ec2 copy-image --source-region "$PROD_REGION" --source-image-id "$SRC_AMI_ID" \
    --name "digby-prod-golden-ca-$STAMP" \
    --description "ca-central-1 copy of $SRC_AMI_ID (Digby prod golden)" \
    --region "$CA_REGION" \
    --tag-specifications "ResourceType=image,Tags=[{Key=Name,Value=digby-prod-golden-ca-$STAMP},{Key=Project,Value=digby-ca}]" \
    --query 'ImageId' --output text)
  state_set CA_AMI_ID "$CA_AMI_ID"
  log "✔ copy-image started: $CA_AMI_ID"
fi
log "⏳ waiting for ca-central-1 AMI to become available (cross-region copy)..."
wait_image "$CA_AMI_ID" "$CA_REGION" "ca-central-1 AMI"
log "✅ ca-central-1 golden AMI ready: $CA_AMI_ID"

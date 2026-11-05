#!/usr/bin/env bash
# 40-launch-staging.sh — launch ONE staging instance in ca-central-1 from the
# golden AMI and register it with the target group. This proves the whole path
# (ALB → SG → instance → nginx → app) without touching prod traffic.
#
# The instance runs user-data-staging.yaml which on first boot:
#   * sets restart=no on admin-worker-* containers and stops them
#     (staging must NEVER double-fire chat/coding schedules or claim
#     agent_runs against its copied DB),
#   * masks digby-backup.timer/service (no duplicate pg_dump → S3),
#   * keeps adminer stopped (DB admin UI must not be reachable),
#   * disables every schedule row (enabled=false) in the COPIED DB
#     (staging DB is a throwaway snapshot; prod is unaffected).
#
# Prod impact: NONE.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/00-config.sh"
require_aws

CA_AMI_ID=$(state_get CA_AMI_ID); SUBNET_A_ID=$(state_get SUBNET_A_ID)
APP_SG_ID=$(state_get APP_SG_ID);  TG_ARN=$(state_get TG_ARN)
for v in CA_AMI_ID SUBNET_A_ID APP_SG_ID TG_ARN; do
  [ -n "${!v}" ] || die "state.env missing $v — run earlier scripts first"
done

# ── Existing staging instance? ────────────────────────────────────────────────
INST_ID=$(aws ec2 describe-instances --region "$CA_REGION" \
  --filters "Name=tag:Name,Values=$STAGING_NAME" "Name=instance-state-name,Values=pending,running,stopped,stopping" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ -z "$INST_ID" ] || [ "$INST_ID" = "None" ]; then
  # 100 GB gp3 root (prod's 50 GB filled to 94% — see README "Disk & capacity").
  # Ubuntu cloud-init's growpart expands the partition+filesystem to fill the
  # larger volume automatically on first boot, no user-data step needed.
  INST_ID=$(aws ec2 run-instances --region "$CA_REGION" \
    --image-id "$CA_AMI_ID" --instance-type "$STAGING_TYPE" \
    --key-name "$PROD_KEY_NAME" \
    --subnet-id "$SUBNET_A_ID" --security-group-ids "$APP_SG_ID" \
    --iam-instance-profile Name="$CA_PROFILE_NAME" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3,DeleteOnTermination=true}" \
    --user-data "file://$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/user-data-staging.yaml" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$STAGING_NAME},{Key=Project,Value=digby-ca}]" \
    --query 'Instances[0].InstanceId' --output text)
  log "✔ launched $STAGING_NAME: $INST_ID (100 GB gp3 root)"
else
  log "✔ staging instance exists: $INST_ID"
fi
state_set STAGING_INSTANCE_ID "$INST_ID"

log "⏳ waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$INST_ID" --region "$CA_REGION"
PUB=$(aws ec2 describe-instances --instance-ids "$INST_ID" --region "$CA_REGION" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
log "✔ running. public IP: $PUB"

# ── Register with the target group ────────────────────────────────────────────
aws elbv2 register-targets --target-group-arn "$TG_ARN" --region "$CA_REGION" \
  --targets Id="$INST_ID",Port=443 >/dev/null
log "✔ registered $INST_ID with $TG_NAME"

log "⏳ first-boot guardrails + container start take ~2-4 min; polling target health..."
for i in $(seq 1 20); do
  H=$(aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region "$CA_REGION" \
    --query "TargetHealthDescriptions[?Target.Id=='$INST_ID'].TargetHealth.State | [0]" --output text)
  log "   target health: $H"
  [ "$H" = "healthy" ] && break
  sleep 15
done
[ "$H" = "healthy" ] || log "⚠️  not healthy yet — re-run this script or check SSM: aws ssm start-session --target $INST_ID --region $CA_REGION"

ALB_DNS=$(state_get ALB_DNS)
log "✅ staging launched."
log "   Smoke test:  curl -sk https://$ALB_DNS/api/health -H 'Host: digby.ai'"
log "   Full URL:    curl -sk https://$ALB_DNS/ -H 'Host: digby.ai' -o /dev/null -w '%{http_code}\\n'"

#!/usr/bin/env bash
# 50-launch-app-b.sh — launch the SECOND (stateless) app instance "example-ca-app-b"
# in ca-central-1b and register it with the target group. B is a stateless app
# client of instance A (the staging box, which owns postgres/redis/docker):
# see user-data-app-b.yaml for exactly what is neutered and repointed.
#
# Prerequisites: A is running and healthy (its private IP is templated into
# B's user-data), the app SG already allows app-sg↔app-sg on 9384/7856/2375,
# and A's docker-socket-proxy is published on 2375.
#
# Prod impact: NONE — B joins the target group only after its health check
# passes, and DNS is untouched.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/00-config.sh"
require_aws

APP_B_NAME="example-ca-app-b"
APP_B_TYPE="t3.large"

CA_AMI_ID=$(state_get CA_AMI_ID); SUBNET_B_ID=$(state_get SUBNET_B_ID)
APP_SG_ID=$(state_get APP_SG_ID);  TG_ARN=$(state_get TG_ARN)
A_INSTANCE_ID=$(state_get STAGING_INSTANCE_ID)
for v in CA_AMI_ID SUBNET_B_ID APP_SG_ID TG_ARN A_INSTANCE_ID; do
  [ -n "${!v}" ] || die "state.env missing $v — run earlier scripts first"
done

# ── Instance A's VPC-private IP (templated into B's user-data) ────────────────
A_IP=$(aws ec2 describe-instances --instance-ids "$A_INSTANCE_ID" --region "$CA_REGION" \
  --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)
[ -n "$A_IP" ] && [ "$A_IP" != "None" ] || die "could not resolve A's private IP from $A_INSTANCE_ID"
log "✔ instance A ($A_INSTANCE_ID) private IP: $A_IP"

# ── Template user-data with A's IP ────────────────────────────────────────────
UD_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/user-data-app-b.yaml"
UD_TMP=$(mktemp /tmp/user-data-app-b.XXXXXX.yaml)
sed "s|__A_PRIVATE_IP__|${A_IP}|g" "$UD_SRC" > "$UD_TMP"
grep -q "$A_IP" "$UD_TMP" || die "user-data templating failed"

# ── Existing B instance? ──────────────────────────────────────────────────────
INST_ID=$(aws ec2 describe-instances --region "$CA_REGION" \
  --filters "Name=tag:Name,Values=$APP_B_NAME" "Name=instance-state-name,Values=pending,running,stopped,stopping" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ -z "$INST_ID" ] || [ "$INST_ID" = "None" ]; then
  # 100 GB gp3 root (prod's 50 GB filled to 94% — see README "Disk & capacity").
  INST_ID=$(aws ec2 run-instances --region "$CA_REGION" \
    --image-id "$CA_AMI_ID" --instance-type "$APP_B_TYPE" \
    --key-name "$PROD_KEY_NAME" \
    --subnet-id "$SUBNET_B_ID" --security-group-ids "$APP_SG_ID" \
    --iam-instance-profile Name="$CA_PROFILE_NAME" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3,DeleteOnTermination=true}" \
    --user-data "file://$UD_TMP" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$APP_B_NAME},{Key=Project,Value=digby-ca}]" \
    --query 'Instances[0].InstanceId' --output text)
  log "✔ launched $APP_B_NAME: $INST_ID (100 GB gp3 root, AZ-balanced subnet B)"
else
  log "✔ $APP_B_NAME exists: $INST_ID (re-registering + health check only)"
fi
rm -f "$UD_TMP"
state_set APP_B_INSTANCE_ID "$INST_ID"

log "⏳ waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$INST_ID" --region "$CA_REGION"
read -r PUB PRIV < <(aws ec2 describe-instances --instance-ids "$INST_ID" --region "$CA_REGION" \
  --query 'Reservations[0].Instances[0].[PublicIpAddress,PrivateIpAddress]' --output text)
log "✔ running. public IP: $PUB  private IP: $PRIV"
state_set APP_B_IP "$PUB"

# ── Register with the target group ────────────────────────────────────────────
aws elbv2 register-targets --target-group-arn "$TG_ARN" --region "$CA_REGION" \
  --targets Id="$INST_ID",Port=443 >/dev/null
log "✔ registered $INST_ID with $TG_NAME"

log "⏳ first-boot guardrails (neuter local pg/redis/worker, repoint to A, recreate blue)"
log "   take ~3-5 min; polling target health..."
H=""
for i in $(seq 1 30); do
  H=$(aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region "$CA_REGION" \
    --query "TargetHealthDescriptions[?Target.Id=='$INST_ID'].TargetHealth.State | [0]" --output text)
  log "   target health: $H"
  [ "$H" = "healthy" ] && break
  sleep 15
done
[ "$H" = "healthy" ] || die "B not healthy after polling — inspect: aws ssm start-session --target $INST_ID --region $CA_REGION (log: /var/log/digby-app-b-guard.log)"

ALB_DNS=$(state_get ALB_DNS)
log "✅ app-b launched and HEALTHY."
log "   Smoke test:  curl -sk https://$ALB_DNS/api/health -H 'Host: digby.ai'"

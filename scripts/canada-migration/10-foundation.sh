#!/usr/bin/env bash
# 10-foundation.sh — idempotent ca-central-1 foundation:
#   key pair import, dedicated VPC (2 public subnets / 2 AZs), IGW + routes,
#   ALB + app security groups, IAM role + instance profile (S3 backup + SSM).
# Safe to re-run; every resource is looked up by name/tag before creation.
# Writes discovered IDs to state.env for the later scripts.
#
# Prod impact: NONE (creates new resources in ca-central-1 only).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/00-config.sh"
require_aws

# ── Key pair: import the SAME public key prod uses (so the existing EC2_SSH_KEY
#    GitHub secret keeps working post-cutover). Fetched live from us-east-1 via
#    describe-key-pairs (public half only — never the private key). ──
if aws ec2 describe-key-pairs --key-names "$PROD_KEY_NAME" --region "$CA_REGION" >/dev/null 2>&1; then
  log "✔ key pair $PROD_KEY_NAME already in $CA_REGION"
else
  TMPKEY=$(mktemp)
  aws ec2 describe-key-pairs --key-names "$PROD_KEY_NAME" --include-public-key \
    --region "$PROD_REGION" --query 'KeyPairs[0].PublicKey' --output text > "$TMPKEY"
  [ -s "$TMPKEY" ] || die "could not fetch public key for $PROD_KEY_NAME from $PROD_REGION"
  aws ec2 import-key-pair --key-name "$PROD_KEY_NAME" --public-key-material "fileb://$TMPKEY" \
    --region "$CA_REGION" --tag-specifications "ResourceType=key-pair,Tags=[{Key=Name,Value=$PROD_KEY_NAME},{Key=Project,Value=digby-ca}]" >/dev/null
  rm -f "$TMPKEY"
  log "✔ imported key pair $PROD_KEY_NAME into $CA_REGION"
fi

# ── VPC ───────────────────────────────────────────────────────────────────────
VPC_ID=$(aws ec2 describe-vpcs --region "$CA_REGION" \
  --filters "Name=tag:Name,Values=$VPC_NAME" --query 'Vpcs[0].VpcId' --output text)
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  VPC_ID=$(aws ec2 create-vpc --cidr-block "$VPC_CIDR" --region "$CA_REGION" \
    --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=$VPC_NAME},{Key=Project,Value=digby-ca}]" \
    --query 'Vpc.VpcId' --output text)
  log "✔ created VPC $VPC_ID ($VPC_CIDR)"
else
  log "✔ VPC exists: $VPC_ID"
fi
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support '{"Value":true}' --region "$CA_REGION"
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames '{"Value":true}' --region "$CA_REGION"
state_set VPC_ID "$VPC_ID"

# ── Subnets ───────────────────────────────────────────────────────────────────
make_subnet() { # $1 name  $2 cidr  $3 az  $4 statekey
  local sid
  sid=$(aws ec2 describe-subnets --region "$CA_REGION" \
    --filters "Name=tag:Name,Values=$1" "Name=vpc-id,Values=$VPC_ID" \
    --query 'Subnets[0].SubnetId' --output text)
  if [ -z "$sid" ] || [ "$sid" = "None" ]; then
    sid=$(aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block "$2" --availability-zone "$3" \
      --region "$CA_REGION" \
      --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$1},{Key=Project,Value=digby-ca}]" \
      --query 'Subnet.SubnetId' --output text)
    log "✔ created subnet $1 $sid ($2 in $3)"
  else
    log "✔ subnet exists: $1 $sid"
  fi
  aws ec2 modify-subnet-attribute --subnet-id "$sid" --map-public-ip-on-launch '{"Value":true}' --region "$CA_REGION"
  state_set "$4" "$sid"
}
make_subnet "$SUBNET_A_NAME" "$SUBNET_A_CIDR" "$AZ_A" SUBNET_A_ID
make_subnet "$SUBNET_B_NAME" "$SUBNET_B_CIDR" "$AZ_B" SUBNET_B_ID

# ── Internet gateway + routing ────────────────────────────────────────────────
IGW_ID=$(aws ec2 describe-internet-gateways --region "$CA_REGION" \
  --filters "Name=tag:Name,Values=example-ca-node" --query 'InternetGateways[0].InternetGatewayId' --output text)
if [ -z "$IGW_ID" ] || [ "$IGW_ID" = "None" ]; then
  IGW_ID=$(aws ec2 create-internet-gateway --region "$CA_REGION" \
    --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=example-ca-node},{Key=Project,Value=digby-ca}]" \
    --query 'InternetGateway.InternetGatewayId' --output text)
  log "✔ created IGW $IGW_ID"
fi
ATTACHED=$(aws ec2 describe-internet-gateways --internet-gateway-ids "$IGW_ID" --region "$CA_REGION" \
  --query "InternetGateways[0].Attachments[?VpcId=='$VPC_ID'].State | [0]" --output text)
if [ "$ATTACHED" != "available" ]; then
  aws ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" --region "$CA_REGION"
  log "✔ attached IGW $IGW_ID to $VPC_ID"
fi

RT_ID=$(aws ec2 describe-route-tables --region "$CA_REGION" \
  --filters "Name=tag:Name,Values=example-ca-node" "Name=vpc-id,Values=$VPC_ID" \
  --query 'RouteTables[0].RouteTableId' --output text)
if [ -z "$RT_ID" ] || [ "$RT_ID" = "None" ]; then
  RT_ID=$(aws ec2 create-route-table --vpc-id "$VPC_ID" --region "$CA_REGION" \
    --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=example-ca-node},{Key=Project,Value=digby-ca}]" \
    --query 'RouteTable.RouteTableId' --output text)
  log "✔ created route table $RT_ID"
fi
aws ec2 create-route --route-table-id "$RT_ID" --destination-cidr-block 0.0.0.0/0 \
  --gateway-id "$IGW_ID" --region "$CA_REGION" >/dev/null 2>&1 || true
for sk in SUBNET_A_ID SUBNET_B_ID; do
  sid=$(state_get "$sk")
  ASSOC=$(aws ec2 describe-route-tables --route-table-ids "$RT_ID" --region "$CA_REGION" \
    --query "RouteTables[0].Associations[?SubnetId=='$sid'].RouteTableAssociationId | [0]" --output text)
  if [ -z "$ASSOC" ] || [ "$ASSOC" = "None" ]; then
    aws ec2 associate-route-table --route-table-id "$RT_ID" --subnet-id "$sid" --region "$CA_REGION" >/dev/null
    log "✔ associated $sid with $RT_ID"
  fi
done

# ── Security groups ───────────────────────────────────────────────────────────
mk_sg() { # $1 name  $2 description  $3 statekey
  local gid
  gid=$(aws ec2 describe-security-groups --region "$CA_REGION" \
    --filters "Name=group-name,Values=$1" "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' --output text)
  if [ -z "$gid" ] || [ "$gid" = "None" ]; then
    gid=$(aws ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC_ID" \
      --region "$CA_REGION" \
      --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$1},{Key=Project,Value=digby-ca}]" \
      --query 'GroupId' --output text)
    log "✔ created SG $1 $gid"
  else
    log "✔ SG exists: $1 $gid"
  fi
  state_set "$3" "$gid"
}
mk_sg "$ALB_SG_NAME" "Digby ALB - public 443/80" ALB_SG_ID
mk_sg "$APP_SG_NAME" "Digby app instances - ALB + SSH only" APP_SG_ID

ALB_SG_ID=$(state_get ALB_SG_ID); APP_SG_ID=$(state_get APP_SG_ID)
add_ingress() { # $1 sg  $2 port  $3 cidr-or-sg  ($4 = "sg" if source group)
  local src_json
  if [ "${4:-}" = "sg" ]; then
    src_json="[{\"IpProtocol\":\"tcp\",\"FromPort\":$2,\"ToPort\":$2,\"UserIdGroupPairs\":[{\"GroupId\":\"$3\"}]}]"
  else
    src_json="[{\"IpProtocol\":\"tcp\",\"FromPort\":$2,\"ToPort\":$2,\"IpRanges\":[{\"CidrIp\":\"$3\"}]}]"
  fi
  aws ec2 authorize-security-group-ingress --group-id "$1" --ip-permissions "$src_json" \
    --region "$CA_REGION" >/dev/null 2>&1 || true
}
add_ingress "$ALB_SG_ID" 443 0.0.0.0/0
add_ingress "$ALB_SG_ID" 80  0.0.0.0/0
add_ingress "$APP_SG_ID" 443 "$ALB_SG_ID" sg   # ALB → nginx TLS (ALB ignores target cert validity)
add_ingress "$APP_SG_ID" 80  "$ALB_SG_ID" sg   # spare (plain-HTTP target option)
add_ingress "$APP_SG_ID" 22  0.0.0.0/0          # GitHub Actions SSH deploy (same posture as prod today)
log "✔ SG rules in place"

# ── IAM role + instance profile (S3 backup put, same as prod + SSM) ──────────
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$CA_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$CA_ROLE_NAME" --assume-role-policy-document "$TRUST" \
    --tags Key=Project,Value=digby-ca >/dev/null
  log "✔ created IAM role $CA_ROLE_NAME"
else
  log "✔ role exists: $CA_ROLE_NAME"
fi
S3POLICY=$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"PutBackupObjects","Effect":"Allow","Action":["s3:PutObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":"arn:aws:s3:::${BACKUP_BUCKET}/*"},
 {"Sid":"ListOwnBucket","Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],"Resource":"arn:aws:s3:::${BACKUP_BUCKET}"}]}
JSON
)
aws iam put-role-policy --role-name "$CA_ROLE_NAME" --policy-name digby-backups-prod-put \
  --policy-document "$S3POLICY"
aws iam attach-role-policy --role-name "$CA_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
if ! aws iam get-instance-profile --instance-profile-name "$CA_PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$CA_PROFILE_NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$CA_PROFILE_NAME" --role-name "$CA_ROLE_NAME"
  log "✔ created instance profile $CA_PROFILE_NAME (+role)"
else
  log "✔ instance profile exists: $CA_PROFILE_NAME"
fi
state_set CA_PROFILE_NAME "$CA_PROFILE_NAME"

log "✅ foundation complete. State:"
grep -E '^(VPC_ID|SUBNET_._ID|ALB_SG_ID|APP_SG_ID)=' "$STATE_FILE" | sed 's/^/   /'

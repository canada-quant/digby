#!/usr/bin/env bash
# 20-acm-and-alb.sh — ACM certificate (DNS-validated via Cloudflare API) +
# internet-facing ALB with HTTPS:443 → target group (HTTPS:443 to instance
# nginx) and HTTP:80 → 301 redirect.
#
# Requires: 10-foundation.sh already run (state.env populated).
# Requires: CLOUDFLARE_API_TOKEN in env (for cert validation CNAMEs).
# Safe to re-run. Prod impact: NONE (adds two harmless _acme-validation-style
# CNAMEs to the digby.ai zone; the A record is untouched).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/00-config.sh"
require_aws
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN not set (needed for ACM DNS validation)"

VPC_ID=$(state_get VPC_ID);        SUBNET_A_ID=$(state_get SUBNET_A_ID)
SUBNET_B_ID=$(state_get SUBNET_B_ID); ALB_SG_ID=$(state_get ALB_SG_ID)
[ -n "$VPC_ID" ] && [ -n "$SUBNET_A_ID" ] && [ -n "$SUBNET_B_ID" ] && [ -n "$ALB_SG_ID" ] \
  || die "state.env missing foundation IDs — run 10-foundation.sh first"

# ── ACM certificate ───────────────────────────────────────────────────────────
CERT_ARN=$(aws acm list-certificates --region "$CA_REGION" --certificate-statuses ISSUED PENDING_VALIDATION \
  --query "CertificateSummaryList[?DomainName=='digby.ai'].CertificateArn | [0]" --output text)
if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  CERT_ARN=$(aws acm request-certificate --region "$CA_REGION" \
    --domain-name "digby.ai" --subject-alternative-names "www.digby.ai" \
    --validation-method DNS \
    --tags Key=Project,Value=digby-ca \
    --query 'CertificateArn' --output text)
  log "✔ requested ACM cert $CERT_ARN"
else
  log "✔ cert exists: $CERT_ARN"
fi
state_set CERT_ARN "$CERT_ARN"

# ── Validation CNAMEs → Cloudflare ────────────────────────────────────────────
log "⏳ waiting for ACM to emit validation records..."
for i in $(seq 1 30); do
  RECORDS=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$CA_REGION" \
    --query 'DomainValidationOptions[?ResourceRecord!=`null`].[ResourceRecord.Name,ResourceRecord.Value]' \
    --output text 2>/dev/null || true)
  [ -n "$RECORDS" ] && break
  sleep 5
done
[ -n "$RECORDS" ] || die "ACM never emitted validation records"

# Create the CNAMEs via the Cloudflare API (idempotent). Python builds the JSON
# payloads — a prior shell-quoting version of this loop was rejected by CF
# (error 9007) — and an early ACM describe may emit only SOME domains, so any
# record missing here is created on the NEXT run of this script (or manually).
export VALIDATION_RECORDS="$RECORDS" CF_ZONE_ID
python3 - <<'PYEOF'
import json, os, urllib.request
token = os.environ["CLOUDFLARE_API_TOKEN"]
zone = os.environ["CF_ZONE_ID"]
def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4{path}",
        data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)
for line in os.environ["VALIDATION_RECORDS"].splitlines():
    parts = line.split()
    if len(parts) < 2:
        continue
    name, content = parts[0].rstrip("."), parts[1].rstrip(".")
    existing = call("GET", f"/zones/{zone}/dns_records?type=CNAME&name={name}")
    if existing.get("result"):
        print(f"✔ validation CNAME already present: {name}")
        continue
    d = call("POST", f"/zones/{zone}/dns_records",
             {"type": "CNAME", "name": name, "content": content, "ttl": 300, "proxied": False})
    print((f"✔ created validation CNAME {name}") if d["success"] else f"❌ CF error for {name}: {d['errors']}")
PYEOF

log "⏳ waiting for ACM validation (Cloudflare propagation is usually <2 min)..."
for i in $(seq 1 40); do
  STATUS=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --region "$CA_REGION" \
    --query 'Certificate.Status' --output text)
  [ "$STATUS" = "ISSUED" ] && { log "✔ cert ISSUED"; break; }
  sleep 15
  [ "$i" = "40" ] && die "cert still $STATUS after 10 min — re-run this script to continue waiting"
done

# ── ALB ───────────────────────────────────────────────────────────────────────
ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$CA_REGION" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  ALB_ARN=$(aws elbv2 create-load-balancer --name "$ALB_NAME" --region "$CA_REGION" \
    --type application --scheme internet-facing --ip-address-type ipv4 \
    --subnets "$SUBNET_A_ID" "$SUBNET_B_ID" --security-groups "$ALB_SG_ID" \
    --tags Key=Name,Value=$ALB_NAME Key=Project,Value=digby-ca \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  log "✔ created ALB $ALB_NAME"
else
  log "✔ ALB exists: $ALB_NAME"
fi
# 60s deregistration delay to mirror the box's current 60s drain behaviour
state_set ALB_ARN "$ALB_ARN"
ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --region "$CA_REGION" \
  --query 'LoadBalancers[0].DNSName' --output text)
state_set ALB_DNS "$ALB_DNS"

# ── Target group: HTTPS:443 to the box nginx (ALB does not validate target
#    certs, so the instance's existing LE cert for digby.ai is fine). Health
#    check hits the backend through nginx; matcher stays lenient until the
#    smoke test confirms what nginx answers for a non-digby.ai Host header. ──
TG_ARN=$(aws elbv2 describe-target-groups --names "$TG_NAME" --region "$CA_REGION" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN=$(aws elbv2 create-target-group --name "$TG_NAME" --region "$CA_REGION" \
    --protocol HTTPS --port 443 --vpc-id "$VPC_ID" --target-type instance \
    --health-check-protocol HTTPS --health-check-path /api/health \
    --health-check-interval-seconds 15 --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 2 \
    --matcher HttpCode=200-399 \
    --tags Key=Name,Value=$TG_NAME Key=Project,Value=digby-ca \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  log "✔ created target group $TG_NAME"
else
  log "✔ target group exists: $TG_NAME"
  # Keep the tuned thresholds idempotent on re-runs (15s/2+2 = ~30s hard-failure
  # detection; tuned during the 2026-07-29 failure drills — see README).
  aws elbv2 modify-target-group --target-group-arn "$TG_ARN" --region "$CA_REGION" \
    --health-check-interval-seconds 15 --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 2 >/dev/null
fi
state_set TG_ARN "$TG_ARN"
aws elbv2 modify-target-group-attributes --target-group-arn "$TG_ARN" --region "$CA_REGION" \
  --attributes Key=deregistration_delay.timeout_seconds,Value=60 >/dev/null

# ── Listeners ─────────────────────────────────────────────────────────────────
L443=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$CA_REGION" \
  --query "Listeners[?Port==\`443\`].ListenerArn | [0]" --output text)
if [ -z "$L443" ] || [ "$L443" = "None" ]; then
  aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --region "$CA_REGION" \
    --protocol HTTPS --port 443 --certificates CertificateArn="$CERT_ARN" \
    --default-actions Type=forward,TargetGroupArn="$TG_ARN" >/dev/null
  log "✔ listener :443 → $TG_NAME (ACM cert)"
fi
L80=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$CA_REGION" \
  --query "Listeners[?Port==\`80\`].ListenerArn | [0]" --output text)
if [ -z "$L80" ] || [ "$L80" = "None" ]; then
  aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --region "$CA_REGION" \
    --protocol HTTP --port 80 \
    --default-actions "Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}" >/dev/null
  log "✔ listener :80 → 301 https"
fi

log "✅ ACM + ALB complete."
log "   ALB DNS: $ALB_DNS"
log "   Smoke-test after staging is up:  curl -sk --resolve digby.ai:443:<alb-ip> https://digby.ai/api/health"

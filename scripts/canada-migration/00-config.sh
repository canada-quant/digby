# 00-config.sh — shared constants + helpers for the ca-central-1 migration.
# Sourced by every script in this directory. No secrets live here.
#
# Context: prod today is a SINGLE t3.large in us-east-1 (blue-green on one box,
# nginx flip). Target: internet-facing ALB + 2 app instances across 2 AZs in
# ca-central-1 (Montreal). See README.md in this directory for the full runbook
# and docs/archive/LOAD-BALANCING-CANADA.md for the approved plan.

set -euo pipefail

# ── Source (current prod) ─────────────────────────────────────────────────────
PROD_REGION="us-east-1"
PROD_INSTANCE_ID="i-0123456789abcdef0"     # "EC2 - Digby - Prod" (t3.large)
PROD_KEY_NAME="crossmodel-prod"            # imported into ca-central-1 verbatim

# ── Target region ─────────────────────────────────────────────────────────────
CA_REGION="ca-central-1"
AZ_A="ca-central-1a"
AZ_B="ca-central-1b"

# ── Network (dedicated VPC — prod uses the default VPC; we build clean) ───────
VPC_NAME="example-ca-node"
VPC_CIDR="10.60.0.0/16"
SUBNET_A_NAME="example-ca-node"
SUBNET_A_CIDR="10.60.1.0/24"
SUBNET_B_NAME="example-ca-node"
SUBNET_B_CIDR="10.60.2.0/24"

# ── Security groups ───────────────────────────────────────────────────────────
ALB_SG_NAME="digby-alb-sg"
APP_SG_NAME="digby-app-sg"

# ── IAM ───────────────────────────────────────────────────────────────────────
CA_ROLE_NAME="example-ec2-role"
CA_PROFILE_NAME="digby-ec2-ca-profile"
BACKUP_BUCKET="digby-backups-prod"         # same bucket as prod backups

# ── ALB / ACM ─────────────────────────────────────────────────────────────────
ALB_NAME="digby-alb"
TG_NAME="digby-app-tg"
CERT_DOMAINS=("digby.ai" "www.digby.ai")
CF_ZONE_ID="6e88d4ef896571cb06de397e92e7e677"   # Cloudflare zone for digby.ai

# ── Staging instance ──────────────────────────────────────────────────────────
STAGING_NAME="example-ca-primary"
STAGING_TYPE="t3.large"                    # same class as prod

# ── State file (resource IDs discovered/created at runtime; NOT committed) ────
STATE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/state.env"
touch "$STATE_FILE"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
die()  { echo "❌ $*" >&2; exit 1; }

# state_set KEY VALUE — upsert into state.env
state_set() {
  local k="$1" v="$2"
  grep -v "^${k}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
  echo "${k}=${v}" >> "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "$STATE_FILE"
}
# state_get KEY — empty string if unset
state_get() { grep "^$1=" "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# require_aws — fail fast with a clear message if creds/CLI are missing
require_aws() {
  command -v aws >/dev/null || die "aws CLI not found"
  aws sts get-caller-identity >/dev/null 2>&1 || die "AWS credentials not usable"
}

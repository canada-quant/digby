#!/usr/bin/env bash
# rotate-db-password.sh — issue #131 durable fix, leg 2: rotate the app DB
# password ONCE and fan it out to EVERY fleet box. Replaces the hand-sync that
# crash-looped app-b (#128/#131: password rotated on the primary, never
# propagated, P1000 for hours).
#
# Run from any operator shell whose AWS creds allow ssm:SendCommand +
# ssm:GetParameter on /example/ca/rds/* (e.g. a Digby coding session):
#
#   bash scripts/deploy/rotate-db-password.sh [--dry-run]
#
# Flow — the new password NEVER transits the operator shell, a transcript, or
# an SSM command parameter (those land in CloudTrail):
#   1. SSM → PRIMARY instance: generate a 32-char alnum password ON THE BOX,
#      read the MASTER credential from the store on-box, ALTER ROLE <app user>
#      via psql-in-docker (no host psql needed), then write the new password
#      to the app-password SSM param. Only a sha256 prefix comes back.
#   2. Fan-out: SSM → EVERY instance in INSTANCES: sync-db-secret.sh with
#      STRICT=1 — each box re-stages DATABASE_URL + POSTGRES_PASSWORD from the
#      store into its env-overrides.env.
#   3. Verify: SSM → every instance: sync-db-secret.sh MODE=verify; the
#      operator independently hashes the store value — all hashes must agree.
#   4. Prints the go-live instruction. Running containers keep their
#      start-time env, and after step 1 the DB no longer accepts the OLD
#      password for NEW connections — so trigger a deploy (health-gated,
#      auto-rollback) PROMPTLY; do not leave the fleet half-switched.
#
# Prereqs (one-time, docs/DB_SECRET_ROTATION.md):
#   - SSM params: /example/ca/rds/master-password (SecureString, master user),
#     /example/ca/rds/app-password (SecureString, app role), /example/ca/rds/endpoint
#     (String, "host:port/db[?query]").
#   - Box instance role: ssm:GetParameter + ssm:PutParameter on /example/ca/rds/*.
#   - Boxes: docker (for the psql client image), aws CLI, SSM agent Online.
set -u
export LC_ALL=C

REGION="${REGION:-ca-central-1}"
PRIMARY="${PRIMARY:-i-0123456789abcdef0}"
INSTANCES="${INSTANCES:-i-0123456789abcdef0 i-0123456789abcdef0 i-0123456789abcdef0}"
MASTER_PARAM="${MASTER_PARAM:-/example/ca/rds/master-password}"
APP_PARAM="${APP_PARAM:-/example/ca/rds/app-password}"
ENDPOINT_PARAM="${ENDPOINT_PARAM:-/example/ca/rds/endpoint}"
APP_USER="${APP_USER:-admin}"
MASTER_USER="${MASTER_USER:-digbyadmin}"
PSQL_IMAGE="${PSQL_IMAGE:-postgres:16-alpine}"
SYNC_SCRIPT="${SYNC_SCRIPT:-$(dirname "$0")/sync-db-secret.sh}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

die() { echo "ERROR(rotate-db-password): $*" >&2; exit 1; }
sha16() { printf '%s' "$1" | sha256sum | cut -c1-16; }

[ -f "$SYNC_SCRIPT" ] || die "sync script not found at $SYNC_SCRIPT"
command -v aws >/dev/null || die "aws CLI not found"
command -v base64 >/dev/null || die "base64 not found"

# SSM send-command + poll; prints the invocation stdout; rc non-zero on failure.
# $1=instance $2=base64-of-script
ssm_run() {
  local id=$1 b64=$2 cmd rc
  cmd=$(aws ssm send-command --region "$REGION" --instance-ids "$id" \
        --document-name AWS-RunShellScript \
        --parameters "{\"commands\":[\"echo $b64 | base64 -d | sudo bash\"]}" \
        --query Command.CommandId --output text 2>/dev/null) || return 1
  [ -n "$cmd" ] && [ "$cmd" != "None" ] || return 1
  local i st
  for i in $(seq 1 40); do
    st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cmd" \
         --instance-id "$id" --query Status --output text 2>/dev/null)
    case "$st" in
      Success|Failed|Cancelled|TimedOut) break ;;
      *) sleep 5 ;;
    esac
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd" \
    --instance-id "$id" --query StandardOutputContent --output text 2>/dev/null
  if [ "$st" != "Success" ]; then
    # Surface the box's stderr for diagnosis (labeled; box payloads never
    # print secrets to either stream).
    aws ssm get-command-invocation --region "$REGION" --command-id "$cmd" \
      --instance-id "$id" --query StandardErrorContent --output text 2>/dev/null \
      | sed 's/^/  [box-stderr] /' >&2
  fi
  [ "$st" = "Success" ]
}

# Step-1 payload: generate + ALTER ROLE + store, all on the primary box.
# Password is 32-char alnum (URL-safe by construction; the sync step still
# RFC-3986-encodes whatever the store holds). put-parameter is guarded: if the
# store write fails AFTER the ALTER, the role is ALTERed back to the previous
# password (read from the store up front) — otherwise the new password would
# exist only in this shell's memory and the fleet could never learn it.
box_payload() {
  cat <<EOF
set -eu
export LC_ALL=C
NEW=\$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)
[ \${#NEW} -eq 32 ] || { echo 'ERROR: password generation failed' >&2; exit 1; }
MASTER=\$(aws ssm get-parameter --region $REGION --name $MASTER_PARAM --with-decryption --query Parameter.Value --output text)
OLD=\$(aws ssm get-parameter --region $REGION --name $APP_PARAM --with-decryption --query Parameter.Value --output text 2>/dev/null || true)
EP=\$(aws ssm get-parameter --region $REGION --name $ENDPOINT_PARAM --query Parameter.Value --output text)
EPHOST=\${EP%%/*}; EPDB=\${EP#*/}; EPDB=\${EPDB%%\\?*}
EPPORT=\${EPHOST##*:}; EPHOSTNAME=\${EPHOST%:*}
alter_role() {
  sudo docker run --rm -e PGPASSWORD="\$MASTER" $PSQL_IMAGE \
    psql "host=\$EPHOSTNAME port=\$EPPORT user=$MASTER_USER dbname=\$EPDB sslmode=require connect_timeout=15" \
    -v ON_ERROR_STOP=1 -c "ALTER ROLE $APP_USER WITH LOGIN PASSWORD '\$1';"
}
alter_role "\$NEW"
if ! aws ssm put-parameter --region $REGION --name $APP_PARAM --type SecureString --overwrite \
     --value "\$NEW" --description "App DB role ($APP_USER) password — rotated \$(date -u +%FT%TZ) by rotate-db-password.sh" >/dev/null; then
  echo 'put-parameter FAILED after ALTER — rolling the role back to the previous password' >&2
  if [ -n "\$OLD" ]; then
    alter_role "\$OLD" && echo 'rollback OK: role restored to the previous password' \
      || echo 'ERROR: ROLLBACK ALTER FAILED — re-run rotation immediately (master credential still works)' >&2
  else
    echo 'ERROR: no previous password in the store to roll back to — re-run rotation immediately' >&2
  fi
  exit 1
fi
echo "rotate-payload OK: role $APP_USER password rotated + stored in $APP_PARAM; sha256-16=\$(printf '%s' "\$NEW" | sha256sum | cut -c1-16)"
unset NEW MASTER OLD
EOF
}

echo "== rotate-db-password =="
echo "region=$REGION primary=$PRIMARY app-user=$APP_USER instances: $INSTANCES"
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would: (1) rotate $APP_USER on $PRIMARY via psql-in-docker + store to $APP_PARAM"
  echo "[dry-run] would: (2) STRICT-fan-out sync-db-secret.sh to: $INSTANCES"
  echo "[dry-run] would: (3) verify hash parity on every instance + against the store"
  echo "[dry-run] box payload:"; box_payload | sed 's/^/[dry-run]   /'
  exit 0
fi

# --- 1. rotate on the primary ----------------------------------------------
echo "--- step 1: rotate $APP_USER on $PRIMARY (password generated + stored on-box) ---"
OUT=$(ssm_run "$PRIMARY" "$(box_payload | base64 -w0)") || die "rotation payload failed on $PRIMARY: $OUT"
echo "$OUT" | sed 's/^/  /'
NEWHASH=$(printf '%s\n' "$OUT" | grep -o 'sha256-16=[0-9a-f]*' | cut -d= -f2)
[ -n "$NEWHASH" ] || die "rotation payload did not report a hash"

# --- 2. STRICT fan-out ------------------------------------------------------
echo "--- step 2: STRICT fan-out of sync-db-secret.sh to every instance ---"
SYNCB64=$(base64 -w0 "$SYNC_SCRIPT")
FAILED=''
for ID in $INSTANCES; do
  echo "  -> $ID"
  # One payload per box: write the script to a temp path, run it STRICT, clean up.
  OUT=$(ssm_run "$ID" "$( { printf 'echo %s | base64 -d > /tmp/.sync-db-secret.$$.sh\n' "$SYNCB64"; printf 'STRICT=1 bash /tmp/.sync-db-secret.$$.sh; rc=$?; rm -f /tmp/.sync-db-secret.$$.sh; exit $rc\n'; } | base64 -w0)") \
    || { FAILED="$FAILED $ID"; echo "  FAILED(sync) $ID: $OUT" >&2; continue; }
  echo "$OUT" | grep -q 'synced:\|already in sync' || { FAILED="$FAILED $ID"; echo "  FAILED(sync) $ID: $OUT" >&2; continue; }
  echo "$OUT" | sed 's/^/    /'
done
[ -z "$FAILED" ] || die "fan-out failed on:$FAILED — those boxes still hold the OLD password; re-run sync-db-secret.sh there before the next deploy (docs/DB_SECRET_ROTATION.md)"

# --- 3. verify parity everywhere ---------------------------------------------
echo "--- step 3: verify hash parity ---"
STOREHASH=$(aws ssm get-parameter --region "$REGION" --name "$APP_PARAM" --with-decryption \
            --query Parameter.Value --output text 2>/dev/null | tr -d '\n' | sha256sum | cut -c1-16)
[ -n "$STOREHASH" ] || die "cannot read $APP_PARAM for verification"
[ "$STOREHASH" = "$NEWHASH" ] || die "store hash $STOREHASH != rotated hash $NEWHASH (put-parameter divergence?!)"
for ID in $INSTANCES; do
  OUT=$(ssm_run "$ID" "$( { printf 'echo %s | base64 -d > /tmp/.sync-db-secret.$$.sh\n' "$SYNCB64"; printf 'MODE=verify bash /tmp/.sync-db-secret.$$.sh; rc=$?; rm -f /tmp/.sync-db-secret.$$.sh; exit $rc\n'; } | base64 -w0)") \
    || die "verify failed on $ID: $OUT"
  echo "  $ID: $OUT"
  printf '%s' "$OUT" | grep -q "verify OK.*$STOREHASH" || die "hash mismatch on $ID"
done

echo "== rotation complete: role $APP_USER password sha256-16=$STOREHASH on $PRIMARY + staged on: $INSTANCES =="
echo
echo "GO-LIVE (required, prompt): running containers still hold the OLD password and the DB"
echo "no longer accepts it for NEW connections. Trigger a deploy NOW (health-gated + auto-rollback):"
echo "  gh workflow run deploy.yml --repo example-org/crossmodel"
echo "or push any commit to main. Watch both ALB targets return to healthy."

#!/usr/bin/env bash
# sync-db-secret.sh — issue #131 durable fix, leg 1: every app box PULLS the DB
# credential from the single source of truth (AWS SSM Parameter Store
# SecureString) instead of relying on a hand-synced env value. A password
# rotated into the store now propagates to every box on the next deploy (or
# immediately via the rotation fan-out in rotate-db-password.sh) instead of
# crash-looping the boxes someone forgot to hand-sync (#128/#131: P1000).
#
# Runs ON each box: deploy.yml scp+execs it on every EC2_HOSTS box right before
# "Apply box-local env overrides" (and the coding-box step runs it from the
# rsync'd tree); rotate-db-password.sh ships it to every fleet instance via SSM
# for the STRICT rotation fan-out. It fetches the app DB password with the
# box's instance role, URL-encodes it (RFC 3986 userinfo), and merge-stages
# DATABASE_URL + POSTGRES_PASSWORD into the box-local overrides file
# (/opt/crossmodel-local/env-overrides.env) — the file deploy.yml then folds
# into /opt/crossmodel/.env. Every other key in the file is left untouched.
#
# OUTPUT CONTRACT: key names, endpoint host, and a sha256 prefix of the RAW
# password only — secret values (raw or encoded) never reach stdout/stderr.
#
# Transport note (ticket 19ddfe80): this script is scp'd to the box and exec'd
# with stdin from /dev/null — never pipe it over ssh stdin.
#
# Env knobs (all optional):
#   DB_SECRET_PARAM    SSM SecureString holding the RAW app password
#                      (/example/ca/rds/app-password)
#   DB_ENDPOINT_PARAM  SSM String "host:port/dbname[?query]" — non-secret
#                      (/example/ca/rds/endpoint)
#   DB_USER            role the app connects as            (admin)
#   AWS_REGION                                             (ca-central-1)
#   OVERRIDES_FILE     box-local overrides file
#                      (/opt/crossmodel-local/env-overrides.env)
#   STRICT=1           any failure exits 1. Default is warn + exit 0, so a
#                      store/IAM hiccup can never block a fleet deploy (the
#                      box keeps its last-good credential). The rotation
#                      fan-out always runs STRICT=1.
#   MODE=verify        no writes: report store-vs-staged password-hash parity;
#                      exit 0 on match, 1 on mismatch/unreadable/absent.
set -u
export LC_ALL=C

DB_SECRET_PARAM="${DB_SECRET_PARAM:-/example/ca/rds/app-password}"
DB_ENDPOINT_PARAM="${DB_ENDPOINT_PARAM:-/example/ca/rds/endpoint}"
DB_USER="${DB_USER:-admin}"
AWS_REGION="${AWS_REGION:-ca-central-1}"
OVERRIDES_FILE="${OVERRIDES_FILE:-/opt/crossmodel-local/env-overrides.env}"
STRICT="${STRICT:-0}"
MODE="${MODE:-sync}"

warn() { echo "WARNING(sync-db-secret): $*" >&2; }
die()  { echo "ERROR(sync-db-secret): $*" >&2; exit 1; }
# soft-fail: STRICT → die; otherwise warn + exit 0 (deploy continues).
soft() { if [ "$STRICT" = "1" ]; then die "$1"; else warn "$1"; exit 0; fi; }

sha16() { printf '%s' "$1" | sha256sum | cut -c1-16; }

# RFC 3986 userinfo percent-encoding: every byte outside unreserved
# (A-Z a-z 0-9 - . _ ~) becomes %XX. LC_ALL=C keeps indexing byte-wise, so
# multi-byte UTF-8 is encoded byte-by-byte (correct for URIs).
urlencode() {
  local s=$1 i c h o=''
  for (( i=0; i<${#s}; i++ )); do
    c=${s:i:1}
    case "$c" in
      [a-zA-Z0-9._~-]) o+="$c" ;;
      *) printf -v h '%%%02X' "'$c"; o+="$h" ;;
    esac
  done
  printf '%s' "$o"
}

# Inverse of urlencode. NO '+'→space mapping: URL userinfo is not form data.
urldecode() { printf '%b' "${1//%/\\x}"; }

# Read a possibly root-owned file (ticket 18787730): plain cat, then sudo -n.
read_file() { cat "$1" 2>/dev/null || sudo -n cat "$1" 2>/dev/null; }

# Raw SSM parameter value on stdout, empty on any failure (never logged).
fetch_param() {
  aws ssm get-parameter --region "$AWS_REGION" --name "$1" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null
}

# Parse "host:port/db[?query]" into EP_HOSTPORT / EP_DB / EP_QUERY. rc 1 if
# the shape is not host[:port]/db.
parse_endpoint() {
  local ep=$1
  EP_QUERY=''
  case "$ep" in
    *\?*) EP_QUERY=${ep#*\?}; ep=${ep%%\?*} ;;
  esac
  case "$ep" in
    */*) EP_HOSTPORT=${ep%%/*}; EP_DB=${ep#*/} ;;
    *)   return 1 ;;
  esac
  [ -n "$EP_HOSTPORT" ] && [ -n "$EP_DB" ]
}

# Parse a full DATABASE_URL (postgresql://user:pw@host:port/db?query) into the
# same EP_* vars. rc 1 if unparseable. Splits at the LAST '@' — libpq/WHATWG
# semantics — so even a legacy URL with a raw, unencoded '@' inside the
# password (the exact bug class this fix removes) yields the right endpoint.
parse_current_url() {
  local rest=${1#*://}
  [ "$rest" = "$1" ] && return 1
  case "$rest" in
    *@*) rest=${rest##*@} ;;
    *)   return 1 ;;
  esac
  parse_endpoint "$rest"
}

# Update KEY=VALUE in $1 in place, or append when absent. Same escaping rules
# as apply-env-overrides.sh (sed RHS: \ & |).
stage_key() {
  local esc
  if grep -q "^$2=" "$1"; then
    esc=$(printf '%s=%s' "$2" "$3" | sed 's/[\\&|]/\\&/g')
    sed -i "s|^$2=.*|$esc|" "$1"
  else
    printf '%s=%s\n' "$2" "$3" >> "$1"
  fi
}

# Extract the password component of a staged DATABASE_URL: userinfo is
# everything before the LAST '@' (libpq/WHATWG semantics). An encoded password
# contains no raw '@', so encoded staging is unaffected; for a legacy staged
# URL with a raw '@' in the password this still recovers the same password the
# app's own driver would use — so MODE=verify can't false-OK a broken URL.
staged_password() { # $1 = DATABASE_URL value
  local rest=${1#*://}
  [ "$rest" = "$1" ] && return 1
  case "$rest" in
    *@*) : ;;
    *)   return 1 ;;
  esac
  local ui=${rest%@*}
  case "$ui" in
    *:*) printf '%s' "${ui#*:}" ;;
    *)   return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
PW=$(fetch_param "$DB_SECRET_PARAM") || PW=''
[ -n "$PW" ] || soft "cannot read $DB_SECRET_PARAM (region $AWS_REGION) — keeping the existing credential. The box instance role needs ssm:GetParameter on /example/ca/rds/*; see docs/DB_SECRET_ROTATION.md"
# Store values must be single-line: a CR/LF would stage extra KEY=VALUE lines
# into env-overrides.env (POSTGRES_PASSWORD is staged raw) which fold into
# prod .env on the next deploy — arbitrary container-env injection from a bad
# paste or a compromised writer (adversarial review, issue #131).
case "$PW" in
  *$'\n'*|*$'\r'*) soft "$DB_SECRET_PARAM value contains a newline — refusing to stage (store values must be single-line)" ;;
esac

CUR=''
if [ -e "$OVERRIDES_FILE" ] || sudo -n test -e "$OVERRIDES_FILE" 2>/dev/null; then
  CUR=$(read_file "$OVERRIDES_FILE") || soft "$OVERRIDES_FILE exists but is unreadable (plain AND sudo -n) — see ticket 18787730 remediation"
fi
CURL=$(printf '%s\n' "$CUR" | grep -m1 '^DATABASE_URL=' | cut -d= -f2-) || CURL=''

# ---- verify mode: hash parity, no writes -----------------------------------
if [ "$MODE" = "verify" ]; then
  [ -n "$CURL" ] || { echo "verify MISMATCH: no DATABASE_URL staged in $OVERRIDES_FILE" >&2; exit 1; }
  SPW=$(staged_password "$CURL") || { echo "verify MISMATCH: staged DATABASE_URL is unparseable" >&2; exit 1; }
  S=$(sha16 "$PW")
  T=$(sha16 "$(urldecode "$SPW")")
  if [ "$S" = "$T" ]; then
    echo "verify OK: staged credential matches $DB_SECRET_PARAM (sha256-16 $S)"
    exit 0
  fi
  echo "verify MISMATCH: staged sha256-16 $T != store sha256-16 $S" >&2
  exit 1
fi

# ---- endpoint: store param wins; fall back to the currently staged URL -----
EP=$(fetch_param "$DB_ENDPOINT_PARAM") || EP=''
if [ -n "$EP" ]; then
  case "$EP" in
    *$'\n'*|*$'\r'*) soft "$DB_ENDPOINT_PARAM value contains a newline — refusing to stage (store values must be single-line)" ;;
  esac
  parse_endpoint "$EP" || soft "$DB_ENDPOINT_PARAM is malformed (want host:port/db[?query]): value shape rejected"
else
  [ -n "$CURL" ] || soft "no $DB_ENDPOINT_PARAM in SSM and no staged DATABASE_URL to derive the endpoint from — seed one of them first (docs/DB_SECRET_ROTATION.md)"
  parse_current_url "$CURL" || soft "staged DATABASE_URL is unparseable (need user:pw@host:port/db[?query])"
fi

ENC=$(urlencode "$PW")
NEW_URL="postgresql://$DB_USER:$ENC@$EP_HOSTPORT/$EP_DB"
[ -n "$EP_QUERY" ] && NEW_URL="$NEW_URL?$EP_QUERY"

# ---- idempotence probe: is the exact pair already staged? -------------------
IN_SYNC=0
if printf '%s\n' "$CUR" | grep -qF "DATABASE_URL=$NEW_URL" \
   && printf '%s\n' "$CUR" | grep -qF "POSTGRES_PASSWORD=$PW"; then
  IN_SYNC=1
fi

# ---- Live-auth guard (runs AFTER the idempotence probe — FO firing 37) ------
# A well-formed-but-WRONG store value must never reach the overrides file — a
# compromised writer (any box role can PutParameter, by design so box A can
# rotate) could otherwise stage a bogus password and take the whole fleet down
# at the next deploy (adversarial review, issue #131). When docker is available
# (all prod boxes), authenticate as the app role with the store password
# BEFORE staging anything new.
# FO firing 37 fixed two defects here: (1) the guard ran BEFORE the idempotence
# check, so every deploy wave re-warned on boxes that were ALREADY in sync —
# firing 37 proved it live: the psql container gets "Connection refused" to RDS
# (check UNAVAILABLE, not rejected) while MODE=verify parity passes and the app
# serves fine on the staged credential; a STRICT rotation fan-out would have
# failed on every already-synced box. (2) One conflated message made "rejected"
# and "unavailable" indistinguishable. Now: REJECTED (psql: password
# authentication failed) warns even when in sync — the box is running on a
# credential the server refuses right now. UNAVAILABLE answers the quiet
# "already in sync" no-op on a synced box and only refuses when a NEW value
# would be staged. VALIDATE=0 opts out entirely; STRICT fails loudly either way.
# 2026-10-22 (probe PGD1022 on box A): the "Connection refused" above was the
# DEFAULT docker bridge, not RDS — a bridged psql got no response while the same
# psql on the host network was "accepting connections" (DOCKER-USER held no drop
# rule). The check now runs on the host network, the egress the app's own RDS
# connection is judged against; PSQL_DOCKER_NETWORK=bridge restores the old run.
if [ "${VALIDATE:-1}" = "1" ] && sudo -n docker info >/dev/null 2>&1; then
  VHOST=${EP_HOSTPORT%:*}; VPORT=${EP_HOSTPORT##*:}
  [ "$VPORT" = "$EP_HOSTPORT" ] && VPORT=5432   # hostport carried no ':port'
  VERR=$(mktemp) || VERR=/dev/null
  if sudo -n docker run --rm --network "${PSQL_DOCKER_NETWORK:-host}" -e PGPASSWORD="$PW" "${PSQL_IMAGE:-postgres:16-alpine}" \
       psql "host=$VHOST port=$VPORT user=$DB_USER dbname=$EP_DB sslmode=require connect_timeout=10" \
       -tAc 'SELECT 1' >/dev/null 2>"$VERR"; then
    [ "$VERR" != /dev/null ] && rm -f "$VERR"
    echo "  validated: store credential authenticates as $DB_USER@$VHOST"
  elif grep -qi 'password authentication failed' "$VERR" 2>/dev/null; then
    [ "$VERR" != /dev/null ] && rm -f "$VERR"
    soft "REJECTED: store credential failed the live-auth check as $DB_USER@$VHOST — the store value is wrong (rotation half-done or store tampered); keeping the last-good credential (VALIDATE=0 to bypass)"
  else
    DETAIL=$(head -c 160 "$VERR" 2>/dev/null | tr '\n' ' ')
    [ "$VERR" != /dev/null ] && rm -f "$VERR"
    if [ "$IN_SYNC" = "1" ]; then
      echo "  note: live-auth check unavailable ($DETAIL) — already in sync, nothing to stage, keeping the staged credential"
    else
      soft "live-auth check UNAVAILABLE as $DB_USER@$VHOST ($DETAIL) — cannot prove the new store value; keeping the last-good credential (VALIDATE=0 to bypass)"
    fi
  fi
fi

# ---- already in sync? quiet no-op -------------------------------------------
if [ "$IN_SYNC" = "1" ]; then
  echo "already in sync: $OVERRIDES_FILE matches $DB_SECRET_PARAM"
  echo "  user=$DB_USER endpoint=$EP_HOSTPORT/$EP_DB pw-sha256-16=$(sha16 "$PW")"
  exit 0
fi

# ---- merge-stage into a temp copy, then install back ------------------------
TMP=$(mktemp) || die "mktemp failed"
trap 'rm -f "$TMP"' EXIT
if [ -n "$CUR" ]; then printf '%s\n' "$CUR" > "$TMP"; else : > "$TMP"; fi
# stage_key failures must be LOUD: without set -e an aborted sed would
# otherwise stage only one of the two keys (divergent credentials — the
# backup path reads POSTGRES_PASSWORD) while still printing "synced:".
stage_key "$TMP" DATABASE_URL "$NEW_URL" || soft "failed to stage DATABASE_URL into the overrides copy"
stage_key "$TMP" POSTGRES_PASSWORD "$PW" || soft "failed to stage POSTGRES_PASSWORD into the overrides copy"
# Belt-and-braces: both exact lines must be present before anything is installed.
grep -qF "DATABASE_URL=$NEW_URL" "$TMP" || soft "staged DATABASE_URL missing from the overrides copy after merge"
grep -qF "POSTGRES_PASSWORD=$PW" "$TMP" || soft "staged POSTGRES_PASSWORD missing from the overrides copy after merge"

if [ -e "$OVERRIDES_FILE" ] || sudo -n test -e "$OVERRIDES_FILE" 2>/dev/null; then
  # Existing file: write IN PLACE so owner/group/mode survive untouched — a
  # root-run sync (SSM) must never re-root an ubuntu-owned file, and an
  # ubuntu-run sync must not fail on a root-owned one (ticket 18787730 class).
  if [ -w "$OVERRIDES_FILE" ]; then
    cat "$TMP" > "$OVERRIDES_FILE" || soft "cannot write $OVERRIDES_FILE"
  else
    sudo -n tee "$OVERRIDES_FILE" < "$TMP" >/dev/null \
      || soft "$OVERRIDES_FILE is not writable (plain AND sudo -n tee failed)"
  fi
else
  mkdir -p "$(dirname "$OVERRIDES_FILE")" 2>/dev/null \
    || sudo -n mkdir -p "$(dirname "$OVERRIDES_FILE")" \
    || soft "cannot create $(dirname "$OVERRIDES_FILE")"
  install -m 600 "$TMP" "$OVERRIDES_FILE" 2>/dev/null \
    || sudo -n install -m 600 "$TMP" "$OVERRIDES_FILE" \
    || soft "cannot write $OVERRIDES_FILE"
fi

echo "synced: DATABASE_URL + POSTGRES_PASSWORD staged in $OVERRIDES_FILE"
echo "  user=$DB_USER endpoint=$EP_HOSTPORT/$EP_DB pw-sha256-16=$(sha16 "$PW")"
echo "  note: running containers keep their start-time env — the new value goes live on the next deploy (or a backend recreate)."

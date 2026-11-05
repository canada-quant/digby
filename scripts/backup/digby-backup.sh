#!/usr/bin/env bash
# digby-backup.sh — nightly application-consistent backup of production data.
#
# Installed at /usr/local/bin/digby-backup.sh on the prod EC2, driven by the
# digby-backup.timer systemd unit (daily 08:30 UTC, Persistent=true so a boot
# after a missed window catches up). Created 2026-07-29 after the outage
# near-miss: the DB (chats, coding sessions, user memory, projects, embeddings)
# had NO backup of any kind.
#
# Layers:
#   1. pg_dump -Fc of admin_db  -> /opt/crossmodel-backups (LOCAL, keep 3)
#      - application-consistent; restores with pg_restore anywhere
#   2. optional S3 offsite copy -> $BACKUP_S3_BUCKET/postgres/
#      - enabled by writing BACKUP_S3_BUCKET=s3://... to
#        /opt/crossmodel-local/backup.conf once the bucket + EC2 instance
#        role exist (see docs/BACKUPS.md). No AWS keys on disk — the
#        instance profile provides credentials.
#   3. EBS-level whole-box recovery is AWS Backup's job (console-side plan,
#      see docs/BACKUPS.md) — NOT this script.
#
# Both /opt/crossmodel-backups and /opt/crossmodel-local live OUTSIDE the
# deploy rsync --delete root (/opt/crossmodel), so deploys never touch them.
#
# NETWORKING (FO firing 21, 2026-09-25): the dump containers run with
# --network host. The sandbox egress guard (owner security fix 2026-09-24,
# scripts/deploy/sandbox-egress-guard.sh) rejects default-`bridge` container
# traffic to the whole VPC CIDR — which correctly walls model-written sandbox
# code away from RDS, but ALSO killed this script's `docker run pg_dump` on
# the default bridge: the 2026-09-25 08:31Z nightly died on both legs with
# "connection refused" to RDS (bridge → 10.60.0.0/16 is REJECTed; the host
# path reaches RDS fine). The dump container is trusted infra, not sandbox
# code — it gets the host network namespace. Override with
# BACKUP_DUMP_NETWORK=bridge to debug.
#
# STATUS MARKER (same fix): a backup-status.json file in $BK_DIR records the
# last result (ok/failed + timestamp + error). The backend mounts
# /opt/crossmodel-backups read-only at /backups (docker-compose.app.yml), so
# infra-watch reads the marker and alerts a FAILED nightly IMMEDIATELY
# (severity 'failed') instead of waiting out the 30 h dump-age threshold —
# the 2026-09-25 failure was silent for 6.5 h and would have surfaced only as
# an unexplained "stale" at ~14:52Z.
set -uo pipefail

BK_DIR="${BACKUP_DIR:-/opt/crossmodel-backups}"   # BACKUP_DIR override = test harness only (systemd runs clean-env)
ENV_FILE="${BACKUP_ENV_FILE:-/opt/crossmodel/.env}"
CONF="${BACKUP_CONF:-/opt/crossmodel-local/backup.conf}"
KEEP_LOCAL=3          # local disk is for the latest few only — S3 is the real retention
MIN_FREE_MB=2048
TS=$(date -u +%Y%m%d-%H%M%S)
OUT="$BK_DIR/admin_db-$TS.dump"
STATUS_FILE="$BK_DIR/backup-status.json"
DUMP_NET="${BACKUP_DUMP_NETWORK:-host}"   # host | bridge (see NETWORKING above)
PG_DUMP_RETRIES="${PG_DUMP_RETRIES:-3}"   # transient-connection retries per leg
PG_DUMP_RETRY_SLEEP="${PG_DUMP_RETRY_SLEEP:-60}"

log() { echo "[digby-backup] $*"; }

# Status marker for infra-watch (see STATUS MARKER above). Best-effort: the
# backup's own exit code stays the source of truth for systemd; the marker is
# the OBSERVABILITY channel the backend's read-only /backups mount can see.
write_status() { # write_status <ok|failed> [error-note]
  local st="$1" err="${2:-}"
  printf '{"status":"%s","at":"%s","error":"%s"}\n' \
    "$st" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(printf '%s' "$err" | tr -d '\n\r"\\\\' | cut -c1-200)" \
    > "$STATUS_FILE.tmp" 2>/dev/null && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE" \
    || log "WARNING: could not write $STATUS_FILE (infra-watch blind to this run)"
}

mkdir -p "$BK_DIR"

# Orphaned-partial reclamation (ticket cf047f4a, 2026-10-24): a run killed
# mid-dump (systemd timeout, box reboot, OOM) leaves its admin_db-<ts>.dump.tmp
# behind — and NOTHING else ever matches *.tmp: the KEEP_LOCAL rotation globs
# admin_db-*.dump, the disk guard prunes the same, so the 2026-10-24 timeout
# kill (437896fb) stranded a 7.5 G orphan on /. A partial whose mtime is older
# than ORPHAN_TMP_MAX_HOURS (default 6 h — well past the 7200 s systemd bound,
# and a healthy run refreshes mtime continuously while writing) is definitively
# abandoned: reclaim it. A live run's fresh-mtime partial is never touched.
ORPHAN_TMP_MAX_HOURS="${ORPHAN_TMP_MAX_HOURS:-6}"
# clamp the override instead of truncating it (D4): a fractional ("0.5") or
# non-numeric value falls back to the 6 h default — never to "-mmin +0" (which
# matches a partial written seconds ago) and never to a crashed arithmetic.
# F-8a/F-8b hardening (adversarial review 2026-10-25): reject >3-digit values
# BEFORE any arithmetic (a 16+-digit override wraps bash int64 arithmetic
# negative — negative -mmin matches a partial written seconds ago, the
# over-delete class), read base-10 ("08" is 8 h, never octal — the octal error
# silently killed the sweep), and bound the result to 1..24 h.
case "$ORPHAN_TMP_MAX_HOURS" in ('' | *[!0-9]* | ????*) ORPHAN_TMP_MAX_HOURS=6 ;; esac
ORPHAN_TMP_MAX_HOURS=$(( 10#$ORPHAN_TMP_MAX_HOURS ))
[ "$ORPHAN_TMP_MAX_HOURS" -ge 1 ] 2>/dev/null || ORPHAN_TMP_MAX_HOURS=6
[ "$ORPHAN_TMP_MAX_HOURS" -le 24 ] 2>/dev/null || ORPHAN_TMP_MAX_HOURS=24
orphan_min=$(( ORPHAN_TMP_MAX_HOURS * 60 ))
while IFS= read -r orphan; do
  log "reclaiming orphaned partial dump (killed run): $orphan"
  rm -f "$orphan"
done < <(find "$BK_DIR" -maxdepth 1 -name 'admin_db-*.dump.tmp' -mmin +"$orphan_min" 2>/dev/null)

# Disk guard: prune oldest local dumps first if space is tight, then abort
# loudly rather than filling the root volume (a full disk is a worse outage
# than a missed backup).
free_mb() { df --output=avail -m / | tail -1 | tr -dc '0-9'; }
if [ "$(free_mb)" -lt "$MIN_FREE_MB" ]; then
  log "low disk ($(free_mb))MB free — pruning old local dumps first"
  ls -1t "$BK_DIR"/admin_db-*.dump 2>/dev/null | tail -n +2 | xargs -r rm -f
fi
if [ "$(free_mb)" -lt "$MIN_FREE_MB" ]; then
  log "ABORT: still <${MIN_FREE_MB}MB free on / — not dumping. Clean the disk."
  write_status failed "disk guard: under ${MIN_FREE_MB}MB free on /"
  exit 1
fi

# Retrying dump runner (FO firing 21): runs one pg_dump leg up to
# $PG_DUMP_RETRIES times (60 s apart) — the 2026-09-25 failure class was a
# single transient "connection refused" that a 60 s retry would have ridden
# out. stdout still goes to $OUT.tmp.
dump_once() { # dump_once <label> <docker args…>
  local label="$1"; shift
  local attempt rc
  for attempt in $(seq 1 "$PG_DUMP_RETRIES"); do
    if docker run --rm -i --network "$DUMP_NET" "$@" > "$OUT.tmp" 2>>"$BK_DIR/.pg_dump-$TS.err"; then
      [ "$attempt" -gt 1 ] && log "pg_dump succeeded on attempt $attempt"
      return 0
    fi
    rc=$?
    log "pg_dump FAILED ($label, attempt $attempt/$PG_DUMP_RETRIES): $(tail -1 "$BK_DIR/.pg_dump-$TS.err" 2>/dev/null | cut -c1-160)"
    rm -f "$OUT.tmp"
    [ "$attempt" -lt "$PG_DUMP_RETRIES" ] && sleep "$PG_DUMP_RETRY_SLEEP"
  done
  return 1
}

# Source: the LIVE store via the backend container's own DATABASE_URL (post
# 2026-07-31 RDS cutover that is the ca-central-1 RDS instance; override the
# .env fallback host via BACKUP_PG_HOST). The retired on-box docker postgres
# (data frozen 2026-08-01) is only a LOUD last-resort fallback: silently
# preferring it — the old auto-detect, while the container was left running —
# made every nightly dump from 2026-08-01 to 2026-08-15 a stale snapshot.
# Fixed 2026-08-15; the retired container is stopped by the ec2-ops r3
# one-shot, so after that this fallback can never trigger.
#
# Isolation boundary (ticket c75b5f34): on a NON-prod instance
# (DIGBY_INSTANCE != prod) the production RDS endpoint is NEVER a fallback —
# a self-hosted backup reads THIS instance's own postgres (the
# admin-postgres-prod / digby-postgres container path below), and an explicit
# BACKUP_PG_HOST is the only remote target ever allowed.
RDS_EP="${BACKUP_PG_HOST:example-db.cp20s4ivqgrn.ca-central-1.rds.amazonaws.com}"
# NOTE: ${BACKUP_PG_HOST:-} everywhere — `set -u` aborts on the bare expansion,
# which killed EVERY non-prod run with the var unset before any dump leg ran
# (found by harness case 5, c75b5f34 follow-up).
if [ "${DIGBY_INSTANCE:-prod}" != "prod" ] && [ -z "${BACKUP_PG_HOST:-}" ]; then
  RDS_EP=""
  log "isolation boundary (DIGBY_INSTANCE=${DIGBY_INSTANCE}): the production RDS endpoint is not a fallback on this instance — the .env fallback leg is disabled (ticket c75b5f34)"
fi
# ── Isolation boundary (ticket c75b5f34, review F6): the SELF-HOSTED dump leg.
# A self-hosted instance (docker-compose.selfhost.yml) runs its OWN postgres as
# the digby-postgres container (user admin, db admin_db) — that container is the
# PRIMARY dump source on a non-prod instance (pg_dump runs INSIDE it, so no
# host-network reachability is needed; the compose network never publishes
# 5432). The backend-env legs below remain for a custom remote DB
# (BACKUP_PG_HOST / a host-reachable DATABASE_URL). Prod never enters this leg.
dump_done=""
if [ "${DIGBY_INSTANCE:-prod}" != "prod" ] && docker ps 2>/dev/null | grep -q 'digby-postgres'; then
  log "dumping via this instance's own digby-postgres container (isolation boundary — the primary self-hosted source)"
  if docker exec digby-postgres pg_dump -U admin -d admin_db -Fc > "$OUT.tmp" 2>>"$BK_DIR/.pg_dump-$TS.err"; then
    dump_done=1
  else
    log "pg_dump FAILED (digby-postgres container leg)"
    rm -f "$OUT.tmp"
  fi
fi
BE_URL=""
for c in admin-backend-blue admin-backend-green digby-backend; do
  BE_URL="$(docker exec "$c" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)"
  [ -n "$BE_URL" ] && break
done
if [ -n "$BE_URL" ]; then
  log "$TS starting pg_dump via backend DATABASE_URL (live store, network=$DUMP_NET)"
  if dump_once "live store via backend env" pgvector/pgvector:pg16 pg_dump -Fc "$BE_URL"; then
    dump_done=1
  else
    log "pg_dump FAILED (live store via backend env, all $PG_DUMP_RETRIES attempts)"
  fi
fi
if [ -z "$dump_done" ]; then
  if [ -n "$RDS_EP" ]; then
    log "WARNING: backend env unreadable — trying .env POSTGRES_PASSWORD against $RDS_EP"
    DB_PW=$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -n "$DB_PW" ] && dump_once "RDS .env fallback" -e PGPASSWORD="$DB_PW" pgvector/pgvector:pg16 pg_dump -h "$RDS_EP" -U admin -d admin_db -Fc; then
      dump_done=1
    else
      log "pg_dump FAILED (RDS .env fallback, all $PG_DUMP_RETRIES attempts)"
    fi
  fi
fi
if [ -z "$dump_done" ] && docker ps | grep -q 'admin-postgres-prod'; then
  log "WARNING: falling back to the RETIRED on-box docker postgres (data frozen 2026-08-01) — THIS DUMP IS STALE; investigate why the live store was unreachable"
  if docker exec admin-postgres-prod pg_dump -U admin -d admin_db -Fc > "$OUT.tmp"; then
    dump_done=1
  else
    log "pg_dump FAILED (stale local fallback)"
    rm -f "$OUT.tmp"
  fi
fi
if [ -z "$dump_done" ]; then
  log "ABORT: no dump source succeeded"
  write_status failed "no dump source succeeded ($(date -u +%H:%MZ) — see journalctl -u digby-backup.service)"
  exit 1
fi
rm -f "$BK_DIR/.pg_dump-$TS.err"
mv "$OUT.tmp" "$OUT"
log "wrote $OUT ($(du -h "$OUT" | cut -f1))"
write_status ok

# Box-local env overrides are the ONE config file that exists nowhere else
# (not in git, not in GitHub secrets) — snapshot it alongside the dump.
if [ -s /opt/crossmodel-local/env-overrides.env ]; then
  cp /opt/crossmodel-local/env-overrides.env "$BK_DIR/env-overrides-$TS.env"
  chmod 600 "$BK_DIR/env-overrides-$TS.env"
fi

# Rotate local copies.
ls -1t "$BK_DIR"/admin_db-*.dump      2>/dev/null | tail -n +$((KEEP_LOCAL+1)) | xargs -r rm -f
ls -1t "$BK_DIR"/env-overrides-*.env  2>/dev/null | tail -n +$((KEEP_LOCAL+1)) | xargs -r rm -f

# Optional S3 offsite copy.
BACKUP_S3_BUCKET=""
[ -f "$CONF" ] && . "$CONF"
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    if aws s3 cp "$OUT" "${BACKUP_S3_BUCKET%/}/postgres/$(basename "$OUT")" --only-show-errors; then
      log "offsite copy uploaded to ${BACKUP_S3_BUCKET%/}/postgres/"
    else
      log "S3 upload FAILED (bucket/role missing?) — local copy retained"
    fi
  else
    log "aws CLI not installed — skipping S3 (sudo snap install aws-cli --classic)"
  fi
else
  log "no BACKUP_S3_BUCKET in $CONF — local-only until the bucket + instance role exist (docs/BACKUPS.md)"
fi

log "done. local dumps:"
ls -lh "$BK_DIR"/admin_db-*.dump 2>/dev/null | tail -3

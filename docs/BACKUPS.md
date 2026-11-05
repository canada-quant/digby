# Backups (created 2026-07-29, after the outage near-miss)

On 2026-07-29 the prod EC2 was accidentally **stopped** while the retired dev
box was being terminated. Had it been **terminated** instead, the production
database — every chat, coding session, user memory, project, and embedding —
would have been unrecoverable: there were no backups of any kind. This
document is the fix.

## Architecture — three layers

| Layer | What | Protects against | Where it runs |
|-------|------|------------------|---------------|
| 1. Nightly `pg_dump` | `digby-backup.timer` → `/usr/local/bin/digby-backup.sh`, daily 08:30 UTC, keeps 3 local dumps in `/opt/crossmodel-backups` | bad migration, accidental delete, app-level corruption | on the box (systemd) |
| 2. S3 offsite copy | same script uploads each dump to `$BACKUP_S3_BUCKET/postgres/` | box/volume loss, region-local disk failure | on the box (needs bucket + instance role — see below) |
| 3. AWS Backup (EBS) | daily snapshot of the instance volume, 14–30 day retention | whole-instance loss (the 2026-07-29 scenario) | AWS console (owner setup — see below) |

Layer 1 ships from this repo (installed via the ec2-ops playbook one-shot;
source of truth: `scripts/backup/digby-backup.sh`,
`deploy/digby-backup.{service,timer}`). Layers 2–3 need ~10 minutes in the
AWS console by the owner; **no AWS credential ever enters git or GitHub
secrets** — the instance profile carries the S3 permission.

**Source (post 2026-08-15 fix):** the script dumps the **live store via the
backend container's own `DATABASE_URL`** — the ca-central-1 RDS instance
(`example-db.cp20s4ivqgrn.ca-central-1.rds.amazonaws.com`) since the
2026-07-31 cutover. Fallbacks, in order: `POSTGRES_PASSWORD` from
`/opt/crossmodel/.env` against the RDS host (override via `BACKUP_PG_HOST`),
then — LOUDLY, as a stale last resort — the retired on-box docker
`admin-postgres-prod`. **Incident 2026-08-01→15:** the old auto-detect
preferred the local container because it was left running after retirement,
so two weeks of nightly dumps (incl. the 533 MB 08-15 dump) were stale
snapshots; the retired container was stopped by the ec2-ops r3 one-shot on
2026-08-15. RDS automated snapshots are independent of this script. The
systemd timer runs the installed copy at
`/usr/local/bin/digby-backup.sh` — refresh it from the repo after a deploy
(`sudo install -m755 /opt/crossmodel/scripts/backup/digby-backup.sh /usr/local/bin/`).
The unit budget is `TimeoutStartSec=7200` (ticket 437896fb, 2026-10-24): the
08:31Z nightly was SIGTERM'd at exactly +30min under the old 1800 budget
("Failed with result 'timeout'") once the dump outgrew 30min — never lower
it back; the pin is `scripts/backup/digby-backup.test.sh` (case 6).

Redis note: `admin-redis-prod` already runs `--appendonly yes` on a Docker
volume, so cache/session/steer state survives restarts on its own. It is
cache-tier data; the pg_dump layers deliberately don't cover it.

## Owner setup — DONE 2026-07-29 (via owner's local CLI, `crossmodel-prod`
## profile = IAM user `rozo_superadmin`, account 123456789012, us-east-1)

Live resources (created 2026-07-29 ~02:30–02:45Z):

| Resource | Value |
|----------|-------|
| S3 bucket | `digby-backups-prod` — private, public access blocked, SSE-S3, versioned; lifecycle expires `postgres/*` + noncurrent versions after 30d, aborts stale multiparts 7d |
| EC2 instance role | `digby-backup-ec2-role` — `s3:PutObject` (+multipart) scoped to this bucket only; attached via instance-profile assoc `iip-assoc-047f8a1a272796529` (no restart) |
| AWS Backup | vault `digby-prod-vault`, plan `digby-prod-daily` — `cron(0 6 * * ? *)` UTC daily, **14-day retention**, selection: instance `i-0123456789abcdef0`, service role `digby-aws-backup-role` |
| First manual snapshot | `snap-0123456789abcdef0` (50 GB, taken 02:35Z 2026-07-29) |
| IAM side-effect | inline policy `digby-backup-manage` on user `rozo_superadmin` (backup:*, backup-storage:*, iam:PassRole on the backup role, KMS set for vault creation) — managed-policy slots were full. Revoke when desired: `aws iam delete-user-policy --user-name rozo_superadmin --policy-name digby-backup-manage` — ⚠ STALE (2026-10-12): IAM user `rozo_superadmin` is DELETED (CQL-Public breach), so this policy is gone with it; never recreate an admin user/key for backups |

On-box wiring (aws CLI install + `/usr/local/bin/aws` symlink — systemd's PATH
excludes `/snap/bin` — + `BACKUP_S3_BUCKET=s3://digby-backups-prod` in
`/opt/crossmodel-local/backup.conf`, `s3://` form required by the script) was
applied by the ec2-ops playbook one-shot `20260729c`, which also ran a live
dump+upload to verify. Note: the instance role deliberately has no
ListBucket/GetObject, so `aws s3 ls` from the box FAILS by design — the
authoritative check is the `aws s3 cp` exit code in
`journalctl -u digby-backup` ("offsite copy uploaded").

**ca-central-1 addendum (post-migration):** the table above records the
ORIGINAL us-east-1 setup for the old single box. With the ca-central-1
migration the AWS Backup vault/plan and the S3 bucket were re-created
in-region (same names), and the plan's resource selection now targets
`i-0123456789abcdef0` (stateful primary A) — the us-east-1 instance
`i-0123456789abcdef0` listed above is terminated and no longer backed up. The
nightly pg_dump timer + role wiring live on A only (B's timer is
stopped+disabled; the ec2-ops playbook one-shot now enforces this itself — a
box without the on-box `admin-postgres-prod` container never enables the
timer. Before 2026-09-25 the one-shot enabled it unconditionally, leaving the
coding box C failing "No such container: admin-postgres-prod" every 08:30 UTC
since Aug 29).

### Reading the fleet backup telemetry (ticket 533087b7)

`get_fleet_telemetry` **deploy view** exposes a `backup` block per box row and a
fleet-level `backup` summary (the `boxes` view returns the per-row `backupRole`
on its rows but no fleet-level summary). Read them together — **a
`backup.ageH` number only means something on the box that OWNS the timer**:

| `backupRole` | What it means | Is a big `ageH` a problem? |
|---|---|---|
| `producer` | The host runs `digby-backup.timer` (default `box-a`; override with `BACKUP_PRODUCER_HOSTS=host1,host2`). Its dump age IS the fleet's backup age. | **Yes** — `backupGap: true` when stale (>30 h), missing, or a `status:"failed"` marker that a newer dump has NOT superseded; infra-watch alerts on it. |
| `non-producer` | The host can see a `/backups` dir but does not run the timer (e.g. `box-b`, whose timer is stopped+disabled above). Any dumps are leftovers that never refresh. | **No** — by design. The age is a true fact, not a fault. box-b has read ~1,031 h stale since an ad-hoc 2026-09-18 dump while nothing was wrong. |
| `unmounted` | No dump reading at all: `/opt/crossmodel-backups` is mounted on the **backend (web) service only** in `docker-compose.app.yml`, so **every worker row is `unmounted` — by design, not a gap**. A *web* row with `unmounted` IS suspicious (a pre-`4f6cb3610` image, or a box recreated without the mount); it surfaces as the fleet-level `producer_unmounted` status, and infra-watch's >24 h producer-lapse check covers it. | Only on a `web` row. |

**A `failed` marker only counts when a newer dump has not superseded it.** The
script writes `backup-status.json` best-effort, so a run can leave a stale
`failed` marker behind while a later run's dump lands fine. A newest dump newer
than the marker's `statusAt` outranks it — the same rule
`classifyBackupAge` (alerts) and `scripts/framework-audit/audit-live-state.js`
apply, and the deploy view's `backup` must agree with them or it would publish a
failure no alert fires on.

The fleet-level `backup.status` is `ok | failed | stale | missing |
unknown_age | producer_unmounted` computed **from producer surfaces only**, plus
`unreported` when no producer reported in the window. Two are deliberately
distinct from "missing" because the data can tell them apart: `unknown_age`
(dumps present but none ageable — NOT "produced nothing") and
`producer_unmounted` (the producer heartbeats but reports no dump reading at
all — a real mount defect). `unreported` means UNKNOWN, never "missing" (a
reporting lapse and a dead timer look identical from there). `backup.reading` is
a citable sentence that names the producer, the by-design leftovers and the
worker nulls, so no reader has to re-derive the role wiring. **Do not open a
ticket on a non-producer's dump age or on a worker's `backup: null`.**

## Restore runbooks

### Database only (bad deploy/migration/delete — most common case)
```bash
# on box A; pick the dump you want
ls -lh /opt/crossmodel-backups/
# Local dumps gone but the box is alive? The box's instance role is
# PutObject-only BY DESIGN (it cannot list or download), so fetch the dump
# with an owner-credentialed CLI and scp it up:
#   aws s3 ls s3://digby-backups-prod/postgres/                        # pick one
#   aws s3 cp s3://digby-backups-prod/postgres/admin_db-<TS>.dump .
#   scp -i <ec2-key> admin_db-<TS>.dump ubuntu@203.0.113.10:/tmp/
#   ssh ... 'sudo mv /tmp/admin_db-<TS>.dump /opt/crossmodel-backups/'
# The app DB lives on RDS since the 2026-07-31 cutover — restore against the
# RDS endpoint, NOT a docker container. Use the backend container's own
# DATABASE_URL (the same live-store handle the backup script dumps from).
# EVERY docker run below needs --network host: the sandbox egress guard
# (2026-09-24, scripts/deploy/sandbox-egress-guard.sh) rejects default-bridge
# container traffic to the VPC/RDS — without it a restore fails exactly the
# way the 2026-09-25 08:31Z nightly dump did (connection refused).
BE_URL=$(sudo docker exec admin-backend-$(cat /opt/crossmodel/.active-color) sh -c 'printf %s "$DATABASE_URL"')
# SAFEST: restore into a scratch DB on the same RDS instance and spot-check
# before touching the live store (swap the /admin_db suffix for /restore_test):
sudo docker run --rm -i --network host pgvector/pgvector:pg16 psql "$BE_URL" -c 'CREATE DATABASE restore_test'
sudo docker run --rm -i --network host pgvector/pgvector:pg16 pg_restore --no-owner \
  -d "<BE_URL with /admin_db → /restore_test>" < /opt/crossmodel-backups/admin_db-<TS>.dump
# IN-PLACE (the loud option): --clean drops+recreates objects in the live DB:
sudo docker run --rm -i --network host pgvector/pgvector:pg16 pg_restore -d "$BE_URL" --clean --if-exists \
  < /opt/crossmodel-backups/admin_db-<TS>.dump
# restart the active-color backend so Prisma reconnects cleanly
AC=$(cat /opt/crossmodel/.active-color); sudo docker restart admin-backend-$AC admin-worker-$AC
# LAST RESORT ONLY: if RDS itself is down and you are deliberately reviving the
# RETIRED on-box admin-postgres-prod container as an emergency store (its data
# froze 2026-08-01 — the backup script treats it as a loud stale fallback,
# scripts/backup/digby-backup.sh:83), restore into it with the old docker
# steps (docker cp + docker exec pg_restore) and re-point the app's
# DATABASE_URL by hand. An emergency bridge, never a restore target.
```

### Whole box (instance lost/terminated)
1. AWS Backup → Restore the latest recovery point → new EC2 instance
   (t3.large, same subnet/SG), or launch fresh Ubuntu and restore just the
   volume.
2. Register the replacement instance to the target group behind the
   internet-facing ALB `example-alb` (digby.ai/www/mcp are grey-cloud
   CNAMEs to the ALB, so ingress needs no DNS or EIP work). The instance EIPs
   (`203.0.113.10` A / `203.0.113.11` B) matter only for OUTBOUND vendor
   whitelisting — if the lost box held one, re-associate that EIP to the
   replacement so egress stays whitelisted.
3. If restored from the EBS snapshot everything (docker, nginx, certs,
   /opt/crossmodel, backups dir) is already on disk — boot and verify;
   `admin-frontend-*` may need a `docker restart` (cold-boot wart seen
   2026-07-29).
4. If instead it's a fresh instance: run `.github/workflows/infrastructure.yml`
   (nginx+SSL), push to `main` (deploy.yml rsyncs code + writes `.env` from
   GitHub secrets), then restore the DB with the runbook above from S3.
   **The backup layer itself does not exist on a fresh box** — reinstall it by
   pushing any trivial change under `scripts/ec2-ops/` (or dispatching the
   ec2-ops workflow manually): the install one-shots re-fire because their
   markers are box-local in `/var/tmp` (script+timer, aws CLI, `backup.conf`).
   Note ec2-ops does NOT run on an ordinary push to main — only on pushes
   touching `scripts/ec2-ops/**`/the workflow file, or manual dispatch.
   Verify: `systemctl list-timers digby-backup.timer`.
   (An EBS-snapshot restore per step 3 already has the units + `backup.conf`
   on disk — nothing to reinstall.)
5. Update the `EC2_HOST` GitHub secret only if the IP changed (it shouldn't —
   the Elastic IP moves with you).

## Updating the backup script

The box executes `/usr/local/bin/digby-backup.sh` — a **copy**, installed once
by the marker-guarded playbook one-shot (already fired; it will not reinstall
on this box). Editing the canonical `scripts/backup/digby-backup.sh` in git
therefore does NOT change what runs tonight. To propagate an edit:

1. Merge the change — the next deploy rsyncs the repo to `/opt/crossmodel`.
2. Refresh the installed copy, either:
   - on-box: `sudo install -m755 /opt/crossmodel/scripts/backup/digby-backup.sh /usr/local/bin/digby-backup.sh`, or
   - push a playbook edit that re-runs the install under a NEW marker name.
3. Verify: `sudo systemctl start digby-backup.service && sudo journalctl -u digby-backup -n 20`.

The 2026-07-29b one-shot no longer embeds the script (FO firing 21,
2026-09-25): it installs the canonical `scripts/backup/digby-backup.sh` from
the rsynced repo — never re-embed a copy. Only the systemd **unit** text is
embedded (heredoc `SVCEOF`), and `scripts/backup/digby-backup.test.sh` case 6
pins every embedded unit body to `TimeoutStartSec >= 7200`.

**Orphaned `*.dump.tmp` reclamation (ticket cf047f4a, 2026-10-24):** a run
killed mid-dump (the 437896fb systemd timeout) leaves its
`admin_db-<ts>.dump.tmp` partial behind, and nothing else in the script ever
matched `*.tmp` — the rotation and disk guard both glob `admin_db-*.dump` —
so the killed run's partial stranded 7.5 G on `/` indefinitely. The script
now reclaims stale partials on every run: any `admin_db-*.dump.tmp` whose
mtime is older than `ORPHAN_TMP_MAX_HOURS` (default **6 h**, safely past the
7200 s systemd bound — a healthy run refreshes its partial's mtime
continuously while writing, so a fresh-mtime partial is a LIVE run's and is
never touched). The override is env-only and bounded to **1–24 h**: an
invalid value (fractional, non-numeric, over-long, or out of range) clamps
back to the 6 h default rather than ever degrading to "delete anything
recent" — and leading-zero values are read as decimal (`08` = 8 h). Pinned by
`scripts/backup/digby-backup.test.sh` cases 7/7b/7c/7d (stale reclaim, fresh
survival, clamp, overflow + octal edges).

## Verification

- Timer installed + first backup ran: ec2-ops playbook one-shot
  (2026-07-29) — see that run's log for the dump size and
  `systemctl list-timers digby-backup.timer` output.
- Ongoing: `journalctl -u digby-backup` on the box; dumps in
  `/opt/crossmodel-backups`; S3 objects land nightly in
  `digby-backups-prod/postgres/` — check from an owner-credentialed CLI with
  `aws s3 ls s3://digby-backups-prod/postgres/` (the box itself cannot list:
  its role is PutObject-only by design). Last independent verification
  2026-07-29 03:15Z: dump `admin_db-20260729-024934.dump` (407 MB) present,
  plan `digby-prod-daily` exists, snapshot `snap-0123456789abcdef0` completing.
- Restore drill (recommended quarterly): restore the latest dump into a
  scratch database (`createdb restore_test && pg_restore -d restore_test ...`)
  and spot-check row counts of `crossmodel_chats`, `user_memory`,
  `coding_sessions`.

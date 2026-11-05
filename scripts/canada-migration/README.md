# Canada migration: ALB + multi-instance in ca-central-1 (Montreal)

> **STATUS 2026-08-01: MIGRATION FULLY CLOSED OUT.** digby.ai + www +
> mcp.digby.ai all live on the ca-central-1 ALB (A stateful 1a + B stateless
> 1b, TG 2/2); Postgres on **RDS `example-db`** (pg16.13, private,
> 7-day backups); nightly backups re-pointed at RDS (on-box + S3). Old
> us-east-1 fully decommissioned: EC2 `i-0123456789abcdef0` terminated, EIP
> released, RDS `crossmodel-postgres` deleted (snapshots/AMI retained as
> rollback artifacts). Soak-finisher (24h) green — one transient
> worker-not-claiming probe RED at 04:10Z, auto-recovered per design (#123).
> Hard-won rules: never run worker handoffs inside a coding session (#122
> self-decapitation — use an ec2-ops one-shot); repoint the healthcheck's
> `EC2_HOST` BEFORE stopping an old worker (else the #123 probe revives it);
> DB password rotations must fan out to every box's env-overrides (#128/#131);
> `deploy.yml` regenerates box `.env` from a template — durable per-box config
> belongs in `/opt/crossmodel-local/env-overrides.env`, never manual `.env`
> edits. Next rungs (auto-scaling roadmap): RDS Multi-AZ / ElastiCache, then
> ASG — see `docs/archive/LOAD-BALANCING-CANADA.md`. Open: #131 (single secret store).
> **2026-08-08:** both instances now on Elastic IPs — A 203.0.113.10, B
> 203.0.113.11 (supersedes IPs quoted in the log body).

Execution companion to `docs/archive/LOAD-BALANCING-CANADA.md` (the approved plan — read
it first). This directory is the **runbook + idempotent scripts** for moving
Digby prod from a single us-east-1 box to an ALB-fronted, 2-AZ architecture in
ca-central-1, in careful, reversible stages.

## Where we start (verified live 2026-07-30)

- Prod = ONE t3.large `i-0123456789abcdef0` (us-east-1a, 50 GB gp3, AMI
  `ami-04680790a315cd58d` / Ubuntu 22.04), blue-green containers + host nginx.
- DB = `admin-postgres-prod` Docker container on that box (`admin_db`). The RDS
  instance `crossmodel-postgres` (us-east-1, Mar 2026) is a **retired migration
  artifact** — the app never points at it. (Decommission separately; ~$30/mo.)
- No ALB/NLB/ASG anywhere in the account (verified: `elbv2 describe-load-balancers`
  is empty in us-east-1).
- DNS: Cloudflare hosts `digby.ai` (zone `6e88d4ef896571cb06de397e92e7e677`),
  **DNS-only (grey cloud)**, A-record TTL 300. Cutover = one Cloudflare API call
  (apex CNAME flattening to the ALB works on Cloudflare).
- Deploys: push to `main` → GitHub Actions → SSH (`EC2_HOST`/`EC2_SSH_KEY`
  secrets) → rsync → `.env` from secrets → box-local overrides →
  `deploy-blue-green.sh` → nginx upstream flip.

## Target architecture (ca-central-1)

```
            digby.ai (Cloudflare DNS, CNAME-flattened apex)
                     │
        digby-alb (internet-facing, ca-central-1a+b)
        ACM cert: digby.ai + www.digby.ai
        :443 → forward digby-app-tg · :80 → 301
                     │ HTTPS:443 (ALB ignores target cert validity;
                     │  instance nginx keeps its LE cert)
        ┌────────────┴────────────┐
   example-ca-node           example-ca-node      ← t3.large, golden AMI
   (primary: worker+cron+    (app-only: WORKER off via hostconfig guard,
    backups on)               backups masked)   both run blue-green nginx
        └────────────┬────────────┘
              box-local postgres+redis per instance
              (primary DB = source of truth; B syncs at cutover…
               see "the two-database problem" below)
```

## Scripts (idempotent, re-runnable; state in `state.env`, gitignored)

| Script | Does | Prod impact |
|---|---|---|
| `10-foundation.sh` | import prod SSH pubkey, VPC 10.60.0.0/16, 2 public subnets (1a/1b), IGW+routes, `digby-alb-sg`/`digby-app-sg`, IAM role `example-ec2-role` (S3 backup put + SSM) + profile | none |
| `20-acm-and-alb.sh` | ACM cert (DNS-validated via Cloudflare API — needs `CLOUDFLARE_API_TOKEN`), ALB, target group (HTTPS:443, health `/api/health`), :443 listener + :80 redirect | none (adds 2 `_…acm` CNAMEs to the zone) |
| `30-ami-copy.sh` | `create-image --no-reboot` of prod → `copy-image` to ca-central-1 | none |
| `40-launch-staging.sh` | launch `example-ca-primary` (t3.large) with `user-data-staging.yaml`, register to TG | none |
| `user-data-staging.yaml` | first-boot guardrails for the staging copy (below) | — |
| `50-launch-app-b.sh` | launch `example-ca-app-b` (t3.large, **1b**) with `user-data-app-b.yaml` (A's private IP templated in), register to TG | none |
| `user-data-app-b.yaml` | stateless-B guardrails: neuter local pg/redis/worker/adminer, stop+disable backup timer, point B at A (compose sed + `/opt/crossmodel-local/{deploy-flags,env-overrides}.env`), recreate blue healthy on first boot | — |

### Staging guardrails (why they exist)

The golden AMI is a **live snapshot of prod**: docker volumes carry a full DB
copy and containers have `restart=unless-stopped`. Un-guarded, first boot would
double-fire chat/coding schedules (misfire catch-up), claim stale coding
`agent_runs` (a resumed run could `git push`), duplicate the nightly S3 backup,
and expose adminer. `user-data-staging.yaml` therefore: stops dockerd → sets
`restart=no` on `admin-worker-*` + `admin-adminer-prod` via hostconfig surgery
→ masks `digby-backup.timer/service` → starts dockerd → disables every
schedule row (`enabled=false`) in the **copied** DB. Prod is untouched.

## Execution log

| Phase | Status | Notes |
|---|---|---|
| 0 Prep (scripts, runbook) | ✅ 2026-07-29 | this directory; commit `9076ba4` |
| 1 Foundation (VPC/SG/IAM) | ✅ 2026-07-29 | VPC `vpc-08e1d94e05e39114b`; subnets `subnet-03bf164c76d4e2af0` (1a) / `subnet-07bb711a8c8e43f72` (1b); SGs `sg-0123456789abcdef0` (alb) / `sg-0123456789abcdef0` (app); role+profile `example-ec2-role`/`digby-ec2-ca-profile`; key `crossmodel-prod` imported |
| 2 ACM + ALB | ✅ 2026-07-29 | cert `8fcffbda-361d-4311-8144-30402f165df1` ISSUED (CF DNS-validated); ALB `example-alb.ca-central-1.elb.amazonaws.com`; TG `digby-app-tg` HTTPS:443 `/api/health`; listeners :443→TG, :80→301 |
| 2b Prod disk rescue | ✅ 2026-07-29 | root `vol-036ba0bc309ff7cc4` grown 50→100 GB **online** (modify-volume + growpart + resize2fs via SSM, no reboot); 94%→47% used. See "Disk & capacity" |
| 3 AMI copy | ✅ 2026-07-29 | source `ami-081b703111d8d797f`; ca-central-1 golden `ami-07592d910702f22f9` |
| 4 Staging + smoke test | ✅ 2026-07-29 | `i-0123456789abcdef0` (203.0.113.16, 100 GB gp3) — guardrails verified via SSM (workers/adminer `restart=no`, backup timer masked, schedules disabled in the copied DB); TG **healthy**; `https://<alb>/api/health` → healthy JSON, `/` → 200, `:80` → 301. **Prod untouched** (digby.ai still on the old box, healthy). Note: frontend needed a manual start — root cause was the missing `restart: unless-stopped` in `docker-compose.app.yml`, now fixed in git (same bug as the Jul-29 cold-boot 502). |
| 4.5 Test data sync | ✅ 2026-07-29 | `pg_dump -Fc` prod → `s3://digby-backups-prod/migration/admin_db-20260729-211250.dump` (480 MB) → restore on A (drop+create, exit 0); exact counts match (chats 838, messages 4467, accounts 64; `agent_events` snapshot ≤ live prod as expected); schedules re-disabled in the copy; worker stays OFF |
| 4.6 Instance B (stateless) | ✅ 2026-07-29 | `i-0123456789abcdef0` (203.0.113.24 / 10.0.0.16, **1b**, 100 GB) — local pg/redis/worker/adminer neutered, env → A (`DATABASE_URL`→10.0.0.11:9384, `REDIS_URL`→:7856, `DOCKER_HOST`→:2375 — verified inside the container); app-SG peer rules 9384/7856/2375; A's docker-proxy published on the VPC; `/opt/crossmodel-local/{deploy-flags,env-overrides}.env` staged; TG healthy |
| 4.7 Deploy plumbing | ✅ 2026-07-29 | commit `f93fbd9`: compose `${VAR:-default}` for `DATABASE_URL`/`REDIS_URL`/`DOCKER_HOST` (defaults = old aliases — backward compatible, proven with `compose config` on A); `deploy-blue-green.sh` sources `/opt/crossmodel-local/deploy-flags.env` (`ENABLE_STATEFUL`/`ENABLE_MIGRATIONS`/`ENABLE_WORKER`, all default **true**); `deploy.yml` loops `EC2_HOSTS` (falls back to legacy `EC2_HOST`), rollback targets only the failed host; base compose publishes docker-proxy :2375 (SG-gated) |
| 4.8 **Vigorous tests — the cutover gate** | ✅ 2026-07-29 | ALL GREEN: TLS SNI/SAN via `--resolve` (digby.ai + www, ACM cert), `:80`→301, frontend 200 + `_next` asset 200, `/api/health` healthy, bad-login 401 (no 5xx), ~50/50 A+B spread (uptime clusters), 60/60 parallel burst, **anon chat SSE E2E** (init→web-search→synthesis→`complete` with exact test string). **Failure drills:** graceful TG deregistration of B = **204/204 requests 200 (zero errors)**; hard-kill of B's docker = 26 s detection (TG tuned 15 s/2+2), 15 × 502 in the window (the irreducible cost of a *hard* failure), then all-200 + auto-recovery. **Deploy drills:** real `deploy-blue-green.sh` on BOTH boxes under a 0.5 s hammer — B (flags=false) **724/724 zero drops**, A (stateful+migrations, worker off) **809/809 zero drops**; both `DRILL_EXIT=0` |
| 4.9 Backups on A | ✅ 2026-07-29 | CA role carries `digby-backups-prod` put/list; `digby-backup.timer` unmasked + scheduled on **A** (next 08:30 UTC), stopped + disabled on **B**. FIX: `systemctl mask` fails on the AMI's real unit files (`File ... already exists`) — use stop+disable (`user-data-app-b.yaml` updated; staging's mask was a silent no-op, harmless because A is now the backup owner). TG health-check tuning (15 s/2+2) synced into `20-acm-and-alb.sh` |
| 5 **CUTOVER** | 🔵 READY — checklist below | every gate above is green; the 24 h staging soak precondition is superseded by the 4.8 drill evidence per the owner's explicit "continue end-to-end, test vigorously" instruction |

## Disk & capacity (investigated live 2026-07-29 — prompted an emergency fix)

**Findings** (read-only SSM diagnostics on the prod box):
- Root filesystem was **94% full — 45 G of 49 G, only 3.4 G free**.
- **928 `no space left on device` errors in the journal over the last 60 days**,
  the most recent TODAY at 20:31 UTC (dockerd failing to write container
  json-file logs) — i.e. the disk was hitting 100% *during this migration*.
- Docker usage: images 19.6 GB (old blue/green build generations), container
  writable layers 8.2 GB, **volumes 16.4 GB** (postgres data + coding-session
  workspaces + redis — grows monotonically, nothing reaps old workspaces),
  build cache 5.7 GB. Local pg_dump backups 1.2 GB (keep-3 retention OK).
- `deploy-blue-green.sh` already prunes (`docker image prune -a --filter until=1h`,
  builder prune 24h), but growth outpaced reclaim: stopped old-color containers
  pin their images, build cache accumulates between deploys, and workspace
  volumes are never cleaned.

**Actions taken (2026-07-29):**
- Prod root `vol-036ba0bc309ff7cc4` grown **50 → 100 GB online**
  (`modify-volume`, then `growpart` + `resize2fs` via SSM — no reboot, no
  downtime). Verified: 97 G total, **47% used, 52 G free**.
- All ca-central-1 instances launch with **100 GB gp3** roots
  (`40-launch-staging.sh` block-device override; cloud-init growpart expands
  automatically on first boot).

**Standing recommendations (post-cutover backlog):**
1. Reap coding-workspace volumes for ended sessions (app-level lifecycle job —
   the volumes bucket only ever grows).
2. Cap journald (`SystemMaxUse=1G`) and the docker json-file log driver
   (`max-size=10m, max-file=3` in daemon.json) — unbounded logs were writing
   to a full disk today.
3. Alert at disk >80% (the deploy-healthcheck workflow already prints `df -h`
   in diagnostics; wire a CloudWatch metric or cron+SNS check).
4. Keep the deploy-script prune cadence; consider pruning old-color *containers*
   older than N days too (they pin images).

## Auto-scaling roadmap ("many users")

**Why the app cannot autoscale horizontally today:** all state is box-local —
postgres (`admin_db` in a container volume), redis, coding-workspace docker
volumes, and the worker/cron must be a single writer. The current single box
is also a single point of failure (the 2026-07-29 stop proved that).

- **Phase A — this migration (HA, not autoscale).** 2 instances behind the ALB.
  **Box A (primary, stateful):** full stack — postgres, redis, worker/cron,
  backups, MCPs. **Box B (app-only, stateless-ish):** backend+frontend+MCPs,
  with `DATABASE_URL`/`REDIS_URL` pointed at A's private IP via the existing
  box-local override mechanism (`/opt/crossmodel-local/env-overrides.env`),
  worker/backup disabled by the same hostconfig guardrails as staging
  (`user-data-staging.yaml`). This is the "two-database problem" of a naive
  2-box lift-and-shift, solved by making B a DB *client* of A (SG: allow
  5432/6379 from `digby-app-sg` to A). Coding sessions still execute on A's
  worker, but their API/SSE traffic can be served by B (progress flows through
  the shared DB/redis).
- **Phase B — externalize state (unlocks true ASG).** RDS Postgres multi-AZ
  (`migrate-to-rds.sh` is the stale starting point — rewrite), ElastiCache
  Redis, coding workspaces to EFS (or keep coding execution on a pinned
  worker node). Worker/cron stays single via a dedicated node or
  Postgres-backed leader election.
- **Phase C — autoscale the stateless tier.** ASG (min 2, max N) of app nodes
  from a launch template built on the golden AMI; target tracking on
  `RequestCountPerTarget` (e.g. 200/target) and/or CPU 60%; ALB deregistration
  delay 60s + deploy-time per-instance drain (same drain the deploy loop
  already does). Blue-green-per-box remains the deploy mechanism.
- **Capacity math (today):** t3.large (2 vCPU/8 GB) idles at load ~2–3 with
  the current user base and the workload is LLM-latency-bound — the first
  scaling lever is vertical (t3.xlarge) and offloading coding-session
  containers to dedicated nodes; horizontal web-tier scaling (Phase C) matters
  once concurrent SSE chat sessions number in the hundreds.



Preconditions (all MET 2026-07-29): phases 4–4.9 green (above); deploy-plumbing
branch merged to `main` (so the `EC2_HOSTS` loop is live); fresh nightly backup
already in `s3://digby-backups-prod/postgres/` + the phase-4.5 test restore
proved the dump→restore path. A = `i-0123456789abcdef0` (203.0.113.16),
B = `i-0123456789abcdef0` (203.0.113.24).

1. **Final data sync (minutes, prod keeps serving).** Repeat phase 4.5 against
   A: fresh `pg_dump -Fc admin_db` on prod → `s3://digby-backups-prod/migration/`
   → drop+create+`pg_restore` on A. Schedules arrive **enabled** from the prod
   dump — that is the correct prod posture (A's worker starts in step 4).
2. **Point deploys at the new fleet.** Set GitHub secret
   `EC2_HOSTS="203.0.113.16 203.0.113.24"` (A first — it owns `prisma migrate`;
   `EC2_HOST` remains the legacy fallback so the pre-merge workflow is unaffected).
3. **DNS switch (Cloudflare, zone `6e88d4ef896571cb06de397e92e7e677`).**
   `digby.ai` A-record → CNAME `example-alb.ca-central-1.elb.amazonaws.com`
   (proxied=false, TTL 300); same for `www.digby.ai`. One API call each.
4. **Worker single-writer handoff** — ⚠️ **GATE: only after step 3's DNS flip is
   VERIFIED live** (`dig +short digby.ai` returns the ALB name/IPs AND
   `curl -s https://digby.ai/api/health` is served by the new fleet). On
   2026-07-30 ~04:20Z this handoff ran from a coding session **before the DNS
   flip**: the old box's worker stopped while it was still production, every
   coding run sat unclaimed ~21h, and the HTTP-only healthcheck stayed green
   (restored 2026-07-31 01:28Z via playbook one-shot `9df67aa`). With DNS
   verified on the new fleet: stop the old box's worker
   (`docker stop admin-worker-green` on `i-0123456789abcdef0`), then set
   `ENABLE_WORKER=true` in A's `/opt/crossmodel-local/deploy-flags.env` and start
   A's worker (`docker compose -p crossmodel_green -f docker-compose.app.yml up -d worker`).
   Order matters: exactly one worker fleet at all times. Also **repoint the
   `EC2_HOST` GitHub secret to A** (203.0.113.16) — deploy-healthcheck.yml's
   coding-worker liveness probe (added 2026-07-31, `scripts/check-worker-liveness.sh`)
   targets `EC2_HOST`; while it points at a box, that box is considered prod and
   a stopped worker + fresh queued runs will (correctly) fire the recovery chain.
5. **Verify live (real domain).** `https://digby.ai/` 200, `/api/health` healthy,
   one anon SSE chat E2E, ALB target health 2/2, deploy-healthcheck workflow green.
6. **Propagation window (~5 min, TTL 300).** Old box keeps serving stragglers;
   writes landing on it in this window are lost (accepted, documented). After the
   window: stop the old box's web containers (`docker compose -p crossmodel_green
   -f docker-compose.app.yml stop backend frontend`), leave the box RUNNING.
7. **Soak 24–72 h**, then STOP (not terminate!) `i-0123456789abcdef0`; keep its
   EBS/snapshots 30 days. Retire RDS `crossmodel-postgres` separately (snapshot first).

**Rollback one-liner (any point in 3–6):** Cloudflare API: point `digby.ai` +
`www` back at the old box's Elastic IP and `docker start admin-worker-green`
there — the old box never stopped serving; propagation ≤ TTL (300 s).

### Post-cutover hardening backlog

- Rotate the postgres password (currently committed in `docker-compose.base.yml`
  — pre-existing repo hygiene issue, flagged here so the move doesn't cement it).
- Swap SSH deploy for SSM `send-command` (then port 22 can close).
- Tighten TG health-check matcher from `200-399` to `200` once nginx's Host
  handling is confirmed; consider a dedicated `/healthz` server block.
- Restrict `digby-alb-sg` 443 to Cloudflare IP ranges if the proxy is ever
  re-enabled (currently DNS-only, so world-open 443 is required).

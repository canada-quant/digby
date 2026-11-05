# Load Balancing & Canada Region Migration — Options & Plan

> Status: **COMPLETE** (2026-07-31). DNS cut over 10:05Z — digby.ai + www are
> live on the ca-central-1 ALB with the 2-AZ A/B fleet; the old us-east-1 box is
> in soak (web up for instant rollback, worker off) pending STOP-not-terminate.
> Execution runbook + live log: `scripts/canada-migration/README.md`.
> Related: `docs/REMOTE_OPS.md`, `docs/BACKUPS.md`, `deploy-blue-green.sh`.

## 1. What we actually have today (verified from repo config)

**There is no load balancer.** Production is a **single EC2 instance**
(`i-0123456789abcdef0`, t3.large, us-east-1) behind **one Elastic IP**
(`203.0.113.21`). Repo-wide search confirms: no ALB/NLB, no target groups, no
Auto Scaling group, no RDS/ElastiCache — the deploy workflow SSHes straight to the
Elastic IP. Postgres 16 + Redis 7 run as **Docker containers on the same box**.

What we *do* have is **single-host blue-green** (`deploy-blue-green.sh`):

1. Push to `main` → GitHub Actions rsyncs the repo to `/opt/crossmodel`.
2. Inactive color (blue/green) is built, migrated (`prisma migrate deploy`), started.
3. Health gates: backend `/health`, frontend HTTP 200, worker liveness, and an
   **authenticated smoke test** — all pre-flip, all fatal.
4. Host nginx `reload` points upstreams at the new color — **zero dropped new
   connections**.
5. Old color drains in-flight SSE for **60s**, then SIGTERM (≤30–45s grace) → SIGKILL.

**So during a deploy users mostly notice nothing** — new requests never drop. The
residual impact:

- Plain-chat SSE streams still open after the 60s drain are **hard-killed**
  (answer cuts off; coding sessions survive via checkpoint + auto-resume, and the
  frontend reconnects with `resyncActive`).
- The bigger risk isn't deploys — it's that **one box = one point of failure**.
  The 2026-07-29 accidental instance stop caused a ~3h total outage. Blue-green on
  one host does nothing for host/AZ failure.

## 2. Load-balancing options

### Option A — Tune what exists (no new infra). ~$0, hours of work
Keep single-host blue-green; lengthen the drain window, add chat-stream client
reconnect (coding already has it). Deploys become truly invisible, but the single
point of failure remains. **Good stopgap, not the goal.**

### Option B — ALB + 2 EC2 instances across AZs (recommended target). +~$90/mo, days of work
- **Application Load Balancer** (~$0.0225/h + ~$0.008/LCU-h ≈ **$22–25/mo**;
  Canada pricing expected similar) in front of **2× t3.large** in different AZs.
- ALB supports SSE/WebSockets and long-lived connections: raise the **idle timeout**
  (default 60s) and set **deregistration delay** (connection draining, up to 3600s)
  so a deploying instance finishes in-flight streams while new connections go to the
  healthy one. **Rolling deploys = genuinely zero user impact.**
- TLS moves to **ACM on the ALB** (free, auto-renewing; replaces on-box certbot).
- Design work required before a second app instance is safe:
  - **Postgres/Redis** — shared containers today. Pragmatic: keep them on
    instance 1, instance 2 connects over private IP (SG-restricted). Proper later:
    RDS PostgreSQL (Single-AZ db.t4g.medium ≈ +$50/mo) ± ElastiCache.
  - **Worker / durable cron must run exactly once** — run the coding worker on one
    designated instance only (web tier multi-instance, worker single) until DB
    claim semantics are verified for multi-writer.
  - **Coding workspaces** are a box-local Docker volume — a session's worktree
    lives on the instance that created it. Keep worker single-instance initially
    (workspaces stay local to it); EFS or per-session pinning is the later fix.
  - Deploy pipeline: deploy to instances **serially** (drain → deploy →
    re-register → next) instead of blue-green-on-one-box.

### Option C — ECS/EKS + RDS (full modernization). Not recommended now
Right answer at 10× scale; at current size it trades a working, understood system
for orchestration complexity. Option B delivers the same availability for far less.

## 3. Canada region options

Both Canadian regions run our full stack (EC2, ALB, RDS, ElastiCache, ECR, SSM,
AWS Backup — verified against AWS service-availability references, 2026-07-29).

| | **ca-central-1 (Montreal)** ✅ recommended | **ca-west-1 (Calgary)** |
|---|---|---|
| AZs | 3 | 3 |
| Enablement | default-on | **opt-in region** (must enable in account) |
| Service breadth | full; new services land first | launched Dec 2023 (~70 services); rollouts trail (e.g. DocumentDB only arrived 2026-04) |
| EC2 price | t3.large **$0.0928/h** (~$68/mo) | identical |
| Best for | eastern Canada users; max service availability | western Canada users; intra-Canada DR pair |

**Cost reality:** Canada runs ≈ **+10–12%** over us-east-1 (t3.large $0.0928 vs
$0.0832/h). **Data residency:** moving to a Canadian region keeps customer data
in-country, which is what Canadian data-residency expectations (PIPEDA, Quebec
Law 25) look for — a genuine product/compliance benefit, not just latency.

## 4. Migration approaches to Canada

1. **Lift-and-shift (AMI copy).** Snapshot prod → `Copy AMI` to ca-central-1
   (EBS snapshots copy with it) → launch → final `pg_dump` sync → cut DNS.
   Fastest (hours); brings the box's whole state along. Brief write-freeze window
   for the final DB sync. **Elastic IPs cannot move regions** — new IPs in Canada.
2. **Clean rebuild + data restore.** Provision fresh with the existing setup
   scripts, rsync `/opt/crossmodel`, restore latest `pg_dump` from S3. Cleanest
   box; slightly more hands-on. Same cutover window.
3. **Build the target architecture in Canada (recommended).** Since we want both
   load balancing AND Canada: build Option B (ALB + 2 instances) fresh in
   ca-central-1, migrate data via `pg_dump`, cut over DNS once, keep the
   us-east-1 box stopped-not-terminated for ~2 weeks as fallback. One migration,
   both goals, no double work.

## 5. Recommended phased plan (Option B in ca-central-1 via approach 3)

- **Phase 0 — prep (no user impact).** Lower DNS TTL on `digby.ai`/`mcp.digby.ai`
  to 60s a day ahead. Create ca-central-1 resources: VPC/subnets across 2 AZs,
  SGs, new S3 backup bucket in-region (residency), recreate AWS Backup plan,
  ACM cert, IAM instance role (mirror `digby-backup-ec2-role`).
- **Phase 1 — build + sync.** Launch instance 1, restore latest `pg_dump`, rsync
  app, point a temp hostname at it, run the full health + auth-smoke gates.
  Set up continuous-ish sync (repeat final `pg_dump` right before cutover).
- **Phase 2 — cutover (minutes of write-freeze).** Stop writes on old box
  (maintenance flag / stop backend briefly) → final `pg_dump` → restore in CA →
  flip DNS (Route53 or registrar) → verify → re-enable. Old box stays stopped as
  fallback.
- **Phase 3 — load balancing.** Add ALB + ACM, register instance 1, launch
  instance 2 (app tier only; worker/cron stays pinned to instance 1), switch
  deploy workflow to serial rolling deploys with ALB draining, raise ALB idle
  timeout for SSE. Retire on-box certbot.
- **Phase 4 — cleanup + optional upgrades.** After ~2 stable weeks terminate the
  us-east-1 box (EBS snapshot retained). Optional: RDS Postgres, ElastiCache,
  Reserved Instances/Savings Plans (~30–40% off the 2-instance baseline).

**Monthly cost shape (on-demand, approximate):** today ≈ $70 (1× t3.large + EBS)
→ target ≈ **$165–175** (2× t3.large $136 + ALB ~$23 + EBS), +$50 if RDS added.

## 6. Risks / open questions

- Worker + durable cron exactly-once under multi-instance — **must stay
  single-instance** until claim semantics are verified (Phase 3 constraint).
- Coding-workspace locality (box-local Docker volume) — solved by single worker
  instance; EFS is the future fix.
- Region-pinned resources to recreate: AWS Backup plan/vault, S3 backup bucket,
  ACM cert, Elastic IPs; GitHub secrets (`EC2_HOST`, SSH key) must be updated at
  cutover, plus `NEXT_PUBLIC_API_URL` stays same-host so no app change needed.
- SSE: ALB idle timeout must exceed backend stream heartbeat gaps; draining
  delay ≥ longest tolerated stream.
- Verified facts note: Canada ALB/LCU exact rates not confirmable from official
  pages in-session (JS-loaded regional tables) — sanity-check on the pricing page
  before commit; us-east-1 baselines used above.

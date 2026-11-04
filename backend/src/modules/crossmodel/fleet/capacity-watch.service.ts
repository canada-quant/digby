/**
 * CAPACITY WATCH (todo 0f58ddde, goal fa54f4b9 — the 2026-10-16 board-surface
 * gap): the fleet's shared coding box saturates in three measurable ways — the
 * deploy DRAINER pool fills (a parked drainer with live runs is force-evicted
 * by the next wave), a shared dev container pins its cgroup at >90% (every
 * co-tenant verify dies env-red), and the ticket-dispatch queue stalls at
 * full occupancy with waiting tickets and zero spawns. The 2026-10-16 baseline
 * was found by an EXTERNAL agent's 13:05 PT sweep, not by any harness line.
 *
 * Shape (detection only — remediation belongs to the linked tickets, never
 * here; this module never restarts, resizes, reaps or re-dispatches):
 *
 *   ┌─ WRITERS (box C only — volume-bound 'capacity-probe' cron, 15 min) ─┐
 *   │ drainer pool  : docker ps name-epoch + agent_runs.workerId counts   │
 *   │ dev container : docker exec cgroup v2 memory (WORKING SET)          │
 *   ├─ WRITER (any worker — rides the ticket-drain drain itself)          │
 *   │ ticket queue  : the drain's own slot accounting, one row per drain  │
 *   └──────────────────────────────────────────────────────────────────────┘
 *                 ↓ loop_metrics (capacity_drainer_pool / capacity_dev_memory /
 *                 ↓              capacity_ticket_queue — ONE row per check,
 *                 ↓              healthy included, so the series charts)
 *   ┌─ CLASSIFIER (DB-only, sweepInfraWatch section 5 — any worker) ───────┐
 *   │ 2-CONSECUTIVE-CHECK persistence window on each signal (anti-flap):   │
 *   │ the newest row must be fresh (< 2 × cadence) and the one before it   │
 *   │ must BOTH breach — a single spike (a GC pause, one long deploy)      │
 *   │ never pages.                                                         │
 *   └──────────────────────────────────────────────────────────────────────┘
 *                 ↓ infra-watch deliver() — [INFRA ALERT — capacity] wake to
 *                 ↓   every admin Fleet Supervisor: Redis-deduped per (kind,
 *                 ↓   subject, severity) for INFRA_ALERT_DEDUPE_SEC (6 h),
 *                 ↓   supervisor-OFF inherited, infra_alert telemetry, and
 *                 ↓   the fleet [BOARD] capacity line (board-digest) so the
 *                 ↓   condition stays visible on EVERY fleet wake between
 *                 ↓   alerts. The alert names the linked tickets — it never
 *                 ↓   files a new one (the asks already sit inside them).
 *
 * The box-boundary rule (explorer finding): docker reads only work where
 * DOCKER_HOST reaches the coding box's filtered proxy (CONTAINERS=1, EXEC=1
 * are allowed; SYSTEM/VOLUMES denied), i.e. the box-C worker — the same rule
 * that keeps VOLUME_BOUND_CRON_JOBS off box A's 0-slot worker. Every docker
 * read is fail-open: an unavailable docker socket reads as NO row (never a
 * false "healthy" and never a throw into the cron loop) and the classifier
 * ages rows out instead (stale data says nothing).
 */

import { execFile } from 'child_process';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { boxLabel } from './infra-watch.service';

export const SOURCE = 'capacity-watch';
export const CAPACITY_WATCH_DISABLED_ENV = 'CAPACITY_WATCH_DISABLED';

/** Probe cadence = the 'capacity-probe' cron (worker.ts). The classifier's
 *  freshness bound and the persistence window are derived from it. */
export const CAPACITY_PROBE_INTERVAL_SEC = 900;
/** A reading older than 2 × cadence is STALE — the probe stopped (deploy
 *  window, docker socket loss) and stale data must read as "unknown", never
 *  as a sustained breach (the backup-lapse silence rule, applied here). */
export const CAPACITY_STALE_MS = 2 * CAPACITY_PROBE_INTERVAL_SEC * 1000;
/** ticket-drain cadence (worker.ts 'ticket-drain' 1800 s) — the queue
 *  signal's own staleness bound. */
export const TICKET_DRAIN_INTERVAL_SEC = 1800;

/** Kill switch (ticket 6808c3ef): '1' restores the pre-liveness-axis breach —
 *  a full queue with waiting tickets alerts on volume alone, even when every
 *  occupied lane is live mid-run (the 2026-10-20 18:09Z false alert class).
 *  For an operator who suspects the liveness axis is masking a real stall. */
export const CAPACITY_QUEUE_LIVENESS_DISABLED_ENV = 'CAPACITY_QUEUE_LIVENESS_DISABLED';
export function queueLivenessAxisDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CAPACITY_QUEUE_LIVENESS_DISABLED_ENV] === '1';
}

/** Ticket 6808c3ef: a lane counts as LIVE for the queue signal when its
 *  newest run row was touched this recently — an agent_run row with a fresh
 *  updatedAt is a lane actively executing (the executor's lease heartbeat
 *  rewrites heartbeatAt/updatedAt on a short cadence), and the 18:09Z false
 *  alert read four such lanes as "occupied-but-idle" purely from occupancy.
 *  Two drain cadences (60 min) of total run silence is a lane that is NOT
 *  making progress on its row — that is the zombie shape the alert exists
 *  for. Env-tunable for tests and operator tuning; '0' disables the freshness
 *  read (falls back to the status-only live test).
 *
 *  Review follow-up (6808c3ef, deployed-code audit): compose forwards the
 *  var SEEDED EMPTY when unset (docker-compose.app.yml ${VAR:-}), and
 *  Number('') === 0 — so the naive Number() read turned every untouched
 *  deployment into "freshness off" (occupiedLive degenerating to
 *  has-a-queued/running-run-now, the axis's weaker half). An empty string is
 *  UNSET, not zero: only an explicit numeric value (including '0') is
 *  honored; empty/garbage/negative fall back to the default. */
export const QUEUE_LIVE_FRESH_MS_DEFAULT = 2 * TICKET_DRAIN_INTERVAL_SEC * 1000;
export function queueLiveFreshMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAPACITY_QUEUE_LIVE_FRESH_MS;
  if (raw === undefined || raw.trim() === '') return QUEUE_LIVE_FRESH_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : QUEUE_LIVE_FRESH_MS_DEFAULT;
}

// ── Thresholds (env-tunable, all read per call — live-flippable) ──────────────

/** Drainer pool: alert when EVERY slot is occupied AND the oldest parked
 *  drainer has been draining at least this long (a fresh wave's 4 parked
 *  drainers is normal fleet operation; one parked 60+ min with the pool full
 *  is the 2026-10-16 measured state — 99 min, 7 live runs). */
export const DRAINER_OLDEST_MIN_DEFAULT = 60;
export function drainerOldestMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CAPACITY_DRAINER_OLDEST_MIN);
  return Number.isFinite(n) && n > 0 ? n : DRAINER_OLDEST_MIN_DEFAULT;
}
/** WORKER_MAX_DRAINERS (deploy-coding-worker.sh) — the deploy-side cap the
 *  enforcement arm interrupts past. Not carried in the worker env, so it is
 *  env-tunable with the same default. */
export const DRAINER_CAP_DEFAULT = 4;
export function drainerCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WORKER_MAX_DRAINERS ?? env.CAPACITY_DRAINER_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DRAINER_CAP_DEFAULT;
}

/** Dev-container memory: the WORKING SET pct (page-cache-corrected — the
 *  2026-09-29 lesson) at which a container is "over 90%". */
export const DEV_MEMORY_PCT_DEFAULT = 90;
export function devMemoryPct(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CAPACITY_DEV_MEMORY_PCT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEV_MEMORY_PCT_DEFAULT;
}

export function capacityWatchDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CAPACITY_WATCH_DISABLED_ENV] === '1';
}

// ── docker seam (fail-open; box C's socket proxy allows CONTAINERS + EXEC) ────

function docker(args: string[], timeoutMs = 20_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

// ── Signal 1: drainer pool ────────────────────────────────────────────────────

/** admin-worker-<color>-drain-<epoch> — the park timestamp IS the name suffix
 *  (deploy-coding-worker.sh park_drainer: epoch = date +%s). */
export const DRAINER_NAME_RE = /^admin-worker-(blue|green)-drain-(\d+)$/;

export interface DrainerReading {
  name: string;
  /** minutes since park (from the name epoch — no docker inspect needed) */
  ageMin: number;
  /** live (queued|running) agent_runs still attributed to the drainer's
   *  hostname — 0 when uncountable (inspect failed), never guessed */
  running: number;
}

export function parseDrainerNames(
  names: string[],
  nowSec: number = Math.floor(Date.now() / 1000),
): Array<Pick<DrainerReading, 'name' | 'ageMin'>> {
  const out: Array<Pick<DrainerReading, 'name' | 'ageMin'>> = [];
  for (const raw of names) {
    const m = DRAINER_NAME_RE.exec(String(raw || '').trim());
    if (!m) continue;
    const epoch = Number(m[2]);
    if (!Number.isFinite(epoch) || epoch <= 0 || epoch > nowSec) continue; // clock skew / garbage
    out.push({ name: String(raw).trim(), ageMin: Math.max(0, Math.round((nowSec - epoch) / 60)) });
  }
  return out;
}

/** Count this drainer's live runs via agent_runs.workerId = worker-<hostname>-<pid>.
 *  The rename keeps the container's hostname, so the prefix identifies it. */
async function drainerRunningCount(name: string): Promise<number> {
  try {
    const { stdout } = await docker(['inspect', '-f', '{{.Config.Hostname}}', name]);
    const host = String(stdout).trim();
    if (!host) return 0;
    const count = await (prisma.agentRun as any).count({
      where: { status: { in: ['queued', 'running'] }, workerId: { startsWith: `worker-${host}-` } },
    }).catch(() => null);
    return Number.isFinite(Number(count)) ? Number(count) : 0;
  } catch {
    return 0; // inspect failed (proxy denies / container vanished) — 0, never a guess
  }
}

/** ONE capacity_drainer_pool row per probe tick — healthy included (the series
 *  must chart occupancy, not only breaches). Never throws into the cron loop. */
export async function probeDrainerPool(): Promise<void> {
  if (capacityWatchDisabled()) return;
  const host = boxLabel();
  try {
    const { stdout } = await docker(['ps', '--format', '{{.Names}}']);
    const parked = parseDrainerNames(String(stdout).split('\n'));
    const cap = drainerCap();
    const drainers: DrainerReading[] = [];
    for (const d of parked) drainers.push({ ...d, running: await drainerRunningCount(d.name) });
    drainers.sort((a, b) => b.ageMin - a.ageMin); // oldest first (deploy-script order)
    const oldestAgeMin = drainers.length ? drainers[0].ageMin : 0;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.CAPACITY_DRAINER_POOL,
      value: drainers.length,
      unit: 'drainers',
      meta: {
        host,
        signal: 'drainer_pool',
        occupied: drainers.length,
        cap,
        oldestAgeMin,
        oldestName: drainers.length ? drainers[0].name : null,
        drainers: drainers.map((d) => ({ name: d.name, ageMin: d.ageMin, running: d.running })),
      },
    });
  } catch (err: any) {
    // docker unavailable (not the coding box / socket down): no row — the
    // classifier's staleness bound handles the gap; never a false healthy.
    logger.debug(`${SOURCE}: drainer probe unavailable (non-fatal): ${err?.message ?? err}`);
  }
}

// ── Signal 2: dev-container memory (WORKING SET) ─────────────────────────────

/** cgroup v2 memory.current / memory.max / memory.stat inactive_file in ONE
 *  docker exec round-trip. Mirrors infra-actions probeCgroupMemory + verify's
 *  parseCgroupPressure (the 2026-09-29 page-cache lesson): pressure is the
 *  WORKING SET (current − inactive_file), never raw current. */
export function parseDevMemory(
  stdout: string,
): { currentBytes: number; maxBytes: number; oomKill: number | null; inactiveFileBytes: number | null } | null {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const num = (v: string | undefined): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const currentBytes = num(lines[0]);
  if (currentBytes == null || currentBytes < 0) return null;
  if (lines[1] === 'max') return null; // unlimited — no ceiling, no pct
  const maxBytes = num(lines[1]);
  if (maxBytes == null || maxBytes <= 0 || currentBytes > maxBytes) return null;
  let oomKill: number | null = null;
  let inactiveFileBytes: number | null = null;
  for (const l of lines.slice(2)) {
    if (oomKill == null && l.startsWith('oom_kill ')) oomKill = num(l.split(/\s+/)[1] ?? undefined);
    if (inactiveFileBytes == null && l.startsWith('inactive_file ')) inactiveFileBytes = num(l.split(/\s+/)[1] ?? undefined);
  }
  if (inactiveFileBytes != null && (inactiveFileBytes < 0 || inactiveFileBytes > currentBytes)) inactiveFileBytes = null;
  return { currentBytes, maxBytes, oomKill, inactiveFileBytes };
}

export interface DevMemoryReading { container: string; pct: number; workingSetKb: number; maxKb: number; rawPct?: number; oomKill: number | null }

/** ONE capacity_dev_memory row per RUNNING digby.dev.container per tick —
 *  healthy included. Never throws into the cron loop. */
export async function probeDevMemory(): Promise<void> {
  if (capacityWatchDisabled()) return;
  const host = boxLabel();
  try {
    const { stdout } = await docker([
      'ps', '--filter', 'label=digby.dev.container', '--filter', 'status=running', '--format', '{{.Names}}',
    ]);
    const names = String(stdout).split('\n').map((s) => s.trim()).filter(Boolean);
    let cgroupFailures = 0;
    for (const container of names) {
      try {
        const { stdout: cg } = await docker([
          'exec', container, 'sh', '-c',
          // memory.current + memory.max + memory.events (oom_kill) + memory.stat
          // (inactive_file — the working-set correction). Same file set
          // infra-actions' probeCgroupMemory reads; one round-trip.
          'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.stat 2>/dev/null',
        ]);
        const parsed = parseDevMemory(cg);
        if (!parsed) { cgroupFailures++; continue; } // unreadable cgroup — say nothing
        const workingSet = parsed.inactiveFileBytes != null ? parsed.currentBytes - parsed.inactiveFileBytes : parsed.currentBytes;
        const pct = (workingSet / parsed.maxBytes) * 100;
        const rawPct = (parsed.currentBytes / parsed.maxBytes) * 100;
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.CAPACITY_DEV_MEMORY,
          value: Math.round(pct * 10) / 10,
          unit: 'pct',
          meta: {
            host,
            signal: 'dev_memory',
            container,
            pct: Math.round(pct * 10) / 10,
            rawPct: Math.round(rawPct * 10) / 10,
            workingSetKb: Math.round(workingSet / 1024),
            maxKb: Math.round(parsed.maxBytes / 1024),
            oomKill: parsed.oomKill,
          },
        });
      } catch (err: any) {
        // one unreadable container never stops the rest — but a WHOLE probe of
        // failures is the "signal 2 silently dark" class, so it logs once per
        // tick (throttled to a single warn below), never per container.
        cgroupFailures++;
        lastDevMemoryError = err?.message ?? String(err);
      }
    }
    if (names.length && cgroupFailures === names.length) {
      // EVERY container failed — exec denied (proxy policy), cgroup v1, or the
      // socket wedged. One warn per tick, throttled to 1/hour.
      const nowMs = Date.now();
      if (nowMs - lastDevMemoryWarnAt > 3600_000) {
        lastDevMemoryWarnAt = nowMs;
        logger.warn(`${SOURCE}: dev-memory probe read 0 of ${names.length} containers (last error: ${lastDevMemoryError ?? 'unknown'}) — signal 2 is dark this tick; check the docker socket proxy's EXEC allowance and the container cgroup layout`, { source: SOURCE });
      }
    }
  } catch (err: any) {
    logger.debug(`${SOURCE}: dev-memory probe unavailable (non-fatal): ${err?.message ?? err}`);
  }
}

let lastDevMemoryWarnAt = 0;
let lastDevMemoryError: string | null = null;

// ── Signal 3: ticket-dispatch queue (writer lives in the drain itself) ───────

/** The drain's own slot accounting → ONE capacity_ticket_queue row (healthy
 *  included). Called from freshLaneDrainLocked — fire-and-forget, never
 *  throws. `archived`/`heldByFiler` may be absent on early paths; the row
 *  still lands so the series has no gaps the classifier could misread.
 *  47397831: familyLanes / familyMembersRiding ride in meta so the
 *  queue-depth attributable to auto-filer families is measurable per drain. */
export function recordTicketQueueDepth(input: {
  occupied: number; cap: number; waiting: number; spawned: number; heldByFiler?: number; archived?: number;
  familyLanes?: number; familyMembersRiding?: number; occupiedLive?: number;
  // TICKET-LANE ARCHIVE GAPS (2026-10-21): the drain's lane-archive axes —
  // archives of awaiting_verification tickets' lanes, orphaned previous
  // lanes archived, 'running' satellites healed before an archive, and the
  // closed-lane scan's row count. Passed only while the gaps switch is off.
  archivedAwaiting?: number; archivedPrevious?: number; healedRunning?: number; closedScanRows?: number;
  // Third review (2026-10-22): the closed-lane scan hit its row ceiling / the
  // closed loop deferred archives past its per-drain bound — present only when they bit.
  closedScanCapped?: boolean; closedArchiveDeferred?: number;
}): void {
  try {
    if (capacityWatchDisabled()) return;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.CAPACITY_TICKET_QUEUE,
      value: input.waiting,
      unit: 'waiting',
      meta: {
        signal: 'ticket_queue',
        occupied: Math.min(input.occupied, input.cap),
        cap: input.cap,
        waiting: input.waiting,
        spawned: input.spawned,
        heldByFiler: input.heldByFiler ?? 0,
        archived: input.archived ?? 0,
        ...(input.familyLanes !== undefined ? { familyLanes: input.familyLanes } : {}),
        ...(input.familyMembersRiding !== undefined ? { familyMembersRiding: input.familyMembersRiding } : {}),
        // 6808c3ef: the liveness axis — how many of the occupied lanes are
        // PROVABLY live (queued/running run row touched inside
        // queueLiveFreshMs). Absent on rows written before this fix; the
        // breach's missing-axis rule keeps those alerting as before.
        ...(input.occupiedLive !== undefined ? { occupiedLive: input.occupiedLive } : {}),
        ...(input.archivedAwaiting !== undefined ? { archivedAwaiting: input.archivedAwaiting } : {}),
        ...(input.archivedPrevious !== undefined ? { archivedPrevious: input.archivedPrevious } : {}),
        ...(input.healedRunning !== undefined ? { healedRunning: input.healedRunning } : {}),
        ...(input.closedScanRows !== undefined ? { closedScanRows: input.closedScanRows } : {}),
        ...(input.closedScanCapped ? { closedScanCapped: true } : {}),
        ...(input.closedArchiveDeferred !== undefined ? { closedArchiveDeferred: input.closedArchiveDeferred } : {}),
      },
    });
  } catch { /* telemetry must never take the drain down */ }
}

// ── Classifier (DB-only; sweepInfraWatch section 5 — any worker) ─────────────

export type CapacitySignalKind = 'drainer_pool' | 'dev_memory' | 'ticket_queue';

export interface CapacityAlert {
  kind: 'capacity';
  signal: CapacitySignalKind;
  /** the subject the dedupe key carries: host (drainer/dev-memory) or 'fleet' (queue) */
  subject: string;
  severity: 'warn';
  /** the two consecutive readings that proved persistence (for the wake text) */
  firstAt: Date;
  lastAt: Date;
  meta: Record<string, unknown>;
}

/** The most recent rows of one capacity kind within the staleness window,
 *  newest first. null when fewer than 2 rows (a signal needs its persistence
 *  pair — ONE spike never alerts). */
export async function latestCapacityRows(
  kind: string,
  now: Date,
  stalenessMs: number,
): Promise<Array<{ createdAt: Date; meta: any }> | null> {
  const since = new Date(now.getTime() - stalenessMs);
  const rows = (await prisma.loopMetric.findMany({
    where: { kind, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, meta: true },
    take: 60,
  }).catch(() => [])) as Array<{ createdAt: Date; meta: any }>;
  return rows.length >= 2 ? rows : null;
}

/** Drainer-pool breach: EVERY slot occupied AND oldest parked ≥ threshold. */
export function drainerBreach(meta: any, env: NodeJS.ProcessEnv = process.env): boolean {
  const occupied = Number(meta?.occupied);
  const cap = Number(meta?.cap);
  const oldest = Number(meta?.oldestAgeMin);
  if (!Number.isFinite(occupied) || !Number.isFinite(cap) || cap <= 0) return false;
  if (!Number.isFinite(oldest)) return false;
  return occupied >= cap && oldest >= drainerOldestMin(env);
}

/** Dev-memory breach: WORKING-SET pct ≥ threshold (a rawPct-only row with no
 *  working-set reading cannot breach — memory.stat was unreadable). */
export function devMemoryBreach(meta: any, env: NodeJS.ProcessEnv = process.env): boolean {
  const pct = Number(meta?.pct);
  if (!Number.isFinite(pct)) return false;
  return pct >= devMemoryPct(env);
}

/** Queue breach: full occupancy AND tickets waiting AND nothing spawned — the
 *  "unmoved" state. A drain that SPAWNED is movement by definition.
 *
 *  Ticket 6808c3ef — the liveness axis (the f170 lesson, generalized): the
 *  2026-10-20 18:09Z alert fired on a queue whose four occupied lanes were ALL
 *  live mid-run (run-level probe: fresh queued/running agent_runs rows) — a
 *  healthy BUSY queue read as "stuck" and paged a wasted priority-4 lane.
 *  Occupancy alone does not distinguish "full and stuck" from "full and
 *  working". With the occupiedLive axis present, the breach additionally
 *  requires a ZOMBIE: at least one occupied lane whose runs are not provably
 *  live (occupiedLive < occupied). MISSING axis (rows written before this
 *  fix, or a drain that could not compute it) keeps the pre-fix volume-only
 *  rule — the axis can only ever NARROW an alert, never silence the signal;
 *  CAPACITY_QUEUE_LIVENESS_DISABLED=1 restores volume-only for operators. */
export function ticketQueueBreach(meta: any, env: NodeJS.ProcessEnv = process.env): boolean {
  const occupied = Number(meta?.occupied);
  const cap = Number(meta?.cap);
  const waiting = Number(meta?.waiting);
  const spawned = Number(meta?.spawned ?? 0);
  if (!Number.isFinite(occupied) || !Number.isFinite(cap) || cap <= 0) return false;
  if (!Number.isFinite(waiting) || waiting <= 0) return false;
  if (!(occupied >= cap && spawned === 0)) return false;
  if (queueLivenessAxisDisabled(env)) return true;
  const occupiedLive = Number(meta?.occupiedLive);
  if (!Number.isFinite(occupiedLive)) return true; // missing axis: pre-fix rule, never silent
  return occupiedLive < occupied;
}

/**
 * The 2-consecutive-check persistence window (the anti-flap rule): the NEWEST
 * row must be fresh and the row BEFORE it must ALSO breach. A deploy wave's
 * one-off drainer spike or a single GC pause never pages; a sustained
 * condition pages on the second consecutive reading.
 */
export async function classifyCapacity(now: Date = new Date()): Promise<CapacityAlert[]> {
  if (capacityWatchDisabled()) return []; // re-checked here AND at the sweep seam
  const alerts: CapacityAlert[] = [];

  // 1. drainer pool — per host (single-tenant: one coding box, but the key is
  //    host-shaped so a second box never collides).
  try {
    const rows = await latestCapacityRows(LOOP_METRIC_KINDS.CAPACITY_DRAINER_POOL, now, CAPACITY_STALE_MS);
    // the persistence pair is the SAME host's two newest rows
    if (rows) {
      const host = String(rows[0].meta?.host ?? '');
      const pair = rows.filter((r) => String(r.meta?.host ?? '') === host).slice(0, 2);
      if (pair.length === 2 && drainerBreach(pair[0].meta) && drainerBreach(pair[1].meta)) {
        alerts.push({
          kind: 'capacity', signal: 'drainer_pool', subject: host || 'unknown', severity: 'warn',
          firstAt: pair[1].createdAt, lastAt: pair[0].createdAt,
          meta: {
            occupied: pair[0].meta?.occupied, cap: pair[0].meta?.cap,
            oldestAgeMin: pair[0].meta?.oldestAgeMin, oldestName: pair[0].meta?.oldestName,
            drainers: pair[0].meta?.drainers, host: host || 'unknown',
          },
        });
      }
    }
  } catch (err: any) {
    logger.warn(`${SOURCE}: drainer classify failed (non-fatal): ${err?.message ?? err}`);
  }

  // 2. dev-container memory — per container; BOTH of the breaching
  //    container's two newest rows must breach (a container that dipped
  //    healthy between two breaches has NOT sustained).
  try {
    const rows = await latestCapacityRows(LOOP_METRIC_KINDS.CAPACITY_DEV_MEMORY, now, CAPACITY_STALE_MS);
    if (rows && devMemoryBreach(rows[0].meta)) {
      const container = String(rows[0].meta?.container ?? '');
      const pair = container ? rows.filter((r) => String(r.meta?.container ?? '') === container).slice(0, 2) : [];
      if (pair.length === 2 && devMemoryBreach(pair[0].meta) && devMemoryBreach(pair[1].meta)) {
        alerts.push({
          kind: 'capacity', signal: 'dev_memory', subject: container, severity: 'warn',
          firstAt: pair[1].createdAt, lastAt: pair[0].createdAt,
          meta: {
            container, host: pair[0].meta?.host, pct: pair[0].meta?.pct,
            workingSetKb: pair[0].meta?.workingSetKb, maxKb: pair[0].meta?.maxKb,
            oomKill: pair[0].meta?.oomKill,
          },
        });
      }
    }
  } catch (err: any) {
    logger.warn(`${SOURCE}: dev-memory classify failed (non-fatal): ${err?.message ?? err}`);
  }

  // 3. ticket-dispatch queue — fleet-wide (the drain is single-flight locked;
  //    its rows are the only source of truth).
  try {
    const rows = await latestCapacityRows(LOOP_METRIC_KINDS.CAPACITY_TICKET_QUEUE, now, 2 * TICKET_DRAIN_INTERVAL_SEC * 1000);
    if (rows && ticketQueueBreach(rows[0].meta) && ticketQueueBreach(rows[1].meta)) {
      alerts.push({
        kind: 'capacity', signal: 'ticket_queue', subject: 'fleet', severity: 'warn',
        firstAt: rows[1].createdAt, lastAt: rows[0].createdAt,
        meta: {
          occupied: rows[0].meta?.occupied, cap: rows[0].meta?.cap,
          waiting: rows[0].meta?.waiting, spawned: rows[0].meta?.spawned,
          // 6808c3ef: carry the liveness axis into the alert (render names it);
          // absent on pre-fix rows — the render omits the liveness sentence.
          ...(rows[0].meta?.occupiedLive !== undefined ? { occupiedLive: rows[0].meta.occupiedLive } : {}),
        },
      });
    }
  } catch (err: any) {
    logger.warn(`${SOURCE}: ticket-queue classify failed (non-fatal): ${err?.message ?? err}`);
  }

  return alerts;
}

const hhmmz = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

/** The linked tickets every capacity alert cites — the asks (detection AND
 *  remediation) already live inside them; this surface never re-files. */
export const CAPACITY_TICKETS: ReadonlyArray<{ id: string; signal: CapacitySignalKind }> = [
  { id: 'ed057f9d', signal: 'drainer_pool' },
  { id: 'ff262da5', signal: 'dev_memory' },
  { id: 'ff262da5', signal: 'ticket_queue' },
];

/** Render ONE [INFRA ALERT — capacity] wake. Playbook names the ticket and the
 *  verify line; remediation stays with the ticket's lane, never here. */
export function renderCapacityAlert(a: CapacityAlert, now: Date): string {
  const tickets = CAPACITY_TICKETS.filter((t) => t.signal === a.signal).map((t) => t.id);
  const ticketLine = tickets.length
    ? ` Linked ticket${tickets.length > 1 ? 's' : ''} ${tickets.join(', ')} own${tickets.length > 1 ? '' : 's'} the remediation asks — dispatch against the ticket id, never re-file it.`
    : '';
  if (a.signal === 'drainer_pool') {
    return `[INFRA ALERT — capacity: drainer pool full] ${a.meta.host}'s deploy drainer pool is FULL (${a.meta.occupied}/${a.meta.cap} slots) with the oldest parked drainer (${a.meta.oldestName}) draining ${a.meta.oldestAgeMin} min (breaching on 2 consecutive checks, first seen ${hhmmz(a.firstAt)}, now ${hhmmz(now)}). With the pool full the NEXT deploy wave force-evicts a drainer that may still carry live runs (${(a.meta.drainers as any[] | undefined)?.map((d) => `${d.name}: ${d.running} live`).join('; ') || 'run counts unavailable'}).${ticketLine} Playbook: this is a SATURATION alert, not a deploy failure — do NOT cancel deploys and do NOT kill drainers; the wait-for-free-slot and batch-waves asks are the linked ticket's. Verify: get_fleet_telemetry view 'metrics' kind 'capacity_drainer_pool' shows occupied < cap (or the oldest drainer exits) on the next reading.`;
  }
  if (a.signal === 'dev_memory') {
    return `[INFRA ALERT — capacity: dev container memory] ${a.meta.container} on ${a.meta.host} is at ${a.meta.pct}% of its memory ceiling (working set ${(Number(a.meta.workingSetKb) / 1024 / 1024).toFixed(1)} GiB of ${(Number(a.meta.maxKb) / 1024 / 1024).toFixed(1)} GiB, oom_kill cumulative ${a.meta.oomKill ?? 'unknown'}) breaching on 2 consecutive checks, first seen ${hhmmz(a.firstAt)} (now ${hhmmz(now)}). At this saturation every co-tenant verify dies environmental (exit 137 / empty output) while the code is green in isolation.${ticketLine} Playbook: do NOT restart the container and do NOT resize it from this alert — the per-container cap and env-starved-verdict asks are the linked ticket's; batch verify runs, never parallel tsc/jest. Verify: get_fleet_telemetry view 'metrics' kind 'capacity_dev_memory' shows pct below ${devMemoryPct()} for ${a.meta.container} on the next reading.`;
  }
  return `[INFRA ALERT — capacity: ticket queue unmoved] the ticket-dispatch queue is FULL (${a.meta.occupied}/${a.meta.cap} lanes) with ${a.meta.waiting} ticket(s) waiting and 0 spawned on two consecutive drains (first seen ${hhmmz(a.firstAt)}, now ${hhmmz(now)}) — the queue has not moved.${a.meta.occupiedLive !== undefined ? ` Liveness: ${a.meta.occupiedLive}/${a.meta.occupied} occupied lanes are provably live (fresh queued/running agent_runs rows)${Number(a.meta.occupiedLive) < Number(a.meta.occupied) ? ' — the rest are the zombie shape this alert exists for' : ''}.` : ''} A full-and-BUSY queue (every lane live mid-run) is healthy saturation, NOT a stall — do NOT re-file it (the 2026-10-20 18:09Z alert class, ticket 6808c3ef). Occupied-but-idle lanes (the 6 h / 8 h reclaim windows) and a starved spawn box read the same from outside: the drains, not the tickets, are the evidence.${ticketLine} Playbook: read the drain's own rows (get_fleet_telemetry view 'metrics' kind 'capacity_ticket_queue', latest meta) — and for liveness, read the LANES' agent_runs rows directly (run-level: id/status/heartbeat/lease per lane, ticket 2dc0988c), NEVER a chat-list running flag (the 18:09Z filer's list_chats read disagreed with the agent_runs ground truth). The per-container starvation asks are the linked ticket's. Verify: a later capacity_ticket_queue row shows spawned > 0 or waiting = 0.`;
}

/**
 * The fleet [BOARD] capacity line (todo 0f58ddde): ONE compact line for every
 * signal the classifier currently proves sustained (the SAME 2-consecutive
 * evidence the alert uses — the board and the alert can never disagree).
 * null when nothing is breaching (the board stays clean when healthy), when
 * rows are stale, or when the kill switch is set. DB-only, never throws.
 */
export async function fleetCapacityBoardLine(now: Date = new Date()): Promise<string | null> {
  try {
    if (capacityWatchDisabled()) return null;
    const alerts = await classifyCapacity(now);
    if (!alerts.length) return null;
    const parts = alerts.map((a) => {
      if (a.signal === 'drainer_pool') return `drainer pool FULL ${a.meta.occupied}/${a.meta.cap} on ${a.meta.host} (oldest draining ${a.meta.oldestAgeMin}m)`;
      if (a.signal === 'dev_memory') return `${a.subject} at ${a.meta.pct}% mem on ${a.meta.host}`;
      return `ticket queue FULL ${a.meta.occupied}/${a.meta.cap}, ${a.meta.waiting} waiting, 0 spawned`;
    });
    const tickets = [...new Set(alerts.flatMap((a) => CAPACITY_TICKETS.filter((t) => t.signal === a.signal).map((t) => t.id)))];
    return `CAPACITY (capacity-watch, breaching on 2 consecutive checks, first seen ${hhmmz(alerts[0].firstAt)}): ${parts.join(' · ')} — linked ticket${tickets.length > 1 ? 's' : ''} ${tickets.join(', ')} own${tickets.length > 1 ? '' : 's'} the remediation; verify via get_fleet_telemetry view 'metrics' kinds capacity_*.`;
  } catch {
    return null; // a board line is never load-bearing for the wake
  }
}

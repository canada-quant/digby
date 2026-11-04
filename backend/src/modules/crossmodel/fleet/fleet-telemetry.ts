/**
 * Fleet telemetry — the read-only VERIFICATION surface behind the
 * `get_fleet_telemetry` platform tool (owner 2026-09-18: "harden the fleet
 * supervisor so you can retire and it can take over your role as the
 * framework operator").
 *
 * What the human operator did by hand to verify a fix — `git log origin/main`,
 * `gh run list`, a DB probe over loop_metrics, `df` on each box — the
 * supervisor could not do at all: it had no read of main's head, of the deploy
 * runs, of what sha each box runs, or of any loop metric. Its VERIFY BEFORE
 * DONE doctrine therefore ended in "unverified" or, worse, in "the lane says it
 * merged". This module assembles those four reads into one JSON answer:
 *
 *   view=boxes    latest box_health row per box (disk / memory / load / the
 *                 sha the process was built from / staleness)
 *   view=deploy   main head + the last deploy runs (GitHub, the caller's own
 *                 connected token) + which boxes run main head + (WI-G)
 *                 deployInterrupts24h: chat runs cut by deploy teardowns
 *   view=metrics  one loop_metrics kind over a window: per-bucket counts and
 *                 the latest rows (meta truncated) — "did the signal move?"
 *   view=kinds    every kind seen in the window with counts — the vocabulary
 *   view=cards    the confirmation cards staged for the CALLER in the window
 *                 (tool, staging chat, status, summary) — the owner-click cost
 *                 alert's evidence; the supervisor's first ticket (1566af57)
 *                 had to say "the toolset cannot read them directly"
 *   view=fleetEvents  the DURABLE fleet-event KPI rollup (feedback 4e36ee4a):
 *                 emitted/delivered counters per UTC day × eventType, written
 *                 at emission time independent of subscriber count and never
 *                 GC'd (the hook_events outbox and loop_metrics die at 30
 *                 days — this ledger does not)
 *
 * ADMIN-ONLY at execution (platform-tools.ts) for the platform-wide views:
 * loop metrics and box health are platform-wide facts, not the caller's own
 * data; a non-admin run is refused with the same "restricted to admin users"
 * phrasing run-receipts.ts treats as NOT-EXECUTED (a refusal is never
 * evidence). EXCEPTION (feedback b426a848, 2026-09-19): supervisor-class
 * seats (fleet OR project supervisor) may read views 'collab' + 'cards'
 * without admin — both are already scoped to the caller's userId below
 * (own-account rows only), which is exactly the COLLABORATION WATCH duty's
 * sweep read.
 *
 * Deterministic assembly, injected fetchers — the GitHub calls and the token
 * lookup are seams so the shape is testable without network.
 */
import prisma from '../../../config/database';
import { LOOP_METRIC_KINDS, queryLoopMetrics, queryLoopMetricOutcomes, queryLoopMetricPayloadSizes, queryLoopMetricLegs, summarizeLoopMetrics } from '../platform/loop-metrics.service';
import { fleetEventKpis } from '../platform/fleet-event-rollup.service';
import { latestBoxHealthRows, latestBoxHealthRowsWithHistory, type BoxShaTransition, type BoxShaState, BOX_SHA_FLAP_WINDOW_MS, fetchDeployRunsWithStatus, fetchMainHead, fetchRepoActionRuns, fetchRepoHead, fetchCompareFiles, isGithubRepoSlug, DEPLOY_REPO, BOX_HEALTH_STALE_MS, type BoxHealthRow, type BackupState, backupProducerHosts, BACKUP_STALE_H, deployWatchBlindReason, infraWatchBlindAlarmDisabled, readDeployWatchBlindState, type DeployWatchBlindState, type WorkflowRunsFetch, servingBuild, type ServingBuild } from './infra-watch.service';
import { workedAlone } from '../coding/tool-profile';
import type { DeployHealth } from './deploy-health';

export const TELEMETRY_VIEWS = ['boxes', 'deploy', 'metrics', 'kinds', 'cards', 'collab', 'fleetEvents', 'errors', 'jobHealth', 'costs', 'overview', 'pulse', 'log', 'digests'] as const;
/** Views scoped to the caller's OWN account inside the assembly — a supervisor seat reads them without admin (T4b added the four dashboard reads). */
export const OWN_ACCOUNT_VIEWS: ReadonlySet<string> = new Set(['collab', 'cards', 'overview', 'pulse', 'log', 'digests']);
/** view 'collab': a lane needs this many runs in the window before it can read as 'alone'. */
export const COLLAB_MIN_RUNS = 4;
export const COLLAB_SCAN_ROWS = 5_000;
export type TelemetryView = (typeof TELEMETRY_VIEWS)[number];

export const TELEMETRY_DEFAULT_HOURS = 24;
export const TELEMETRY_MAX_HOURS = 24 * 7;
export const TELEMETRY_DEFAULT_LIMIT = 20;
export const TELEMETRY_MAX_LIMIT = 50;
/** Per-bucket series are capped from the END (the freshest buckets win). */
export const TELEMETRY_MAX_BUCKETS = 48;
export const TELEMETRY_META_CHARS = 240;
export const DEPLOY_RUNS_PER_PAGE = 6;
/** view 'boxes' decisionGate tile (ticket e7b9521b): an episode with no latched/relatched row newer than this reads
 *  stale (inactive) instead of active — only the process that latched a backend can write its 'recovered' row
 *  (platform/decision-gate.ts noteBackendAuthRecovered early-returns on `if (!latch)`), so when that process dies
 *  latched (a worker container replaced mid-outage, e.g. a DRAINING worker serving its last runs on a revoked key)
 *  NO recovered row is ever written and the tile would otherwise stay active until the row window slides past the
 *  episode. A genuinely-continuing outage cannot cross this horizon silently: while the latch holds, every ask
 *  skips the leg and, once the cooldown (DECISION_GATE_AUTH_LATCH_MS, default 90 s, clamped 10 s..10 min) elapses,
 *  ONE ask probes — a probe that fails 401/403 again writes a fresh 'relatched' row (a live outage writes a row at
 *  least every ~10 min, and a still-active worker keeps relatching); a probe that fails for a NON-auth reason
 *  (timeout, 5xx) RELEASES the latch with no row (releaseBackendAuthProbe) — the gate goes fail-open, the episode
 *  is genuinely over, and reading it stale later is correct. 2 h = 12× the max cooldown with zero decision traffic
 *  (a probe needs an ask), which trades a bounded worst-case false-inactive against the 24 h stuck-active it fixes. */
export const DECISION_DOWN_STALE_MS = 2 * 60 * 60 * 1000;

export interface TelemetryArgs {
  view: TelemetryView;
  kind?: string;
  hours: number;
  bucket: 'hour' | 'day';
  limit: number;
  chatId?: string;
  /** view 'errors' (T3a): level + message-substring filters. */
  level?: 'error' | 'warn';
  search?: string;
  /**
   * view 'metrics' only (ticket ecfc9bf8): the `limit` the CALLER asked for,
   * BEFORE the TELEMETRY_MAX_LIMIT clamp. Kept so the answer can say "you asked
   * for 200, the ceiling is 50" instead of silently returning 50 — an operator
   * who cannot see the clamp reads a capped sample as the window's row count.
   */
  limitRequested?: number;
  /** view 'deploy' only (ticket 51ff7e93): scope the read to ANY repo the
   * caller's connected GitHub account can read ('owner/name'); default = the
   * framework repo (DEPLOY_REPO) with the box/onMainHead picture. */
  repo?: string;
  /** view 'deploy' only: which branch head to read for a repo-scoped read (default 'main'). */
  ref?: string;
}

/** Pure arg validation — a string error for the model, never a throw. */
export function clampTelemetryArgs(raw: any): TelemetryArgs | { error: string } {
  const view = String(raw?.view ?? '').trim() as TelemetryView;
  if (!TELEMETRY_VIEWS.includes(view)) {
    return { error: `get_fleet_telemetry requires view = ${TELEMETRY_VIEWS.map((v) => `'${v}'`).join(' | ')}.` };
  }
  const hoursN = Math.floor(Number(raw?.hours));
  const hours = Number.isFinite(hoursN) && hoursN >= 1 ? Math.min(hoursN, TELEMETRY_MAX_HOURS) : TELEMETRY_DEFAULT_HOURS;
  const limitN = Math.floor(Number(raw?.limit));
  const limit = Number.isFinite(limitN) && limitN >= 1 ? Math.min(limitN, TELEMETRY_MAX_LIMIT) : TELEMETRY_DEFAULT_LIMIT;
  // Ticket ecfc9bf8: remember what was ASKED so the metrics answer can disclose a
  // clamp rather than quietly returning fewer rows than requested.
  const limitRequested = Number.isFinite(limitN) && limitN >= 1 ? limitN : TELEMETRY_DEFAULT_LIMIT;
  const bucket: 'hour' | 'day' = raw?.bucket === 'day' ? 'day' : 'hour';
  const kind = typeof raw?.kind === 'string' && raw.kind.trim() ? raw.kind.trim().slice(0, 64) : undefined;
  if (view === 'metrics' && !kind) {
    return { error: "get_fleet_telemetry requires kind for view 'metrics' (a loop_metrics kind such as 'box_health', 'infra_alert', 'confirmation_staged', 'guard_strike' — use view 'kinds' for the vocabulary seen in the window)." };
  }
  const chatId = typeof raw?.chatId === 'string' && /^[0-9a-f-]{8,36}$/i.test(raw.chatId.trim()) ? raw.chatId.trim() : undefined;
  const level: 'error' | 'warn' | undefined = raw?.level === 'error' || raw?.level === 'warn' ? raw.level : undefined;
  const search = typeof raw?.search === 'string' && raw.search.trim() ? raw.search.trim().slice(0, 120) : undefined;
  // view 'deploy' repo scoping (ticket 51ff7e93): 'owner/name' GitHub slug or
  // ref (branch) name, strictly shaped — both are interpolated into GitHub API
  // URLs, so anything that is not a plain slug/branch name is rejected rather
  // than URL-escaped into some other repo's reads.
  let repo: string | undefined;
  let ref: string | undefined;
  if (raw?.repo !== undefined && raw?.repo !== null && String(raw.repo).trim() !== '') {
    const candidate = String(raw.repo).trim();
    if (!isGithubRepoSlug(candidate)) {
      return { error: "get_fleet_telemetry view 'deploy' repo must be a GitHub slug 'owner/name' (letters, digits, '.', '_' and '-'; no traversal, no query), e.g. 'canada-quant/example-repo'." };
    }
    repo = candidate;
  }
  if (raw?.ref !== undefined && raw?.ref !== null && String(raw.ref).trim() !== '') {
    const candidateRef = String(raw.ref).trim();
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(candidateRef) || candidateRef.includes('..') || candidateRef.startsWith('/') || candidateRef.endsWith('/')) {
      return { error: "get_fleet_telemetry view 'deploy' ref must be a plain branch name (letters, digits, '.', '_', '-', '/'), e.g. 'main' or 'release/1.x'." };
    }
    if (!repo) {
      return { error: "get_fleet_telemetry view 'deploy' ref requires repo — ref narrows a repo-scoped read; the default (framework) read is always main." };
    }
    ref = candidateRef;
  }
  if (repo && view !== 'deploy') {
    return { error: "get_fleet_telemetry repo/ref scoping is supported on view 'deploy' only — the other views read platform-wide facts, not one repo." };
  }
  return { view, kind, hours, bucket, limit, limitRequested, chatId, repo, ref , level, search };
}

export interface TelemetryDeps {
  userId: string;
  /** T4b: view 'pulse' shows the GitHub/queue panels only for ADMIN. */
  role?: string;
  now?: Date;
  /** Ticket 5fba7188: which build answered (default servingBuild). A seam so a
   *  test can pin the drainer stamp without a real marker file. */
  servingBuild?: () => ServingBuild;
  getGithubToken?: (userId: string) => Promise<string | null>;
  fetchRuns?: (token: string, perPage: number) => Promise<any[]>;
  /** DEPLOY-WATCH-BLIND (2026-10-20): the status-carrying deploy read (default
   *  fetchDeployRunsWithStatus) — wins over fetchRuns; a legacy fetchRuns seam reads as HTTP 200. */
  fetchRunsWithStatus?: (token: string, perPage: number) => Promise<WorkflowRunsFetch>;
  /** DEPLOY-WATCH-BLIND: the infra-watch sweep's consecutive-blind state (default readDeployWatchBlindState). */
  readDeployWatchBlind?: () => Promise<DeployWatchBlindState | null>;
  fetchHead?: (token: string) => Promise<{ sha: string; committedAt: string; title: string } | null>;
  /** repo-scoped seam (ticket 51ff7e93) — fetchRepoActionRuns by default. */
  fetchRepoRuns?: (token: string, repo: string, opts: { perPage?: number; ref?: string }) => Promise<import('./infra-watch.service').RepoRunsResult>;
  /** repo-scoped seam (ticket 51ff7e93) — fetchRepoHead by default. */
  fetchRepoHead?: (token: string, repo: string, ref: string) => Promise<{ sha: string; committedAt: string; title: string } | null>;
  /** view 'deploy' worker-lag verdicts (2026-10-07): the compare file list
   * between a lagging coding box's sha and main head — infra-watch.service
   * fetchCompareFiles by default. null (compare unavailable) degrades the
   * verdict to the honest hand-classify fallback, never a guess. */
  fetchCompare?: (token: string, base: string, head: string) => Promise<Array<{ filename: string }> | null>;
  /** views 'jobHealth' + 'deploy' (WI-M 2026-09-25): the live site probe shared
   * with the REST admin job-health endpoint — fleet/deploy-health.ts
   * probeDeployHealth by default (60 s cache; DEPLOY_HEALTH_PROBE_DISABLED=1 → 'skipped'). */
  probeDeployHealth?: (now: Date) => Promise<DeployHealth>;
}

/** The deploy-health read both views share; never throws (a probe failure reads as status 'unknown'). */
async function readDeployHealth(deps: TelemetryDeps, now: Date): Promise<DeployHealth> {
  try {
    const probe = deps.probeDeployHealth ?? (async (at: Date) => (await import('./deploy-health')).probeDeployHealth({ now: at }));
    return await probe(now);
  } catch {
    return { status: 'unknown', checkedAt: now.toISOString() };
  }
}

/**
 * Ticket 9c0caf1c — the deploy-run state a BOXES read needs, read through the
 * caller's own connected GitHub account (the same seam the deploy view uses).
 * Never throws and never guesses: no token ⇒ 'unavailable', a refused/empty
 * answer ⇒ 'blind', both with inFlight null. Anything but 'read' means the
 * consumer cannot rule out a wave, which is strictly weaker evidence than
 * "no wave in flight" — so it is never spelled the same way.
 */
async function readDeployWaveStamp(deps: TelemetryDeps, now: Date): Promise<DeployWaveStamp> {
  const getToken = deps.getGithubToken ?? (async (userId: string) => (await import('../github/token-manager')).getValidToken(userId));
  const token = await getToken(deps.userId).catch(() => null);
  if (!token) return deployWaveStamp([], 'unavailable', now);
  const runsFetch: (t: string, n: number) => Promise<WorkflowRunsFetch> = deps.fetchRunsWithStatus
    ?? (deps.fetchRuns
      ? (async (t: string, n: number) => ({ runs: await deps.fetchRuns!(t, n), status: 200 }))
      : ((t: string, n: number) => fetchDeployRunsWithStatus(t, { perPage: n })));
  const res = await runsFetch(token, DEPLOY_RUNS_PER_PAGE).catch((): WorkflowRunsFetch => ({ runs: [], status: null }));
  const runsRaw = Array.isArray(res.runs) ? res.runs : [];
  if (res.skipped || res.malformed || res.status !== 200) return deployWaveStamp([], 'blind', now);
  return deployWaveStamp(shapeDeployRuns(runsRaw), 'read', now);
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(Object.values(LOOP_METRIC_KINDS));
const short = (sha: string | undefined | null) => (sha ? String(sha).slice(0, 8) : undefined);
const ageMin = (at: Date, now: Date) => Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
const truncMeta = (meta: unknown): string => {
  try {
    const s = JSON.stringify(meta ?? null);
    return s.length > TELEMETRY_META_CHARS ? `${s.slice(0, TELEMETRY_META_CHARS)}…` : s;
  } catch { return '"[unserializable]"'; }
};

// ── boxes ─────────────────────────────────────────────────────────────────────

export function shapeBoxes(rows: BoxHealthRow[], now: Date, producerHosts: string[] = backupProducerHosts()) {
  return rows
    .slice()
    .sort((a, b) => a.host.localeCompare(b.host) || a.process.localeCompare(b.process))
    .map((r) => ({
      host: r.host,
      process: r.process,
      sha: r.sha ?? null,
      diskPct: r.diskPct,
      diskFreeGb: r.diskFreeGb,
      memFreePct: r.memFreePct,
      load1: r.load1,
      lastSeen: r.at.toISOString(),
      ageMin: ageMin(r.at, now),
      stale: now.getTime() - r.at.getTime() > BOX_HEALTH_STALE_MS,
      // nightly dump as seen through the /backups mount (box A owns the dumps;
      // other boxes see an empty dir; older containers report nothing)
      backup: r.backup ?? null,
      // Ticket 533087b7: WHOSE dump a row is. `backup` alone is unfalsifiable —
      // a non-producer box's by-design leftover dumps (box-b: timer
      // disabled-by-design, docs/BACKUPS.md) render byte-identically to a
      // producer whose nightly silently died 43 days ago, and a supervisor read
      // exactly that as an unrecoverable production gap. The role travels with
      // the numbers so no consumer has to know the role wiring to read it.
      ...backupRoleOf(r.backup, r.host, producerHosts),
    }));
}

/**
 * The backup ROLE of ONE box surface (ticket 533087b7).
 *  - 'producer'     — this host owns digby-backup.timer; its dump age is the
 *                     fleet's real backup age and a stale/absent/failed reading
 *                     is an ALERTABLE gap.
 *  - 'non-producer' — the row can see a /backups dir but does not run the timer.
 *                     Any dumps there are leftovers that never refresh BY
 *                     DESIGN; the age is reported (it is a true fact) but it is
 *                     NEVER a gap. box-b has read 1,031 h stale since a
 *                     2026-09-18 ad-hoc dump while nothing was wrong.
 *  - 'unmounted'    — no dump reading at all, because /opt/crossmodel-backups is
 *                     mounted only on the backend (web) service in
 *                     docker-compose.app.yml. Every worker row is this, always,
 *                     by design — NOT a second silent gap.
 */
export interface BackupRoleAnnotation {
  backupRole: 'producer' | 'non-producer' | 'unmounted';
  /** true ONLY for a producer whose reading is a real alertable shortfall. */
  backupGap: boolean;
}

/**
 * A `failed` marker SUPERSEDED by a newer dump is not a failure (reviewer
 * finding 1, ticket 533087b7). `digby-backup.sh` writes backup-status.json
 * best-effort — a failed write is itself only a log warning — so a run can
 * leave a stale `failed` marker behind while a LATER run's dump lands
 * successfully. A newer DUMP outranks an older marker.
 *
 * This MUST match the alert path (`infra-watch.service.ts` classifyBackupAge
 * filters the same condition) and `scripts/framework-audit/audit-live-state.js`
 * (`!superseded`): without it this read publishes "BACKUP FAILED" and
 * backupGap:true on a box that is fine WHILE no alert fires — the exact
 * misleading-published-read class this ticket exists to kill, just inverted.
 */
export function failedMarkerSuperseded(backup: BackupState): boolean {
  return Boolean(backup.newestAt && backup.statusAt && Date.parse(backup.newestAt) > Date.parse(backup.statusAt));
}

export function backupRoleOf(backup: BackupState | undefined | null, host: string, producerHosts: string[] = backupProducerHosts()): BackupRoleAnnotation {
  if (!backup) return { backupRole: 'unmounted', backupGap: false };
  const producer = producerHosts.includes(host);
  if (!producer) return { backupRole: 'non-producer', backupGap: false };
  const failed = backup.status === 'failed' && !failedMarkerSuperseded(backup);
  const gap = failed || (backup.count ?? 0) === 0 || (backup.ageH ?? Infinity) > BACKUP_STALE_H;
  return { backupRole: 'producer', backupGap: gap };
}

/** One shaped box row, as `shapeBoxes` emits it. */
export type ShapedBox = ReturnType<typeof shapeBoxes>[number];

export interface FleetBackupView {
  /** Hosts whose dump reading is the fleet's backup age (BACKUP_PRODUCER_HOSTS, default box-a). */
  producers: string[];
  /** Newest dump age across the PRODUCER surfaces only — the number that means something. */
  ageH: number | null;
  newestAt: string | null;
  status: 'ok' | 'failed' | 'stale' | 'missing' | 'unknown_age' | 'producer_unmounted' | 'unreported';
  /** Non-producer surfaces carrying by-design leftover dumps — never a gap. */
  leftovers: Array<{ host: string; process: string; ageH: number | null; newestAt: string | null }>;
  /** Surfaces with no dump reading at all, with the reason (by design for workers). */
  unmounted: Array<{ host: string; process: string; reason: string }>;
  /** One sentence a supervisor can quote instead of re-deriving the role wiring. */
  reading: string;
}

/**
 * Fleet-level backup picture over the SAME shaped rows (pure). This is the
 * complement of `classifyBackupAge` (which decides ALERTS): this one decides
 * what the numbers MEAN, so a reader is never left to infer it. Ticket
 * 533087b7 — the published view exposed `backup.ageH` with no role attached and
 * a supervisor filed a priority-3 "43-day unrecoverable production gap" off a
 * box that has no timer by design.
 */
export function readBackupPicture(boxes: ShapedBox[], now: Date, producerHosts: string[] = backupProducerHosts()): FleetBackupView {
  const producers = boxes.filter((b) => backupRoleOf(b.backup, b.host, producerHosts).backupRole === 'producer');
  const leftovers = boxes
    .filter((b) => backupRoleOf(b.backup, b.host, producerHosts).backupRole === 'non-producer' && b.backup)
    .map((b) => ({ host: b.host, process: b.process, ageH: b.backup!.ageH ?? null, newestAt: b.backup!.newestAt ?? null }));
  const unmounted = boxes
    .filter((b) => !b.backup)
    .map((b) => ({
      host: b.host,
      process: b.process,
      reason:
        b.process === 'worker'
          ? 'the /opt/crossmodel-backups mount is declared on the backend (web) service only in docker-compose.app.yml, so worker rows never report a dump — by design, not a gap'
          : 'this container has no readable /backups mount (a pre-4f6cb3610 image, or a box recreated without the mount)',
    }));
  const withDumps = producers.filter((b) => (b.backup!.count ?? 0) > 0 && b.backup!.ageH != null);
  const freshest = withDumps.sort((a, b) => (a.backup!.ageH ?? 0) - (b.backup!.ageH ?? 0))[0];
  // Same supersede rule as the alert path — a stale 'failed' marker outranked by
  // a newer dump is NOT a failure (reviewer finding 1).
  const failed = producers.find((b) => b.backup!.status === 'failed' && !failedMarkerSuperseded(b.backup!));
  // A producer HOST that heartbeats but reports no dump at all is a KNOWN defect
  // class (a pre-4f6cb3610 image, or a box recreated without the mount) — it must
  // not collapse into 'unreported' (reviewer finding 3): we can tell them apart,
  // because the heartbeat row exists.
  const producerHostsReporting = boxes.filter((b) => producerHosts.includes(b.host));
  const producerUnmounted = producerHostsReporting.length > 0 && producerHostsReporting.every((b) => !b.backup);
  // Dumps exist but cannot be aged — NOT "produced nothing" (reviewer finding 2).
  const unageable = producers.filter((b) => (b.backup!.count ?? 0) > 0 && b.backup!.ageH == null);
  let status: FleetBackupView['status'];
  if (failed) status = 'failed';
  else if (producerUnmounted) status = 'producer_unmounted';
  else if (!producers.length) status = 'unreported';
  else if (unageable.length && !freshest) status = 'unknown_age';
  else if (!freshest) status = 'missing';
  else status = (freshest.backup!.ageH ?? 0) > BACKUP_STALE_H ? 'stale' : 'ok';
  const view: Omit<FleetBackupView, 'reading'> = {
    producers: producerHosts,
    ageH: freshest ? freshest.backup!.ageH ?? null : null,
    newestAt: freshest ? freshest.backup!.newestAt ?? null : null,
    status,
    leftovers,
    unmounted,
  };
  return { ...view, reading: readBackupSentence(view, now) };
}

/** The citable sentence for a FleetBackupView (pure; split out so tests pin the wording). */
export function readBackupSentence(v: Omit<FleetBackupView, 'reading'>, now: Date): string {
  const parts: string[] = [];
  const producerNames = v.producers.join(', ') || 'box-a';
  if (v.status === 'unreported') {
    parts.push(`No ${producerNames} surface reported a dump reading in this window — the backup picture is UNKNOWN, not "missing" (a reporting lapse and a dead timer look the same from here).`);
  } else if (v.status === 'producer_unmounted') {
    parts.push(`BACKUP UNREADABLE on the producer (${producerNames}): its heartbeat is fresh but it reports NO dump reading at all — the read-only /backups mount is missing or unreadable in its container (the pre-4f6cb3610 class). Backup alerting is blind while this lasts, so this is a real defect to fix, not a gap in the dumps.`);
  } else if (v.status === 'ok') {
    parts.push(`Backup is healthy: the newest dump on the producer (${producerNames}) is ${v.ageH}h old (${v.newestAt}), inside the ${BACKUP_STALE_H}h nightly bar.`);
  } else if (v.status === 'failed') {
    parts.push(`BACKUP FAILED: the producer (${producerNames}) reports status "failed" for its latest attempt — see backup-status.json / the infra-watch alert; a dump older than this run is the recovery point.`);
  } else if (v.status === 'unknown_age') {
    parts.push(`BACKUP AGE UNKNOWN on the producer (${producerNames}): dumps are present but none can be aged (an unreadable stat) — this is NOT "no dump was produced", so check the mount before treating it as a gap.`);
  } else if (v.status === 'missing') {
    parts.push(`BACKUP MISSING: the producer (${producerNames}) sees a /backups mount with no dump in it — the nightly has produced nothing this window.`);
  } else {
    parts.push(`BACKUP STALE: the newest dump on the producer (${producerNames}) is ${v.ageH}h old (${v.newestAt}), past the ${BACKUP_STALE_H}h nightly bar.`);
  }
  if (v.leftovers.length) {
    parts.push(
      `Non-producer boxes carry OLD dumps that are BY-DESIGN leftovers, never a gap: ${v.leftovers
        .map((l) => `${l.host}/${l.process} newest ${l.ageH}h (${l.newestAt})`)
        .join(', ')} — those hosts do not run digby-backup.timer (role wiring lives on ${producerNames}); their age is a true fact and not a fault, so do not open a ticket on it.`,
    );
  }
  if (v.unmounted.length) {
    // Separate the two very different reasons a surface reports nothing: a
    // WORKER row never has the mount (by design — the compose file declares it
    // on the backend service only), while a WEB row with no mount is the real
    // defect class (a pre-4f6cb3610 image, or a box recreated without it).
    const workerUnmounted = v.unmounted.filter((u) => u.process === 'worker');
    const webUnmounted = v.unmounted.filter((u) => u.process !== 'worker');
    if (workerUnmounted.length) {
      parts.push(`${workerUnmounted.length} row(s) with backup:null are WORKER processes (${workerUnmounted.map((u) => `${u.host}/worker`).join(', ')}) — by design: the dump mount is declared on the web service only in docker-compose.app.yml, so workers never report a dump and their null is not a gap.`);
    }
    if (webUnmounted.length) {
      parts.push(`${webUnmounted.map((u) => `${u.host}/web`).join(', ')} report NO dump reading — ${webUnmounted[0].reason}.`);
    }
  }
  parts.push(`(read at ${now.toISOString()})`);
  return parts.join(' ');
}

// ── sha evidence quality (ticket 9c0caf1c) ───────────────────────────────────
// A single `boxes` read used to hand back one bare sha per surface, and nothing
// in the payload could distinguish "box A landed this sha" from "box A was
// caught mid-flip during a coalesced wave". Two supervisors published (then
// retracted) a "box-a flipped to <sha>" claim off exactly that ambiguity, on
// 2026-10-30 — the evidence the verify-before-done rule rests on was
// unfalsifiable by construction. The three pure helpers below make the read
// self-describing: each surface says how long its sha has been continuously
// reported, whether it changed inside the flap window, and the view names the
// deploy run it is consistent with (including an in-flight wave).

/** The deploy-run stamp a telemetry read carries so a consumer can tell a settled read from a mid-wave one. */
export interface DeployWaveStamp {
  /** 'read' = deploy runs were actually read; 'blind' = the read was refused / got no answer; 'unavailable' = no GitHub account, so NO run state was read. */
  read: 'read' | 'blind' | 'unavailable';
  /** true while a deploy run has not completed. null when the run state could not be read — NEVER false, because "unread" is not "no wave". */
  inFlight: boolean | null;
  /** The runs that are still executing — the coalescing wave, each named so a consumer can cite it. */
  runs: Array<{ id: number; sha: string; status: string; ageMin: number | null }>;
  /** The newest run of ANY status — what this read is consistent with. */
  newest: { id: number; sha: string; status: string; conclusion: string | null } | null;
  /** The completed run whose sha each box is expected to reach (the newest completed run), or null. */
  lastCompleted: { id: number; sha: string; conclusion: string | null } | null;
}

/** Build the deploy-wave stamp from shaped runs (pure). */
export function deployWaveStamp(
  runs: DeployRunView[],
  read: DeployWaveStamp['read'],
  now: Date,
): DeployWaveStamp {
  if (read !== 'read') return { read, inFlight: null, runs: [], newest: null, lastCompleted: null };
  const running = runs.filter((r) => r.status !== 'completed');
  const newest = runs[0];
  const lastCompleted = runs.find((r) => r.status === 'completed');
  return {
    read,
    inFlight: running.length > 0,
    runs: running.map((r) => ({
      id: r.id,
      sha: r.sha,
      status: r.status,
      ageMin: r.createdAt && Number.isFinite(Date.parse(r.createdAt)) ? ageMin(new Date(r.createdAt), now) : null,
    })),
    newest: newest ? { id: newest.id, sha: newest.sha, status: newest.status, conclusion: newest.conclusion } : null,
    lastCompleted: lastCompleted ? { id: lastCompleted.id, sha: lastCompleted.sha, conclusion: lastCompleted.conclusion } : null,
  };
}

/** The per-surface sha annotation the boxes view stamps from the sha history. */
export interface BoxShaAnnotation {
  /** 8-char sha the surface's newest row reported. */
  sha: string | null;
  /** 'settled' | 'flapping' | 'unconfirmed' | 'unknown' — ONLY 'settled' may be cited as settled serving state. */
  shaState: BoxShaState;
  /** ISO instant the current sha was FIRST reported (the earliest row in its contiguous run). */
  shaSince: string | null;
  /** Minutes since shaSince. */
  shaAgeMin: number | null;
  /** Contiguous rows carrying the current sha — 2+ means a second reading corroborates it. */
  shaRows: number;
  /** The sha reported immediately before the current one, and when it was last seen — the change window. */
  previousSha: string | null;
  previousShaAt: string | null;
  /** Distinct sha runs whose newest row landed inside the flap window (1 = no change inside it). */
  shaChanges: number;
  /** true ONLY when shaState === 'settled' AND no deploy wave is in flight — the only citable value. */
  settled: boolean;
}

/**
 * Annotate the shaped boxes with their sha history + the wave stamp (pure).
 * A 'settled' sha is downgraded to 'flapping' whenever a deploy wave is in
 * flight: during a coalescing wave the box's OWN history can look stable for a
 * few minutes while the fleet is still moving, and a consumer must not read
 * that as the box's final state.
 */
export function annotateBoxSha(
  boxes: ReturnType<typeof shapeBoxes>,
  shaHistory: Map<string, BoxShaTransition>,
  wave: DeployWaveStamp,
): Array<ReturnType<typeof shapeBoxes>[number] & BoxShaAnnotation> {
  return boxes.map((b) => {
    const h = shaHistory.get(`${b.host}/${b.process}`);
    const base: BoxShaAnnotation = {
      sha: b.sha,
      shaState: h?.state ?? (b.sha ? 'unconfirmed' : 'unknown'),
      shaSince: h?.shaSince ?? null,
      shaAgeMin: h?.shaAgeMin ?? null,
      shaRows: h?.shaRows ?? (b.sha ? 1 : 0),
      previousSha: h?.previousSha ?? null,
      previousShaAt: h?.previousShaAt ?? null,
      shaChanges: h?.shaChanges ?? (b.sha ? 1 : 0),
      settled: false,
    };
    if (wave.inFlight === true && base.shaState === 'settled') base.shaState = 'flapping';
    base.settled = base.shaState === 'settled' && wave.inFlight === false;
    return { ...b, ...base };
  });
}

/** The view-level verdict on whether this read can be cited as settled serving state. */
export interface ShaEvidence {
  /** true ONLY when every reporting surface is settled AND a wave was actually read as not in flight. */
  settled: boolean;
  code: 'settled' | 'wave_in_flight' | 'flapping' | 'unconfirmed' | 'stale' | 'wave_unread' | 'unknown';
  /** One sentence naming what this read proves and what it does not. */
  reason: string;
}

/** Roll the annotated boxes + the wave stamp into ONE citation-ready verdict (pure). */
export function shaEvidence(
  boxes: Array<{ host: string; process: string } & BoxShaAnnotation>,
  wave: DeployWaveStamp,
): ShaEvidence {
  const reporting = boxes.filter((b) => b.sha);
  const flapping = reporting.filter((b) => b.shaState === 'flapping');
  const unconfirmed = reporting.filter((b) => b.shaState === 'unconfirmed');
  const names = (list: Array<{ host: string; process: string }>) => list.map((b) => `${b.host}/${b.process}`).join(', ');
  const waveRun = wave.runs[0];
  const waveLine = wave.inFlight
    ? `deploy run ${waveRun.id} (${waveRun.sha} ${waveRun.status}) is in flight${wave.runs.length > 1 ? ` with ${wave.runs.length - 1} newer wave(s) coalescing` : ''} — the fleet is still moving, so no sha below is a settled state; re-read after that run concludes`
    : '';
  if (wave.inFlight === true) {
    return { settled: false, code: 'wave_in_flight', reason: `${waveLine}.` };
  }
  if (flapping.length) {
    return { settled: false, code: 'flapping', reason: `${names(flapping)} reported a sha that began inside the ${Math.round(BOX_SHA_FLAP_WINDOW_MS / 60000)} min flap window — this read may be catching the box mid-flip; re-read in a few minutes before citing it.` };
  }
  if (unconfirmed.length) {
    return { settled: false, code: 'unconfirmed', reason: `${names(unconfirmed)} report a sha backed by a SINGLE box_health row — no second reading corroborates it yet; re-read after the next heartbeat (box_health lands every 15 min) instead of citing one row.` };
  }
  const staleList = reporting.filter((b) => b.shaState === 'stale');
  if (staleList.length) {
    return { settled: false, code: 'stale', reason: `${names(staleList)} last reported a box_health row over ${Math.round(BOX_HEALTH_STALE_MS / 60000)} min ago — the sha says what the box RAN, not what it serves now; re-read when its heartbeat returns before citing it.` };
  }
  if (wave.read !== 'read') {
    return { settled: false, code: 'wave_unread', reason: `the sha on every reporting box has been continuous for over ${Math.round(BOX_SHA_FLAP_WINDOW_MS / 60000)} min, but the deploy-run state could not be read (${wave.read === 'unavailable' ? 'no connected GitHub account for this user' : 'the deploy-runs read was refused or got no answer'}) — a wave the boxes have not caught up with cannot be ruled out, so cite the sha as "continuously reported since <shaSince>", not as settled serving state.` };
  }
  const oldest = reporting.length ? reporting.reduce((a, b) => ((a.shaAgeMin ?? 0) >= (b.shaAgeMin ?? 0) ? a : b)) : null;
  if (!reporting.length) {
    return { settled: false, code: 'unknown', reason: 'no reporting surface carries a deploy sha (processes older than the DEPLOY_SHA passthrough report after their next rebuild) — nothing here is evidence of what production serves.' };
  }
  return {
    settled: true,
    code: 'settled',
    reason: `every reporting box's sha has been continuous for over ${Math.round(BOX_SHA_FLAP_WINDOW_MS / 60000)} min with ${oldest?.shaRows ?? 1}+ corroborating readings (newest change ${oldest?.shaSince ?? 'unknown'}) and no deploy run is in flight${wave.lastCompleted ? ` (last completed run ${wave.lastCompleted.id})` : ''} — citable as settled serving state.`,
  };
}

// ── decision backends (audit budgets-cost-6, 2026-09-26) ──────────────────────
// The 'boxes' view's decisionGate tile: every backend the gate latched in the
// window (decision_gate_backend_down rows written by platform/decision-gate.ts),
// whether it recovered, and the all-legs-failed count — the read an [INFRA
// ALERT — decision backend down] wake's playbook and verify step cite.

export interface DecisionBackendDownView {
  spec: string | null;
  backend: string | null;
  status: number | null;
  /** ISO time of the first latch of the episode (the row's meta.since when present). */
  since: string;
  /** ISO time of the newest latched / relatched row. */
  lastAt: string;
  relatches: number;
  /** ISO time of the 'recovered' row that closed the episode, or null while it is still latched. */
  recoveredAt: string | null;
  /** true while the episode is live: a latched/relatched row inside DECISION_DOWN_STALE_MS and no later 'recovered' row. */
  active: boolean;
  /** true when the episode reads inactive ONLY because its newest row aged past DECISION_DOWN_STALE_MS with no
   *  'recovered' row — the latch-holder died latched (ticket e7b9521b: only the process that latched can write
   *  'recovered'), so recovery was never recorded. Never true together with active. */
  stale: boolean;
  /** How long the episode lasted (or has lasted so far) in seconds. */
  downSec: number;
}

export function shapeDecisionBackendDown(rows: Array<{ meta: any; createdAt: Date | string }>, now: Date): { backends: DecisionBackendDownView[]; active: string[]; allLegsFailed: number; note?: string } {
  const byKey = new Map<string, { spec: string | null; backend: string | null; status: number | null; since: number; lastAt: number; relatches: number; recoveredAt: number | null }>();
  let allLegsFailed = 0;
  for (const r of rows) {
    const m = r?.meta;
    if (!m || typeof m !== 'object' || typeof m.event !== 'string') continue;
    const at = r.createdAt instanceof Date ? r.createdAt.getTime() : Date.parse(String(r.createdAt));
    if (!Number.isFinite(at)) continue;
    if (m.event === 'all_legs_failed') { allLegsFailed += 1; continue; }
    if (m.event !== 'latched' && m.event !== 'relatched' && m.event !== 'recovered') continue;
    const spec = typeof m.spec === 'string' ? m.spec : null;
    const backend = typeof m.backend === 'string' ? m.backend : null;
    const status = typeof m.status === 'number' ? m.status : null;
    const key = `${spec ?? backend ?? 'unknown'}::${status ?? 'auth'}`;
    const sinceMs = typeof m.since === 'string' && Number.isFinite(Date.parse(m.since)) ? Date.parse(m.since) : at;
    const cur = byKey.get(key) ?? { spec, backend, status, since: sinceMs, lastAt: 0, relatches: 0, recoveredAt: null };
    cur.since = Math.min(cur.since, sinceMs);
    if (m.event === 'recovered') cur.recoveredAt = Math.max(cur.recoveredAt ?? 0, at);
    else {
      cur.lastAt = Math.max(cur.lastAt, at);
      cur.relatches = Math.max(cur.relatches, typeof m.relatches === 'number' ? m.relatches : 0);
    }
    byKey.set(key, cur);
  }
  const backends: DecisionBackendDownView[] = [...byKey.values()]
    .map((e) => {
      const open = e.lastAt > 0 && (e.recoveredAt === null || e.recoveredAt < e.lastAt);
      // Ticket e7b9521b: an open episode with NO row newer than DECISION_DOWN_STALE_MS reads stale (inactive) —
      // only the process that latched a backend can write its 'recovered' row (noteBackendAuthRecovered early-returns
      // when the running process holds no latch), so a latch-holder that dies latched leaves the episode open in the
      // rows forever. A live outage keeps writing rows (each elapsed cooldown that sees an ask writes a fresh
      // latched/relatched row), so staleness here means the recorder is gone, not that the backend is still down.
      const stale = open && now.getTime() - e.lastAt > DECISION_DOWN_STALE_MS;
      const active = open && !stale;
      const end = active ? now.getTime() : (e.recoveredAt ?? e.lastAt);
      return {
        spec: e.spec, backend: e.backend, status: e.status,
        since: new Date(e.since).toISOString(), lastAt: new Date(e.lastAt || e.since).toISOString(), relatches: e.relatches,
        recoveredAt: e.recoveredAt !== null ? new Date(e.recoveredAt).toISOString() : null,
        active, stale, downSec: Math.max(0, Math.round((end - e.since) / 1000)),
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.lastAt.localeCompare(a.lastAt));
  const active = backends.filter((b) => b.active).map((b) => b.spec ?? b.backend ?? 'unknown');
  const staleBackends = backends.filter((b) => b.stale);
  return {
    backends, active, allLegsFailed,
    ...(staleBackends.length ? { note: `${staleBackends.map((b) => b.spec ?? b.backend ?? 'unknown').join(', ')}: newest latch row is older than ${Math.round(DECISION_DOWN_STALE_MS / 60000)} min with no 'recovered' row — the process that latched it likely died latched (ticket e7b9521b); the episode reads stale, not active. Verify with the Model roles Test button if this backend matters.` } : backends.length || allLegsFailed ? {} : { note: 'no decision backend was latched (401/403) and no ask lost every leg in the window' }),
  };
}

// ── deploy ────────────────────────────────────────────────────────────────────

export interface DeployRunView { id: number; sha: string; status: string; conclusion: string | null; title: string; createdAt: string; updatedAt: string; url: string; /** workflow file basename — repo-scoped reads (51ff7e93) name which workflow ran */ workflow?: string }

export function shapeDeployRuns(runs: any[]): DeployRunView[] {
  return (runs || []).slice(0, DEPLOY_RUNS_PER_PAGE).map((r) => ({
    id: Number(r?.id),
    sha: short(r?.head_sha) ?? '',
    status: String(r?.status ?? ''),
    conclusion: r?.conclusion ? String(r.conclusion) : null,
    title: String(r?.display_title ?? r?.head_commit?.message ?? '').split('\n')[0].slice(0, 90),
    createdAt: String(r?.created_at ?? ''),
    updatedAt: String(r?.updated_at ?? ''),
    url: String(r?.html_url ?? ''),
  }));
}

/** A short workflow label for a raw Actions run — "deploy.yml" style path, falling back to the workflow name. */
export function workflowName(run: any): string {
  const path = String(run?.path ?? '').split('/').pop() ?? '';
  if (path) return path;
  return String(run?.name ?? '').slice(0, 40) || 'unknown';
}

/**
 * Repo-scoped deploy reading (ticket 51ff7e93) — same doctrine as
 * readDeployPicture (in-flight ⇒ NOT live yet; cancelled = coalesced wave),
 * minus the framework-only box picture. Pure; pinned by tests.
 */
export function readRepoDeployPicture(
  repo: string,
  ref: string,
  mainHead: { sha: string } | null,
  runs: DeployRunView[],
  buildReading?: string | null,
): string {
  const parts: string[] = [];
  const head = mainHead ? short(mainHead.sha)! : null;
  if (head) parts.push(`${repo} ${ref} head is ${head}.`);
  else parts.push(`${repo} ${ref} head unavailable (deleted branch, or the connected account cannot read it).`);
  const inFlight = runs.filter((r) => r.status !== 'completed');
  if (inFlight.length) parts.push(`${inFlight.length} Actions run(s) in flight (${inFlight.map((r) => `${r.sha} ${r.workflow} ${r.status}`).join(', ')}) — a commit in one of them is NOT live yet; verify after the run concludes.`);
  const lastDone = runs.find((r) => r.status === 'completed');
  if (lastDone) parts.push(`Last completed Actions run: ${lastDone.sha} (${lastDone.workflow}) → ${lastDone.conclusion ?? 'unknown'}${lastDone.conclusion === 'cancelled' ? ' (cancelled runs are normally a coalesced wave — the newer sha carries the commit)' : ''}.`);
  const lastSuccess = runs.find((r) => r.conclusion === 'success');
  if (head && !lastSuccess && !inFlight.length) parts.push(`No successful Actions run at all for ${repo} (last completed: ${lastDone ? `${lastDone.sha} → ${lastDone.conclusion ?? 'unknown'}` : 'none'}) — ${ref} head ${head} is NOT verified as deployed${lastDone && lastDone.sha === head ? ` (the run for it concluded ${lastDone.conclusion})` : ''}.`);
  if (lastSuccess && head && lastSuccess.sha !== head && !inFlight.length) parts.push(`No successful Actions run for ${ref} head ${head} yet (last success ${lastSuccess.sha}): the head is NOT what the last successful run built — either no run has fired for it yet, or the deploy workflow failed.`);
  if (!runs.length) parts.push('No Actions runs found for this repo (and branch, when narrowed) — an empty result here is real: verify the repo has Actions workflows at all before reading it as "deployed".');
  // N4 (review of #2208): this path answers the deploy question a PROJECT lane
  // asks, so it needs the answering-build sentence too — a stale DIGBY build
  // producing the answer is exactly as misleading here.
  if (buildReading) parts.push(buildReading);
  return parts.join(' ');
}

/**
 * Deterministic one-paragraph reading of the deploy picture — the sentence the
 * operator used to write by hand. Pure; pinned by tests.
 */
export interface WorkerLagVerdict {
  /** 'expected' = nothing the worker image/runtime depends on changed in base..head — the by-design skip. */
  kind: 'expected' | 'real' | 'unknown';
  /** The changed paths the verdict was computed from (empty when unknown). */
  changed: string[];
  /**
   * One clause for the reading. 'expected': names the delta class
   * (frontend-only / docs-only / test-only / none). 'real': names the first
   * worker inputs that DID change and points at the deploy step — or, when a
   * deploy run for the current main head is still executing (the mid-wave
   * window), names that run instead of asserting a failure. 'unknown':
   * the honest hand-classify fallback.
   */
  reason: string;
}

/**
 * Read-time context the pure classifier cannot derive from a file list:
 * whether the deploy wave for the CURRENT main head is still executing.
 * 2026-10-09 (live): a firing reading the view ~9 min into a ~19-min wave saw
 * all four boxes accused of a "failed or was skipped" deploy step while run
 * 37954579315 for head 15d6d26d was simply in_progress — every on-time read
 * carried the false alarm. With headDeployInFlight the 'real' verdict reports
 * the mid-wave window and defers the failed-step accusation to after the run
 * concludes.
 */
export interface WorkerLagContext {
  headDeployInFlight?: boolean;
  /**
   * Age (ms) of the COMPLETED deploy wave for the current main head, when the
   * caller has it — the deferral arm's input (2026-10-21, FO f175, backlog
   * WL-1): inside the deploy script's rollout-window self-heal bound a lag is
   * presumptively the benign window-defer, not a failed/skipped step.
   */
  headWaveAgeMs?: number;
}

/**
 * Mirror of scripts/deploy/deploy-coding-worker.sh WORKER_ROLLOUT_MAX_STALE_SEC
 * (default 7200 — the force-roll bound on a window-deferred pending inputs
 * hash). Keep in sync with the deploy script.
 */
export const WORKER_ROLLOUT_MAX_STALE_MS = 2 * 3600 * 1000;

/**
 * Classify a coding-box worker lag against the deploy script's OWN rebuild
 * rules (scripts/deploy/deploy-coding-worker.sh, the HASH block): the worker
 * is rebuilt only when the worker image (backend/ minus tests/.md/env/dist,
 * Dockerfile, compose) or its runtime env (docker-compose.app.yml,
 * env-overrides.env, env-secrets.env) changed. Mirrored here so the deploy
 * view's verdict matches what the box actually does — NOT a git diff against
 * "backend/" wholesale, which is exactly the misdirection that made this
 * reading name a phantom deploy-step failure while the live box-c lag was a
 * hash-excluded *.test.ts pin file (found live 2026-10-07: backend delta
 * journal-recurrence.f94.pin.test.ts, worker skipped by design).
 */
export function classifyWorkerLag(files: Array<{ filename: string }> | null | undefined, ctx?: WorkerLagContext): WorkerLagVerdict {
  if (!files) return { kind: 'unknown', changed: [], reason: 'compare unavailable — classify by hand: git diff --name-only <box-sha>..main, then apply the worker-input rules from deploy-coding-worker.sh (backend/ minus *.test.ts/*.md/tests//dist//.env, plus docker-compose.app.yml)' };
  const changed = files.map((f) => f.filename);
  if (!changed.length) return { kind: 'expected', changed, reason: 'no changed files at all' };
  // Mirrors the deploy script's HASH find(1) exactly — keep in sync with
  // scripts/deploy/deploy-coding-worker.sh (the "Input hash" block).
  const isWorkerInput = (path: string): boolean => {
    if (!path.startsWith('backend/')) {
      // Only the compose file matters beyond backend/ (env overrides/secrets
      // are box-local files, never in a compare).
      return path === 'docker-compose.app.yml';
    }
    const rest = path.slice('backend/'.length);
    if (rest.startsWith('node_modules/') || rest.startsWith('dist/') || rest.startsWith('coverage/') || rest.startsWith('tests/') || rest.startsWith('.vscode/') || rest.startsWith('.idea/')) return false;
    const name = rest.split('/').pop() ?? rest;
    if (name === '.env' || name.startsWith('.env.') || name === '.gitignore') return false;
    if (name.endsWith('.test.ts') || name.endsWith('.md') || name.endsWith('.log')) return false;
    return true;
  };
  const inputs = changed.filter(isWorkerInput);
  if (!inputs.length) {
    const classes: Array<[RegExp, string]> = [
      [/^backend\//, 'a backend test-only or docs-only wave'],
      [/^(frontend|macos-app|macos-pkg|windows-agent|windows-shell)\/|\.md$|^docs?\//, 'a frontend-only or docs-only wave'],
    ];
    let waveClass = 'a wave that touched nothing the worker runs';
    for (const [re, label] of classes) if (changed.some((p) => re.test(p))) { waveClass = label; break; }
    return { kind: 'expected', changed, reason: `the un-rolled delta is ${waveClass} — the deploy script's input hash is unchanged, so the skip is by design (nothing the worker image or its runtime env depends on changed)` };
  }
  if (ctx?.headDeployInFlight) {
    return { kind: 'real', changed, reason: `worker inputs DID change (${inputs.slice(0, 4).join(', ')}${inputs.length > 4 ? ` +${inputs.length - 4} more` : ''}) — but the deploy wave for the current main head is STILL RUNNING, so this is the normal mid-wave window, not a deploy failure: re-read the view after the run concludes; only a lag that persists past a COMPLETED wave is a defect (then check the run's "Deploy coding box" step)` };
  }
  // Deferral arm (2026-10-21, FO f175, backlog WL-1 — 4th sighting): inputs
  // changed and the head wave is done, but it concluded INSIDE the script's
  // rollout-window self-heal bound — presumptively the benign window-defer
  // (rollout_window_deferred() writes a pending inputs hash and force-rolls at
  // pending_age >= 7200s; NOTHING invokes the script between waves — no cron /
  // systemd timer on the box), NOT a failed step. The step's ||-guard also
  // swallows real failures ("WARNING: coding-worker deploy failed"), so the
  // verdict names the two discriminating step-log lines and escalates only
  // past the bound. Sightings: tickets 9993f30c, d6f96c89, the 9dacab1a
  // mid-wave sibling, the 1b569f27 wave of 2026-10-21.
  if (typeof ctx?.headWaveAgeMs === 'number' && ctx.headWaveAgeMs >= 0 && ctx.headWaveAgeMs < WORKER_ROLLOUT_MAX_STALE_MS) {
    const ageMin = Math.round(ctx.headWaveAgeMs / 60000);
    return { kind: 'unknown', changed, reason: `worker inputs DID change (${inputs.slice(0, 4).join(', ')}${inputs.length > 4 ? ` +${inputs.length - 4} more` : ''}) and the head wave concluded ${ageMin} min ago — INSIDE the deploy script's rollout-window self-heal bound (2h max-stale force-roll), so this is presumptively the benign window-defer, not a failed step. The wave's "Deploy coding box (extra hosts)" step log discriminates: "worker-rollout-window: deferred" = benign (a pending inputs hash rolls on the next invocation — re-run deploy-coding-worker.sh on the box to roll it now); "WARNING: coding-worker deploy failed" = a real failure the step's ||-guard swallowed. Read as lag REAL only if the lag persists past the 2h bound` };
  }
  return { kind: 'real', changed, reason: `worker inputs DID change (${inputs.slice(0, 4).join(', ')}${inputs.length > 4 ? ` +${inputs.length - 4} more` : ''}) — no deploy run for the current main head is in flight, so the run's "Deploy coding box" step failed or was skipped: check it in the run log` };
}

/**
 * Ticket 5fba7188: the sentence that names WHICH BUILD answered the read.
 * A run still executing on a retiring worker colour answers with the OLD code,
 * so a missing field in this answer is not evidence the fix is absent. Pure.
 */
export function servingBuildLine(build: ServingBuild, mainHead: { sha: string } | null): string {
  const head = mainHead ? short(mainHead.sha) : null;
  const where = `${build.host}/${build.process}`;
  // N6 (review of #2208): "re-read before concluding" on EVERY not-evidence branch —
  // the strong claim below is the only one allowed to skip it.
  if (!build.sha) {
    return `This answer came from ${where}, which reports NO deploy sha (a build older than the DEPLOY_SHA passthrough) — it cannot say which commit it runs, so a field missing here is NOT evidence the fix is absent; re-read from a build that reports its sha before concluding.`;
  }
  if (build.draining) {
    return `This answer came from ${where}, a SUPERSEDED build (DEPLOY_SHA ${build.sha}, up ${build.upMin} min) that is DRAINING: it stopped claiming and is finishing the runs it already claimed, so its code predates the newest wave by design. A field missing here therefore proves NOTHING about main${head ? ` ${head}` : ''} — re-read from the colour that is claiming (or wait for this drain to finish) before concluding a fix is not live.`;
  }
  if (head && build.sha !== head) {
    // N2 (review of #2208): the lag REASON is tier-specific. Box C's worker skips a
    // rebuild when a wave changed no worker inputs; the web tier does not, so
    // telling a web reader about the worker's skip rule points at the wrong tier.
    const why = build.process === 'worker'
      ? 'box C\'s worker rebuilds only when a wave changed worker inputs'
      : build.process === 'web'
        ? 'the web tier is rebuilt by every wave, so this process is mid-handover or has not taken the new image yet'
        : 'this process is not on the newest wave';
    return `This answer came from ${where} on DEPLOY_SHA ${build.sha}, which is NOT main head ${head} (${why}) — a field missing here is that lag, not a failed fix; re-read before concluding.`;
  }
  // N6 (review of #2208): head equality at READ time is the premise, so the strong
  // claim is scoped to it — main landing later does not retroactively falsify it.
  return head
    ? `This answer came from ${where} on main head ${head} as read now — a field missing here IS evidence this build genuinely lacks it (a wave landing after this read is not covered).`
    : `This answer came from ${where} on DEPLOY_SHA ${build.sha}; main head was unread, so a missing field cannot be attributed either way.`;
}

export function readDeployPicture(
  mainHead: { sha: string } | null,
  runs: DeployRunView[],
  boxes: Array<{ host: string; sha: string | null; process: string }>,
  interrupts?: DeployInterrupts | null,
  lagVerdicts?: Array<{ box: string; verdict: WorkerLagVerdict }>,
  backupReading?: string | null,
  buildReading?: string | null,
): string {
  const parts: string[] = [];
  const head = mainHead ? short(mainHead.sha)! : null;
  if (head) parts.push(`main head is ${head}.`);
  const inFlight = runs.filter((r) => r.status !== 'completed');
  if (inFlight.length) parts.push(`${inFlight.length} deploy run(s) in flight (${inFlight.map((r) => `${r.sha} ${r.status}`).join(', ')}) — a fix in one of them is NOT live yet; verify after the run concludes.`);
  const lastDone = runs.find((r) => r.status === 'completed');
  if (lastDone) parts.push(`Last completed deploy run: ${lastDone.sha} → ${lastDone.conclusion ?? 'unknown'}${lastDone.conclusion === 'cancelled' ? ' (cancelled runs are normally a coalesced wave — the newer sha carries the commit)' : ''}.`);
  const lastSuccess = runs.find((r) => r.conclusion === 'success');
  if (lastSuccess && head && lastSuccess.sha !== head && !inFlight.length) parts.push(`No successful deploy run for main head ${head} yet (last success ${lastSuccess.sha}): main is NOT what production runs.`);
  if (head) {
    const on = boxes.filter((b) => b.sha === head).map((b) => `${b.host}/${b.process}`);
    const off = boxes.filter((b) => b.sha && b.sha !== head);
    const unknown = boxes.filter((b) => !b.sha);
    if (on.length) parts.push(`On main head: ${on.join(', ')}.`);
    if (off.length) {
      parts.push(`NOT on main head: ${off.map((b) => `${b.host}/${b.process} runs ${b.sha}`).join(', ')}. Box C's worker rebuilds only when a wave changed worker inputs (backend/ source — NOT its *.test.ts/*.md — the compose file, or its env).`);
      for (const { box, verdict } of lagVerdicts ?? []) {
        if (verdict.kind === 'expected') parts.push(`${box}: lag EXPECTED — ${verdict.reason}.`);
        else if (verdict.kind === 'real') parts.push(`${box}: lag REAL — ${verdict.reason}.`);
        else parts.push(`${box}: ${verdict.reason}.`);
      }
    }
    if (unknown.length) parts.push(`No sha reported by ${unknown.map((b) => `${b.host}/${b.process}`).join(', ')} (process older than the DEPLOY_SHA passthrough — it reports after its next rebuild).`);
  }
  if (interrupts && interrupts.total > 0) {
    parts.push(`${interrupts.total} chat run(s) were interrupted by deploy teardowns in the last 24 h (${interrupts.supervisorWakes} supervisor wake(s); chats ${interrupts.byChat.map((c) => `${c.chat}×${c.count}`).join(', ')}) — each one re-fires on the new colour with its resume brief, but a repeat on the same chat means its wakes outlive the drain budget.`);
  }
  // Ticket 533087b7: the backup picture is ADDITIVE — the deploy clauses above
  // keep their exact contract, and the backup verdict follows them.
  if (!parts.length) parts.push('No deploy facts available.');
  if (backupReading) parts.push(backupReading);
  // Ticket 5fba7188: LAST by design — the reader must see which build answered
  // before it treats any absent field above as evidence.
  if (buildReading) parts.push(buildReading);
  return parts.join(' ');
}

/**
 * DEPLOY-WATCH-BLIND (2026-10-20): the deploy view's line for the infra-watch
 * SWEEP's own blind episode — distinct from the caller's read: the sweep runs
 * on the admin owners' / INFRA_WATCH_GITHUB_TOKEN credentials, so a supervisor
 * whose own read works can still be looking at a sweep that raises no deploy
 * alerts. Pure.
 */
export function deployWatchBlindLine(s: DeployWatchBlindState): string {
  return `Infra-watch deploy sweep is BLIND (${s.reason}) since ${s.since} (${s.consecutive} consecutive sweep(s)): a failed deploy raises NO [INFRA ALERT — deploy failed] and no deploy_wave_success row lands until a credential can read the runs (INFRA_WATCH_GITHUB_TOKEN, or an admin owner's connected GitHub account).`;
}

/** WI-G (2026-09-25): chat runs cut by deploy teardowns in the last 24 h — the number the drain work is measured by. */
export interface DeployInterrupts {
  total: number;
  /** rows whose interrupted run was a supervisor-class machine wake (stamped since WI-G; older rows count as unknown) */
  supervisorWakes: number;
  byChat: Array<{ chat: string; count: number }>;
  lastAt: string | null;
}

/**
 * loop_metrics kind chat_run_interrupted with meta.reason 'deploy' over the
 * last 24 h (a handful of rows/day — grouped in memory). Read-only; a DB
 * failure yields null so the deploy view never throws on it.
 */
export async function deployInterruptsLast24h(now: Date): Promise<DeployInterrupts | null> {
  try {
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const rows = (await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.CHAT_RUN_INTERRUPTED, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, sessionId: true, meta: true },
      take: 500,
    })) as Array<{ createdAt: Date; sessionId: string | null; meta: any }>;
    const deploy = rows.filter((r) => r?.meta?.reason === 'deploy');
    const counts = new Map<string, number>();
    for (const r of deploy) {
      const chat = r.sessionId ? r.sessionId.slice(0, 8) : 'anonymous';
      counts.set(chat, (counts.get(chat) ?? 0) + 1);
    }
    return {
      total: deploy.length,
      supervisorWakes: deploy.filter((r) => r.meta?.isSupervisorWake === true).length,
      byChat: [...counts.entries()].map(([chat, count]) => ({ chat, count })).sort((a, b) => b.count - a.count).slice(0, 5),
      lastAt: deploy.length ? deploy[0].createdAt.toISOString() : null,
    };
  } catch {
    return null;
  }
}

// ── metrics ───────────────────────────────────────────────────────────────────

async function latestMetricRows(kind: string, since: Date, limit: number, chatId?: string) {
  const rows = (await prisma.loopMetric.findMany({
    where: { kind, createdAt: { gte: since }, ...(chatId ? { sessionId: chatId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { createdAt: true, sessionId: true, runId: true, value: true, unit: true, meta: true },
  })) as Array<{ createdAt: Date; sessionId: string | null; runId: string | null; value: number | null; unit: string | null; meta: unknown }>;
  return rows.map((r) => ({
    at: r.createdAt.toISOString(),
    chat: r.sessionId ? r.sessionId.slice(0, 8) : null,
    run: r.runId ? r.runId.slice(0, 8) : null,
    value: r.value,
    unit: r.unit,
    meta: truncMeta(r.meta),
  }));
}

// ── entry ─────────────────────────────────────────────────────────────────────

export async function fleetTelemetry(rawArgs: any, deps: TelemetryDeps): Promise<Record<string, unknown>> {
  const args = clampTelemetryArgs(rawArgs);
  if ('error' in args) return { ok: false, error: args.error };
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - args.hours * 3_600_000);
  // Ticket 5fba7188: EVERY answer names the build that produced it. A run still
  // executing on a retiring worker colour answers with the OLD code (the
  // zero-gap drain keeps it running its already-claimed runs up to 6 h), so
  // without this stamp a merely STALE read is indistinguishable from a read
  // that PROVES the newest field is absent — and an honest lane is pushed to a
  // phantom "not live" claim or a re-fix of shipped work. `servingBuild.sha`
  // (vs the deploy view's main head) plus `.draining` is what tells them apart.
  const buildStamp = (deps.servingBuild ?? servingBuild)();
  const base = {
    ok: true, view: args.view, asOf: now.toISOString(), windowHours: args.hours,
    servingBuild: buildStamp,
  };

  // ── T4b (2026-09-24): the fleet dashboard reads the owner looks at, so the
  //    supervisor can re-read what it wrote for them. Each is the SAME service
  //    call the REST route makes, scoped by deps.userId inside the service.
  if (args.view === 'overview' || args.view === 'pulse' || args.view === 'log' || args.view === 'digests') {
    const fleet: any = await import('./fleet.service');
    if (args.view === 'overview') {
      const o = await fleet.getFleetOverview(deps.userId);
      return { ...base, ...o };
    }
    if (args.view === 'pulse') {
      const p = await fleet.getFleetPulse(deps.userId, deps.role ?? 'USER');
      return { ...base, ...p };
    }
    if (args.view === 'log') {
      const l = await fleet.getFleetLog(deps.userId, { limit: args.limit });
      return { ...base, ...l };
    }
    const d = await fleet.getProjectDigests(deps.userId, { showAcked: false });
    return { ...base, ...d, note: 'ack_digest_item {key} / unack_digest_item act on attentionItems[].key' };
  }

  // ── T3a (2026-09-24): the three admin REST reads that had no tool twin ──
  if (args.view === 'errors') {
    const where: any = { createdAt: { gte: since } };
    if (args.level) where.level = args.level;
    if (args.search) where.message = { contains: args.search, mode: 'insensitive' };
    const [rows, total] = await Promise.all([
      (prisma as any).appErrorLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: args.limit, select: { id: true, level: true, message: true, source: true, createdAt: true } }),
      (prisma as any).appErrorLog.count({ where }),
    ]);
    return { ...base, total, rows: rows.map((e: any) => ({ ...e, message: String(e.message).slice(0, TELEMETRY_META_CHARS) })), note: total > args.limit ? `showing the newest ${args.limit} of ${total} — narrow with search/level/hours` : undefined };
  }
  if (args.view === 'jobHealth') {
    const h1 = new Date(now.getTime() - 3_600_000), h24 = new Date(now.getTime() - 86_400_000), d7 = new Date(now.getTime() - 604_800_000);
    const [e24, w24, e7, w7, e1h, oT, iT, dT] = await Promise.all([
      (prisma as any).appErrorLog.count({ where: { level: 'error', createdAt: { gte: h24 } } }),
      (prisma as any).appErrorLog.count({ where: { level: 'warn', createdAt: { gte: h24 } } }),
      (prisma as any).appErrorLog.count({ where: { level: 'error', createdAt: { gte: d7 } } }),
      (prisma as any).appErrorLog.count({ where: { level: 'warn', createdAt: { gte: d7 } } }),
      (prisma as any).appErrorLog.count({ where: { level: 'error', createdAt: { gte: h1 } } }),
      prisma.userFeatureRequest.count({ where: { status: 'open' } }),
      prisma.userFeatureRequest.count({ where: { status: 'in_progress' } }),
      prisma.userFeatureRequest.count({ where: { status: 'done', updatedAt: { gte: d7 } } }),
    ]);
    const recent = await (prisma as any).appErrorLog.findMany({ where: { level: 'error' }, orderBy: { createdAt: 'desc' }, take: Math.min(args.limit, 15), select: { id: true, message: true, source: true, createdAt: true } });
    const avg = e24 > 0 ? e24 / 24 : 0;
    // WI-M (2026-09-25): the SAME live probe the REST admin endpoint returns as
    // deployHealth — one helper, so the supervisor and the admin page agree.
    const deployHealth = await readDeployHealth(deps, now);
    return { ...base, errorSummary: { last1h: { error: e1h }, last24h: { error: e24, warn: w24 }, last7d: { error: e7, warn: w7 }, avgErrorsPerHour: Math.round(avg * 10) / 10, errorSpike: e1h > 5 && e1h > avg * 3 }, recentErrors: recent.map((e: any) => ({ ...e, message: String(e.message).slice(0, TELEMETRY_META_CHARS) })), ticketPipeline: { open: oT, inProgress: iT, done7d: dT }, deployHealth };
  }
  if (args.view === 'costs') {
    const [byDay, bySplit, byModel, topChats] = await Promise.all([
      prisma.$queryRaw<Array<{ day: Date; usd: number | null; runs: number | null }>>`SELECT date_trunc('day', lm."createdAt") AS day, SUM(lm."value")::float AS usd, COUNT(*)::int AS runs FROM "loop_metrics" lm WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<Array<{ profile: string | null; trigger_kind: string | null; usd: number | null }>>`SELECT COALESCE(lm."meta"->>'profile', 'coding') AS profile, COALESCE(lm."meta"->>'triggerKind', 'user') AS trigger_kind, SUM(lm."value")::float AS usd FROM "loop_metrics" lm WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since} GROUP BY 1, 2 ORDER BY 3 DESC`,
      prisma.$queryRaw<Array<{ model: string | null; kind: string; tokens: number | null }>>`SELECT lm."meta"->>'model' AS model, lm."kind" AS kind, SUM(lm."value")::float AS tokens FROM "loop_metrics" lm WHERE lm."kind" IN ('run_tokens_in','run_tokens_out') AND lm."createdAt" >= ${since} GROUP BY 1, 2`,
      prisma.$queryRaw<Array<{ chat_id: string | null; title: string | null; usd: number | null; runs: number | null }>>`SELECT lm."sessionId" AS chat_id, MAX(c."title") AS title, SUM(lm."value")::float AS usd, COUNT(*)::int AS runs FROM "loop_metrics" lm LEFT JOIN "crossmodel_chats" c ON c."id" = lm."sessionId" WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${since} GROUP BY 1 ORDER BY 3 DESC LIMIT ${args.limit}`,
    ]);
    const models: Record<string, { tokensIn: number; tokensOut: number }> = {};
    for (const r of byModel) { const k = r.model || 'unknown'; const acc = (models[k] ||= { tokensIn: 0, tokensOut: 0 }); if (r.kind === 'run_tokens_in') acc.tokensIn += Number(r.tokens) || 0; else acc.tokensOut += Number(r.tokens) || 0; }
    const totalUsd = byDay.reduce((a, r) => a + (Number(r.usd) || 0), 0);
    return { ...base, totalUsd: Math.round(totalUsd * 100) / 100, byDay: byDay.map((r) => ({ day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day), usd: Math.round((Number(r.usd) || 0) * 100) / 100, runs: Number(r.runs) || 0 })), byProfileTrigger: bySplit.map((r) => ({ profile: r.profile, triggerKind: r.trigger_kind, usd: Math.round((Number(r.usd) || 0) * 100) / 100 })), byModel: models, topChats: topChats.map((r) => ({ chatId: r.chat_id, title: r.title, usd: Math.round((Number(r.usd) || 0) * 100) / 100, runs: Number(r.runs) || 0 })), estimated: true };
  }
  if (args.view === 'boxes') {
    // Ticket 9c0caf1c: the sha history comes from the SAME box_health read as
    // the rows (no second query), and the deploy-run state is read through the
    // caller's connected account so the view can say "in flight: run N" instead
    // of presenting a transient sha as the box's state. One invariant holds
    // throughout: an UNREAD wave is never reported as "no wave" (wave.read).
    const [{ rows, shaHistory }, downRows, wave] = await Promise.all([
      latestBoxHealthRowsWithHistory(now, { perProcess: true }),
      prisma.loopMetric.findMany({
        where: { kind: LOOP_METRIC_KINDS.DECISION_GATE_BACKEND_DOWN, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { meta: true, createdAt: true },
      }).catch(() => []) as Promise<Array<{ meta: any; createdAt: Date }>>,
      readDeployWaveStamp(deps, now),
    ]);
    const shaped = annotateBoxSha(shapeBoxes(rows, now), shaHistory, wave);
    const evidence = shaEvidence(shaped, wave);
    return {
      ...base,
      boxes: shaped,
      deployWave: wave,
      shaEvidence: evidence,
      ...(wave.inFlight === true ? { inFlight: true } : {}),
      decisionGate: shapeDecisionBackendDown(downRows, now),
      note: rows.length
        ? (wave.inFlight === true ? `${evidence.reason}.` : undefined)
        : 'no box_health rows in the last 24 h — every reporter is silent or the infra watch is disabled (INFRA_WATCH_DISABLED=1)',
    };
  }

  if (args.view === 'kinds') {
    const kinds = await summarizeLoopMetrics(args.hours);
    return { ...base, kinds };
  }

  if (args.view === 'cards') {
    // The caller's OWN staged confirmations (userId scope = the per-user gate;
    // an admin's Fleet Supervisor runs as the admin, so it sees the owner's cards).
    const rows = (await prisma.pendingConfirmation.findMany({
      where: { userId: deps.userId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: args.limit,
      select: { id: true, chatId: true, tool: true, status: true, summary: true, createdAt: true, resolvedAt: true },
    })) as Array<{ id: string; chatId: string; tool: string; status: string; summary: string; createdAt: Date; resolvedAt: Date | null }>;
    const byTool = new Map<string, number>();
    const byChat = new Map<string, number>();
    for (const r of rows) {
      byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + 1);
      byChat.set(r.chatId.slice(0, 8), (byChat.get(r.chatId.slice(0, 8)) ?? 0) + 1);
    }
    return {
      ...base,
      total: rows.length,
      byTool: [...byTool.entries()].map(([tool, n]) => ({ tool, n })).sort((a, b) => b.n - a.n),
      byChat: [...byChat.entries()].map(([chat, n]) => ({ chat, n })).sort((a, b) => b.n - a.n),
      cards: rows.map((r) => ({
        id: r.id,
        chat: r.chatId.slice(0, 8),
        tool: r.tool,
        status: r.status,
        summary: r.summary.length > 200 ? `${r.summary.slice(0, 200)}…` : r.summary,
        at: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      })),
      note: rows.length >= args.limit ? `capped at ${args.limit} — raise limit (max ${TELEMETRY_MAX_LIMIT}) or narrow hours` : undefined,
    };
  }

  if (args.view === 'collab') {
    // Per-run tool-family profiles (coding/tool-profile.ts → run_tool_profile
    // rows) aggregated per lane. Per-user gate: only chats the CALLER owns are
    // named (an admin's Fleet Supervisor runs as the admin; another user's lanes
    // never appear). `alone` = ≥ COLLAB_MIN_RUNS runs with zero memory / web /
    // delegation / sub-session use — the "works alone and offline" signal the
    // owner spotted by eye on 2026-09-19 and nobody could measure.
    const rows = (await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.RUN_TOOL_PROFILE, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: COLLAB_SCAN_ROWS,
      select: { sessionId: true, meta: true, createdAt: true },
    })) as Array<{ sessionId: string | null; meta: any; createdAt: Date }>;
    type LaneAgg = { runs: number; machineRuns: number; aloneRuns: number; calls: number; memory: number; web: number; delegate: number; spawn: number; messages: number; connectors: number; runCommand: number; lastRunAt: Date; seats: Set<string> };
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
    const agg = new Map<string, LaneAgg>();
    for (const r of rows) {
      if (!r.sessionId) continue;
      const m = (r.meta && typeof r.meta === 'object') ? r.meta as Record<string, unknown> : {};
      const a = agg.get(r.sessionId) ?? { runs: 0, machineRuns: 0, aloneRuns: 0, calls: 0, memory: 0, web: 0, delegate: 0, spawn: 0, messages: 0, connectors: 0, runCommand: 0, lastRunAt: r.createdAt, seats: new Set<string>() };
      a.runs += 1;
      if (m.machine === true) a.machineRuns += 1;
      const fam = { memory: n(m.memory), web: n(m.web), delegate: n(m.delegate), spawn: n(m.spawn) };
      if (workedAlone(fam)) a.aloneRuns += 1;
      a.calls += n(m.calls); a.memory += fam.memory; a.web += fam.web; a.delegate += fam.delegate; a.spawn += fam.spawn;
      a.messages += n(m.messages); a.connectors += n(m.connectors); a.runCommand += n(m.runCommand);
      if (r.createdAt > a.lastRunAt) a.lastRunAt = r.createdAt;
      if (typeof m.seat === 'string' && m.seat) a.seats.add(m.seat);
      agg.set(r.sessionId, a);
    }
    const ids = [...agg.keys()];
    const chats = ids.length
      ? (await prisma.crossModelChat.findMany({
          where: { id: { in: ids }, userId: deps.userId },
          select: { id: true, title: true, isSupervisor: true, isProjectSupervisor: true, project: { select: { name: true } } },
        })) as Array<{ id: string; title: string; isSupervisor: boolean; isProjectSupervisor: boolean; project: { name: string } | null }>
      : [];
    const lanes = chats.map((c) => {
      const a = agg.get(c.id)!;
      const alone = a.runs >= COLLAB_MIN_RUNS && a.memory + a.web + a.delegate + a.spawn === 0;
      return {
        chat: c.id.slice(0, 8),
        title: c.title.length > 60 ? `${c.title.slice(0, 60)}…` : c.title,
        project: c.project?.name ?? null,
        kind: c.isSupervisor ? 'fleet-supervisor' : c.isProjectSupervisor ? 'project-supervisor' : 'lane',
        seats: [...a.seats].sort(),
        runs: a.runs, machineRuns: a.machineRuns, aloneRuns: a.aloneRuns, calls: a.calls,
        memory: a.memory, web: a.web, delegate: a.delegate, spawn: a.spawn, messages: a.messages, connectors: a.connectors, runCommand: a.runCommand,
        alone,
        lastRunAgeMin: ageMin(a.lastRunAt, now),
      };
    }).sort((x, y) => y.runs - x.runs).slice(0, args.limit);
    const active = lanes.filter((l) => l.runs >= COLLAB_MIN_RUNS);
    const aloneLanes = active.filter((l) => l.alone);
    const totals = lanes.reduce((t, l) => ({ runs: t.runs + l.runs, memory: t.memory + l.memory, web: t.web + l.web, delegate: t.delegate + l.delegate, spawn: t.spawn + l.spawn }), { runs: 0, memory: 0, web: 0, delegate: 0, spawn: 0 });
    const reading = rows.length === 0
      ? 'no run_tool_profile rows in the window yet — the profile is recorded at run finalize on builds from 2026-09-19 onward'
      : `${aloneLanes.length} of ${active.length} active lane(s) (≥ ${COLLAB_MIN_RUNS} runs) worked ALONE — zero memory / web / delegation / sub-session use${aloneLanes.length ? `: ${aloneLanes.map((l) => `${l.chat} "${l.title}"`).join(', ')}` : ''}. Window totals: ${totals.runs} runs, ${totals.memory} memory reads, ${totals.web} web calls, ${totals.delegate} delegations, ${totals.spawn} sub-sessions spawned.`;
    return { ...base, minRuns: COLLAB_MIN_RUNS, totals, lanes, reading, note: rows.length >= COLLAB_SCAN_ROWS ? `scan capped at ${COLLAB_SCAN_ROWS} newest rows — narrow hours` : undefined };
  }

  if (args.view === 'metrics') {
    const kind = args.kind!;
    // Outcomes + payload sizes are BEST-EFFORT: a kind with no boolean-ish flag
    // (or no size) gets an honest empty answer, and a failed read must never
    // take the counts down with it — this view is a supervisor's only window
    // into the rows (tickets 63ab9dc7 / d59499f4).
    const [buckets, latest, outcomesRaw, payloadSizes, legs] = await Promise.all([
      queryLoopMetrics(kind, { hours: args.hours, bucket: args.bucket }),
      latestMetricRows(kind, since, args.limit, args.chatId),
      args.chatId
        ? Promise.resolve(null) // an aggregate is window-wide; never silently mix it with a chat-scoped sample
        : queryLoopMetricOutcomes(kind, { hours: args.hours, bucket: args.bucket }).catch(() => null),
      args.chatId ? Promise.resolve(null) : queryLoopMetricPayloadSizes(kind, { hours: args.hours }).catch(() => null),
      // Ticket b5f4d5e2: which LEG failed, and who aborted. Best-effort like the
      // other aggregates — a failed read must never take the counts down.
      args.chatId ? Promise.resolve(null) : queryLoopMetricLegs(kind, { hours: args.hours }).catch(() => null),
    ]);
    // The per-(bucket, unit) list is capped the SAME way `series` is — from the
    // END, freshest buckets win. Uncapped it is hours × units (168 × N), which
    // overflows the tool-result display cap and truncates away `latest` AND the
    // note below — the very warning that says to cite one unit group.
    const outcomes = outcomesRaw
      ? { ...outcomesRaw, buckets: outcomesRaw.buckets.slice(-TELEMETRY_MAX_BUCKETS) }
      : null;
    const total = buckets.reduce((n, b) => n + b.count, 0);
    const series = buckets.slice(-TELEMETRY_MAX_BUCKETS).map((b) => ({ bucket: b.bucket, count: b.count, sum: b.sum, avg: b.avg }));
    // ── Ticket ecfc9bf8: `latest` is a SAMPLE, and it must say so ────────────
    // `latest` is the NEWEST `limit` rows over a window that can hold millions,
    // so it is a floor for any count derived from it, never a count. Three
    // separate traps made that unreadable: (1) the array capped at
    // TELEMETRY_MAX_LIMIT regardless of `limit`, (2) the cap was undisclosed, and
    // (3) one embed call writes TWO rows (an attempt row + a call roll-up), so a
    // "call count" read off `latest` is ~half the real number. An operator wrote
    // a gate that could never open because of exactly this. The aggregate that
    // DOES count lives in `outcomes` (DB-side COUNT, no row cap) — so the answer
    // now discloses the cap, and names `outcomes` as the count to use instead.
    const latestSample = {
      /** rows actually returned */
      returned: latest.length,
      /** the limit the caller asked for, before the TELEMETRY_MAX_LIMIT clamp */
      requested: args.limitRequested ?? args.limit,
      /** the ceiling actually applied */
      limit: args.limit,
      maxLimit: TELEMETRY_MAX_LIMIT,
      /**
       * the window's row count for this kind — compare against `returned`.
       * NULL on a chat-scoped read: `total` is platform-wide while `latest` is
       * chat-scoped, so the two count different populations and comparing them
       * would invent a truncation ratio. The chat's own row total is not
       * returned by this view.
       */
      windowTotal: args.chatId ? null : total,
      /**
       * true only when `latest` was NOT OBSERVED to be truncated — i.e. the
       * array covers the whole window's row count. Deliberately hedged: `total`
       * (from queryLoopMetrics) and `latest` (from latestMetricRows) are two
       * separate concurrent reads over a moving table, so a row landing between
       * them can make a genuinely-truncated window read as complete. It is a
       * reliable signal for THIS ticket's failure mode (50 vs 10,447 — off by
       * orders), not a transactionally-exact predicate. NULL (unknown) on a
       * chat-scoped read: `total` is platform-wide there, so no comparison is
       * possible and `false` would claim a truncation nobody measured.
       */
      complete: args.chatId ? null : latest.length >= total,
    };
    const note = [
      !KNOWN_KINDS.has(kind) && total === 0 ? `'${kind}' is not a registered loop_metrics kind — use view 'kinds' for what the window contains` : null,
      // Disclose the clamp itself. Silent truncation reads as "the window holds
      // 50 rows", which is how a satisfaction gate got written against a sample.
      latestSample.requested > latestSample.maxLimit
        ? `limit ${latestSample.requested} exceeds the ceiling ${latestSample.maxLimit} — ${latest.length} latest row(s) returned, not ${latestSample.requested}`
        : null,
      !args.chatId && total > latest.length
        ? `latest is a newest-${latest.length} SAMPLE of ${total} row(s) in this window (a floor, not a count) — ${outcomes?.flag ? 'take COUNTS and success RATES from `outcomes` (DB-side aggregate, no row cap)' : 'the outcomes aggregate cannot supply a rate for this kind, so no success rate is computable here'}; one embed call writes two rows (an attempt row + a call roll-up), so a call count read off latest is roughly double`
        : null,
      // A chat-scoped read cannot compare `returned` to anything: `total` is
      // platform-wide, so claiming a ratio here would be a fabricated number.
      args.chatId
        ? `latest is the newest ${latest.length} row(s) for THIS chat only — windowTotal/complete are null because the view returns no chat-scoped row total, and no success rate is computable on a chat-scoped read (drop chatId for a window rate)`
        : null,
      buckets.length > TELEMETRY_MAX_BUCKETS
        ? `series shows the freshest ${TELEMETRY_MAX_BUCKETS} of ${buckets.length} buckets — 'total' counts the WHOLE window, but older buckets (and their rows) are outside this answer; narrow hours to see them`
        : null,
      // outcomes.buckets is capped identically to series — a caller reading the
      // per-bucket ok/fail history over a long window would otherwise see a
      // silently short list (adversarial review finding 4).
      outcomesRaw && outcomesRaw.buckets.length > TELEMETRY_MAX_BUCKETS
        ? `outcomes.buckets shows the freshest ${TELEMETRY_MAX_BUCKETS} of ${outcomesRaw.buckets.length} (bucket × unit) groups — outcomes.window and outcomes.byUnit still cover the WHOLE window, so cite those for a window rate`
        : null,
      outcomes && outcomes.window.total > 0 && !outcomes.flag
        ? 'no row in this window carries a boolean-ish success flag (meta.ok / meta.success) — outcomes.window.total counts rows, ok/fail/rate stay 0/null rather than guessing'
        : null,
      outcomes && outcomes.byUnit.length > 1
        ? `outcomes are grouped by meta.unit (${outcomes.byUnit.map((g) => g.unit ?? '(no unit)').join(', ')}) — cite ONE group's rate, or state which; a rate pooled across them is ambiguous`
        : null,
      outcomesRaw === null && !args.chatId
        ? 'the outcomes aggregate read FAILED for this window — null here is blind, not "no rows" (the counts above are unaffected)'
        : null,
      payloadSizes === null && !args.chatId
        ? 'the payload-size read FAILED for this window — null here is blind, not "no rows" (the counts above are unaffected)'
        : null,
      outcomes && outcomes.window.total > 0 && !payloadSizes?.length
        ? 'no payload-size field on these rows (meta.chars / meta.batchChars) — payload distribution unavailable; a size is only emitted from the build that started writing it, so a window spanning the change mixes populations'
        : null,
      // Ticket b5f4d5e2. `legs: null` collapsed three different states (a failed
      // read, an empty window, a kind that emits no legs) into one silence —
      // the same defect the payload-size clause above already fixes. Mirror it.
      legs === null && !args.chatId
        ? 'the per-leg read FAILED for this window — null here is blind, not "no legs" (the counts above are unaffected)'
        : null,
      legs && legs.length === 0 && !args.chatId
        ? 'no row in this window carries a leg or abort field (meta.leg / meta.abort) — a leg is only emitted from the build that started writing it, so a window spanning the change mixes populations'
        : null,
      legs && legs.length > 0 && legs.some((l) => l.leg === null && l.abort === null)
        ? 'the (leg:null, abort:null) group is NOT a failed leg: it is rows that reported neither — a leg-less successful attempt (a direct-to-provider lane with no gateway in front) or a pre-change row. Read `caller_timeout` rows for the aborted-at-our-bound population'
        : null,
    ].filter(Boolean).join(' · ') || undefined;
    // ORDER MATTERS, and this order is the fix (adversarial review finding 1):
    // a tool result is truncated to DISPLAY_RESULT_CAP (8000 chars) in the
    // persisted transcript/UI. `latest` at 50 rows is ~10k+ chars on its own, so
    // emitting it BEFORE `note` pushed the disclosure past the cap — the human
    // reading the transcript saw the sample and never the warning about it.
    // `latestSample` and `note` therefore come FIRST; the bulk array goes last.
    // (A corrected claim: the OLD comment said the opposite while doing it wrong.)
    return {
      ...base,
      kind,
      known: KNOWN_KINDS.has(kind),
      // `total` is platform-wide on a chat-scoped read while `latest`/series
      // narrow to one chat — name the scope so the pair is never silently
      // compared (adversarial review finding 2).
      totalScope: args.chatId ? 'platform-wide (IGNORES chatId — not this chat’s row count)' : 'window (this kind)',
      total,
      bucket: args.bucket,
      series,
      ...(args.chatId ? { chatId: args.chatId } : {}),
      // Ticket ecfc9bf8: `latest` is a newest-N SAMPLE, never a count. This
      // block is machine-readable disclosure so a gate can assert
      // `latestSample.complete === true` (or use `outcomes`) instead of
      // silently treating a capped array as the window.
      latestSample,
      note,
      // Ticket d59499f4: the ok/fail aggregate, grouped BY UNIT and by bucket.
      // A caller MUST name the unit it cites — one embed call writes two rows at
      // the same timestamp (an attempt row and a call roll-up), so a rate that
      // mixes them is ambiguous (85.71 % per attempt vs 95.45 % per call on the
      // same prod sample).
      // Emitted BEFORE `latest` on purpose: this is the aggregate the note points
      // at for counts and rates, so it must survive the display cap that the
      // ~10k-char `latest` array trips (ticket ecfc9bf8, review finding 1).
      outcomes,
      // Ticket d59499f4 (#1): p50/p95/max payload size per unit, so chunk/batch
      // sizing stops being a blind guess. Empty = the kind emits no size.
      payloadSizes: payloadSizes && payloadSizes.length ? payloadSizes : null,
      // Ticket b5f4d5e2: the attribution read — attempts grouped by (leg, abort)
      // with p50/p95 wall-clock, failures first. This is what makes "which leg
      // failed" a read instead of an inference; a leg-less row (a caller abort
      // has no response header to name a leg) still appears, under leg: null,
      // with its `abort` naming the side that ended it.
      legs: legs && legs.length ? legs : null,
      // The BULK array goes LAST: it is the one block big enough to trip the
      // display cap, and everything above it is what a truncated reader must
      // still see (the disclosure, and the counts that are not a sample).
      latest,
    };
  }

  if (args.view === 'fleetEvents') {
    // The durable KPI ledger (feedback 4e36ee4a). The shared hours arg maps
    // onto whole UTC days (ceil so any partial trailing day is included); the
    // ledger itself outlives the 168h tool cap — fleetEventKpis({days}) reads
    // arbitrary windows for future surfaces.
    const kpis = await fleetEventKpis({ days: Math.max(1, Math.ceil(args.hours / 24)) });
    return { ...base, ...kpis };
  }

  // view === 'deploy'
  const getToken = deps.getGithubToken ?? (async (userId: string) => (await import('../github/token-manager')).getValidToken(userId));
  const token = await getToken(deps.userId).catch(() => null);

  // REPO-SCOPED read (ticket 51ff7e93): any repo the caller's connected GitHub
  // account can read — how a PROJECT lane verifies its own deploy ("commit X
  // deployed, run Y concluded success") instead of probing production ad hoc.
  // Deliberately NO box picture here: box_health rows are the FRAMEWORK's
  // boxes; showing them against a foreign repo's sha was exactly the confusion
  // the ticket reported. Inaccessible/missing repos surface as ok:false —
  // never as an empty run list.
  if (args.repo) {
    if (!token) {
      return {
        ...base,
        repo: args.repo,
        ref: args.ref ?? 'main',
        github: 'unavailable — no connected GitHub account for this user (Account → Integrations → GitHub); the repo-scoped deploy read cannot run',
      };
    }
    const repo = args.repo;
    const ref = args.ref ?? 'main';
    const runsResult = await (deps.fetchRepoRuns ?? fetchRepoActionRuns)(token, repo, { perPage: DEPLOY_RUNS_PER_PAGE, ...(args.ref ? { ref } : {}) });
    if (!runsResult.ok) {
      return {
        ...base,
        repo,
        ref,
        ok: false,
        error: `cannot read Actions runs for ${repo}: ${runsResult.message}. Check the slug, the connected account's access to the repo, and try again — this is an access error, not "no runs".`,
      };
    }
    const head = await (deps.fetchRepoHead ?? fetchRepoHead)(token, repo, ref).catch(() => null);
    const runs = shapeDeployRuns(runsResult.runs).map((r) => ({ ...r, workflow: workflowName(runsResult.runs.find((x) => Number(x?.id) === r.id)) }));
    const mainHead = head ? { sha: short(head.sha)!, committedAt: head.committedAt, title: head.title } : null;
    return {
      ...base,
      repo,
      ref,
      mainHead: mainHead ?? 'unavailable',
      inFlight: runs.some((r) => r.status !== 'completed'),
      runs,
      reading: readRepoDeployPicture(repo, ref, mainHead, runs, servingBuildLine(buildStamp, mainHead)),
    };
  }

  const [boxRead, deployHealth, deployInterrupts24h] = await Promise.all([
    latestBoxHealthRowsWithHistory(now, { perProcess: true }),
    readDeployHealth(deps, now),
    // WI-G: how many chat runs deploy teardowns cut in the last 24 h — the
    // number the drain budget / retire nudge work is measured by.
    deployInterruptsLast24h(now),
  ]);
  // Ticket 9c0caf1c: the deploy view hands out the SAME per-surface sha, so it
  // carries the same stability annotation — otherwise a consumer sidesteps the
  // boxes view's protection by reading its sibling and gets the bare sha back.
  // The wave stamp is derived from the runs THIS view already reads, below.
  const annotateDeployBoxes = (wave: DeployWaveStamp) =>
    // ...b carries the full annotation INCLUDING settled and previousShaAt (the
    // fields the map used to drop — reviewer finding 5): the deploy view hands
    // out exactly what the boxes view hands out, so no consumer can get a
    // weaker-sha claim by reading the sibling view.
    annotateBoxSha(shapeBoxes(boxRead.rows, now), boxRead.shaHistory, wave);
  // No wave read yet — spelled 'unavailable', never "no wave in flight".
  const unreadWave = deployWaveStamp([], 'unavailable', now);
  // DEPLOY-WATCH-BLIND (2026-10-20): the view names a read it could not make
  // ("github: blind (<reason>)") instead of an empty runs list that reads as
  // "no runs", and carries the infra-watch SWEEP's own blind episode — while
  // the sweep is blind, a failed deploy raises no alert at all.
  const blindView = !infraWatchBlindAlarmDisabled();
  const sweepBlind = blindView ? await (deps.readDeployWatchBlind ?? readDeployWatchBlindState)().catch(() => null) : null;
  const deployWatch = sweepBlind ? deployWatchBlindLine(sweepBlind) : undefined;
  // Ticket 533087b7: the backup picture travels with the deploy view. The rows
  // alone carried `backup.ageH` with no ROLE attached, so a non-producer's
  // by-design leftover dumps (box-b: 1,031 h) read exactly like a dead nightly
  // and a supervisor filed an unrecoverable-gap ticket off it. Both the numbers
  // and the sentence below now say whose dump is whose.
  const backupViewOf = (bx: ReturnType<typeof annotateDeployBoxes>) => readBackupPicture(bx, now);
  if (!token) {
    const noTokenBoxes = annotateDeployBoxes(unreadWave);
    const backup = backupViewOf(noTokenBoxes);
    const reading = readDeployPicture(null, [], noTokenBoxes, deployInterrupts24h, undefined, backup.reading, servingBuildLine(buildStamp, null));
    return {
      ...base,
      repo: DEPLOY_REPO,
      github: blindView
        ? 'blind (no_token) — no connected GitHub account for this user (Account → Integrations → GitHub); main head and deploy runs cannot be read'
        : 'unavailable — no connected GitHub account for this user (Account → Integrations → GitHub); main head and deploy runs cannot be read',
      ...(deployWatch ? { deployWatch } : {}),
      boxes: noTokenBoxes,
      backup,
      deployWave: unreadWave,
      shaEvidence: shaEvidence(noTokenBoxes, unreadWave),
      deployHealth,
      deployInterrupts24h,
      reading: deployWatch ? `${reading} ${deployWatch}` : reading,
    };
  }
  const runsFetch: (t: string, n: number) => Promise<WorkflowRunsFetch> = deps.fetchRunsWithStatus
    ?? (deps.fetchRuns
      ? (async (t: string, n: number) => ({ runs: await deps.fetchRuns!(t, n), status: 200 }))
      : ((t: string, n: number) => fetchDeployRunsWithStatus(t, { perPage: n })));
  const [head, runsRead] = await Promise.all([
    (deps.fetchHead ?? fetchMainHead)(token).catch(() => null),
    runsFetch(token, DEPLOY_RUNS_PER_PAGE).catch((): WorkflowRunsFetch => ({ runs: [], status: null })),
  ]);
  const runsRaw = Array.isArray(runsRead.runs) ? runsRead.runs : [];
  // Wording (github/reading strings) is gated by the blind-alarm kill switch —
  // that switch's scope is PRESENTATION only.
  const runsBlind = blindView && !runsRead.skipped && runsRead.status !== 200 ? deployWatchBlindReason(runsRead.status) : null;
  const runs = shapeDeployRuns(runsRaw);
  const mainHead = head ? { sha: short(head.sha)!, committedAt: head.committedAt, title: head.title } : null;
  // Ticket 9c0caf1c: the wave stamp THIS view is consistent with — from the runs
  // it already read. A blind read stays blind (inFlight null), never "no wave".
  // The stamp's truth is NOT gated by INFRA_WATCH_BLIND_ALARM_DISABLED: that
  // switch covers wording/alerting, never an evidence verdict — a skipped
  // (non-prod) or malformed read is 'blind' here exactly as the boxes view
  // reads it, so the two views can never disagree about the same read.
  const waveRead: DeployWaveStamp['read'] = runsRead.skipped || runsRead.malformed || runsRead.status !== 200 ? 'blind' : 'read';
  const wave = deployWaveStamp(runs, waveRead, now);
  const deployBoxes = annotateDeployBoxes(wave);
  const shaped = deployBoxes.map((b) => ({ ...b, onMainHead: mainHead && b.sha ? b.sha === mainHead.sha : null }));
  // Ticket 533087b7: the fleet-level backup picture for the WITH-token path —
  // same producer-role semantics as the no-token path above.
  const backup = backupViewOf(deployBoxes);
  // Worker-lag verdicts (2026-10-07): for every box NOT on main head that
  // reports a sha, fetch the compare file list (box sha → main head) and
  // classify it against the deploy script's own rebuild-input rules — the
  // verdict the operator used to hand-derive with git diff. Failures degrade
  // to 'unknown' (classify by hand), never a guess: a misread 'expected'
  // would silence a real lag, the exact misdirection this replaces.
  // 2026-10-09: a 'real' verdict read while the deploy wave for the current
  // main head is still executing is the NORMAL mid-wave window, not a
  // failed/skipped deploy step — the classifier needs that run-state fact
  // (it cannot derive it from a file list) or every on-time firing falsely
  // accuses the wave mid-run (live: all 4 boxes, run 37954579315).
  const headDeployInFlight = runs.some((r) => r.status !== 'completed' && (mainHead ? r.sha === mainHead.sha : true));
  // FO f175 (WL-1): age of the completed wave for the current main head — the
  // deferral arm's input. Only passed when finite; an unreadable/absent wave
  // keeps the old failed-or-skipped verdict (the suspicious case).
  const headWaveDone = mainHead ? runs.find((r) => r.status === 'completed' && r.sha === mainHead.sha) : undefined;
  const headWaveAgeRaw = headWaveDone ? Date.now() - Date.parse(headWaveDone.updatedAt) : NaN;
  const headWaveAgeMs = Number.isFinite(headWaveAgeRaw) ? headWaveAgeRaw : undefined;
  const lagBoxes = shaped.filter((b) => b.sha && mainHead && b.sha !== mainHead.sha);
  const lagVerdicts: Array<{ box: string; verdict: WorkerLagVerdict }> = [];
  for (const b of lagBoxes) {
    const files = await (deps.fetchCompare ?? fetchCompareFiles)(token, b.sha!, mainHead!.sha).catch(() => null);
    lagVerdicts.push({ box: `${b.host}/${b.process}`, verdict: classifyWorkerLag(files, { headDeployInFlight, headWaveAgeMs }) });
  }
  const picture = readDeployPicture(mainHead, runs, shaped, deployInterrupts24h, lagVerdicts, backup.reading, servingBuildLine(buildStamp, mainHead));
  const reading = [
    ...(runsBlind ? [`GitHub deploy runs are UNREADABLE (blind: ${runsBlind}) — the empty runs list means "cannot read", NOT "no runs"; do not conclude a wave is or is not live from it.`] : []),
    picture,
    ...(deployWatch ? [deployWatch] : []),
  ].join(' ');
  const evidence = shaEvidence(deployBoxes, wave);
  return {
    ...base,
    repo: DEPLOY_REPO,
    ...(runsBlind ? { github: `blind (${runsBlind}) — the deploy-runs read for ${DEPLOY_REPO} was refused or got no answer with this user's GitHub token; runs below are empty because they could not be read` } : {}),
    ...(deployWatch ? { deployWatch } : {}),
    mainHead: mainHead ?? 'unavailable',
    inFlight: runs.some((r) => r.status !== 'completed'),
    runs,
    boxes: shaped,
    // Ticket 533087b7: the fleet-level backup picture — producer-only age, and
    // the by-design leftovers/unmounted surfaces named as such.
    backup,
    // Ticket 9c0caf1c: the same stability stamp the boxes view carries.
    deployWave: wave,
    shaEvidence: evidence,
    workerLag: lagVerdicts.length ? lagVerdicts.map((v) => ({ box: v.box, kind: v.verdict.kind, changed: v.verdict.changed.slice(0, 12), reason: v.verdict.reason })) : undefined,
    deployHealth,
    deployInterrupts24h,
    reading: `${reading} SHA EVIDENCE: ${evidence.reason}`,
  };
}

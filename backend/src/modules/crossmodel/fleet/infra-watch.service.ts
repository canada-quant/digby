/**
 * Infra watch — the operational signals the Fleet Supervisor could not see
 * (owner 2026-09-18: "continue to harden the fleet supervisor so you can
 * retire and the fleet supervisor can take over your role as the framework
 * operator").
 *
 * What happened without it, all on 2026-09-18: box A's root disk hit 99% and
 * the deploy pipeline ABORTED before building (nothing on the fleet noticed —
 * the owner's Files-tab fix sat undeployed for hours); the nightly database
 * backup FAILED on the full disk (nothing noticed); a CI red on a stale test
 * pin cancelled a wave (nothing noticed); nine confirmation cards in a week
 * were one defect class (a mistyped chat id) that the owner kept clicking
 * through. Every one of those was a framework-operator job a human session
 * did by hand. This module turns them into deterministic wakes with a
 * playbook, so the supervisor dispatches and verifies the fix itself.
 *
 * Three signals, one sweep (runs inside the attention watchdog, ≤15-min cadence):
 *   1. BOX HEALTH — every process reports `box_health` (disk %, free GB,
 *      memory, load) every 15 min: the worker cron on A and C, the web backend
 *      on A and B (server.ts interval). Labelled by BOX_NAME from the box's
 *      env overrides (box-a / box-b / box-c), not the container hostname.
 *      ≥ DISK_WARN_PCT → warning, ≥ DISK_CRIT_PCT → critical; a box that
 *      reported in the last 24 h but not in the last BOX_HEALTH_STALE_MS →
 *      'silent'.
 *   2. DEPLOY FAILURES — the deploy workflow's runs concluded 'failure' in
 *      the last DEPLOY_LOOKBACK_MS, read from GitHub with the admin owner's
 *      connected GitHub token (token-manager.getValidToken); each failed run
 *      alerts once (Redis, 24 h). Since 2026-09-27 each alert also carries
 *      the SAME-SHA CI (ci.yml) verdict: the suite runs twice per main push
 *      (CI on push:main + the deploy Test gate via workflow_call), so a
 *      green same-sha CI run marks the deploy failure a rolled FLAKE —
 *      re-run the wave, don't open a fix lane (attachCiVerdicts +
 *      renderDeployFailureAlert's SAME-SHA CI VERDICT line).
 *      DEPLOY-WATCH-BLIND (2026-10-20): prod recorded 0 deploy_wave_success
 *      rows over 10-17..10-20 against 110 green + 10 red deploy.yml runs — the
 *      sweep read ONE token (targets[0], an unordered take:10, whose owner had
 *      no labelled GitHub account: getValidToken warned 73× on 10-18) and
 *      skipped silently on null, and the run fetchers returned [] on any
 *      non-200. Now: INFRA_WATCH_GITHUB_TOKEN (read-only secret) is tried
 *      first, then every admin owner's token in a stable order
 *      (adminFleetSupervisors orderBy createdAt asc) until a deploy-runs read
 *      answers HTTP 200 (probeDeployWatchToken); a sweep with no token or no
 *      200 is BLIND — one infra_watch_blind loop_metrics row {reason:
 *      'no_token' | 'network' | 'http_<n>'}, a Redis consecutive-blind count,
 *      and at DEPLOY_WATCH_BLIND_ALARM_AFTER ONE [INFRA ALERT — deploy watch
 *      blind] wake per 24 h; the get_fleet_telemetry deploy view says
 *      "github: blind (<reason>)". Kill switch INFRA_WATCH_BLIND_ALARM_DISABLED=1.
 *   3. OWNER-CLICK COST — once a day per owner: confirmation cards staged in
 *      the last 24 h grouped by tool (ownerStagedCardRows → pending_confirmations
 *      scoped by userId, same scope as get_fleet_telemetry view 'cards';
 *      10395cc6: the old global loop_metrics read counted every account's
 *      cards as the owner's on this multi-tenant instance);
 *      ≥ CARD_COST_DAILY_THRESHOLD → an alert naming the classes, because a
 *      repeated staging class is a framework defect, not an owner chore.
 *      AUTO-TICKET (WI-Q, 2026-09-25): a tool that accounts for
 *      ≥ CARD_TICKET_MIN_PER_TOOL cards in that day files ONE
 *      user_feature_requests row per (tool, ISO week) through the same insert
 *      path the file_feedback tool uses (feedback.fileFeedbackTicket — its
 *      caps/dedup apply), deduped in Redis (`infra-watch:card-ticket:<tool>:
 *      <week>` holds the ticket id), and the wake cites the ticket id so the
 *      supervisor dispatches against a durable row instead of a prose alert
 *      that dies with the wake. (RSW-1 2026-10-30: the
 *      INFRA_WATCH_CARD_TICKETS_DISABLED kill switch was deleted — NF_INERT,
 *      never forwarded by compose, so prod only ever ran the filing branch.)
 *      Insert-path contract (review fix 2026-09-25): the filing's
 *      context.sessionId is PER TOOL (`infra-watch:<tool>`) — the feedback
 *      service's same-session 24 h FUZZY title dedup (Jaccard ≥ 0.6) scores
 *      "Card class: send_chat_message staged 3×/day …" against
 *      "… notify_user staged 3×/day …" at 0.67, so a shared session id made
 *      the second tool's filing BUMP the first tool's ticket and cache the
 *      wrong id under the second tool's week key. The seam also reports
 *      `deduped` (the 90-day exact-title pass returns the OLD open ticket for
 *      the same tool at the same N in a later week) — the wake then says
 *      "existing ticket, sighting recorded", never "filed" — and a deduped
 *      result whose title is NOT the requested one is treated as a NON-filing
 *      (nothing cached, the next sweep retries). The week key is per (tool,
 *      week), NOT per owner: infra is single-tenant, so a second admin's wake
 *      cites the ticket the first admin's sweep filed (one row per class).
 *
 * Delivery: a direct machine wake ([INFRA ALERT — …]) to every Fleet
 * Supervisor chat whose owner is an ADMIN (infra is single-tenant; project
 * supervisors never receive these). Deduped in Redis per (kind, subject,
 * severity) for INFRA_ALERT_DEDUPE_SEC. Telemetry: `infra_alert` rows.
 * Kill switch: INFRA_WATCH_DISABLED=1 (reporting AND sweep).
 *
 *   5. DECISION BACKEND DOWN (audit budgets-cost-6, 2026-09-26): the decision
 *      gate latched a backend on a 401/403 (revoked / exhausted key) or a run
 *      of asks lost every leg — `alertDecisionBackendDown` (called by
 *      platform/decision-gate.ts on the first latch of an episode / an
 *      all-failed streak) plus a sweep re-read of the `decision_gate_backend_down`
 *      rows under the SAME dedupe key. Playbook: the 'boxes' view's decisionGate
 *      tile + the Model roles Test button; verify = a 'recovered' event.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
// Supervisor OFF switch (owner 2026-09-26): alert wakes are skipped while the
// Fleet Supervisor is off — before the dedupe key, so a still-true alert fires
// once the switch is back on.
import { getFleetSupervisorEnabled, recordSupervisorSwitchSkip } from '../platform/supervisor-switch';
// Ticket 4d476b9a: the stall-vs-egress verdict decide() stamps on all_legs_failed rows (pure leaf, perf_hooks only).
import { allFailedCauseText, isStallExemptAllFailedRow, type AllFailedCause } from '../platform/decision-gate-stall';
// The ONE DEPLOY_SHA rule (leaf: os only) — `deploySha()` below delegates here so
// a metric row's `proc` tag and fleet build attribution cannot disagree (c0c0c52a).
import { shortDeploySha } from '../platform/process-tag';

const SOURCE = 'infra-watch';
export const INFRA_WATCH_DISABLED_ENV = 'INFRA_WATCH_DISABLED';
export const BOX_HEALTH_INTERVAL_MS = 15 * 60 * 1000;
export const BOX_HEALTH_STALE_MS = 45 * 60 * 1000;
export const DISK_WARN_PCT = 85;
export const DISK_CRIT_PCT = 92;
export const DEPLOY_LOOKBACK_MS = 30 * 60 * 1000;
export const DEPLOY_WORKFLOW_FILE = 'deploy.yml';
export const CI_WORKFLOW_FILE = 'ci.yml';
// Instance isolation boundary (ticket c75b5f34): the framework repo this
// instance watches deploys for, resolved from ITS OWN environment —
// production keeps the historical default; a non-prod instance reads
// INFRA_WATCH_REPO ONLY. Unset on non-prod ⇒ '' (nothing to watch — the
// fetchers short-circuit to "no facts", never a silent production read).
// Configured to the PRODUCTION repo on a non-prod instance ⇒ this THROWS at
// module load (a boot hard-fail with the operator's exact fix: point
// INFRA_WATCH_REPO at the instance's own repo) — never a silent fallback.
import { resolveInstanceRepoTarget, IsolationBoundaryError } from '../platform/instance-targets';
export const DEPLOY_REPO = deployRepoSlug();
function deployRepoSlug(): string {
  const r = resolveInstanceRepoTarget(process.env, 'INFRA_WATCH_REPO');
  if (r.ok) return r.slug;
  if (!String(process.env.INFRA_WATCH_REPO ?? '').trim()) return '';
  throw new IsolationBoundaryError(r.refusal);
}
export const CARD_COST_DAILY_THRESHOLD = 3;
/** WI-Q: cards/day from ONE tool that file a card-class ticket (default 3; INFRA_WATCH_CARD_TICKET_MIN_PER_TOOL). */
export const CARD_TICKET_MIN_PER_TOOL = 3;
export const INFRA_ALERT_DEDUPE_SEC = 6 * 3600;
/** abd733af (review finding 3): per-target dedupe on enqueue-failure EVIDENCE —
 *  a permanently failing target (hard-deleted supervisor chat, wedged outbox)
 *  wrote one enqueue_failed loop_metrics row + one warn per target PER SWEEP
 *  (~96/day/standing target — pure noise once the first row proved it). While
 *  this key holds, deliver() still ATTEMPTS the wake (the 6d19f11f contract —
 *  a failed enqueue is retried every sweep, never silenced) but writes no
 *  second row/warn for it: the telemetry rate is ≤1 row/hour/target, which is
 *  the durable-evidence rate operators asked for. A delivered wake clears the
 *  key, so a recovered target's next failure is fully evidenced again. */
export const ENQUEUE_FAIL_ROW_DEDUPE_SEC = 3600;
const ENQUEUE_FAIL_ROW_KEY = (chatId: string) => `infra-watch:enqueue-fail-row:${chatId}`;
const ALERT_KEY = (kind: string, subject: string, severity: string) => `infra-watch:alert:${kind}:${subject}:${severity}`;
const DEPLOY_SEEN_KEY = (runId: string | number) => `infra-watch:deployfail:${runId}`;
const CARD_DIGEST_KEY = (userId: string, day: string) => `infra-watch:cards:${userId}:${day}`;
/** one ticket per (tool, ISO week) — the value is the ticket id so later days' wakes can cite it */
const CARD_TICKET_KEY = (tool: string, week: string) => `infra-watch:card-ticket:${tool}:${week}`;
const CARD_TICKET_TTL_SEC = 8 * 24 * 3600;

// ── DEPLOY-WATCH-BLIND (2026-10-20) ──────────────────────────────────────────
/** A read-only GitHub token (Actions:read on DEPLOY_REPO) the sweep prefers over
 *  any owner's connected account — a SECRET, not a switch (forwarded in compose
 *  as ${INFRA_WATCH_GITHUB_TOKEN:-}). Unset ⇒ the admin owners' tokens. */
export const INFRA_WATCH_GITHUB_TOKEN_ENV = 'INFRA_WATCH_GITHUB_TOKEN';
/** Kill switch: '1' drops the blind telemetry row, the consecutive-blind counter
 *  and the alarm (the deploy section is silent when blind again, as before).
 *  Token iteration + the status-carrying fetch stay on — they only ever find a
 *  token the old single read would have missed. */
export const INFRA_WATCH_BLIND_ALARM_DISABLED_ENV = 'INFRA_WATCH_BLIND_ALARM_DISABLED';
/** Consecutive blind sweeps before the ONE [INFRA ALERT — deploy watch blind] wake (sweeps run ≤ 15 min apart ⇒ ≥ 30 min blind). */
export const DEPLOY_WATCH_BLIND_ALARM_AFTER = 3;
/** The alarm's dedupe window — one wake per 24 h however long the watch stays blind. */
export const DEPLOY_WATCH_BLIND_ALERT_TTL_SEC = 24 * 3600;
/** The consecutive-blind state ({n, since, reason}); a seeing sweep deletes it. 26 h so a stalled watchdog keeps `since` honest across a gap. */
const DEPLOY_WATCH_BLIND_KEY = 'infra-watch:deploy-watch-blind';
const DEPLOY_WATCH_BLIND_TTL_SEC = 26 * 3600;

export function infraWatchBlindAlarmDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INFRA_WATCH_BLIND_ALARM_DISABLED_ENV] === '1';
}

export function infraWatchDisabled(): boolean {
  return process.env[INFRA_WATCH_DISABLED_ENV] === '1';
}
export function cardTicketMinPerTool(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.INFRA_WATCH_CARD_TICKET_MIN_PER_TOOL);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : CARD_TICKET_MIN_PER_TOOL;
}

/** ISO-8601 week key, e.g. 2026-W39 — the ticket dedup bucket (Monday-anchored, UTC). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;             // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day);     // Thursday of this ISO week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── 1. Box health ─────────────────────────────────────────────────────────────

export interface BoxHealth {
  host: string;
  diskPct: number;
  diskFreeGb: number;
  memFreePct: number;
  load1: number;
  process: 'worker' | 'web';
  /** short sha the process was built from (DEPLOY_SHA passthrough, 2026-09-18) — absent on older containers */
  sha?: string;
  /** Ticket 5fba7188 (review N3): TRUE when this row was written by a SUPERSEDED
   *  worker colour finishing its already-claimed runs. Without it `sha` is the
   *  other field a lane reads as "the fix is not live" — and a drainer's sha is
   *  a pre-fix build BY DESIGN, so its absence of new fields proves nothing. */
  draining?: boolean;
  /** process uptime in minutes — a fresh restart on every wave is normal; a wave with NO restart is the tell */
  upMin: number;
  /** nightly pg_dump state as seen through the read-only /backups mount (box A
   *  owns /opt/crossmodel-backups; other boxes mount an empty dir) — absent
   *  when the mount is missing (pre-2026-09-18 containers) */
  backup?: BackupState;
}

export interface BackupState { count: number; ageH: number | null; newestAt?: string; status?: 'ok' | 'failed'; statusAt?: string; statusError?: string }

export const BACKUP_DIR_ENV = 'BACKUP_DIR';
export const BACKUP_DIR_DEFAULT = '/backups';
/** nightly at 08:30Z + a generous slack: one missed night is the alert, not a slow dump */
export const BACKUP_STALE_H = 30;
/** Backup-status marker file (FO firing 21, 2026-09-25): digby-backup.sh writes
 * backup-status.json next to the dumps on EVERY terminal outcome (ok/failed).
 * A 'failed' marker means the latest nightly attempt DIED (e.g. the 2026-09-25
 * 08:31Z run: the sandbox egress guard rejected the default-bridge pg_dump
 * container's traffic to RDS) — that must alert IMMEDIATELY, not 30 h later
 * when the newest dump ages past BACKUP_STALE_H with no reason attached. */
export const BACKUP_STATUS_FILE = 'backup-status.json';
/** The backup-OWNER role: the ONLY hosts whose dump readings may name a
 *  stale/missing alert. box-a owns digby-backup.timer (docs/BACKUPS.md —
 *  "nightly pg_dump timer + role wiring live on A only"); box-b's timer is
 *  disabled-by-design and its leftover dumps are by-design artifacts (ticket
 *  cc1ca2bf), so a non-producer can never name an alert. Move the role with
 *  BACKUP_PRODUCER_HOSTS=host1,host2 when ownership changes. */
export const BACKUP_PRODUCER_HOSTS_ENV = 'BACKUP_PRODUCER_HOSTS';
export const BACKUP_PRODUCER_HOSTS_DEFAULT = ['box-a'];
export function backupProducerHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = String(env[BACKUP_PRODUCER_HOSTS_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [...BACKUP_PRODUCER_HOSTS_DEFAULT];
}
const DUMP_RE = /^admin_db-.*\.dump$/;

/** Parse the backup-status.json marker digby-backup.sh writes next to the dumps.
 * Returns null when absent/unreadable/malformed (a pre-2026-09-25 script or a
 * transient write — the age rule still covers that box; never throw). */
export function parseBackupStatus(raw: string): Pick<BackupState, 'status' | 'statusAt' | 'statusError'> | null {
  try {
    const j = JSON.parse(raw) as { status?: unknown; at?: unknown; error?: unknown };
    if (j.status !== 'ok' && j.status !== 'failed') return null;
    return { status: j.status, ...(typeof j.at === 'string' && j.at ? { statusAt: j.at } : {}), ...(typeof j.error === 'string' && j.error ? { statusError: j.error.slice(0, 200) } : {}) };
  } catch { return null; }
}

/** Newest `admin_db-*.dump` under the mount. undefined = not mounted / unreadable (say nothing). */
export async function readBackupState(dir: string = process.env[BACKUP_DIR_ENV] || BACKUP_DIR_DEFAULT, now: Date = new Date()): Promise<BackupState | undefined> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return undefined; }
  const dumps = names.filter((n) => DUMP_RE.test(n));
  const statusRaw = await fs.readFile(`${dir}/${BACKUP_STATUS_FILE}`, 'utf8').then((s) => s).catch(() => null);
  const status = statusRaw !== null ? parseBackupStatus(statusRaw) : null;
  if (!dumps.length) return { count: 0, ageH: null, ...(status ?? {}) };
  let newest = 0;
  for (const n of dumps) {
    try { newest = Math.max(newest, (await fs.stat(`${dir}/${n}`)).mtimeMs); } catch { /* a vanishing file mid-rotation is fine */ }
  }
  if (!newest) return { count: dumps.length, ageH: null, ...(status ?? {}) };
  return { count: dumps.length, ageH: Math.round(((now.getTime() - newest) / 3_600_000) * 10) / 10, newestAt: new Date(newest).toISOString(), ...(status ?? {}) };
}

/** Stable box label: BOX_NAME from the box's env overrides, else the container hostname. */
export function boxLabel(env: NodeJS.ProcessEnv = process.env, hostname: string = os.hostname()): string {
  const v = String(env.BOX_NAME || '').trim();
  return v || hostname.slice(0, 12);
}

/** A 12-hex container id — the label a process falls back to when BOX_NAME is unset; replaced on every deploy. */
export function isEphemeralHostLabel(host: string): boolean {
  return /^[0-9a-f]{12}$/i.test(String(host || ''));
}

/**
 * Short deploy sha from DEPLOY_SHA (deploy.yml writes .deploy-sha; compose passes it through).
 *
 * Delegates to platform/process-tag `shortDeploySha` — the ONE rule. A metric
 * row's `proc` tag and the fleet's build attribution must agree on what counts
 * as a sha (a compose `DEPLOY_SHA=dev` default is not one), and two copies of
 * this regex is exactly how such a disagreement starts (todo c0c0c52a).
 */
export function deploySha(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return shortDeploySha(env);
}

// ── Which BUILD answered this call (ticket 5fba7188) ─────────────────────────
// The worker blue-green handoff is deliberately ZERO-GAP: the new colour boots
// and goes healthy, then the old one gets SIGTERM and stops claiming — but it
// KEEPS EXECUTING the runs it already claimed, in place, for up to
// WORKER_DRAIN_MAX_MS (6 h), writing the /tmp/worker-draining marker while it
// does. That is the owner-mandated design (2026-09-24: deploys used to
// docker-stop the old worker after 45 s and interrupt every running run).
//
// The consequence is the one nothing guarded: a run still executing on the
// RETIRING colour answers its tool calls with the OLD build. Its code cannot
// have the newest fields, so a read that is merely STALE is indistinguishable
// from a read that PROVES the fix is absent — and a lane that correctly
// merged, deployed and verified green gets told by its own tools that its
// change is not there (the phantom-claim pressure the evidence rules exist to
// remove). Reconciling the colours away is NOT an option: interrupting the
// drainer is the run-loss class the drain exists to prevent.
//
// So the read makes itself FALSIFIABLE instead: every answer names the build
// that produced it (DEPLOY_SHA), the tier, and whether that process is a
// superseded drainer. A reader can then tell "this build genuinely lacks the
// field" from "a stale build answered you" — the class ticket 9c0caf1c fixed
// for `sha` and ticket 533087b7 fixed for `backup`.
/** The drain marker a retiring worker writes. ONE definition: worker.ts imports
 *  this, so the deploy script (which probes the same file) and the reporter can
 *  never disagree about the name. */
export const WORKER_DRAIN_FILE_DEFAULT = '/tmp/worker-draining';
export function workerDrainFile(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.WORKER_DRAIN_FILE || '').trim() || WORKER_DRAIN_FILE_DEFAULT;
}

export type ServingProcess = 'worker' | 'web' | 'unknown';

export interface ServingBuild {
  /** short DEPLOY_SHA of the process that ANSWERED — null on a build older than
   *  the passthrough (it reports after its next rebuild, never as "main head"). */
  sha: string | null;
  /** the box label that answered (BOX_NAME, else the container hostname) */
  host: string;
  /** which tier answered: the worker (coding runs, the box-C colour) or the web backend */
  process: ServingProcess;
  /** TRUE when this process is a SUPERSEDED build finishing its already-claimed
   *  runs in place (the /tmp/worker-draining marker). Its code may predate main
   *  head, so a missing field here is NOT evidence the fix is absent. */
  draining: boolean;
  /** minutes the answering process has been up */
  upMin: number;
}

/** Which file tells us the answering tier? The two containers run the same image
 *  with a different command (dist/worker.js vs dist/server.js). */
export function servingProcessKind(argv1: string | undefined = process.argv[1]): ServingProcess {
  const base = String(argv1 || '').toLowerCase();
  if (base.includes('worker')) return 'worker';
  if (base.includes('server')) return 'web';
  return 'unknown';
}

/**
 * Identify the process answering the call. Pure except for the drain-marker
 * stat, which is why it takes every input as a seam. Cheap (one stat) and
 * never throws — an unreadable marker reads as "not draining" rather than
 * making the whole telemetry read fail.
 */
export function servingBuild(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1],
  uptimeSec: number = process.uptime(),
  exists: (p: string) => boolean = (p) => fsSync.existsSync(p),
): ServingBuild {
  let draining = false;
  try { draining = exists(workerDrainFile(env)); } catch { draining = false; }
  return {
    sha: deploySha(env) ?? null,
    host: boxLabel(env),
    process: servingProcessKind(argv1),
    // The marker is a WORKER-only concept; the web tier never drains, so a stray
    // file on a web box must not mislabel it.
    draining: draining && servingProcessKind(argv1) !== 'web',
    upMin: Math.round(uptimeSec / 60),
  };
}

/**
 * Measure this process's box. statfs('/') inside a container reports the
 * overlay's UPPER filesystem — the host root disk the deploy pre-flight
 * measures with `df /` — so the percentage matches what blocks a build.
 */
export async function collectBoxHealth(processKind: 'worker' | 'web', opts: { backupDir?: string; now?: Date } = {}): Promise<BoxHealth> {
  const st: any = await (fs as any).statfs('/');
  const backup = await readBackupState(opts.backupDir, opts.now);
  const total = Number(st.blocks) * Number(st.bsize);
  const free = Number(st.bavail) * Number(st.bsize);
  const used = total - Number(st.bfree) * Number(st.bsize);
  const diskPct = total > 0 ? Math.round((used / (used + free)) * 100) : 0;
  const memFreePct = os.totalmem() > 0 ? Math.round((os.freemem() / os.totalmem()) * 100) : 0;
  const sha = deploySha();
  // Best-effort: an unreadable marker reads as "not draining" rather than failing
  // the health row (the row is how a wedged box reports itself).
  let draining = false;
  try { draining = fsSync.existsSync(workerDrainFile()) && processKind === 'worker'; } catch { draining = false; }
  return {
    host: boxLabel(),
    diskPct,
    diskFreeGb: Math.round((free / 1e9) * 10) / 10,
    memFreePct,
    load1: Math.round(os.loadavg()[0] * 100) / 100,
    process: processKind,
    ...(sha ? { sha } : {}),
    upMin: Math.round(process.uptime() / 60),
    // Ticket 5fba7188: a drainer's box_health row must SAY it is a drainer, or the
    // row repeats in the deploy view exactly the unfalsifiable `sha` the ticket was
    // filed about (533087b7 fixed the same shape for `backup`).
    ...(draining ? { draining: true } : {}),
    ...(backup ? { backup } : {}),
  };
}

/** One `box_health` metric row for this process's box. Never throws. */
export async function recordBoxHealth(processKind: 'worker' | 'web'): Promise<BoxHealth | null> {
  if (infraWatchDisabled()) return null;
  try {
    const h = await collectBoxHealth(processKind);
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.BOX_HEALTH, value: h.diskPct, unit: 'pct', meta: { ...h } });
    return h;
  } catch (err: any) {
    logger.warn(`${SOURCE}: box health collection failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    return null;
  }
}

/** Start the web-process reporter (server.ts). Returns a stop function. */
export function startBoxHealthReporter(processKind: 'worker' | 'web', intervalMs: number = BOX_HEALTH_INTERVAL_MS): () => void {
  if (infraWatchDisabled()) return () => {};
  void recordBoxHealth(processKind);
  const timer = setInterval(() => { void recordBoxHealth(processKind); }, intervalMs);
  (timer as any).unref?.();
  return () => clearInterval(timer);
}

export type BoxSeverity = 'critical' | 'warning' | 'silent';
export interface BoxAlert { kind: 'disk' | 'silent'; host: string; severity: BoxSeverity; diskPct?: number; diskFreeGb?: number; lastSeenAt?: Date }

/** Pure: classify the newest row per box (and boxes seen in 24 h but not lately). */
export function classifyBoxHealth(
  latest: Array<{ host: string; diskPct: number; diskFreeGb: number; at: Date }>,
  now: Date,
  staleMs: number = BOX_HEALTH_STALE_MS,
): BoxAlert[] {
  const out: BoxAlert[] = [];
  for (const row of latest) {
    if (now.getTime() - row.at.getTime() > staleMs) {
      // A container-id label (no BOX_NAME) is EPHEMERAL: every deploy replaces
      // the container, so its rows simply stop — that is a retirement, not a
      // silent box (2026-09-18 19:26Z: two false "silent box" wakes for the
      // pre-BOX_NAME ids of box A's blue stack, minutes after the fix that
      // named the boxes deployed). Silence is only meaningful for a NAMED box.
      if (!isEphemeralHostLabel(row.host)) out.push({ kind: 'silent', host: row.host, severity: 'silent', lastSeenAt: row.at });
      continue;
    }
    if (row.diskPct >= DISK_CRIT_PCT) out.push({ kind: 'disk', host: row.host, severity: 'critical', diskPct: row.diskPct, diskFreeGb: row.diskFreeGb });
    else if (row.diskPct >= DISK_WARN_PCT) out.push({ kind: 'disk', host: row.host, severity: 'warning', diskPct: row.diskPct, diskFreeGb: row.diskFreeGb });
  }
  return out;
}

export interface BoxHealthRow { host: string; process: string; sha?: string; diskPct: number; diskFreeGb: number; memFreePct: number; load1: number; upMin?: number; backup?: BackupState; at: Date }

/**
 * Ticket 9c0caf1c — how long a sha must have been CONTINUOUSLY reported before a
 * single telemetry read may call it settled. Sized above the box_health reporter
 * cadence (BOX_HEALTH_INTERVAL_MS = 15 min) and above the ~27 min deploy lag, so
 * a read taken during or just after a wave cannot present a transient sha as the
 * box's state. Not an env switch on purpose: an evidence threshold must not
 * retreat under pressure (the "widen the gate" failure mode).
 */
export const BOX_SHA_FLAP_WINDOW_MS = 30 * 60 * 1000;

/**
 * Ticket 9c0caf1c — the sha history of ONE box surface, derived from the
 * box_health rows of a single read. `sha` alone is unfalsifiable (a supervisor
 * published and then retracted a "box-a flipped to <sha>" claim during a
 * coalesced wave because one read looked as authoritative as ten); these fields
 * say whether that sha is a settled state or a transient mid-wave reading.
 */
export interface BoxShaTransition {
  /** 8-char sha on the surface's NEWEST row, or null when the process reports none. */
  sha: string | null;
  /** ISO time of the OLDEST row in the contiguous run carrying `sha` — the earliest evidence for it (the real change lies between the previous sha's last row and this instant). */
  shaSince: string | null;
  /** ISO time of the NEWEST row carrying `sha` — the read's freshness input: a sha whose newest row is older than BOX_HEALTH_STALE_MS says nothing about what serves NOW. */
  newestAt: string | null;
  /** Minutes between shaSince and now; null without a sha. */
  shaAgeMin: number | null;
  /** Contiguous rows carrying the current sha — 1 means a SINGLE read, no corroboration. */
  shaRows: number;
  /** The sha reported immediately before the current one, or null. */
  previousSha: string | null;
  /** ISO time of the newest row that carried previousSha (the other half of the change window). */
  previousShaAt: string | null;
  /** Distinct sha runs whose newest row lands inside the trailing flap window (1 = no change inside it). */
  shaChanges: number;
  /** 'settled' | 'flapping' | 'unconfirmed' | 'stale' | 'unknown' — see classifyBoxSha. */
  state: BoxShaState;
}

/** 'settled' = one corroborated sha older than the flap window, reported within the freshness threshold; 'flapping' = the sha changed inside the window; 'unconfirmed' = a single row, no second reading; 'stale' = the newest row is too old to say what serves now; 'unknown' = no sha reported. */
export type BoxShaState = 'settled' | 'flapping' | 'unconfirmed' | 'stale' | 'unknown';

/**
 * Classify one surface's sha history (pure). Deliberately conservative: only
 * 'settled' is citable as settled serving state, and the order of the checks is
 * the point — each label names the STRONGEST thing the rows actually prove.
 *   unknown     — the process reports no sha (older than the DEPLOY_SHA passthrough).
 *   flapping    — more than one sha run intersects the flap window: the box was
 *                 seen on two different shas inside it, so this read may be
 *                 catching it mid-flip.
 *   unconfirmed — only ONE row carries the sha: nothing corroborates it, and a
 *                 single reading cannot distinguish a landing from a flap. This
 *                 is checked BEFORE the window test so a lone fresh row is never
 *                 mislabelled a flap it did not prove.
 *   settled     — ≥2 contiguous rows carry the sha and it began before the window.
 */
export function classifyBoxSha(t: Pick<BoxShaTransition, 'sha' | 'shaSince' | 'newestAt' | 'shaRows' | 'shaChanges'>, now: Date, flapWindowMs: number = BOX_SHA_FLAP_WINDOW_MS): BoxShaState {
  if (!t.sha) return 'unknown';
  // Reviewer finding 3: a read whose NEWEST row is older than the freshness
  // threshold says what the box RAN, not what it serves now — a box silent for
  // hours can look perfectly settled on a 20 h-old sha otherwise.
  const newestMs = t.newestAt ? Date.parse(t.newestAt) : NaN;
  if (Number.isFinite(newestMs) && now.getTime() - newestMs > BOX_HEALTH_STALE_MS) return 'stale';
  if (t.shaChanges > 1) return 'flapping';
  if (t.shaRows < 2) return 'unconfirmed';
  const sinceMs = t.shaSince ? Date.parse(t.shaSince) : NaN;
  const insideWindow = Number.isFinite(sinceMs) && now.getTime() - sinceMs < flapWindowMs;
  return insideWindow ? 'flapping' : 'settled';
}

/**
 * Per-surface sha transitions from the RAW box_health rows (newest first), for
 * the surfaces the caller asks about. Pure — the caller supplies the key
 * function so `latestBoxHealthRows` and the per-process telemetry views agree.
 */
export function boxShaTransitions(
  rows: Array<{ at: Date; host: string; process: string; sha: string | null }>,
  now: Date,
  flapWindowMs: number = BOX_SHA_FLAP_WINDOW_MS,
): Map<string, BoxShaTransition> {
  const windowStart = now.getTime() - flapWindowMs;
  // Per surface, walk the rows newest→oldest and split them into contiguous
  // runs of an equal sha. A box that flipped A→B→A is three runs, which is what
  // makes a flap visible at all; a plain "distinct shas" set would lose it.
  const runsBySurface = new Map<string, Array<{ sha: string | null; rows: number; newestAt: Date; oldestAt: Date }>>();
  for (const r of rows) {
    const key = `${r.host}/${r.process}`;
    const list = runsBySurface.get(key) ?? [];
    const head = list[list.length - 1];
    if (head && head.sha === r.sha) {
      head.rows += 1;
      head.oldestAt = r.at; // rows arrive newest first, so each older row moves the bound back
    } else {
      list.push({ sha: r.sha, rows: 1, newestAt: r.at, oldestAt: r.at });
    }
    runsBySurface.set(key, list);
  }
  const out = new Map<string, BoxShaTransition>();
  for (const [key, runs] of runsBySurface) {
    const current = runs[0];
    const previous = runs[1] ?? null;
    const shaChanges = runs.filter((run) => run.newestAt.getTime() >= windowStart).length;
    const t = {
      sha: current.sha,
      shaSince: current.sha ? current.oldestAt.toISOString() : null,
      newestAt: current.sha ? current.newestAt.toISOString() : null,
      shaAgeMin: current.sha ? Math.max(0, Math.round((now.getTime() - current.oldestAt.getTime()) / 60000)) : null,
      shaRows: current.rows,
      previousSha: previous?.sha ?? null,
      previousShaAt: previous ? previous.newestAt.toISOString() : null,
      shaChanges,
      state: 'unknown' as BoxShaState,
    };
    t.state = classifyBoxSha(t, now, flapWindowMs);
    out.set(key, t);
  }
  return out;
}

/**
 * The box_health rows of the last 24 h, newest first — ONE read shared by the
 * dedupe (latestBoxHealthRows) and the sha history (boxShaTransitions), so a
 * stability verdict never costs a second query.
 */
async function fetchBoxHealthRawRows(now: Date): Promise<Array<{ createdAt: Date; meta: any }>> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  return (await prisma.loopMetric.findMany({
    where: { kind: LOOP_METRIC_KINDS.BOX_HEALTH, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, meta: true },
    take: 400,
  })) as Array<{ createdAt: Date; meta: any }>;
}

/**
 * Latest box_health row per HOST (24 h window, newest wins) — the sweep's
 * disk/silence classification reads diskPct/diskFreeGb/at; the
 * get_fleet_telemetry views read the whole row (process, sha, memory, load).
 */
export async function latestBoxHealthRows(now: Date, opts: { perProcess?: boolean } = {}): Promise<BoxHealthRow[]> {
  return (await latestBoxHealthRowsWithHistory(now, opts)).rows;
}

/**
 * The latest row per surface PLUS that surface's sha history from the SAME
 * read (ticket 9c0caf1c) — the read that lets `get_fleet_telemetry` say
 * "settled since 18:32Z, 3 rows" instead of handing a bare sha to a consumer
 * that has no way to tell a landing from a mid-wave flap.
 */
export async function latestBoxHealthRowsWithHistory(
  now: Date,
  opts: { perProcess?: boolean; flapWindowMs?: number } = {},
): Promise<{ rows: BoxHealthRow[]; shaHistory: Map<string, BoxShaTransition> }> {
  const rows = await fetchBoxHealthRawRows(now);
  // Keyed per HOST for the disk/silence/backup classification (one alert per
  // box); per host+process for the telemetry views — box A runs a web backend
  // AND a cron-only worker, and "does the worker run main head?" is a
  // different question from "does the web backend?" (perProcess: true).
  const byHost = new Map<string, BoxHealthRow>();
  for (const r of rows) {
    const host = String(r.meta?.host ?? '');
    const key = opts.perProcess ? `${host}/${String(r.meta?.process ?? '')}` : host;
    if (!host || byHost.has(key)) continue;
    const sha = typeof r.meta?.sha === 'string' && r.meta.sha ? String(r.meta.sha).slice(0, 8) : undefined;
    byHost.set(key, {
      host,
      process: String(r.meta?.process ?? ''),
      ...(sha ? { sha } : {}),
      diskPct: Number(r.meta?.diskPct ?? 0),
      diskFreeGb: Number(r.meta?.diskFreeGb ?? 0),
      memFreePct: Number(r.meta?.memFreePct ?? 0),
      load1: Number(r.meta?.load1 ?? 0),
      ...(Number.isFinite(Number(r.meta?.upMin)) ? { upMin: Number(r.meta.upMin) } : {}),
      ...(r.meta?.backup && typeof r.meta.backup === 'object'
        ? { backup: { count: Number(r.meta.backup.count ?? 0), ageH: r.meta.backup.ageH == null ? null : Number(r.meta.backup.ageH), ...(r.meta.backup.newestAt ? { newestAt: String(r.meta.backup.newestAt) } : {}), ...(r.meta.backup.status === 'ok' || r.meta.backup.status === 'failed' ? { status: r.meta.backup.status } : {}), ...(typeof r.meta.backup.statusAt === 'string' && r.meta.backup.statusAt ? { statusAt: r.meta.backup.statusAt } : {}), ...(typeof r.meta.backup.statusError === 'string' && r.meta.backup.statusError ? { statusError: r.meta.backup.statusError } : {}) } }
        : {}),
      at: r.createdAt,
    });
  }
  // The sha history rides the SAME rows: `sha` alone cannot say whether it is a
  // landing or a mid-wave reading, which is exactly what ticket 9c0caf1c is
  // about. Keyed `host/process` always (the telemetry views read perProcess).
  const shaHistory = boxShaTransitions(
    rows
      .filter((r) => String(r.meta?.host ?? ''))
      .map((r) => ({
        at: r.createdAt,
        host: String(r.meta?.host ?? ''),
        process: String(r.meta?.process ?? ''),
        sha: typeof r.meta?.sha === 'string' && r.meta.sha ? String(r.meta.sha).slice(0, 8) : null,
      })),
    now,
    opts.flapWindowMs,
  );
  return { rows: [...byHost.values()], shaHistory };
}

// ── 1b. Backup age ────────────────────────────────────────────────────────────

export interface BackupAlert { kind: 'backup'; severity: 'stale' | 'missing' | 'lapse' | 'failed'; host?: string; ageH?: number; newestAt?: string; statusError?: string }

/**
 * Newest box_health row from a backup-PRODUCER host that CARRIES a backup reading
 * (24 h window) — null = the producer has not reported backups all window: a >24 h
 * lapse (the pre-4f6cb3610 class: the box recreated without the /backups mount),
 * which classifyBackupAge degrades to a WARN-grade 'lapse' alert instead of staying
 * permanently silent (todo 7e57d253, goal b3f240e4). A separate small query on
 * purpose: latestBoxHealthRows dedupes newest-per-host, so a transient mid-deploy
 * row WITHOUT backup would hide the older reading that proves the lapse transient.
 */
export async function producerBackupLastSeenAt(now: Date, producerHosts: string[] = backupProducerHosts()): Promise<Date | null> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const rows = (await prisma.loopMetric.findMany({
    where: { kind: LOOP_METRIC_KINDS.BOX_HEALTH, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, meta: true },
    take: 400,
  })) as Array<{ createdAt: Date; meta: any }>;
  for (const r of rows) {
    if (!producerHosts.includes(String(r.meta?.host ?? ''))) continue;
    if (r.meta?.backup && typeof r.meta.backup === 'object') return r.createdAt;
  }
  return null;
}

/**
 * Fleet-level rule over the latest rows: only rows that SEE the mount count
 * (older containers say nothing), and only the backup PRODUCER's readings
 * decide — the freshest dump on a producer host is the fleet's backup age.
 * No dump on any mounted producer ⇒ missing; freshest older than
 * BACKUP_STALE_H ⇒ stale (the 2026-09-17 night: the timer's run was killed
 * by the disk guard during builds and nothing noticed until a human looked).
 * Non-producer hosts (box-b's disabled timer + leftover dumps — ticket
 * cc1ca2bf) can never name an alert; and when NO producer row reports in the
 * window (a reporting lapse, e.g. box-a's container restarting mid-deploy)
 * while non-producer leftovers still report, the honest reading is "unknown",
 * not "stale" — downgrade to silence (the 2026-09-19 23:06Z re-fire). This is
 * NOT deploy-wave suppression: a genuinely stale producer reading still
 * alerts mid-wave. The silence is TIME-BOUNDED (todo 7e57d253): with no
 * producer backup reading anywhere in the window (producerBackupLastSeen
 * === null) and fresh producer heartbeats, the classification degrades to a
 * WARN-grade 'lapse' alert naming the producer — a DEAD producer box stays
 * classifyBoxHealth's silent-box alert, and a transient mid-deploy lapse
 * (producerBackupLastSeen a Date) stays silent.
 */
export function classifyBackupAge(rows: BoxHealthRow[], now: Date, staleH: number = BACKUP_STALE_H, producerHosts: string[] = backupProducerHosts(), producerBackupLastSeen: Date | null | undefined = undefined): BackupAlert | null {
  const producers = rows.filter((r) => r.backup && producerHosts.includes(r.host));
  if (!producers.length) {
    if (producerBackupLastSeen === null) {
      // >24 h producer-lapse degrade: fresh heartbeats are the discriminator —
      // a dead box is the silent-box alert, never this one.
      const heartbeat = rows.filter((r) => producerHosts.includes(r.host)).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
      if (heartbeat && now.getTime() - heartbeat.at.getTime() <= BOX_HEALTH_STALE_MS) return { kind: 'backup', severity: 'lapse', host: heartbeat.host };
    }
    return null; // producer not reporting (transient lapse / unknown) — non-producer leftovers never decide
  }
  // FAILED-marker rule (FO firing 21, 2026-09-25): a producer whose latest
  // backup-status.json says 'failed' alerts IMMEDIATELY — the 2026-09-25
  // 08:31Z nightly died on the egress-guarded default bridge and was silent
  // for 6.5 h because only dump AGE was classified. The marker is freshest
  // evidence: a later 'ok' (the retry succeeded) or a newer dump after it
  // means the newest DUMP outranks an old failed marker — only a failed
  // marker NOT superseded by a newer dump alerts.
  const failed = producers
    .filter((r) => r.backup!.status === 'failed')
    .filter((r) => !(r.backup!.newestAt && r.backup!.statusAt && Date.parse(r.backup!.newestAt) > Date.parse(r.backup!.statusAt)))
    .sort((a, b) => a.host.localeCompare(b.host))[0];
  if (failed) return { kind: 'backup', severity: 'failed', host: failed.host, ageH: failed.backup!.ageH ?? undefined, newestAt: failed.backup!.newestAt, statusError: failed.backup!.statusError };
  const withDumps = producers.filter((r) => (r.backup!.count ?? 0) > 0 && r.backup!.ageH != null);
  if (!withDumps.length) return { kind: 'backup', severity: 'missing', host: producers.map((r) => r.host).sort()[0] };
  const freshest = withDumps.reduce((a, b) => (a.backup!.ageH! <= b.backup!.ageH! ? a : b));
  if (freshest.backup!.ageH! > staleH) return { kind: 'backup', severity: 'stale', host: freshest.host, ageH: freshest.backup!.ageH!, newestAt: freshest.backup!.newestAt };
  return null;
}

export function renderBackupAlert(a: BackupAlert, now: Date): string {
  // Alerts are raised only off the producer's readings, so the playbook +
  // verify line name the PRODUCER — a non-producer leftover host is never the
  // verify target (the 2026-09-19 23:06Z dispatch chased 'box-b backup.ageH').
  const producer = a.host ?? backupProducerHosts()[0] ?? 'box-a';
  if (a.severity === 'failed') {
    // FO firing 21 (2026-09-25): the nightly RUN failed (backup-status.json
    // marker), not merely aged — the known cause chain is in the script's
    // NETWORKING note (egress-guarded default bridge → RDS refused) plus the
    // disk guard and a dead RDS. This is the IMMEDIATE companion to the 30 h
    // stale rule: a failed 08:30Z run surfaces on the NEXT sweep, not next day.
    return `[INFRA ALERT — backup FAILED] the latest nightly backup attempt on ${producer} FAILED at ${a.statusError ? `${a.newestAt ?? 'unknown time'} (${a.statusError})` : a.newestAt ?? 'unknown time'} (seen ${hhmmz(now)}) — backup-status.json on the /backups mount says status:"failed", so the 08:30Z digby-backup run produced no dump. Without it a bad migration or a deleted table is unrecoverable past the last S3 copy. Playbook: dispatch_platform_task "Nightly backup FAILED on ${producer}" — the lane reads journalctl -u digby-backup.service --since -1d on the prod box (known causes: the dump container's network path to RDS — the sandbox egress guard rejects the default bridge, the fixed script uses --network host; the disk guard aborting under 2 GB free; a transient RDS refusal), fixes the cause, re-runs sudo systemctl start digby-backup.service, and confirms a fresh admin_db-*.dump under /opt/crossmodel-backups AND backup-status.json flipping to status:"ok". Verify: get_fleet_telemetry view 'boxes' shows ${producer} backup.ageH under 24. Never delete dumps to make room — grow the volume instead (owner spend, one question).`;
  }
  if (a.severity === 'lapse') {
    return `[INFRA ALERT — backup producer not reporting] the backup producer ${producer} has not reported a backup reading in over 24 h while its box_health heartbeats continue normally (seen ${hhmmz(now)}) — the read-only /backups mount is missing or unreadable in its container (the pre-4f6cb3610 class: a box recreated without the mount). Backup alerting is blind while this lasts: a failed nightly dump would go unnoticed (the 2026-09-17 night). Playbook: dispatch_platform_task "Backup producer ${producer} not reporting backups" — the lane checks the /backups mount in the producer's containers (ls ${BACKUP_DIR_DEFAULT}; the mount wiring shipped in 4f6cb3610, docs/BACKUPS.md), restores it, and confirms box_health meta.backup reappears. Verify: get_fleet_telemetry view 'boxes' shows ${producer} backup.ageH under 24. A producer whose heartbeats STOP is classifyBoxHealth's silent-box alert instead — continuing heartbeats are what makes this a mount lapse.`;
  }
  const head = a.severity === 'missing'
    ? `[INFRA ALERT — backup missing] no nightly database dump is present on the backup producer ${producer} (seen ${hhmmz(now)}).`
    : `[INFRA ALERT — backup stale] the newest nightly database dump on ${a.host} is ${a.ageH} h old (${a.newestAt ?? 'unknown time'}; seen ${hhmmz(now)}) — the digby-backup.timer (08:30Z daily) did not produce a dump last night.`;
  return `${head} Without it a bad migration or a deleted table is unrecoverable past the last S3 copy. Playbook: dispatch_platform_task "Nightly backup ${a.severity} on ${producer}" — the lane runs an ec2-ops one-shot on the prod box (==ONE-SHOT-INSERT-POINT-PROD==) that reads systemctl status digby-backup.timer digby-backup.service and journalctl -u digby-backup.service --since -2d (the three known causes: the disk guard aborting under 2 GB free; the service timing out under the pre-437896fb unit budget — "Failed with result 'timeout'", fixed by TimeoutStartSec=7200 in deploy/digby-backup.service; and the service being killed by a deploy build — "Failed with result 'signal'"), fixes the cause, re-runs sudo systemctl start digby-backup.service, and confirms the new dump under /opt/crossmodel-backups AND its S3 copy (the digby-backup journal line "offsite copy uploaded" — the instance role has no s3:ListBucket, so aws s3 ls from the box fails by design). Verify: get_fleet_telemetry view 'boxes' shows ${producer} backup.ageH under 24. Never delete dumps to make room — grow the volume instead (owner spend, one question).`;
}

// ── 2. Deploy failures ────────────────────────────────────────────────────────

export interface DeployFailure { runId: number; sha: string; url: string; startedAt: string; title: string; /** The same-sha CI (ci.yml) run's verdict, when known: 'success' | 'failure' | 'in_progress' | null (no run found / fetch failed). A green CI on the same sha is the FLAKE signal — the deploy's Test gate re-runs the same suite and can roll the other way. */ ciVerdict?: 'success' | 'failure' | 'in_progress' | null }

/**
 * FO firing 102 (2026-10-08, 32nd f64 bake): the SUCCESSFUL deploy runs the
 * sweep has already stamped — the recovery signal for red-deploy alerts.
 * Pure mirror of selectDeployFailures: newest first, lookback-bounded.
 */
export function selectDeploySuccesses(runs: Array<any>, now: Date, lookbackMs: number = DEPLOY_LOOKBACK_MS): Array<{ runId: number; sha: string; at: string }> {
  const cut = now.getTime() - lookbackMs;
  return (runs || [])
    .filter((r) => r && r.conclusion === 'success' && new Date(r.updated_at ?? r.created_at).getTime() >= cut)
    .map((r) => ({ runId: Number(r.id), sha: String(r.head_sha ?? '').slice(0, 8), at: String(r.updated_at ?? r.created_at ?? '') }))
    .sort((a, b) => b.runId - a.runId);
}

/** Pure: the failed deploy runs inside the lookback window, newest first. */
export function selectDeployFailures(runs: Array<any>, now: Date, lookbackMs: number = DEPLOY_LOOKBACK_MS): DeployFailure[] {
  const cut = now.getTime() - lookbackMs;
  return (runs || [])
    .filter((r) => r && r.conclusion === 'failure' && new Date(r.updated_at ?? r.created_at).getTime() >= cut)
    .map((r) => ({ runId: Number(r.id), sha: String(r.head_sha ?? '').slice(0, 8), url: String(r.html_url ?? ''), startedAt: String(r.created_at ?? ''), title: String(r.display_title ?? r.name ?? '').slice(0, 120) }))
    .sort((a, b) => b.runId - a.runId);
}

/**
 * The same-sha CI (ci.yml) verdict for each failed deploy run — the flake
 * discriminator the deploy alert was missing (2026-09-27: CI 36304247052
 * FAILED on e1a458dd 07:50Z while Deploy 36304247203 SUCCEEDED on the same
 * sha; 57 min later Deploy 36306405841 FAILED on 966afd15 while CI
 * 36306405517 PASSED — the suite runs twice per main push, and the verdicts
 * diverge on flakes BOTH ways. A deploy-failed alert whose sha shows a green
 * CI run is a RE-RUN CANDIDATE, not a fix lane: the fired playbook cost a
 * full lane dispatch whose correct action was "push a no-op or re-run the
 * wave"). Pure: matching is on the 8-char sha prefix (DeployFailure carries
 * the 8-char slice of the Actions API's 40-char head_sha).
 */
export function attachCiVerdicts(failures: DeployFailure[], ciRuns: Array<any>): DeployFailure[] {
  // Key on the first 8 chars — DeployFailure carries the 8-char sha slice
  // (selectDeployFailures), while the Actions API returns the full 40-char
  // head_sha. 8 hex chars over a ~15-run window cannot collide.
  const bySha = new Map<string, { id: number; status?: string; conclusion?: string | null }>();
  for (const r of ciRuns || []) {
    const sha = String(r?.head_sha ?? '').slice(0, 8);
    if (sha.length < 8) continue;
    const id = Number(r.id);
    // highest run id wins — a re-run CI on the same sha supersedes the earlier
    // verdict, whatever order the API returned (it ships newest-first, but do
    // not lean on that). A non-numeric id loses to any numeric one.
    const prev = bySha.get(sha);
    const prevId = Number.isFinite(prev?.id) ? prev!.id : Number.NEGATIVE_INFINITY;
    if (!prev || (Number.isFinite(id) && id > prevId)) bySha.set(sha, { id, status: r.status, conclusion: r.conclusion });
  }
  return (failures || []).map((f) => {
    const match = bySha.get(f.sha);
    if (!match) return { ...f, ciVerdict: null };
    if (match.status !== 'completed') return { ...f, ciVerdict: 'in_progress' as const };
    return { ...f, ciVerdict: (match.conclusion === 'success' ? 'success' : 'failure') as 'success' | 'failure' };
  });
}

const GH_HEADERS = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'digby-infra-watch' });

/**
 * A GitHub 'owner/name' slug (ticket 51ff7e93) — the ONE validator shared by
 * clampTelemetryArgs and the exported repo-scoped fetchers. Charset is
 * URL-safe, but dots alone are not enough: `.`/`..`-leading segments and any
 * `..` are traversal, and a slug is interpolated RAW into the API URL, so a
 * `../etc`-shaped "slug" must be rejected here, not at GitHub's door.
 */
export function isGithubRepoSlug(s: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s)) return false;
  return !s.split('/').some((seg) => seg.includes('..') || seg.startsWith('.') || seg.endsWith('.lock') || seg.length > 100);
}

/**
 * One workflow-runs read WITH its HTTP status (DEPLOY-WATCH-BLIND, 2026-10-20).
 * `status` is the response's HTTP status (200 = the read happened) or null when
 * no response arrived (network error / the 10 s abort); `skipped: 'no_repo'` =
 * a non-prod instance with no INFRA_WATCH_REPO (isolation boundary c75b5f34) —
 * nothing to watch, never "blind". Never throws.
 *
 * Why the status rides along: prod recorded 0 deploy_wave_success rows over
 * 10-17..10-20 against 110 green + 10 red deploy.yml runs — the sweep's token
 * read came back null and the old [] returns made "cannot read" look exactly
 * like "no runs", with no signal anywhere. The sweep and the get_fleet_telemetry
 * deploy view read the status now and say "blind".
 */
export interface WorkflowRunsFetch { runs: any[]; status: number | null; skipped?: 'no_repo'; malformed?: boolean }

async function fetchWorkflowRunsWithStatus(file: string, token: string, perPage: number, status?: 'completed'): Promise<WorkflowRunsFetch> {
  // Isolation boundary (c75b5f34): a non-prod instance with no INFRA_WATCH_REPO
  // has no repo to watch — no fetch, "no facts" (never a production read).
  if (!DEPLOY_REPO) return { runs: [], status: null, skipped: 'no_repo' };
  const q = status ? `&status=${status}` : '';
  const url = `https://api.github.com/repos/${DEPLOY_REPO}/actions/workflows/${file}/runs?per_page=${perPage}${q}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { headers: GH_HEADERS(token), signal: ctrl.signal });
    if (!res.ok) return { runs: [], status: res.status };
    const body: any = await res.json().catch(() => null);
    // Ticket 9c0caf1c (reviewer finding 4): an HTTP 200 whose body carries no
    // workflow_runs array is NOT "zero runs" — it is an unreadable read (proxy
    // interstitial, truncated response). Marked malformed so the wave stamp
    // reads it as 'blind', never as "no wave in flight".
    return Array.isArray(body?.workflow_runs)
      ? { runs: body.workflow_runs, status: res.status }
      : { runs: [], status: res.status, malformed: true };
  } catch {
    return { runs: [], status: null };
  } finally { clearTimeout(t); }
}

/** The deploy workflow's runs WITH the read's HTTP status — see WorkflowRunsFetch. */
export async function fetchDeployRunsWithStatus(token: string, opts: { perPage?: number; status?: 'completed' } = { status: 'completed' }): Promise<WorkflowRunsFetch> {
  const perPage = Math.min(Math.max(Math.floor(Number(opts.perPage) || 8), 1), 20);
  return fetchWorkflowRunsWithStatus(DEPLOY_WORKFLOW_FILE, token, perPage, opts.status);
}

/** The CI workflow's runs WITH the read's HTTP status — see WorkflowRunsFetch. */
export async function fetchCiRunsWithStatus(token: string, opts: { perPage?: number; status?: 'completed' } = { status: 'completed' }): Promise<WorkflowRunsFetch> {
  const perPage = Math.min(Math.max(Math.floor(Number(opts.perPage) || 15), 1), 30);
  return fetchWorkflowRunsWithStatus(CI_WORKFLOW_FILE, token, perPage, opts.status);
}

/**
 * The deploy workflow's runs (newest first). The sweep reads completed runs
 * only (failure detection); the `get_fleet_telemetry` deploy view reads every
 * status so an in-flight wave is visible ("not live yet"). 10 s budget, [] on
 * any failure — callers treat an empty list as "no facts", never as "no runs";
 * a caller that must tell "cannot read" from "no runs" uses
 * fetchDeployRunsWithStatus.
 */
export async function fetchDeployRuns(token: string, opts: { perPage?: number; status?: 'completed' } = { status: 'completed' }): Promise<any[]> {
  return (await fetchDeployRunsWithStatus(token, opts)).runs;
}

/**
 * The CI workflow's runs on the framework repo (newest first) — the same-sha
 * verdict the deploy alert needs (below). Same shape/budget as fetchDeployRuns.
 */
export async function fetchCiRuns(token: string, opts: { perPage?: number; status?: 'completed' } = { status: 'completed' }): Promise<any[]> {
  return (await fetchCiRunsWithStatus(token, opts)).runs;
}

/** main's head commit — the sha every box should run after a successful wave. null on any failure. */
export async function fetchMainHead(token: string): Promise<{ sha: string; committedAt: string; title: string } | null> {
  // Isolation boundary (c75b5f34): see fetchDeployRuns.
  if (!DEPLOY_REPO) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.github.com/repos/${DEPLOY_REPO}/commits/main`, { headers: GH_HEADERS(token), signal: ctrl.signal });
    if (!res.ok) return null;
    const body: any = await res.json();
    if (!body?.sha) return null;
    return {
      sha: String(body.sha),
      committedAt: String(body?.commit?.committer?.date ?? body?.commit?.author?.date ?? ''),
      title: String(body?.commit?.message ?? '').split('\n')[0].slice(0, 90),
    };
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * REPO-SCOPED deploy verification (ticket 51ff7e93) — ANY repo the caller's
 * connected GitHub account can read, not just the framework repo. Reads the
 * repo-wide Actions runs (EVERY workflow — a project repo may deploy through
 * any workflow file; the framework's deploy.yml pin must not apply) plus the
 * ref's head commit. Unlike fetchDeployRuns (which returns [] on any failure
 * because the framework sweep treats "no facts" as safe), this returns a
 * DISCRIMINATED result: an unreadable repo (404 = missing OR no access —
 * GitHub never distinguishes, and neither do we) must surface as an ERROR so
 * a lane can never mistake "cannot read" for "no runs" — the exact weak
 * evidence this surface exists to replace.
 */
export type RepoRunsResult =
  | { ok: true; runs: any[] }
  | { ok: false; status: number | null; message: string };

export async function fetchRepoActionRuns(
  token: string,
  repo: string,
  opts: { perPage?: number; ref?: string } = {},
): Promise<RepoRunsResult> {
  // Self-defending: the slug is validated at clampTelemetryArgs, but this is
  // exported — a future caller must not be able to smuggle a path/query here.
  if (!isGithubRepoSlug(repo)) {
    return { ok: false, status: null, message: `invalid repo slug '${repo.slice(0, 80)}' — expected 'owner/name'` };
  }
  const perPage = Math.min(Math.max(Math.floor(Number(opts.perPage) || 6), 1), 20);
  const branch = opts.ref ? `&branch=${encodeURIComponent(opts.ref)}` : '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=${perPage}${branch}`,
      { headers: GH_HEADERS(token), signal: ctrl.signal },
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: res.status === 404
          ? 'HTTP 404 — the repo does not exist, or this connected GitHub account has no access to it (GitHub answers private repos you cannot read with 404)'
          : res.status === 403
            ? 'HTTP 403 — the token lacks permission or is rate-limited'
            : `HTTP ${res.status}`,
      };
    }
    const body: any = await res.json();
    return { ok: true, runs: Array.isArray(body?.workflow_runs) ? body.workflow_runs : [] };
  } catch (e: any) {
    return { ok: false, status: null, message: e?.name === 'AbortError' ? 'request timed out' : String(e?.message ?? 'network failure') };
  } finally { clearTimeout(t); }
}

/** A repo-scoped ref head (ticket 51ff7e93) — null on any failure (best-effort; the runs are the evidence). */
export async function fetchRepoHead(token: string, repo: string, ref: string): Promise<{ sha: string; committedAt: string; title: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
      { headers: GH_HEADERS(token), signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const body: any = await res.json();
    if (!body?.sha) return null;
    return {
      sha: String(body.sha),
      committedAt: String(body?.commit?.committer?.date ?? body?.commit?.author?.date ?? ''),
      title: String(body?.commit?.message ?? '').split('\n')[0].slice(0, 90),
    };
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * The compare between two refs (short shas are fine) — the changed-file list
 * the deploy view's worker-lag verdict is computed from (base = the sha a
 * lagging coding box runs, head = main head). Files only; 10 s budget; null
 * on ANY failure — the caller renders the honest "classify by hand"
 * fallback, never a guess. A compare GitHub truncates (>300 files) also
 * answers null: a partial file list could misclassify a REAL lag as a
 * by-design skip, which is the exact misdirection this seam exists to end.
 */
export async function fetchCompareFiles(
  token: string,
  base: string,
  head: string,
): Promise<Array<{ filename: string; status?: string; previous_filename?: string }> | null> {
  // Self-defending: refs interpolate into the URL path — only GitHub-ref-safe
  // characters pass (shas, branch names, tags), never slashes or query glue.
  if (!/^[A-Za-z0-9._-]+$/.test(base) || !/^[A-Za-z0-9._-]+$/.test(head)) return null;
  // Isolation boundary (c75b5f34): see fetchDeployRuns.
  if (!DEPLOY_REPO) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${DEPLOY_REPO}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      { headers: GH_HEADERS(token), signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const body: any = await res.json();
    if (!Array.isArray(body?.files)) return null;
    if (body?.truncated === true) return null;
    return body.files as Array<{ filename: string; status?: string; previous_filename?: string }>;
  } catch { return null; } finally { clearTimeout(t); }
}

// ── 3. Owner-click cost ───────────────────────────────────────────────────────

export interface CardCostDigest { total: number; byTool: Array<{ tool: string; n: number }> }

/**
 * The owner's OWN staged confirmation cards in the 24 h window (ticket
 * 10395cc6, 2026-09-26): rows from pending_confirmations scoped by userId —
 * the SAME table, scope and semantics as get_fleet_telemetry view 'cards' —
 * never the global loop_metrics `confirmation_staged` stream. LoopMetric has
 * NO userId column, so the old query counted EVERY account's cards on this
 * multi-tenant instance and attributed them to the owner's digest: the
 * 2026-09-26 pause_schedule card-class ticket was 3 OTHER accounts'
 * user-anchored lanes (confirmation_staged meta.machine:false, chats not the
 * owner's) read as the owner's card cost. Rows keep the card's real status —
 * a card staged then cancelled/failed is still a card the owner had to look
 * at; a card that expired is still owner-click cost the framing cares about
 * (the owner either clicked it or lost the action).
 */
export async function ownerStagedCardRows(userId: string, now: Date): Promise<Array<{ tool: string }>> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const cards = (await prisma.pendingConfirmation.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { tool: true },
    take: 500,
  }).catch(() => [])) as Array<{ tool: string }>;
  if (cards.length) return cards;
  // Fallback for staged-then-deleted chats (cards die with the chat, the
  // metric rows survive): the owner's confirmation_staged rows are the ones
  // whose sessionId belongs to one of the owner's chats — one findMany on
  // crossmodel_chats for the id set, then the metrics scoped by it. Empty id
  // set ⇒ return empty (an IN () of no ids means NO rows, never ALL rows).
  const chatIds = (await prisma.crossModelChat.findMany({
    where: { userId },
    select: { id: true },
    take: 1000,
  }).catch(() => [])) as Array<{ id: string }>;
  if (!chatIds.length) return [];
  const rows = (await prisma.loopMetric.findMany({
    where: {
      kind: LOOP_METRIC_KINDS.CONFIRMATION_STAGED,
      createdAt: { gte: since },
      sessionId: { in: chatIds.map((c) => c.id) },
    },
    select: { meta: true },
    take: 500,
  }).catch(() => [])) as Array<{ meta: any }>;
  return rows.map((r) => ({ tool: String(r.meta?.tool ?? 'unknown') }));
}

/** Pure: group staged confirmations by tool; null under the threshold. */
export function summarizeCardCost(rows: Array<{ tool: string }>, threshold: number = CARD_COST_DAILY_THRESHOLD): CardCostDigest | null {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.tool, (counts.get(r.tool) ?? 0) + 1);
  const total = rows.length;
  if (total < threshold) return null;
  return { total, byTool: [...counts.entries()].map(([tool, n]) => ({ tool, n })).sort((a, b) => b.n - a.n) };
}

/**
 * A card-class ticket the sweep filed (or found already filed this week) for
 * one tool. `filed` = a NEW row was created this sweep; `deduped` = the
 * insert path matched an EXISTING open ticket for this exact title (same
 * tool, same N, inside feedback's 90-day window) and recorded a sighting on
 * it instead — the id is still the right row for this tool, so the wake
 * cites it, but never as "filed".
 */
export interface CardClassTicket { tool: string; n: number; ticketId: string; week: string; filed: boolean; deduped?: boolean }

/** The insert seam — the SAME path the file_feedback tool uses (caps + dedup apply). */
export type FileCardTicket = (opts: { userId: string; title: string; description: string; context: Record<string, unknown> }) => Promise<{ id: string; deduped?: boolean } | null>;

/** The per-tool session id the filing carries — feedback's fuzzy pass keys on context.sessionId, so two tools' titles must never share one. */
export const cardTicketSessionId = (tool: string) => `${SOURCE}:${tool}`;

const defaultFileCardTicket: FileCardTicket = async (opts) => {
  // Dynamic import per the import-graph discipline (feedback.service is a
  // heavy module the platform-tools suites mock at the boundary).
  const { fileFeedbackTicket, normalizeFeedbackTitle } = await import('../feedback/feedback.service');
  const r = await fileFeedbackTicket({ userId: opts.userId, type: 'enhancement', title: opts.title, description: opts.description, priority: 2, area: 'framework', context: opts.context });
  if ('error' in r) {
    logger.warn(`${SOURCE}: card-class ticket not filed (${r.error}): ${r.message}`, { source: SOURCE });
    return null;
  }
  const id = r.ticket?.id ? String(r.ticket.id) : '';
  if (!id) return null;
  const deduped = 'deduped' in r && r.deduped === true;
  if (deduped) {
    // A dedup hit is only THIS tool's ticket when the titles agree. Anything
    // else (a fuzzy merge onto another class) must never be cached under this
    // tool's week key — report a non-filing so the next sweep retries.
    const got = normalizeFeedbackTitle(String(r.ticket?.title ?? ''));
    if (got !== normalizeFeedbackTitle(opts.title)) {
      logger.warn(`${SOURCE}: card-class ticket for ${String(opts.context?.tool ?? '?')} deduped onto a DIFFERENT title (${id.slice(0, 8)}: "${String(r.ticket?.title ?? '').slice(0, 80)}") — not cached`, { source: SOURCE });
      return null;
    }
  }
  return { id, deduped };
};

export function cardClassTicketTitle(tool: string, n: number): string {
  return `Card class: ${tool} staged ${n}×/day — candidate for a card-free path`;
}

/**
 * WI-Q: file ONE ticket per (tool, ISO week) for every tool that staged
 * ≥ cardTicketMinPerTool() cards for this owner in the digest day. Redis NX
 * on the (tool, week) key is the dedup: the first sweep of the week files and
 * stores the ticket id under the key; later days' wakes cite that id
 * (filed:false). Never throws — a filing failure just leaves the wake without
 * a ticket line for that tool.
 */
export async function fileCardClassTickets(
  userId: string,
  digest: CardCostDigest,
  now: Date,
  fileTicket: FileCardTicket = defaultFileCardTicket,
): Promise<CardClassTicket[]> {
  const out: CardClassTicket[] = [];
  const week = isoWeekKey(now);
  const day = now.toISOString().slice(0, 10);
  const min = cardTicketMinPerTool();
  for (const { tool, n } of digest.byTool) {
    if (n < min) continue;
    const key = CARD_TICKET_KEY(tool, week);
    try {
      const claimed = await (redisClient as any).set(key, 'filing', { NX: true, EX: CARD_TICKET_TTL_SEC });
      if (claimed !== 'OK') {
        const existing = String((await (redisClient as any).get(key).catch(() => '')) || '');
        if (existing && existing !== 'filing') out.push({ tool, n, ticketId: existing, week, filed: false });
        continue;
      }
      const ticket = await fileTicket({
        userId,
        title: cardClassTicketTitle(tool, n),
        description: [
          `The confirmation tool \`${tool}\` staged ${n} owner-click cards on ${day} (${digest.total} cards total across ${digest.byTool.map((t) => `${t.tool} ×${t.n}`).join(', ')}).`,
          'A repeated staging class is a FRAMEWORK DEFECT, not an owner chore (2026-09-18: nine send_chat_message cards in a week were one mistyped-chat-id class the owner kept clicking through).',
          `Evidence: get_fleet_telemetry view 'cards' (hours 24) — byChat says which lane keeps staging, each card's summary says what it tried. Metric: loop_metrics kind 'confirmation_staged' meta.tool='${tool}'.`,
          'Fix shape: find why the machine lane hits the card at all (a wrong id, a missing autonomy grant, a tool that should be non-consequential in this context) and give it a card-free path; verify the tool\'s confirmation_staged count is zero the next day.',
          `Auto-filed by infra-watch (owner-click cost pass, ISO week ${week}). One ticket per tool per week.`,
        ].join('\n\n'),
        // sessionId is PER TOOL — see the header: a shared id let feedback's
        // fuzzy title pass merge two tools' filings into one ticket.
        context: { sessionId: cardTicketSessionId(tool), surface: 'system', origin: SOURCE, about: 'digby_platform', tool, cardsPerDay: n, day, week },
      });
      if (!ticket) {
        await (redisClient as any).del(key).catch(() => {}); // let the next sweep retry the filing
        continue;
      }
      await (redisClient as any).set(key, ticket.id, { EX: CARD_TICKET_TTL_SEC }).catch(() => {});
      const deduped = ticket.deduped === true;
      out.push({ tool, n, ticketId: ticket.id, week, filed: !deduped, ...(deduped ? { deduped: true } : {}) });
      logger.info(`${SOURCE}: card-class ticket ${ticket.id.slice(0, 8)} ${deduped ? 'already open (sighting recorded)' : 'filed'} for ${tool} (${n} cards/day, ${week})`, { source: SOURCE });
    } catch (err: any) {
      logger.warn(`${SOURCE}: card-class ticket for ${tool} failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }
  }
  return out;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const hhmmz = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

export function renderBoxAlert(a: BoxAlert, now: Date): string {
  if (a.kind === 'silent') {
    return `[INFRA ALERT — silent box] ${a.host} has reported no health row since ${a.lastSeenAt ? hhmmz(a.lastSeenAt) : 'unknown'} (now ${hhmmz(now)}). Its worker or backend may be down. Playbook: dispatch_platform_task "Check ${a.host}: container health + deploy state" — the lane confirms the containers (docker ps) and the last deploy on that box, restarts NOTHING without a diagnosis, and reports the receipt. Verify: a fresh box_health row for ${a.host} appears within 30 minutes (get_fleet_telemetry view 'boxes' — ageMin under 30, stale false).`;
  }
  return `[INFRA ALERT — disk ${a.severity}] ${a.host} root disk at ${a.diskPct}% (${a.diskFreeGb} GB free) at ${hhmmz(now)}. The deploy pipeline refuses to build at ≥ 95% (main stops deploying) and the nightly database backup needs ~5 GB free. Playbook, in order: (1) infra_action kind 'prune_build_cache' (reason: this alert) — prunes BuildKit cache older than 72h on the docker host down to a retained cap; a dryRun:true receipt means INFRA_ACTIONS_ENABLED is unset, so dispatch_platform_task "Reclaim disk on ${a.host}" with the receipt's exact command (plus docker image prune -af); NEVER prune volumes or containers and never touch the coding workspaces volume; (2) if still ≥ ${DISK_WARN_PCT}%, infra_action kind 'propose_volume_growth' (read-only: it returns the exact aws ec2 modify-volume command and the projected monthly cost delta) — the root gp3 volume grows ONLINE with no downtime (modify-volume + growpart + resize2fs) but that is owner spend: file ONE flag_owner_question naming the box, the proposed size and the cost line from that receipt; (3) verify: the next box_health row for ${a.host} is below ${DISK_WARN_PCT}% (get_fleet_telemetry view 'boxes') and this alert stops. Do not restart containers.`;
}

export function renderDeployFailureAlert(f: DeployFailure, now: Date): string {
  // 2026-09-27 flake class (deploy-alert blind spot): the same suite runs
  // twice per main push — ci.yml triggers on push:main AND deploy.yml's Test
  // gate re-uses it via workflow_call. Observed same morning: CI 36304247052
  // FAILED on e1a458dd while Deploy 36304247203 SUCCEEDED on that sha; 57 min
  // later Deploy 36306405841 FAILED on 966afd15 while CI 36306405517 PASSED —
  // the fired fix-lane's correct action was "this is a flake, push a no-op or
  // re-run the wave", and 11 of the last 15 deploy failures were Test-gate
  // (suite) failures, not deploy-job failures. A green same-sha CI run is the
  // discriminator: the sha's code already passed the identical suite once, so
  // the deploy failure is a re-run candidate, NOT a code defect hunt.
  const flakeLine = f.ciVerdict === 'success'
    ? ` SAME-SHA CI VERDICT: success — CI (ci.yml) already PASSED this exact sha, so the deploy failure is a rolled FLAKE of the twice-run suite, not a code defect: RE-RUN the wave (gh run rerun --failed <run-id>) or push a no-op commit to main; only open a fix lane if the re-run fails the SAME test.`
    : f.ciVerdict === 'failure'
      ? ` SAME-SHA CI VERDICT: failure — CI (ci.yml) ALSO failed this sha: the code is genuinely red; the fix-lane playbook below applies.`
      : f.ciVerdict === 'in_progress'
        ? ` SAME-SHA CI VERDICT: in progress — wait for CI to conclude before opening a fix lane; a green CI reclassifies this as a flake re-run.`
        : '';
  return `[INFRA ALERT — deploy failed] GitHub deploy run ${f.runId} for ${f.sha} ("${f.title}") concluded FAILURE (started ${f.startedAt}, seen ${hhmmz(now)}): ${f.url}.${flakeLine} Until a later wave succeeds, main is NOT what production runs. Playbook: dispatch_platform_task "Deploy run ${f.runId} failed — fix and re-run" with this URL ONLY if the same-sha CI verdict is not 'success'; the lane reads the failed job log (a red test pin after a metric/contract change is the common class; a disk pre-flight abort is the other), fixes the cause on main, and verifies the next deploy run concludes success and every box's .deploy-sha matches (get_fleet_telemetry view 'deploy': the run for main head concluded success and each box reports onMainHead true). Report the receipt and the verified sha, not the plan.`;
}

export function renderCardCostAlert(d: CardCostDigest, now: Date, tickets: CardClassTicket[] = []): string {
  const classes = d.byTool.map((t) => `${t.tool} ×${t.n}`).join(', ');
  // WI-Q: the durable row the supervisor dispatches against — filed this
  // sweep, or found already filed earlier this week (cite it, do not re-file).
  const ticketLine = tickets.length
    ? ` Tickets (one per tool per ISO week, auto-filed by infra-watch): ${tickets.map((t) => `${t.tool} → ticket ${t.ticketId}${t.filed ? '' : t.deduped ? ' (existing open ticket — sighting recorded, not re-filed)' : ' (filed earlier this week)'}`).join('; ')} — dispatch against the ticket id, never re-file it.`
    : '';
  return `[INFRA ALERT — owner-click cost] ${d.total} confirmation cards were staged for the owner in the last 24 h (${classes}) as of ${hhmmz(now)}. A repeated staging class is a FRAMEWORK DEFECT, not an owner chore (2026-09-18: nine send_chat_message cards in a week were one mistyped-chat-id class the owner kept clicking through).${ticketLine} Playbook: read the staged cards with get_fleet_telemetry view 'cards' (hours 24 — byChat says which lane keeps staging, each card's summary says what it tried), dispatch ONE platform task per class with those summaries as evidence and the expected autonomous path, and verify the class stops staging the next day (get_fleet_telemetry view 'metrics' kind 'confirmation_staged', hours 24: the tool's count is zero). Never ask the owner to keep clicking.`;
}

// ── Decision backend down (audit budgets-cost-6, 2026-09-26) ──────────────────
// platform/decision-gate.ts latches a backend that answered 401/403 (revoked /
// exhausted key) and calls alertDecisionBackendDown on the FIRST latch of an
// episode (and on an all-legs-failed streak); the sweep below re-reads the
// same loop_metrics kind so an alert whose direct delivery failed (redis down,
// the web box's dynamic import refused) still lands within one watchdog tick.
// Both paths share the dedupe key, so a delivered direct alert makes the
// sweep a no-op. Kill switch: INFRA_WATCH_DISABLED (everything here).

export const DECISION_BACKEND_DOWN_KIND = 'decision_gate_backend_down';
/** The sweep's lookback over decision_gate_backend_down rows (two watchdog ticks). */
export const DECISION_BACKEND_DOWN_LOOKBACK_MS = 30 * 60 * 1000;
/** all_legs_failed rows inside the lookback that make the sweep alert (decision-gate.ts alerts at the same streak in-process). */
export const DECISION_ALL_FAILED_SWEEP_MIN = 3;

export interface DecisionBackendDownAlertInput {
  event: 'latched' | 'all_legs_failed';
  purpose: string;
  /** ISO time of the event. */
  at: string;
  spec?: string;
  backend?: string;
  status?: number;
  cooldownMs?: number;
  legErrors?: string[];
  streak?: number;
  /** 4d476b9a: the measured cause of the newest all-failed ask (decision-gate-stall.ts); absent on pre-change rows. */
  cause?: AllFailedCause;
}

const ALL_FAILED_CAUSES: ReadonlySet<string> = new Set(['stall', 'egress', 'provider', 'mixed', 'budget']);

const decisionBackendKey = (a: DecisionBackendDownAlertInput): string =>
  a.event === 'latched'
    ? ALERT_KEY('decision_backend', String(a.spec || a.backend || 'unknown'), String(a.status ?? 'auth'))
    : ALERT_KEY('decision_backend', 'all_legs_failed', 'streak');

export function renderDecisionBackendDownAlert(a: DecisionBackendDownAlertInput, now: Date): string {
  if (a.event === 'latched') {
    const backend = a.backend || a.spec || 'the decision backend';
    const cooldownS = Math.round((a.cooldownMs ?? 90_000) / 1000);
    const keyHint = a.spec === 'jev' ? 'TYPESAFE_API_KEY (the TypeSafe key — revoked, rotated or over quota)' : a.spec === 'deepseek-flash' ? 'DEEPSEEK_API_KEY' : `the registered endpoint's key for ${a.spec ?? backend}`;
    return `[INFRA ALERT — decision backend down] ${backend} (spec ${a.spec ?? 'unknown'}) answered HTTP ${a.status ?? '401/403'} to the decision gate at ${a.at} (seen ${hhmmz(now)}, first noticed by purpose ${a.purpose}). The gate has LATCHED it for ${cooldownS} s at a time (one probe per cooldown) and every ask falls through to the next leg; the fallback logprob readout is UNCALIBRATED, so every act purpose on this backend (sweep_triage, wake_triage, auto_route, drain_triage, imessage_send as of 2026-09-26) is silently running its pre-gate heuristic — no bad answers, but ~0.5–1.3 s added per gated site and zero act-band labels accrue while it lasts. Most likely cause: ${keyHint}. Playbook: (1) get_fleet_telemetry view 'boxes' — the decisionGate tile names the latched backend, since when and whether it recovered; a recovered:true tile with no active latch means a transient episode (the 2026-09-26 06:34–06:40Z class) and nothing to do, and a stale:true episode (newest latch row older than 2 h, no recovered row) means the process that latched it died latched — recovery was never recorded but the latch is gone with it (e7b9521b); (2) still active after 15 min ⇒ dispatch_platform_task "Decision backend ${a.spec ?? backend} answering HTTP ${a.status ?? 403}" — the lane checks the key on the box (docker-compose.app.yml passes ${a.spec === 'jev' ? 'TYPESAFE_API_KEY / TYPESAFE_BASE_URL / TYPESAFE_MODEL' : 'the provider key'} to backend + worker; a 403 with a present key is quota / plan on the vendor side — read the vendor dashboard, never guess), rotates it via the owner if revoked (ONE flag_owner_question naming the key and the vendor), and confirms with the Model roles Test button (Account → Admin → Endpoints → Model roles → Decision gate) — from an agent, the same probe is test_model_role {role:'decision', candidate:'${a.spec ?? 'jev'}'} (the seat key is 'decision'; backend specs are candidate values, never seats); (3) verify: get_fleet_telemetry view 'metrics' kind 'decision_gate_backend_down' shows a 'recovered' event after the fix and view 'boxes' decisionGate.active is empty (a stale episode reads inactive too — its note says 'died latched'); loop_metrics decision_gate rows for the act purposes stop carrying modeDowngrade:'uncalibrated'.`;
  }
  const errs = (a.legErrors ?? []).slice(0, 4).join(' | ') || 'no leg detail';
  return `[INFRA ALERT — decision gate: every backend failing] ${a.streak ?? DECISION_ALL_FAILED_SWEEP_MIN}+ decision-gate asks in the last 5 minutes had EVERY leg fail (latest ${a.at}, purpose ${a.purpose}, seen ${hhmmz(now)}): ${errs}.${a.cause ? ` Measured cause of the latest: ${allFailedCauseText(a.cause)}.` : ''} Every gated site is running its pre-gate path (fail-open — no wrong answers, but no act savings and no labels). Playbook: (1) read get_fleet_telemetry view 'boxes' (decisionGate tile) and view 'metrics' kind 'decision_gate' hours 1 — a run of 'deadline exhausted' / 'timeout' on every leg is provider latency or egress (compare box_health load), HTTP 4xx on the first leg is a key / quota problem (see the decision-backend-down playbook), 'not servable' means no key is configured at all; (2) if the readout leg (deepseek-flash) is failing too, the DeepSeek key or api.deepseek.com egress is the common cause — check with the Model roles Test button for both built-ins (from an agent: test_model_role {role:'decision', candidate:'jev'} and {role:'decision', candidate:'deepseek-flash'} — the seat key is 'decision', backend specs are candidate values, never seats); (3) verify: no new all_legs_failed rows in the next 15 min (get_fleet_telemetry view 'metrics' kind 'decision_gate_backend_down').`;
}

/**
 * Deliver ONE [INFRA ALERT — decision backend down] wake for the event to every
 * admin owner's Fleet Supervisor, deduped per (spec, status) / the streak key
 * for INFRA_ALERT_DEDUPE_SEC. Called by platform/decision-gate.ts on the first
 * latch of an episode / an all-failed streak (fire-and-forget) and by the
 * sweep from the stored rows. Never throws; returns the wakes delivered.
 */
export async function alertDecisionBackendDown(a: DecisionBackendDownAlertInput, deps: Pick<InfraWatchDeps, 'now' | 'enqueueDirectWake'> = {}): Promise<number> {
  if (infraWatchDisabled()) return 0;
  try {
    const now = deps.now ?? new Date();
    const wake = deps.enqueueDirectWake ?? (async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
    const targets = await adminFleetSupervisors();
    if (!targets.length) return 0;
    const meta = { kind: 'decision_backend', event: a.event, purpose: a.purpose, spec: a.spec ?? null, backend: a.backend ?? null, status: a.status ?? null, at: a.at, ...(typeof a.streak === 'number' ? { streak: a.streak } : {}), ...(a.cause ? { cause: a.cause } : {}) };
    return await deliver(targets, decisionBackendKey(a), INFRA_ALERT_DEDUPE_SEC, renderDecisionBackendDownAlert(a, now), meta, wake);
  } catch (err: any) {
    logger.warn(`${SOURCE}: decision-backend alert failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    return 0;
  }
}

/** Pure: the alerts the sweep raises from the window's decision_gate_backend_down rows — one per latched backend
 *  (spec + status; its NEWEST latched/relatched row, skipped once a later 'recovered' row exists) plus the streak alert
 *  when ≥ DECISION_ALL_FAILED_SWEEP_MIN all_legs_failed rows sit in the window. Rows without a known `event` are ignored.
 *  4d476b9a: an all_legs_failed row decide() attributed to an event-loop STALL (cause 'stall') is not counted — the
 *  same exemption as the in-process streak (DECISION_GATE_STALL_RECOVERY_DISABLED=1 in this process counts it again).
 *  Round 2: only when the row itself carries the confirming evidence (every timed-out leg `stallConfirmed`); a cause
 *  'stall' row without it counts. */
export function selectDecisionBackendDownAlerts(rows: Array<{ meta: any; createdAt: Date | string }>, min: number = DECISION_ALL_FAILED_SWEEP_MIN): DecisionBackendDownAlertInput[] {
  const newestByKey = new Map<string, { at: number; alert: DecisionBackendDownAlertInput }>();
  const recoveredAt = new Map<string, number>();
  const allFailed: Array<{ at: number; purpose: string; legErrors: string[]; cause?: AllFailedCause }> = [];
  for (const r of rows) {
    const m = r?.meta;
    if (!m || typeof m !== 'object') continue;
    const at = r.createdAt instanceof Date ? r.createdAt.getTime() : Date.parse(String(r.createdAt));
    if (!Number.isFinite(at)) continue;
    const spec = typeof m.spec === 'string' ? m.spec : undefined;
    const status = typeof m.status === 'number' ? m.status : undefined;
    const key = `${spec ?? m.backend ?? 'unknown'}::${status ?? 'auth'}`;
    if (m.event === 'latched' || m.event === 'relatched') {
      const cur = newestByKey.get(key);
      if (!cur || at > cur.at) {
        newestByKey.set(key, { at, alert: { event: 'latched', purpose: String(m.purpose ?? 'unknown'), at: new Date(at).toISOString(), spec, backend: typeof m.backend === 'string' ? m.backend : undefined, status, cooldownMs: typeof m.cooldownMs === 'number' ? m.cooldownMs : undefined } });
      }
    } else if (m.event === 'recovered') {
      recoveredAt.set(key, Math.max(recoveredAt.get(key) ?? 0, at));
    } else if (m.event === 'all_legs_failed') {
      if (isStallExemptAllFailedRow(m)) continue;
      const cause = typeof m.cause === 'string' && ALL_FAILED_CAUSES.has(m.cause) ? (m.cause as AllFailedCause) : undefined;
      allFailed.push({ at, purpose: String(m.purpose ?? 'unknown'), legErrors: Array.isArray(m.legErrors) ? m.legErrors.map(String) : [], ...(cause ? { cause } : {}) });
    }
  }
  const out: DecisionBackendDownAlertInput[] = [];
  for (const [key, { at, alert }] of newestByKey) {
    if ((recoveredAt.get(key) ?? -1) >= at) continue;
    out.push(alert);
  }
  if (allFailed.length >= Math.max(1, min)) {
    const newest = allFailed.reduce((a, b) => (b.at > a.at ? b : a));
    out.push({ event: 'all_legs_failed', purpose: newest.purpose, at: new Date(newest.at).toISOString(), legErrors: newest.legErrors, streak: allFailed.length, ...(newest.cause ? { cause: newest.cause } : {}) });
  }
  return out;
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

export interface InfraWatchDeps {
  now?: Date;
  enqueueDirectWake?: (opts: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<unknown>;
  fetchDeployRuns?: (token: string) => Promise<any[]>;
  /** DEPLOY-WATCH-BLIND: the status-carrying deploy read (default fetchDeployRunsWithStatus).
   *  Wins over fetchDeployRuns; a legacy fetchDeployRuns seam reads as HTTP 200. */
  fetchDeployRunsWithStatus?: (token: string) => Promise<WorkflowRunsFetch>;
  /** DEPLOY-WATCH-BLIND: the read-only token (default process.env.INFRA_WATCH_GITHUB_TOKEN) — test seam. */
  envGithubToken?: string | null;
  /** The same-sha CI verdict fetch (default: fetchCiRuns) — test seam. */
  fetchCiRuns?: (token: string) => Promise<any[]>;
  getGithubToken?: (userId: string) => Promise<string | null>;
  /** WI-Q: the card-class ticket insert seam (default: feedback.fileFeedbackTicket). */
  fileCardTicket?: FileCardTicket;
}

export interface FleetSupervisorRow { id: string; userId: string }

/** Every admin owner's Fleet Supervisor chat — the operator's inbox (shared with fleet/product-watch.service.ts). */
export async function adminFleetSupervisors(): Promise<FleetSupervisorRow[]> {
  const rows = (await prisma.crossModelChat.findMany({
    where: { isSupervisor: true, archivedAt: null, user: { role: 'ADMIN' } } as any,
    select: { id: true, userId: true },
    // DEPLOY-WATCH-BLIND (2026-10-20): a STABLE order — the deploy sweep used
    // to read targets[0] of an unordered take:10, so which owner's GitHub
    // token it tried changed with the planner. Oldest supervisor first.
    orderBy: { createdAt: 'asc' },
    take: 10,
  }).catch(() => [])) as FleetSupervisorRow[];
  return rows;
}

/**
 * Deliver ONE alert wake to every target, deduped by `key` for `ttlSec`
 * (Redis). Shared with fleet/product-watch.service.ts — `metricKind` names
 * the loop_metrics row each delivery attempt leaves (default INFRA_ALERT): a
 * DELIVERED row is bare meta; a failed enqueue (returned not-ok or thrown —
 * 6d19f11f) leaves the same-kind row with meta.outcome = 'enqueue_failed' and
 * sets NO dedupe key, so the next deliver() attempt retries.
 */
export async function deliver(
  targets: FleetSupervisorRow[],
  key: string,
  ttlSec: number,
  prompt: string,
  meta: Record<string, unknown>,
  wake: NonNullable<InfraWatchDeps['enqueueDirectWake']>,
  metricKind: string = LOOP_METRIC_KINDS.INFRA_ALERT,
): Promise<number> {
  // Supervisor OFF switch: no wake, no dedupe key (the alert re-evaluates on
  // every sweep and delivers the moment the switch is back on if still true).
  if (targets.length && !(await getFleetSupervisorEnabled().catch(() => true))) {
    for (const t of targets) recordSupervisorSwitchSkip({ target: 'fleet', source: `alert:${metricKind}`, chatId: t.id });
    return 0;
  }
  if (await (redisClient as any).get(key).catch(() => null)) return 0;
  let delivered = 0;
  for (const t of targets) {
    // abd733af (review finding 3): the enqueue-failure EVIDENCE (row + warn)
    // is deduped per target per hour — a permanently failing target used to
    // write one per sweep (~96/day/standing alert). The wake itself is still
    // ATTEMPTED every sweep: the 6d19f11f contract (a failed enqueue is
    // retried, never silenced) is untouched.
    const failRowKey = ENQUEUE_FAIL_ROW_KEY(t.id);
    const failRowHeld = await (redisClient as any).get(failRowKey).catch(() => null);
    const noteFailure = (error: string) => {
      // Review round 1b finding 4: the warn is part of the deduped EVIDENCE
      // (the docblock above says "no second row/warn") — it used to sit
      // outside this guard and fired once per sweep per standing target.
      if (!failRowHeld) {
        recordLoopMetric({ kind: metricKind, sessionId: t.id, meta: { ...meta, outcome: 'enqueue_failed', error } });
        void (redisClient as any).set(failRowKey, String(Date.now()), { EX: ENQUEUE_FAIL_ROW_DEDUPE_SEC }).catch(() => {});
        logger.warn(`${SOURCE}: wake failed for ${t.id.slice(0, 8)}: ${error}`, { source: SOURCE });
      }
    };
    try {
      // 6d19f11f: enqueueDirectWake reports failure as { ok: false } instead of
      // throwing (hooks.service enqueueDirectWake — target chat missing, outbox
      // write failed, …), so the RETURN must be read too. Treating a non-ok
      // return as delivered silenced the alert for the whole dedupe window
      // (INFRA_ALERT_DEDUPE_SEC = 6 h) without a wake ever landing: the day key
      // was set and a delivered-looking metrics row written. Not delivered ⇒ no
      // dedupe key (the sweep retries the still-true alert — sweeps re-invoke
      // deliver() every pass; a caller with its OWN deliver gate, like the
      // card-cost digest key, still owes its own retry) and the failure is
      // recorded as such, distinguishable from a delivered row by meta.outcome
      // (delivered-count readers must filter outcome IS NULL / <> 'enqueue_failed').
      const res: any = await wake({ targetChatId: t.id, prompt, meta: { origin: SOURCE, ...meta } });
      if (res && typeof res === 'object' && res.ok === false) {
        noteFailure(String(res.error ?? 'unknown error'));
        continue;
      }
      delivered++;
      recordLoopMetric({ kind: metricKind, sessionId: t.id, meta });
      // Recovery clears the evidence-dedupe key: the NEXT failure after a
      // delivered wake is a fresh incident and gets a fresh row + warn.
      if (failRowHeld) await (redisClient as any).del(failRowKey).catch(() => {});
    } catch (err: any) {
      // Same class as a non-ok return (6d19f11f): a thrown enqueue failure is
      // not delivered either — the sweep must retry on the next pass, so it
      // never sets the dedupe key, and the throw leaves a failure row too.
      noteFailure(String(err?.message ?? err));
    }
  }
  if (delivered) await (redisClient as any).set(key, String(Date.now()), { EX: ttlSec }).catch(() => {});
  return delivered;
}

// ── Deploy watch blind (DEPLOY-WATCH-BLIND, 2026-10-20) ──────────────────────

/** Why a sweep could not read the deploy runs: no token anywhere, no response, or GitHub's non-200 status. */
export type DeployWatchBlindReason = 'no_token' | 'network' | `http_${number}`;

/** Pure: the blind reason a deploy-runs read's status names (null = no response arrived). */
export function deployWatchBlindReason(status: number | null): DeployWatchBlindReason {
  return status === null ? 'network' : `http_${status}`;
}

export interface DeployWatchProbe {
  /** The token whose deploy-runs read answered HTTP 200 (null = blind). */
  token: string | null;
  /** That read's runs — the probe IS the sweep's deploy read, never a second call. */
  runs: any[];
  /** 'env' | 'user:<id8>' — which credential answered (never the token). */
  source: string | null;
  /** Set when blind: the FIRST failure (the preferred credential's), or 'no_token'. */
  reason: DeployWatchBlindReason | null;
  /** Credentials that were actually probed (a null / duplicate token is not). */
  tried: number;
  /** Every probed credential's failure, in order — 'env:http_401', 'user:3f2a9c10:network'. */
  failures: string[];
  /** The fetch was skipped (non-prod with no INFRA_WATCH_REPO) — nothing to watch, never blind. */
  skipped?: 'no_repo';
}

/**
 * Find a credential that can READ the framework repo's deploy runs: the
 * read-only INFRA_WATCH_GITHUB_TOKEN first, then each admin owner's connected
 * token in the given (stable) order, stopping at the first deploy-runs read
 * that answers HTTP 200. The old sweep read ONE token (targets[0]) and skipped
 * silently on null — one owner with no labelled GitHub account blinded it for
 * days. The env token is PREFERRED, not exclusive: an expired one falls back
 * to the owners' tokens (the pre-change source) and its failure is the
 * reported reason. A fetch that throws reads as no response ('network').
 * `repo: ''` (a non-prod instance with no INFRA_WATCH_REPO) is "nothing to
 * watch": no token is read, nothing is fetched, and the result is skipped —
 * never blind (an Edge box without a repo must not page its owner daily).
 * Never throws (getToken rejections read as "no token for that owner").
 */
export async function probeDeployWatchToken(opts: {
  envToken?: string | null;
  userIds: string[];
  getToken: (userId: string) => Promise<string | null>;
  fetchRuns: (token: string) => Promise<WorkflowRunsFetch>;
  /** The watched repo slug (the sweep passes DEPLOY_REPO); omitted = assumed configured. */
  repo?: string;
}): Promise<DeployWatchProbe> {
  const failures: string[] = [];
  if (opts.repo !== undefined && !opts.repo) return { token: null, runs: [], source: null, reason: null, tried: 0, failures, skipped: 'no_repo' };
  const seen = new Set<string>();
  const acc: { tried: number; firstReason: DeployWatchBlindReason | null } = { tried: 0, firstReason: null };
  const attempt = async (token: string, source: string): Promise<DeployWatchProbe | null> => {
    if (seen.has(token)) return null;
    seen.add(token);
    acc.tried++;
    const res: WorkflowRunsFetch = (await Promise.resolve().then(() => opts.fetchRuns(token)).catch(() => null)) || { runs: [], status: null };
    if (res.skipped === 'no_repo') return { token: null, runs: [], source: null, reason: null, tried: acc.tried, failures, skipped: 'no_repo' };
    if (res.status === 200) return { token, runs: Array.isArray(res.runs) ? res.runs : [], source, reason: null, tried: acc.tried, failures };
    const reason = deployWatchBlindReason(res.status);
    if (!acc.firstReason) acc.firstReason = reason;
    failures.push(`${source}:${reason}`);
    return null;
  };
  const envToken = String(opts.envToken ?? '').trim();
  if (envToken) {
    const hit = await attempt(envToken, 'env');
    if (hit) return hit;
  }
  for (const userId of [...new Set(opts.userIds.filter(Boolean))]) {
    const token = await Promise.resolve().then(() => opts.getToken(userId)).catch(() => null);
    if (!token) continue;
    const hit = await attempt(token, `user:${userId.slice(0, 8)}`);
    if (hit) return hit;
  }
  return { token: null, runs: [], source: null, reason: acc.firstReason ?? 'no_token', tried: acc.tried, failures };
}

export interface DeployWatchBlindState { consecutive: number; since: string; reason: DeployWatchBlindReason }

function parseBlindState(raw: unknown): DeployWatchBlindState | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || !Number.isFinite(Number(v.consecutive)) || typeof v.since !== 'string') return null;
    return { consecutive: Math.max(0, Math.floor(Number(v.consecutive))), since: v.since, reason: String(v.reason ?? 'no_token') as DeployWatchBlindReason };
  } catch { return null; }
}

/** The sweep's current consecutive-blind state (null = seeing, unknown, or the kill switch is on). Never throws. */
export async function readDeployWatchBlindState(): Promise<DeployWatchBlindState | null> {
  if (infraWatchBlindAlarmDisabled()) return null;
  try { return parseBlindState(await (redisClient as any).get(DEPLOY_WATCH_BLIND_KEY)); } catch { return null; }
}

export function renderDeployWatchBlindAlert(s: DeployWatchBlindState, now: Date, failures: string[] = []): string {
  const detail = failures.length ? ` (credentials probed this sweep: ${failures.slice(0, 4).join(', ')})` : '';
  return `[INFRA ALERT — deploy watch blind] deploy watch blind: ${s.reason} since ${s.since} — ${s.consecutive} consecutive infra-watch sweeps (seen ${hhmmz(now)}) could not read ${DEPLOY_REPO || 'the framework repo'}'s ${DEPLOY_WORKFLOW_FILE} runs${detail}. While blind, a failed deploy raises NO [INFRA ALERT — deploy failed] and no deploy_wave_success row is written (the red-deploy recovery signal the audit adjudicates on), so "no alerts" means nothing. Playbook: no_token ⇒ nothing usable is configured — set ${INFRA_WATCH_GITHUB_TOKEN_ENV} (a read-only fine-grained token with Actions:read on the repo) in the box env overrides, or have an admin owner connect GitHub (Account → Integrations → GitHub); ONE flag_owner_question naming the missing credential, never a guess. http_401 / http_403 ⇒ the token is revoked, expired or rate-limited — rotate it (owner action); http_404 ⇒ the token cannot see the repo; network ⇒ api.github.com egress from the worker (compare box_health). Verify: get_fleet_telemetry view 'deploy' no longer says "blind" and its runs list matches the Actions page; a fresh deploy_wave_success row lands after the next green wave (view 'metrics' kind 'deploy_wave_success').`;
}

/**
 * Account ONE blind sweep: an infra_watch_blind row, the Redis consecutive
 * count (since = the episode's first blind sweep), and — at
 * DEPLOY_WATCH_BLIND_ALARM_AFTER — ONE wake per DEPLOY_WATCH_BLIND_ALERT_TTL_SEC
 * through deliver() (its own dedupe key; a failed enqueue sets no key and the
 * next blind sweep retries). Returns the wakes delivered. Never throws.
 */
export async function recordDeployWatchBlind(
  probe: Pick<DeployWatchProbe, 'reason' | 'tried' | 'failures'>,
  targets: FleetSupervisorRow[],
  now: Date,
  wake: NonNullable<InfraWatchDeps['enqueueDirectWake']>,
): Promise<number> {
  if (infraWatchBlindAlarmDisabled()) return 0;
  try {
    const reason = probe.reason ?? 'no_token';
    const prev = parseBlindState(await (redisClient as any).get(DEPLOY_WATCH_BLIND_KEY).catch(() => null));
    const state: DeployWatchBlindState = { consecutive: (prev?.consecutive ?? 0) + 1, since: prev?.since ?? now.toISOString(), reason };
    await (redisClient as any).set(DEPLOY_WATCH_BLIND_KEY, JSON.stringify(state), { EX: DEPLOY_WATCH_BLIND_TTL_SEC }).catch(() => {});
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.INFRA_WATCH_BLIND, meta: { reason, consecutive: state.consecutive, since: state.since, tried: probe.tried, failures: probe.failures.slice(0, 6) } });
    if (state.consecutive < DEPLOY_WATCH_BLIND_ALARM_AFTER) return 0;
    return await deliver(
      targets,
      ALERT_KEY('deploy_watch_blind', 'github', 'blind'),
      DEPLOY_WATCH_BLIND_ALERT_TTL_SEC,
      renderDeployWatchBlindAlert(state, now, probe.failures),
      { kind: 'deploy_watch_blind', reason, since: state.since, consecutive: state.consecutive },
      wake,
    );
  } catch (err: any) {
    logger.warn(`${SOURCE}: deploy-watch blind accounting failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    return 0;
  }
}

/** A SEEING sweep ends the blind episode: one 'recovered' row when an episode was open, then the state is cleared. Never throws. */
/** The deploy watch's read credential as last recorded by THIS process (null = never). */
let lastDeployWatchSource: string | null = null;
/** Record which credential the deploy watch read GitHub with — once per process, then only on a change
 *  of source ('env' = the read-only INFRA_WATCH_GITHUB_TOKEN, 'user:<id8>' = an admin's account). Pure
 *  telemetry; never throws. Exported for tests. */
export function noteDeployWatchSource(source: string | null): boolean {
  if (!source || source === lastDeployWatchSource) return false;
  const previous = lastDeployWatchSource;
  lastDeployWatchSource = source;
  try {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.INFRA_WATCH_SOURCE, meta: { source: source.startsWith('user:') ? 'user' : source, ...(source.startsWith('user:') ? { user: source.slice(5) } : {}), previous } });
  } catch { /* telemetry only */ }
  return true;
}
/** Test seam: forget the recorded source. */
export function resetDeployWatchSourceForTests(): void { lastDeployWatchSource = null; }

export async function clearDeployWatchBlind(source: string | null): Promise<void> {
  if (infraWatchBlindAlarmDisabled()) return;
  try {
    const prev = parseBlindState(await (redisClient as any).get(DEPLOY_WATCH_BLIND_KEY).catch(() => null));
    if (!prev) return;
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.INFRA_WATCH_BLIND, meta: { outcome: 'recovered', reason: prev.reason, consecutive: prev.consecutive, since: prev.since, source } });
    await (redisClient as any).del(DEPLOY_WATCH_BLIND_KEY).catch(() => {});
  } catch { /* best-effort */ }
}

/** One sweep (attention watchdog cadence). Never throws. */
export async function sweepInfraWatch(deps: InfraWatchDeps = {}): Promise<{ alerts: number }> {
  const counters = { alerts: 0 };
  if (infraWatchDisabled()) return counters;
  const now = deps.now ?? new Date();
  const wake = deps.enqueueDirectWake ?? (async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
  try {
    const targets = await adminFleetSupervisors();
    if (!targets.length) return counters;

    // 1. boxes (+ 1b. backup age over the same rows)
    try {
      const rows = await latestBoxHealthRows(now);
      const backup = classifyBackupAge(rows, now, BACKUP_STALE_H, backupProducerHosts(), await producerBackupLastSeenAt(now));
      if (backup) {
        counters.alerts += await deliver(targets, ALERT_KEY('backup', backup.host ?? 'fleet', backup.severity), INFRA_ALERT_DEDUPE_SEC, renderBackupAlert(backup, now), { kind: 'backup', severity: backup.severity, host: backup.host, ageH: backup.ageH }, wake);
      }
      const alerts = classifyBoxHealth(rows, now);
      for (const a of alerts) {
        counters.alerts += await deliver(targets, ALERT_KEY(a.kind, a.host, a.severity), INFRA_ALERT_DEDUPE_SEC, renderBoxAlert(a, now), { kind: a.kind, host: a.host, severity: a.severity, diskPct: a.diskPct ?? null }, wake);
      }
    } catch (err: any) {
      logger.warn(`${SOURCE}: box sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }

    // 2. deploy failures. DEPLOY-WATCH-BLIND (2026-10-20): the read-only
    //    INFRA_WATCH_GITHUB_TOKEN first, then every admin owner's connected
    //    token (stable order) until a deploy-runs read answers HTTP 200 — the
    //    old single targets[0] read skipped SILENTLY on null and the [] fetch
    //    hid every non-200, so 3 days of deploys left 0 deploy_wave_success
    //    rows and no alert. A sweep that cannot read is BLIND: counted, and
    //    alarmed once at DEPLOY_WATCH_BLIND_ALARM_AFTER in a row.
    try {
      const getToken = deps.getGithubToken ?? (async (userId: string) => (await import('../github/token-manager')).getValidToken(userId));
      const legacyFetchRuns = deps.fetchDeployRuns;
      const fetchRunsWithStatus = deps.fetchDeployRunsWithStatus
        ?? (legacyFetchRuns
          ? (async (t: string): Promise<WorkflowRunsFetch> => ({ runs: await legacyFetchRuns(t), status: 200 }))
          : ((t: string) => fetchDeployRunsWithStatus(t, { status: 'completed' })));
      const fetchCi = deps.fetchCiRuns ?? ((t: string) => fetchCiRuns(t, { status: 'completed' }));
      const envToken = deps.envGithubToken !== undefined ? deps.envGithubToken : process.env[INFRA_WATCH_GITHUB_TOKEN_ENV];
      const probe = await probeDeployWatchToken({ envToken, userIds: targets.map((t) => t.userId), getToken, fetchRuns: fetchRunsWithStatus, repo: DEPLOY_REPO });
      if (!probe.token) {
        // no_repo (non-prod without INFRA_WATCH_REPO) is "nothing to watch", never blind.
        if (!probe.skipped) counters.alerts += await recordDeployWatchBlind(probe, targets, now, wake);
      } else {
        await clearDeployWatchBlind(probe.source);
        noteDeployWatchSource(probe.source);
        const token = probe.token;
        const deployRuns = probe.runs;
        const failures = selectDeployFailures(deployRuns, now);
        // Same-sha CI verdicts (2026-09-27 flake class): the suite runs TWICE
        // per main push (CI on push:main + the deploy Test gate via
        // workflow_call), so a deploy failure can be a rolled flake the CI
        // run already answered. Fetch is best-effort — a failed fetch leaves
        // ciVerdict null and the alert falls back to the fix-lane playbook.
        const enriched = attachCiVerdicts(failures, await fetchCi(token).catch(() => []));
        for (const f of enriched) {
          const seenKey = DEPLOY_SEEN_KEY(f.runId);
          if (await (redisClient as any).get(seenKey).catch(() => null)) continue;
          const n = await deliver(targets, ALERT_KEY('deploy', String(f.runId), 'failure'), 24 * 3600, renderDeployFailureAlert(f, now), { kind: 'deploy', runId: f.runId, sha: f.sha, ...(f.ciVerdict ? { ciVerdict: f.ciVerdict } : {}) }, wake);
          counters.alerts += n;
          if (n) await (redisClient as any).set(seenKey, f.sha, { EX: 24 * 3600 }).catch(() => {});
        }
        // FO firing 102 (32nd f64 bake): stamp every in-window SUCCESSFUL
        // deploy run once (Redis-deduped by runId for 7 d) — the recovery
        // signal the audit's deploy_ci_red_24h adjudication keys on. The rows
        // land even when nothing is red, so a red alert raised BEFORE the wave
        // reads 'recovered' the moment a green wave concludes after it.
        for (const s of selectDeploySuccesses(deployRuns, now)) {
          const skey = DEPLOY_SEEN_KEY(`ok-${s.runId}`);
          if (await (redisClient as any).get(skey).catch(() => null)) continue;
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.DEPLOY_WAVE_SUCCESS, meta: { runId: s.runId, sha: s.sha, at: s.at } });
          await (redisClient as any).set(skey, '1', { EX: 7 * 24 * 3600 }).catch(() => {});
        }
      }
    } catch (err: any) {
      logger.warn(`${SOURCE}: deploy sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }

    // 3. owner-click cost — once per owner per UTC day
    try {
      const day = now.toISOString().slice(0, 10);
      for (const t of targets) {
        const dkey = CARD_DIGEST_KEY(t.userId, day);
        if (await (redisClient as any).get(dkey).catch(() => null)) continue;
        const rows = (await ownerStagedCardRows(t.userId, now).catch(() => [])) as Array<{ tool: string }>;
        const digest = summarizeCardCost(rows);
        if (!digest) {
          // Nothing actionable TODAY: mark the digest seen so the next sweep
          // skips the row fetch, but ONLY after the not-actionable decision —
          // a failed wake below never reaches this point, so its retry stays
          // eligible for the rest of the day.
          await (redisClient as any).set(dkey, '1', { EX: 26 * 3600 }).catch(() => {});
          continue;
        }
        // WI-Q: one durable ticket per (tool, week) for the ≥3/day classes, cited in the wake.
        const tickets = await fileCardClassTickets(t.userId, digest, now, deps.fileCardTicket);
        const delivered = await deliver([t], ALERT_KEY('cards', t.userId, day), 26 * 3600, renderCardCostAlert(digest, now, tickets), { kind: 'cards', total: digest.total, byTool: digest.byTool, ...(tickets.length ? { tickets: tickets.map((x) => ({ tool: x.tool, ticketId: x.ticketId, filed: x.filed, ...(x.deduped ? { deduped: true } : {}) })) } : {}) }, wake);
        // abd733af (6d19f11f review finding 2a): the 26h digest gate is a
        // CALLER-OWNED retry gate — deliver() itself never sets the shared
        // dedupe key on a failed wake, but this digest key used to be stamped
        // BEFORE deliver(), so a failed card-cost wake was never retried that
        // day (the daily digest looked sent). Gate on delivered>0 only: a
        // failed enqueue leaves the day open for the next sweep to retry.
        if (delivered > 0) {
          counters.alerts += delivered;
          await (redisClient as any).set(dkey, '1', { EX: 26 * 3600 }).catch(() => {});
        }
      }
    } catch (err: any) {
      logger.warn(`${SOURCE}: card-cost sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }

    // 4. decision backends down (audit budgets-cost-6, 2026-09-26): the latched /
    //    all-failed rows decision-gate.ts wrote in the lookback — the direct
    //    alert shares the dedupe key, so this only fires when that one did not land.
    try {
      const rows = (await prisma.loopMetric.findMany({
        where: { kind: DECISION_BACKEND_DOWN_KIND, createdAt: { gte: new Date(now.getTime() - DECISION_BACKEND_DOWN_LOOKBACK_MS) } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { meta: true, createdAt: true },
      }).catch(() => [])) as Array<{ meta: any; createdAt: Date }>;
      for (const a of selectDecisionBackendDownAlerts(rows)) {
        counters.alerts += await deliver(targets, decisionBackendKey(a), INFRA_ALERT_DEDUPE_SEC, renderDecisionBackendDownAlert(a, now), { kind: 'decision_backend', event: a.event, purpose: a.purpose, spec: a.spec ?? null, backend: a.backend ?? null, status: a.status ?? null, at: a.at, ...(typeof a.streak === 'number' ? { streak: a.streak } : {}), viaSweep: true }, wake);
      }
    } catch (err: any) {
      logger.warn(`${SOURCE}: decision-backend sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }

    // 5. capacity (todo 0f58ddde, 2026-10-16): drainer pool full / dev-container
    //    memory / ticket-queue unmoved — each proven by TWO consecutive
    //    capacity_* loop_metrics rows (anti-flap) written by the box-C
    //    capacity-probe cron and the ticket drain itself. DB-only, any worker.
    //    The alert names the linked tickets (ed057f9d / ff262da5) and never
    //    files a new one — the asks already sit inside them. The classify is
    //    raced against a deadline so a cold pool cannot leak latency into the
    //    supervisor wake path (the same bound the deploy fetches carry).
    try {
      const { classifyCapacity, renderCapacityAlert, capacityWatchDisabled } = await import('./capacity-watch.service');
      if (!capacityWatchDisabled()) {
        // race the classify so a cold pool cannot leak latency into the wake
        // path (the same 10 s bound the deploy fetches carry).
        let classifyTimer: NodeJS.Timeout | null = null;
        const classified = await Promise.race([
          classifyCapacity(now),
          new Promise<null>((resolve) => { classifyTimer = setTimeout(() => resolve(null), 10_000); }),
        ]).finally(() => { if (classifyTimer) clearTimeout(classifyTimer); });
        for (const a of classified ?? []) {
          counters.alerts += await deliver(
            targets,
            ALERT_KEY(a.kind, `${a.signal}:${a.subject}`, a.severity),
            INFRA_ALERT_DEDUPE_SEC,
            renderCapacityAlert(a, now),
            { kind: a.kind, signal: a.signal, subject: a.subject, severity: a.severity, ...a.meta, sustainedSince: a.firstAt.toISOString() },
            wake,
          );
        }
      }
    } catch (err: any) {
      logger.warn(`${SOURCE}: capacity sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }
  } catch (err: any) {
    logger.warn(`${SOURCE}: sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
  }
  return counters;
}

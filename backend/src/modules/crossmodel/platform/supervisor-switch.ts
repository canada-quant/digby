/**
 * Supervisor OFF switch (owner 2026-09-26: "we need a way to turn off fleet
 * supervisor from the framework").
 *
 * TWO admin-only SystemSettings, each with an env boot default and a 60 s
 * in-memory cache (the rate-limit.service `patience_auto_only` shape):
 *   - `fleet_supervisor_enabled`    (env FLEET_SUPERVISOR_ENABLED,    default ON)
 *   - `project_supervisors_enabled` (env PROJECT_SUPERVISORS_ENABLED, default ON)
 * Flipped LIVE by `PUT /api/crossmodel/admin/settings/<key>` (admin-only;
 * cache invalidated on the same box, every other box converges within 60 s).
 *
 * SEMANTICS WHILE OFF — deterministic and FAIL-OPEN (the switch can only
 * REMOVE supervisor work; it never blocks lanes or user chats):
 *   - ensureFleetSupervisor / ensureProjectSupervisor return the EXISTING chat
 *     without healing or arming anything, and create nothing when none exists;
 *   - every MACHINE wake of a supervisor chat is SKIPPED at its entry point:
 *     hook deliveries (hooks.service deliverHookGroup — rows terminal-marked
 *     `skipped:supervisor_off`, NEVER replayed on re-enable), schedule firings
 *     (coding/schedule.service — the row's cadence slides, no run, no cap
 *     token; a `once` row re-arms 15 min out so it fires once re-enabled),
 *     the stock sweeps (gated BEFORE sweep_triage, so the heartbeat floor never
 *     fires either), infra-watch / product-watch alert wakes (deliver() —
 *     the Redis dedupe key is NOT set, so an alert still true at re-enable
 *     fires then), follow-through nudges and auto-filings, the watchdog's
 *     stuck-note nudge, and the plain-chat machine-run backstop
 *     (chat-agent.service startDetachedChatRun: agent messages / webhooks /
 *     queue drains into a supervisor chat leave the message queued and start
 *     no run);
 *   - the start_coding_session spawn guard refuses a spawn BY a supervisor
 *     lane whose switch is off (clear message, no side effect);
 *   - an in-flight supervisor run is NEVER killed — it finishes;
 *   - a HUMAN turn typed into a supervisor chat still runs (user chats are
 *     never blocked); the switch removes machine work only.
 *
 * Every skip writes ONE loop_metrics row kind `supervisor_switch`
 * {target:'fleet'|'project', action:'skipped', source:<entry point>, chatId,
 * suppressed} — rate-limited per (target, source, chat) to one row per
 * SUPERVISOR_SWITCH_METRIC_WINDOW_MS (the `suppressed` count carries the
 * coalesced skips) so a busy fleet cannot storm the table — plus an EXACT
 * Redis counter (`supervisor_switch:skipped:<target>`, reset on every flip)
 * that the status card / owner briefing / board digest quote as "wakes
 * skipped: N". A flip writes {target, action:'flipped', enabled, by}.
 *
 * ADMIN-ONLY BY CONSTRUCTION: no platform tool writes SystemSettings
 * (ADMIN_ONLY_SETTING_KEYS is the pin — supervisor-switch.test.ts scans the
 * tool schemas), so a supervisor can never re-enable itself; the doctrine
 * (supervisor-doctrine.ts FLEET_FACTS) tells it so.
 *
 * Import discipline: LEAF-ish — static imports only config/database,
 * utils/logger and loop-metrics.service (every importer of this module already
 * loads those); config/redis is loaded LAZILY inside the counter helpers so a
 * suite that never mocks redis (board-digest, supervisor.service, …) does not
 * pull config/env at import time. Every read is wrapped: a missing prisma /
 * redis surface (partial test mocks, an outage) resolves to ENABLED.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric } from './loop-metrics.service';

/** Lazy redis handle (never at module load — see the import-discipline note). */
async function redis(): Promise<any> {
  const mod = await import('../../../config/redis');
  return (mod as any).default ?? mod;
}

export const FLEET_SUPERVISOR_ENABLED_KEY = 'fleet_supervisor_enabled';
export const PROJECT_SUPERVISORS_ENABLED_KEY = 'project_supervisors_enabled';
/** Companion row `<key>_by` holds the admin identity that last flipped the key. */
export const SUPERVISOR_SWITCH_BY_SUFFIX = '_by';
export const FLEET_SUPERVISOR_ENABLED_ENV = 'FLEET_SUPERVISOR_ENABLED';
export const PROJECT_SUPERVISORS_ENABLED_ENV = 'PROJECT_SUPERVISORS_ENABLED';

export type SupervisorSwitchTarget = 'fleet' | 'project';
export const SUPERVISOR_SWITCH_TARGETS: readonly SupervisorSwitchTarget[] = ['fleet', 'project'];

/** SystemSetting keys that ONLY the admin REST route may write — never a platform tool. */
export const ADMIN_ONLY_SETTING_KEYS: readonly string[] = [
  FLEET_SUPERVISOR_ENABLED_KEY,
  PROJECT_SUPERVISORS_ENABLED_KEY,
  `${FLEET_SUPERVISOR_ENABLED_KEY}${SUPERVISOR_SWITCH_BY_SUFFIX}`,
  `${PROJECT_SUPERVISORS_ENABLED_KEY}${SUPERVISOR_SWITCH_BY_SUFFIX}`,
  // The always-Auto switch (rate-limit.service PATIENCE_AUTO_ONLY_KEY) and its
  // audit companion — same admin-only posture since the 2026-09-26 audit
  // (string literals: this module stays leaf-ish).
  'patience_auto_only',
  'patience_auto_only_by',
];

/** loop_metrics kind (mirrored in LOOP_METRIC_KINDS.SUPERVISOR_SWITCH). */
export const SUPERVISOR_SWITCH_METRIC_KIND = 'supervisor_switch';
/** Terminal status stamped on skipped hook rows / schedule rows. */
export const SUPERVISOR_SWITCH_SKIPPED_STATUS = 'skipped:supervisor_off';
/** fireScheduleTarget / sweeper reason for a skipped firing. */
export const SUPERVISOR_SWITCH_SKIP_REASON = 'supervisor_off';
/** Cached-reader TTL (≤ 60 s per the owner ask). */
export const SUPERVISOR_SWITCH_CACHE_TTL_MS = 60_000;
/** One telemetry row per (target, source, chat) per window; the rest coalesce into `suppressed`. */
export const SUPERVISOR_SWITCH_METRIC_WINDOW_MS = 5 * 60_000;
/** A `once` schedule row skipped while OFF re-arms this far out (fires once re-enabled). */
export const SUPERVISOR_SWITCH_ONCE_REARM_MS = 15 * 60_000;
/** Redis counter of skipped wakes since the last flip. */
export const skippedCounterKey = (target: SupervisorSwitchTarget): string => `supervisor_switch:skipped:${target}`;

const KEY_OF: Record<SupervisorSwitchTarget, string> = {
  fleet: FLEET_SUPERVISOR_ENABLED_KEY,
  project: PROJECT_SUPERVISORS_ENABLED_KEY,
};
const ENV_OF: Record<SupervisorSwitchTarget, string> = {
  fleet: FLEET_SUPERVISOR_ENABLED_ENV,
  project: PROJECT_SUPERVISORS_ENABLED_ENV,
};
const LABEL_OF: Record<SupervisorSwitchTarget, string> = {
  fleet: 'Fleet supervisor',
  project: 'Project supervisors',
};

/**
 * Parse a stored/posted switch value. 1|true|on → true, 0|false|off → false,
 * anything else → null (the PUT rejects it; a corrupt stored row reads as the
 * env boot default — never as OFF by accident).
 */
export function parseSwitchValue(v: unknown): boolean | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'off') return false;
  return null;
}

export function isSupervisorSwitchKey(key: unknown): key is string {
  return key === FLEET_SUPERVISOR_ENABLED_KEY || key === PROJECT_SUPERVISORS_ENABLED_KEY;
}

export function switchTargetForKey(key: string): SupervisorSwitchTarget | null {
  if (key === FLEET_SUPERVISOR_ENABLED_KEY) return 'fleet';
  if (key === PROJECT_SUPERVISORS_ENABLED_KEY) return 'project';
  return null;
}

/** Boot default: the env var unset (or unparseable) means ON. */
export function supervisorSwitchBootDefault(target: SupervisorSwitchTarget): boolean {
  const parsed = parseSwitchValue(process.env[ENV_OF[target]]);
  return parsed === null ? true : parsed;
}
export function fleetSupervisorEnabledBootDefault(): boolean { return supervisorSwitchBootDefault('fleet'); }
export function projectSupervisorsEnabledBootDefault(): boolean { return supervisorSwitchBootDefault('project'); }

// ── Cached readers ───────────────────────────────────────────────────────────

const cache: Record<SupervisorSwitchTarget, { value: boolean | null; at: number }> = {
  fleet: { value: null, at: 0 },
  project: { value: null, at: 0 },
};

/**
 * Is the switch ON? SystemSetting row wins (a parseable value); no row or an
 * unparseable value = the env boot default. Cached 60 s; a DB error returns
 * the last cached value, else the boot default — never throws, never turns a
 * supervisor OFF on an outage.
 */
export async function supervisorSwitchEnabled(target: SupervisorSwitchTarget): Promise<boolean> {
  const now = Date.now();
  const c = cache[target];
  if (c.value !== null && now - c.at < SUPERVISOR_SWITCH_CACHE_TTL_MS) return c.value;
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: KEY_OF[target] } });
    const parsed = row ? parseSwitchValue(row.value) : null;
    c.value = parsed === null ? supervisorSwitchBootDefault(target) : parsed;
    c.at = now;
    return c.value;
  } catch (err: any) {
    logger.warn(`supervisor-switch: failed to read ${KEY_OF[target]} (using the cached/boot value): ${err?.message ?? err}`);
    return c.value ?? supervisorSwitchBootDefault(target);
  }
}
export async function getFleetSupervisorEnabled(): Promise<boolean> { return supervisorSwitchEnabled('fleet'); }
export async function getProjectSupervisorsEnabled(): Promise<boolean> { return supervisorSwitchEnabled('project'); }

/** Force-invalidate both cached switches (admin PUT; tests). */
export function invalidateSupervisorSwitchCache(): void {
  cache.fleet = { value: null, at: 0 };
  cache.project = { value: null, at: 0 };
  metricWindow.clear();
}

// ── State (admin GET + surfaces) ─────────────────────────────────────────────

export interface SupervisorSwitchTargetState {
  target: SupervisorSwitchTarget;
  key: string;
  enabled: boolean;
  /** ISO of the last flip write (the SystemSetting row's updatedAt); null = never set (env default in force). */
  since: string | null;
  /** Admin identity (email) that last flipped it; null = never set / pre-audit row. */
  updatedBy: string | null;
  /** Machine wakes skipped since the last flip; null = counter unreadable. */
  skipped: number | null;
  /** Where the effective value comes from. */
  source: 'setting' | 'env';
  bootDefault: boolean;
  envVar: string;
}

export interface SupervisorSwitchState {
  fleet: SupervisorSwitchTargetState;
  project: SupervisorSwitchTargetState;
  /** The harness-composed status line (null when both switches are ON). */
  line: string | null;
}

async function readSkipped(target: SupervisorSwitchTarget): Promise<number | null> {
  try {
    const raw = await (await redis()).get(skippedCounterKey(target));
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readTargetState(target: SupervisorSwitchTarget): Promise<SupervisorSwitchTargetState> {
  const key = KEY_OF[target];
  const bootDefault = supervisorSwitchBootDefault(target);
  let enabled = bootDefault;
  let since: string | null = null;
  let updatedBy: string | null = null;
  let source: 'setting' | 'env' = 'env';
  try {
    const [row, byRow] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key } }),
      prisma.systemSetting.findUnique({ where: { key: `${key}${SUPERVISOR_SWITCH_BY_SUFFIX}` } }),
    ]);
    const parsed = row ? parseSwitchValue(row.value) : null;
    if (parsed !== null) {
      enabled = parsed;
      source = 'setting';
      since = row?.updatedAt ? new Date(row.updatedAt).toISOString() : null;
      updatedBy = byRow?.value ? String(byRow.value) : null;
    }
  } catch (err: any) {
    logger.warn(`supervisor-switch: state read failed for ${key} (reporting the cached/boot value): ${err?.message ?? err}`);
    enabled = cache[target].value ?? bootDefault;
  }
  const skipped = enabled ? 0 : await readSkipped(target);
  return { target, key, enabled, since, updatedBy, skipped, source, bootDefault, envVar: ENV_OF[target] };
}

/** Both switches with since / updatedBy / skipped — the admin GET + every surface. Never throws. */
export async function getSupervisorSwitchState(): Promise<SupervisorSwitchState> {
  const [fleet, project] = await Promise.all([readTargetState('fleet'), readTargetState('project')]);
  return { fleet, project, line: supervisorSwitchLine({ fleet, project }) };
}

/** Compact "OFF since <time> by <who> — wakes skipped: N" line per OFF target; null when both are ON. */
export function supervisorSwitchLine(state: { fleet: SupervisorSwitchTargetState; project: SupervisorSwitchTargetState }): string | null {
  const parts: string[] = [];
  for (const t of [state.fleet, state.project]) {
    if (t.enabled) continue;
    const since = t.since ? new Date(t.since).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : `boot (env ${t.envVar})`;
    const by = t.updatedBy ?? (t.source === 'env' ? 'env' : 'unknown');
    const skipped = t.skipped == null ? 'n/a' : String(t.skipped);
    parts.push(`${LABEL_OF[t.target]}: OFF since ${since} by ${by} — wakes skipped: ${skipped}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

// ── Flip (admin PUT) ─────────────────────────────────────────────────────────

export interface SupervisorSwitchFlipResult {
  target: SupervisorSwitchTarget;
  key: string;
  enabled: boolean;
  /** false = the stored value already matched — nothing written, `since` untouched. */
  changed: boolean;
  setting: { key: string; value: string; updatedAt?: Date } | null;
}

/**
 * Write a switch (idempotent): reads the current effective value first and
 * returns changed:false without touching the row when it already matches —
 * so `since` (the row's updatedAt) stays honest. A real flip upserts the value
 * + the `<key>_by` audit row, invalidates the cache, resets the skip counter
 * and writes the {action:'flipped'} telemetry row.
 */
export async function setSupervisorSwitch(key: string, enabled: boolean, by: string): Promise<SupervisorSwitchFlipResult> {
  const target = switchTargetForKey(key);
  if (!target) throw new Error(`not a supervisor switch key: ${key}`);
  const current = await supervisorSwitchEnabledFresh(target);
  if (current === enabled) {
    const row = await prisma.systemSetting.findUnique({ where: { key } }).catch(() => null);
    return { target, key, enabled, changed: false, setting: row ? { key: row.key, value: row.value, updatedAt: row.updatedAt } : null };
  }
  const value = enabled ? '1' : '0';
  const setting = await prisma.systemSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  await prisma.systemSetting.upsert({
    where: { key: `${key}${SUPERVISOR_SWITCH_BY_SUFFIX}` },
    update: { value: by },
    create: { key: `${key}${SUPERVISOR_SWITCH_BY_SUFFIX}`, value: by },
  }).catch((err: any) => logger.warn(`supervisor-switch: audit row write failed for ${key}: ${err?.message ?? err}`));
  invalidateSupervisorSwitchCache();
  try { await (await redis()).del(skippedCounterKey(target)); } catch { /* counter reset is best-effort */ }
  recordLoopMetric({ kind: SUPERVISOR_SWITCH_METRIC_KIND, meta: { target, action: 'flipped', enabled, by } });
  logger.info(`supervisor-switch: ${LABEL_OF[target]} turned ${enabled ? 'ON' : 'OFF'} by ${by}`);
  return { target, key, enabled, changed: true, setting: { key: setting.key, value: setting.value, updatedAt: setting.updatedAt } };
}

/** Uncached read (the PUT must compare against the STORED truth, not a stale cache). */
async function supervisorSwitchEnabledFresh(target: SupervisorSwitchTarget): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY_OF[target] } });
  const parsed = row ? parseSwitchValue(row.value) : null;
  return parsed === null ? supervisorSwitchBootDefault(target) : parsed;
}

// ── Skips (every entry point) ────────────────────────────────────────────────

const metricWindow = new Map<string, { at: number; suppressed: number }>();
const METRIC_WINDOW_MAX_KEYS = 2_000;

/**
 * Record ONE skipped wake: exact Redis counter (fire-and-forget) + a
 * rate-limited loop_metrics row. Synchronous from the caller's point of view
 * (never awaited on the hot path), never throws.
 */
export function recordSupervisorSwitchSkip(input: { target: SupervisorSwitchTarget; source: string; chatId?: string | null }): void {
  const { target, source } = input;
  const chatId = input.chatId ?? null;
  // Exact counter — fire-and-forget; a missing redis surface (partial mocks)
  // or an outage never blocks the skip, the row below still lands.
  void redis().then((r) => r.incr(skippedCounterKey(target))).catch(() => {});
  try {
    const now = Date.now();
    const key = `${target}:${source}:${chatId ?? '-'}`;
    if (metricWindow.size > METRIC_WINDOW_MAX_KEYS) metricWindow.clear();
    const w = metricWindow.get(key);
    if (w && now - w.at < SUPERVISOR_SWITCH_METRIC_WINDOW_MS) {
      w.suppressed += 1;
      return;
    }
    const suppressed = w?.suppressed ?? 0;
    metricWindow.set(key, { at: now, suppressed: 0 });
    recordLoopMetric({
      kind: SUPERVISOR_SWITCH_METRIC_KIND,
      ...(chatId ? { sessionId: chatId } : {}),
      meta: { target, action: 'skipped', source, chatId, suppressed },
    });
    logger.info(`supervisor-switch: ${LABEL_OF[target]} OFF — ${source} wake skipped${chatId ? ` for chat ${chatId.slice(0, 8)}` : ''}${suppressed ? ` (+${suppressed} coalesced)` : ''}`);
  } catch { /* telemetry never blocks a skip */ }
}

/** Test seam: forget the per-key telemetry windows. */
export function resetSupervisorSwitchMetricWindowForTests(): void { metricWindow.clear(); }

/** Which switch governs a chat row — null for a plain chat (no read, no cost). */
export function supervisorTargetFor(chat: { isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null } | null | undefined): SupervisorSwitchTarget | null {
  if (!chat) return null;
  if (chat.isSupervisor === true) return 'fleet';
  if (chat.isProjectSupervisor === true) return 'project';
  return null;
}

/**
 * THE gate every wake entry point calls: returns the governing target when the
 * wake must be SKIPPED (and records the skip), null when it may proceed. A
 * plain chat costs nothing; a supervisor chat costs one cached read. Any
 * failure resolves to null (fail-open).
 */
export async function supervisorWakeSkip(
  chat: { isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null } | null | undefined,
  source: string,
  chatId?: string | null,
): Promise<SupervisorSwitchTarget | null> {
  try {
    const target = supervisorTargetFor(chat);
    if (!target) return null;
    if (await supervisorSwitchEnabled(target)) return null;
    recordSupervisorSwitchSkip({ target, source, chatId });
    return target;
  } catch {
    return null;
  }
}

/** True when EITHER switch is OFF — the cheap pre-check before a chat-flag read on hot paths. */
export async function anySupervisorSwitchOff(): Promise<boolean> {
  try {
    const [fleet, project] = await Promise.all([supervisorSwitchEnabled('fleet'), supervisorSwitchEnabled('project')]);
    return !fleet || !project;
  } catch {
    return false;
  }
}

/**
 * Wake gate for a chat known only by id (schedule sweeper, detached-run
 * backstop): reads the two flags ONLY when a switch is actually off, so the
 * all-ON steady state adds no query. Fail-open.
 */
export async function supervisorWakeSkipById(chatId: string | null | undefined, source: string): Promise<SupervisorSwitchTarget | null> {
  try {
    if (!chatId) return null;
    if (!(await anySupervisorSwitchOff())) return null;
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: chatId },
      select: { isSupervisor: true, isProjectSupervisor: true },
    });
    return supervisorWakeSkip(chat, source, chatId);
  } catch {
    return null;
  }
}

/** The start_coding_session refusal for a supervisor-class caller whose switch is OFF (null = proceed). */
export async function supervisorSpawnRefusal(target: SupervisorSwitchTarget, callerChatId: string): Promise<string | null> {
  try {
    if (await supervisorSwitchEnabled(target)) return null;
    recordSupervisorSwitchSkip({ target, source: 'spawn_guard', chatId: callerChatId });
    return `Child-session spawn REFUSED: the ${LABEL_OF[target]} switch is OFF (Account → Admin → Settings → Supervisors; SystemSetting ${KEY_OF[target]}). While it is off no supervisor lane may dispatch, schedule or be woken — this is an admin decision, not a gate you can clear: do not re-arm, relay through a peer, or file a ticket to re-enable it. An admin turns it back on to resume.`;
  } catch {
    return null;
  }
}

/** Human label used by surfaces + refusals. */
export function supervisorSwitchLabel(target: SupervisorSwitchTarget): string { return LABEL_OF[target]; }

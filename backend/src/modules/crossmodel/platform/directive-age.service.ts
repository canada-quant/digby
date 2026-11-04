/**
 * Directive age sweep (supervisor-directives-closure D2, 2026-09-27).
 * Rides the attention watchdog's 15-minute sweep, next to follow-through.
 *
 * The finding: a supervisor directive had no age alarm — `status` is
 * open|done only, the 7-day archive kept status open while hiding the row,
 * and no metric measured how long an owner order sat untouched. The canlaw
 * H100-move order sat 41 h unacted; spark showed 6 archived-but-open rows.
 *
 * Two surfaces here (the third — the DIRECTIVE AGE ALARM line — lives in
 * supervisor-state.service formatStateForWake):
 *
 *  1. [FOLLOW-THROUGH — DIRECTIVE] wake: every OPEN, non-standing directive
 *     (live or archived) with NO evidence recorded and age ≥
 *     DIRECTIVE_FOLLOW_THROUGH_MS (24 h) earns ONE direct wake per directive
 *     per 24 h naming it (id, age, scope, text) — up to
 *     DIRECTIVE_AGE_WAKE_MAX_NAMED per wake, oldest first, folded into ONE
 *     wake. The wake asks for exactly two outcomes: act on the order and
 *     record the dispatch id as evidence on the OPEN row (closing only once
 *     the artifact has landed — a dispatch is progress, not done), or record
 *     the blocker as evidence on the open row.
 *
 *     Review fix (bounded volume): these wakes are todo_wake rows — ALARM-
 *     CLASS, so they bypass the supervisor's N/day machine-run cap — and the
 *     per-sweep fold alone only spaced them 15 min apart (a ledger of N
 *     evidence-less rows meant ceil(N/5) alarm runs per day, starting with a
 *     burst over every pre-existing open row on first deploy, since no prior
 *     doctrine asked for evidence on OPEN rows). Two bounds now:
 *       - DIRECTIVE_AGE_WAKE_MAX_PER_DAY (default 1) wakes per SUPERVISOR per
 *         24 h (Redis INCR + EXPIRE); the wake-block alarm line carries the
 *         rest of the ledger every wake anyway;
 *       - a first-deploy RAMP: for DIRECTIVE_AGE_WAKE_RAMP_MS (default 48 h)
 *         after the sweep's first run (Redis `directive-age:live-since`, SET
 *         NX) only the alarm line + the daily metric run — no wakes; 0
 *         disables the ramp.
 *     A withheld wake (ramp or cap) is recorded ONCE per supervisor per 24 h
 *     as a `directive_follow_through` row with outcome 'ramp' | 'capped' so
 *     the volume stays observable; a fired one carries outcome 'fired'.
 *  2. `directive_open_age` loop metric: ONE row per supervisor chat per day,
 *     value = age in HOURS of the oldest open-without-evidence directive (0
 *     when none), meta counts (open / openNoEvidence / overAlarm /
 *     archivedOpen) — the series that shows whether orders are being acted on.
 *
 * Dedupe is an atomic Redis SET NX (claimOnce): a Redis failure means "not
 * claimed" ⇒ NO wake / NO row this sweep (storm-proof — a 15-min repeat of a
 * follow-through wake would be worse than a missed one); a failed wake
 * enqueue releases its claims so the next sweep retries. Posture: per-owner
 * scoped, paused/detached/switched-off supervisors skipped, best-effort,
 * never throws into the cron loop.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { recordLoopMetric } from './loop-metrics.service';
import { modelToolName } from '../coding/tool-scope';
import { getFleetSupervisorEnabled, getProjectSupervisorsEnabled, recordSupervisorSwitchSkip } from './supervisor-switch';
import {
  DIRECTIVE_AGE_ALARM_MS,
  DIRECTIVE_FOLLOW_THROUGH_MS,
  parseSupervisorStateDoc,
  unactedDirectives,
  type SupervisorStateDoc,
  type UnactedDirective,
} from './supervisor-state.service';

const SOURCE = 'directive-age';

export const DIRECTIVE_AGE_MAX_SUPERVISORS = 300;
/** One wake per directive per this long. */
export const DIRECTIVE_AGE_WAKE_DEDUPE_SEC = 24 * 3600;
/** One directive_open_age row per supervisor chat per this long. */
export const DIRECTIVE_AGE_METRIC_DEDUPE_SEC = 24 * 3600;
/** Directives named in one wake (oldest first); the rest ride the alarm line and the next allowed wake. */
export const DIRECTIVE_AGE_WAKE_MAX_NAMED = 5;
/** Follow-through wakes per SUPERVISOR per 24 h (alarm-class rows bypass the daily machine-run cap — this is their bound). 0 = no wakes. */
export const DIRECTIVE_AGE_WAKE_MAX_PER_DAY_ENV = 'DIRECTIVE_AGE_WAKE_MAX_PER_DAY';
export const DIRECTIVE_AGE_WAKE_MAX_PER_DAY_DEFAULT = 1;
export const DIRECTIVE_AGE_WAKE_CAP_SEC = 24 * 3600;
/** First-deploy ramp: no wakes for this long after the sweep first runs (alarm line + metric only). 0 disables. */
export const DIRECTIVE_AGE_WAKE_RAMP_MS_ENV = 'DIRECTIVE_AGE_WAKE_RAMP_MS';
export const DIRECTIVE_AGE_WAKE_RAMP_MS_DEFAULT = 48 * 3600 * 1000;
/** The sweep's first-run stamp (SET NX; a lost key re-arms one ramp — fail-quiet). */
export const LIVE_SINCE_KEY = 'directive-age:live-since';
export const LIVE_SINCE_TTL_SEC = 400 * 24 * 3600;
export const DIRECTIVE_WAKE_PREFIX = '[FOLLOW-THROUGH — DIRECTIVE]';
export const WAKE_KEY = (chatId: string, directiveId: string) => `directive-age:wake:${chatId}:${directiveId}`;
export const METRIC_KEY = (chatId: string) => `directive-age:metric:${chatId}`;
export const WAKE_CAP_KEY = (chatId: string) => `directive-age:wake-cap:${chatId}`;
export const WITHHELD_KEY = (chatId: string) => `directive-age:withheld:${chatId}`;

export function directiveAgeWakeMaxPerDay(): number {
  const raw = process.env[DIRECTIVE_AGE_WAKE_MAX_PER_DAY_ENV];
  if (raw === undefined || raw.trim() === '') return DIRECTIVE_AGE_WAKE_MAX_PER_DAY_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DIRECTIVE_AGE_WAKE_MAX_PER_DAY_DEFAULT;
}

export function directiveAgeWakeRampMs(): number {
  const raw = process.env[DIRECTIVE_AGE_WAKE_RAMP_MS_ENV];
  if (raw === undefined || raw.trim() === '') return DIRECTIVE_AGE_WAKE_RAMP_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DIRECTIVE_AGE_WAKE_RAMP_MS_DEFAULT;
}

interface SupervisorRow { id: string; userId: string; title: string | null; projectId: string | null; isSupervisor: boolean | null; isProjectSupervisor: boolean | null }

export interface DirectiveAgeDeps {
  now?: Date;
  enqueueDirectWake?: (opts: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<{ ok: boolean } | unknown>;
}

export interface DirectiveAgeStats {
  open: number;
  openNoEvidence: number;
  overAlarm: number;
  archivedOpen: number;
  oldestAgeHours: number;
  oldestId: string | null;
  overdueIds: string[];
}

export type DirectiveWakeOutcome = 'fired' | 'ramp' | 'capped';

const hours = (ms: number): number => Math.round((ms / 3_600_000) * 10) / 10;
const ageLabel = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

/** Per-doc counts for the daily row. Pure; exported for tests. */
export function directiveAgeStats(doc: SupervisorStateDoc, now: Date = new Date()): DirectiveAgeStats {
  const isOpen = (d: { status: string }) => d.status === 'open';
  const open = doc.directives.filter(isOpen).length + doc.archived.filter(isOpen).length;
  const archivedOpen = doc.archived.filter(isOpen).length;
  const noEvidence = unactedDirectives(doc, now, 0);
  const overAlarm = noEvidence.filter((d) => d.ageMs >= DIRECTIVE_AGE_ALARM_MS);
  const oldest = noEvidence[0] ?? null;
  return {
    open,
    openNoEvidence: noEvidence.length,
    overAlarm: overAlarm.length,
    archivedOpen,
    oldestAgeHours: oldest ? hours(oldest.ageMs) : 0,
    oldestId: oldest ? oldest.id.slice(0, 8) : null,
    overdueIds: overAlarm.slice(0, 8).map((d) => d.id.slice(0, 8)),
  };
}

/** The wake prompt naming the overdue directives. Pure; exported for tests. */
export function renderDirectiveFollowThroughWake(rows: UnactedDirective[], now: Date = new Date()): string {
  const named = rows.slice(0, DIRECTIVE_AGE_WAKE_MAX_NAMED);
  const lines = named.map((d) => `- [${d.id}] open ${ageLabel(d.ageMs)}${d.scope ? ` [scope: ${d.scope}]` : ''}${d.archived ? ' [ARCHIVED-but-open — revive with {id, status:\'open\'} or close it where it lies]' : ''}: "${d.text.slice(0, 220)}"`);
  const more = rows.length > named.length ? `\n(+${rows.length - named.length} more overdue — get_supervisor_state({section:'directives'}) lists them; the [SUPERVISOR STATE] alarm line carries them every wake.)` : '';
  const tool = modelToolName('update_supervisor_state');
  return [
    `${DIRECTIVE_WAKE_PREFIX} ${named.length} owner directive(s) have been OPEN for over ${Math.round(DIRECTIVE_FOLLOW_THROUGH_MS / 3_600_000)}h with NO evidence recorded against them (as of ${now.toISOString().slice(0, 16)}Z):`,
    ...lines,
    `An order is not acted on by being remembered. For EACH row above, THIS wake, do one of two things and nothing else counts: (a) act on it — dispatch it (send_chat_message / start_coding_session / schedule_message) and record the returned id AS EVIDENCE on the OPEN row: ${tool}({directives:[{id, evidence:'dispatched: session <id>'}]}) — the row stays open. Close it with ${tool}({directives:[{id, status:'done', evidence:'<type> <id>'}]}) ONLY once the artifact has landed and you verified it this wake — a dispatch is progress, not done — and the id comes from YOUR OWN tool result (a session/ticket/msg/oq id, a receipt/run id you were handed, or the PR a lane of this account opened); or (b) if it cannot be done yet, record the blocker AS EVIDENCE on the open row — ${tool}({directives:[{id, evidence:'blocked: <what is missing> (msg <id> / oq_<id> / ticket <id>)'}]}) — so the age alarm clears and the next wake sees the blocker instead of an untouched order. If the order was superseded by the owner, close it citing the superseding owner message (msg <id>). A note that restates the directive without (a) or (b) is the failure this wake exists to end.${more}`,
  ].join('\n');
}

/** Atomic once-per-TTL claim. Redis failure ⇒ false (skip — never a 15-min storm). */
async function claimOnce(key: string, ttlSec: number): Promise<boolean> {
  try {
    const res = await (redisClient as any).set(key, String(Date.now()), { NX: true, EX: ttlSec });
    return res === 'OK';
  } catch {
    return false;
  }
}

async function releaseClaim(key: string): Promise<void> {
  try { await (redisClient as any).del(key); } catch { /* best effort */ }
}

/** Per-supervisor daily slot: INCR + EXPIRE on first; true while count ≤ max. Redis failure ⇒ false. */
async function claimDailySlot(key: string, max: number): Promise<boolean> {
  try {
    const n = Number(await (redisClient as any).incr(key));
    if (n === 1) await (redisClient as any).expire(key, DIRECTIVE_AGE_WAKE_CAP_SEC);
    return Number.isFinite(n) && n <= max;
  } catch {
    return false;
  }
}

async function refundDailySlot(key: string): Promise<void> {
  try { await (redisClient as any).decr(key); } catch { /* best effort */ }
}

/**
 * True while the first-deploy ramp holds (wakes withheld). Computed ONCE per
 * sweep. The stamp is SET NX on first sight; an unreadable stamp (Redis
 * failure) counts as "in ramp" — the storm-proof default.
 */
export async function directiveAgeRampActive(now: Date): Promise<boolean> {
  const rampMs = directiveAgeWakeRampMs();
  if (rampMs <= 0) return false;
  try {
    const set = await (redisClient as any).set(LIVE_SINCE_KEY, String(now.getTime()), { NX: true, EX: LIVE_SINCE_TTL_SEC });
    if (set === 'OK') return true; // first run — the ramp starts now
    const since = Number(await (redisClient as any).get(LIVE_SINCE_KEY));
    if (!Number.isFinite(since)) return true;
    return now.getTime() - since < rampMs;
  } catch {
    return true;
  }
}

interface SweepCtx { now: Date; inRamp: boolean; maxPerDay: number; deps: DirectiveAgeDeps; counters: { wakes: number; metrics: number; withheld: number } }

/** ONE withheld row per supervisor per 24 h (outcome ramp | capped) — the volume the bounds hide stays observable. */
async function recordWithheld(sup: SupervisorRow, outcome: Exclude<DirectiveWakeOutcome, 'fired'>, claimed: UnactedDirective[], overdue: UnactedDirective[], ctx: SweepCtx): Promise<void> {
  if (!(await claimOnce(WITHHELD_KEY(sup.id), DIRECTIVE_AGE_WAKE_CAP_SEC))) return;
  ctx.counters.withheld++;
  recordLoopMetric({
    kind: 'directive_follow_through',
    sessionId: sup.id,
    meta: { outcome, directiveIds: claimed.map((d) => d.id.slice(0, 8)), overdue: overdue.length, oldestAgeHours: hours(overdue[0].ageMs), ...(sup.projectId ? { projectId: sup.projectId } : {}) },
  });
}

async function sweepSupervisor(sup: SupervisorRow, doc: SupervisorStateDoc, ctx: SweepCtx): Promise<void> {
  const { now, deps, counters } = ctx;
  const projectMeta = sup.projectId ? { projectId: sup.projectId } : {};
  // (2) the daily row — recorded even at zero so the series is complete.
  if (await claimOnce(METRIC_KEY(sup.id), DIRECTIVE_AGE_METRIC_DEDUPE_SEC)) {
    const stats = directiveAgeStats(doc, now);
    recordLoopMetric({ kind: 'directive_open_age', sessionId: sup.id, value: stats.oldestAgeHours, unit: 'h', meta: { ...stats, ...projectMeta } });
    counters.metrics++;
  }
  // (1) the follow-through wake — oldest first, one claim per directive.
  const overdue = unactedDirectives(doc, now, DIRECTIVE_FOLLOW_THROUGH_MS);
  if (!overdue.length) return;
  const claimed: UnactedDirective[] = [];
  const claimedKeys: string[] = [];
  for (const d of overdue) {
    if (claimed.length >= DIRECTIVE_AGE_WAKE_MAX_NAMED) break;
    const key = WAKE_KEY(sup.id, d.id);
    if (await claimOnce(key, DIRECTIVE_AGE_WAKE_DEDUPE_SEC)) { claimed.push(d); claimedKeys.push(key); }
  }
  if (!claimed.length) return;
  // First-deploy ramp: the alarm line + metric already ran; no wake yet. The
  // directive claims are released so the rows get their wake once the ramp ends.
  if (ctx.inRamp) {
    await Promise.all(claimedKeys.map(releaseClaim));
    await recordWithheld(sup, 'ramp', claimed, overdue, ctx);
    return;
  }
  // Per-supervisor daily cap (alarm-class wakes bypass the machine-run cap — this is their bound).
  const capKey = WAKE_CAP_KEY(sup.id);
  if (!(await claimDailySlot(capKey, ctx.maxPerDay))) {
    await Promise.all(claimedKeys.map(releaseClaim));
    await recordWithheld(sup, 'capped', claimed, overdue, ctx);
    return;
  }
  const wake = deps.enqueueDirectWake ?? (async (o) => (await import('./hooks.service')).enqueueDirectWake(o));
  const unclaimedRest = overdue.filter((d) => !claimed.includes(d));
  try {
    const res: any = await wake({
      targetChatId: sup.id,
      prompt: renderDirectiveFollowThroughWake([...claimed, ...unclaimedRest], now),
      meta: { origin: SOURCE, kind: 'directive_follow_through', directiveIds: claimed.map((d) => d.id) },
    });
    if (res && typeof res === 'object' && 'ok' in res && res.ok === false) throw new Error(String(res.error ?? 'enqueue refused'));
    counters.wakes++;
    recordLoopMetric({ kind: 'directive_follow_through', sessionId: sup.id, meta: { outcome: 'fired' as DirectiveWakeOutcome, directiveIds: claimed.map((d) => d.id.slice(0, 8)), overdue: overdue.length, oldestAgeHours: hours(claimed[0].ageMs), archivedNamed: claimed.filter((d) => d.archived).length, ...projectMeta } });
  } catch (err: any) {
    // Release the claims (and the daily slot) so the next sweep retries instead of waiting 24h.
    await Promise.all([...claimedKeys.map(releaseClaim), refundDailySlot(capKey)]);
    logger.warn(`${SOURCE}: wake enqueue failed for ${sup.id.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
  }
}

/** One sweep over every fleet + ENABLED, attached project supervisor. Never throws. */
export async function sweepDirectiveAge(deps: DirectiveAgeDeps = {}): Promise<{ supervisors: number; wakes: number; metrics: number; withheld: number }> {
  const counters = { supervisors: 0, wakes: 0, metrics: 0, withheld: 0 };
  const now = deps.now ?? new Date();
  let sups: SupervisorRow[] = [];
  try {
    sups = (await prisma.crossModelChat.findMany({
      // Detached project supervisors (projectId null) are never scanned — the watchdog's rule.
      where: { OR: [{ isSupervisor: true }, { isProjectSupervisor: true, projectId: { not: null } }], archivedAt: null },
      select: { id: true, userId: true, title: true, projectId: true, isSupervisor: true, isProjectSupervisor: true },
      take: DIRECTIVE_AGE_MAX_SUPERVISORS,
    })) as SupervisorRow[];
  } catch (err: any) {
    logger.warn(`${SOURCE}: supervisor listing failed: ${err?.message ?? err}`, { source: SOURCE });
    return counters;
  }
  sups = sups.filter((s) => s.isSupervisor || (s.isProjectSupervisor && s.projectId));
  // Paused (pause-never-delete) or archived projects: their supervisor stays flagged but must not be woken.
  const projectIds = [...new Set(sups.filter((s) => !s.isSupervisor && s.projectId).map((s) => s.projectId as string))];
  if (projectIds.length) {
    const projects = await prisma.crossModelProject.findMany({ where: { id: { in: projectIds } }, select: { id: true, projectSupervisorEnabled: true, archivedAt: true } }).catch(() => [] as any[]);
    const enabled = new Set((projects as any[]).filter((p) => p.projectSupervisorEnabled === true && !p.archivedAt).map((p) => p.id));
    sups = sups.filter((s) => s.isSupervisor || enabled.has(s.projectId as string));
  }
  // Supervisor OFF switch: drop the switched-off tier (one skip row per lane, rate-limited inside). Fail-open.
  const [fleetOn, projectOn] = await Promise.all([
    getFleetSupervisorEnabled().catch(() => true),
    getProjectSupervisorsEnabled().catch(() => true),
  ]);
  if (!fleetOn || !projectOn) {
    sups = sups.filter((s) => {
      const target = s.isSupervisor ? 'fleet' : 'project';
      if ((target === 'fleet' && fleetOn) || (target === 'project' && projectOn)) return true;
      recordSupervisorSwitchSkip({ target, source: SOURCE, chatId: s.id });
      return false;
    });
  }
  counters.supervisors = sups.length;
  if (!sups.length) return counters;
  let docs = new Map<string, SupervisorStateDoc>();
  try {
    const rows = (await prisma.supervisorState.findMany({
      where: { chatId: { in: sups.map((s) => s.id) } },
      select: { chatId: true, state: true },
    })) as Array<{ chatId: string; state: unknown }>;
    docs = new Map(rows.map((r) => [r.chatId, parseSupervisorStateDoc(r.state)]));
  } catch (err: any) {
    logger.warn(`${SOURCE}: state listing failed: ${err?.message ?? err}`, { source: SOURCE });
    return counters;
  }
  const ctx: SweepCtx = { now, inRamp: await directiveAgeRampActive(now), maxPerDay: directiveAgeWakeMaxPerDay(), deps, counters };
  for (const sup of sups) {
    const doc = docs.get(sup.id);
    if (!doc) continue; // no doc yet — nothing to age
    try {
      await sweepSupervisor(sup, doc, ctx);
    } catch (err: any) {
      logger.warn(`${SOURCE}: sweep failed for ${sup.id.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }
  }
  if (counters.wakes || counters.metrics || counters.withheld) logger.info(`${SOURCE}: sweep supervisors=${counters.supervisors} wakes=${counters.wakes} metrics=${counters.metrics} withheld=${counters.withheld}${ctx.inRamp ? ' (ramp)' : ''}`, { source: SOURCE });
  return counters;
}

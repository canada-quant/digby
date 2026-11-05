/**
 * DECISION-GATE ROLLOUT AUTOMATON (rollout self-governance, 2026-09-27).
 *
 * WHY: the owner pre-authorised flipping purposes to act one by one as each
 * readiness bar holds ("why dont you just start flipping things and
 * monitoring"), and until now the flipping was a human session's loop — read
 * the readiness stamp, call the admin PUT, watch the auto-demote, write it up.
 * This module makes that loop the framework's own job: the worker cron
 * `decision-gate-rollout` runs after each readiness firing and, for every
 * TIER-1 purpose (decision-gate-registry.ts) that sits in shadow with a FRESH,
 * MEASURED READY stamp (never an owner-override stamp — `backend` names a
 * real backend and `metrics.n` clears the purpose's label bar) and no act cap,
 * flips it to act THROUGH THE SAME ADMISSION PATH THE ADMIN PUT USES
 * (decision-gate-modes updateDecisionModes — PURPOSE_ACT_CAPS, the READY
 * stamp, the primary-backend pin and the control gate are never bypassed),
 * records ONE loop_metrics `decision_gate_rollout` row per action, and keeps
 * a small store row (['instance','decision-gate'] / 'rollout') the owner
 * briefing, the framework-facts prompt layer and get_decision_gate_status
 * read. Tier-2 / tier-3 purposes that read READY are reported to the owner
 * as ONE owner question per purpose (deduped while open; a tier-2 question
 * answered with a GO flips on the next pass, a tier-3 question is
 * informational — never flipped here). A purpose auto-demoted TWICE within
 * ROLLOUT_DEMOTE_WINDOW_DAYS is PARKED for ROLLOUT_PARK_DAYS so it never
 * flip-flops; an OFF purpose is never touched; a store row that says act for
 * a purpose the code caps at shadow is REPORTED as an inconsistency, never
 * rewritten.
 *
 * SWITCHES: SystemSetting `decision_gate_auto_rollout` (admin PUT / the
 * Model roles panel; default ON — the owner pre-authorisation; env boot
 * default DECISION_GATE_AUTO_ROLLOUT=0 turns the default off);
 * DECISION_GATE_AUTO_ROLLOUT_DRY_RUN=1 logs + records what it WOULD flip and
 * writes no mode; DECISION_GATE_ROLLOUT_JOB_DISABLED=1 = the cron computes
 * nothing; DECISION_GATE_ROLLOUT_INTERVAL_MIN (default 60, clamped
 * 15..10080) is the cadence — a pass whose readiness report is not newer
 * than the previous pass's is a no-op, so the effective cadence is "once per
 * readiness firing". FAIL-OPEN: any failure logs and leaves every mode as it
 * was. The automaton can only ADD act on measured evidence; it never removes
 * act (auto-demote owns that). The ONE path that writes `off` is the registry
 * LIFECYCLE below, and only for purposes in SHADOW.
 *
 * LIFECYCLE ENFORCEMENT (DECISION-GATE-LIFECYCLE, 2026-10-20). The registry's
 * self-learning claims were decorative: `reviewBy` was read only by its type
 * (self_audit missed its 2026-10-12 bar and kept asking ~3k times / 30 d), and
 * five purposes sat at AUROC < 0.6 on n ≥ 200 (claim_evidenced 0.466) with
 * nothing to stop the asks. Each pass now (planLifecycle, pure):
 *   review_by      — a shadow_review purpose past its reviewBy date whose
 *                    machine-checkable reviewBar is unmet on the fresh stamp
 *                    is set OFF through the admin path (updateDecisionModes);
 *   non_converging — any SHADOW purpose whose fresh measured stamp reads
 *                    AUROC < NON_CONVERGING_MAX_AUROC on ≥
 *                    NON_CONVERGING_MIN_LABELS labels spanning ≥
 *                    NON_CONVERGING_MIN_DAYS days is PARKED (set OFF) and ONE
 *                    re-pose ticket is filed for it — only when that AUROC is
 *                    estimable (≥ NON_CONVERGING_MIN_OUTCOME_ROWS agreed AND
 *                    disagreed rows) and accuracy < NON_CONVERGING_MAX_ACCURACY;
 *                    never before a shadow_review row's reviewBy, never for a
 *                    purpose whose human-turn ask is retired (review fixes).
 * Each writes one `decision_gate_lifecycle_retired` loop_metrics row and an
 * owner-briefing line. Act purposes are never touched (auto-demote owns act);
 * a purpose a human restored after a lifecycle action is never retired again
 * for the same question (a re-posed partition is judged afresh); dry run
 * records what it WOULD do. Label collection stops for a parked question;
 * act consumers fail open. Kill switch DECISION_GATE_LIFECYCLE_ENFORCE_DISABLED=1.
 */

import logger from '../../../utils/logger';
import {
  DECISION_PURPOSES, getDecisionModeConfig, updateDecisionModes, readinessMaxAgeMs, purposeRetiredOnHumanTurns,
  type DecisionModeConfig, type DecisionModeOpts, type DecisionModeView,
} from './decision-gate-modes';
import type { DecisionPurpose } from './decision-gate';
import { DECISION_ROLE_REGISTRY, ROLLOUT_TIER_RULE, rolloutTierFor, type RolloutTier, type StorablePurpose } from './decision-gate-registry';
import { readinessBarsFor } from './decision-gate-fit';
import type { PurposeReadiness as StampEntry } from './decision-gate-readiness';
import { LOOP_METRIC_KINDS } from './loop-metric-kinds';

export const ROLLOUT_JOB_ID = 'decision-gate-rollout';
export const ROLLOUT_SETTING_KEY = 'decision_gate_auto_rollout';
export const ROLLOUT_SETTING_BY_SUFFIX = '_by';
export const ROLLOUT_ENV = 'DECISION_GATE_AUTO_ROLLOUT';
export const ROLLOUT_DRY_RUN_ENV = 'DECISION_GATE_AUTO_ROLLOUT_DRY_RUN';
export const ROLLOUT_JOB_DISABLED_ENV = 'DECISION_GATE_ROLLOUT_JOB_DISABLED';
export const ROLLOUT_INTERVAL_ENV = 'DECISION_GATE_ROLLOUT_INTERVAL_MIN';
export const ROLLOUT_INTERVAL_DEFAULT_MIN = 60;
export const ROLLOUT_METRIC_KIND = 'decision_gate_rollout';
export const ROLLOUT_STORE_NS = ['instance', 'decision-gate'];
export const ROLLOUT_STORE_KEY = 'rollout';
/** A purpose auto-demoted this many times inside the window is parked. */
export const ROLLOUT_DEMOTE_PARK_COUNT = 2;
export const ROLLOUT_DEMOTE_WINDOW_DAYS = 7;
export const ROLLOUT_PARK_DAYS = 7;
/** Actions kept on the store row (newest first). */
export const ROLLOUT_ACTIONS_KEEP = 50;
const SETTING_CACHE_TTL_MS = 60_000;
const STATE_CACHE_TTL_MS = 60_000;
export const ROLLOUT_ACTOR = 'auto-rollout';

const onFlag = (v: unknown): boolean => { const s = String(v ?? '').trim().toLowerCase(); return s === '1' || s === 'true' || s === 'on'; };
const offFlag = (v: unknown): boolean => { const s = String(v ?? '').trim().toLowerCase(); return s === '0' || s === 'false' || s === 'off'; };

// ── Lifecycle enforcement knobs (DECISION-GATE-LIFECYCLE, 2026-10-20 — see the header) ──
export const LIFECYCLE_ENFORCE_DISABLED_ENV = 'DECISION_GATE_LIFECYCLE_ENFORCE_DISABLED';
/** A shadow purpose whose measured AUROC stays below this … */
export const NON_CONVERGING_MAX_AUROC = 0.6;
/** … on at least this many labels … */
export const NON_CONVERGING_MIN_LABELS = 200;
/** … spanning at least this many days is parked (set off) with one re-pose ticket … */
export const NON_CONVERGING_MIN_DAYS = 10;
/**
 * … but ONLY when that AUROC is estimable and the question is not already
 * right most of the time (review fix, 2026-10-20). The stamp's AUROC is
 * auroc(1 − confidence, !agreed): whether low confidence FINDS the gate's
 * ERRORS. With a handful of errors it is a coin toss whatever the question's
 * quality (2 errors ⇒ P(AUROC < 0.6) ≈ 0.6), and `degenerateLabels` does not
 * cover it — that flag tests the yes / no split of the ACTUAL label, not the
 * agreed / disagreed split. So a park needs ≥ this many rows of EACH outcome
 * (agreed and disagreed) …
 */
export const NON_CONVERGING_MIN_OUTCOME_ROWS = 20;
/** … and an accuracy below this: a question right ≥ 90 % of the time converges — only its confidence ranking is weak (reported in `skipped`, never parked). */
export const NON_CONVERGING_MAX_ACCURACY = 0.9;
/** Stable title prefix of the re-pose ticket (the feedback dedupe keys on the whole title). */
export const LIFECYCLE_TICKET_PREFIX = '[decision-gate lifecycle]';
export function lifecycleEnforceDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env[LIFECYCLE_ENFORCE_DISABLED_ENV]); }

export function rolloutJobDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env[ROLLOUT_JOB_DISABLED_ENV]); }
export function rolloutDryRun(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env[ROLLOUT_DRY_RUN_ENV]); }
/** Boot default for the SystemSetting: ON unless DECISION_GATE_AUTO_ROLLOUT=0. */
export function rolloutBootDefault(env: NodeJS.ProcessEnv = process.env): boolean { return !offFlag(env[ROLLOUT_ENV]); }
export function rolloutIntervalMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[ROLLOUT_INTERVAL_ENV]);
  if (!Number.isFinite(n) || n <= 0) return ROLLOUT_INTERVAL_DEFAULT_MIN;
  return Math.min(7 * 24 * 60, Math.max(15, Math.round(n)));
}
export function rolloutIntervalSec(env: NodeJS.ProcessEnv = process.env): number { return rolloutIntervalMin(env) * 60; }

// ── The SystemSetting switch (supervisor-switch pattern: row wins, env boot default, 60 s cache) ──

let settingCache: { enabled: boolean; expiresAt: number } | null = null;
export function invalidateRolloutSettingCache(): void { settingCache = null; }
export function parseRolloutValue(v: unknown): boolean | null {
  if (onFlag(v)) return true;
  if (offFlag(v)) return false;
  return null;
}

async function db(): Promise<any> { return (await import('../../../config/database')).default; }

/** Is the automaton enabled? SystemSetting row wins; no row / unparseable / DB error → the env boot default. */
export async function rolloutEnabled(): Promise<boolean> {
  if (settingCache && settingCache.expiresAt > Date.now()) return settingCache.enabled;
  let enabled = rolloutBootDefault();
  try {
    const prisma = await db();
    const row = await prisma.systemSetting.findUnique({ where: { key: ROLLOUT_SETTING_KEY } });
    const parsed = row ? parseRolloutValue(row.value) : null;
    if (parsed !== null) enabled = parsed;
  } catch (err: any) {
    logger.warn(`${ROLLOUT_JOB_ID}: setting read failed (${err?.message}) — env boot default ${enabled ? 'ON' : 'OFF'} applies`);
  }
  settingCache = { enabled, expiresAt: Date.now() + SETTING_CACHE_TTL_MS };
  return enabled;
}

export interface RolloutSwitchState {
  enabled: boolean;
  bootDefault: boolean;
  dryRun: boolean;
  jobDisabled: boolean;
  intervalMin: number;
  /** ISO of the last flip write (the row's updatedAt); null = never set. */
  since: string | null;
  updatedBy: string | null;
}

export async function getRolloutSwitchState(): Promise<RolloutSwitchState> {
  let since: string | null = null;
  let updatedBy: string | null = null;
  try {
    const prisma = await db();
    const [row, by] = await Promise.all([
      prisma.systemSetting.findUnique({ where: { key: ROLLOUT_SETTING_KEY } }),
      prisma.systemSetting.findUnique({ where: { key: `${ROLLOUT_SETTING_KEY}${ROLLOUT_SETTING_BY_SUFFIX}` } }),
    ]);
    if (row?.updatedAt) since = new Date(row.updatedAt).toISOString();
    if (by?.value) updatedBy = String(by.value);
  } catch { /* fail-open */ }
  return { enabled: await rolloutEnabled(), bootDefault: rolloutBootDefault(), dryRun: rolloutDryRun(), jobDisabled: rolloutJobDisabled(), intervalMin: rolloutIntervalMin(), since, updatedBy };
}

/** Admin flip (idempotent): writes the row + the `_by` audit row, invalidates the cache, records a telemetry row. */
export async function setRolloutEnabled(enabled: boolean, by: string): Promise<{ changed: boolean; state: RolloutSwitchState }> {
  invalidateRolloutSettingCache();
  const current = await rolloutEnabled();
  if (current === enabled) return { changed: false, state: await getRolloutSwitchState() };
  const prisma = await db();
  const value = enabled ? '1' : '0';
  await prisma.systemSetting.upsert({ where: { key: ROLLOUT_SETTING_KEY }, update: { value }, create: { key: ROLLOUT_SETTING_KEY, value } });
  await prisma.systemSetting.upsert({
    where: { key: `${ROLLOUT_SETTING_KEY}${ROLLOUT_SETTING_BY_SUFFIX}` },
    update: { value: by }, create: { key: `${ROLLOUT_SETTING_KEY}${ROLLOUT_SETTING_BY_SUFFIX}`, value: by },
  }).catch((err: any) => logger.warn(`${ROLLOUT_JOB_ID}: audit row write failed: ${err?.message ?? err}`));
  invalidateRolloutSettingCache();
  await recordRolloutMetric({ action: 'switch', enabled, by });
  logger.info(`${ROLLOUT_JOB_ID}: auto-rollout turned ${enabled ? 'ON' : 'OFF'} by ${by}`);
  return { changed: true, state: await getRolloutSwitchState() };
}

// ── Store row: the automaton's own ledger ────────────────────────────────────

export interface RolloutAction {
  at: string;
  purpose: string;
  from: string;
  to: string;
  /** flipped | dry_run | owner_answered | tool | parked | asked | refused | lifecycle_retired | lifecycle_parked | lifecycle_dry_run */
  reason: string;
  bars?: Record<string, unknown>;
  by?: string;
}

/** DECISION-GATE-LIFECYCLE: the record of one lifecycle retirement (the purpose was set off by the automaton). */
export interface LifecycleRecord {
  rule: 'review_by' | 'non_converging';
  at: string;
  /** The effective mode it left. */
  from: string;
  detail: string;
  /** The readiness partition (questionsHash) the verdict judged — a re-posed question is judged afresh. */
  partition: string;
  /** The re-pose ticket (non_converging only). */
  ticketId?: string;
  /** Labels and disagreed rows the verdict rested on (review fix: the briefing names the error count). */
  n?: number;
  errors?: number;
}

export interface RolloutState {
  lastRunAt: string | null;
  lastReadinessComputedAt: string | null;
  lastSummary: string | null;
  parked: Record<string, { until: string; reason: string; demotedAt: string[] }>;
  actions: RolloutAction[];
  ownerAsks: Record<string, { questionId: string; at: string; tier: RolloutTier }>;
  inconsistencies: string[];
  /** DECISION-GATE-LIFECYCLE: purposes the registry lifecycle set off (never re-retired for the same question after a hand restore). */
  lifecycle: Record<string, LifecycleRecord>;
}

export function emptyRolloutState(): RolloutState {
  return { lastRunAt: null, lastReadinessComputedAt: null, lastSummary: null, parked: {}, actions: [], ownerAsks: {}, inconsistencies: [], lifecycle: {} };
}

/** Pure: a stored row → a well-formed state (unknown / malformed fields dropped). */
export function normalizeRolloutState(stored: unknown): RolloutState {
  const s = emptyRolloutState();
  if (!stored || typeof stored !== 'object') return s;
  const r = stored as Record<string, unknown>;
  const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  s.lastRunAt = iso(r.lastRunAt);
  s.lastReadinessComputedAt = iso(r.lastReadinessComputedAt);
  s.lastSummary = typeof r.lastSummary === 'string' ? r.lastSummary.slice(0, 400) : null;
  if (r.parked && typeof r.parked === 'object') {
    for (const [k, v] of Object.entries(r.parked as Record<string, any>)) {
      const until = iso(v?.until);
      if (!until) continue;
      s.parked[k] = { until, reason: typeof v?.reason === 'string' ? v.reason.slice(0, 300) : 'parked', demotedAt: Array.isArray(v?.demotedAt) ? v.demotedAt.map(String).slice(0, 10) : [] };
    }
  }
  if (Array.isArray(r.actions)) {
    for (const a of r.actions.slice(0, ROLLOUT_ACTIONS_KEEP)) {
      const at = iso(a?.at);
      if (!at || typeof a?.purpose !== 'string') continue;
      s.actions.push({ at, purpose: a.purpose, from: String(a.from ?? ''), to: String(a.to ?? ''), reason: String(a.reason ?? ''), ...(a.bars && typeof a.bars === 'object' ? { bars: a.bars } : {}), ...(typeof a.by === 'string' ? { by: a.by } : {}) });
    }
  }
  if (r.ownerAsks && typeof r.ownerAsks === 'object') {
    for (const [k, v] of Object.entries(r.ownerAsks as Record<string, any>)) {
      const at = iso(v?.at);
      if (!at || typeof v?.questionId !== 'string') continue;
      const tier = v?.tier === 2 || v?.tier === 3 ? (v.tier as RolloutTier) : 2;
      s.ownerAsks[k] = { questionId: v.questionId, at, tier };
    }
  }
  if (Array.isArray(r.inconsistencies)) s.inconsistencies = r.inconsistencies.filter((x: unknown): x is string => typeof x === 'string').slice(0, 20);
  if (r.lifecycle && typeof r.lifecycle === 'object') {
    for (const [k, v] of Object.entries(r.lifecycle as Record<string, any>)) {
      const at = iso(v?.at);
      if (!at || (v?.rule !== 'review_by' && v?.rule !== 'non_converging')) continue;
      s.lifecycle[k] = {
        rule: v.rule, at, from: String(v.from ?? ''), detail: typeof v.detail === 'string' ? v.detail.slice(0, 300) : '',
        partition: typeof v.partition === 'string' ? v.partition.slice(0, 80) : '',
        ...(typeof v.ticketId === 'string' && v.ticketId ? { ticketId: v.ticketId.slice(0, 64) } : {}),
        ...(typeof v.n === 'number' && Number.isFinite(v.n) ? { n: v.n } : {}),
        ...(typeof v.errors === 'number' && Number.isFinite(v.errors) ? { errors: v.errors } : {}),
      };
    }
  }
  return s;
}

export async function readRolloutState(): Promise<RolloutState> {
  try {
    const { storeGet } = await import('../memory/context-store');
    return normalizeRolloutState(await storeGet<unknown>(ROLLOUT_STORE_NS, ROLLOUT_STORE_KEY));
  } catch (err: any) {
    logger.warn(`${ROLLOUT_JOB_ID}: state read failed (${err?.message}) — empty state`);
    return emptyRolloutState();
  }
}

export async function writeRolloutState(state: RolloutState): Promise<void> {
  const { storePut } = await import('../memory/context-store');
  await storePut(ROLLOUT_STORE_NS, ROLLOUT_STORE_KEY, { ...state, actions: state.actions.slice(0, ROLLOUT_ACTIONS_KEEP) } as unknown as Record<string, unknown>);
  stateCache = { state, expiresAt: Date.now() + STATE_CACHE_TTL_MS };
}

// ── Sync view for the prompt layer (framework-facts) — cache + background refresh ──

let stateCache: { state: RolloutState; expiresAt: number } | null = null;
let stateInFlight: Promise<void> | null = null;
export function clearRolloutStateCache(): void { stateCache = null; stateInFlight = null; }
/** Test hook: seed the sync cache. */
export function primeRolloutStateCache(state: RolloutState): void { stateCache = { state, expiresAt: Date.now() + STATE_CACHE_TTL_MS }; }

/** The last-read rollout state (null before the first read); schedules ONE background refresh when stale (never under jest). */
export function rolloutStateSync(): RolloutState | null {
  if (!stateCache || stateCache.expiresAt <= Date.now()) {
    if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID && !stateInFlight) {
      stateInFlight = readRolloutState().then(s => { stateCache = { state: s, expiresAt: Date.now() + STATE_CACHE_TTL_MS }; }).catch(() => { /* logged inside */ }).finally(() => { stateInFlight = null; });
    }
  }
  return stateCache?.state ?? null;
}

/** Purposes currently parked (sync; [] before the first read). */
export function parkedPurposesSync(now = Date.now()): string[] {
  const s = rolloutStateSync();
  if (!s) return [];
  return Object.entries(s.parked).filter(([, p]) => Date.parse(p.until) > now).map(([k]) => k).sort();
}

const relAge = (iso: string, now: number): string => {
  const ms = Math.max(0, now - Date.parse(iso));
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

/** ONE short line of recent automaton actions for the prompt layer (no absolute dates), or null. */
export function rolloutRecentLineSync(now = Date.now(), windowDays = 7): string | null {
  const s = rolloutStateSync();
  if (!s) return null;
  const since = now - windowDays * 86_400_000;
  const recent = s.actions.filter(a => Date.parse(a.at) >= since && (a.reason === 'flipped' || a.reason === 'owner_answered' || a.reason === 'tool' || a.reason === 'parked' || a.reason === 'lifecycle_retired' || a.reason === 'lifecycle_parked')).slice(0, 6);
  if (!recent.length) return null;
  return recent.map(a => a.reason === 'parked' ? `${a.purpose} parked (${relAge(a.at, now)})`
    : a.reason === 'lifecycle_retired' ? `${a.purpose} ${a.from} → off — review bar unmet (${relAge(a.at, now)})`
    : a.reason === 'lifecycle_parked' ? `${a.purpose} ${a.from} → off — non-converging (${relAge(a.at, now)})`
    : `${a.purpose} ${a.from} → ${a.to} (${relAge(a.at, now)})`).join('; ');
}

// ── Telemetry ────────────────────────────────────────────────────────────────

async function recordRolloutMetric(meta: Record<string, unknown>): Promise<void> {
  try {
    const { recordLoopMetric } = await import('./loop-metrics.service');
    recordLoopMetric({ kind: ROLLOUT_METRIC_KIND, meta });
  } catch { /* telemetry never throws */ }
}

// ── The pure planner ─────────────────────────────────────────────────────────

export interface RolloutPlanInput {
  now: Date;
  /** The admin view (modes + admission + act caps). */
  modes: DecisionModeConfig;
  /** The readiness STAMP (with `backend` + `metrics.n`), or null. */
  stamp: Record<string, StampEntry> | null;
  /** Auto-demotions per purpose inside the window (ISO dates, outcome 'demoted'). */
  demotions: Record<string, string[]>;
  state: RolloutState;
  /** Owner-ask rows the previous passes filed: purpose → live status + answer. */
  askStatus: Record<string, { status: string; answer: string | null; chosenOption: string | null } | null>;
}

export interface RolloutPlan {
  flips: Array<{ purpose: string; from: string; reason: 'measured_ready' | 'owner_answered'; bars: Record<string, unknown> }>;
  asks: Array<{ purpose: string; tier: RolloutTier; why: string }>;
  parks: Array<{ purpose: string; until: string; demotedAt: string[] }>;
  inconsistencies: string[];
  skipped: Array<{ purpose: string; reason: string }>;
  /** Owner asks to forget (answered / dismissed). */
  closeAsks: string[];
}

/** A GO answer on a rollout owner question: the typed option 'flip', or the standing proceed words. */
export function ownerAnswerIsGo(answer: string | null | undefined, chosenOption: string | null | undefined): boolean {
  if (chosenOption && chosenOption.toLowerCase() === 'flip') return true;
  if (chosenOption && chosenOption.toLowerCase() === 'hold') return false;
  const a = String(answer ?? '').trim();
  if (!a) return false;
  return /\b(flip( it)?|go ahead|proceed|approved|yes)\b/i.test(a) && !/\b(no|hold|keep|don'?t|not yet|wait)\b/i.test(a);
}

/** Pure: is the stamp entry a FRESH, MEASURED READY (never an owner-override / hand stamp)? */
export function measuredReady(entry: StampEntry | undefined, purpose: string, now: number, maxAgeMs = readinessMaxAgeMs()): { ok: boolean; why: string } {
  if (!entry) return { ok: false, why: 'no readiness stamp' };
  if (!entry.ready) return { ok: false, why: `NOT READY${entry.reasons?.length ? `: ${entry.reasons[0]}` : ''}` };
  const age = now - Date.parse(entry.at);
  if (!Number.isFinite(age) || age > maxAgeMs) return { ok: false, why: 'READY stamp is stale' };
  const backend = String(entry.backend ?? '');
  if (!backend || /owner|override|manual|hand/i.test(backend)) return { ok: false, why: `READY stamp is an owner-override (${backend || 'no backend'}), not a measured verdict` };
  const n = Number((entry.metrics as any)?.n);
  const bars = readinessBarsFor(purpose);
  if (!Number.isFinite(n) || n < bars.minLabels) return { ok: false, why: `READY stamp carries ${Number.isFinite(n) ? n : 'no'} labels < ${bars.minLabels} — not a measured verdict` };
  return { ok: true, why: `measured READY on ${backend} (n=${n})` };
}

/**
 * The highest tier the automaton flips on its own (2026-10-04, owner: "move over shadow roles autonomously if
 * everything is looking good and backtests prove just flip"): default 2 — a tier-2 purpose with a fresh MEASURED
 * READY stamp flips through the same admission as tier 1 (never an override stamp, never a capped / parked / off
 * purpose, never an owner-locked one — those still get the owner question). DECISION_GATE_AUTO_ROLLOUT_MAX_TIER=1
 * restores the tier-2 owner question; tier 3 is never flipped here whatever the env says. Pure over env.
 */
export function rolloutAutoMaxTier(env: Record<string, string | undefined> = process.env): 1 | 2 {
  return String(env.DECISION_GATE_AUTO_ROLLOUT_MAX_TIER ?? '').trim() === '1' ? 1 : 2;
}

export function planRollout(input: RolloutPlanInput): RolloutPlan {
  const now = input.now.getTime();
  const plan: RolloutPlan = { flips: [], asks: [], parks: [], inconsistencies: [], skipped: [], closeAsks: [] };
  const byPurpose = new Map<string, DecisionModeView>(input.modes.purposes.map(p => [p.purpose, p]));
  for (const { purpose } of DECISION_PURPOSES) {
    const v = byPurpose.get(purpose);
    if (!v) continue;
    const tier = rolloutTierFor(purpose);
    const spec = DECISION_ROLE_REGISTRY[purpose as StorablePurpose];
    // Inconsistency: the store says act but the code caps the purpose at shadow — report, never fix.
    if (v.storeMode === 'act' && v.effectiveSource === 'registry_cap') {
      plan.inconsistencies.push(`${purpose}: the store row says act but the code caps it at shadow (${v.actCap?.why ?? 'registry cap'}) — set it to shadow by hand for coherence`);
    }
    // Parking: ≥ ROLLOUT_DEMOTE_PARK_COUNT auto-demotions inside the window → parked (extend if already parked).
    const demoted = (input.demotions[purpose] ?? []).filter(d => now - Date.parse(d) <= ROLLOUT_DEMOTE_WINDOW_DAYS * 86_400_000);
    const parkedRow = input.state.parked[purpose];
    const parkedNow = parkedRow ? Date.parse(parkedRow.until) > now : false;
    if (demoted.length >= ROLLOUT_DEMOTE_PARK_COUNT && !parkedNow) {
      plan.parks.push({ purpose, until: new Date(now + ROLLOUT_PARK_DAYS * 86_400_000).toISOString(), demotedAt: demoted });
    }
    if (v.storeMode === 'off' || v.effective === 'off') { plan.skipped.push({ purpose, reason: 'off — never touched' }); continue; }
    if (v.effective === 'act') { plan.skipped.push({ purpose, reason: 'already act' }); continue; }
    if (parkedNow || demoted.length >= ROLLOUT_DEMOTE_PARK_COUNT) { plan.skipped.push({ purpose, reason: `parked after ${demoted.length} auto-demotions in ${ROLLOUT_DEMOTE_WINDOW_DAYS} d` }); continue; }
    if (v.actCap) { plan.skipped.push({ purpose, reason: `act-capped in code since ${v.actCap.since}` }); continue; }
    const measured = measuredReady(input.stamp?.[purpose], purpose, now);
    if (!measured.ok) { plan.skipped.push({ purpose, reason: measured.why }); continue; }
    if (!v.admission.admitted) { plan.skipped.push({ purpose, reason: `admission refused: ${v.admission.reason ?? 'unknown'}` }); continue; }
    const bars = { backend: input.stamp?.[purpose]?.backend, n: (input.stamp?.[purpose]?.metrics as any)?.n, at: input.stamp?.[purpose]?.at, tier };
    if (tier === 1) { plan.flips.push({ purpose, from: v.effective, reason: 'measured_ready', bars }); continue; }
    if (tier === 2 && rolloutAutoMaxTier() >= 2 && !spec?.ownerLock) { plan.flips.push({ purpose, from: v.effective, reason: 'measured_ready', bars: { ...bars, ownerAuthorized: '2026-10-04' } }); continue; }
    // Tier 2 / 3: ONE owner question per purpose while open; a tier-2 GO answer flips.
    const ask = input.state.ownerAsks[purpose];
    const live = ask ? input.askStatus[purpose] : null;
    if (ask && live && live.status === 'open') { plan.skipped.push({ purpose, reason: `ready (tier ${tier}) — owner question ${ask.questionId} still open` }); continue; }
    if (ask && live && live.status === 'answered') {
      plan.closeAsks.push(purpose);
      if (tier === 2 && ownerAnswerIsGo(live.answer, live.chosenOption)) { plan.flips.push({ purpose, from: v.effective, reason: 'owner_answered', bars }); continue; }
      plan.skipped.push({ purpose, reason: `ready (tier ${tier}) — owner answered ${ask.questionId} without a GO${tier === 3 ? ' (tier 3 is never flipped here)' : ''}` });
      continue;
    }
    if (ask && live && live.status !== 'open') plan.closeAsks.push(purpose);
    if (ask && !live) { plan.skipped.push({ purpose, reason: `ready (tier ${tier}) — owner question ${ask.questionId} status unknown` }); continue; }
    plan.asks.push({ purpose, tier: (tier ?? 2) as RolloutTier, why: spec?.tierWhy ?? '' });
  }
  return plan;
}

// ── The pure lifecycle planner (DECISION-GATE-LIFECYCLE, 2026-10-20) ─────────

export interface LifecycleRetirement {
  purpose: string;
  rule: LifecycleRecord['rule'];
  /** The effective mode it leaves (always 'shadow' — act / off are never planned). */
  from: string;
  /** One sentence: what was measured against which bar (incl. the error count it rests on). */
  detail: string;
  /** `errors` = disagreed rows (n − round(accuracy × n)); null with `accuracy` when the stamp carries none. */
  metrics: { auroc: number | null; n: number; days: number; partition: string; accuracy: number | null; errors: number | null };
  reviewBy?: string;
}

export interface LifecyclePlan {
  retire: LifecycleRetirement[];
  skipped: Array<{ purpose: string; reason: string }>;
}

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** End of the reviewBy day (UTC) — a purpose is due the moment the date has fully passed. NaN when unparseable. */
export function reviewDueMs(reviewBy: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(reviewBy ?? '').trim()) ? Date.parse(`${reviewBy.trim()}T23:59:59.999Z`) : NaN;
}

/**
 * Which SHADOW purposes the registry lifecycle retires this pass (pure).
 * `review_by` judges a shadow_review row's reviewBar on the fresh stamp once
 * its date has passed (a missing / stale / override stamp is never judged —
 * skipped, not retired; the readiness job stamps EVERY ACT_POLICIES purpose, a
 * zero-label one included, so "no entry" means no evidence at all, never "no
 * labels"); `non_converging` parks any other shadow purpose whose fresh
 * MEASURED stamp reads AUROC < NON_CONVERGING_MAX_AUROC on ≥
 * NON_CONVERGING_MIN_LABELS labels over ≥ NON_CONVERGING_MIN_DAYS days — and
 * only when that AUROC means something: ≥ NON_CONVERGING_MIN_OUTCOME_ROWS
 * agreed AND disagreed rows, and accuracy < NON_CONVERGING_MAX_ACCURACY
 * (review fix 2026-10-20 — see the constants). Never judged by non_converging:
 * a degenerate label set (the AUROC bar is waived there); a shadow_review row
 * before its reviewBy (the registry gave it until then to prove itself); a
 * purpose whose HUMAN-turn ask is retired (PURPOSE_RETIRED_ON_HUMAN_TURNS — the
 * stamp's human partition is frozen pre-retirement while machine turns keep
 * asking; parking it would stop the live machine-segment labels). A would-be
 * park waived by those rules is named in `skipped`. Act and off purposes are
 * never planned; neither is a purpose a human restored after a lifecycle
 * action on the SAME question (review_by: never; non_converging: until the
 * stamp's partition changes — a re-pose).
 */
export function planLifecycle(input: { now: Date; modes: DecisionModeConfig; stamp: Record<string, StampEntry> | null; state: RolloutState; maxAgeMs?: number; env?: NodeJS.ProcessEnv }): LifecyclePlan {
  const now = input.now.getTime();
  const maxAgeMs = input.maxAgeMs ?? readinessMaxAgeMs();
  const env = input.env ?? process.env;
  const plan: LifecyclePlan = { retire: [], skipped: [] };
  for (const v of input.modes.purposes) {
    const purpose = v.purpose;
    if (v.effective !== 'shadow' || v.storeMode === 'act') continue; // act: auto-demote owns it; off: nothing to do
    const spec = DECISION_ROLE_REGISTRY[purpose as StorablePurpose];
    const e = input.stamp?.[purpose];
    const m = (e?.metrics ?? {}) as Partial<StampEntry['metrics']>;
    const n = Number(m.n) || 0;
    const days = Number(m.days) || 0;
    const auroc = finiteOrNull(m.auroc);
    const accuracy = finiteOrNull(m.accuracy);
    const errors = accuracy === null ? null : Math.max(0, n - Math.round(accuracy * n));
    const partition = String(e?.partition ?? '');
    const metrics = { auroc, n, days, partition, accuracy, errors };
    const prior = input.state.lifecycle[purpose];
    if (prior && (prior.rule === 'review_by' || prior.partition === partition)) {
      plan.skipped.push({ purpose, reason: `restored by hand after the lifecycle ${prior.rule} retirement ${prior.at} — not retired again for the same question` });
      continue;
    }
    const age = e ? now - Date.parse(e.at) : NaN;
    const backend = String(e?.backend ?? '');
    const measured = !!e && Number.isFinite(age) && age <= maxAgeMs && !!backend && !/owner|override|manual|hand/i.test(backend);
    const lc = spec?.lifecycle;
    const errorsText = errors === null ? 'error count unknown' : `${errors} error${errors === 1 ? '' : 's'}`;
    const due = lc?.decision === 'shadow_review' && lc.reviewBy ? reviewDueMs(lc.reviewBy) : NaN;
    if (lc?.decision === 'shadow_review' && lc.reviewBy && Number.isFinite(due)) {
      if (now <= due) {
        // Before its review date the registry gave the question until then — never parked early.
        if (measured && auroc !== null && auroc < NON_CONVERGING_MAX_AUROC && n >= NON_CONVERGING_MIN_LABELS) {
          plan.skipped.push({ purpose, reason: `AUROC ${auroc.toFixed(3)} on n=${n}, but its review date ${lc.reviewBy} has not passed — judged on its reviewBar then, never parked early` });
        }
        continue;
      }
      if (!lc.reviewBar) { plan.skipped.push({ purpose, reason: `past reviewBy ${lc.reviewBy} but the bar is free text — add reviewBar to enforce it` }); continue; }
      if (!measured) { plan.skipped.push({ purpose, reason: `past reviewBy ${lc.reviewBy} — no fresh measured readiness stamp to judge the bar (${e ? 'stale / override stamp' : 'no stamp entry'})` }); continue; }
      const met = n >= lc.reviewBar.minLabels && auroc !== null && auroc >= lc.reviewBar.minAuroc;
      if (met) { plan.skipped.push({ purpose, reason: `past reviewBy ${lc.reviewBy} — bar met (AUROC ${auroc} on n=${n})` }); continue; }
      plan.retire.push({
        purpose, rule: 'review_by', from: v.effective, reviewBy: lc.reviewBy,
        detail: `past its review date ${lc.reviewBy} with the bar unmet — AUROC ${auroc === null ? 'n/a' : auroc.toFixed(3)} on n=${n}, ${errorsText} (bar: AUROC ≥ ${lc.reviewBar.minAuroc} on ≥ ${lc.reviewBar.minLabels} labels)`,
        metrics,
      });
      continue;
    }
    if (!measured || auroc === null || m.degenerateLabels === true) continue;
    if (n < NON_CONVERGING_MIN_LABELS || days < NON_CONVERGING_MIN_DAYS || auroc >= NON_CONVERGING_MAX_AUROC) continue;
    // From here the AUROC bar is crossed — every waiver below is NAMED, so an operator sees why nothing was parked.
    if (purposeRetiredOnHumanTurns(purpose as DecisionPurpose, env)) {
      plan.skipped.push({ purpose, reason: `AUROC ${auroc.toFixed(3)} on n=${n}, but its human-turn ask is retired (the judged human partition is frozen pre-retirement; machine turns still ask) — not parked` });
      continue;
    }
    const agreed = errors === null ? null : n - errors;
    if (errors === null || agreed === null || errors < NON_CONVERGING_MIN_OUTCOME_ROWS || agreed < NON_CONVERGING_MIN_OUTCOME_ROWS) {
      plan.skipped.push({ purpose, reason: `AUROC ${auroc.toFixed(3)} on n=${n}, but not estimable — ${errors === null ? 'no accuracy on the stamp' : `${errorsText} / ${agreed} agreed`} (needs ≥ ${NON_CONVERGING_MIN_OUTCOME_ROWS} of each) — not parked` });
      continue;
    }
    if (accuracy !== null && accuracy >= NON_CONVERGING_MAX_ACCURACY) {
      plan.skipped.push({ purpose, reason: `AUROC ${auroc.toFixed(3)} on n=${n}, but accuracy ${(accuracy * 100).toFixed(1)} % ≥ ${NON_CONVERGING_MAX_ACCURACY * 100} % (${errorsText}) — the answers converge, only the confidence ranking is weak — not parked` });
      continue;
    }
    plan.retire.push({
      purpose, rule: 'non_converging', from: v.effective,
      detail: `non-converging — AUROC ${auroc.toFixed(3)} < ${NON_CONVERGING_MAX_AUROC} on n=${n} labels over ${days.toFixed(1)} d, ${errorsText} (accuracy ${((accuracy ?? 0) * 100).toFixed(1)} %; bar: ≥ ${NON_CONVERGING_MIN_LABELS} labels, ≥ ${NON_CONVERGING_MIN_DAYS} d, ≥ ${NON_CONVERGING_MIN_OUTCOME_ROWS} errors and agreed rows, accuracy < ${NON_CONVERGING_MAX_ACCURACY * 100} %)`,
      metrics,
    });
  }
  return plan;
}

// ── The pass ─────────────────────────────────────────────────────────────────

export interface RolloutRunOptions {
  now?: Date;
  primaryOpts?: DecisionModeOpts;
}

/** Owner-question filing seam (owner-questions.flagOwnerQuestion) — one question per purpose, to every admin owner's Fleet Supervisor.
 *  `lastDemotedAt` (the purpose's newest auto-demote in the window) is the per-event fact: an owner ruling made before it
 *  annotates the re-ask instead of refusing it; an unchanged re-ask (no demote since the ruling) is still refused. */
async function fileOwnerAsk(purpose: string, tier: RolloutTier, why: string, now: Date, lastDemotedAt?: string): Promise<{ questionId: string } | null> {
  try {
    const [{ adminFleetSupervisors }, { flagOwnerQuestion }] = await Promise.all([import('../fleet/infra-watch.service'), import('./owner-questions')]);
    const targets = await adminFleetSupervisors();
    if (!targets.length) return null;
    const row = DECISION_ROLE_REGISTRY[purpose as StorablePurpose];
    const label = DECISION_PURPOSES.find(p => p.purpose === purpose)?.label ?? purpose;
    const question = tier === 3
      ? `[Decision gate] ${label} (${purpose}) reads READY but is tier 3 — never flipped automatically (${why}). Nothing to do unless you want it in act by hand (Account → Admin → Endpoints → Model roles → Decision gate).`
      : `[Decision gate] ${label} (${purpose}) reads READY on a measured stamp. It is tier 2 (${why}). Flip it to act? act = ${row?.actDoes ?? 'see the registry'}.`;
    const t = targets[0];
    const r = await flagOwnerQuestion({
      chatId: t.id, userId: t.userId, question,
      context: `Rollout automaton ${ROLLOUT_JOB_ID} at ${now.toISOString()}. Tier rule: ${ROLLOUT_TIER_RULE}. A GO answer ("flip") on a tier-2 question flips the purpose on the next pass through the same admission the admin PUT uses; a wrong act auto-demotes.${lastDemotedAt ? ` Last auto-demoted from act at ${lastDemotedAt}.` : ''}`,
      options: tier === 2 ? [{ id: 'flip', label: 'Flip to act' }, { id: 'hold', label: 'Keep shadow' }] : undefined,
      machineTriggered: true,
      ...(lastDemotedAt ? { harnessEventAt: lastDemotedAt } : {}),
    });
    if (r.kind === 'created' || r.kind === 'deduped') return { questionId: r.question.id };
    return null;
  } catch (err: any) {
    logger.warn(`${ROLLOUT_JOB_ID}: owner ask for ${purpose} failed (${err?.message ?? err})`);
    return null;
  }
}

/**
 * DECISION-GATE-LIFECYCLE: ONE re-pose ticket per parked purpose (the title is
 * stable, so a repeat filing dedupes onto the open ticket). Returns the ticket
 * id, or null on any failure (the park stands; the briefing line still names it).
 */
async function fileRePoseTicket(r: LifecycleRetirement, now: Date): Promise<string | null> {
  try {
    const { fileFeedbackTicket } = await import('../feedback/feedback.service');
    const spec = DECISION_ROLE_REGISTRY[r.purpose as StorablePurpose];
    const label = DECISION_PURPOSES.find(p => p.purpose === r.purpose)?.label ?? r.purpose;
    const res = await fileFeedbackTicket({
      userId: null, type: 'enhancement', priority: 2, area: 'framework',
      title: `${LIFECYCLE_TICKET_PREFIX} re-pose ${r.purpose} — non-converging (AUROC < ${NON_CONVERGING_MAX_AUROC} on ≥ ${NON_CONVERGING_MIN_LABELS} labels)`,
      description: [
        `The decision-gate rollout automaton (${ROLLOUT_JOB_ID}, platform/decision-gate-rollout.ts planLifecycle) PARKED ${label} (${r.purpose}) at ${now.toISOString()}: ${r.detail}. Its store mode is now OFF — the question is no longer asked, so no new labels accrue; its act consumer (if any) fails open to the pre-gate behaviour.`,
        `What it decides: ${spec?.decides ?? 'see the registry'}. Harness label: ${spec?.harnessLabel ?? 'see the registry'}.`,
        `Re-pose: change the question or the state facts it reads (a new questionsHash partition is judged afresh), or replace it with a deterministic rule, or retire it for good in decision-gate-modes PURPOSE_RETIRED. To run it again set it to shadow (Account → Admin → Endpoints → Model roles → Decision gate, or set_decision_gate_mode) — the lifecycle never parks the same question twice after a hand restore.`,
      ].join('\n\n'),
      context: {
        source: ROLLOUT_JOB_ID, signal: 'decision_gate_non_converging', purpose: r.purpose,
        sessionId: `${ROLLOUT_JOB_ID}:lifecycle:${r.purpose}`, filedBy: ROLLOUT_JOB_ID, metrics: r.metrics,
      },
    });
    if ('error' in res) { logger.warn(`${ROLLOUT_JOB_ID}: re-pose ticket for ${r.purpose} not filed (${res.error}): ${res.message}`); return null; }
    return res.ticket?.id ? String(res.ticket.id) : null;
  } catch (err: any) {
    logger.warn(`${ROLLOUT_JOB_ID}: re-pose ticket for ${r.purpose} failed (${err?.message ?? err})`);
    return null;
  }
}

async function recordLifecycleMetric(meta: Record<string, unknown>): Promise<void> {
  try {
    const { recordLoopMetric } = await import('./loop-metrics.service');
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.DECISION_GATE_LIFECYCLE_RETIRED, meta });
  } catch { /* telemetry never throws */ }
}

async function readAskStatuses(state: RolloutState): Promise<RolloutPlanInput['askStatus']> {
  const out: RolloutPlanInput['askStatus'] = {};
  const entries = Object.entries(state.ownerAsks);
  if (!entries.length) return out;
  try {
    const prisma = await db();
    for (const [purpose, ask] of entries) {
      const row = await prisma.ownerQuestion.findUnique({ where: { id: ask.questionId }, select: { status: true, answer: true, chosenOption: true } }).catch(() => null);
      out[purpose] = row ? { status: String(row.status), answer: row.answer ?? null, chosenOption: row.chosenOption ?? null } : null;
    }
  } catch { /* unknown statuses skip the purpose this pass */ }
  return out;
}

async function readDemotions(now: Date): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  try {
    const prisma = await db();
    const since = new Date(now.getTime() - ROLLOUT_DEMOTE_WINDOW_DAYS * 86_400_000);
    const rows: Array<{ meta: any; createdAt: Date }> = await prisma.loopMetric.findMany({
      where: { kind: 'decision_gate_demoted', createdAt: { gte: since } }, select: { meta: true, createdAt: true }, take: 500,
    });
    for (const r of rows) {
      const m = r.meta ?? {};
      if (m.outcome !== 'demoted' || typeof m.purpose !== 'string') continue;
      (out[m.purpose] ??= []).push(new Date(r.createdAt).toISOString());
    }
  } catch (err: any) {
    logger.warn(`${ROLLOUT_JOB_ID}: demotion history read failed (${err?.message}) — no purpose is parked this pass`);
  }
  return out;
}

/** Recent auto-demotes (the status tool + the briefing read these). */
export async function recentAutoDemotes(days = ROLLOUT_DEMOTE_WINDOW_DAYS, now = new Date()): Promise<Array<{ purpose: string; at: string; precision: number | null; n: number | null; outcome: string }>> {
  try {
    const prisma = await db();
    const since = new Date(now.getTime() - days * 86_400_000);
    const rows: Array<{ meta: any; createdAt: Date }> = await prisma.loopMetric.findMany({
      where: { kind: 'decision_gate_demoted', createdAt: { gte: since } }, select: { meta: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50,
    });
    return rows.map(r => ({ purpose: String(r.meta?.purpose ?? '?'), at: new Date(r.createdAt).toISOString(), precision: typeof r.meta?.precision === 'number' ? r.meta.precision : null, n: typeof r.meta?.n === 'number' ? r.meta.n : null, outcome: String(r.meta?.outcome ?? 'demoted') }));
  } catch { return []; }
}

/**
 * Pure: the "next readiness firing" clause appended to the waiting line
 * (FO 2026-11-05). The waiting branch fires on EVERY hourly rollout pass that
 * falls between the readiness job's own firings — the job's default cadence is
 * 360 min, so five passes in six land here — and the bare "waiting for a fresher
 * readiness report" line reads as a STALL. It has now cost two investigations
 * while the job was demonstrably healthy: the 2026-10-04 one (FO firing 78,
 * which added the liveness stamp below) and a supervisor escalation on
 * 2026-11-05 whose only finding was that `cron_jobs['decision-gate-readiness']`
 * was enabled with lastFiredAt 00:37:39Z and nextRunAt 06:37:39Z. Naming the
 * due time makes a healthy idle legible without changing what the pass DOES.
 *
 * Pure and total: an absent/unparseable timestamp or a nonsense interval yields
 * '' so the waiting line stays exactly as it was before this clause existed
 * (fail-open — a status string must never be able to break the pass).
 */
export function readinessNextDueSummary(computedAt: string | null | undefined, intervalSec: number): string {
  if (!computedAt || !Number.isFinite(intervalSec) || intervalSec <= 0) return '';
  const t = Date.parse(computedAt);
  if (Number.isNaN(t)) return '';
  const due = new Date(t + intervalSec * 1000);
  if (Number.isNaN(due.getTime())) return '';
  return `; next readiness firing due ${due.toISOString()}`;
}

/**
 * ONE pass. Returns a ≤ 200-char summary for cron_jobs.lastStatus. NEVER throws.
 */
export async function runDecisionGateRolloutOnce(opts: RolloutRunOptions = {}): Promise<string> {
  if (rolloutJobDisabled()) return `disabled (${ROLLOUT_JOB_DISABLED_ENV})`;
  const now = opts.now ?? new Date();
  const t0 = Date.now();
  // Mode writes this pass has COMMITTED (flips + lifecycle offs) — the catch below must not claim "no mode changed" after one.
  let modeWrites = 0;
  try {
    const state = await readRolloutState();
    const enabled = await rolloutEnabled();
    const dryRun = rolloutDryRun();
    if (!enabled) {
      state.lastRunAt = now.toISOString();
      state.lastSummary = 'auto-rollout OFF (SystemSetting) — nothing evaluated';
      await writeRolloutState(state).catch(() => {});
      return state.lastSummary;
    }
    const { readReadinessStamp, readLatestReadinessReport, readinessIntervalSec } = await import('./decision-gate-readiness');
    const [modes, stamp, report] = await Promise.all([getDecisionModeConfig(opts.primaryOpts), readReadinessStamp(), readLatestReadinessReport()]);
    const computedAt = report?.computedAt ?? null;
    // Once per readiness firing: a report the previous pass already judged is a no-op.
    if (computedAt && state.lastReadinessComputedAt && computedAt <= state.lastReadinessComputedAt) {
      const s = `waiting for a fresher readiness report (last judged ${state.lastReadinessComputedAt}${readinessNextDueSummary(computedAt, readinessIntervalSec())}) — normal between readiness firings, not a stall`;
      // Liveness heartbeat (FO firing 78, 2026-10-04): this early-return used to
      // skip writeRolloutState entirely, so the status surface froze lastRunAt at
      // the last JUDGING pass while the job kept firing hourly — a healthy idle
      // (readiness runs every 6 h) was indistinguishable from a stalled automaton
      // and cost a live investigation. Stamp lastRunAt/lastSummary on the waiting
      // path too: "the pass ran" and "the pass judged" are different facts and
      // the surface must show the former. cron_jobs.lastFiredAt stays the
      // scheduler-level truth; this is the state-level one.
      state.lastRunAt = now.toISOString();
      state.lastSummary = s.slice(0, 200);
      await writeRolloutState(state).catch(() => {});
      return s.slice(0, 200);
    }
    const [demotions, askStatus] = await Promise.all([readDemotions(now), readAskStatuses(state)]);
    const plan = planRollout({ now, modes, stamp, demotions, state, askStatus });
    const actions: RolloutAction[] = [];
    // Parks first (they gate flips of the same pass in the planner already).
    for (const p of plan.parks) {
      state.parked[p.purpose] = { until: p.until, reason: `${p.demotedAt.length} auto-demotions in ${ROLLOUT_DEMOTE_WINDOW_DAYS} d`, demotedAt: p.demotedAt };
      actions.push({ at: now.toISOString(), purpose: p.purpose, from: 'shadow', to: 'parked', reason: 'parked', bars: { until: p.until, demotedAt: p.demotedAt } });
      await recordRolloutMetric({ purpose: p.purpose, from: 'shadow', to: 'parked', reason: 'parked', bars: { until: p.until, demotedAt: p.demotedAt } });
    }
    // Expired parks fall away.
    for (const [k, v] of Object.entries(state.parked)) if (Date.parse(v.until) <= now.getTime()) delete state.parked[k];
    let flipped = 0, dry = 0, refused = 0;
    for (const f of plan.flips) {
      if (dryRun) {
        dry++;
        actions.push({ at: now.toISOString(), purpose: f.purpose, from: f.from, to: 'act', reason: 'dry_run', bars: f.bars });
        await recordRolloutMetric({ purpose: f.purpose, from: f.from, to: 'act', reason: f.reason, dryRun: true, bars: f.bars });
        logger.info(`${ROLLOUT_JOB_ID}: DRY RUN — would flip ${f.purpose} ${f.from} → act (${f.reason}; ${JSON.stringify(f.bars)})`);
        continue;
      }
      try {
        // The SAME admission path as the admin PUT: caps, READY stamp, primary pin, control gate.
        await updateDecisionModes({ [f.purpose]: 'act' }, ROLLOUT_ACTOR, opts.primaryOpts);
        modeWrites++;
        flipped++;
        actions.push({ at: now.toISOString(), purpose: f.purpose, from: f.from, to: 'act', reason: f.reason === 'owner_answered' ? 'owner_answered' : 'flipped', bars: f.bars, by: ROLLOUT_ACTOR });
        await recordRolloutMetric({ purpose: f.purpose, from: f.from, to: 'act', reason: f.reason, dryRun: false, bars: f.bars });
        logger.info(`${ROLLOUT_JOB_ID}: flipped ${f.purpose} ${f.from} → act (${f.reason}; ${JSON.stringify(f.bars)})`);
      } catch (err: any) {
        refused++;
        const msg = String(err?.message || err).slice(0, 300);
        actions.push({ at: now.toISOString(), purpose: f.purpose, from: f.from, to: f.from, reason: 'refused', bars: { error: msg } });
        await recordRolloutMetric({ purpose: f.purpose, from: f.from, to: f.from, reason: 'refused', error: msg });
        logger.warn(`${ROLLOUT_JOB_ID}: flip of ${f.purpose} refused by admission — ${msg}`);
      }
    }
    for (const p of plan.closeAsks) delete state.ownerAsks[p];
    let asked = 0;
    for (const a of plan.asks) {
      if (dryRun) { logger.info(`${ROLLOUT_JOB_ID}: DRY RUN — would ask the owner about ${a.purpose} (tier ${a.tier})`); continue; }
      const r = await fileOwnerAsk(a.purpose, a.tier, a.why, now, [...(demotions[a.purpose] ?? [])].sort().pop());
      if (!r) continue;
      asked++;
      state.ownerAsks[a.purpose] = { questionId: r.questionId, at: now.toISOString(), tier: a.tier };
      actions.push({ at: now.toISOString(), purpose: a.purpose, from: 'shadow', to: 'shadow', reason: 'asked', bars: { questionId: r.questionId, tier: a.tier } });
      await recordRolloutMetric({ purpose: a.purpose, from: 'shadow', to: 'shadow', reason: 'asked', questionId: r.questionId, tier: a.tier });
    }
    // DECISION-GATE-LIFECYCLE: past-reviewBy / non-converging SHADOW purposes go off
    // through the SAME admin path (never an act purpose — auto-demote owns those).
    let lifecycleRetired = 0;
    let lifecycleWaived = 0;
    if (!lifecycleEnforceDisabled()) {
      const flipping = new Set(plan.flips.map(f => f.purpose));
      const lp = planLifecycle({ now, modes, stamp, state });
      // Review fix: every purpose the lifecycle looked at and did NOT retire (a pending review
      // date, a non-estimable AUROC, a retired human ask, a hand restore, a missing stamp) is
      // named once per pass, so an operator can see why enforcement did not happen.
      lifecycleWaived = lp.skipped.length;
      if (lp.skipped.length) logger.info(`${ROLLOUT_JOB_ID}: lifecycle not retired — ${lp.skipped.slice(0, 8).map(k => `${k.purpose}: ${k.reason}`).join('; ')}${lp.skipped.length > 8 ? ` (+${lp.skipped.length - 8} more)` : ''}`);
      for (const r of lp.retire) {
        if (flipping.has(r.purpose)) continue; // a READY purpose is converging — the flip wins (defensive; the bars exclude it)
        const reason = r.rule === 'review_by' ? 'lifecycle_retired' : 'lifecycle_parked';
        const bars = { rule: r.rule, detail: r.detail, ...r.metrics, ...(r.reviewBy ? { reviewBy: r.reviewBy } : {}) };
        if (dryRun) {
          actions.push({ at: now.toISOString(), purpose: r.purpose, from: r.from, to: 'off', reason: 'lifecycle_dry_run', bars });
          await recordLifecycleMetric({ purpose: r.purpose, from: r.from, to: 'off', dryRun: true, ...bars });
          logger.info(`${ROLLOUT_JOB_ID}: DRY RUN — would set ${r.purpose} off (${r.detail})`);
          continue;
        }
        try {
          await updateDecisionModes({ [r.purpose]: 'off' }, ROLLOUT_ACTOR, opts.primaryOpts);
          modeWrites++;
          lifecycleRetired++;
          const ticketId = r.rule === 'non_converging' ? await fileRePoseTicket(r, now) : null;
          state.lifecycle[r.purpose] = {
            rule: r.rule, at: now.toISOString(), from: r.from, detail: r.detail.slice(0, 300), partition: r.metrics.partition,
            n: r.metrics.n, ...(r.metrics.errors !== null ? { errors: r.metrics.errors } : {}), ...(ticketId ? { ticketId } : {}),
          };
          // Persist the ledger record NOW (review fix): the off-write above has committed, so a
          // failure of the pass's final state write would leave the purpose off with NO record —
          // the briefing would never name it and a later hand restore would be retired again.
          await writeRolloutState(state).catch((werr: any) => logger.warn(`${ROLLOUT_JOB_ID}: lifecycle record for ${r.purpose} not persisted yet (${werr?.message ?? werr}) — the pass's final state write retries it`));
          actions.push({ at: now.toISOString(), purpose: r.purpose, from: r.from, to: 'off', reason, bars: { ...bars, ...(ticketId ? { ticketId } : {}) }, by: ROLLOUT_ACTOR });
          await recordLifecycleMetric({ purpose: r.purpose, from: r.from, to: 'off', dryRun: false, ...bars, ...(ticketId ? { ticketId } : {}) });
          logger.info(`${ROLLOUT_JOB_ID}: lifecycle set ${r.purpose} ${r.from} → off (${r.detail})${ticketId ? ` — re-pose ticket ${ticketId}` : ''}`);
        } catch (err: any) {
          const msg = String(err?.message || err).slice(0, 300);
          actions.push({ at: now.toISOString(), purpose: r.purpose, from: r.from, to: r.from, reason: 'refused', bars: { ...bars, error: msg } });
          logger.warn(`${ROLLOUT_JOB_ID}: lifecycle off-write for ${r.purpose} refused — ${msg}`);
        }
      }
    }
    state.actions = [...actions, ...state.actions].slice(0, ROLLOUT_ACTIONS_KEEP);
    state.inconsistencies = plan.inconsistencies;
    state.lastRunAt = now.toISOString();
    if (computedAt) state.lastReadinessComputedAt = computedAt;
    const summary = `${dryRun ? 'DRY RUN: ' : ''}flipped ${flipped}${dry ? ` (would flip ${dry})` : ''}, refused ${refused}, asked ${asked}, parked ${plan.parks.length}, inconsistencies ${plan.inconsistencies.length}, evaluated ${modes.purposes.length}, lifecycle-off ${lifecycleRetired}${lifecycleWaived ? ` (${lifecycleWaived} not retired, logged)` : ''}, ${Date.now() - t0} ms`;
    state.lastSummary = summary;
    for (const i of plan.inconsistencies) logger.warn(`${ROLLOUT_JOB_ID}: inconsistency — ${i}`);
    await writeRolloutState(state);
    logger.info(`${ROLLOUT_JOB_ID}: ${summary}`);
    return summary.slice(0, 200);
  } catch (err: any) {
    const msg = String(err?.message || err);
    // Review fix: a failure AFTER a committed mode write says so (the old text claimed "no mode changed" even then).
    logger.warn(`${ROLLOUT_JOB_ID}: pass failed after ${Date.now() - t0} ms — ${modeWrites ? `${modeWrites} mode write${modeWrites === 1 ? '' : 's'} committed earlier in the pass stand${modeWrites === 1 ? 's' : ''}; nothing after the failure ran` : 'no mode changed'} (${msg})`);
    return `failed: ${msg}`.slice(0, 200);
  }
}

// ── Views (admin GET, the status tool, the briefing) ─────────────────────────

export interface RolloutView {
  switch: RolloutSwitchState;
  state: RolloutState;
  tierRule: string;
  recentDemotes: Awaited<ReturnType<typeof recentAutoDemotes>>;
}

export async function getRolloutView(): Promise<RolloutView> {
  const [sw, state, recentDemotes] = await Promise.all([getRolloutSwitchState(), readRolloutState(), recentAutoDemotes()]);
  return { switch: sw, state, tierRule: ROLLOUT_TIER_RULE, recentDemotes };
}

/** "Decision gate: …" for the owner briefing head — recent flips / parks / open owner asks in the last 7 days; null when quiet. Never throws. */
export async function rolloutBriefingLine(now = new Date()): Promise<string | null> {
  try {
    const [state, sw] = await Promise.all([readRolloutState(), getRolloutSwitchState()]);
    const since = now.getTime() - 7 * 86_400_000;
    const flips = state.actions.filter(a => Date.parse(a.at) >= since && (a.reason === 'flipped' || a.reason === 'owner_answered'));
    const parks = Object.entries(state.parked).filter(([, p]) => Date.parse(p.until) > now.getTime());
    const asks = Object.entries(state.ownerAsks);
    // DECISION-GATE-LIFECYCLE: purposes the registry lifecycle set off this week.
    const offs = Object.entries(state.lifecycle).filter(([, l]) => Date.parse(l.at) >= since);
    const parts: string[] = [];
    if (flips.length) parts.push(`${flips.length} purpose${flips.length === 1 ? '' : 's'} moved to act by the rollout automaton this week (${flips.map(f => `${f.purpose} ${relAge(f.at, now.getTime())}`).join(', ')})`);
    if (offs.length) parts.push(`set off by the registry lifecycle this week: ${offs.map(([k, l]) => `${k} (${l.rule === 'review_by' ? 'past its review date with the bar unmet' : `non-converging${typeof l.errors === 'number' && typeof l.n === 'number' ? ` — ${l.errors} errors in ${l.n} labels` : ''}${l.ticketId ? `; re-pose ticket ${l.ticketId.slice(0, 8)}` : ''}`})`).join(', ')}`);
    if (parks.length) parts.push(`parked after repeated auto-demotes: ${parks.map(([k]) => k).join(', ')}`);
    if (asks.length) parts.push(`ready and waiting for your answer: ${asks.map(([k]) => k).join(', ')}`);
    if (state.inconsistencies.length) parts.push(`${state.inconsistencies.length} store/code inconsistenc${state.inconsistencies.length === 1 ? 'y' : 'ies'} to settle by hand`);
    if (!parts.length) return null;
    return `Decision gate (auto-rollout ${sw.enabled ? (sw.dryRun ? 'ON, dry run' : 'ON') : 'OFF'}): ${parts.join('; ')}.`;
  } catch {
    return null;
  }
}

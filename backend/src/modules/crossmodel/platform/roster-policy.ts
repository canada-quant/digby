/**
 * Roster POLICY — the store-backed switches of the dynamic roster's model access (roster 2026-10-06 C-1 / C-3 / C-4).
 *
 * ONE reader of the fields Team C owns on the turn-plan config row ['instance','turn-plan'] / 'config' (the same row
 * carries the turn_plan act canary + the model-pick mode, read by turn-plan.ts; every writer keeps the other fields):
 *
 *   autoPickPolicy              'open_only' (DEFAULT, and the HARD RULE) | 'all'. Which models an AUTOMATIC pick (the
 *                               per-turn lead pick, the Quick / checker / colleague role picks, call_in, the admin Auto
 *                               pools, the session's sticky lead) may choose. Owner 2026-10-06 late, reversing the same
 *                               day's C-1 "any and all models": "pickers should never choose frontier anyway...the only
 *                               reason a frontier model is ever used is for a special use case and tool like
 *                               reflection" — a frontier model is consulted ONLY by the reflection council after
 *                               repeated failures (coding/frontier-council.ts). A stored 'all' is still PARSED (old
 *                               rows read) but IGNORED: the effective policy is 'open_only' (one log line + one
 *                               loop_metrics `auto_pick_policy` row per process says so) unless the env opt-in below.
 *   costPerUsd                  quality points (1–5 scale) one USD of estimated per-turn spend costs in the pick's
 *                               utility (default DEFAULT_COST_PER_USD = 1). 0 = price ignored.
 *   rolePick                    'off' | 'shadow' (DEFAULT) | 'act' — the Quick / checker / colleague picks (role-pick.ts).
 *   rolePickCanaryUserIds       users whose eligible turns ACT on the role picks while the mode is shadow.
 *   quickWebCap                 'off' | 'shadow' (DEFAULT) | 'act' — the Quick lane's harness web-tool budget
 *                               (coding/web-tool-cap.ts: QUICK_WEB_CAP_SEARCH search + QUICK_WEB_CAP_FETCH fetch).
 *   quickWebCapCanaryUserIds    users whose Quick turns run the budget in act while the mode is shadow.
 *
 * Env switches (each overrides the store):
 *   AUTO_PICK_FRONTIER_ENABLED=1    → the ONLY way back to the C-1 behaviour: the stored autoPickPolicy is honoured
 *                                     again ('all' admits frontier models to the pickers — they still need bench
 *                                     evidence and pay their price). Never via the store alone.
 *   AUTO_PICK_FRONTIER_DISABLED=1   → 'open_only' even under the opt-in. FRONTIER_SEATS_REFUSE=1 implies it too.
 *   MODEL_PICK_COST_DISABLED=1      → costPerUsd 0 (the pre-2026-10-06 quality − wait − failures utility).
 *   ROLE_PICK_DISABLED=1            → rolePick 'off' (seats only — today's checker / colleagues / Quick model).
 *   QUICK_LANE_WEB_CAP_DISABLED=1   → quickWebCap 'off' (no counting, no cap).
 *
 * Written by scripts/framework-audit/set-roster-policy.js. 30 s cache per process; a read failure serves the defaults
 * (fail CLOSED on frontier: 'open_only'; the act paths fall back to shadow = nothing changes for a user). Never throws.
 */

export type AutoPickPolicy = 'all' | 'open_only';
export type RosterActMode = 'off' | 'shadow' | 'act';

export const DEFAULT_AUTO_PICK_POLICY: AutoPickPolicy = 'open_only';
export const DEFAULT_COST_PER_USD = 1;
/** Hard ceiling on the stored weight (a typo of 1000 would make every pick "cheapest wins"). */
export const MAX_COST_PER_USD = 20;

export interface RosterPolicy {
  /** The EFFECTIVE policy (after the env switches): 'open_only' unless AUTO_PICK_FRONTIER_ENABLED=1. */
  autoPickPolicy: AutoPickPolicy;
  /** What the store row says (parsed so old rows still read; 'all' is ignored without the env opt-in). */
  storedAutoPickPolicy?: AutoPickPolicy;
  costPerUsd: number;
  rolePick: RosterActMode;
  rolePickCanaryUserIds: ReadonlySet<string>;
  quickWebCap: RosterActMode;
  quickWebCapCanaryUserIds: ReadonlySet<string>;
}

const NS = ['instance', 'turn-plan'];
const KEY = 'config';
const CACHE_MS = 30_000;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

export function autoPickFrontierDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return onFlag(env.AUTO_PICK_FRONTIER_DISABLED) || env.FRONTIER_SEATS_REFUSE === '1';
}
/**
 * The ONLY switch that lets an automatic picker choose a frontier-class model again (the C-1 behaviour): the env
 * opt-in AUTO_PICK_FRONTIER_ENABLED=1, and never while AUTO_PICK_FRONTIER_DISABLED / FRONTIER_SEATS_REFUSE is set.
 * Every picker reads this (model-pick.ts candidateFits, call-in.ts, session-roster.ts, auto-pools.service.ts). Pure.
 */
export function autoPickFrontierEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return onFlag(env.AUTO_PICK_FRONTIER_ENABLED) && !autoPickFrontierDisabled(env);
}
export function modelPickCostDisabled(env: Record<string, string | undefined> = process.env): boolean { return onFlag(env.MODEL_PICK_COST_DISABLED); }
export function rolePickDisabled(env: Record<string, string | undefined> = process.env): boolean { return onFlag(env.ROLE_PICK_DISABLED); }
export function quickWebCapDisabled(env: Record<string, string | undefined> = process.env): boolean { return onFlag(env.QUICK_LANE_WEB_CAP_DISABLED); }

const actMode = (v: unknown, dflt: RosterActMode): RosterActMode => (v === 'off' || v === 'shadow' || v === 'act' ? v : dflt);
const idSet = (v: unknown): Set<string> => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);

/** The stored row → a well-formed policy (unknown / malformed fields take their defaults). Pure. */
export function normalizeRosterPolicy(row: unknown): RosterPolicy {
  const r = (row && typeof row === 'object' && !Array.isArray(row) ? row : {}) as Record<string, unknown>;
  const cost = typeof r.costPerUsd === 'number' && Number.isFinite(r.costPerUsd) && r.costPerUsd >= 0 ? Math.min(MAX_COST_PER_USD, r.costPerUsd) : DEFAULT_COST_PER_USD;
  const stored: AutoPickPolicy = r.autoPickPolicy === 'open_only' || r.autoPickPolicy === 'all' ? r.autoPickPolicy : DEFAULT_AUTO_PICK_POLICY;
  return {
    autoPickPolicy: stored,
    storedAutoPickPolicy: stored,
    costPerUsd: cost,
    rolePick: actMode(r.rolePick, 'shadow'),
    rolePickCanaryUserIds: idSet(r.rolePickCanaryUserIds),
    quickWebCap: actMode(r.quickWebCap, 'shadow'),
    quickWebCapCanaryUserIds: idSet(r.quickWebCapCanaryUserIds),
  };
}

/** The env switches applied over a stored policy: frontier is never auto-pickable without the env opt-in. Pure. */
export function applyRosterKillSwitches(p: RosterPolicy, env: Record<string, string | undefined> = process.env): RosterPolicy {
  return {
    ...p,
    storedAutoPickPolicy: p.storedAutoPickPolicy ?? p.autoPickPolicy,
    autoPickPolicy: autoPickFrontierEnabled(env) ? p.autoPickPolicy : 'open_only',
    costPerUsd: modelPickCostDisabled(env) ? 0 : p.costPerUsd,
    rolePick: rolePickDisabled(env) ? 'off' : p.rolePick,
    quickWebCap: quickWebCapDisabled(env) ? 'off' : p.quickWebCap,
  };
}

let cache: { policy: RosterPolicy; expiresAt: number } | null = null;
/** Test hook (and the setter script's in-process invalidation). */
export function __resetRosterPolicyForTests(p: RosterPolicy | null = null): void {
  cache = p ? { policy: p, expiresAt: Date.now() + 60_000 } : null;
}

async function storedPolicy(): Promise<RosterPolicy> {
  if (cache && cache.expiresAt > Date.now()) return cache.policy;
  let policy: RosterPolicy;
  try {
    const { storeGet } = await import('../memory/context-store');
    policy = normalizeRosterPolicy(await storeGet<Record<string, unknown>>(NS, KEY));
  } catch {
    policy = normalizeRosterPolicy(null);
  }
  cache = { policy, expiresAt: Date.now() + CACHE_MS };
  return policy;
}

// A stored 'all' the hard rule ignores is said ONCE per process (log line + loop_metrics row) — never per pick.
let ignoredAllNoted = false;
export type IgnoredAllNotifier = () => void;
/**
 * The default notifier loads the logger + loop-metrics lazily, and only on a configured process (DATABASE_URL set):
 * both modules validate the env at import, and a unit suite that reads the policy must never boot them.
 */
const defaultIgnoredAllNotifier: IgnoredAllNotifier = () => {
  if (!process.env.DATABASE_URL) return;
  void import('../../../utils/logger')
    .then((m: any) => m?.default?.info?.('roster-policy: the stored autoPickPolicy is \'all\' but automatic pickers never choose frontier models (owner 2026-10-06) — effective policy open_only; AUTO_PICK_FRONTIER_ENABLED=1 is the only way back to the C-1 behaviour'))
    .catch(() => { /* logging never breaks a pick */ });
  void import('./loop-metrics.service')
    .then((m: any) => m?.recordLoopMetric?.({ kind: 'auto_pick_policy', meta: { stored: 'all', effective: 'open_only', reason: 'frontier_never_auto_picked' } }))
    .catch(() => { /* telemetry never breaks a pick */ });
};
let ignoredAllNotifier: IgnoredAllNotifier = defaultIgnoredAllNotifier;
/** Test hook: re-arm the once-per-process note and (optionally) swap the notifier. */
export function __resetIgnoredAllNoteForTests(notifier: IgnoredAllNotifier | null = null): void {
  ignoredAllNoted = false;
  ignoredAllNotifier = notifier ?? defaultIgnoredAllNotifier;
}
function noteIgnoredStoredAll(): void {
  if (ignoredAllNoted) return;
  ignoredAllNoted = true;
  try { ignoredAllNotifier(); } catch { /* never throws */ }
}

/** The policy in force (store + env switches). Never throws. */
export async function rosterPolicy(env: Record<string, string | undefined> = process.env): Promise<RosterPolicy> {
  const p = applyRosterKillSwitches(await storedPolicy().catch(() => normalizeRosterPolicy(null)), env);
  if (p.storedAutoPickPolicy === 'all' && p.autoPickPolicy === 'open_only' && !autoPickFrontierDisabled(env)) noteIgnoredStoredAll();
  return p;
}

export async function autoPickPolicy(env: Record<string, string | undefined> = process.env): Promise<AutoPickPolicy> {
  return (await rosterPolicy(env)).autoPickPolicy;
}

export async function pickCostPerUsd(env: Record<string, string | undefined> = process.env): Promise<number> {
  return (await rosterPolicy(env)).costPerUsd;
}

export interface ActDecision {
  mode: RosterActMode;
  /** This user's eligible turn ACTS (mode act, or a canary user while the mode is shadow). */
  acts: boolean;
  canary: boolean;
}

/** mode + canary → whether a user's turn acts. Pure. */
export function actDecision(mode: RosterActMode, canaryIds: ReadonlySet<string>, userId: string | null | undefined): ActDecision {
  const canary = mode === 'shadow' && !!userId && canaryIds.has(userId);
  return { mode, acts: mode === 'act' || canary, canary };
}

export async function rolePickDecision(userId: string | null | undefined, env: Record<string, string | undefined> = process.env): Promise<ActDecision> {
  const p = await rosterPolicy(env);
  return actDecision(p.rolePick, p.rolePickCanaryUserIds, userId);
}

export async function quickWebCapDecision(userId: string | null | undefined, env: Record<string, string | undefined> = process.env): Promise<ActDecision> {
  const p = await rosterPolicy(env);
  return actDecision(p.quickWebCap, p.quickWebCapCanaryUserIds, userId);
}

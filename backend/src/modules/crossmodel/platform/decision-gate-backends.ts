/**
 * Decision gate — per-purpose PRIMARY backend + CHALLENGERS as a STORE-BACKED,
 * instance-wide setting (open-weight decision-model plan items C / D / F,
 * 2026-09-26; owner: "support the open weight version of jev for testing
 * different decision models … we are self hosting laya now").
 *
 * WHY: the decision seat picks ONE backend chain for every purpose (seat model
 * → seat fallback → built-in jev → built-in deepseek readout). Comparing a
 * self-hosted Laya / JevK5 / NeoHorse server against TypeSafe Jev on Digby's
 * OWN labels needs two things the seat cannot express: a different PRIMARY per
 * purpose (a background purpose can trial a challenger as its primary while a
 * request-path purpose stays on Jev) and CHALLENGERS — backends that answer
 * the same ask in parallel, record their own decision + outcome rows, and
 * NEVER influence the answer. Model roles / decision modes solved the
 * fleet-wide-setting problem with ONE store row + a 30 s in-process cache +
 * fail-open; this module does the same for backends.
 *
 * STORE ROW: ['instance','decision-gate'] / 'backends' →
 *   { purposes: { <purpose>: { primary?: spec, challengers?: spec[] } },
 *     defaultChallengers?: spec[],
 *     temps?: { '<spec>|<purpose>': number },   // per-(backend,purpose) fitted temperature (plan item A writes it; read-only here)
 *     updatedBy, updatedAt }
 * A spec is what the seat takes: 'jev' | 'deepseek-flash' | '<label>:<modelId>'.
 *
 * SEMANTICS (decision-gate.ts):
 *   chain(purpose)      = dedupe([purposes[p].primary, seat model, seat fallback, jev, deepseek]) — primary FIRST
 *   challengers(purpose) = (purposes[p].challengers ?? defaultChallengers) − the chain's first leg, capped at
 *                          DECISION_GATE_CHALLENGER_MAX (default 2); run in PARALLEL with the chain from t0, never on
 *                          memo hits / opts.spec asks / purpose 'probe'. DETACHED since the 2026-09-26 Laya follow-up:
 *                          a challenger adds ZERO latency — the primary's answer returns as soon as the chain settles;
 *                          a still-running challenger keeps going in the background, bounded by its OWN deadline
 *                          t0 + DECISION_GATE_CHALLENGER_TIMEOUT_MS (default 5000, independent of the caller's
 *                          deadline — Laya's proxy serialises requests, up to ~2 s under load), and records its row
 *                          when it settles (ok:false 'challenger_timeout' on expiry). DECISION_GATE_CHALLENGER_GRACE_MS
 *                          is now an OPTIONAL post-primary wait (default 0). Each records its OWN decision row
 *                          { id: `${id}~c${n}`, challenger: true, primaryId, backend, backendSpec, mode: 'shadow' }
 *                          and, through DecideResult.challengers → DecisionStash.challengers, its OWN outcome row
 *                          (a challenger that settles after the primary's outcome was labelled IN THIS PROCESS is
 *                          paired through decision-gate.ts's late-outcome registry; across processes the stash
 *                          carries only what had settled when it was taken — see the decision-gate.ts header).
 *                          Challenger results never touch answers / backend / mode, are never memoised, and NEVER feed
 *                          the act-band auto-demote window.
 *   An explicit `challengers: []` on a purpose means NONE (it overrides defaultChallengers); an absent key inherits.
 *
 * PUT (plan item D, this half): a PRIMARY change on a purpose whose fleet-effective mode is `act` writes
 * modes[p] = 'shadow' (backends row first, then the modes row), resets that purpose's act-band window, drops the
 * chain cache, and records loop_metrics `decision_gate_backend_changed { purpose, from, to, demotedToShadow }` —
 * the readiness stamp was measured on the OLD backend, so act must be re-admitted through the readiness path.
 * "Promote challenger" is the documented PUT shape { purposes: { p: { primary: spec, challengers: (old − spec) ∪ [old primary] } } } —
 * no server-side special case.
 *
 * PLAN D SEAM (the readiness stamp / admission pin — core branch, decision-gate-modes setDecisionPrimaryResolver):
 * resolveEffectivePrimarySpec(purpose) names the purpose's fleet-effective primary (the STORED primary, else the
 * decision seat's model — switch-agnostic, fresh deduped read, never throws). registerDecisionPrimaryResolver()
 * hands it to decision-gate-modes' hook when that export exists (probed at import; a no-op until the core branch
 * merges) so the readiness job stamps the CONFIGURED primary's entry and admissionVerdict refuses act when the stamp
 * was measured on another backend — without the pin, "most labelled rows" could stamp a fallback leg.
 *
 * KNOBS:
 *   DECISION_GATE_CHALLENGER_MAX=<n>           — challengers per ask (default 2, 0 = none, hard cap 8)
 *   DECISION_GATE_CHALLENGER_GRACE_MS=<ms>     — an OPTIONAL post-primary wait for challengers (default 0 = none since the
 *                                               detached design; ceiling 10 s)
 *   DECISION_GATE_CHALLENGER_TIMEOUT_MS=<ms>   — a detached challenger's own deadline from t0 (default 5000, clamped 500..60000);
 *                                               on expiry its row reads ok:false error 'challenger_timeout'
 *   A missing / malformed row = no primary, no challengers = byte-identical to before this module.
 *
 * SYNC READ, ASYNC REFRESH (the decision-gate-modes contract): storedDecisionBackendsSync() serves the 30 s
 * in-process cache and schedules ONE background refresh when stale — never under NODE_ENV='test' / JEST_WORKER_ID
 * (hermeticity: the dynamic context-store import boots config/env, which process.exit()s a keyless jest). The
 * async storedDecisionBackends() (what resolveBackendChain uses — it is async anyway and already awaits the seat's
 * own store read) additionally AWAITS the first read on a cold cache in production, so a fresh process honours a
 * configured primary from its first ask. Tests that exercise the store call refreshDecisionBackends() themselves
 * with a mocked context-store.
 */

import logger from '../../../utils/logger';
import type { DecisionMode, DecisionPurpose } from './decision-gate';
import {
  DECISION_PURPOSES, clearDecisionModeCache, envDecisionMode, isStorablePurpose,
  normalizeStoredDecisionModes, resetActBandWindow,
} from './decision-gate-modes';
// The module namespace is probed (not typed) for the plan-D `setDecisionPrimaryResolver` hook the core branch adds —
// see registerDecisionPrimaryResolver below.
import * as decisionGateModes from './decision-gate-modes';

export const DECISION_BACKENDS_STORE_NS = ['instance', 'decision-gate'];
export const DECISION_BACKENDS_STORE_KEY = 'backends';
/** The modes row this module writes on a primary change (the decision-gate-modes row). */
const MODES_STORE_KEY = 'modes';
const CACHE_TTL_MS = 30_000;
export const CHALLENGER_MAX_DEFAULT = 2;
/** Hard ceiling on challengers per ask, whatever the env says — every challenger is a parallel backend call. */
export const CHALLENGER_MAX_CEILING = 8;
/** The OPTIONAL post-primary wait's default — 0 since the detached design (2026-09-26 Laya follow-up): a challenger never
 *  adds latency to the primary's answer. */
export const CHALLENGER_GRACE_DEFAULT_MS = 0;
/** Grace ceiling: the whole point is a bounded wait after the primary answers. */
export const CHALLENGER_GRACE_CEILING_MS = 10_000;
/** A detached challenger's own deadline from the ask's t0 (DECISION_GATE_CHALLENGER_TIMEOUT_MS): default 20 s since the
 *  2026-10-06 audit (T6-6, crosscutting X4: 681 of 1,614 challenger calls in 24 h ended `challenger_timeout` at the old 5 s —
 *  30–63 % per purpose, likely the larger states, so the agreement data was survivorship-biased). The challenger is
 *  DETACHED, so the longer deadline costs the caller nothing. Clamped 500 ms .. 60 s.
 *  DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED=1 restores the 5 s default (an explicit env value always wins). */
export const CHALLENGER_TIMEOUT_DEFAULT_MS = 20_000;
/** The pre-2026-10-06 default (Laya's proxy answers in 220–430 ms alone and up to ~2 s when it serialises 8 parallel asks). */
export const CHALLENGER_TIMEOUT_LEGACY_DEFAULT_MS = 5000;
export const CHALLENGER_TIMEOUT_MIN_MS = 500;
export const CHALLENGER_TIMEOUT_CEILING_MS = 60_000;
const SPEC_MAX_LEN = 300;
/** The built-in chain tail (decision-gate.ts DECISION_BUILT_IN_OPTIONS — passed in by the caller so this module never
 *  imports a decision-gate VALUE; only types cross that seam, keeping the import graph acyclic). */
export type StorablePurpose = Exclude<DecisionPurpose, 'probe'>;

export interface PurposeBackends {
  /** The spec that answers FIRST for this purpose (before the seat model). */
  primary?: string;
  /** Explicit challenger list; `[]` = none (overrides defaultChallengers); absent = inherit defaultChallengers. */
  challengers?: string[];
}

export interface StoredDecisionBackends {
  purposes: Partial<Record<StorablePurpose, PurposeBackends>>;
  defaultChallengers?: string[];
  /** Per-(backend, purpose) fitted temperature — written by the readiness job (plan item A); read-only here. */
  temps?: Record<string, number>;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

interface StoredRow {
  purposes?: Record<string, unknown>;
  defaultChallengers?: unknown;
  temps?: unknown;
  updatedBy?: unknown;
  updatedAt?: unknown;
}

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

// ── Kill switches / knobs ────────────────────────────────────────────────────

/** DECISION_GATE_CHALLENGER_MAX: challengers per ask; default 2; 0 = none; hard ceiling CHALLENGER_MAX_CEILING. */
export function challengerMax(): number {
  const raw = process.env.DECISION_GATE_CHALLENGER_MAX;
  if (raw === undefined || String(raw).trim() === '') return CHALLENGER_MAX_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return CHALLENGER_MAX_DEFAULT;
  return Math.min(CHALLENGER_MAX_CEILING, Math.floor(n));
}
/** DECISION_GATE_CHALLENGER_GRACE_MS: an OPTIONAL wait after the primary answers; default 0; ceiling 10 s. */
export function challengerGraceMs(): number {
  const fallback = CHALLENGER_GRACE_DEFAULT_MS;
  const raw = process.env.DECISION_GATE_CHALLENGER_GRACE_MS;
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(CHALLENGER_GRACE_CEILING_MS, Math.floor(n));
}
/** DECISION_GATE_CHALLENGER_TIMEOUT_MS: a detached challenger's own deadline from t0; default 20000 (5000 under
 *  DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED=1 — audit 2026-10-06 T6-6); clamped 500..60000. */
export function challengerTimeoutMs(): number {
  const fallback = onFlag(process.env.DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED) ? CHALLENGER_TIMEOUT_LEGACY_DEFAULT_MS : CHALLENGER_TIMEOUT_DEFAULT_MS;
  const raw = process.env.DECISION_GATE_CHALLENGER_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(CHALLENGER_TIMEOUT_CEILING_MS, Math.max(CHALLENGER_TIMEOUT_MIN_MS, Math.floor(n)));
}

// ── Normalisation (pure) ─────────────────────────────────────────────────────

/** A backend spec as stored: trimmed, non-empty, ≤ 300 chars; null otherwise. */
export function normalizeSpec(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= SPEC_MAX_LEN ? s : null;
}

/** A spec LIST as stored: valid specs only, deduped in order, capped at the challenger ceiling. */
export function normalizeSpecList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    const s = normalizeSpec(x);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= CHALLENGER_MAX_CEILING) break;
  }
  return out;
}

/** Pure: the stored row → known purposes with well-formed entries only. Never throws. */
export function normalizeStoredDecisionBackends(stored: StoredRow | null | undefined): StoredDecisionBackends {
  const out: StoredDecisionBackends = { purposes: {} };
  if (!stored || typeof stored !== 'object') return out;
  for (const [k, v] of Object.entries(stored.purposes ?? {})) {
    if (!isStorablePurpose(k) || !v || typeof v !== 'object') continue;
    const entry = v as Record<string, unknown>;
    const primary = normalizeSpec(entry.primary);
    const challengers = normalizeSpecList(entry.challengers);
    if (!primary && !challengers) continue;
    out.purposes[k] = { ...(primary ? { primary } : {}), ...(challengers ? { challengers } : {}) };
  }
  const defaults = normalizeSpecList(stored.defaultChallengers);
  if (defaults && defaults.length) out.defaultChallengers = defaults;
  if (stored.temps && typeof stored.temps === 'object' && !Array.isArray(stored.temps)) {
    const temps: Record<string, number> = {};
    for (const [k, v] of Object.entries(stored.temps as Record<string, unknown>)) {
      const n = Number(v);
      if (typeof k === 'string' && k.includes('|') && Number.isFinite(n) && n > 0) temps[k] = n;
    }
    if (Object.keys(temps).length) out.temps = temps;
  }
  if (typeof stored.updatedBy === 'string') out.updatedBy = stored.updatedBy;
  if (typeof stored.updatedAt === 'string') out.updatedAt = stored.updatedAt;
  return out;
}

/** Pure: the STORED primary for a purpose (null when none / unknown purpose) — the config-side read: what the fleet
 *  is configured to run. The PUT's before/after comparison and the plan-D readiness / admission pin use this one. */
export function storedPrimarySpecForPurpose(cfg: StoredDecisionBackends | null | undefined, purpose: string): string | null {
  if (!cfg || !isStorablePurpose(purpose)) return null;
  return cfg.purposes[purpose]?.primary ?? null;
}

/** Pure: the configured primary THIS process runs for a purpose (null when none / unknown purpose) —
 *  the runtime read-side view resolveBackendChain uses. */
export function primarySpecForPurpose(cfg: StoredDecisionBackends | null | undefined, purpose: string): string | null {
  return storedPrimarySpecForPurpose(cfg, purpose);
}

/** Pure: the challenger specs a purpose asks, BEFORE the answering-leg subtraction and the cap
 *  (purposes[p].challengers ?? defaultChallengers; [] when none / unknown purpose). */
export function configuredChallengerSpecs(cfg: StoredDecisionBackends | null | undefined, purpose: string): string[] {
  if (!cfg || !isStorablePurpose(purpose)) return [];
  const own = cfg.purposes[purpose]?.challengers;
  return (own ?? cfg.defaultChallengers ?? []).slice();
}

/** Pure: the challengers that actually run for one ask — the configured list minus the leg expected to answer
 *  (the chain's first spec), capped at DECISION_GATE_CHALLENGER_MAX. */
export function challengerSpecsForPurpose(cfg: StoredDecisionBackends | null | undefined, purpose: string, primarySpec: string | null | undefined): string[] {
  const max = challengerMax();
  if (max <= 0) return [];
  return configuredChallengerSpecs(cfg, purpose).filter(s => s !== (primarySpec || '')).slice(0, max);
}

/** Pure: the chain spec order for a purpose — configured primary FIRST, then the seat model, the seat's custom
 *  fallback, then the built-in tail; duplicates and empties removed. With no configured primary (or the kill
 *  switch) this is byte-identical to the pre-2026-09-26 global chain. */
export function chainSpecsForPurpose(
  cfg: StoredDecisionBackends | null | undefined,
  purpose: string,
  seat: { seatModel: string; seatFallback: string; builtIns: readonly string[] },
): string[] {
  const specs = [primarySpecForPurpose(cfg, purpose) ?? '', seat.seatModel, seat.seatFallback, ...seat.builtIns];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of specs) {
    const v = String(s || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ── Store-backed config (30 s cache, sync read, async refresh) ───────────────

let cache: { config: StoredDecisionBackends; expiresAt: number } | null = null;
let inFlight: Promise<StoredDecisionBackends> | null = null;

/** Test hook + admin mutation invalidation (this module's cache only — the chain cache lives in decision-gate.ts). */
export function clearDecisionBackendsConfigCache(): void { cache = null; inFlight = null; }

const underTest = (): boolean => process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;

/** Read the store row into the cache (deduped; fail-open to the last known row, else an empty config). */
export async function refreshDecisionBackends(): Promise<StoredDecisionBackends> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let config: StoredDecisionBackends = cache?.config ?? { purposes: {} };
    try {
      const { storeGet } = await import('../memory/context-store');
      config = normalizeStoredDecisionBackends(await storeGet<StoredRow>(DECISION_BACKENDS_STORE_NS, DECISION_BACKENDS_STORE_KEY));
    } catch (err: any) {
      logger.warn(`decision-gate-backends: store read failed (${err?.message}) — ${cache ? 'serving the last known backends' : 'no per-purpose backends apply'}`);
    }
    cache = { config, expiresAt: Date.now() + CACHE_TTL_MS };
    return config;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * The cached config, or null when the store has not been read yet. A stale
 * cache schedules ONE background refresh (never under test — see the header).
 */
export function storedDecisionBackendsSync(): StoredDecisionBackends | null {
  if (!cache || cache.expiresAt <= Date.now()) {
    if (!underTest() && !inFlight) {
      void refreshDecisionBackends().catch(() => { /* fail-open: logged inside */ });
    }
  }
  return cache?.config ?? null;
}

/**
 * The config for an async caller (resolveBackendChain): the cache when it
 * holds anything (stale → background refresh, like the sync read); on a COLD
 * cache in production the first read is awaited (deduped) so a fresh process
 * honours a configured primary at once; under test a cold cache is an empty
 * config unless the suite primed it with refreshDecisionBackends().
 */
export async function storedDecisionBackends(): Promise<StoredDecisionBackends> {
  const sync = storedDecisionBackendsSync();
  if (sync) return sync;
  if (underTest()) return { purposes: {} };
  try {
    return await refreshDecisionBackends();
  } catch {
    return { purposes: {} };
  }
}

// ── Plan D seam: the fleet-effective primary for the readiness stamp / admission pin ──

/**
 * The backend spec a purpose's PRIMARY leg is configured to run on, fleet-wide:
 * the STORED per-purpose primary (a fresh, deduped read of the backends row;
 * the stamp / admission judge the fleet), else the decision seat's model. Fail-open to the seat model; never throws. The readiness stamp
 * pins the entry measured on THIS spec and admissionVerdict refuses act when
 * its stamp names another.
 */
export async function resolveEffectivePrimarySpec(purpose: string): Promise<string> {
  const seat = await readSeat();
  try {
    return storedPrimarySpecForPurpose(await refreshDecisionBackends(), purpose) || seat.seatModel;
  } catch (err: any) {
    logger.warn(`decision-gate-backends: backends row unavailable for ${purpose} (${err?.message}) — the seat model is the primary`);
    return seat.seatModel;
  }
}

type PrimaryResolverHook = (fn: (purpose: string) => Promise<string | undefined>) => void;

/**
 * Hand resolveEffectivePrimarySpec to decision-gate-modes' `setDecisionPrimaryResolver`
 * (the plan-D hook: the readiness job asks it for primaryByPurpose, the modes
 * GET / PUT for the admission pin). Runs at import here AND explicitly at the
 * readiness job's load (integration 2026-09-26 — the worker process must not depend
 * on decision-gate.ts having loaded first); the admin controller additionally passes
 * resolveEffectivePrimarySpec to the modes GET / PUT as `primarySpecFor`. Idempotent;
 * registration only stores the function — no store read happens at import. `hook`
 * is the test seam.
 */
export function registerDecisionPrimaryResolver(hook?: PrimaryResolverHook): boolean {
  const fn = hook ?? (decisionGateModes as unknown as { setDecisionPrimaryResolver?: PrimaryResolverHook }).setDecisionPrimaryResolver;
  if (typeof fn !== 'function') return false;
  try {
    fn(resolveEffectivePrimarySpec);
    return true;
  } catch (err: any) {
    logger.warn(`decision-gate-backends: primary resolver registration failed (${err?.message}) — no readiness pin from this process`);
    return false;
  }
}
registerDecisionPrimaryResolver();

// ── Admin view ───────────────────────────────────────────────────────────────

export interface DecisionBackendCandidate {
  spec: string;
  /** 'systemone_chat' (2026-09-26 Laya follow-up): a typed-decision model reached through /chat/completions — the
   *  `systemone_chat` endpoint shape or a model flagged `decision:'systemone_chat'` on an OpenAI-compatible endpoint.
   *  Its ROWS still carry backendKind 'systemone' (same answer shape, same calibration rule). */
  kind: 'systemone' | 'logit' | 'systemone_chat';
  label: string;
  /** Calibrated by construction (the built-in jev) or by admin assertion (the endpoint model's `calibrated`
   *  flag). A fitted per-(backend, purpose) temperature also makes a backend calibrated at call time, but that
   *  is a per-purpose fact a candidate row cannot say — false here for the readouts and unflagged servers. */
  calibrated: boolean;
  servable: boolean;
  unservableReason?: string;
}

export interface DecisionBackendPurposeView {
  purpose: StorablePurpose;
  label: string;
  /** Stored per-purpose primary / challengers (null = unset → seat model / defaultChallengers). */
  primary: string | null;
  challengers: string[] | null;
  /** What runs: the configured primary, else the seat model. */
  effectivePrimary: string;
  /** The challengers that would run (before the answering-leg subtraction / cap). */
  effectiveChallengers: string[];
  /** The full chain spec order for the purpose (servability not applied). */
  chain: string[];
  /** The fleet-effective mode (store row, else env) — what a primary change would demote from. */
  mode: DecisionMode;
}

export interface DecisionBackendsConfig {
  config: StoredDecisionBackends;
  candidates: DecisionBackendCandidate[];
  purposes: DecisionBackendPurposeView[];
  seatModel: string;
  seatFallback: string;
  /** This process's knobs (env). */
  challengerMax: number;
  challengerGraceMs: number;
  /** 2026-09-26 (Laya follow-up): a detached challenger's own deadline from t0, and that challengers are detached (always, since the follow-up). */
  challengerTimeoutMs: number;
  challengerDetached: boolean;
}

async function readSeat(): Promise<{ seatModel: string; seatFallback: string }> {
  try {
    const { resolveRoleModel, resolveRoleFallback } = await import('../model-endpoints/model-roles.service');
    return { seatModel: await resolveRoleModel('decision'), seatFallback: await resolveRoleFallback('decision') };
  } catch (err: any) {
    logger.warn(`decision-gate-backends: seat resolution failed (${err?.message}) — assuming the built-in seat`);
    return { seatModel: 'jev', seatFallback: '' };
  }
}

async function readBuiltIns(): Promise<readonly string[]> {
  try {
    const { DECISION_BUILT_IN_OPTIONS } = await import('./decision-gate');
    return DECISION_BUILT_IN_OPTIONS;
  } catch { return ['jev', 'deepseek-flash']; }
}

/** The fleet-effective modes (store row, else env) — a fresh store read; fail-open to env. */
async function readFleetModes(): Promise<Partial<Record<StorablePurpose, DecisionMode>>> {
  try {
    const { storeGet } = await import('../memory/context-store');
    const stored = normalizeStoredDecisionModes(await storeGet<{ modes?: Record<string, string> }>(DECISION_BACKENDS_STORE_NS, MODES_STORE_KEY));
    return stored;
  } catch { return {}; }
}

const fleetEffectiveMode = (stored: Partial<Record<StorablePurpose, DecisionMode>>, purpose: StorablePurpose): DecisionMode =>
  stored[purpose] ?? envDecisionMode(purpose).mode;

/** Every spec the decision seat could be pointed at: the built-ins + every ENABLED registry model, with servability. */
export async function listDecisionBackendCandidates(): Promise<DecisionBackendCandidate[]> {
  const out: DecisionBackendCandidate[] = [];
  try {
    const dg = await import('./decision-gate');
    for (const spec of dg.DECISION_BUILT_IN_OPTIONS) {
      const envKey = dg.decisionSpecEnvKey(spec);
      const servable = !envKey || !!process.env[envKey];
      out.push({
        spec,
        kind: spec === dg.DECISION_BUILT_IN_JEV ? 'systemone' : 'logit',
        label: spec === dg.DECISION_BUILT_IN_JEV ? 'TypeSafe Jev' : 'DeepSeek logprob readout',
        calibrated: spec === dg.DECISION_BUILT_IN_JEV,
        servable,
        ...(servable ? {} : { unservableReason: `needs the ${envKey} environment variable, which is not set on this instance` }),
      });
    }
  } catch (err: any) {
    logger.warn(`decision-gate-backends: built-in candidates unavailable (${err?.message})`);
  }
  try {
    const { listEndpoints, resolveRegistryModel, modelKindOf } = await import('../model-endpoints/model-endpoints.service');
    const { registryDecisionTransport, systemOneBackendLabel, isTypedDecisionSpec } = await import('./decision-gate');
    for (const ep of await listEndpoints()) {
      if (!ep?.enabled || !Array.isArray(ep.models)) continue;
      for (const m of ep.models) {
        if (!m?.id) continue;
        // 2026-09-26: the chat transport (a `systemone_chat` endpoint, or a model flagged `decision:'systemone_chat'` on an
        // OpenAI-compatible endpoint — prod's `cql-litellm:agx-laya`) reads kind 'systemone_chat' here; an unflagged model
        // on an OpenAI-compatible endpoint stays the logprob readout, exactly as before.
        // Ticket 2df5ed65: the kind is modelKindOf (the same single source of truth as every other surface) —
        // a DECISION-KIND model (explicit kind, the [typed decisions] flag, a detection, or the id heuristic
        // reading `agx-laya`) resolves to the chat transport here too, so the candidate row matches what
        // backendForSpec actually drives at call time.
        const kindOfModel = modelKindOf(m as any);
        const spec = `${ep.label}:${m.id}`;
        // Review 3c18284e (condition 6): consult the latch — a spec this process learned
        // is typed-decision (guard 400 observed on its logit leg) shows as the chat
        // transport here too, matching what backendForSpec drives at call time. Without
        // it the picker kept offering the latched model as a "logprob readout".
        const transport = registryDecisionTransport({ providerShape: ep.providerShape, decision: (m as { decision?: unknown }).decision, kind: kindOfModel }, spec);
        const kind: DecisionBackendCandidate['kind'] = transport === 'systemone' ? 'systemone' : transport === 'chat' ? 'systemone_chat' : 'logit';
        // The label names the transport for a latch-learned spec too (the flag-shaped
        // "typed decisions via chat completions"), never the plain "(systemone)" one.
        const latchedChat = transport === 'chat' && kindOfModel !== 'decision'
          && ep.providerShape !== 'systemone_chat' && (m as { decision?: unknown }).decision !== 'systemone_chat'
          && isTypedDecisionSpec(spec);
        let servable = true;
        let unservableReason: string | undefined;
        try {
          servable = !!(await resolveRegistryModel(spec));
          if (!servable) unservableReason = 'does not resolve — check the endpoint label, model id, and that the endpoint is enabled (a key that no longer decrypts also fails)';
        } catch { servable = true; }
        out.push({
          spec, kind,
          label: kind === 'logit' ? `${ep.label} logprob readout` : systemOneBackendLabel(ep.label, ep.providerShape, (m as { decision?: unknown }).decision, latchedChat ? 'decision' : kindOfModel),
          // Plan A (integration 2026-09-26): a registry backend is calibrated only when the admin flagged the
          // model entry `calibrated:true` (or once a temperature is fitted per (spec, purpose) — a per-purpose
          // fact a candidate row cannot say). A bare systemone server is NOT presumed calibrated (Laya ships
          // ECE ≈ 0.47 raw) — the same rule decision-gate.ts isCalibratedBackend applies at call time.
          calibrated: (m as { calibrated?: unknown }).calibrated === true,
          servable,
          ...(unservableReason ? { unservableReason } : {}),
        });
      }
    }
  } catch (err: any) {
    logger.warn(`decision-gate-backends: registry candidates unavailable (${err?.message})`);
  }
  return out;
}

/** The admin view: the stored row, every candidate spec, and per purpose what runs (fresh store reads). */
export async function getDecisionBackendsConfig(): Promise<DecisionBackendsConfig> {
  const [config, seat, builtIns, modes, candidates] = await Promise.all([
    refreshDecisionBackends(), readSeat(), readBuiltIns(), readFleetModes(), listDecisionBackendCandidates(),
  ]);
  const purposes: DecisionBackendPurposeView[] = DECISION_PURPOSES.map(p => {
    const stored = config.purposes[p.purpose];
    const chain = chainSpecsForPurpose(config, p.purpose, { seatModel: seat.seatModel, seatFallback: seat.seatFallback, builtIns });
    return {
      purpose: p.purpose, label: p.label,
      primary: stored?.primary ?? null,
      challengers: stored?.challengers ? stored.challengers.slice() : null,
      effectivePrimary: primarySpecForPurpose(config, p.purpose) || seat.seatModel || chain[0] || '',
      effectiveChallengers: configuredChallengerSpecs(config, p.purpose),
      chain,
      mode: fleetEffectiveMode(modes, p.purpose),
    };
  });
  return {
    config, candidates, purposes, seatModel: seat.seatModel, seatFallback: seat.seatFallback,
    challengerMax: challengerMax(), challengerGraceMs: challengerGraceMs(),
    challengerTimeoutMs: challengerTimeoutMs(), challengerDetached: true,
  };
}

// ── Admin PUT ────────────────────────────────────────────────────────────────

export interface DecisionBackendsPatch {
  /** Per purpose: `primary` '' clears (seat model applies); `challengers` null clears (inherit defaultChallengers),
   *  [] = explicitly none; an absent key leaves that field untouched. */
  purposes?: Record<string, { primary?: string; challengers?: string[] | null }>;
  /** [] clears. */
  defaultChallengers?: string[];
}

interface PurposeChange { purpose: StorablePurpose; primary?: string | null; challengers?: string[] | null }

/**
 * Admin PUT. Validates every spec with the decision seat's own assignability
 * rule (model-roles.service assertDecisionSpecAssignable — built-in vocabulary
 * or a registered endpoint model that resolves), read-modify-writes the ONE
 * backends row, then — for every purpose whose STORED (fleet-effective) primary
 * moved while its fleet-effective mode is act — writes modes[p] = 'shadow' into the modes
 * row (backends first, then modes), resets the act-band window and drops both
 * caches on this process (other boxes within the 30 s TTL). Returns the fresh
 * admin view.
 */
export async function updateDecisionBackends(patchIn: unknown, userId?: string): Promise<DecisionBackendsConfig> {
  const { AppError } = await import('../../../middleware/error-handler');
  const patch = (patchIn && typeof patchIn === 'object' ? patchIn : {}) as DecisionBackendsPatch;
  const purposeEntries = Object.entries(patch.purposes ?? {});
  const hasDefaults = patch.defaultChallengers !== undefined;
  if (!purposeEntries.length && !hasDefaults) {
    throw new AppError(400, 'Nothing to update — send { purposes: { "<purpose>": { primary?: "<spec>" | "", challengers?: ["<spec>", …] | null } }, defaultChallengers?: ["<spec>", …] }.');
  }
  const { assertDecisionSpecAssignable } = await import('../model-endpoints/model-roles.service');
  const vet = async (spec: unknown, where: string): Promise<string> => {
    const s = normalizeSpec(spec);
    if (!s) throw new AppError(400, `Invalid backend spec ${JSON.stringify(spec)} for ${where} — a non-empty string of at most ${SPEC_MAX_LEN} characters.`);
    await assertDecisionSpecAssignable(s);
    return s;
  };
  const vetList = async (list: unknown, where: string): Promise<string[]> => {
    if (!Array.isArray(list)) throw new AppError(400, `${where} must be an array of backend specs.`);
    if (list.length > CHALLENGER_MAX_CEILING) throw new AppError(400, `${where} lists ${list.length} challengers — the ceiling is ${CHALLENGER_MAX_CEILING}.`);
    const out: string[] = [];
    for (const x of list) {
      const s = await vet(x, where);
      if (!out.includes(s)) out.push(s);
    }
    return out;
  };
  const changes: PurposeChange[] = [];
  for (const [k, v] of purposeEntries) {
    if (!isStorablePurpose(k)) throw new AppError(400, `Unknown decision-gate purpose "${k}" — one of ${DECISION_PURPOSES.map(p => p.purpose).join(', ')}.`);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError(400, `purposes.${k} must be an object { primary?, challengers? }.`);
    const entry = v as { primary?: unknown; challengers?: unknown };
    const change: PurposeChange = { purpose: k };
    if (entry.primary !== undefined) {
      change.primary = typeof entry.primary === 'string' && entry.primary.trim() === '' ? null : await vet(entry.primary, `purposes.${k}.primary`);
    }
    if (entry.challengers !== undefined) {
      change.challengers = entry.challengers === null ? null : await vetList(entry.challengers, `purposes.${k}.challengers`);
    }
    if (change.primary === undefined && change.challengers === undefined) throw new AppError(400, `purposes.${k} carries neither primary nor challengers.`);
    changes.push(change);
  }
  const defaultChallengers = hasDefaults ? await vetList(patch.defaultChallengers, 'defaultChallengers') : undefined;

  const { storeGet, storePut } = await import('../memory/context-store');
  let existing: StoredDecisionBackends = { purposes: {} };
  try { existing = normalizeStoredDecisionBackends(await storeGet<StoredRow>(DECISION_BACKENDS_STORE_NS, DECISION_BACKENDS_STORE_KEY)); } catch { existing = { purposes: {} }; }
  const seat = await readSeat();
  // The STORED primary: the act→shadow demotion must follow the config every box runs.
  const effectivePrimaryOf = (cfg: StoredDecisionBackends, p: StorablePurpose): string => storedPrimarySpecForPurpose(cfg, p) || seat.seatModel;

  // Apply.
  const next: StoredDecisionBackends = {
    purposes: Object.fromEntries(Object.entries(existing.purposes).map(([k, v]) => [k, { ...(v as PurposeBackends) }])) as StoredDecisionBackends['purposes'],
    ...(existing.defaultChallengers ? { defaultChallengers: existing.defaultChallengers.slice() } : {}),
    ...(existing.temps ? { temps: { ...existing.temps } } : {}),
  };
  const movedPrimary: Array<{ purpose: StorablePurpose; from: string; to: string }> = [];
  const movedChallengers: Array<{ purpose: StorablePurpose; from: string[]; to: string[] }> = [];
  for (const c of changes) {
    const cur: PurposeBackends = { ...(next.purposes[c.purpose] ?? {}) };
    const beforePrimary = effectivePrimaryOf(next, c.purpose);
    const beforeChallengers = configuredChallengerSpecs(next, c.purpose);
    if (c.primary !== undefined) {
      if (c.primary) cur.primary = c.primary; else delete cur.primary;
    }
    if (c.challengers !== undefined) {
      if (c.challengers) cur.challengers = c.challengers; else delete cur.challengers;
    }
    if (cur.primary || cur.challengers) next.purposes[c.purpose] = cur; else delete next.purposes[c.purpose];
    const afterPrimary = effectivePrimaryOf(next, c.purpose);
    if (beforePrimary !== afterPrimary) movedPrimary.push({ purpose: c.purpose, from: beforePrimary, to: afterPrimary });
    const afterChallengers = configuredChallengerSpecs(next, c.purpose);
    if (JSON.stringify(beforeChallengers) !== JSON.stringify(afterChallengers)) movedChallengers.push({ purpose: c.purpose, from: beforeChallengers, to: afterChallengers });
  }
  if (defaultChallengers !== undefined) {
    if (defaultChallengers.length) next.defaultChallengers = defaultChallengers; else delete next.defaultChallengers;
  }
  const now = new Date().toISOString();
  // 1) backends row FIRST (the chain must already point at the new primary when the mode drops).
  await storePut(DECISION_BACKENDS_STORE_NS, DECISION_BACKENDS_STORE_KEY, {
    purposes: next.purposes as Record<string, unknown>,
    ...(next.defaultChallengers ? { defaultChallengers: next.defaultChallengers } : {}),
    ...(next.temps ? { temps: next.temps } : {}),
    updatedBy: userId ?? null,
    updatedAt: now,
  });
  clearDecisionBackendsConfigCache();
  try {
    const { clearDecisionBackendCache } = await import('./decision-gate');
    clearDecisionBackendCache();
  } catch { /* the chain cache expires on its own within 30 s */ }

  // 2) then the modes row: a moved primary on a fleet-effective ACT purpose drops to shadow.
  const demoted: StorablePurpose[] = [];
  if (movedPrimary.length) {
    let modes: Partial<Record<StorablePurpose, DecisionMode>> = {};
    let modesReadOk = true;
    try { modes = normalizeStoredDecisionModes(await storeGet<{ modes?: Record<string, string> }>(DECISION_BACKENDS_STORE_NS, MODES_STORE_KEY)); } catch { modesReadOk = false; }
    const toDemote = movedPrimary.filter(m => fleetEffectiveMode(modes, m.purpose) === 'act').map(m => m.purpose);
    if (toDemote.length) {
      if (!modesReadOk) {
        // The modes row could not be read: writing a partial row would drop every other purpose's mode. Fail
        // loudly rather than silently — the backends row is already written, the admin must re-PUT the mode.
        logger.error(`decision-gate-backends: primary moved on act purpose(s) ${toDemote.join(', ')} but the modes row could not be read — NOT demoting; set them to shadow via PUT /admin/model-roles/decision-modes`);
      } else {
        for (const p of toDemote) modes[p] = 'shadow';
        await storePut(DECISION_BACKENDS_STORE_NS, MODES_STORE_KEY, {
          modes, updatedBy: `backend-change:${userId ?? 'admin'}`, updatedAt: now,
          backendChanged: movedPrimary.filter(m => toDemote.includes(m.purpose)).map(m => ({ purpose: m.purpose, from: m.from, to: m.to })),
        });
        clearDecisionModeCache();
        for (const p of toDemote) {
          demoted.push(p);
          resetActBandWindow(p, 'primary backend changed — act dropped to shadow');
        }
        logger.warn(`decision-gate-backends: primary backend moved on ACT purpose(s) ${toDemote.join(', ')} — mode dropped to shadow fleet-wide; the readiness stamp was measured on the previous backend, re-admit act after the next readiness run`);
      }
    }
  }
  // Telemetry: loop-metrics boots config/env, so it is imported at call time
  // (the decision-gate-modes precedent) — a keyless process never loads it here.
  try {
    const { recordLoopMetric } = await import('./loop-metrics.service');
    for (const m of movedPrimary) {
      recordLoopMetric({
        kind: 'decision_gate_backend_changed',
        value: demoted.includes(m.purpose) ? 1 : 0,
        meta: { field: 'primary', purpose: m.purpose, from: m.from, to: m.to, demotedToShadow: demoted.includes(m.purpose), updatedBy: userId ?? null },
      });
    }
    for (const m of movedChallengers) {
      recordLoopMetric({
        kind: 'decision_gate_backend_changed',
        value: 0,
        meta: { field: 'challengers', purpose: m.purpose, from: m.from.join(','), to: m.to.join(','), demotedToShadow: false, updatedBy: userId ?? null },
      });
    }
    if (defaultChallengers !== undefined && JSON.stringify(existing.defaultChallengers ?? []) !== JSON.stringify(defaultChallengers)) {
      recordLoopMetric({
        kind: 'decision_gate_backend_changed',
        value: 0,
        meta: { field: 'defaultChallengers', purpose: '*', from: (existing.defaultChallengers ?? []).join(','), to: defaultChallengers.join(','), demotedToShadow: false, updatedBy: userId ?? null },
      });
    }
  } catch { /* telemetry never throws */ }
  logger.info(`decision-gate-backends: updated ${changes.map(c => `${c.purpose}{${c.primary !== undefined ? `primary=${c.primary ?? '(seat)'}` : ''}${c.challengers !== undefined ? ` challengers=${c.challengers ? `[${c.challengers.join(',')}]` : '(default)'}` : ''}}`).join(', ')}${defaultChallengers !== undefined ? ` defaultChallengers=[${defaultChallengers.join(',')}]` : ''}${userId ? ` by ${userId}` : ''}${demoted.length ? ` — demoted to shadow: ${demoted.join(', ')}` : ''}`);
  return getDecisionBackendsConfig();
}

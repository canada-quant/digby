/**
 * Auto pools — dynamic roster phase 1 (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §4 B.2;
 * owner chose option B on 2026-10-03).
 *
 * The admin's ORDERED model lists the roster planner picks from, one per role:
 *   quick     — the Quick lane's lead (lookups / live facts, thinking off)
 *   lead      — the lead for the Standard / Checked / Research lanes
 *   checker   — the Double Checker candidates (the planner prefers a model of a
 *               DIFFERENT family than the lead — independent coverage)
 *   colleague — the research-council colleagues
 * An EMPTY pool follows its seats (quick → Quick answers, lead → Digby,
 * checker → Double Checker, colleague → Double + Triple Checker), so an
 * instance nobody configures behaves exactly as the seats say today.
 *
 * A frontier-class model (provider-class.ts) NEVER sits in a pool (owner
 * 2026-10-06 late, reversing the same day's C-1 "any and all models":
 * "pickers should never choose frontier anyway") — refused at save time with
 * a message pointing at the reflection council (the one place frontier
 * models run, coding/frontier-council.ts) and dropped from a stored pool at
 * read time, whatever the store's autoPickPolicy says. Only the env opt-in
 * AUTO_PICK_FRONTIER_ENABLED=1 restores the C-1 admission. Seats themselves
 * are the owner's explicit setting and are never filtered here.
 *
 * Storage: ONE context-store row ['instance','auto-pools'] / 'config' —
 * { pools: { <role>: string[] }, updatedAt, updatedBy } — read through a 30 s
 * cache by every box (no redeploy). Kill switch AUTO_POOLS_DISABLED=1: every
 * pool follows its seats.
 */

import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { storeGet, storePut } from '../memory/context-store';
import { catalogBySpec, listChatModelCatalog, type ModelCard } from './model-catalog';
import type { ModelRoleKey } from './model-roles.service';
import { specIsFrontier } from './provider-class';
import { autoPickFrontierEnabled } from '../platform/roster-policy';

export type PoolRole = 'quick' | 'lead' | 'checker' | 'colleague';
export const POOL_ROLES: readonly PoolRole[] = ['quick', 'lead', 'checker', 'colleague'];

/** The seats a pool follows while it is empty, in order. */
export const POOL_SEATS: Readonly<Record<PoolRole, readonly ModelRoleKey[]>> = {
  quick: ['chat_quick'],
  lead: ['chat_orchestrator'],
  checker: ['double_checker'],
  colleague: ['double_checker', 'triple_checker'],
};

/** Display names (admin UI + audit lines). */
export const POOL_LABELS: Readonly<Record<PoolRole, string>> = {
  quick: 'Quick lane',
  lead: 'Lead',
  checker: 'Checker',
  colleague: 'Research colleagues',
};

export const POOL_MAX_MODELS = 6;

export interface AutoPoolsConfig {
  pools: Partial<Record<PoolRole, string[]>>;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface EffectivePool {
  role: PoolRole;
  /** The ordered specs the planner picks from. */
  models: string[];
  /** 'pool' = the admin's list; 'seats' = following the seats (empty / disabled / nothing survived). */
  source: 'pool' | 'seats';
  /** Stored entries left out at read time, with why (endpoint gone, frontier, …). */
  dropped: Array<{ spec: string; reason: string }>;
}

const STORE_NS = ['instance', 'auto-pools'];
const STORE_KEY = 'config';
const CACHE_TTL_MS = 30_000;
let cache: { config: AutoPoolsConfig; expiresAt: number } | null = null;

/** Test hook + mutation invalidation. */
export function clearAutoPoolsCache(): void { cache = null; }

export function autoPoolsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = String(env.AUTO_POOLS_DISABLED ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

/** Strings only, trimmed, non-empty, de-duplicated (first wins), at most POOL_MAX_MODELS. Pure. */
export function normalizePoolList(raw: unknown): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= POOL_MAX_MODELS) break;
  }
  return out;
}

/** The refusal every frontier-class pool entry gets (owner 2026-10-06 late) — it names where frontier models DO run. */
export const FRONTIER_POOL_REFUSAL = 'frontier-class model — automatic picks never choose frontier models (owner 2026-10-06); a frontier model is consulted only by the reflection council after repeated failures (Account → Admin → Endpoints → Model roles → Reflection council)';

/** Why a spec may not sit in an auto pool, or null when it may. A frontier-class model is refused whatever the store's
 *  auto-pick policy says (the env opt-in AUTO_PICK_FRONTIER_ENABLED=1 restores the C-1 admission). Pure over env. */
export function poolSpecRefusal(spec: string, card: ModelCard | undefined, env: Record<string, string | undefined> = process.env): string | null {
  if (!card) return 'not a chat model on this instance (unknown built-in, or the endpoint is missing / disabled / lists it as a non-chat model)';
  if ((card.frontier || specIsFrontier(spec)) && !autoPickFrontierEnabled(env)) return FRONTIER_POOL_REFUSAL;
  if (!card.autoEligible) {
    return card.frontier
      ? 'frontier-class model — this instance\'s auto-pick policy is open models only (open_only)'
      : 'not eligible for automatic picks';
  }
  return null;
}

/**
 * The pool the planner reads for one role (pure over its inputs): the stored
 * list minus entries that no longer qualify, else the seats' models
 * (de-duplicated, unfiltered — a seat is the owner's explicit pick).
 */
export function effectivePool(role: PoolRole, stored: readonly string[] | undefined, seatModels: readonly string[], catalog: Map<string, ModelCard>, disabled = false): EffectivePool {
  const dropped: Array<{ spec: string; reason: string }> = [];
  const kept: string[] = [];
  if (!disabled) {
    for (const spec of normalizePoolList(stored ?? [])) {
      const why = poolSpecRefusal(spec, catalog.get(spec));
      if (why) dropped.push({ spec, reason: why });
      else kept.push(spec);
    }
  }
  if (kept.length) return { role, models: kept, source: 'pool', dropped };
  const seats: string[] = [];
  for (const m of seatModels) if (m && !seats.includes(m)) seats.push(m);
  return { role, models: seats, source: 'seats', dropped };
}

function normalizeStored(raw: any): AutoPoolsConfig {
  const pools: Partial<Record<PoolRole, string[]>> = {};
  for (const role of POOL_ROLES) {
    const list = normalizePoolList(raw?.pools?.[role]);
    if (list.length) pools[role] = list;
  }
  return {
    pools,
    ...(typeof raw?.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof raw?.updatedBy === 'string' ? { updatedBy: raw.updatedBy } : {}),
  };
}

/** The stored config (30 s cache; a read failure serves the last good copy, else empty). */
export async function getAutoPoolsConfig(): Promise<AutoPoolsConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.config;
  try {
    const raw = await storeGet<Record<string, unknown>>(STORE_NS, STORE_KEY);
    const config = normalizeStored(raw);
    cache = { config, expiresAt: Date.now() + CACHE_TTL_MS };
    return config;
  } catch (err: any) {
    logger.warn(`auto-pools: store read failed (${err?.message ?? err}) — ${cache ? 'serving the last good copy' : 'pools follow their seats'}`);
    return cache?.config ?? { pools: {} };
  }
}

/** The seat models each pool follows when empty (resolved live; '' entries dropped). */
async function seatModelsByPool(): Promise<Record<PoolRole, string[]>> {
  const { resolveRoleModel } = await import('./model-roles.service');
  const out = {} as Record<PoolRole, string[]>;
  for (const role of POOL_ROLES) {
    const models: string[] = [];
    for (const seat of POOL_SEATS[role]) {
      const m = await resolveRoleModel(seat).catch(() => '');
      if (m) models.push(m);
    }
    out[role] = models;
  }
  return out;
}

/** Every pool as the planner reads it right now. Never throws (falls back to seats). */
export async function resolveEffectivePools(catalogIn?: readonly ModelCard[]): Promise<Record<PoolRole, EffectivePool>> {
  const [config, seats, catalog] = await Promise.all([
    getAutoPoolsConfig().catch(() => ({ pools: {} } as AutoPoolsConfig)),
    seatModelsByPool().catch(() => ({ quick: [], lead: [], checker: [], colleague: [] } as Record<PoolRole, string[]>)),
    catalogIn ? Promise.resolve(catalogIn) : listChatModelCatalog().catch(() => [] as ModelCard[]),
  ]);
  const bySpec = catalogBySpec(catalog);
  const disabled = autoPoolsDisabled();
  const out = {} as Record<PoolRole, EffectivePool>;
  for (const role of POOL_ROLES) out[role] = effectivePool(role, config.pools[role], seats[role], bySpec, disabled);
  return out;
}

/**
 * Admin write. Each role in the patch REPLACES that pool ([] or null clears it
 * back to the seats); roles absent from the patch are untouched. Every spec is
 * validated against the live catalog — an unknown or frontier model refuses
 * the whole save with a 400 naming each problem.
 */
export async function updateAutoPools(patch: Partial<Record<PoolRole, string[] | null>>, by?: string | null, catalogIn?: readonly ModelCard[]): Promise<AutoPoolsConfig> {
  const unknownRoles = Object.keys(patch ?? {}).filter((k) => !(POOL_ROLES as readonly string[]).includes(k));
  if (unknownRoles.length) throw new AppError(400, `Unknown pool${unknownRoles.length > 1 ? 's' : ''}: ${unknownRoles.join(', ')} (pools: ${POOL_ROLES.join(', ')})`);
  const catalog = catalogBySpec(catalogIn ?? (await listChatModelCatalog()));
  const current = await getAutoPoolsConfig();
  const pools: Partial<Record<PoolRole, string[]>> = { ...current.pools };
  const problems: string[] = [];
  for (const role of POOL_ROLES) {
    if (!(role in (patch ?? {}))) continue;
    const raw = (patch as any)[role];
    if (raw === null || (Array.isArray(raw) && raw.length === 0)) { delete pools[role]; continue; }
    if (!Array.isArray(raw)) { problems.push(`${POOL_LABELS[role]}: expected a list of model specs`); continue; }
    if (raw.filter((x: unknown) => typeof x === 'string' && x.trim()).length > POOL_MAX_MODELS) problems.push(`${POOL_LABELS[role]}: at most ${POOL_MAX_MODELS} models`);
    const list = normalizePoolList(raw);
    for (const spec of list) {
      const why = poolSpecRefusal(spec, catalog.get(spec));
      if (why) problems.push(`${POOL_LABELS[role]} — ${spec}: ${why}`);
    }
    pools[role] = list;
  }
  if (problems.length) throw new AppError(400, `Auto pools not saved: ${problems.join('; ')}`);
  const next: AutoPoolsConfig = { pools, updatedAt: new Date().toISOString(), updatedBy: by ?? null };
  await storePut(STORE_NS, STORE_KEY, next as unknown as Record<string, unknown>);
  clearAutoPoolsCache();
  logger.info(`auto-pools: saved by ${by ?? 'unknown'} — ${POOL_ROLES.map((r) => `${r}=[${(pools[r] ?? []).join(', ') || 'seats'}]`).join(' ')}`);
  return next;
}

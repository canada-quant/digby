/**
 * REFLECTION COUNCIL — the admin-editable FRONTIER list (owner 2026-10-06 late: "the only reason a frontier model is
 * ever used is for a special use case and tool like reflection when a coding agent or any agent makes multiple
 * failures it should reflect then message a frontier of its choosing or multiple to create a council citing all its
 * failures and goals and where it is at").
 *
 * Automatic pickers never choose a frontier-class model (platform/roster-policy.ts — the F1 hard rule). The ONE place
 * frontier models run is the reflection council (coding/frontier-council.ts): after repeated failures an agent writes
 * its reflection and calls `consult_frontier_council` with 1–3 frontier advisors OF ITS CHOOSING. This module owns:
 *
 *   candidates  every servable frontier-class chat model on an enabled registry endpoint (provider-class.ts — e.g.
 *               cql-litellm:api-anthropic-claude-*, api-openai-gpt-*, api-xai-grok-*), with its price when one is on
 *               record, ORDERED BY PROVIDER DIVERSITY (round-robin across families; strongest tier first inside a
 *               family) — the list the agent chooses from (any of them);
 *   default     the 1–3 models the HARNESS uses when it runs the council itself (the agent ignored the reflect note
 *               for 2 steps, or the run is stopping): the admin's list (Account → Admin → Endpoints → Model roles →
 *               Reflection council) — stored entries that stopped resolving are dropped with the reason — else the
 *               first REFLECTION_COUNCIL_MAX candidates of the diversity order.
 *
 * Storage: the model-roles namespace of the context store, its own key — ['instance','model-roles'] / 'reflection-council'
 * = { models: string[], updatedAt, updatedBy } (the seats row's read-modify-write never touches it). 30 s cache. No
 * migration. Never throws on read (an unreadable row = no admin list = the diversity default).
 */

import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { storeGet, storePut } from '../memory/context-store';
import type { ModelCard, ModelTier } from './model-catalog';

export const REFLECTION_COUNCIL_MAX = 3;
const STORE_NS = ['instance', 'model-roles'];
const STORE_KEY = 'reflection-council';
const CACHE_TTL_MS = 30_000;

export interface ReflectionCouncilConfig {
  models: string[];
  updatedAt?: string;
  updatedBy?: string | null;
}

/** One frontier model the council may seat. */
export interface FrontierCouncilModel {
  spec: string;
  name: string;
  family: string;
  tier: ModelTier;
  /** USD per 1M tokens, null = no price on record (the council estimates with model-pick's UNKNOWN_FRONTIER_PRICE). */
  priceIn: number | null;
  priceOut: number | null;
}

export interface ResolvedReflectionCouncil {
  /** Every model the agent may choose (diversity order). */
  candidates: FrontierCouncilModel[];
  /** The harness auto-run's pick (1..REFLECTION_COUNCIL_MAX). */
  defaults: string[];
  source: 'admin' | 'diversity';
  config: ReflectionCouncilConfig;
  /** Stored admin entries left out (endpoint gone / not frontier / not servable), with why. */
  dropped: Array<{ spec: string; reason: string }>;
}

const TIER_RANK: Readonly<Record<ModelTier, number>> = { strong: 0, standard: 1, fast: 2 };

/** The servable frontier-class chat models of a catalog, as council candidates (catalog order). Pure. */
export function frontierCouncilModels(catalog: readonly ModelCard[]): FrontierCouncilModel[] {
  return catalog
    .filter((c) => c.frontier && c.servable)
    .map((c) => ({ spec: c.spec, name: c.name, family: c.family, tier: c.tier, priceIn: c.priceIn, priceOut: c.priceOut }));
}

/**
 * Provider diversity (pure): round-robin across families in the order each family first appears, strongest tier
 * first inside a family (stable on the input order) — three picks span three vendors whenever three exist.
 */
export function orderByProviderDiversity<T extends { family: string; tier: ModelTier }>(models: readonly T[]): T[] {
  const families: string[] = [];
  const byFamily = new Map<string, Array<{ m: T; i: number }>>();
  models.forEach((m, i) => {
    if (!byFamily.has(m.family)) { byFamily.set(m.family, []); families.push(m.family); }
    byFamily.get(m.family)!.push({ m, i });
  });
  for (const list of byFamily.values()) list.sort((a, b) => TIER_RANK[a.m.tier] - TIER_RANK[b.m.tier] || a.i - b.i);
  const out: T[] = [];
  for (let round = 0; out.length < models.length; round++) {
    for (const f of families) {
      const e = byFamily.get(f)![round];
      if (e) out.push(e.m);
    }
  }
  return out;
}

/** Strings only, trimmed, de-duplicated, at most REFLECTION_COUNCIL_MAX. Pure. */
export function normalizeCouncilList(raw: unknown): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= REFLECTION_COUNCIL_MAX) break;
  }
  return out;
}

/** Why a spec may not sit on the council (null = it may). Pure. */
export function councilSpecRefusal(spec: string, card: ModelCard | undefined): string | null {
  if (!card) return 'not a chat model on this instance (the endpoint is missing / disabled, or lists it as a non-chat model)';
  if (!card.frontier) return 'not a frontier-class model — the reflection council seats frontier models only (open models already run every automatic pick)';
  if (!card.servable) return 'not servable on this instance';
  return null;
}

/** The effective council (pure over the stored config + the catalog). */
export function resolveCouncilFrom(config: ReflectionCouncilConfig, catalog: readonly ModelCard[]): ResolvedReflectionCouncil {
  const candidates = orderByProviderDiversity(frontierCouncilModels(catalog));
  const bySpec = new Map(catalog.map((c) => [c.spec, c] as const));
  const dropped: Array<{ spec: string; reason: string }> = [];
  const kept: string[] = [];
  for (const spec of normalizeCouncilList(config.models)) {
    const why = councilSpecRefusal(spec, bySpec.get(spec));
    if (why) dropped.push({ spec, reason: why });
    else kept.push(spec);
  }
  if (kept.length) return { candidates, defaults: kept, source: 'admin', config, dropped };
  return { candidates, defaults: candidates.slice(0, REFLECTION_COUNCIL_MAX).map((m) => m.spec), source: 'diversity', config, dropped };
}

let cache: { config: ReflectionCouncilConfig; expiresAt: number } | null = null;
/** Test hook + mutation invalidation. */
export function clearReflectionCouncilCache(): void { cache = null; }

function normalizeStored(raw: any): ReflectionCouncilConfig {
  return {
    models: normalizeCouncilList(raw?.models),
    ...(typeof raw?.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof raw?.updatedBy === 'string' ? { updatedBy: raw.updatedBy } : {}),
  };
}

/** The stored admin list (30 s cache; a read failure serves the last good copy, else none). Never throws. */
export async function getReflectionCouncilConfig(): Promise<ReflectionCouncilConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.config;
  try {
    const config = normalizeStored(await storeGet<Record<string, unknown>>(STORE_NS, STORE_KEY));
    cache = { config, expiresAt: Date.now() + CACHE_TTL_MS };
    return config;
  } catch (err: any) {
    logger.warn(`reflection-council: store read failed (${err?.message ?? err}) — ${cache ? 'serving the last good copy' : 'the diversity default stands'}`);
    return cache?.config ?? { models: [] };
  }
}

/** The council as the harness reads it right now. Never throws (no catalog ⇒ no candidates). */
export async function resolveReflectionCouncil(catalogIn?: readonly ModelCard[]): Promise<ResolvedReflectionCouncil> {
  const [config, catalog] = await Promise.all([
    getReflectionCouncilConfig().catch(() => ({ models: [] } as ReflectionCouncilConfig)),
    catalogIn ? Promise.resolve(catalogIn) : import('./model-catalog').then((m) => m.listChatModelCatalog()).catch(() => [] as ModelCard[]),
  ]);
  return resolveCouncilFrom(config, catalog);
}

/**
 * Admin write: REPLACES the list ([] clears it back to the diversity default). Every spec must be a servable
 * frontier-class chat model on this instance; 1–3 models. Refuses the whole save (400) naming each problem.
 */
export async function updateReflectionCouncil(models: unknown, by?: string | null, catalogIn?: readonly ModelCard[]): Promise<ReflectionCouncilConfig> {
  if (models !== null && !Array.isArray(models)) throw new AppError(400, 'Reflection council not saved: expected { models: string[] } (1–3 frontier model specs, [] to clear)');
  const raw = Array.isArray(models) ? models.filter((x: unknown) => typeof x === 'string' && x.trim()) : [];
  if (raw.length > REFLECTION_COUNCIL_MAX) throw new AppError(400, `Reflection council not saved: at most ${REFLECTION_COUNCIL_MAX} models`);
  const list = normalizeCouncilList(raw);
  const catalog: readonly ModelCard[] = catalogIn ?? (await import('./model-catalog').then((m) => m.listChatModelCatalog()));
  const bySpec = new Map(catalog.map((c) => [c.spec, c] as const));
  const problems = list.map((spec) => ({ spec, why: councilSpecRefusal(spec, bySpec.get(spec)) })).filter((p) => p.why);
  if (problems.length) throw new AppError(400, `Reflection council not saved: ${problems.map((p) => `${p.spec}: ${p.why}`).join('; ')}`);
  const next: ReflectionCouncilConfig = { models: list, updatedAt: new Date().toISOString(), updatedBy: by ?? null };
  await storePut(STORE_NS, STORE_KEY, next as unknown as Record<string, unknown>);
  clearReflectionCouncilCache();
  logger.info(`reflection-council: saved by ${by ?? 'unknown'} — [${list.join(', ') || 'diversity default'}]`);
  return next;
}

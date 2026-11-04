/**
 * GHOST MODE designation (owner 2026-10-22: "private ghost mode for a session
 * … changes models to a specific new endpoint we set in admin or backend that
 * points to ablitered self hosted models").
 *
 * Ghost mode is a per-chat privacy posture: a chat flagged ghost runs its
 * ENTIRE model lineup (lead, Double Checker, council colleagues) on ONE
 * admin-designated model spec — an '<label>:<modelId>' registry spec pointing
 * at a self-hosted endpoint — and stays out of memory extraction, learning and
 * cross-chat surfacing. Both guests and signed-in users can use it.
 *
 * This module owns the ADMIN DESIGNATION only (the storage + validation +
 * resolution contract):
 *
 *   storage   the model-roles namespace of the context store, its own key —
 *             ['instance','model-roles'] / 'ghost-endpoint'
 *             = { spec: string | null, enabled: boolean, updatedAt, updatedBy }
 *             (the seats row's read-modify-write never touches it — the same
 *             deliberate-namespace rule as reflection-council). 30 s cache.
 *             No migration.
 *   validate  a non-null spec must be an enabled, SERVABLE, CHAT-capable
 *             registry model (assertAssignable's rule) — an unresolvable /
 *             non-chat / retired spec refuses the save with a precise 400.
 *   resolve   what a RUN should route to: null when ghost mode is unset,
 *             disabled (the enabled flag), killed (CHAT_GHOST_MODE_DISABLED=1)
 *             or the spec no longer resolves/serves — the caller then keeps
 *             the normal lineup and says so honestly.
 *
 * Fail-open everywhere a READ can fail (an unreadable row = no designation =
 * normal chats); the WRITE path is the only strict one.
 */

import { AppError } from '../../../middleware/error-handler';
import { storeGet, storePut } from '../memory/context-store';
import { ghostModeDisabled } from '../chat-agent/ghost-runtime';
import type { ModelCard } from './model-catalog';

const STORE_NS = ['instance', 'model-roles'];
const STORE_KEY = 'ghost-endpoint';
const CACHE_TTL_MS = 30_000;

export interface GhostEndpointConfig {
  /** '<label>:<modelId>' registry spec, or null = no designation. */
  spec: string | null;
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface ResolvedGhostEndpoint {
  /** The spec a ghost run should route every leg to; null = normal lineup. */
  spec: string | null;
  /** Why it is null when it is (the honest-notice vocabulary). */
  reason: 'unset' | 'disabled' | 'switch' | 'unresolvable' | 'ok';
  config: GhostEndpointConfig | null;
}

let cache: { at: number; value: GhostEndpointConfig } | null = null;

/** Test hook — drop the cached designation row. */
export function clearGhostEndpointCache(): void {
  cache = null;
}

function emptyConfig(): GhostEndpointConfig {
  return { spec: null, enabled: false };
}

/** The stored designation (never throws — an unreadable row = no designation). */
export async function getGhostEndpointConfig(): Promise<GhostEndpointConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const row = await storeGet(STORE_NS, STORE_KEY).catch(() => null) as GhostEndpointConfig | null;
  const value: GhostEndpointConfig = row && typeof row === 'object'
    ? {
        spec: typeof row.spec === 'string' && row.spec.trim() ? row.spec.trim() : null,
        enabled: row.enabled !== false,
        ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
        ...(row.updatedBy !== undefined ? { updatedBy: row.updatedBy ?? null } : {}),
      }
    : emptyConfig();
  cache = { at: Date.now(), value };
  return value;
}

/** Why a stored spec may not be designated (null = it may). Pure over the catalog. */
export function ghostSpecRefusal(spec: string, card: ModelCard | undefined): string | null {
  if (!card) return 'not a chat model on this instance (the endpoint is missing / disabled, or lists it as a non-chat model)';
  if (!card.servable) return 'not servable on this instance';
  return null;
}

/** The catalog card for a stored spec, when the catalog knows it. Pure. */
function cardForSpec(spec: string, catalog: readonly ModelCard[]): ModelCard | undefined {
  return catalog.find((c) => c.spec === spec);
}

/**
 * What a RUN routes a ghost chat's legs to. Pure over the stored config + the
 * catalog, EXCEPT the kill-switch read (an env read, cheap). Never throws.
 */
export function resolveGhostEndpoint(config: GhostEndpointConfig, catalog: readonly ModelCard[]): ResolvedGhostEndpoint {
  if (!config.spec) return { spec: null, reason: 'unset', config: null };
  if (!config.enabled) return { spec: null, reason: 'disabled', config };
  if (ghostModeDisabled()) return { spec: null, reason: 'switch', config };
  const refusal = ghostSpecRefusal(config.spec, cardForSpec(config.spec, catalog));
  if (refusal) return { spec: null, reason: 'unresolvable', config };
  return { spec: config.spec, reason: 'ok', config };
}

/**
 * The designation a RUN actually uses — resolves the stored row against the
 * LIVE catalog (the one decision read on the run path). Never throws.
 */
export async function resolveGhostEndpointForRun(): Promise<ResolvedGhostEndpoint> {
  if (ghostModeDisabled()) return { spec: null, reason: 'switch', config: null };
  const config = await getGhostEndpointConfig();
  if (!config.spec) return { spec: null, reason: 'unset', config: null };
  if (!config.enabled) return { spec: null, reason: 'disabled', config };
  try {
    const { listChatModelCatalog } = await import('./model-catalog');
    const catalog = await listChatModelCatalog();
    return resolveGhostEndpoint(config, catalog);
  } catch {
    return { spec: null, reason: 'unresolvable', config };
  }
}

/**
 * PUT /admin/model-roles/ghost-endpoint — { spec, enabled? } REPLACES the
 * designation. spec null / '' CLEARS it. A non-null spec must resolve to an
 * enabled, servable, chat-capable registry model — the whole save refuses
 * (400) with the human reason otherwise (never a partially-updated row).
 */
export async function updateGhostEndpoint(
  spec: string | null | undefined,
  enabled: boolean | undefined,
  updatedBy: string | null,
  catalog: readonly ModelCard[],
): Promise<GhostEndpointConfig> {
  const raw = typeof spec === 'string' ? spec.trim() : '';
  if (!raw) {
    const cleared: GhostEndpointConfig = { spec: null, enabled: false };
    await storePut(STORE_NS, STORE_KEY, { ...cleared, updatedAt: new Date().toISOString(), updatedBy });
    cache = { at: Date.now(), value: cleared };
    return cleared;
  }
  if (raw.includes(':') === false) {
    throw new AppError(400, `"${raw}" is not a ghost endpoint designation — use a "<label>:<modelId>" registry spec (Account → Admin → Endpoints).`);
  }
  const refusal = ghostSpecRefusal(raw, cardForSpec(raw, catalog));
  if (refusal) {
    throw new AppError(400, `"${raw}" cannot be the ghost endpoint: it is ${refusal}.`);
  }
  const next: GhostEndpointConfig = { spec: raw, enabled: enabled !== false, updatedAt: new Date().toISOString(), updatedBy };
  await storePut(STORE_NS, STORE_KEY, { ...next });
  cache = { at: Date.now(), value: next };
  return next;
}

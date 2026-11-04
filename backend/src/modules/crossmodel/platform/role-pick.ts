/**
 * ROLE picks at run time — the Quick model, the Double Checker and the council colleagues chosen per turn from their
 * Auto pools (roster 2026-10-06 C-3; readiness report #10 partial). Today those three are FIXED seats; the lead is
 * already picked per turn (model-pick.ts pickModel via the turn plan).
 *
 * The pure choice is model-pick.ts pickForRole (same utility as the lead pick — quality − wait − failures − cost —
 * plus the family rule: a checker / colleague is never of the lead's family). This module gathers what it needs —
 * the evidence snapshot (model-evidence.ts, cached), the live catalog + Auto pools, the cost weight and the act
 * decision — and returns, per slot, the pick + whether it ACTS for this user:
 *
 *   mode 'off'     nothing is computed (ROLE_PICK_DISABLED=1 or the store says off);
 *   mode 'shadow'  (the DEFAULT) computed and RECORDED only (loop_metrics `role_pick`), never awaited on the answer
 *                  path by the caller — except for a user on `rolePickCanaryUserIds`, whose turn ACTS;
 *   mode 'act'     every eligible turn acts.
 * Set with scripts/framework-audit/set-roster-policy.js (fields `rolePick`, `rolePickCanaryUserIds`).
 *
 * Candidates per slot: the admin's Auto pool for the role when one is configured (quick / checker / colleague), else
 * every catalog model (the picker filters servable / auto-eligible / chat / thinking-off-capable for Quick) — the same
 * rule as the lead pick. A model with no bench evidence is never chosen (no live exploration). The SEAT always stands
 * when nothing clearly beats it, and the caller runs the seat when a picked model fails (fail OPEN).
 *
 * Never throws: any error ⇒ null (the caller keeps the seats).
 */

import { recordLoopMetric } from './loop-metrics.service';
import { pickForRole, rankForRole, type PickCandidate, type PickRole, type RolePick } from './model-pick';
import { evidenceFrom, loadModelEvidence, type EvidenceSnapshot } from './model-evidence';
import type { ActDecision } from './roster-policy';
import type { EffectivePool, PoolRole } from '../model-endpoints/auto-pools.service';
import { modelFamily, type ModelCard } from '../model-endpoints/model-catalog';

/** How long an ACTING turn waits for the pick inputs (evidence is warmed at boot; catalog + pools are two small
 *  reads). Past it the seats run. */
export const ROLE_PICK_WAIT_MS = 800;

export interface RolePickSlotRequest { slot: string; seat: string }

export interface RolePickRequest {
  userId: string | null;
  /** The model leading this turn (the Quick model, the picked lead or the seat). */
  lead: string;
  stakes: number | null;
  images: boolean;
  quick?: { seat: string } | null;
  checker?: { seat: string } | null;
  /** Council slots in dispatch order (double_checker, triple_checker). */
  colleagues?: RolePickSlotRequest[] | null;
  /** Telemetry. */
  sessionId?: string;
  lane?: string | null;
}

export interface RolePickResult {
  decision: ActDecision;
  quick: RolePick | null;
  checker: RolePick | null;
  colleagues: Array<{ slot: string; pick: RolePick }>;
}

export interface RolePickDeps {
  decision: (userId: string | null) => Promise<ActDecision>;
  evidence: () => Promise<EvidenceSnapshot | null>;
  catalog: () => Promise<ModelCard[]>;
  pools: (catalog: ModelCard[]) => Promise<Record<PoolRole, EffectivePool> | null>;
  costPerUsd: () => Promise<number>;
  familyOf: (spec: string) => string;
}

const defaultDeps: RolePickDeps = {
  decision: async (userId) => (await import('./roster-policy')).rolePickDecision(userId),
  evidence: () => loadModelEvidence(),
  catalog: async () => (await import('../model-endpoints/model-catalog')).listChatModelCatalog(),
  pools: async (catalog) => (await import('../model-endpoints/auto-pools.service')).resolveEffectivePools(catalog),
  costPerUsd: async () => (await import('./roster-policy')).pickCostPerUsd(),
  familyOf: modelFamily,
};

/** The role's candidate list: its admin pool's cards when configured, else every catalog card. Pure. */
export function roleCandidates(role: PoolRole, pools: Record<PoolRole, EffectivePool> | null, catalog: readonly ModelCard[]): PickCandidate[] {
  const pool = pools?.[role];
  if (pool && pool.source === 'pool' && pool.models.length) {
    const bySpec = new Map(catalog.map((c) => [c.spec, c] as const));
    return pool.models.map((s) => bySpec.get(s)).filter((c): c is ModelCard => !!c);
  }
  return [...catalog];
}

function record(req: RolePickRequest, decision: ActDecision, role: PickRole, pick: RolePick, slot?: string): void {
  recordLoopMetric({
    kind: 'role_pick',
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    meta: {
      role, ...(slot ? { slot } : {}), seat: pick.seat, spec: pick.spec, changed: pick.changed, familyForced: pick.familyForced,
      act: decision.acts && pick.changed, mode: decision.mode, ...(decision.canary ? { canary: true } : {}),
      lead: req.lead, ...(req.lane ? { lane: req.lane } : {}), reason: pick.reason.slice(0, 240),
      ranked: pick.ranked.slice(0, 3).map((r) => ({ spec: r.spec, u: r.utility, ttft: r.ttftP50Ms, q: r.quality, ...(r.usd !== undefined ? { usd: r.usd } : {}) })),
    },
  });
}

/**
 * Compute the role picks for one turn. Returns null when the mode is off or anything fails (the caller keeps the
 * seats). Records one `role_pick` loop metric per computed slot. Never throws.
 */
export async function resolveRolePicks(req: RolePickRequest, deps: RolePickDeps = defaultDeps): Promise<RolePickResult | null> {
  try {
    const decision = await deps.decision(req.userId).catch((): ActDecision => ({ mode: 'off', acts: false, canary: false }));
    if (decision.mode === 'off') return null;
    if (!req.quick && !req.checker && !(req.colleagues && req.colleagues.length)) return null;
    const catalog = await deps.catalog().catch(() => [] as ModelCard[]);
    const [snapshot, pools, perUsd] = await Promise.all([
      deps.evidence().catch(() => null),
      deps.pools(catalog).catch(() => null),
      deps.costPerUsd().catch(() => 0),
    ]);
    const evidence = evidenceFrom(snapshot);
    const bySpec = new Map(catalog.map((c) => [c.spec, c] as const));
    const cost = perUsd > 0 ? { perUsd, priceOf: (spec: string) => bySpec.get(spec) ?? null } : null;
    const familyOf = (spec: string) => bySpec.get(spec)?.family ?? deps.familyOf(spec);
    const leadFamily = familyOf(req.lead);
    const out: RolePickResult = { decision, quick: null, checker: null, colleagues: [] };
    if (req.quick?.seat) {
      out.quick = pickForRole({ role: 'quick', stakes: req.stakes, images: req.images, seat: req.quick.seat, candidates: roleCandidates('quick', pools, catalog), evidence, familyOf, cost });
      record(req, decision, 'quick', out.quick);
    }
    if (req.checker?.seat) {
      out.checker = pickForRole({ role: 'checker', stakes: req.stakes, images: false, seat: req.checker.seat, candidates: roleCandidates('checker', pools, catalog), evidence, familyOf, avoidFamilies: [leadFamily], exclude: [req.lead], cost });
      record(req, decision, 'checker', out.checker);
    }
    if (req.colleagues?.length) {
      const taken: string[] = [req.lead];
      const families: string[] = [leadFamily];
      for (const s of req.colleagues) {
        const pick = pickForRole({ role: 'colleague', stakes: req.stakes, images: false, seat: s.seat, candidates: roleCandidates('colleague', pools, catalog), evidence, familyOf, avoidFamilies: families, exclude: taken, cost });
        out.colleagues.push({ slot: s.slot, pick });
        record(req, decision, 'colleague', pick, s.slot);
        taken.push(pick.spec);
        families.push(familyOf(pick.spec));
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Race the picks against ROLE_PICK_WAIT_MS (an ACTING turn waits at most that long). Never throws. */
export async function resolveRolePicksBounded(req: RolePickRequest, waitMs: number = ROLE_PICK_WAIT_MS, deps: RolePickDeps = defaultDeps): Promise<RolePickResult | null> {
  const TIMED_OUT = Symbol('role-pick-timeout');
  const raced = await Promise.race([
    resolveRolePicks(req, deps),
    new Promise<typeof TIMED_OUT>((res) => setTimeout(() => res(TIMED_OUT), waitMs).unref?.()),
  ]).catch(() => null);
  return raced === TIMED_OUT ? null : (raced as RolePickResult | null);
}

/** The spec a slot should RUN: the pick when it acts and changed, else null (keep the seat). Pure. */
export function actingSpec(r: RolePickResult | null | undefined, pick: RolePick | null | undefined): string | null {
  return r && r.decision.acts && pick && pick.changed && pick.spec !== pick.seat ? pick.spec : null;
}

/**
 * call_in (Team D, chat-agent/call-in.ts) ordering — roster 2026-10-06 C-3. D's pickCallInModels already filters the
 * pools to servable, other-family candidates in POOL order; this re-orders them by the role utility (quality − wait −
 * failures − cost; measured first, unmeasured keep D's order) when the role pick ACTS for this user (rolePick act, or a
 * rolePickCanaryUserIds user while shadow). Otherwise D's order stands and the would-be order is recorded only
 * (loop_metrics role_pick, callIn: true). Never throws: any failure returns `picks` unchanged.
 * Integration: in call-in.ts, after `const picks = pickCallInModels(...)`:
 *   const ordered = await rankCallInCandidates(role, picks, { userId, lead, stakes: null, sessionId });
 * and iterate `ordered` instead of `picks`.
 */
export async function rankCallInCandidates<T extends { spec: string }>(
  role: 'checker' | 'colleague',
  picks: readonly T[],
  opts: { userId: string | null; lead?: string; stakes?: number | null; sessionId?: string },
  deps: Pick<RolePickDeps, 'decision' | 'evidence' | 'catalog' | 'costPerUsd'> = defaultDeps,
): Promise<T[]> {
  const original = [...picks];
  try {
    if (original.length < 2) return original;
    const decision = await deps.decision(opts.userId).catch((): ActDecision => ({ mode: 'off', acts: false, canary: false }));
    if (decision.mode === 'off') return original;
    const [snapshot, catalog, perUsd] = await Promise.all([
      deps.evidence().catch(() => null),
      deps.catalog().catch(() => [] as ModelCard[]),
      deps.costPerUsd().catch(() => 0),
    ]);
    const bySpec = new Map(catalog.map((c) => [c.spec, c] as const));
    const ranked = rankForRole(role, original, {
      stakes: opts.stakes ?? null, evidence: evidenceFrom(snapshot),
      cost: perUsd > 0 ? { perUsd, priceOf: (spec: string) => bySpec.get(spec) ?? null } : null,
    });
    const changed = ranked[0]?.spec !== original[0]?.spec;
    recordLoopMetric({
      kind: 'role_pick',
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      meta: {
        role, callIn: true, seat: original[0]?.spec, spec: ranked[0]?.spec, changed, act: decision.acts && changed, mode: decision.mode,
        ...(decision.canary ? { canary: true } : {}), ...(opts.lead ? { lead: opts.lead } : {}),
        ranked: ranked.slice(0, 3).map((r) => ({ spec: r.spec, u: r.utility, ...(r.usd !== undefined ? { usd: r.usd } : {}) })),
      },
    });
    if (!decision.acts) return original;
    const order = new Map(ranked.map((r, i) => [r.spec, i] as const));
    return [...original].sort((a, b) => (order.get(a.spec) ?? 0) - (order.get(b.spec) ?? 0));
  } catch {
    return original;
  }
}

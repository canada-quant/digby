/**
 * Digby Edge (Phase 2) — thin HTTP transport over model-endpoints.service.ts
 * (mirrors fleet.controller.ts style: try/catch → next(error), AppError carries
 * the status). Every endpoint is ADMIN-gated the same way crossmodel.controller's
 * admin handlers are (403 { error } before touching the service).
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../../middleware/auth';
import * as service from './model-endpoints.service';
import * as rolesService from './model-roles.service';
import * as decisionModes from '../platform/decision-gate-modes';
import * as decisionReadiness from '../platform/decision-gate-readiness';
import * as decisionBackends from '../platform/decision-gate-backends';
import * as decisionRegistry from '../platform/decision-gate-registry';
import * as decisionRollout from '../platform/decision-gate-rollout';
import { decisionSpendByPurpose24h } from '../platform/decision-gate-spend';
import { verifyEndpointModel } from './endpoint-verifier';
import { frontierSeatsAllowed } from './provider-class';
import logger from '../../../utils/logger';

/** Integration seam (b) (2026-09-26): the decision-modes GET / PUT judge admission
 *  against the purpose's EFFECTIVE primary backend (the stored per-purpose primary,
 *  else the decision seat — decision-gate-backends resolveEffectivePrimarySpec), so
 *  a READY stamp measured on another backend refuses act. Passed explicitly rather
 *  than relying on the backends module's import-time hook; a missing resolver (an
 *  older mock / build) leaves the pin off — pre-change behaviour, fail-open. */
function decisionPrimaryOpts(): decisionModes.DecisionModeOpts {
  const resolve = (decisionBackends as { resolveEffectivePrimarySpec?: (purpose: string) => Promise<string> }).resolveEffectivePrimarySpec;
  return typeof resolve === 'function' ? { primarySpecFor: (purpose: string) => resolve(purpose) } : {};
}

/** Same gate crossmodel.controller's admin handlers use. */
function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden: admin access required' });
    return false;
  }
  return true;
}

class ModelEndpointsController {
  /** GET /admin/model-endpoints — sanitized list (hasApiKey, never the key). */
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: { endpoints: await service.listEndpoints() } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/model-endpoints — create an instance-wide endpoint. */
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const endpoint = await service.createEndpoint(req.body);
      res.status(201).json({ success: true, data: { endpoint } });
    } catch (error) {
      next(error);
    }
  }

  /** PATCH /admin/model-endpoints/:id — partial update (apiKey '' clears). */
  async update(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const endpoint = await service.updateEndpoint(req.params.id, req.body);
      res.json({ success: true, data: { endpoint } });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /admin/model-endpoints/:id */
  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const deleted = await service.deleteEndpoint(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Model endpoint not found' });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/model-endpoints/:id/test — GET /models, then a 1-token POST /chat/completions auth probe when a key is set (5s timeouts). */
  async test(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await service.testEndpointConnection(req.params.id) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/model-endpoints/probe — model auto-discovery for an unsaved/edited draft. */
  async probe(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await service.probeEndpointModels(req.body) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/model-endpoints/:id/verify {modelId} — per-model PARSE
   *  verification battery (endpoint-verifier.ts): chat_stream (full SSE parse),
   *  utility, embeddings, rerank — sequential, key-scrubbed. 404 unknown
   *  endpoint; 400 when modelId is not one of the endpoint's models. */
  async verify(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const endpoint = await service.getEndpoint(req.params.id);
      if (!endpoint) return res.status(404).json({ error: 'Model endpoint not found' });
      const modelId = String(req.body?.modelId || '').trim();
      if (!endpoint.models.some(m => m?.id === modelId)) {
        return res.status(400).json({ error: `Model "${modelId.slice(0, 300)}" is not registered on endpoint "${endpoint.label}".` });
      }
      res.json({ success: true, data: await verifyEndpointModel(`${endpoint.label}:${modelId}`) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/model-endpoints/:id/detect and /:id/detect/:modelId (2026-09-27)
   *  — the bounded capability-detection suite (capability-detect.ts): every
   *  model of the endpoint (≤4 concurrent) or ONE model, 20 s per probe, results
   *  cached on the model entry (`capabilities`) and the flags SET with evidence
   *  (an admin's manual flag — `manualFlags` — is never overwritten). 404
   *  unknown endpoint; 400 when :modelId is not one of the endpoint's models;
   *  400 with the kill-switch message when ENDPOINT_CAPABILITY_DETECT_DISABLED=1. */
  async detect(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const endpoint = await service.getEndpoint(req.params.id);
      if (!endpoint) return res.status(404).json({ error: 'Model endpoint not found' });
      const modelId = req.params.modelId !== undefined ? String(req.params.modelId || '').trim() : undefined;
      if (modelId !== undefined && !endpoint.models.some(m => m?.id === modelId)) {
        return res.status(400).json({ error: `Model "${modelId.slice(0, 300)}" is not registered on endpoint "${endpoint.label}".` });
      }
      const { detectEndpointCapabilities } = await import('./capability-detect');
      const capabilities = Array.isArray(req.body?.capabilities) ? req.body.capabilities.map((c: unknown) => String(c)) : undefined;
      res.json({ success: true, data: await detectEndpointCapabilities(endpoint.id, { modelId, capabilities }) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/model-endpoints/:id/refresh — model-list SYNC (ticket
   *  780cd7a4): re-pulls the endpoint's live /v1/models with the stored key
   *  and merges it into the row (adds new ids as bare entries, marks row ids
   *  the server no longer lists as unservable/retired, preserves every other
   *  flag, never deletes). Returns the sanitized endpoint + the sync diff.
   *  404 unknown endpoint; 400 kill-switch (MODEL_ENDPOINT_SYNC_DISABLED=1);
   *  a failed /v1/models fetch surfaces as a key-safe error. */
  async refresh(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await service.refreshEndpointModels(req.params.id) });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/model-roles — every role seat with its default/override/effective
   *  model, which provider .env keys are set on this instance (presence only —
   *  the UI names the exact variable to add for a dead seat), and (2026-09-22,
   *  owner: "understand what everything is doing exactly") the model map: every
   *  built-in model with its fixed call parameters + every fixed chain. */
  async roles(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const [roles, builtIns] = await Promise.all([
        rolesService.listModelRoles(req.user?.id),
        rolesService.listBuiltInModelInfo().catch(() => []),
      ]);
      res.json({ success: true, data: {
        roles,
        providerKeys: rolesService.listProviderKeyStatus(),
        builtIns,
        chains: rolesService.listFixedChains(),
        // Seat governance (audit E3, 2026-09-27): frontierSeatsAllowed is true
        // by default (observe-only); false = FRONTIER_SEATS_REFUSE=1 is set on
        // this instance and the save path refuses frontier-class specs.
        governance: { frontierSeatsAllowed: frontierSeatsAllowed() },
      } });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/model-roles — partial override update ('' resets a role to
   *  default) and/or (owner 2026-09-15) partial custom-fallback update
   *  ({ fallbacks: { <role>: '<model or empty>' } }). */
  async updateRoles(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      // 09a03aef: advisory save-time warnings (e.g. an [image] seat model whose
      // measured probe latency implies > its chain timeout at chat sizes) ride
      // the successful PUT response — the save proceeds, the admin sees the line.
      const warnings: string[] = [];
      const roles = await rolesService.updateModelRoles(req.body?.roles ?? {}, req.user?.id, { fallbacks: req.body?.fallbacks ?? {}, warnings });
      res.json({ success: true, data: { roles, ...(warnings.length ? { warnings } : {}) } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/model-roles/test — live connection test with the role's REAL
   *  call shape. `fallback: true` tests the seat's custom-fallback slot. */
  async testRole(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await rolesService.testModelRole(String(req.body?.role || ''), req.body?.model, { fallback: req.body?.fallback === true }) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /admin/model-roles/test/stream (ticket 61d33af9) — the SSE delivery
   * twin of testRole for probes that outlive the ALB's 60 s idle timeout (the
   * image seat's 180 s budget). Same probe, same body; the response is a
   * text/event-stream that flushes immediately, writes ': keepalive' comments
   * every 15 s, and ends with ONE `data: {"type":"result","result":…}` frame.
   * Typed service errors (unknown role / keyless built-in) ride that same
   * terminal frame as {ok:false,error} so the UI renders them like the JSON
   * route's toast. Client-abort safe: writes after the socket closes are
   * swallowed by the res.write try/catch in the service twin.
   */
  async testRoleStream(req: AuthRequest, res: Response, _next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const write = (frame: string) => { try { if (!res.writableEnded) res.write(frame); } catch { /* client gone */ } };
    write(': open\n\n');
    await rolesService.testModelRoleStream(String(req.body?.role || ''), req.body?.model, { fallback: req.body?.fallback === true }, write);
    try { res.end(); } catch { /* already closed */ }
  }

  /** POST /admin/model-roles/apply-seats { dryRun } — seats govern sessions
   *  (2026-09-28): clear framework-stamped project overrides that point at
   *  built-ins, re-stamp provenance-less live sessions to the Workspace default
   *  seat, list the explicit picks left alone. dryRun (default true) previews. */
  async applySeats(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const { applySeatsToExistingSessions } = await import('./seat-apply.service');
      res.json({ success: true, data: await applySeatsToExistingSessions({ dryRun: req.body?.dryRun !== false, actorId: req.user?.id }) });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/model-roles/decision-modes — the decision gate's per-purpose
   *  mode (WI-S, 2026-09-25): the stored fleet-wide value, what env alone
   *  would give on THIS process, and the effective mode + its source. */
  async decisionModes(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await decisionModes.getDecisionModeConfig(decisionPrimaryOpts()) });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/model-roles/decision-modes — { modes: { <purpose>: off |
   *  shadow | act | '' } }; '' clears the stored mode. One row in the context
   *  store, so every box (web A/B + worker C) picks it up within the 30 s
   *  cache — no env staging, no redeploy. */
  async updateDecisionModes(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await decisionModes.updateDecisionModes(req.body?.modes ?? {}, req.user?.id, decisionPrimaryOpts()) });
    } catch (err) {
      next(err);
    }
  }

  /** GET /admin/model-roles/decision-readiness — the latest flip-readiness
   *  stamp per purpose (E1 2026-09-25): READY / NOT READY against the §6 bars
   *  with the metrics behind it, plus the worker job's latest STORED report
   *  (`computedAt`, every (backend, purpose) entry, the temperature fits).
   *  Written every DECISION_GATE_READINESS_INTERVAL_MIN by the worker's
   *  `decision-gate-readiness` cron (or on demand by `npm run
   *  decision-gate:fit -- --stamp`); the GET NEVER recomputes — it reads the
   *  store. null purposes / computedAt = never stamped / never run. Read-only.
   *  DOI-17 (2026-09-28): the response also carries `latches` — the 401/403
   *  auth-latch state of THIS backend process (`decisionBackendLatchView`;
   *  per process, the worker keeps its own map) — so the admin page can render the
   *  backend health beside the stamp's per-purpose `health` counters. */
  async decisionReadiness(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const view = await decisionReadiness.getDecisionReadinessView();
      // Lazy: the gate core boots axios + loop-metrics (→ config/env) — loading it
      // at import time would tie every controller consumer to that graph.
      const { decisionBackendLatchView, typedDecisionLatchView } = await import('../platform/decision-gate');
      res.json({ success: true, data: { ...view, latches: decisionBackendLatchView(), typedDecisionLatched: typedDecisionLatchView() } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/model-roles/decision-latch/clear (review 3c18284e): forget the
   *  runtime's LEARNED typed-decision specs — one via { spec }, ALL via {}.
   *  Drops the cached chains too, so the next ask resolves flag/kind transports
   *  only. The response carries the remaining latch view. */
  async clearTypedDecisionLatch(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const spec = typeof req.body?.spec === 'string' ? req.body.spec.trim() : '';
      const dg = await import('../platform/decision-gate');
      const cleared = spec ? dg.unlatchTypedDecisionSpec(spec) : false;
      if (!spec) dg.clearTypedDecisionLatch();
      dg.clearDecisionBackendCache();
      logger.info(`model-endpoints: cleared the learned typed-decision latch (${spec || 'all specs'})`);
      res.json({ success: true, data: { cleared, ...(spec ? {} : { all: true }), remaining: dg.typedDecisionLatchView() } });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/model-roles/decision-registry — the decision-role registry
   *  (rollout self-governance, 2026-09-27): every purpose with its tier, what it
   *  decides, the consumer site, what act does, the harness label, bars, caps,
   *  kill switches and owner lock, JOINED with the live modes view (effective /
   *  store / admission / readiness) and the rollout automaton's view. Read-only. */
  /** GET /admin/model-roles/auto-pools — dynamic roster phase 1 (2026-10-03): the
   *  stored per-lane pools, the EFFECTIVE pools the planner reads (an empty pool
   *  follows its seats; dropped entries carry the reason) and the model catalog
   *  (every chat-capable model with its capability card). Read-only. */
  async autoPools(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      // Loaded on demand — the pools service reads the context store (prisma).
      const [autoPools, { listChatModelCatalog }] = await Promise.all([import('./auto-pools.service'), import('./model-catalog')]);
      const catalog = await listChatModelCatalog();
      const [config, effective] = await Promise.all([autoPools.getAutoPoolsConfig(), autoPools.resolveEffectivePools(catalog)]);
      // roster 2026-10-06 C-1: which models automatic picks may choose ('all' | 'open_only') — data for the admin page.
      const autoPickPolicy = await (await import('../platform/roster-policy')).autoPickPolicy().catch(() => null);
      res.json({ success: true, data: { config, effective, catalog, roles: autoPools.POOL_ROLES.map(r => ({ role: r, label: autoPools.POOL_LABELS[r], seats: autoPools.POOL_SEATS[r] })), maxModels: autoPools.POOL_MAX_MODELS, disabled: autoPools.autoPoolsDisabled(), autoPickPolicy } });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/model-roles/auto-pools — { pools: { quick?, lead?, checker?, colleague? } };
   *  each listed role REPLACES that pool ([] / null = follow its seats again);
   *  unknown or frontier-class models refuse the whole save (400). Fleet-wide
   *  within the 30 s cache, no redeploy. */
  async updateAutoPools(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const [autoPools, { listChatModelCatalog }] = await Promise.all([import('./auto-pools.service'), import('./model-catalog')]);
      const catalog = await listChatModelCatalog();
      const config = await autoPools.updateAutoPools(req.body?.pools ?? {}, req.user?.id ?? null, catalog);
      res.json({ success: true, data: { config, effective: await autoPools.resolveEffectivePools(catalog) } });
    } catch (err) {
      next(err);
    }
  }

  /** GET /admin/model-roles/reflection-council — F2 (owner 2026-10-06 late): the frontier models the reflection
   *  council may seat (servable frontier-class registry models, provider-diversity order, prices), the admin's stored
   *  default list and the EFFECTIVE default the harness auto-run uses. Read-only. */
  async reflectionCouncil(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const [council, { listChatModelCatalog }] = await Promise.all([import('./reflection-council.service'), import('./model-catalog')]);
      const catalog = await listChatModelCatalog();
      const r = await council.resolveReflectionCouncil(catalog);
      const { frontierCouncilDisabled, councilMaxPerRun, councilSessionDailyCap } = await import('../coding/frontier-council');
      res.json({ success: true, data: {
        config: r.config, candidates: r.candidates, defaults: r.defaults, source: r.source, dropped: r.dropped,
        maxModels: council.REFLECTION_COUNCIL_MAX, disabled: frontierCouncilDisabled(), maxPerRun: councilMaxPerRun(), sessionDailyCap: councilSessionDailyCap(),
      } });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/model-roles/reflection-council — { models: string[] | null } REPLACES the default list (1–3 frontier
   *  models; [] / null = the provider-diversity default). A non-frontier / unknown model refuses the whole save (400). */
  async updateReflectionCouncil(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const [council, { listChatModelCatalog }] = await Promise.all([import('./reflection-council.service'), import('./model-catalog')]);
      const catalog = await listChatModelCatalog();
      await council.updateReflectionCouncil(req.body?.models ?? [], req.user?.id ?? null, catalog);
      const r = await council.resolveReflectionCouncil(catalog);
      res.json({ success: true, data: { config: r.config, candidates: r.candidates, defaults: r.defaults, source: r.source, dropped: r.dropped } });
    } catch (err) {
      next(err);
    }
  }

  /** GET /admin/model-roles/ghost-endpoint — the ghost-mode designation view:
   *  the stored { spec, enabled, updatedAt, updatedBy } plus the EFFECTIVE spec
   *  a ghost run routes to right now (spec: null + reason when nothing is
   *  live). Read-only. */
  async ghostEndpoint(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const [ghost, { listChatModelCatalog }] = await Promise.all([import('./ghost-endpoint.service'), import('./model-catalog')]);
      const config = await ghost.getGhostEndpointConfig();
      const catalog = await listChatModelCatalog().catch(() => [] as Awaited<ReturnType<typeof listChatModelCatalog>>);
      const effective = ghost.resolveGhostEndpoint(config, catalog);
      res.json({ success: true, data: { config, effective } });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/model-roles/ghost-endpoint — { spec: string | null, enabled? }
   *  REPLACES the designation. A non-null spec must resolve to an enabled,
   *  servable, chat-capable registry model — the whole save refuses (400) with
   *  the human reason otherwise. null / '' clears it. */
  async updateGhostEndpoint(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const [ghost, { listChatModelCatalog }] = await Promise.all([import('./ghost-endpoint.service'), import('./model-catalog')]);
      const catalog = await listChatModelCatalog();
      const config = await ghost.updateGhostEndpoint(req.body?.spec ?? null, req.body?.enabled, req.user?.id ?? null, catalog);
      const effective = ghost.resolveGhostEndpoint(config, catalog);
      res.json({ success: true, data: { config, effective } });
    } catch (err) {
      next(err);
    }
  }

  async decisionRegistry(req: AuthRequest, res: Response, next: NextFunction) {    if (!requireAdmin(req, res)) return;
    try {
      // 2026-09-28 (owner: "add jev to api costs"): calls + USD per purpose over the last 24 h ride every row (fail-open: zeros).
      const [modes, rollout, spend24h] = await Promise.all([decisionModes.getDecisionModeConfig(decisionPrimaryOpts()), decisionRollout.getRolloutView(), decisionSpendByPurpose24h()]);
      const byPurpose = new Map(modes.purposes.map(p => [p.purpose, p]));
      const parked = new Set(Object.entries(rollout.state.parked).filter(([, p]) => Date.parse(p.until) > Date.now()).map(([k]) => k));
      const registry = decisionRegistry.listDecisionRegistry().map(r => {
        const m = byPurpose.get(r.purpose);
        return {
          ...r,
          effective: m?.effective ?? null, effectiveSource: m?.effectiveSource ?? null, storeMode: m?.storeMode ?? null,
          readiness: m?.readiness ?? null, admission: m?.admission ?? null, primarySpec: m?.primarySpec ?? null,
          parked: parked.has(r.purpose),
          calls24h: spend24h.get(r.purpose)?.calls24h ?? 0,
          costUsd24h: spend24h.get(r.purpose)?.costUsd24h ?? 0,
          pricedCalls24h: spend24h.get(r.purpose)?.pricedCalls24h ?? 0,
        };
      });
      res.json({ success: true, data: { registry, rollout, tierRule: decisionRegistry.ROLLOUT_TIER_RULE, modes: { gateDisabled: modes.gateDisabled, admissionDisabled: modes.admissionDisabled } } });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/model-roles/decision-rollout — the automaton's switch + ledger. */
  async decisionRollout(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await decisionRollout.getRolloutView() });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/model-roles/decision-rollout — { enabled } flips SystemSetting
   *  decision_gate_auto_rollout (idempotent, audited with the admin's identity). */
  async updateDecisionRollout(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const r = await decisionRollout.setRolloutEnabled(req.body?.enabled === true, String(req.user?.email || req.user?.id || 'admin'));
      res.json({ success: true, data: await decisionRollout.getRolloutView(), changed: r.changed });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/model-roles/decision-backends — the per-purpose PRIMARY +
   *  CHALLENGER backends (open-weight decision-model plan C/F, 2026-09-26):
   *  the stored row, every candidate spec (the decision built-ins + every
   *  enabled registry model, with servability), and per purpose what runs
   *  (effective primary, challengers, chain order, fleet-effective mode). */
  async decisionBackends(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await decisionBackends.getDecisionBackendsConfig() });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/model-roles/decision-backends — { purposes?: { <purpose>:
   *  { primary?, challengers? } }, defaultChallengers? }. Specs are vetted with
   *  the decision seat's assignability rule; a PRIMARY change on a purpose whose
   *  fleet-effective mode is act drops it to shadow (plan D — the readiness stamp
   *  was measured on the old backend). One store row → every box within 30 s. */
  async updateDecisionBackends(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await decisionBackends.updateDecisionBackends(req.body ?? {}, req.user?.id) });
    } catch (error) {
      next(error);
    }
  }
}

export default new ModelEndpointsController();

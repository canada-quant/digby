/**
 * Digby Edge (Phase 2) — custom model endpoint registry routes. All
 * ADMIN-only, authenticated by the app-level /api/crossmodel guard in app.ts —
 * deliberately NO router.use(authenticate) here (see the ordering contract in
 * app.ts; fleet.routes.ts is the precedent for bare rejectChild).
 *
 *   GET    /admin/model-endpoints          — list (sanitized: hasApiKey, never the key)
 *   POST   /admin/model-endpoints          — create (instance-wide in v1)
 *   PATCH  /admin/model-endpoints/:id      — update (apiKey '' clears; omitted = unchanged)
 *   DELETE /admin/model-endpoints/:id
 *   POST   /admin/model-endpoints/:id/test — connectivity check (GET /models, then a 1-token POST /chat/completions auth probe when a key is set; ≤35 s shared budget incl. one typed-decision probe on decision routes, ticket 2df5ed65)
 *   POST   /admin/model-endpoints/:id/verify — per-model PARSE verification {modelId} (chat_stream full-SSE parse + utility + embeddings + rerank, sequential)
 *   POST   /admin/model-endpoints/:id/refresh — model-list SYNC against the endpoint's live /v1/models (ticket 780cd7a4): adds new ids, marks vanished ids unservable (retired), preserves every other flag, never deletes; MODEL_ENDPOINT_SYNC_DISABLED=1 refuses
 *   POST   /admin/model-endpoints/:id/detect — capability DETECTION for every model of the endpoint (2026-09-27): ≤4 models at once, 20 s per probe; sets the model flags with evidence (chat stream shape, tool calling, max tools, reasoning_effort, thinking-by-default, vision, embeddings dims, rerank, typed decisions, image generation, context window); ENDPOINT_CAPABILITY_DETECT_DISABLED=1 refuses
 *   POST   /admin/model-endpoints/:id/detect/:modelId — the same suite for ONE model
 *   POST   /admin/model-endpoints/probe    — model auto-discovery for a draft (same check; nothing persisted)
 *   GET    /admin/model-roles               — role seats (Digby/Double Checker/Triple Checker/…) + overrides
 *   PUT    /admin/model-roles               — partial override update ('' resets to the default)
 *   POST   /admin/model-roles/test          — live per-role connection test (real call shape)
 *   POST   /admin/model-roles/test/stream   — the SSE twin (61d33af9): same probe, keepalive comments every 15 s + ONE terminal result frame — the image seat's 180 s budget outlives the ALB's 60 s idle timeout
 *   GET    /admin/model-roles/auto-pools     — dynamic roster (2026-10-03): stored + effective per-lane pools + the model catalog
 *   PUT    /admin/model-roles/auto-pools     — { pools: { quick?, lead?, checker?, colleague? } } — [] / null = follow the seats
 *   GET    /admin/model-roles/reflection-council — F2 (2026-10-06): the frontier models the reflection council may seat + its default
 *   PUT    /admin/model-roles/reflection-council — { models: string[] | null } — 1–3 frontier models; [] / null = provider-diversity default
 *   GET    /admin/model-roles/decision-modes — decision-gate mode per purpose (store / env / effective) (WI-S 2026-09-25)
 *   PUT    /admin/model-roles/decision-modes — { modes: { <purpose>: off|shadow|act|'' } } — fleet-wide, no redeploy
 *   GET    /admin/model-roles/decision-readiness — the latest flip-readiness stamp per purpose + the worker job's latest STORED report (computedAt; E1 2026-09-25 — written every DECISION_GATE_READINESS_INTERVAL_MIN by the `decision-gate-readiness` cron, or on demand by `npm run decision-gate:fit -- --stamp`; never recomputed on request).
 *   GET    /admin/model-roles/decision-backends — per-purpose PRIMARY + CHALLENGER backends (plan C/F 2026-09-26): { config, candidates (built-ins + every enabled registry model, with servability), purposes (effective primary / challengers / chain / mode) }
 *   GET    /admin/model-roles/decision-registry — the decision-role registry (every purpose: tier, consumer, what act does, label, bars, caps, kill switches) joined with the live modes + the rollout automaton's view (rollout self-governance 2026-09-27)
 *   GET    /admin/model-roles/decision-rollout — the rollout automaton's switch (SystemSetting decision_gate_auto_rollout) + ledger (flips / parks / owner asks / inconsistencies) + recent auto-demotes
 *   PUT    /admin/model-roles/decision-rollout — { enabled: boolean } flips the automaton on / off fleet-wide (idempotent, audited with the admin's identity)
 *   PUT    /admin/model-roles/decision-backends — { purposes?: { <purpose>: { primary?, challengers? } }, defaultChallengers? } — fleet-wide; a PRIMARY change on an act purpose drops it to shadow (plan D). "Promote challenger" = { purposes: { p: { primary: spec, challengers: (old − spec) ∪ [old primary] } } }. Test a backend with POST /admin/model-roles/test { role: 'decision', model: spec }.
 */

import { Router } from 'express';
import { rejectChild } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import controller from './model-endpoints.controller';
import {
  createModelEndpointSchema, updateModelEndpointSchema, probeModelEndpointSchema,
  updateModelRolesSchema, testModelRoleSchema, verifyModelEndpointSchema, updateDecisionModesSchema, updateDecisionBackendsSchema, updateDecisionRolloutSchema,
  detectModelEndpointSchema, applySeatsSchema, updateAutoPoolsSchema, updateReflectionCouncilSchema, updateGhostEndpointSchema, clearTypedDecisionLatchSchema,
} from './model-endpoints.validation';

const router = Router();

router.use(rejectChild);

router.get('/admin/model-endpoints', controller.list.bind(controller));
router.post('/admin/model-endpoints', validate(createModelEndpointSchema), controller.create.bind(controller));
router.post('/admin/model-endpoints/probe', validate(probeModelEndpointSchema), controller.probe.bind(controller));
router.patch('/admin/model-endpoints/:id', validate(updateModelEndpointSchema), controller.update.bind(controller));
router.delete('/admin/model-endpoints/:id', controller.remove.bind(controller));
router.post('/admin/model-endpoints/:id/test', controller.test.bind(controller));
router.post('/admin/model-endpoints/:id/verify', validate(verifyModelEndpointSchema), controller.verify.bind(controller));
// Model-list SYNC (ticket 780cd7a4): re-pull the endpoint's live /v1/models and
// merge into the row — adds new ids, marks vanished ids unservable (retired),
// preserves every other flag, never deletes. Kill switch MODEL_ENDPOINT_SYNC_DISABLED=1.
router.post('/admin/model-endpoints/:id/refresh', controller.refresh.bind(controller));
// Capability detection (2026-09-27): a bounded probe suite per model (≤4 concurrent,
// 20 s each) that SETS the model flags with evidence — chat streaming shape, tool
// calling, max tools, reasoning_effort, thinking-by-default, vision, embeddings
// dims, rerank, typed decisions, image generation, context window.
// Kill switch ENDPOINT_CAPABILITY_DETECT_DISABLED=1.
router.post('/admin/model-endpoints/:id/detect', validate(detectModelEndpointSchema), controller.detect.bind(controller));
router.post('/admin/model-endpoints/:id/detect/:modelId', validate(detectModelEndpointSchema), controller.detect.bind(controller));

router.get('/admin/model-roles', controller.roles.bind(controller));
router.put('/admin/model-roles', validate(updateModelRolesSchema), controller.updateRoles.bind(controller));
router.post('/admin/model-roles/test', validate(testModelRoleSchema), controller.testRole.bind(controller));
// Ticket 61d33af9 (2026-10-10): the SSE delivery twin for probes that outlive
// the ALB's 60 s idle timeout (the image seat's 180 s budget) — same probe,
// same body, keepalive comments + ONE terminal result frame.
router.post('/admin/model-roles/test/stream', validate(testModelRoleSchema), controller.testRoleStream.bind(controller));
// Seats govern sessions (2026-09-28): "Apply seats to existing sessions" — { dryRun } previews.
router.post('/admin/model-roles/apply-seats', validate(applySeatsSchema), controller.applySeats.bind(controller));
// Dynamic roster phase 1 (2026-10-03): per-lane Auto pools + the model catalog (capability cards).
router.get('/admin/model-roles/auto-pools', controller.autoPools.bind(controller));
router.put('/admin/model-roles/auto-pools', validate(updateAutoPoolsSchema), controller.updateAutoPools.bind(controller));
// F2 (owner 2026-10-06 late): the reflection council — the frontier models it may seat + the harness auto-run default.
router.get('/admin/model-roles/reflection-council', controller.reflectionCouncil.bind(controller));
router.put('/admin/model-roles/reflection-council', validate(updateReflectionCouncilSchema), controller.updateReflectionCouncil.bind(controller));
// Ghost mode (owner 2026-10-22): the admin-designated '<label>:<modelId>' spec
// that powers every leg of a ghost session (GET view + PUT replace/clear).
router.get('/admin/model-roles/ghost-endpoint', controller.ghostEndpoint.bind(controller));
router.put('/admin/model-roles/ghost-endpoint', validate(updateGhostEndpointSchema), controller.updateGhostEndpoint.bind(controller));
router.get('/admin/model-roles/decision-modes', controller.decisionModes.bind(controller));
router.put('/admin/model-roles/decision-modes', validate(updateDecisionModesSchema), controller.updateDecisionModes.bind(controller));
router.get('/admin/model-roles/decision-readiness', controller.decisionReadiness.bind(controller));
router.get('/admin/model-roles/decision-backends', controller.decisionBackends.bind(controller));
// Review 3c18284e (condition 6): clear the runtime's LEARNED typed-decision latch (one
// spec, or all). The latch is process-local state the runtime derives from a guard 400;
// this is the manual reset when the admin flags the model properly (flag/kind routing
// then applies) or retires the endpoint. Admin-only, same gate as the reads around it.
router.post('/admin/model-roles/decision-latch/clear', validate(clearTypedDecisionLatchSchema), controller.clearTypedDecisionLatch.bind(controller));
router.put('/admin/model-roles/decision-backends', validate(updateDecisionBackendsSchema), controller.updateDecisionBackends.bind(controller));
// Rollout self-governance (2026-09-27): the decision-role REGISTRY (every purpose
// with its tier, consumer, what act does, label, bars, caps, kill switches,
// joined with the live modes + readiness) and the rollout AUTOMATON's switch +
// ledger. PUT { enabled } flips SystemSetting decision_gate_auto_rollout (audited).
router.get('/admin/model-roles/decision-registry', controller.decisionRegistry.bind(controller));
router.get('/admin/model-roles/decision-rollout', controller.decisionRollout.bind(controller));
router.put('/admin/model-roles/decision-rollout', validate(updateDecisionRolloutSchema), controller.updateDecisionRollout.bind(controller));

export default router;

/**
 * Digby Edge (Phase 2) — zod schemas for the /api/crossmodel/admin/model-endpoints
 * REST surface. Shape-only checks live here; business rules (providerShape is
 * 'openai_chat' only, http(s) baseUrl, label charset, per-owner label
 * uniqueness) live in model-endpoints.service.ts so they can return precise
 * 400 messages. Conventions match fleet.validation.ts ({ body } objects
 * consumed by middleware/validate).
 */

import { z } from 'zod';

export const endpointModelSchema = z.object({
  id: z.string().min(1, 'model id is required').max(200),
  displayName: z.string().max(200).optional(),
  vision: z.boolean().optional(),
  coding: z.boolean().optional(),
  // 2026-09-08 (owner: Qwen3-Embedding-8B returned 4096 dims): an MRL-trained
  // embedding model — Digby truncates a longer vector to 1536 client-side.
  matryoshka: z.boolean().optional(),
  // 2026-09-08 (owner: Qwen3-4B helper digested nothing): 'off' sends the
  // thinking-disable directive (chat_template_kwargs.enable_thinking=false).
  thinking: z.enum(['default', 'off']).optional(),
  // 2026-09-24 (owner: image generation): the model serves an OpenAI-compatible
  // POST /images/generations route — assignable to the Image generator seat.
  image: z.boolean().optional(),
  // 2026-10-23 (ticket 04c8ffd1, review blocker): per-model image-generation
  // timeout in ms for [image]-flagged models (slow local backends, 5-10
  // min/generation). SHAPE only at this layer — the service's validateModels
  // clamps [IMAGE_MODEL_TIMEOUT_MIN_MS, IMAGE_MODEL_TIMEOUT_MAX_MS] and drops
  // garbage; without this member zod STRIPPED the field on every POST/PATCH
  // (validate.ts writes the parsed body back), silently killing the admin UI's
  // knob: the UI saved, reload showed no timeout.
  imageTimeoutMs: z.number().int().min(1).max(86_400_000).optional(),
  // 2026-10-25 (todo 87b020c4, owner ruling oq_7af5537b): per-model images-route
  // base-URL override — the seat-side tailnet-direct flip for the LONG-RUNNING
  // image class (e.g. http://100.64.0.1:4001/v1 — a BASE, mirroring the
  // endpoint baseUrl's path prefix) while chat traffic keeps the
  // endpoint's baseUrl (Cloudflare). SHAPE only at this layer (the imageTimeoutMs
  // lesson above: without the member zod STRIPS it on every POST/PATCH); the
  // service's validateModels normalizes (trim, trailing-slash strip, http(s)
  // URL-parse) and DROPS garbage instead of rejecting the save.
  imagesUrl: z.string().max(2048).optional(),
  // 2026-09-26 (owner: self-hosted Laya / open-weight Jev): decision-backend flags.
  // `calibrated` — the admin asserts the server's probabilities are calibrated
  // (else a registry decision backend is uncalibrated until a temperature is
  // fitted for it); `maxStateChars` — the per-backend state cap (Laya's 512-token
  // window ≈ 1,200 chars; JevK5 / openjev 16k tokens), clamped by the gate to
  // DECISION_STATE_MAX_CHARS.
  calibrated: z.boolean().optional(),
  maxStateChars: z.number().int().min(200).max(200_000).optional(),
  // 2026-09-28 (decision-gate spend rows): the price this model bills at, USD per
  // 1M input / output tokens (0 is a valid "free" price; unset = the endpoint's
  // settings price, else badged self-hosted in API costs).
  usdPerMTokIn: z.number().min(0).max(10_000).optional(),
  usdPerMTokOut: z.number().min(0).max(10_000).optional(),
  // 2026-09-26 (Laya follow-up): the model on an OpenAI-compatible endpoint is a
  // TYPED-DECISION model served through /chat/completions (LiteLLM fronting
  // Laya) — the decision gate calls it with the systemone_chat transport.
  decision: z.enum(['systemone_chat']).optional(),
  // 2026-09-27 seat/provider limits (owner incident: 195 tools on a 128-tool
  // OpenAI cap behind LiteLLM; reasoning_effort injected by the proxy):
  // per-model tool cap, reasoning-effort support, provider-class override,
  // what the model IS, its context window, and the last capability detection.
  maxTools: z.number().int().min(1).max(4096).optional(),
  reasoningEffort: z.enum(['supported', 'unsupported', 'auto']).optional(),
  providerClass: z.enum(['openai', 'anthropic', 'google', 'moonshot', 'deepseek', 'zai', 'dashscope', 'other']).optional(),
  kind: z.enum(['chat', 'embeddings', 'rerank', 'asr', 'tts', 'image', 'decision']).optional(),
  contextWindow: z.number().int().min(256).max(100_000_000).optional(),
  capabilities: z.object({
    detectedAt: z.string().max(64),
    results: z.array(z.object({
      capability: z.string().max(40),
      ok: z.boolean(),
      value: z.union([z.boolean(), z.number(), z.string().max(200), z.null()]),
      evidence: z.string().max(600),
      latencyMs: z.number().min(0).optional(),
      at: z.string().max(64).optional(),
      skipped: z.boolean().optional(),
    })).max(40),
  }).optional(),
  manualFlags: z.array(z.string().max(40)).max(32).optional(),
  // 2026-10-06 (f90 follow-up): RETIRED entry — listed for provenance, never
  // served (the gateway route was torn down). Stops resolving; catalog card
  // servable:false. Admin-set via the editor's "retired" chip.
  unservable: z.boolean().optional(),
});

// Endpoint-level settings (row column `settings`, 2026-09-27): a tool cap for
// every model on the endpoint that carries no per-model cap.
export const endpointSettingsSchema = z.object({
  maxTools: z.number().int().min(1).max(4096).optional(),
  // 2026-09-28: endpoint-wide price (USD / M tokens) for models without their own.
  usdPerMTokIn: z.number().min(0).max(10_000).optional(),
  usdPerMTokOut: z.number().min(0).max(10_000).optional(),
}).nullable().optional();

export const createModelEndpointSchema = z.object({
  body: z.object({
    label: z.string().min(1, 'label is required').max(64),
    providerShape: z.string().min(1).max(32),
    baseUrl: z.string().min(1, 'baseUrl is required').max(500),
    apiKey: z.string().max(1024).optional(),
    models: z.array(endpointModelSchema).min(1, 'At least one model is required').max(100),
    settings: endpointSettingsSchema,
    enabled: z.boolean().optional(),
  }),
});

export const updateModelEndpointSchema = z.object({
  body: z.object({
    label: z.string().min(1).max(64).optional(),
    providerShape: z.string().min(1).max(32).optional(),
    baseUrl: z.string().min(1).max(500).optional(),
    // apiKey patch semantics: omitted = unchanged, '' = clear, value = re-encrypt.
    apiKey: z.string().max(1024).optional(),
    models: z.array(endpointModelSchema).min(1, 'At least one model is required').max(100).optional(),
    settings: endpointSettingsSchema,
    enabled: z.boolean().optional(),
  }),
});

// Capability detection (2026-09-27): POST /admin/model-endpoints/:id/detect
// (every model) and /:id/detect/:modelId (one model). `capabilities` limits the
// probe suite; omitted = the whole suite. Nothing else rides in the body.
export const detectModelEndpointSchema = z.object({
  body: z.object({
    capabilities: z.array(z.string().max(40)).max(20).optional(),
  }).optional(),
});

// Model auto-discovery for the add/edit dialog: lists a server's /models
// WITHOUT persisting. endpointId lets an edit draft reuse the stored key when
// the apiKey field is left blank; an explicit apiKey always wins.
export const probeModelEndpointSchema = z.object({
  body: z.object({
    baseUrl: z.string().min(1, 'baseUrl is required').max(500),
    apiKey: z.string().max(1024).optional(),
    endpointId: z.string().max(64).optional(),
  }),
});

// Model roles (Digby Edge): partial override map — '' resets a role to its
// built-in default. Key/value business rules (known role, assignable model)
// live in model-roles.service.ts for precise 400s.
// Owner 2026-09-15: `fallbacks` — the admin's custom fallback model per seat
// ('' clears it back to Digby's built-in fallback behaviour). At least one of
// the two maps must be present (the service 400s an empty update).
export const updateModelRolesSchema = z.object({
  body: z.object({
    roles: z.record(z.string(), z.string().max(300)).optional(),
    fallbacks: z.record(z.string(), z.string().max(300)).optional(),
  }),
});

// Auto pools (dynamic roster phase 1, 2026-10-03): per-lane ordered model lists.
// A role's list REPLACES that pool; [] / null clears it back to its seats.
// Spec rules (chat-capable, open-model only) live in auto-pools.service.ts for precise 400s.
const poolList = z.array(z.string().max(300)).max(12).nullable().optional();
export const updateAutoPoolsSchema = z.object({
  body: z.object({
    pools: z.object({ quick: poolList, lead: poolList, checker: poolList, colleague: poolList }).strict(),
  }),
});

// Reflection council (F2, owner 2026-10-06 late): the 1–3 FRONTIER models the harness consults when an agent ignores
// its reflect note (the agent itself may choose any servable frontier model). [] / null clears it back to the
// provider-diversity default. Spec rules (frontier-class, servable chat model) live in reflection-council.service.ts.
export const updateReflectionCouncilSchema = z.object({
  body: z.object({
    models: z.array(z.string().max(300)).max(6).nullable(),
  }),
});

// Ghost mode designation (owner 2026-10-22): the '<label>:<modelId>' registry
// spec that powers every leg of a ghost session. null / '' clears it. Spec
// rules (chat-capable, servable, resolvable) live in ghost-endpoint.service.ts
// for precise 400s.
export const updateGhostEndpointSchema = z.object({
  body: z.object({
    spec: z.string().max(300).nullable(),
    enabled: z.boolean().optional(),
  }),
});

// Decision-gate modes (WI-S, 2026-09-25): per-purpose fleet-wide mode map —
// '' clears a purpose back to its env/default mode. Purpose + value rules
// (known purpose, off|shadow|act) live in platform/decision-gate-modes.ts for
// precise 400s.
// Rollout self-governance (2026-09-27): the automaton's switch.
export const updateDecisionRolloutSchema = z.object({
  body: z.object({
    enabled: z.boolean(),
  }),
});

export const updateDecisionModesSchema = z.object({
  body: z.object({
    modes: z.record(z.string(), z.string().max(16)),
  }),
});

// Decision-gate backends (open-weight decision-model plan F, 2026-09-26): the
// per-purpose PRIMARY + CHALLENGER map, fleet-wide. `primary` '' clears (the
// seat model applies); `challengers` null clears (inherit defaultChallengers),
// [] = explicitly none; an absent key leaves that field untouched;
// `defaultChallengers` [] clears. Spec rules (the decision seat's own
// assignability: built-in vocabulary or a registered endpoint model that
// resolves) and purpose names live in platform/decision-gate-backends.ts for
// precise 400s.
export const updateDecisionBackendsSchema = z.object({
  body: z.object({
    purposes: z.record(z.string(), z.object({
      primary: z.string().max(300).optional(),
      challengers: z.array(z.string().max(300)).max(8).nullable().optional(),
    })).optional(),
    defaultChallengers: z.array(z.string().max(300)).max(8).optional(),
  }),
});

// Review 3c18284e: clear the runtime's learned typed-decision latch —
// { spec: 'label:model' } unlatches ONE; {} unlatches EVERY (the whole map).
// Also drops every cached chain (clearDecisionBackendCache), so the next ask
// resolves transports from the flag/kind alone.
export const clearTypedDecisionLatchSchema = z.object({
  body: z.object({
    spec: z.string().max(300).optional(),
  }).optional(),
});

// Seats govern sessions (2026-09-28): "Apply seats to existing sessions" —
// dryRun omitted = true (the preview); false executes.
export const applySeatsSchema = z.object({
  body: z.object({
    dryRun: z.boolean().optional(),
  }).optional(),
});

// Live role tester: `model` tests an unsaved candidate ('' = the built-in
// default); omitted = the currently stored config for that role. `fallback:
// true` tests the seat's custom-fallback slot instead of the seat itself.
export const testModelRoleSchema = z.object({
  body: z.object({
    role: z.string().min(1).max(64),
    model: z.string().max(300).optional(),
    fallback: z.boolean().optional(),
  }),
});

// Per-model parse verification (endpoint-verifier.ts): runs the four-shape
// battery (chat_stream / utility / embeddings / rerank) against ONE model id
// of the :id endpoint. The id lives in the route param.
export const verifyModelEndpointSchema = z.object({
  body: z.object({
    modelId: z.string().trim().min(1).max(300),
  }),
});

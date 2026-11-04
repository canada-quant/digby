/**
 * Ticket 7a078b4d (mishap, 2026-09-28) — the 3× test_model_role breaker streak
 * on the Fleet Supervisor (chat c0e22e36): the [INFRA ALERT — decision gate:
 * every backend failing] playbook's step (2) said "check with the Model roles
 * Test button" — a UI control — and the supervisor's natural tool translation
 * `test_model_role {role:'decision_gate'}` (the admin panel's own section
 * label; the seat KEY is 'decision') 400'd deterministically, 3× (a second
 * probe guessed 'jev', a decision BACKEND spec named verbatim in the alert,
 * also not a seat), tripping the tool-failure breaker mid-diagnosis.
 *
 * Adjudication: BOTH a framework seam and model behavior.
 *   Framework seam (fixed here): (a) no seat-label synonym heal — the panel's
 *   own label "Decision gate" did not resolve to seat 'decision'; (b) a
 *   decision BACKEND spec as `role` meant "probe that backend" but could not
 *   be expressed; (c) the invalid-role error redirected to get_model_roles —
 *   a tool the supervisor never called (0 calls in its receipts) — and even a
 *   successful read could not express "probe the jev backend" for either
 *   guess's intent; (d) the playbook named a UI control with no agent-callable
 *   form. Model behavior (not fixed by code, recorded here): retrying an
 *   identical invalid role verbatim instead of reading the hint — the
 *   hint-ignored shape (same class as 99ad288e).
 *
 * This file replays the mishap at all three layers:
 *   1. the real model-roles service: ROLE_SYNONYMS heals the panel label
 *      (module loaded via requireActual-spread — only the live probe is
 *      mocked, so the REAL validation runs);
 *   2. the agent tool (executeFleetOpsTool test_model_role): both incident
 *      inputs probe the decision seat, with an echoed healedFrom — never
 *      silent; a genuinely unknown role is a refusal that names the seat keys
 *      inline (no dead end), and a model-id-shaped input gets the
 *      candidate-form hint;
 *   3. the two playbook renderers: the agent-callable probe form is named
 *      next to the UI button.
 *
 * Mock topology mirrors model-roles.service.test.ts (the service's boundary:
 * context-store / registry / prisma / coding-model / loop-metrics — so the
 * REAL module loads) and infra-watch.service.test.ts (redis + error-handler +
 * ticket-dispatch stubs so the renderers load without env).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── The REAL model-roles.service boundary (same mocks the service's own
//    suite uses) so jest.requireActual inside the module mock loads it.
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: jest.fn(async () => null),
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userPreferences: { findUnique: jest.fn(async () => null) },
    // fleet-ops-tools' audit() writes here (never fails the tool).
    activity: { create: jest.fn(async () => ({})) },
  },
}));
jest.mock('../coding/coding-data.service', () => ({
  __esModule: true,
  resolveOneCodingPick: jest.fn(async () => null),
}));
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  resolveProviderForRun: jest.fn(async () => { throw new Error('not under test'); }),
  seatServability: jest.fn(async () => ({ reason: null })),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  countSeatFallbacksByRole: jest.fn(async () => ({})),
  recordLoopMetric: jest.fn(),
}));
jest.mock('../image-generate', () => ({
  __esModule: true,
  ...jest.requireActual('../image-generate'),
  probeImageGenerate: jest.fn(async () => ({ ok: true })),
}));

// ── The agent tool's service seam: the REAL module with only the live probe
//    and the write path stubbed — normalizeRoleKey / MODEL_ROLES /
//    BUILT_IN_MODEL_IDS stay REAL, so the tool-layer tests below exercise the
//    genuine heal.
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  ...jest.requireActual('../model-endpoints/model-roles.service'),
  testModelRole: jest.fn(async (..._a: any[]): Promise<any> => ({ ok: true, target: 'built-in TypeSafe Jev (jev)', latencyMs: 321, detail: 'Jev answered in 321 ms' })),
  updateModelRoles: jest.fn(),
}));

// ── The infra-watch renderers' boundary (same env-shaped stubs the
//    infra-watch suite uses) so the module loads without process.env.
const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => { if (opts?.NX && redisStore.has(k)) return null; redisStore.set(k, v); return 'OK'; }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  },
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error { constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); } },
}));
jest.mock('../feedback/ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'skipped' })),
  dispatchTicketToLane: jest.fn(async () => 'skipped'),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));

import { executeFleetOpsTool } from './fleet-ops-tools';
import * as rolesSvc from '../model-endpoints/model-roles.service';
import { normalizeRoleKey, ROLE_SYNONYMS, MODEL_ROLES } from '../model-endpoints/model-roles.service';
import { renderDecisionBackendDownAlert } from '../fleet/infra-watch.service';

const NOW = new Date('2026-09-28T15:03:00.000Z');
const makeCtx = (over: Record<string, any> = {}) => ({ sessionId: 'sup-1', userId: 'admin-1', ...over });
const deps = { platform: null, isAdmin: async (_u: string) => true };
const run = async (args: any, ctx = makeCtx()) => JSON.parse(await executeFleetOpsTool(ctx as any, 'test_model_role', args, deps as any));

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
});

describe('7a078b4d layer 1 — the seat-label synonym heal (real service code)', () => {
  it("the admin panel's own label 'decision_gate' resolves to the 'decision' seat; the synonym table names exactly one seat per entry", () => {
    expect(normalizeRoleKey('decision_gate')).toBe('decision');
    expect(normalizeRoleKey('decision')).toBe('decision');
    expect(normalizeRoleKey('jev')).toBeNull(); // a backend spec is NOT a seat key
    expect(normalizeRoleKey('nope')).toBeNull();
    expect(normalizeRoleKey('toString')).toBeNull();
    // A synonym naming two seats is a defect in the table, not a heal: every
    // target must be a real seat key, and no synonym may itself be a seat key.
    const seatKeys = new Set<string>(MODEL_ROLES.map((r) => r.key));
    for (const target of Object.values(ROLE_SYNONYMS)) expect(seatKeys.has(target)).toBe(true);
    expect(Object.keys(ROLE_SYNONYMS).every((k) => !seatKeys.has(k))).toBe(true);
    // Stored-config reads stay strict: a synonym never loads from a row
    // (isModelRoleKey — not normalizeRoleKey — is the row gate).
    expect(rolesSvc.isModelRoleKey('decision_gate')).toBe(false);
  });
});

describe('7a078b4d layer 2 ��� the agent tool heals both incident inputs, never silently', () => {
  it("the supervisor's exact call {role:'decision_gate'} now probes the decision seat and echoes healedFrom", async () => {
    const r = await run({ role: 'decision_gate' });
    expect(r).toMatchObject({ ok: true, tool: 'test_model_role', role: 'decision', healedFrom: 'decision_gate' });
    expect(rolesSvc.testModelRole).toHaveBeenCalledWith('decision', undefined, undefined);
    expect(r.message).toContain('Healed "decision_gate" → seat "decision"');
    expect(r.message).toContain('decision answered in 321 ms');
  });

  it("the second incident guess {role:'jev'} (the backend spec the alert names) probes decision with the spec as candidate", async () => {
    const r = await run({ role: 'jev' });
    expect(r).toMatchObject({ ok: true, role: 'decision', healedFrom: 'jev', candidate: 'jev' });
    expect(rolesSvc.testModelRole).toHaveBeenCalledWith('decision', 'jev', undefined);
  });

  it('an explicit candidate is preserved on a healed backend-spec role (the seat default never overrides the ask)', async () => {
    const r = await run({ role: 'jev', candidate: 'deepseek-flash' });
    expect(r).toMatchObject({ role: 'decision', healedFrom: 'jev', candidate: 'deepseek-flash' });
    expect(rolesSvc.testModelRole).toHaveBeenCalledWith('decision', 'deepseek-flash', undefined);
  });

  it('a healed probe that FAILS still echoes the heal (attribution, not silent success)', async () => {
    (rolesSvc.testModelRole as jest.Mock).mockResolvedValueOnce({ ok: false, target: 'jev', latencyMs: 5, error: 'timeout of 1000ms exceeded' });
    const r = await run({ role: 'decision_gate' });
    expect(r).toMatchObject({ ok: false, role: 'decision', healedFrom: 'decision_gate', error: 'timeout of 1000ms exceeded' });
    expect(r.message).toContain('Healed "decision_gate" → seat "decision"');
    expect(r.message).toContain('probe FAILED');
  });

  it('a genuinely unknown role is a real refusal that lists the seat keys inline — no dead end, no get_model_roles dependency', async () => {
    const r = await run({ role: 'not-a-seat' });
    expect(r).toMatchObject({ ok: false, reason: 'invalid', role: 'not-a-seat' });
    expect(r.message).toContain('the seat keys are: chat_orchestrator, chat_quick, supervisor');
    expect(r.message).toContain('decision');
    expect(r.message).not.toContain('get_model_roles lists the keys');
    expect(rolesSvc.testModelRole).not.toHaveBeenCalled();
  });

  it('a model-id-shaped input gets the candidate-form hint instead of a bare refusal', async () => {
    const r = await run({ role: 'deepseek-flash' });
    expect(r).toMatchObject({ ok: false, reason: 'invalid', role: 'deepseek-flash' });
    expect(r.message).toContain('is a MODEL id/spec, not a seat');
    expect(r.message).toContain("{role:'decision', candidate:'deepseek-flash'}");
  });

  it('unchanged paths: a direct seat key still works unhealed and the probe receipt shape is intact', async () => {
    const r = await run({ role: 'supervisor' });
    expect(r).toMatchObject({ ok: true, role: 'supervisor' });
    expect(r).not.toHaveProperty('healedFrom');
    expect(rolesSvc.testModelRole).toHaveBeenCalledWith('supervisor', undefined, undefined);
  });
});

describe('7a078b4d layer 3 — the playbooks name the agent-callable probe form', () => {
  it('the decision-backend-down alert names the tool form beside the UI button', () => {
    const text = renderDecisionBackendDownAlert({ event: 'latched', purpose: 'sweep_triage', at: NOW.toISOString(), spec: 'jev', backend: 'TypeSafe Jev', status: 403, cooldownMs: 90_000 }, NOW);
    expect(text).toContain('Model roles Test button');
    expect(text).toContain("test_model_role {role:'decision', candidate:'jev'}");
    expect(text).toContain("the seat key is 'decision'");
  });

  it('the every-backend-failing alert names the probe for both built-ins', () => {
    const text = renderDecisionBackendDownAlert({ event: 'all_legs_failed', purpose: 'compute_policy', at: NOW.toISOString(), legErrors: ['TypeSafe Jev: timeout timeout of 1000ms exceeded', 'DeepSeek logprob readout: timeout timeout of 173ms exceeded'], streak: 9 }, NOW);
    expect(text).toContain("test_model_role {role:'decision', candidate:'jev'}");
    expect(text).toContain("{role:'decision', candidate:'deepseek-flash'}");
  });
});

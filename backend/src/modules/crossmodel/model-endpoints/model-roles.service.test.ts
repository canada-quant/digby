/**
 * Model roles (Digby Edge) — model-roles.service unit tests with mocked store
 * + registry. Pins: default lineup mirrors the hardcoded seat constants
 * (drift guard), override/cache/fail-open read semantics, the assignability
 * matrix (agent roles need built-in or [coding]-flagged spec; embeddings/
 * rerank/asr take any registry spec, never built-ins), update merge semantics
 * ('' clears), and the live tester's probes (chat first-token, embeddings
 * 1536-dim contract, Cohere-style rerank, multipart /audio/transcriptions —
 * the asr seat is ticket 4806298b-7032-4c21-9d9e-cc6af9d6a24f) with
 * key-scrubbed errors.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

const mockStoreGet = jest.fn();
const mockStorePut = jest.fn(async (..._a: any[]) => {});
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));

const mockResolveRegistryModel = jest.fn();
const mockResolveRegistryModelEntry = jest.fn();
jest.mock('./model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
  // 09a03aef: the seat-save warning reads the raw model ENTRY (the Detect
  // capabilities' measured image_generation latency) — not the run-shaped
  // resolution.
  resolveRegistryModelEntry: (...a: any[]) => mockResolveRegistryModelEntry(...a),
}));

// e5298647 viewer-pick lookup: the service reads the viewing admin's
// UserPreferences.codingModel via prisma and resolves it through coding-data's
// resolveOneCodingPick (dynamic import). Both mocked here; the resolver's own
// aliasing/registry behavior is pinned in coding-data.stamping.test.ts.
const mockPrefFindUnique = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userPreferences: { findUnique: (...a: any[]) => mockPrefFindUnique(...a) } },
}));
const mockResolveOneCodingPick = jest.fn();
jest.mock('../coding/coding-data.service', () => ({
  __esModule: true,
  resolveOneCodingPick: (...a: any[]) => mockResolveOneCodingPick(...a),
}));

// The chat probe resolves providers through coding-model (dynamic import);
// listModelRoles' servability check uses seatServability from the same
// module (default: everything servable — tests override per case).
const mockResolveProviderForRun = jest.fn();
const mockSeatServability = jest.fn(async (..._a: any[]): Promise<{ reason: string | null; missingEnvKey?: string }> => ({ reason: null }));
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  // Pure helpers stay REAL: helper-completion (the non-streaming probe path)
  // needs isDeepSeekBuiltInProvider / DEEPSEEK_THINKING_OFF_EXTRA /
  // THINKING_OFF_EXTRA to shape the payload exactly as at runtime.
  ...jest.requireActual('../coding/coding-model'),
  resolveProviderForRun: (...a: any[]) => mockResolveProviderForRun(...a),
  seatServability: (...a: any[]) => mockSeatServability(...(a as [])),
}));

// Seat-health signal (owner 2026-09-14): listModelRoles reads the 24h
// seat_fallback count per role from loop-metrics (dynamic import, fail-open).
const mockCountSeatFallbacks = jest.fn(async (..._a: any[]): Promise<Record<string, number>> => ({}));
// Seat governance telemetry (review fixer 2026-09-27): recordSeatGovernance
// writes ONE `seat_governance` row per governed attempt through this export —
// the mock must carry it or the write is silently skipped in every test.
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  countSeatFallbacksByRole: (...a: any[]) => mockCountSeatFallbacks(...a),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

// Image generator seat (2026-09-24): servability + the model map read the
// REAL image-generate table (pure); only the live probe is mocked.
const mockProbeImageGenerate = jest.fn();
jest.mock('../image-generate', () => ({
  __esModule: true,
  ...jest.requireActual('../image-generate'),
  probeImageGenerate: (...a: any[]) => mockProbeImageGenerate(...a),
}));

jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

import { EventEmitter } from 'events';
import {
  MODEL_ROLES, NON_CHAT_ROLES, BUILT_IN_MODEL_IDS, FAST_BUILT_IN_MODEL_IDS, EMBEDDING_DIMENSIONS,
  clearModelRoleCache, getModelRoleOverrides, resolveRoleModel, roleDefaultModel, listModelRoles,
  updateModelRoles, testModelRole, isModelRoleKey, listProviderKeyStatus,
  buildAsrProbeWav, ASR_PROBE_WAV_FILENAME, RECENT_FAILURES_WINDOW_HOURS,
  FALLBACKABLE_ROLES, LEGACY_ROLE_ALIASES, SEAT_PERSONAS, normalizeRoleKey, normalizeStoredRoleConfig,
  getModelRoleFallbacks, resolveRoleFallback,
  IMAGE_ROLES, IMAGE_BUILT_IN_OPTIONS, builtInOptionsFor, listFixedChains, listBuiltInModelInfo,
  IMAGE_PROBE_HARD_CAP_GRACE_MS, FRONTIER_GOVERNED_ROLES,
  scrubError,
  roleTestTimeoutMs,
  roleTestCustomTimeoutMs,
  ROLE_TEST_TIMEOUT_MS,
} from './model-roles.service';

const REG = {
  url: 'http://10.0.0.5:11434/v1/chat/completions',
  baseUrl: 'http://10.0.0.5:11434/v1',
  apiKey: 'sk-registry-secret',
  model: 'qwen3:32b',
  label: 'my-ollama',
  supportsVision: false,
  coding: true,
};

beforeEach(() => {
  jest.resetAllMocks(); // implementations too — persistent mockResolvedValue must not leak across tests
  clearModelRoleCache();
  mockStoreGet.mockResolvedValue(null);
  mockStorePut.mockResolvedValue(undefined as any);
  mockSeatServability.mockResolvedValue({ reason: null });
  mockPrefFindUnique.mockResolvedValue(null);
  mockResolveOneCodingPick.mockResolvedValue(null);
  mockCountSeatFallbacks.mockResolvedValue({});
});

describe('listModelRoles recentFailures (seat-health badge, owner 2026-09-14)', () => {
  it('carries the 24h seat_fallback count per role; quiet seats read 0', async () => {
    mockCountSeatFallbacks.mockResolvedValue({ coding_helper: 4, supervisor: 1 });
    const roles = await listModelRoles();
    expect(roles.find(r => r.key === 'coding_helper')!.recentFailures).toBe(4);
    expect(roles.find(r => r.key === 'supervisor')!.recentFailures).toBe(1);
    for (const r of roles.filter(r => r.key !== 'coding_helper' && r.key !== 'supervisor')) {
      expect(r.recentFailures).toBe(0);
    }
    expect(mockCountSeatFallbacks).toHaveBeenCalledTimes(1);
    expect(mockCountSeatFallbacks).toHaveBeenCalledWith(RECENT_FAILURES_WINDOW_HOURS);
    expect(RECENT_FAILURES_WINDOW_HOURS).toBe(24);
  });

  it('fails OPEN: a telemetry read error reports 0 everywhere and never breaks the admin page', async () => {
    mockCountSeatFallbacks.mockRejectedValue(new Error('db down'));
    const roles = await listModelRoles();
    expect(roles).toHaveLength(MODEL_ROLES.length);
    expect(roles.every(r => r.recentFailures === 0)).toBe(true);
  });
});

/** Store mock that actually persists writes (update → re-read round trips). */
const statefulStore = (initial: any = null) => {
  let stored: any = initial;
  mockStoreGet.mockImplementation(async () => stored);
  mockStorePut.mockImplementation(async (_ns: any, _k: any, v: any) => { stored = v; });
};

describe('role definitions (drift guard)', () => {
  it('defaults mirror the hardcoded seat constants at the seams', () => {
    const byKey = Object.fromEntries(MODEL_ROLES.map(r => [r.key, r.defaultModel]));
    expect(byKey).toEqual({
      chat_orchestrator: 'kimi-k3',       // chat-agent.service.ts ORCHESTRATOR_MODEL
      chat_quick: '',                     // dynamic roster 2026-10-03: NO hardcoded id — inheritsFrom 'coding_helper' (the Auto Quick lane's lead)
      supervisor: 'kimi-k3',              // supervisor chats' seat (owner 2026-09-10) — default mirrors the orchestrator
      project_supervisor: '',             // Project-supervisor preflight 2026-09-14: NO hardcoded id — inheritsFrom 'supervisor' (see the inheritance block below)
      double_checker: 'deepseek-flash',   // chat-agent.service.ts CROSS_CHECKERS[0] — ONE secondary seat for L2 + the L3 council (owner 2026-09-15; was chat_cross_checker + council_logician)
      triple_checker: 'glm-5.3',          // chat-agent.service.ts COUNCIL_MODELS.glm (was council_professor)
      coding_default: 'glm-5.3',          // coding-data.service resolveStampedCodingModel fallback
      coding_helper: 'qwen3.6-27b',       // coding-model.ts HELPER_MODEL + pipe SUMMARY_MODELs
      coding_reviewer: '',                // roadmap item 4: NO hardcoded id — inheritsFrom 'double_checker' (independent review by default)
      coding_architect: '',               // roadmap item 4: followsSession — the delegating lane's own model (delegation.ts tier rule)
      coding_explorer: '',                // roadmap item 4: followsSession — the delegating lane's own model
      utility: '',                        // utility-llm.ts built-in chain (its CUSTOM FALLBACK slot replaced the 2026-09-15 AM utility_fallback seat)
      embeddings: '',                     // rag.service DashScope text-embedding-v4
      rerank: '',                         // rag.service DashScope qwen3-rerank
      // 2026-09-22 capability seats (owner: every model call admin-editable; no frontier models)
      vision_describe: 'glm-5.3-flash',   // image-describe.ts VISION_UTILITY_MODEL
      pdf_ocr: 'glm-5.3-flash',           // pdf-extract.ts PDF_OCR_DEFAULT_MODEL (was Gemini)
      browser_agent: 'glm-5.3',           // browser-agent/glm-client.ts BROWSER_AGENT_DEFAULT_MODEL
      computer_vision: 'deepseek-flash',  // computer-agent/vision-client.ts COMPUTER_VISION_DEFAULT_MODEL (was gpt-5.6-luna)
      kids: 'qwen3.6-flash',              // qwen-kid.integration.ts KID_MODEL
      asr: '',                            // speech.ts built-in STT chain (STT_BASE_URL → DashScope qwen3-asr-flash)
      tts: '',                            // speech.ts built-in DashScope qwen3-tts-flash (was OpenAI tts-1)
      decision: 'jev',                    // platform/decision-gate.ts DECISION_BUILT_IN_JEV — TypeSafe Jev (TYPESAFE_API_KEY), readout fallback on deepseek-flash (2026-09-24)
      image_generate: 'qwen-image-3.0',   // image-generate.ts IMAGE_DEFAULT_MODEL — DashScope, 4 s / $0.03 at 1024², edits (2026-09-24)
    });
  });

  it('BUILT_IN_MODEL_IDS mirrors coding-model CodingModelId', () => {
    expect([...BUILT_IN_MODEL_IDS].sort()).toEqual(
      ['deepseek-flash', 'glm-5.3', 'kimi-k2.6', 'kimi-k3', 'qwen3.6-27b', 'glm-5.3-flash', 'qwen3.6-flash'].sort(),
    );
    // …and coding-model's own list agrees (the run path resolves every seat id).
    const { BUILT_IN_CODING_MODEL_IDS } = jest.requireActual('../coding/coding-model');
    expect([...BUILT_IN_CODING_MODEL_IDS].sort()).toEqual([...BUILT_IN_MODEL_IDS].sort());
  });

  it('NON_CHAT_ROLES is exactly embeddings + rerank + asr + tts; the vector dim is pinned to 1536', () => {
    expect([...NON_CHAT_ROLES].sort()).toEqual(['asr', 'embeddings', 'rerank', 'tts']);
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
    expect(isModelRoleKey('coding_helper')).toBe(true);
    expect(isModelRoleKey('asr')).toBe(true);
    expect(isModelRoleKey('nope')).toBe(false);
  });

  it('rejects Object.prototype member names as role keys (own-property check)', async () => {
    for (const k of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(isModelRoleKey(k)).toBe(false);
      await expect(updateModelRoles({ [k]: 'kimi-k3' })).rejects.toMatchObject({ statusCode: 400 });
    }
  });
});

// Project-supervisor preflight 2026-09-14 (architecture assessment, fix 2):
// #741's per-project supervisor chats resolved the SAME 'supervisor' seat as
// the fleet chat — no knob to run the layer that fans out workers on a
// different model. The new seat's UNSET value must FOLLOW the supervisor
// seat's RESOLVED model (override, else built-in) so enabling the role changes
// nothing until the owner assigns it; the owner decides seats, not the code.
describe('project_supervisor seat (inherits from supervisor)', () => {
  it('is a real role: listed after supervisor, valid key, inheritsFrom supervisor, no hardcoded default', () => {
    const keys = MODEL_ROLES.map(r => r.key);
    expect(isModelRoleKey('project_supervisor')).toBe(true);
    expect(keys.indexOf('project_supervisor')).toBe(keys.indexOf('supervisor') + 1);
    const def = MODEL_ROLES.find(r => r.key === 'project_supervisor')!;
    expect(def).toMatchObject({ persona: 'Project Supervisor', defaultModel: '', inheritsFrom: 'supervisor' });
    expect(def.description).toMatch(/fan out workers/i);
    expect(def.description).toMatch(/58% zero-tool/);
    // Three seats inherit (chat_quick → coding_helper, dynamic roster 2026-10-03; project_supervisor → supervisor; coding_reviewer → double_checker, roadmap item 4), and no parent itself inherits (one hop).
    expect(MODEL_ROLES.filter(r => r.inheritsFrom).map(r => r.key)).toEqual(['chat_quick', 'project_supervisor', 'coding_reviewer']);
    expect(MODEL_ROLES.find(r => r.key === 'double_checker')!.inheritsFrom).toBeUndefined();
    expect(MODEL_ROLES.find(r => r.key === 'supervisor')!.inheritsFrom).toBeUndefined();
    expect(NON_CHAT_ROLES.has('project_supervisor')).toBe(false);
  });

  it('UNSET → resolves to the supervisor seat\'s built-in default (byte-identical to before the seat existed)', async () => {
    expect(await resolveRoleModel('project_supervisor')).toBe('kimi-k3');
    expect(roleDefaultModel('project_supervisor', {})).toBe('kimi-k3');
    expect(await resolveRoleModel('supervisor')).toBe('kimi-k3');
  });

  it('UNSET → FOLLOWS a supervisor override (the owner re-seating the fleet chat re-seats the project layer too)', async () => {
    mockStoreGet.mockResolvedValue({ roles: { supervisor: 'deepseek-flash' } });
    expect(await resolveRoleModel('project_supervisor')).toBe('deepseek-flash');
    // A RETIRED id stored on the parent aliases forward before the child reads it.
    mockStoreGet.mockResolvedValue({ roles: { supervisor: 'deepseek-v4-pro' } });
    clearModelRoleCache();
    expect(await resolveRoleModel('project_supervisor')).toBe('deepseek-flash');
  });

  it('its OWN override wins over the parent, and clearing it falls back to following the parent again', async () => {
    statefulStore({ roles: { supervisor: 'deepseek-flash', project_supervisor: 'glm-5.3' } });
    expect(await resolveRoleModel('project_supervisor')).toBe('glm-5.3');
    expect(await resolveRoleModel('supervisor')).toBe('deepseek-flash');
    await updateModelRoles({ project_supervisor: '' });
    expect(await resolveRoleModel('project_supervisor')).toBe('deepseek-flash');
    expect(mockStorePut).toHaveBeenLastCalledWith(['instance', 'model-roles'], 'config', { roles: { supervisor: 'deepseek-flash' }, fallbacks: {} });
  });

  it('listModelRoles: the view\'s defaultModel/effective carry the RESOLVED parent model (the UI label reads "Default — <model>", never "")', async () => {
    let roles = await listModelRoles();
    expect(roles.find(r => r.key === 'project_supervisor')).toMatchObject({
      persona: 'Project Supervisor', inheritsFrom: 'supervisor',
      defaultModel: 'kimi-k3', override: null, effective: 'kimi-k3', resolves: true, servable: true,
    });
    mockStoreGet.mockResolvedValue({ roles: { supervisor: 'my-ollama:qwen3:32b' } });
    mockResolveRegistryModel.mockResolvedValue(REG);
    clearModelRoleCache();
    roles = await listModelRoles();
    expect(roles.find(r => r.key === 'project_supervisor')).toMatchObject({
      defaultModel: 'my-ollama:qwen3:32b', override: null, effective: 'my-ollama:qwen3:32b',
    });
    // Plain seats are untouched by the helper — their view defaultModel is still the definition's.
    expect(roles.find(r => r.key === 'supervisor')).toMatchObject({ defaultModel: 'kimi-k3', override: 'my-ollama:qwen3:32b' });
    expect(roles.find(r => r.key === 'utility')).toMatchObject({ defaultModel: '', effective: '' });
  });

  it('listModelRoles: servability is judged on the INHERITED effective model (keyless parent provider badges the child too)', async () => {
    mockSeatServability.mockImplementation(async (m: any) =>
      m === 'kimi-k3'
        ? { reason: 'its model "kimi-k3" needs the MOONSHOT_API_KEY environment variable that is not set on this instance', missingEnvKey: 'MOONSHOT_API_KEY' }
        : { reason: null });
    const roles = await listModelRoles();
    expect(roles.find(r => r.key === 'project_supervisor')).toMatchObject({ servable: false, missingEnvKey: 'MOONSHOT_API_KEY' });
    expect(roles.find(r => r.key === 'supervisor')).toMatchObject({ servable: false, missingEnvKey: 'MOONSHOT_API_KEY' });
    // Re-seating the child onto a live provider clears ITS badge independently.
    mockStoreGet.mockResolvedValue({ roles: { project_supervisor: 'deepseek-flash' } });
    clearModelRoleCache();
    const roles2 = await listModelRoles();
    expect(roles2.find(r => r.key === 'project_supervisor')).toMatchObject({ servable: true, effective: 'deepseek-flash' });
    expect(roles2.find(r => r.key === 'supervisor')).toMatchObject({ servable: false });
  });

  it('updateModelRoles validates it like the other agent seats: built-ins save, unflagged registry specs 400, reasoning built-ins are FINE (streaming seat)', async () => {
    statefulStore();
    const roles = await updateModelRoles({ project_supervisor: 'deepseek-flash' });
    expect(roles.find(r => r.key === 'project_supervisor')).toMatchObject({ override: 'deepseek-flash', effective: 'deepseek-flash' });
    expect(mockResolveRegistryModel).not.toHaveBeenCalled();
    // kimi-k3 / glm-5.3 are reasoning built-ins — rejected only on the
    // NON-STREAMING seats; this seat streams, so they are assignable.
    await expect(updateModelRoles({ project_supervisor: 'glm-5.3' })).resolves.toBeTruthy();
    await expect(updateModelRoles({ project_supervisor: 'kimi-k3' })).resolves.toBeTruthy();
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false });
    await expect(updateModelRoles({ project_supervisor: 'my-ollama:qwen3:32b' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('testModelRole on the UNSET seat probes the PARENT\'s resolved model with the streaming chat shape — never an empty spec', async () => {
    mockStoreGet.mockResolvedValue({ roles: { supervisor: 'deepseek-flash' } });
    mockResolveProviderForRun.mockResolvedValueOnce({
      url: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'sk-deepseek-secret', model: 'deepseek-flash',
      label: 'DeepSeek (api.deepseek.com)', extra: {},
    });
    const stream: any = new EventEmitter();
    stream.destroy = jest.fn();
    mockedAxios.post.mockImplementationOnce(async () => {
      setTimeout(() => stream.emit('data', Buffer.from('data: {}')), 5);
      return { data: stream } as any;
    });
    const r = await testModelRole('project_supervisor', '');
    expect(mockResolveProviderForRun).toHaveBeenCalledWith('deepseek-flash');
    expect(r).toMatchObject({ ok: true, target: 'built-in default (deepseek-flash)' });
    expect(r.detail).toContain('first tokens');
  });
});

// ── Seat renames + custom fallbacks (owner 2026-09-15: "remove the names …
//    cross-checker, logician and professor and just change them to Double
//    Checker & Triple Checker … the secondary should be the same model on both
//    patience level 2 and 3 … the option to 'add custom fallback'"). ──
describe('seat vocabulary (owner 2026-09-15)', () => {
  it('lists exactly the current seats, in admin order, with the seat labels the chat UI shares', () => {
    expect(MODEL_ROLES.map(r => r.key)).toEqual([
      'chat_orchestrator',
      // 2026-10-03 dynamic roster: the Auto Quick lane's lead, listed next to Digby
      'chat_quick',
      'supervisor', 'project_supervisor', 'double_checker', 'triple_checker',
      'coding_default', 'coding_helper', 'coding_reviewer', 'coding_architect', 'coding_explorer', 'utility', 'embeddings', 'rerank',
      // 2026-09-22 capability seats + speech seats
      'vision_describe', 'pdf_ocr', 'browser_agent', 'computer_vision', 'kids', 'asr', 'tts',
      // 2026-09-24 decision seat (platform/decision-gate.ts)
      'decision',
      // 2026-09-24 image generator seat (image-generate.ts) — appended LAST
      'image_generate',
    ]);
    expect(SEAT_PERSONAS.chat_orchestrator).toBe('Digby');
    expect(SEAT_PERSONAS.double_checker).toBe('Double Checker');
    expect(SEAT_PERSONAS.triple_checker).toBe('Triple Checker');
    const allText = MODEL_ROLES.map(r => `${r.persona} ${r.description} ${r.builtInFallback}`).join(' ');
    expect(allText).not.toMatch(/Fact-checker|Cross-checker|Logician|Professor/);
    // The retired keys are NOT roles…
    for (const k of ['chat_cross_checker', 'council_logician', 'council_professor', 'utility_fallback']) expect(isModelRoleKey(k)).toBe(false);
    // …but every legacy alias normalizes to its current seat.
    expect(normalizeRoleKey('chat_cross_checker')).toBe('double_checker');
    expect(normalizeRoleKey('council_logician')).toBe('double_checker');
    expect(normalizeRoleKey('council_professor')).toBe('triple_checker');
    expect(normalizeRoleKey('double_checker')).toBe('double_checker');
    expect(normalizeRoleKey('nope')).toBeNull();
    expect(normalizeRoleKey('toString')).toBeNull();
    expect(Object.keys(LEGACY_ROLE_ALIASES).sort()).toEqual(['chat_cross_checker', 'council_logician', 'council_professor']);
  });

  it('fallbackable seats = every seat whose runtime has a fallback seam; the rest say why not', () => {
    // coding_default joined 2026-09-17 (ticket fe6f0b0b): the main coding seat's
    // transient failover reads the admin's custom fallback, then glm-5.3.
    // 2026-09-22: the Image reader + PDF reader seats gained a custom-fallback seam (seat → custom fallback → built-in).
    // 2026-09-24: the Decision gate seat → custom fallback → built-in jev → built-in deepseek readout.
    // 2026-09-24: the Image generator seat → custom fallback → built-in z-image-turbo → glm-image → cogview-4-250304.
    // 2026-10-03: the Quick answers seat → custom fallback → the Digby seat (helper-seat.ts pickLeadFallback).
    expect([...FALLBACKABLE_ROLES].sort()).toEqual(['chat_orchestrator', 'chat_quick', 'coding_default', 'coding_helper', 'double_checker', 'project_supervisor', 'supervisor', 'triple_checker', 'utility', 'vision_describe', 'pdf_ocr', 'decision', 'image_generate'].sort());
    for (const r of MODEL_ROLES) expect(r.builtInFallback.length).toBeGreaterThan(20);
  });

  it('MIGRATION: a stored row with the OLD keys resolves the NEW seats (explicit new key wins; L2 re-seat wins over the old logician)', () => {
    const cfg = normalizeStoredRoleConfig({ roles: {
      chat_cross_checker: 'kimi-k3', council_logician: 'deepseek-flash', council_professor: 'glm-5.3',
      chat_orchestrator: 'glm-5.3', utility_fallback: 'nebius-b300:Qwen/Qwen3-32B', junk: 'x',
    } });
    expect(cfg.overrides).toEqual({ chat_orchestrator: 'glm-5.3', double_checker: 'kimi-k3', triple_checker: 'glm-5.3' });
    expect(cfg.fallbacks).toEqual({ utility: 'nebius-b300:Qwen/Qwen3-32B' });
    // An explicit new key beats a legacy alias; only the logician set → it feeds the seat.
    expect(normalizeStoredRoleConfig({ roles: { double_checker: 'glm-5.3', chat_cross_checker: 'kimi-k3' } }).overrides.double_checker).toBe('glm-5.3');
    expect(normalizeStoredRoleConfig({ roles: { council_logician: 'kimi-k3' } }).overrides.double_checker).toBe('kimi-k3');
    // Retired built-in ids alias forward in BOTH maps; non-fallbackable fallbacks are dropped.
    const cfg2 = normalizeStoredRoleConfig({ roles: { council_professor: 'glm-5.2' }, fallbacks: { utility: 'deepseek-v4-flash', embeddings: 'x:y', bogus: 'z' } });
    expect(cfg2.overrides).toEqual({ triple_checker: 'glm-5.3' });
    expect(cfg2.fallbacks).toEqual({ utility: 'deepseek-flash' });
    expect(normalizeStoredRoleConfig(null)).toEqual({ overrides: {}, fallbacks: {} });
  });

  it("the LIVE prod row shape (2026-09-15 14:43Z: old keys) resolves L2 and L3 the way the owner set them — one secondary model", async () => {
    mockStoreGet.mockResolvedValue({ roles: {
      chat_orchestrator: 'glm-5.3', chat_cross_checker: 'kimi-k3', council_logician: 'kimi-k3', council_professor: 'deepseek-flash', project_supervisor: 'kimi-k3', coding_default: 'glm-5.3',
    } });
    expect(await resolveRoleModel('chat_orchestrator')).toBe('glm-5.3');
    expect(await resolveRoleModel('double_checker')).toBe('kimi-k3');
    expect(await resolveRoleModel('triple_checker')).toBe('deepseek-flash');
    // Legacy callers keep working.
    expect(await resolveRoleModel('chat_cross_checker')).toBe('kimi-k3');
    expect(await resolveRoleModel('council_professor')).toBe('deepseek-flash');
    expect(await resolveRoleModel('utility_fallback')).toBe(''); // = the utility seat's (unset) custom fallback
    expect(await resolveRoleModel('not-a-role')).toBe('');
  });

  it('updateModelRoles accepts a LEGACY key, saves under the NEW key, and drops the old keys from the row (self-heal)', async () => {
    statefulStore({ roles: { chat_cross_checker: 'deepseek-flash', council_logician: 'deepseek-flash', council_professor: 'glm-5.3' } });
    const roles = await updateModelRoles({ council_professor: 'kimi-k3' });
    expect(roles.find(r => r.key === 'triple_checker')).toMatchObject({ override: 'kimi-k3', effective: 'kimi-k3' });
    expect(mockStorePut).toHaveBeenLastCalledWith(['instance', 'model-roles'], 'config',
      { roles: { double_checker: 'deepseek-flash', triple_checker: 'kimi-k3' }, fallbacks: {} });
  });
});

describe('custom fallbacks (owner 2026-09-15 "add custom fallback")', () => {
  it("no fallbacks by default: every seat reads '' and the view carries fallback:null", async () => {
    expect(await getModelRoleFallbacks()).toEqual({});
    expect(await resolveRoleFallback('chat_orchestrator')).toBe('');
    expect(await resolveRoleFallback('embeddings')).toBe(''); // not fallbackable
    const roles = await listModelRoles();
    for (const r of roles) expect(r).toMatchObject({ fallback: null, fallbackResolves: true, fallbackable: FALLBACKABLE_ROLES.has(r.key) });
  });

  it('saves a fallback for a fallbackable seat (built-in or [coding] custom spec) in the fallbacks map — the roles map is untouched', async () => {
    statefulStore({ roles: { double_checker: 'kimi-k3' } });
    mockResolveRegistryModel.mockResolvedValue(REG);
    const roles = await updateModelRoles({}, undefined, { fallbacks: { double_checker: 'my-ollama:qwen3:32b', chat_orchestrator: 'glm-5.3' } });
    expect(roles.find(r => r.key === 'double_checker')).toMatchObject({ override: 'kimi-k3', fallback: 'my-ollama:qwen3:32b', fallbackResolves: true });
    expect(roles.find(r => r.key === 'chat_orchestrator')).toMatchObject({ override: null, fallback: 'glm-5.3' });
    expect(mockStorePut).toHaveBeenLastCalledWith(['instance', 'model-roles'], 'config',
      { roles: { double_checker: 'kimi-k3' }, fallbacks: { double_checker: 'my-ollama:qwen3:32b', chat_orchestrator: 'glm-5.3' } });
    expect(await resolveRoleFallback('double_checker')).toBe('my-ollama:qwen3:32b');
    expect(await resolveRoleFallback('council_logician')).toBe('my-ollama:qwen3:32b'); // legacy alias
    // '' clears it.
    await updateModelRoles({}, undefined, { fallbacks: { double_checker: '' } });
    expect(await resolveRoleFallback('double_checker')).toBe('');
  });

  it('the CODING DEFAULT seat takes a custom fallback (ticket fe6f0b0b) — the main coding seat failover reads it', async () => {
    statefulStore({ roles: { coding_default: 'glm-5.3' } });
    mockResolveRegistryModel.mockResolvedValue(REG);
    const roles = await updateModelRoles({}, undefined, { fallbacks: { coding_default: 'my-ollama:qwen3:32b' } });
    expect(roles.find(r => r.key === 'coding_default')).toMatchObject({ fallback: 'my-ollama:qwen3:32b', fallbackResolves: true });
    expect(await resolveRoleFallback('coding_default')).toBe('my-ollama:qwen3:32b');
    // …but a fallback equal to the seat's own model is still refused.
    await expect(updateModelRoles({}, undefined, { fallbacks: { coding_default: 'glm-5.3' } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('same model the seat already runs') });
  });

  it('refuses a fallback on a non-fallbackable seat, an unflagged custom spec, and a fallback equal to the seat model', async () => {
    statefulStore({ roles: { chat_orchestrator: 'glm-5.3' } });
    await expect(updateModelRoles({}, undefined, { fallbacks: { embeddings: 'my-ollama:x' } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('no custom-fallback slot') });
    // 2026-09-27: the [coding] flag is retired — a NON-CHAT model (an embeddings /
    // rerank / decision kind) is what a chat seat refuses now.
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, chatCapable: false, kind: 'embeddings' });
    await expect(updateModelRoles({}, undefined, { fallbacks: { double_checker: 'my-ollama:qwen3:32b' } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not a chat model') });
    // …while a legacy resolution that only carries the old flag still reads it (older rows / mocks).
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false });
    await expect(updateModelRoles({}, undefined, { fallbacks: { double_checker: 'my-ollama:qwen3:32b' } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not a chat model') });
    await expect(updateModelRoles({}, undefined, { fallbacks: { chat_orchestrator: 'glm-5.3' } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('same model the seat already runs') });
    // …including when the ROLE side of the same patch creates the collision.
    await expect(updateModelRoles({ double_checker: 'kimi-k3' }, undefined, { fallbacks: { double_checker: 'kimi-k3' } })).rejects.toMatchObject({ statusCode: 400 });
    // The default is the seat model too: a fallback equal to the unset seat's default is refused.
    await expect(updateModelRoles({}, undefined, { fallbacks: { triple_checker: 'glm-5.3' } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateModelRoles({}, undefined, { fallbacks: { nope: 'glm-5.3' } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateModelRoles({})).rejects.toMatchObject({ statusCode: 400 });
  });

  it("the UTILITY seat's fallback takes custom endpoint specs only (review F1) and the legacy utility_fallback role key still saves/reads there", async () => {
    statefulStore();
    mockResolveRegistryModel.mockResolvedValue(REG);
    await expect(updateModelRoles({}, undefined, { fallbacks: { utility: 'deepseek-flash' } })).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('custom endpoint'),
    });
    await expect(updateModelRoles({ utility_fallback: 'glm-5.3' })).rejects.toMatchObject({ statusCode: 400 });
    const roles = await updateModelRoles({ utility_fallback: 'my-ollama:qwen3:32b' });
    expect(roles.find(r => r.key === 'utility')).toMatchObject({ fallback: 'my-ollama:qwen3:32b' });
    expect(mockStorePut).toHaveBeenLastCalledWith(['instance', 'model-roles'], 'config',
      { roles: {}, fallbacks: { utility: 'my-ollama:qwen3:32b' } });
    expect(await resolveRoleFallback('utility')).toBe('my-ollama:qwen3:32b');
    expect(await resolveRoleModel('utility_fallback')).toBe('my-ollama:qwen3:32b'); // utility-llm's legacy read
  });

  it('a stored legacy utility_fallback ROLE row is read as the utility fallback and migrated on the next save', async () => {
    statefulStore({ roles: { utility_fallback: 'my-ollama:qwen3:32b', utility: 'my-ollama:qwen3:8b' } });
    mockResolveRegistryModel.mockResolvedValue(REG);
    expect(await resolveRoleFallback('utility')).toBe('my-ollama:qwen3:32b');
    const roles = await updateModelRoles({ coding_helper: 'deepseek-flash' });
    expect(roles.find(r => r.key === 'utility')).toMatchObject({ override: 'my-ollama:qwen3:8b', fallback: 'my-ollama:qwen3:32b' });
    expect(mockStorePut).toHaveBeenLastCalledWith(['instance', 'model-roles'], 'config',
      { roles: { utility: 'my-ollama:qwen3:8b', coding_helper: 'deepseek-flash' }, fallbacks: { utility: 'my-ollama:qwen3:32b' } });
  });

  it("testModelRole on an EMPTY fallback slot 400s (nothing of its own to probe); a set fallback is probed with the seat's real shape", async () => {
    await expect(testModelRole('double_checker', '', { fallback: true })).rejects.toMatchObject({
      statusCode: 400, message: expect.stringContaining('No custom fallback configured'),
    });
    await expect(testModelRole('utility_fallback', '')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('No custom fallback configured') });
    expect(mockedAxios.post).not.toHaveBeenCalled();
    // Utility fallback = the NON-streaming probe (its real call shape).
    mockResolveRegistryModel.mockResolvedValue(REG);
    mockResolveProviderForRun.mockResolvedValue({
      url: REG.url, apiKey: REG.apiKey, model: REG.model, label: 'my-ollama (custom endpoint)', extra: {},
    });
    mockedAxios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } } as any);
    const r = await testModelRole('utility', 'my-ollama:qwen3:32b', { fallback: true });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('non-streaming completion OK');
    const sent = mockedAxios.post.mock.calls[0][1] as any;
    expect(sent.stream).toBeUndefined(); // NOT the streaming first-chunk probe
    // A built-in id offered to the utility fallback is refused before any call.
    await expect(testModelRole('utility', 'deepseek-flash', { fallback: true })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("listModelRoles: a stale custom fallback spec is badged fallbackResolves:false; the seat's servability is unaffected", async () => {
    mockStoreGet.mockResolvedValue({ roles: {}, fallbacks: { chat_orchestrator: 'gone:model' } });
    mockResolveRegistryModel.mockResolvedValue(null);
    const roles = await listModelRoles();
    expect(roles.find(r => r.key === 'chat_orchestrator')).toMatchObject({ fallback: 'gone:model', fallbackResolves: false, servable: true, resolves: true });
  });
});

describe('override reads', () => {
  it('no store row → every role resolves its default', async () => {
    expect(await resolveRoleModel('chat_orchestrator')).toBe('kimi-k3');
    expect(await resolveRoleModel('utility')).toBe('');
    expect(mockStoreGet).toHaveBeenCalledWith(['instance', 'model-roles'], 'config');
  });

  it('stored override wins; unknown keys and empty values are ignored', async () => {
    mockStoreGet.mockResolvedValue({ roles: {
      coding_helper: 'my-ollama:qwen3:32b',
      bogus_role: 'x:y',
      chat_orchestrator: '   ',
    } });
    expect(await resolveRoleModel('coding_helper')).toBe('my-ollama:qwen3:32b');
    expect(await resolveRoleModel('chat_orchestrator')).toBe('kimi-k3');
    expect(await getModelRoleOverrides()).toEqual({ coding_helper: 'my-ollama:qwen3:32b' });
  });

  it('caches for the TTL (one store read for many resolves) and clears on demand', async () => {
    await resolveRoleModel('coding_helper');
    await resolveRoleModel('chat_orchestrator');
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
    clearModelRoleCache();
    await resolveRoleModel('coding_helper');
    expect(mockStoreGet).toHaveBeenCalledTimes(2);
  });

  it('FAILS OPEN to defaults when the store read throws', async () => {
    mockStoreGet.mockRejectedValue(new Error('db down'));
    expect(await resolveRoleModel('double_checker')).toBe('deepseek-flash');
  });

  it('serves the LAST KNOWN overrides on a store-read failure (stale-on-error, not {})', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      mockStoreGet.mockResolvedValueOnce({ roles: { embeddings: 'my-ollama:nomic-embed' } });
      expect(await getModelRoleOverrides()).toEqual({ embeddings: 'my-ollama:nomic-embed' });
      nowSpy.mockReturnValue(1_000_000 + 31_000); // expire the 30s cache
      mockStoreGet.mockRejectedValueOnce(new Error('db blip'));
      // A DB blip must not flip the overrides to {} — that would silently swap
      // the embeddings vector space on an instance with an override configured.
      expect(await getModelRoleOverrides()).toEqual({ embeddings: 'my-ollama:nomic-embed' });
      expect(mockStoreGet).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('concurrent cold-cache reads share ONE store read (in-flight dedup)', async () => {
    let resolveRead: (v: any) => void;
    mockStoreGet.mockImplementationOnce(() => new Promise(res => { resolveRead = res; }));
    const [a, b, c] = [resolveRoleModel('chat_orchestrator'), resolveRoleModel('coding_helper'), getModelRoleOverrides()];
    resolveRead!({ roles: { coding_helper: 'my-ollama:qwen3:32b' } });
    expect(await a).toBe('kimi-k3');
    expect(await b).toBe('my-ollama:qwen3:32b');
    expect(await c).toEqual({ coding_helper: 'my-ollama:qwen3:32b' });
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
  });
});

describe('listModelRoles viewerPick (feedback e5298647)', () => {
  // REPLAY e5298647 — the 2026-09-11 incident: the owner saved the
  // coding_default seat → glm-5.3 at 17:25Z (the store row's updated_at proves
  // the save persisted), yet a fresh coding session at 17:43Z — and a live
  // repro probe at 18:16Z — still stamped kimi-k3. Cause: the owner's stored
  // UserPreferences.codingModel='kimi-k3' (2026-08-24) wins over the seat in
  // resolveStampedCodingModel (project pick > user pref > seat). The shadow
  // was invisible in the admin UI, so the save looked dead. listModelRoles
  // now surfaces the shadowing pick on the coding_default row.
  const codingDefaultRow = (roles: any[]) => roles.find((r: any) => r.key === 'coding_default');

  // Seats govern sessions (2026-09-28): a stored value shadows the seat ONLY when the user
  // set it THEMSELVES — the context-store marker ['user',<id>,'coding-prefs']/codingModelExplicit
  // names the current stored value (coding/seat-governance.ts). The store mock answers it here.
  const markExplicit = (model: string) => mockStoreGet.mockImplementation(async (_ns: string[], key: string) => (key === 'codingModelExplicit' ? { model, at: '2026-09-28T00:00:00.000Z', via: 'settings' } : null));

  it('surfaces the viewer\'s EXPLICIT shadowing pick on the coding_default row only, when it stamps a DIFFERENT model than the seat', async () => {
    mockPrefFindUnique.mockResolvedValue({ codingModel: 'kimi-k3' });
    mockResolveOneCodingPick.mockResolvedValue('kimi-k3');
    markExplicit('kimi-k3');
    const roles = await listModelRoles('owner-1');
    expect(codingDefaultRow(roles).viewerPick).toEqual({ stored: 'kimi-k3', resolved: 'kimi-k3' });
    expect(roles.filter((r: any) => r.viewerPick)).toHaveLength(1);
    expect(mockPrefFindUnique).toHaveBeenCalledWith({ where: { userId: 'owner-1' }, select: { codingModel: true } });
  });

  it('an UNMARKED stored value never shadows (the seat governs it) — the pre-2026-09-28 "any resolvable pref is a pick" trap; SEAT_GOVERNS_SESSIONS_DISABLED=1 restores it', async () => {
    mockPrefFindUnique.mockResolvedValue({ codingModel: 'kimi-k3' });
    mockResolveOneCodingPick.mockResolvedValue('kimi-k3');
    expect(codingDefaultRow(await listModelRoles('owner-1')).viewerPick).toBeUndefined();
    expect(mockResolveOneCodingPick).not.toHaveBeenCalled();
    process.env.SEAT_GOVERNS_SESSIONS_DISABLED = '1';
    try {
      expect(codingDefaultRow(await listModelRoles('owner-1')).viewerPick).toEqual({ stored: 'kimi-k3', resolved: 'kimi-k3' });
    } finally {
      delete process.env.SEAT_GOVERNS_SESSIONS_DISABLED;
    }
  });

  it('stays quiet when the pick resolves to the SAME model as the seat effective (a default-valued pref row is not a visible shadow)', async () => {
    mockPrefFindUnique.mockResolvedValue({ codingModel: 'glm-5.2' }); // column default — aliases forward to glm-5.3
    mockResolveOneCodingPick.mockResolvedValue('glm-5.3');
    const roles = await listModelRoles('owner-1');
    expect(codingDefaultRow(roles).viewerPick).toBeUndefined();
  });

  it('compares against the seat OVERRIDE (not just the built-in default) when one is set', async () => {
    statefulStore({ roles: { coding_default: 'deepseek-flash' } });
    mockPrefFindUnique.mockResolvedValue({ codingModel: 'deepseek-flash' });
    mockResolveOneCodingPick.mockResolvedValue('deepseek-flash');
    const roles = await listModelRoles('owner-1');
    expect(codingDefaultRow(roles).viewerPick).toBeUndefined(); // same model → no shadow
  });

  it('no viewerPick without a userId, without a pref row, with an unresolvable pick, or when the lookup throws (fail-open)', async () => {
    expect(codingDefaultRow(await listModelRoles()).viewerPick).toBeUndefined(); // anonymous caller
    expect(codingDefaultRow(await listModelRoles('u1')).viewerPick).toBeUndefined(); // no row
    mockPrefFindUnique.mockResolvedValue({ codingModel: 'gone:model-x' });
    mockResolveOneCodingPick.mockResolvedValue(null); // stale registry spec → seat applies, no shadow
    expect(codingDefaultRow(await listModelRoles('u1')).viewerPick).toBeUndefined();
    mockPrefFindUnique.mockRejectedValue(new Error('db down'));
    const roles = await listModelRoles('u1');
    expect(codingDefaultRow(roles).viewerPick).toBeUndefined();
    expect(roles).toHaveLength(MODEL_ROLES.length); // the page still renders
  });

  it('updateModelRoles threads the viewer through, so the save response keeps the shadow signal', async () => {
    mockPrefFindUnique.mockResolvedValue({ codingModel: 'kimi-k3' });
    mockResolveOneCodingPick.mockResolvedValue('kimi-k3');
    markExplicit('kimi-k3');
    const roles = await updateModelRoles({ double_checker: 'deepseek-flash' }, 'owner-1');
    expect(codingDefaultRow(roles).viewerPick).toEqual({ stored: 'kimi-k3', resolved: 'kimi-k3' });
  });
});

describe('updateModelRoles', () => {
  it('rejects unknown roles and non-string values with a 400', async () => {
    await expect(updateModelRoles({ nope: 'kimi-k3' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateModelRoles({})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('agent role: built-in id is assignable without touching the registry', async () => {
    await updateModelRoles({ double_checker: 'deepseek-flash' });
    expect(mockResolveRegistryModel).not.toHaveBeenCalled();
    expect(mockStorePut).toHaveBeenCalledWith(['instance', 'model-roles'], 'config',
      { roles: { double_checker: 'deepseek-flash' }, fallbacks: {} });
  });

  it('agent role: a registry spec must resolve AND carry the [coding] flag', async () => {
    statefulStore();
    mockResolveRegistryModel.mockResolvedValueOnce(null);
    await expect(updateModelRoles({ coding_helper: 'ghost:model' })).rejects.toMatchObject({ statusCode: 400 });
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, coding: false });
    await expect(updateModelRoles({ coding_helper: 'my-ollama:qwen3:32b' })).rejects.toMatchObject({ statusCode: 400 });
    mockResolveRegistryModel.mockResolvedValueOnce(REG);
    const roles = await updateModelRoles({ coding_helper: 'my-ollama:qwen3:32b' });
    expect(roles.find(r => r.key === 'coding_helper')).toMatchObject({
      override: 'my-ollama:qwen3:32b', effective: 'my-ollama:qwen3:32b',
    });
  });

  it('non-chat roles: any resolving registry spec is assignable, built-ins are not', async () => {
    await expect(updateModelRoles({ embeddings: 'qwen3.6-27b' })).rejects.toMatchObject({ statusCode: 400 });
    // Save now PROBES the embedding shape (dimension gate) — serve a 1536 vector.
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'nomic-embed' });
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ embedding: new Array(1536).fill(0.1) }] } } as any);
    await updateModelRoles({ embeddings: 'my-ollama:nomic-embed' });
    expect(mockStorePut).toHaveBeenCalledWith(['instance', 'model-roles'], 'config',
      { roles: { embeddings: 'my-ollama:nomic-embed' }, fallbacks: {} });
  });

  it('SAVE-TIME dimension gate (owner 2026-09-08): a 4096-dim embeddings model is REFUSED with the Test verdict, never stored', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'Qwen3-Embedding-8B' });
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ embedding: new Array(4096).fill(0.1) }] } } as any);
    await expect(updateModelRoles({ embeddings: 'my-ollama:Qwen3-Embedding-8B' })).rejects.toMatchObject({
      statusCode: 400, message: expect.stringMatching(/Refusing to save the embeddings role[\s\S]*4096[\s\S]*MRL/),
    });
    expect(mockStorePut).not.toHaveBeenCalled();
    // Rerank has no dimension contract — saving it never probes.
    mockedAxios.post.mockReset();
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'Qwen3-Reranker-4B' });
    await updateModelRoles({ rerank: 'my-ollama:Qwen3-Reranker-4B' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('a stored RETIRED built-in id reads as its current model and self-heals on the next save (V4.1 Flash cutover)', async () => {
    // Pre-2026-09-10 rows could hold deepseek-v4-flash (utility/helper) or
    // deepseek-v4-pro (chat seats); the run path normalizes them, so the admin
    // surface must agree — otherwise the picker shows "Default" and Test 400s.
    statefulStore({ roles: { utility: 'deepseek-v4-flash', chat_cross_checker: 'deepseek-v4-pro', coding_default: 'glm-5.2' } });
    // (chat_cross_checker is a LEGACY key — it reads as the Double Checker and is re-saved under the new key.)
    expect(await resolveRoleModel('utility')).toBe('deepseek-flash');
    expect(await resolveRoleModel('double_checker')).toBe('deepseek-flash');
    expect(await resolveRoleModel('coding_default')).toBe('glm-5.3');
    const roles = await updateModelRoles({ coding_helper: 'qwen3.6-27b' });
    expect(mockStorePut).toHaveBeenCalledWith(['instance', 'model-roles'], 'config',
      { roles: { utility: 'deepseek-flash', double_checker: 'deepseek-flash', coding_default: 'glm-5.3', coding_helper: 'qwen3.6-27b' }, fallbacks: {} });
    expect(roles.find(r => r.key === 'utility')).toMatchObject({ override: 'deepseek-flash', effective: 'deepseek-flash' });
  });

  it("'' clears an override back to the default and merges with existing rows", async () => {
    statefulStore({ roles: { coding_helper: 'my-ollama:qwen3:32b', utility: 'deepseek-flash' } });
    const roles = await updateModelRoles({ coding_helper: '' });
    expect(mockStorePut).toHaveBeenCalledWith(['instance', 'model-roles'], 'config',
      { roles: { utility: 'deepseek-flash' }, fallbacks: {} });
    expect(roles.find(r => r.key === 'coding_helper')).toMatchObject({ override: null, effective: 'qwen3.6-27b' });
  });

  it('listModelRoles reports default/override/effective per seat + a stale-override flag', async () => {
    mockStoreGet.mockResolvedValue({ roles: { chat_orchestrator: 'my-ollama:qwen3:32b', coding_helper: 'ghost:model' } });
    mockResolveRegistryModel.mockImplementation(async (spec: string) => (spec === 'my-ollama:qwen3:32b' ? REG : null));
    const roles = await listModelRoles();
    expect(roles.find(r => r.key === 'chat_orchestrator')).toMatchObject({
      persona: 'Digby', defaultModel: 'kimi-k3',
      override: 'my-ollama:qwen3:32b', effective: 'my-ollama:qwen3:32b', resolves: true,
    });
    // A dangling override (endpoint deleted/disabled after assignment) is
    // surfaced — the seat silently runs its default until fixed.
    expect(roles.find(r => r.key === 'coding_helper')).toMatchObject({ override: 'ghost:model', resolves: false });
    expect(roles.find(r => r.key === 'rerank')).toMatchObject({ override: null, effective: '', resolves: true });
  });

  it('listModelRoles surfaces per-seat SERVABILITY (keyless-Edge trap: untouched seats on dead providers)', async () => {
    const prevDash = process.env.DASHSCOPE_API_KEY;
    const prevDeep = process.env.DEEPSEEK_API_KEY;
    const prevStt = process.env.STT_BASE_URL;
    const prevOpenai = process.env.OPENAI_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.STT_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    try {
      mockSeatServability.mockImplementation(async (m: any) =>
        String(m).includes(':')
          ? { reason: null }
          : { reason: `its model "${m}" needs the MOONSHOT_API_KEY environment variable that is not set on this instance`, missingEnvKey: 'MOONSHOT_API_KEY' });
      const roles = await listModelRoles();
      // Agent seat on a keyless built-in default → badged, with the exact
      // .env variable named for the UI (owner ask 2026-09-05).
      expect(roles.find(r => r.key === 'chat_orchestrator')).toMatchObject({
        servable: false, unservableReason: expect.stringContaining('kimi-k3'),
        missingEnvKey: 'MOONSHOT_API_KEY',
      });
      // Chain roles on a keyless box: utility needs DeepSeek or DashScope,
      // embeddings/rerank need DashScope — each names its variable(s).
      expect(roles.find(r => r.key === 'utility')).toMatchObject({
        servable: false, missingEnvKey: 'DEEPSEEK_API_KEY or DASHSCOPE_API_KEY',
      });
      expect(roles.find(r => r.key === 'embeddings')).toMatchObject({
        servable: false, missingEnvKey: 'DASHSCOPE_API_KEY',
      });
      // The asr chain needs a self-hosted STT URL or a DashScope key (no
      // frontier whisper leg since 2026-09-22) — neither here, so the seat is
      // badged with BOTH fix paths; tts needs DashScope.
      expect(roles.find(r => r.key === 'asr')).toMatchObject({
        servable: false, missingEnvKey: 'STT_BASE_URL or DASHSCOPE_API_KEY',
      });
      expect(roles.find(r => r.key === 'tts')).toMatchObject({
        servable: false, missingEnvKey: 'DASHSCOPE_API_KEY',
      });
      // With the chain keys back, the chain roles are servable again.
      process.env.DASHSCOPE_API_KEY = 'sk-d';
      process.env.STT_BASE_URL = 'http://localhost:5092/v1';
      clearModelRoleCache();
      const roles2 = await listModelRoles();
      expect(roles2.find(r => r.key === 'utility')!.servable).toBe(true);
      expect(roles2.find(r => r.key === 'rerank')!.servable).toBe(true);
      expect(roles2.find(r => r.key === 'asr')!.servable).toBe(true);
      // A custom-endpoint override is servable even keyless (the mock's ':' rule).
      mockStoreGet.mockResolvedValue({ roles: { chat_orchestrator: 'my-ollama:qwen3:32b' } });
      mockResolveRegistryModel.mockResolvedValue(REG);
      clearModelRoleCache();
      const roles3 = await listModelRoles();
      expect(roles3.find(r => r.key === 'chat_orchestrator')).toMatchObject({ servable: true });
    } finally {
      if (prevDash !== undefined) process.env.DASHSCOPE_API_KEY = prevDash; else delete process.env.DASHSCOPE_API_KEY;
      if (prevDeep !== undefined) process.env.DEEPSEEK_API_KEY = prevDeep; else delete process.env.DEEPSEEK_API_KEY;
      if (prevStt !== undefined) process.env.STT_BASE_URL = prevStt; else delete process.env.STT_BASE_URL;
      if (prevOpenai !== undefined) process.env.OPENAI_API_KEY = prevOpenai; else delete process.env.OPENAI_API_KEY;
    }
  });

  it('non-streaming seats (utility, coding_helper) reject reasoning built-ins; fast built-ins pass', async () => {
    for (const seat of ['utility', 'coding_helper']) {
      // deepseek-flash is NOT in this list on purpose: its thinking is switched
      // off per call by helper-completion, so it stays a fast built-in.
      for (const model of ['kimi-k3', 'kimi-k2.6', 'glm-5.3']) {
        await expect(updateModelRoles({ [seat]: model })).rejects.toMatchObject({ statusCode: 400 });
      }
    }
    for (const model of FAST_BUILT_IN_MODEL_IDS) {
      await expect(updateModelRoles({ coding_helper: model })).resolves.toBeTruthy();
    }
    // Chat seats still take reasoning built-ins (they stream via runModelTurn).
    await expect(updateModelRoles({ chat_orchestrator: 'kimi-k3' })).resolves.toBeTruthy();
  });

  it('listProviderKeyStatus reports presence per .env variable, never the value (owner ask 2026-09-05)', () => {
    const prevMoon = process.env.MOONSHOT_API_KEY;
    const prevZai = process.env.ZAI_API_KEY;
    process.env.MOONSHOT_API_KEY = 'sk-super-secret';
    delete process.env.ZAI_API_KEY;
    try {
      const status = listProviderKeyStatus();
      // Exactly the built-in seat providers, in UI order (+ TypeSafe for the Decision gate, 2026-09-24,
      // + BrightData for web search, 2026-10-20 — the panel showed every model key while an instance silently had no search).
      expect(status.map(s => s.envKey)).toEqual([
        'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'DASHSCOPE_API_KEY', 'TYPESAFE_API_KEY', 'BRIGHTDATA_API_TOKEN',
      ]);
      expect(status.find(s => s.envKey === 'MOONSHOT_API_KEY')).toMatchObject({
        present: true, provider: expect.stringContaining('Moonshot'),
        serves: expect.arrayContaining(['kimi-k3']),
      });
      expect(status.find(s => s.envKey === 'ZAI_API_KEY')).toMatchObject({ present: false });
      // The key VALUE must never appear anywhere in the payload.
      expect(JSON.stringify(status)).not.toContain('sk-super-secret');
      // Self-host 2026-10-20: when the GATEWAY is what serves search (production with only the
      // gateway token), the row names the gateway token, not the BrightData one.
      const prevEnv = { DIGBY_INSTANCE: process.env.DIGBY_INSTANCE, MCP_DIGBY_TOKEN: process.env.MCP_DIGBY_TOKEN, BRIGHTDATA_API_TOKEN: process.env.BRIGHTDATA_API_TOKEN };
      delete process.env.DIGBY_INSTANCE; delete process.env.BRIGHTDATA_API_TOKEN; process.env.MCP_DIGBY_TOKEN = 'gw';
      try {
        const gw = listProviderKeyStatus().find(s => s.serves.some(x => x.includes('search_engine')));
        expect(gw).toMatchObject({ envKey: 'MCP_DIGBY_TOKEN', present: true });
      } finally {
        for (const [k, v] of Object.entries(prevEnv)) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
      }
    } finally {
      if (prevMoon !== undefined) process.env.MOONSHOT_API_KEY = prevMoon; else delete process.env.MOONSHOT_API_KEY;
      if (prevZai !== undefined) process.env.ZAI_API_KEY = prevZai; else delete process.env.ZAI_API_KEY;
    }
  });
});

describe('testModelRole', () => {
  it('rejects unknown roles (400) and validates the candidate before probing', async () => {
    await expect(testModelRole('nope')).rejects.toMatchObject({ statusCode: 400 });
    mockResolveRegistryModel.mockResolvedValueOnce(null);
    await expect(testModelRole('embeddings', 'ghost:model')).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('embeddings probe: ok on a 1536-dim vector, key never leaks in errors', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'nomic-embed' });
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ embedding: new Array(1536).fill(0.1) }] } } as any);
    const ok = await testModelRole('embeddings', 'my-ollama:nomic-embed');
    expect(ok).toMatchObject({ ok: true, detail: expect.stringContaining('1536') });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://10.0.0.5:11434/v1/embeddings',
      expect.objectContaining({ model: 'nomic-embed', dimensions: 1536 }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-registry-secret' }) }),
    );
  });

  it('embeddings probe: wrong dimension is a clear failure', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'nomic-embed' });
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ embedding: new Array(768).fill(0.1) }] } } as any);
    const r = await testModelRole('embeddings', 'my-ollama:nomic-embed');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('768');
    expect(r.error).toContain('1536');
  });

  // ── Owner 2026-09-08: Qwen3-Embedding-8B "returns 4096-dimensional vectors" ──

  it('embeddings probe: 4096 native dims → says whether the server IGNORED or REJECTED `dimensions`, and names every fix', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'Qwen3-Embedding-8B' });
    // (a) server IGNORES the param — 200 with the native size.
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ embedding: new Array(4096).fill(0.1) }] } } as any);
    const ignored = await testModelRole('embeddings', 'my-ollama:Qwen3-Embedding-8B');
    expect(ignored.ok).toBe(false);
    expect(ignored.error).toMatch(/IGNORED the `dimensions` request[\s\S]*4096/);
    expect(ignored.error).toContain('flag it "MRL"');
    expect(ignored.error).toContain('is_matryoshka');
    // (b) server REJECTS the param (vLLM without is_matryoshka) — 400, retry without → native size.
    mockedAxios.post
      .mockRejectedValueOnce({ response: { status: 400, statusText: 'Bad Request', data: { error: { message: 'Model does not support matryoshka representation, changing output dimensions will lead to poor results' } } }, message: 'Request failed with status code 400' })
      .mockResolvedValueOnce({ data: { data: [{ embedding: new Array(4096).fill(0.1) }] } } as any);
    const rejected = await testModelRole('embeddings', 'my-ollama:Qwen3-Embedding-8B');
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/REJECTED the OpenAI `dimensions` parameter/);
    expect(rejected.error).toContain('does not support matryoshka'); // the server's own words, surfaced
    expect(rejected.error).toContain('4096');
  });

  it('embeddings probe: a model FLAGGED matryoshka passes with client-side truncation, mirroring the runtime', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'Qwen3-Embedding-8B', matryoshka: true });
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ embedding: new Array(4096).fill(0.1) }] } } as any);
    const r = await testModelRole('embeddings', 'my-ollama:Qwen3-Embedding-8B');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('native 4096');
    expect(r.detail).toContain('truncated to 1536');
    // …and so does SAVE (same probe).
    mockedAxios.post.mockResolvedValueOnce({ data: { data: [{ embedding: new Array(4096).fill(0.1) }] } } as any);
    await expect(updateModelRoles({ embeddings: 'my-ollama:Qwen3-Embedding-8B' })).resolves.toBeTruthy();
  });

  it('NON-STREAMING seats (coding_helper, utility) are probed with the real non-streaming shape; an empty answer names the "no-think" fix', async () => {
    mockResolveRegistryModel.mockResolvedValue(REG);
    mockResolveProviderForRun.mockResolvedValue({
      url: REG.url, apiKey: REG.apiKey, model: REG.model, label: 'my-ollama (custom endpoint)', extra: {},
    });
    // A default-thinking model: content empty, reasoning present, budget exhausted.
    mockedAxios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }] } } as any);
    const empty = await testModelRole('coding_helper', 'my-ollama:qwen3:32b');
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('spent the budget thinking');
    expect(empty.error).toContain('"no-think"');
    const sent = mockedAxios.post.mock.calls[0][1] as any;
    expect(sent.stream).toBeUndefined();          // NOT the streaming first-chunk probe
    expect(sent.max_tokens).toBe(256);
    // A healthy fast model answers.
    mockedAxios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } } as any);
    const ok = await testModelRole('utility', 'my-ollama:qwen3:32b');
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain('non-streaming completion OK');
  });

  it('rerank probe: ok on a Cohere-style results shape, shape mismatch fails', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'bge-reranker' });
    mockedAxios.post.mockResolvedValueOnce({ data: { results: [{ index: 0, relevance_score: 0.9 }] } } as any);
    expect((await testModelRole('rerank', 'my-ollama:bge-reranker')).ok).toBe(true);
    mockedAxios.post.mockResolvedValueOnce({ data: { scores: [0.5] } } as any);
    const bad = await testModelRole('rerank', 'my-ollama:bge-reranker');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Cohere-style');
  });

  // ── ASR seat (owner ask 2026-09-13: "switch asr model on the custom
  //    endpoints ui page … test other STT asr models") ──

  it('asr is a NON-CHAT role: any resolving registry spec saves, built-in ids are rejected', async () => {
    // Like rerank, saving an asr override does NOT probe (the save-time
    // dimension gate is embeddings-only) — only built-in ids are rejected.
    await expect(updateModelRoles({ asr: 'whisper-1' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedAxios.post).not.toHaveBeenCalled();
    statefulStore();
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'parakeet-tdt-0.6b-v3' });
    const roles = await updateModelRoles({ asr: 'my-ollama:parakeet-tdt-0.6b-v3' });
    expect(mockedAxios.post).not.toHaveBeenCalled(); // save never probes asr
    expect(mockStorePut).toHaveBeenCalledWith(['instance', 'model-roles'], 'config',
      { roles: { asr: 'my-ollama:parakeet-tdt-0.6b-v3' }, fallbacks: {} });
    expect(roles.find(r => r.key === 'asr')).toMatchObject({
      override: 'my-ollama:parakeet-tdt-0.6b-v3', effective: 'my-ollama:parakeet-tdt-0.6b-v3', resolves: true,
    });
  });

  it('asr probe: an override POSTs a valid silent WAV to the registry /audio/transcriptions and passes on any 2xx', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'parakeet-tdt-0.6b-v3' });
    mockedAxios.post.mockResolvedValueOnce({ data: '' } as any);
    const r = await testModelRole('asr', 'my-ollama:parakeet-tdt-0.6b-v3');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('empty transcript');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://10.0.0.5:11434/v1/audio/transcriptions',
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-registry-secret' }) }),
    );
    // The multipart body carries a REAL WAV file part (0.5s 16kHz mono
    // silence: 44-byte RIFF header + 16000 zero bytes) + the model field.
    const form = mockedAxios.post.mock.calls[0][1] as any;
    const body = form.getBuffer().toString('binary');
    const riffAt = body.indexOf('RIFF');
    expect(riffAt).toBeGreaterThan(0); // inside the file part, after the boundary
    expect(body.slice(riffAt + 8, riffAt + 12)).toBe('WAVE');
    expect(body).toContain('name="model"');
    expect(body).toContain('parakeet-tdt-0.6b-v3');
    expect(body).toContain(`name="file"; filename="${ASR_PROBE_WAV_FILENAME}"`);
    // The WAV data block is all zeros (silence) and full-length — the envelope
    // is strictly bigger than the 16044-byte WAV it carries.
    expect(body).toContain('\u0000'.repeat(100));
    expect(form.getBuffer().length).toBeGreaterThan(44 + 16000);
  });

  it('asr probe: a returned text snippet is surfaced; an HTTP error fails key-scrubbed', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'whisper-large-v3' });
    mockedAxios.post.mockResolvedValueOnce({ data: ' hello world ' } as any);
    const ok = await testModelRole('asr', 'my-ollama:whisper-large-v3');
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain('"hello world"');
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 401, statusText: 'Unauthorized', data: { error: 'bad key sk-registry-secret' } },
      message: 'Request failed with status code 401',
    } as any);
    const bad = await testModelRole('asr', 'my-ollama:whisper-large-v3');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('HTTP 401');
    expect(bad.error).not.toContain('sk-registry-secret');
  });

  it('asr probe: the "" built-in default probes the env chain legs (STT_BASE_URL leg, else DashScope qwen3-asr-flash), and 400s when neither can serve', async () => {
    const prevStt = process.env.STT_BASE_URL;
    const prevDash = process.env.DASHSCOPE_API_KEY;
    const prevSttModel = process.env.STT_MODEL;
    const prevSttKey = process.env.STT_API_KEY;
    delete process.env.STT_BASE_URL;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      // Keyless box, no self-hosted STT → the built-in chain cannot serve.
      await expect(testModelRole('asr', '')).rejects.toMatchObject({ statusCode: 400 });
      expect(mockedAxios.post).not.toHaveBeenCalled();
      // Self-hosted STT configured → the probe posts there with STT_MODEL.
      process.env.STT_BASE_URL = 'http://localhost:5092/v1';
      process.env.STT_MODEL = 'parakeet-tdt-0.6b-v3';
      process.env.STT_API_KEY = 'digby-local-stt';
      mockedAxios.post.mockResolvedValueOnce({ data: { text: '' } } as any);
      const r = await testModelRole('asr', '');
      expect(r.ok).toBe(true);
      expect(r.target).toContain('localhost:5092');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://localhost:5092/v1/audio/transcriptions',
        expect.anything(),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer digby-local-stt' }) }),
      );
      // No self-hosted STT but a DashScope key → the qwen3-asr-flash leg, through
      // the runtime's own client (speech.ts — OpenAI-compatible chat route,
      // audio inline as an input_audio data URI).
      delete process.env.STT_BASE_URL;
      process.env.DASHSCOPE_API_KEY = 'sk-dash';
      mockedAxios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: '' } }] } } as any);
      const r2 = await testModelRole('asr', '');
      expect(r2.ok).toBe(true);
      expect(r2.target).toContain('qwen3-asr-flash');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
        expect.objectContaining({ model: 'qwen3-asr-flash' }),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-dash' }) }),
      );
    } finally {
      if (prevStt !== undefined) process.env.STT_BASE_URL = prevStt; else delete process.env.STT_BASE_URL;
      if (prevDash !== undefined) process.env.DASHSCOPE_API_KEY = prevDash; else delete process.env.DASHSCOPE_API_KEY;
      if (prevSttModel !== undefined) process.env.STT_MODEL = prevSttModel; else delete process.env.STT_MODEL;
      if (prevSttKey !== undefined) process.env.STT_API_KEY = prevSttKey; else delete process.env.STT_API_KEY;
    }
  });

  it('buildAsrProbeWav produces a well-formed 16kHz mono 16-bit PCM WAV', () => {
    const wav = buildAsrProbeWav();
    expect(wav.length).toBe(44 + 16000);
    expect(wav.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.slice(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt16LE(22)).toBe(1);     // mono
    expect(wav.readUInt16LE(34)).toBe(16);    // bits per sample
    expect(wav.slice(44).every(b => b === 0)).toBe(true); // silence
  });

  it('built-in embeddings/rerank default needs DASHSCOPE_API_KEY', async () => {
    const prev = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      await expect(testModelRole('embeddings', '')).rejects.toMatchObject({ statusCode: 400 });
    } finally {
      if (prev !== undefined) process.env.DASHSCOPE_API_KEY = prev;
    }
  });

  it('chat probe: resolves the provider, streams to the first chunk, reports ok', async () => {
    mockResolveRegistryModel.mockResolvedValue(REG); // save-time validation passes
    mockResolveProviderForRun.mockResolvedValueOnce({
      url: REG.url, apiKey: REG.apiKey, model: REG.model,
      label: 'my-ollama (custom endpoint)', extra: {},
    });
    const stream: any = new EventEmitter();
    stream.destroy = jest.fn();
    mockedAxios.post.mockImplementationOnce(async () => {
      setTimeout(() => stream.emit('data', Buffer.from('data: {}')), 5);
      return { data: stream } as any;
    });
    const r = await testModelRole('chat_orchestrator', 'my-ollama:qwen3:32b');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('first tokens');
  });

  it('chat probe: a colon spec that silently fell back to built-ins is surfaced, not masked', async () => {
    // Save-time validation passes (registry row exists)…
    mockResolveRegistryModel.mockResolvedValue(REG);
    // …but the run-path resolution falls back (e.g. row disabled between calls).
    mockResolveProviderForRun.mockResolvedValueOnce({
      url: 'https://api.z.ai/api/paas/v4/chat/completions', apiKey: undefined,
      model: 'glm-5.2', label: 'ZAI direct', extra: {},
    });
    const r = await testModelRole('chat_orchestrator', 'my-ollama:qwen3:32b');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no longer resolves');
  });

  it('chat probe: provider 401 comes back key-scrubbed', async () => {
    mockResolveRegistryModel.mockResolvedValue(REG); // save-time validation passes
    mockResolveProviderForRun.mockResolvedValueOnce({
      url: REG.url, apiKey: REG.apiKey, model: REG.model,
      label: 'my-ollama (custom endpoint)', extra: {},
    });
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 401, statusText: 'Unauthorized', data: { error: `bad key sk-registry-secret` } },
      message: 'Request failed with status code 401',
    });
    const r = await testModelRole('double_checker', 'my-ollama:qwen3:32b');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('HTTP 401');
    expect(r.error).not.toContain('sk-registry-secret');
  });

  it('scrub redacts BEFORE truncation and covers echoed Bearer headers (no partial-key leak)', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'nomic-embed' });
    // A body where the key sits astride the 200-char slice point, echoed inside
    // an Authorization header the server reflected back.
    const padding = 'x'.repeat(190);
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 400, statusText: 'Bad Request', data: { detail: `${padding} Authorization: Bearer sk-registry-secret rejected` } },
      message: 'Request failed with status code 400',
    });
    const r = await testModelRole('embeddings', 'my-ollama:nomic-embed');
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('sk-registry');
    expect(r.error).not.toContain('registry-secret');
  });

  it('chat probe: an empty 200 stream (end with zero data) is a FAILURE, not ok', async () => {
    mockResolveRegistryModel.mockResolvedValue(REG);
    mockResolveProviderForRun.mockResolvedValueOnce({
      url: REG.url, apiKey: REG.apiKey, model: REG.model,
      label: 'my-ollama (custom endpoint)', extra: {},
    });
    const stream: any = new EventEmitter();
    stream.destroy = jest.fn();
    mockedAxios.post.mockImplementationOnce(async () => {
      setTimeout(() => stream.emit('end'), 5);
      return { data: stream } as any;
    });
    const r = await testModelRole('chat_orchestrator', 'my-ollama:qwen3:32b');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('empty 200');
  });

  it("utility with no override probes the built-in chain's live leg", async () => {
    const prev = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-ds';
    try {
      mockResolveProviderForRun.mockResolvedValueOnce({
        url: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-ds',
        model: 'deepseek-flash', label: 'DeepSeek direct', extra: { reasoning_effort: 'max', thinking: { type: 'enabled' } },
      });
      // Utility is a NON-STREAMING seat (2026-09-08): the probe now posts the
      // real non-streaming shape and reads choices[0].message.content.
      mockedAxios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } } as any);
      const r = await testModelRole('utility', '');
      expect(r.ok).toBe(true);
      expect(r.detail).toContain('non-streaming completion OK');
      expect(r.target).toContain('deepseek-flash');
      expect(mockResolveProviderForRun).toHaveBeenCalledWith('deepseek-flash');
      const posted = mockedAxios.post.mock.calls[0][1] as any;
      expect(posted.stream).toBeUndefined();
      // The probe exercises the REAL fast-seat shape: DeepSeek's thinking is
      // switched off and the agent-seat reasoning_effort is not forwarded
      // (V4.1 Flash thinks by default — helper-completion, 2026-09-10).
      expect(posted.thinking).toEqual({ type: 'disabled' });
      expect(posted.reasoning_effort).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
      else delete process.env.DEEPSEEK_API_KEY;
    }
  });
});

// ── Per-role worker seats (harness roadmap item 4, owner-approved 2026-09-19) ──
describe('worker seats: coding_reviewer / coding_architect / coding_explorer', () => {
  beforeEach(() => { mockStoreGet.mockResolvedValue(null); clearModelRoleCache(); });

  it('the Reviewer seat FOLLOWS the Double Checker (independent review by default); the other two are follow-session and resolve to "" when unset', async () => {
    expect(await resolveRoleModel('coding_reviewer')).toBe('deepseek-flash');
    expect(roleDefaultModel('coding_reviewer', {})).toBe('deepseek-flash');
    mockStoreGet.mockResolvedValue({ roles: { double_checker: 'glm-5.3' } });
    clearModelRoleCache();
    expect(await resolveRoleModel('coding_reviewer')).toBe('glm-5.3');
    mockStoreGet.mockResolvedValue({ roles: { double_checker: 'glm-5.3', coding_reviewer: 'kimi-k3' } });
    clearModelRoleCache();
    expect(await resolveRoleModel('coding_reviewer')).toBe('kimi-k3'); // an explicit seat model wins over inheritance
    for (const k of ['coding_architect', 'coding_explorer'] as const) {
      expect(MODEL_ROLES.find(r => r.key === k)).toMatchObject({ defaultModel: '', followsSession: true, fallbackable: false });
      expect(roleDefaultModel(k, {})).toBe('');
    }
    expect(await resolveRoleModel('coding_architect')).toBe('');
  });

  it('listModelRoles: a follow-session seat is SERVABLE when unset (it has no model of its own); the Reviewer view carries the resolved parent', async () => {
    const roles = await listModelRoles();
    expect(roles.find(r => r.key === 'coding_architect')).toMatchObject({ defaultModel: '', effective: '', servable: true, followsSession: true });
    expect(roles.find(r => r.key === 'coding_explorer')).toMatchObject({ defaultModel: '', effective: '', servable: true });
    expect(roles.find(r => r.key === 'coding_reviewer')).toMatchObject({ inheritsFrom: 'double_checker', defaultModel: 'deepseek-flash', effective: 'deepseek-flash', override: null });
  });
});

// ── Image generator seat (owner 2026-09-24: "add image generation model and
//    admin endpoint and defaults to generate images") — runtime image-generate.ts ──
describe('Image generator seat (2026-09-24)', () => {
  const REG_IMAGE = { ...REG, coding: false, model: 'sdxl', label: 'my-comfy', baseUrl: 'http://10.0.0.5:8188/v1', image: true as const };
  const ENV = ['DASHSCOPE_API_KEY', 'ZAI_API_KEY'] as const;
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    mockStoreGet.mockResolvedValue(null);
    clearModelRoleCache();
  });
  afterEach(() => {
    for (const k of ENV) { if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; else delete process.env[k]; }
  });

  it('09a03aef: seat-save WARNINGS — an [image] model whose measured Detect latency implies > its chain timeout at chat sizes saves successfully but carries an advisory line; a raised per-entry imageTimeoutMs or no measured latency = no warning', async () => {
    statefulStore();
    // The incident's measured shape: image_generation detected OK at
    // 48.8 s (512x512), no per-entry imageTimeoutMs => 120 s stock chain
    // timeout => ~190 s at portrait scale — the seat would silently serve a
    // built-in on every real generate.
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    // 09a03aef (review): the real Detect row shape is { ok, value, evidence,
    // latencyMs, at } (capability-detect.ts row()) — 'supported' does not
    // exist. A FAILED probe (ok:true, value:false) has a latency too — it
    // must NOT warn (there is nothing to scale; the probe itself failed).
    mockResolveRegistryModelEntry.mockResolvedValue({
      id: 'sdxl', image: true,
      capabilities: { results: [{ capability: 'image_generation', ok: true, value: true, evidence: 'ok', latencyMs: 48_800, at: '2026-10-24T00:00:00.000Z' }] },
    });
    const warnings: string[] = [];
    await updateModelRoles({ image_generate: 'my-comfy:sdxl' }, undefined, { warnings });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('my-comfy:sdxl');
    expect(warnings[0]).toContain('Image generator');
    expect(warnings[0]).toContain('HEADS-UP');
    expect(warnings[0]).toContain('imageTimeoutMs');
    // The save still proceeded (advisory, never a refusal) — the override is set.
    expect(mockStorePut).toHaveBeenCalledWith(['instance', 'model-roles'], 'config', { roles: { image_generate: 'my-comfy:sdxl' }, fallbacks: {} });
    // (1b) A Detect row whose image probe FAILED (ok:true, value:false) carries
    // a latency but no verdict to scale — no warning from it.
    mockResolveRegistryModelEntry.mockResolvedValue({
      id: 'sdxl', image: true,
      capabilities: { results: [{ capability: 'image_generation', ok: true, value: false, evidence: 'failed', latencyMs: 180_000, at: '2026-10-24T00:00:00.000Z' }] },
    });
    const failedProbe: string[] = [];
    await updateModelRoles({ image_generate: 'my-comfy:sdxl' }, undefined, { warnings: failedProbe });
    expect(failedProbe).toEqual([]);
    // (2) The owner-side unblock applied: a raised per-entry imageTimeoutMs
    // absorbs the projected latency — no warning.
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, imageTimeoutMs: 600_000 });
    mockResolveRegistryModelEntry.mockResolvedValue({
      id: 'sdxl', image: true,
      capabilities: { results: [{ capability: 'image_generation', ok: true, value: true, evidence: 'ok', latencyMs: 48_800, at: '2026-10-24T00:00:00.000Z' }] },
    });
    const quiet: string[] = [];
    await updateModelRoles({ image_generate: 'my-comfy:sdxl' }, undefined, { warnings: quiet });
    expect(quiet).toEqual([]);
    // (3) No measured Detect latency yet (a fresh entry) — nothing to warn
    // from; the save is clean.
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockResolveRegistryModelEntry.mockResolvedValue({ id: 'sdxl', image: true });
    const fresh: string[] = [];
    await updateModelRoles({ image_generate: 'my-comfy:sdxl' }, undefined, { warnings: fresh });
    expect(fresh).toEqual([]);
  });

  it('is its own seat class: IMAGE_ROLES = {image_generate}, builtInOptions = the six image ids, NON_CHAT_ROLES unchanged, chat ids never offered', () => {
    expect([...IMAGE_ROLES]).toEqual(['image_generate']);
    expect(IMAGE_BUILT_IN_OPTIONS).toEqual(['qwen-image-3.0', 'qwen-image-2.0', 'z-image-turbo', 'wan2.7-image', 'glm-image', 'cogview-4-250304']);
    expect(builtInOptionsFor('image_generate')).toEqual([...IMAGE_BUILT_IN_OPTIONS]);
    expect([...NON_CHAT_ROLES].sort()).toEqual(['asr', 'embeddings', 'rerank', 'tts']);
    for (const id of IMAGE_BUILT_IN_OPTIONS) expect(BUILT_IN_MODEL_IDS.has(id)).toBe(false); // image ids are NOT chat built-ins
    // Drift guard against the runtime table (image-generate.ts IMAGE_BUILT_INS).
    const { IMAGE_BUILT_INS, IMAGE_DEFAULT_MODEL } = jest.requireActual('../image-generate');
    expect(Object.keys(IMAGE_BUILT_INS)).toEqual([...IMAGE_BUILT_IN_OPTIONS]);
    expect(MODEL_ROLES.find(r => r.key === 'image_generate')).toMatchObject({ persona: 'Image generator', defaultModel: IMAGE_DEFAULT_MODEL, fallbackable: true });
    expect(SEAT_PERSONAS.image_generate).toBe('Image generator');
  });

  it('assertAssignable: a built-in image id saves; a chat id is "not offered"; a registry spec needs the [image] flag; asFallback follows the same rule', async () => {
    statefulStore();
    const roles = await updateModelRoles({ image_generate: 'glm-image' });
    expect(mockStorePut).toHaveBeenCalledWith(['instance', 'model-roles'], 'config', { roles: { image_generate: 'glm-image' }, fallbacks: {} });
    expect(roles.find(r => r.key === 'image_generate')).toMatchObject({ override: 'glm-image', effective: 'glm-image', builtInOptions: [...IMAGE_BUILT_IN_OPTIONS] });
    await expect(updateModelRoles({ image_generate: 'kimi-k3' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not offered for the "Image generator" seat') });
    await expect(updateModelRoles({ image_generate: 'dall-e-3' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('flagged [image]') });
    mockResolveRegistryModel.mockResolvedValue(null);
    await expect(updateModelRoles({ image_generate: 'ghost:sdxl' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('does not resolve') });
    mockResolveRegistryModel.mockResolvedValue({ ...REG_IMAGE, image: undefined });
    await expect(updateModelRoles({ image_generate: 'my-comfy:sdxl' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('image toggle') });
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    const saved = await updateModelRoles({ image_generate: 'my-comfy:sdxl' });
    expect(saved.find(r => r.key === 'image_generate')).toMatchObject({ override: 'my-comfy:sdxl', resolves: true });
    // Custom fallback slot: a built-in image id is fine (unlike the utility seat); a chat id is not; equal-to-effective is refused.
    await updateModelRoles({}, undefined, { fallbacks: { image_generate: 'z-image-turbo' } });
    expect(await resolveRoleFallback('image_generate')).toBe('z-image-turbo');
    await expect(updateModelRoles({}, undefined, { fallbacks: { image_generate: 'glm-5.3' } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateModelRoles({}, undefined, { fallbacks: { image_generate: 'my-comfy:sdxl' } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('same model the seat already runs') });
    expect(mockedAxios.post).not.toHaveBeenCalled(); // saving an image seat never probes
  });

  it('servability badges the exact env var per built-in (DashScope default, Z.AI override); a registry spec is servable keyless', async () => {
    let roles = await listModelRoles();
    expect(roles.find(r => r.key === 'image_generate')).toMatchObject({ servable: false, missingEnvKey: 'DASHSCOPE_API_KEY', unservableReason: expect.stringContaining('qwen-image-3.0') });
    process.env.DASHSCOPE_API_KEY = 'sk-d';
    clearModelRoleCache();
    roles = await listModelRoles();
    expect(roles.find(r => r.key === 'image_generate')).toMatchObject({ servable: true });
    mockStoreGet.mockResolvedValue({ roles: { image_generate: 'glm-image' } });
    clearModelRoleCache();
    roles = await listModelRoles();
    expect(roles.find(r => r.key === 'image_generate')).toMatchObject({ servable: false, missingEnvKey: 'ZAI_API_KEY', effective: 'glm-image' });
    mockStoreGet.mockResolvedValue({ roles: { image_generate: 'my-comfy:sdxl' } });
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    clearModelRoleCache();
    roles = await listModelRoles();
    expect(roles.find(r => r.key === 'image_generate')).toMatchObject({ servable: true, resolves: true });
    expect(mockSeatServability).not.toHaveBeenCalledWith(expect.stringMatching(/image|glm-image|sdxl/)); // never the coding-model resolver
  });

  it('testModelRole("image_generate") dispatches to probeImageGenerate with the pinned spec + the 55 s budget and returns the thumbnail; keyless built-ins 400', async () => {
    process.env.ZAI_API_KEY = 'id.secret';
    mockProbeImageGenerate.mockResolvedValue({ ok: true, latencyMs: 8_100, detail: 'cogview-4-250304 OK — 512×512 image/jpeg, 41,203 bytes (zai, 8.1s)', image: { mediaType: 'image/jpeg', data: 'AAAA' } });
    const r = await testModelRole('image_generate', 'cogview-4-250304');
    expect(mockProbeImageGenerate).toHaveBeenCalledWith('cogview-4-250304', 180_000); // 61d33af9: budget raised 55 s → 180 s
    expect(r).toEqual({ ok: true, target: 'cogview-4-250304', latencyMs: 8_100, detail: expect.stringContaining('cogview-4-250304 OK'), image: { mediaType: 'image/jpeg', data: 'AAAA' } });
    // '' = the seat default (qwen-image-3.0) — keyless here → a 400 naming the variable, no probe.
    mockProbeImageGenerate.mockClear();
    await expect(testModelRole('image_generate', '')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('DASHSCOPE_API_KEY') });
    expect(mockProbeImageGenerate).not.toHaveBeenCalled();
    process.env.DASHSCOPE_API_KEY = 'sk-d';
    mockProbeImageGenerate.mockResolvedValue({ ok: false, latencyMs: 300, detail: 'HTTP 401 — {"code":"InvalidApiKey"}' });
    const bad = await testModelRole('image_generate', '');
    expect(bad).toEqual({ ok: false, target: 'built-in default (qwen-image-3.0)', latencyMs: 300, error: expect.stringContaining('HTTP 401') });
    expect(mockProbeImageGenerate).toHaveBeenCalledWith('qwen-image-3.0', 180_000);
    // A registry spec probes through the same runtime client (its key lives in the registry).
    mockResolveRegistryModel.mockResolvedValue(REG_IMAGE);
    mockProbeImageGenerate.mockResolvedValue({ ok: true, latencyMs: 2_000, detail: 'sdxl OK — 512×512 image/png, 9,000 bytes (custom, 2.0s)', image: { mediaType: 'image/png', data: 'BBBB' } });
    const custom = await testModelRole('image_generate', 'my-comfy:sdxl');
    expect(custom).toMatchObject({ ok: true, target: 'my-comfy:sdxl', image: { mediaType: 'image/png' } });
    expect(mockProbeImageGenerate).toHaveBeenLastCalledWith('my-comfy:sdxl', 180_000);
  });

  it('the image Test ALWAYS answers: a probe that outlives the 180 s budget + the grace is a typed failure, not a hung request (hard cap, review 2026-09-24; budget raised 55 s → 180 s by ticket 61d33af9)', async () => {
    const savedZai = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = 'id.secret';
    jest.useFakeTimers();
    try {
      expect(IMAGE_PROBE_HARD_CAP_GRACE_MS).toBe(5_000);
      mockProbeImageGenerate.mockReturnValue(new Promise(() => { /* never settles — a provider still running */ }));
      const pending = testModelRole('image_generate', 'glm-image');
      for (let i = 0; i < 20; i++) await Promise.resolve(); // let the dispatch reach the image branch
      await jest.advanceTimersByTimeAsync(180_000 + IMAGE_PROBE_HARD_CAP_GRACE_MS + 10);
      const r = await pending;
      expect(r).toMatchObject({ ok: false, target: 'glm-image', error: expect.stringContaining('did not finish within 185 s') });
      expect(r).not.toHaveProperty('image');
      expect(mockProbeImageGenerate).toHaveBeenCalledWith('glm-image', 180_000);
    } finally {
      jest.useRealTimers();
      if (savedZai === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = savedZai;
    }
  });

  it('the model map lists image_chain + the six image built-ins (kind image, provider key presence) and the provider-key panel names the image models', async () => {
    const chain = listFixedChains().find(c => c.key === 'image_chain');
    expect(chain).toBeDefined();
    expect(chain!.seats).toEqual(['Image generator']);
    expect(chain!.envKeys).toEqual(expect.arrayContaining(['DASHSCOPE_API_KEY', 'ZAI_API_KEY']));
    expect(chain!.steps.join(' ')).toMatch(/z-image-turbo.*glm-image.*cogview-4-250304/);
    process.env.DASHSCOPE_API_KEY = 'sk-d';
    const info = await listBuiltInModelInfo();
    const imageRows = info.filter(m => m.kind === 'image');
    expect(imageRows.map(m => m.id)).toEqual([...IMAGE_BUILT_IN_OPTIONS]);
    expect(info.filter(m => m.kind === 'chat').map(m => m.id).sort()).toEqual([...BUILT_IN_MODEL_IDS].sort());
    expect(imageRows.find(m => m.id === 'qwen-image-3.0')).toMatchObject({ envKey: 'DASHSCOPE_API_KEY', present: true, mustStream: false, defaultFor: ['Image generator'], params: expect.stringContaining('prompt_extend off') });
    expect(imageRows.find(m => m.id === 'glm-image')).toMatchObject({ envKey: 'ZAI_API_KEY', present: false, params: expect.stringContaining('/images/generations') });
    const keys = listProviderKeyStatus();
    expect(keys.find(k => k.envKey === 'DASHSCOPE_API_KEY')!.serves.join(' ')).toContain('qwen-image-3.0 (Image generator default)');
    expect(keys.find(k => k.envKey === 'ZAI_API_KEY')!.serves.join(' ')).toContain('glm-image');
    expect(JSON.stringify(keys)).not.toContain('sk-d');
  });
});

// ── Open-weight decision-model plan D/F (2026-09-26): the decision seat's rule
// as an exported helper + the per-purpose effective primary accessor ─────────
describe('assertDecisionSpecAssignable + effectivePrimarySpec (plan D/F, 2026-09-26)', () => {
  const svc = () => require('./model-roles.service') as typeof import('./model-roles.service');

  it('assertDecisionSpecAssignable: the decision built-ins and "" pass; a chat built-in / bare id 400s naming the vocabulary; a registry spec passes only when it resolves', async () => {
    await expect(svc().assertDecisionSpecAssignable('jev')).resolves.toBeUndefined();
    await expect(svc().assertDecisionSpecAssignable('deepseek-flash')).resolves.toBeUndefined();
    await expect(svc().assertDecisionSpecAssignable('')).resolves.toBeUndefined();
    await expect(svc().assertDecisionSpecAssignable('kimi-k3')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not offered for the "Decision gate" seat') });
    mockResolveRegistryModel.mockResolvedValueOnce(null);
    await expect(svc().assertDecisionSpecAssignable('laya:typed-decisions')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('does not resolve') });
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, label: 'laya', model: 'typed-decisions', coding: false, providerShape: 'systemone' });
    await expect(svc().assertDecisionSpecAssignable('laya:typed-decisions')).resolves.toBeUndefined();
    // Laya follow-up (2026-09-26): a typed-decision model flagged on an openai_chat endpoint (prod cql-litellm:agx-laya) is assignable too.
    mockResolveRegistryModel.mockResolvedValueOnce({ ...REG, label: 'cql-litellm', model: 'agx-laya', coding: false, providerShape: 'openai_chat', decision: 'systemone_chat' });
    await expect(svc().assertDecisionSpecAssignable('cql-litellm:agx-laya')).resolves.toBeUndefined();
    // The seat save goes through the same rule (a non-[coding] registry model is fine here; a chat built-in is not).
    mockResolveRegistryModel.mockResolvedValue({ ...REG, label: 'laya', model: 'typed-decisions', coding: false, providerShape: 'systemone' });
    await expect(updateModelRoles({ decision: 'laya:typed-decisions' }, 'u1')).resolves.toBeTruthy();
    await expect(updateModelRoles({ decision: 'kimi-k3' }, 'u1')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('effectivePrimarySpec: the per-purpose primary from the backends row wins over the seat; no row / unknown purpose / store failure → the seat model', async () => {
    const { clearDecisionBackendsConfigCache } = require('../platform/decision-gate-backends') as typeof import('../platform/decision-gate-backends');
    try {
      mockStoreGet.mockImplementation(async (_ns: string[], key: string) => {
        if (key === 'config') return { roles: { decision: 'deepseek-flash' } };
        if (key === 'backends') return { purposes: { wake_triage: { primary: 'laya:typed-decisions' } } };
        return null;
      });
      clearDecisionBackendsConfigCache();
      expect(await svc().effectivePrimarySpec('wake_triage')).toBe('laya:typed-decisions');
      expect(await svc().effectivePrimarySpec('auto_route')).toBe('deepseek-flash');
      expect(await svc().effectivePrimarySpec('probe')).toBe('deepseek-flash');
      // A backends-row read failure is fail-open to the seat model (the roles row is cached).
      clearDecisionBackendsConfigCache();
      mockStoreGet.mockImplementation(async (_ns: string[], key: string) => { if (key === 'backends') throw new Error('db down'); return key === 'config' ? { roles: { decision: 'deepseek-flash' } } : null; });
      expect(await svc().effectivePrimarySpec('wake_triage')).toBe('deepseek-flash');
    } finally {
      clearDecisionBackendsConfigCache();
    }
  });
});

// ── Seat governance — the no-frontier doctrine OBSERVED at save / test time (audit E3, 2026-09-27; review fixer the same day) ──
// A custom endpoint carried no provider class, so the LiteLLM proxy model
// `api-anthropic-claude-fable-5-1` sat on the Project Supervisor seat with
// nothing on the admin page naming its class. That seat is the OWNER's setting
// (deliberately swapped there), so the fix is VISIBILITY: the registry
// resolution carries governanceClass:'frontier' (provider-class.ts), the view
// badges it, and assertAssignable writes ONE loop_metrics `seat_governance`
// row per governed attempt. The save goes ahead by default ('observed');
// refusal is OPT-IN (FRONTIER_SEATS_REFUSE=1) and even then a PROBE is never
// refused and an owner-confirmed card passes ('allowed_by_owner'). Coding /
// helper seats are not governed; the run path never consults it.
describe('seat governance — frontier-class registry models on chat / supervisor seats (audit E3)', () => {
  const FRONTIER_REG = { ...REG, url: 'https://llm.example.com/v1/chat/completions', baseUrl: 'https://llm.example.com/v1', model: 'api-anthropic-claude-fable-5-1', label: 'cql-litellm', governanceClass: 'frontier' as const };
  const SPEC = 'cql-litellm:api-anthropic-claude-fable-5-1';
  const prevFlag = process.env.FRONTIER_SEATS_REFUSE;
  /** recordSeatGovernance writes through a dynamic import — let the microtask settle. */
  const flush = () => new Promise<void>(r => setImmediate(r));
  const governanceRows = () => mockRecordLoopMetric.mock.calls.map(c => c[0]).filter((m: any) => m?.kind === 'seat_governance').map((m: any) => m.meta);
  /** A streaming agent-seat probe that reaches first tokens on the frontier spec. */
  const armFrontierProbe = () => {
    mockResolveProviderForRun.mockResolvedValueOnce({ url: FRONTIER_REG.url, apiKey: FRONTIER_REG.apiKey, model: FRONTIER_REG.model, label: 'cql-litellm (custom endpoint)', extra: {} });
    const stream: any = new EventEmitter();
    stream.destroy = jest.fn();
    mockedAxios.post.mockImplementationOnce(async () => {
      setTimeout(() => stream.emit('data', Buffer.from('data: {}')), 5);
      return { data: stream } as any;
    });
  };
  beforeEach(() => { delete process.env.FRONTIER_SEATS_REFUSE; mockRecordLoopMetric.mockClear(); });
  afterAll(() => { if (prevFlag === undefined) delete process.env.FRONTIER_SEATS_REFUSE; else process.env.FRONTIER_SEATS_REFUSE = prevFlag; });

  it('the governed set is exactly the chat lead, both supervisors and both checkers', () => {
    expect([...FRONTIER_GOVERNED_ROLES].sort()).toEqual(['chat_orchestrator', 'chat_quick', 'double_checker', 'project_supervisor', 'supervisor', 'triple_checker']);
    for (const k of FRONTIER_GOVERNED_ROLES) expect(isModelRoleKey(k)).toBe(true);
  });

  it('DEFAULT (observe-only; the effective auto-pick policy is open_only — frontier hard rule 2026-10-06 late; seats are not pickers): a frontier-class spec SAVES on every governed seat, the view badges it and says allowed, and ONE seat_governance {outcome:observed, probe:false} row is written per save', async () => {
    mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
    for (const key of FRONTIER_GOVERNED_ROLES) {
      statefulStore();
      mockRecordLoopMetric.mockClear();
      mockStorePut.mockClear();
      const roles = await updateModelRoles({ [key]: SPEC });
      expect(roles.find(r => r.key === key)).toMatchObject({ override: SPEC, resolves: true, providerClass: 'frontier', frontierSeatsAllowed: true });
      expect(mockStorePut).toHaveBeenCalledTimes(1);
      await flush();
      expect(governanceRows()).toEqual([{ role: key, spec: SPEC, slot: 'seat', outcome: 'observed', probe: false, policy: 'open_only' }]);
    }
  });

  it('DEFAULT: a frontier-class CUSTOM FALLBACK saves too, with a slot:fallback row', async () => {
    statefulStore();
    mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
    const roles = await updateModelRoles({}, undefined, { fallbacks: { project_supervisor: SPEC } });
    expect(roles.find(r => r.key === 'project_supervisor')).toMatchObject({ fallback: SPEC, fallbackResolves: true, fallbackProviderClass: 'frontier' });
    await flush();
    expect(governanceRows()).toEqual([{ role: 'project_supervisor', spec: SPEC, slot: 'fallback', outcome: 'observed', probe: false, policy: 'open_only' }]);
  });

  it('AUTO_PICK_FRONTIER_DISABLED=1 (roster 2026-10-06 C-1 kill switch): the policy reads open_only and the row is the pre-policy {outcome:observed}; the save still goes ahead', async () => {
    process.env.AUTO_PICK_FRONTIER_DISABLED = '1';
    try {
      statefulStore();
      mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
      const roles = await updateModelRoles({ supervisor: SPEC });
      expect(roles.find(r => r.key === 'supervisor')).toMatchObject({ override: SPEC, providerClass: 'frontier' });
      await flush();
      expect(governanceRows()).toEqual([{ role: 'supervisor', spec: SPEC, slot: 'seat', outcome: 'observed', probe: false, policy: 'open_only' }]);
    } finally { delete process.env.AUTO_PICK_FRONTIER_DISABLED; }
  });

  it('FRONTIER_SEATS_REFUSE=1 (opt-in): PUT refuses the spec on every governed seat and their fallbacks with the switch named; nothing is stored; one {outcome:refused} row each', async () => {
    process.env.FRONTIER_SEATS_REFUSE = '1';
    mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
    for (const key of FRONTIER_GOVERNED_ROLES) {
      await expect(updateModelRoles({ [key]: SPEC })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('frontier-class'),
      });
      await expect(updateModelRoles({ [key]: SPEC })).rejects.toMatchObject({ message: expect.stringContaining('FRONTIER_SEATS_REFUSE=1') });
    }
    await expect(updateModelRoles({}, undefined, { fallbacks: { project_supervisor: SPEC } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('frontier-class') });
    expect(mockStorePut).not.toHaveBeenCalled();
    await flush();
    const rows = governanceRows();
    expect(rows).toHaveLength(FRONTIER_GOVERNED_ROLES.size * 2 + 1);
    expect(rows.every((r: any) => r.outcome === 'refused' && r.probe === false)).toBe(true);
    expect(rows.at(-1)).toEqual({ role: 'project_supervisor', spec: SPEC, slot: 'fallback', outcome: 'refused', probe: false, policy: 'open_only' });
  });

  it('a PROBE is NEVER refused, even under FRONTIER_SEATS_REFUSE=1: the explicit-candidate tester runs and records {outcome:observed, probe:true}', async () => {
    process.env.FRONTIER_SEATS_REFUSE = '1';
    mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
    armFrontierProbe();
    const r = await testModelRole('supervisor', SPEC);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('first tokens');
    expect(mockResolveProviderForRun).toHaveBeenCalledWith(SPEC);
    await flush();
    expect(governanceRows()).toEqual([{ role: 'supervisor', spec: SPEC, slot: 'seat', outcome: 'observed', probe: true, policy: 'open_only' }]);
  });

  it('the NO-CANDIDATE tester (the admin Test button / in-loop test_model_role {role}) probes the owner\'s STORED frontier seat instead of answering a doctrine 400', async () => {
    process.env.FRONTIER_SEATS_REFUSE = '1';
    mockStoreGet.mockResolvedValue({ roles: { project_supervisor: SPEC } });
    mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
    armFrontierProbe();
    const r = await testModelRole('project_supervisor');
    expect(r.ok).toBe(true);
    expect(mockResolveProviderForRun).toHaveBeenCalledWith(SPEC);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockStorePut).not.toHaveBeenCalled();
    await flush();
    expect(governanceRows()).toEqual([{ role: 'project_supervisor', spec: SPEC, slot: 'seat', outcome: 'observed', probe: true, policy: 'open_only' }]);
  });

  it('the fallback-slot tester is a probe too (never refused)', async () => {
    process.env.FRONTIER_SEATS_REFUSE = '1';
    mockStoreGet.mockResolvedValue({ roles: {}, fallbacks: { double_checker: SPEC } });
    mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
    armFrontierProbe();
    const r = await testModelRole('double_checker', undefined, { fallback: true });
    expect(r.ok).toBe(true);
    await flush();
    expect(governanceRows()).toEqual([{ role: 'double_checker', spec: SPEC, slot: 'fallback', outcome: 'observed', probe: true, policy: 'open_only' }]);
  });

  it('under FRONTIER_SEATS_REFUSE=1 an OWNER-CONFIRMED write (the ASK-ONLY set_model_role_fallback card) passes with {outcome:allowed_by_owner}', async () => {
    process.env.FRONTIER_SEATS_REFUSE = '1';
    statefulStore();
    mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
    const roles = await updateModelRoles({}, 'admin-1', { fallbacks: { supervisor: SPEC }, ownerConfirmed: true });
    expect(roles.find(r => r.key === 'supervisor')).toMatchObject({ fallback: SPEC, fallbackProviderClass: 'frontier', frontierSeatsAllowed: false });
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    await flush();
    expect(governanceRows()).toEqual([{ role: 'supervisor', spec: SPEC, slot: 'fallback', outcome: 'allowed_by_owner', probe: false, policy: 'open_only' }]);
  });

  it('an open-class registry model on a governed seat saves exactly as before (no providerClass on the resolution) and writes NO governance row', async () => {
    statefulStore();
    mockResolveRegistryModel.mockResolvedValue(REG);
    const roles = await updateModelRoles({ project_supervisor: 'my-ollama:qwen3:32b' });
    const seat = roles.find(r => r.key === 'project_supervisor')!;
    expect(seat).toMatchObject({ override: 'my-ollama:qwen3:32b', resolves: true, frontierSeatsAllowed: true });
    expect(seat.providerClass).toBeUndefined();
    await flush();
    expect(governanceRows()).toEqual([]);
  });

  it('ungoverned seats (coding / helper / workers) accept a frontier-class [coding] spec with NO governance row — the finding scoped the fix to chat + supervisor turns', async () => {
    mockResolveRegistryModel.mockResolvedValue(FRONTIER_REG);
    for (const key of ['coding_default', 'coding_helper', 'coding_reviewer', 'coding_architect', 'coding_explorer'] as const) {
      expect(FRONTIER_GOVERNED_ROLES.has(key)).toBe(false);
      await expect(updateModelRoles({ [key]: SPEC })).resolves.toBeTruthy();
    }
    await flush();
    expect(governanceRows()).toEqual([]);
  });

  it('listModelRoles badges a seat ALREADY stored on a frontier-class model (present only when frontier) — and its fallback — without touching the store (the seat keeps serving)', async () => {
    mockStoreGet.mockResolvedValue({ roles: { project_supervisor: SPEC, double_checker: 'my-ollama:qwen3:32b' }, fallbacks: { chat_orchestrator: SPEC } });
    mockResolveRegistryModel.mockImplementation(async (spec: string) => spec === SPEC ? FRONTIER_REG : REG);
    const roles = await listModelRoles();
    const ps = roles.find(r => r.key === 'project_supervisor')!;
    expect(ps).toMatchObject({ effective: SPEC, resolves: true, providerClass: 'frontier', servable: true, frontierSeatsAllowed: true });
    expect(ps.fallbackProviderClass).toBeUndefined();
    const dc = roles.find(r => r.key === 'double_checker')!;
    expect(dc.providerClass).toBeUndefined();
    const lead = roles.find(r => r.key === 'chat_orchestrator')!;
    expect(lead).toMatchObject({ fallback: SPEC, fallbackResolves: true, fallbackProviderClass: 'frontier' });
    expect(lead.providerClass).toBeUndefined(); // the seat itself runs the built-in default
    // Built-in seats never carry the field.
    for (const r of roles) if (!r.override) expect(r.providerClass).toBeUndefined();
    expect(mockStorePut).not.toHaveBeenCalled();
    // A READ never writes governance telemetry.
    await flush();
    expect(governanceRows()).toEqual([]);
  });

  it('every view row carries frontierSeatsAllowed — true by default, false under FRONTIER_SEATS_REFUSE=1 (the badge title reads it)', async () => {
    for (const r of await listModelRoles()) expect(r.frontierSeatsAllowed).toBe(true);
    process.env.FRONTIER_SEATS_REFUSE = '1';
    for (const r of await listModelRoles()) expect(r.frontierSeatsAllowed).toBe(false);
  });
});


describe('scrubError — streamed error bodies (2026-09-29)', () => {
  it('uses the drained body cached on the error, never the raw stream object', () => {
    const stream = new EventEmitter() as any;
    stream._readableState = { highWaterMark: 16384 };
    const err: any = { response: { status: 429, statusText: 'Too Many Requests', data: stream } };
    expect(scrubError(err)).toBe('HTTP 429 Too Many Requests');
    err.digbyBody = '{"error":{"message":"No deployments available for selected model"}}';
    const out = scrubError(err);
    expect(out).toContain('No deployments available');
    expect(out).not.toContain('_readableState');
  });
  it('a plain JSON body is unchanged', () => {
    expect(scrubError({ response: { status: 400, data: { error: { message: 'bad' } } } })).toContain('"message":"bad"');
  });
});

// Ticket 902ea9c1-788c-4809-ae53-61c82abbb811 (2026-10-26): the TTS probe posts
// with responseType 'arraybuffer', so an upstream error body arrived as a Node
// Buffer and the admin tester rendered it as {"type":"Buffer","data":[123,34,…]}
// instead of the provider's actual JSON error text. Every byte-shaped body a
// probe can see decodes to text before redaction/slice.
describe('scrubError — byte error bodies decode to text (ticket 902ea9c1)', () => {
  const ERR_JSON = '{"error":{"message":"Internal server error","type":"server_error"}}';
  it('a Node Buffer body renders the decoded JSON error text, never the byte array', () => {
    const err = { response: { status: 500, data: Buffer.from(ERR_JSON, 'utf8') } };
    const out = scrubError(err);
    expect(out).toContain('HTTP 500');
    expect(out).toContain('Internal server error');
    expect(out).not.toContain('"type":"Buffer"');
    expect(out).not.toContain('[123,34');
  });
  it('Uint8Array and ArrayBuffer bodies decode the same way (browser-shaped arraybuffer)', () => {
    const enc = new TextEncoder().encode(ERR_JSON);
    expect(scrubError({ response: { status: 500, data: enc } })).toContain('Internal server error');
    const ab = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer;
    expect(scrubError({ response: { status: 500, data: ab } })).toContain('Internal server error');
  });
  it('a buffer echoed back as a plain {type:"Buffer"} JSON object also decodes', () => {
    const data = { type: 'Buffer', data: Array.from(Buffer.from(ERR_JSON, 'utf8')) };
    const out = scrubError({ response: { status: 500, data } });
    expect(out).toContain('Internal server error');
    expect(out).not.toContain('[123,34');
  });
  it('redaction still runs on the DECODED text (a key echoed inside the bytes is scrubbed)', () => {
    const leaky = `{"error":{"message":"bad key sk-registry-secret"}}`;
    const out = scrubError({ response: { status: 401, data: Buffer.from(leaky, 'utf8') } }, 'sk-registry-secret');
    expect(out).toContain('bad key');
    expect(out).not.toContain('sk-registry-secret');
  });
  it('a non-UTF8 binary body stays lossy-but-safe (no throw, no byte spam beyond the slice)', () => {
    const out = scrubError({ response: { status: 500, data: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]) } });
    expect(out).toContain('HTTP 500');
    expect(out).not.toContain('[255,254');
  });
});

// The TTS seat end-to-end: the probe posts {model,input,voice,response_format}
// to the registry entry's /audio/speech and its 500 must surface the provider's
// message (the owner's live repro: llm-cql:stanne-phonon-tts → HTTP 500).
describe('tts probe — upstream 500 renders the decoded error (ticket 902ea9c1)', () => {
  it('a Buffer error body surfaces the provider message, not the byte array', async () => {
    mockResolveRegistryModel.mockResolvedValue({ ...REG, coding: false, model: 'stanne-phonon-tts' });
    mockedAxios.post.mockRejectedValueOnce({
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        // The exact shape axios produces for responseType 'arraybuffer' in Node.
        data: Buffer.from('{"error":{"message":"Internal server error"}}', 'utf8'),
      },
      message: 'Request failed with status code 500',
    } as any);
    const r = await testModelRole('tts', 'my-ollama:stanne-phonon-tts');
    expect(r.ok).toBe(false);
    expect(r.target).toBe('my-ollama:stanne-phonon-tts');
    expect(r.error).toContain('HTTP 500');
    expect(r.error).toContain('Internal server error');
    expect(r.error).not.toContain('"type":"Buffer"');
    expect(r.error).not.toContain('[123,34');
    // The probe posts to the entry's /audio/speech with responseFormat mp3.
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://10.0.0.5:11434/v1/audio/speech',
      expect.objectContaining({ model: 'stanne-phonon-tts', input: 'Digby connection test.' }),
      expect.objectContaining({ responseType: 'arraybuffer' }),
    );
  });
});

describe('custom-endpoint probe budget (2026-10-07)', () => {
  const KEYS = ['ROLE_TEST_CUSTOM_TIMEOUT_MS', 'ROLE_TEST_CUSTOM_TIMEOUT_DISABLED'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('a custom endpoint spec gets 55 s, a built-in keeps 20 s', () => {
    expect(ROLE_TEST_TIMEOUT_MS).toBe(20_000);
    expect(roleTestTimeoutMs('cql-litellm:spark-mimo-v26-flash-rl')).toBe(55_000);
    expect(roleTestTimeoutMs('kimi-k3')).toBe(20_000);
    expect(roleTestTimeoutMs('')).toBe(20_000);
  });
  it('the env budget is clamped under the 60 s ALB idle timeout', () => {
    process.env.ROLE_TEST_CUSTOM_TIMEOUT_MS = '300000';
    expect(roleTestCustomTimeoutMs()).toBe(58_000);
    process.env.ROLE_TEST_CUSTOM_TIMEOUT_MS = '5000';
    expect(roleTestCustomTimeoutMs()).toBe(20_000);
    process.env.ROLE_TEST_CUSTOM_TIMEOUT_MS = '40000';
    expect(roleTestTimeoutMs('ep:m')).toBe(40_000);
  });
  it('ROLE_TEST_CUSTOM_TIMEOUT_DISABLED=1 restores 20 s everywhere', () => {
    process.env.ROLE_TEST_CUSTOM_TIMEOUT_DISABLED = '1';
    expect(roleTestTimeoutMs('ep:m')).toBe(20_000);
  });
  it('a timeout names the budget that applied and explains a cold start on the longer budget', () => {
    const err = { code: 'ECONNABORTED', message: 'timeout of 55000ms exceeded' };
    expect(scrubError(err)).toBe('Timed out after 20s');
    const long = scrubError(err, null, 55_000);
    expect(long).toContain('Timed out after 55s');
    expect(long).toContain('cold start');
  });
});

/**
 * Coding-model stamping precedence (owner ask 2026-09-04): the PROJECT-level
 * codingModel setting (side-panel picker, ProjectSettings) wins over the
 * user's pref; a stale project pick falls back to the pref (WARNed); nothing
 * valid → the instance coding_default seat. Also pins resolveOneCodingPick —
 * the shared validity contract used by the pref path, the project override,
 * and run-executor's run-time swap.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
// error-handler imports config/env (process.exit(1) without env vars in jest).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string) { super(message); }
  },
}));
jest.mock('../platform/folder-tree-ops', () => ({ __esModule: true, relocateFolderChildren: jest.fn() }));

const mockGetProjectSettings = jest.fn(async (): Promise<any> => ({ crossProjectMemory: false }));
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  getProjectSettings: (...a: any[]) => mockGetProjectSettings(...(a as [])),
}));

const mockResolveRegistryModel = jest.fn(async (): Promise<any> => null);
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...(a as [])),
}));

const mockResolveRoleModelForRun = jest.fn(async (_role: string, fallback: string) => fallback);
jest.mock('./coding-model', () => ({
  __esModule: true,
  resolveRoleModelForRun: (...a: any[]) => mockResolveRoleModelForRun(...(a as [string, string])),
}));

// Seats govern sessions (2026-09-28): a preference counts ONLY with the explicit
// marker in the context store (coding/seat-governance.ts). The store mock answers
// the marker lookup; `markExplicit` makes the CURRENT stored value a deliberate pick.
const explicitMarker: { model: string | null } = { model: null };
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (_ns: string[], key: string) => (key === 'codingModelExplicit' && explicitMarker.model ? { model: explicitMarker.model, at: 'x', via: 'settings' } : null)),
  storePut: jest.fn(async () => {}),
  storeDelete: jest.fn(async () => {}),
}));
const markExplicit = (model: string | null) => { explicitMarker.model = model; };

import { resolveStampedCodingModel, resolveStampedCodingModelDetailed, resolveOneCodingPick, projectCodingModel, projectCodingModelSource } from './coding-data.service';

beforeEach(() => {
  jest.clearAllMocks();
  markExplicit(null);
  delete process.env.SEAT_GOVERNS_SESSIONS_DISABLED;
  mockGetProjectSettings.mockResolvedValue({ crossProjectMemory: false });
  mockResolveRegistryModel.mockResolvedValue(null);
  mockResolveRoleModelForRun.mockImplementation(async (_r: string, f: string) => f);
});

describe('resolveOneCodingPick', () => {
  it('built-ins pass through; legacy ids alias forward', async () => {
    expect(await resolveOneCodingPick('glm-5.3', 'u1')).toBe('glm-5.3');
    expect(await resolveOneCodingPick('glm-5.2', 'u1')).toBe('glm-5.3');
    expect(await resolveOneCodingPick('kimi-k2.6', 'u1')).toBe('kimi-k3');
    // DeepSeek V4.1 Flash cutover (2026-09-10): the retired id aliases forward.
    expect(await resolveOneCodingPick('deepseek-v4-pro', 'u1')).toBe('deepseek-flash');
    expect(await resolveOneCodingPick('deepseek-flash', 'u1')).toBe('deepseek-flash');
  });

  it('a registry spec survives only while it resolves enabled + [coding]', async () => {
    mockResolveRegistryModel.mockResolvedValueOnce({ coding: true });
    expect(await resolveOneCodingPick('my-ollama:qwen3:32b', 'u1')).toBe('my-ollama:qwen3:32b');
    mockResolveRegistryModel.mockResolvedValueOnce({ coding: false });
    expect(await resolveOneCodingPick('my-ollama:qwen3:32b', 'u1')).toBeNull();
    mockResolveRegistryModel.mockResolvedValueOnce(null);
    expect(await resolveOneCodingPick('ghost:model', 'u1')).toBeNull();
  });

  it('garbage / empty picks are null', async () => {
    expect(await resolveOneCodingPick('', 'u1')).toBeNull();
    expect(await resolveOneCodingPick(undefined, 'u1')).toBeNull();
    expect(await resolveOneCodingPick('gpt-5.6-sol', 'u1')).toBeNull();
  });
});

describe('resolveStampedCodingModel precedence — seats govern sessions (2026-09-28): human project pick > EXPLICIT pref > coding_default seat', () => {
  it('a valid PROJECT pick beats an explicit user pref', async () => {
    mockGetProjectSettings.mockResolvedValue({ crossProjectMemory: false, codingModel: 'my-ollama:qwen3:32b' });
    mockResolveRegistryModel.mockResolvedValue({ coding: true });
    markExplicit('kimi-k3');
    expect(await resolveStampedCodingModel('kimi-k3', 'u1', 'p1')).toBe('my-ollama:qwen3:32b');
    expect(await resolveStampedCodingModelDetailed('kimi-k3', 'u1', 'p1')).toEqual({ model: 'my-ollama:qwen3:32b', source: 'project' });
    expect(mockGetProjectSettings).toHaveBeenCalledWith('p1');
  });

  it('a MACHINE-written project pick never shadows the seat (a human-set one does)', async () => {
    mockGetProjectSettings.mockResolvedValue({ crossProjectMemory: false, codingModel: 'kimi-k3', codingModelSource: 'machine' });
    mockResolveRoleModelForRun.mockResolvedValue('edge:seat');
    expect(await projectCodingModelSource('p1')).toBe('machine');
    expect(await resolveStampedCodingModelDetailed(null, 'u1', 'p1')).toEqual({ model: 'edge:seat', source: 'seat' });
    mockGetProjectSettings.mockResolvedValue({ crossProjectMemory: false, codingModel: 'kimi-k3', codingModelSource: 'user' });
    expect(await projectCodingModelSource('p1')).toBe('user');
    expect(await resolveStampedCodingModelDetailed(null, 'u1', 'p1')).toEqual({ model: 'kimi-k3', source: 'project' });
  });

  it('a STALE project pick falls back to an EXPLICIT pref; an unmarked pref does not count (the seat governs)', async () => {
    mockGetProjectSettings.mockResolvedValue({ crossProjectMemory: false, codingModel: 'ghost:model' });
    mockResolveRegistryModel.mockResolvedValue(null);
    markExplicit('kimi-k3');
    expect(await resolveStampedCodingModel('kimi-k3', 'u1', 'p1')).toBe('kimi-k3');
    markExplicit(null);
    mockResolveRoleModelForRun.mockResolvedValue('edge:seat');
    expect(await resolveStampedCodingModelDetailed('kimi-k3', 'u1', 'p1')).toEqual({ model: 'edge:seat', source: 'seat' });
  });

  it('no projectId → an explicit pref (legacy alias included); the default "glm-5.2" row is never a pick', async () => {
    markExplicit('deepseek-flash');
    expect(await resolveStampedCodingModel('deepseek-flash', 'u1')).toBe('deepseek-flash');
    // The schema default row every user carried — even a stray marker cannot make it a pick.
    markExplicit('glm-5.2');
    expect(await resolveStampedCodingModelDetailed('glm-5.2', 'u1')).toEqual({ model: 'glm-5.3', source: 'seat' });
  });

  it('nothing valid anywhere → the instance coding_default seat, resolved live', async () => {
    mockResolveRoleModelForRun.mockResolvedValueOnce('edge:local-model');
    expect(await resolveStampedCodingModel(null, 'u1', 'p1')).toBe('edge:local-model');
    expect(mockResolveRoleModelForRun).toHaveBeenCalledWith('coding_default', 'glm-5.3');
  });

  it('a project-settings failure is fail-open (an explicit pref still stamps)', async () => {
    mockGetProjectSettings.mockRejectedValue(new Error('store down'));
    markExplicit('deepseek-flash');
    expect(await resolveStampedCodingModel('deepseek-flash', 'u1', 'p1')).toBe('deepseek-flash');
    expect(await projectCodingModel('p1')).toBeNull();
    expect(await projectCodingModelSource('p1')).toBeNull();
  });

  it('SEAT_GOVERNS_SESSIONS_DISABLED=1 restores the pre-2026-09-28 chain: any resolvable pref is a pick, provenance ignored', async () => {
    process.env.SEAT_GOVERNS_SESSIONS_DISABLED = '1';
    expect(await resolveStampedCodingModelDetailed('kimi-k3', 'u1', 'p1')).toEqual({ model: 'kimi-k3', source: 'preference' });
    expect(await resolveStampedCodingModel('glm-5.2', 'u1')).toBe('glm-5.3');
    mockGetProjectSettings.mockResolvedValue({ crossProjectMemory: false, codingModel: 'deepseek-flash', codingModelSource: 'machine' });
    expect(await resolveStampedCodingModelDetailed('kimi-k3', 'u1', 'p1')).toEqual({ model: 'deepseek-flash', source: 'project' });
    mockGetProjectSettings.mockResolvedValue({ crossProjectMemory: false });
    mockResolveRoleModelForRun.mockResolvedValueOnce('edge:local-model');
    expect(await resolveStampedCodingModelDetailed(null, 'u1', 'p1')).toEqual({ model: 'edge:local-model', source: 'seat' });
  });
});

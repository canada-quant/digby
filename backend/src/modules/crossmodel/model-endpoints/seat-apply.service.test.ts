/**
 * "Apply seats to existing sessions" (seats govern sessions, 2026-09-28) —
 * model-endpoints/seat-apply.service.ts. Pins the classification of project
 * overrides (machine-written / legacy built-in → cleared; human-set / legacy
 * registry spec → kept), the session re-stamp (live rows with NULL provenance
 * and not on the seat; explicit picks and rows already on the seat left
 * alone), the read-only preference listing (explicit vs ignored), that a DRY
 * RUN writes nothing, that the applied run writes exactly the plan, the
 * loop_metrics `seat_apply` row + the Activity audit, and per-row fail-open.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const storeRows: Array<{ namespacePath: string; value: any }> = [];
const sessions: Array<{ id: string; projectId: string; model: string; modelSource: string | null; status: string }> = [];
const prefs: Array<{ userId: string; codingModel: string | null }> = [];
const mockSessionUpdate: jest.Mock = jest.fn(async ({ where, data }: any) => { const s = sessions.find(x => x.id === where.id)!; Object.assign(s, data); return s; });
const mockActivityCreate: jest.Mock = jest.fn(async () => ({}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    // Honours the service's filter (key 'state' + namespacePath endsWith ':settings') like Prisma would.
    contextStoreEntry: { findMany: jest.fn(async ({ where }: any) => storeRows.filter(r => (!where?.namespacePath?.endsWith || r.namespacePath.endsWith(where.namespacePath.endsWith))).map(r => ({ ...r }))) },
    chatCodingState: {
      findMany: jest.fn(async ({ where }: any) => sessions.filter(s => where.status.in.includes(s.status)).map(s => ({ id: s.id, projectId: s.projectId, model: s.model, modelSource: s.modelSource }))),
      update: (...a: any[]) => mockSessionUpdate(...a),
    },
    userPreferences: { findMany: jest.fn(async () => prefs.map(p => ({ ...p }))) },
    activity: { create: (...a: any[]) => mockActivityCreate(...a) },
  },
}));

const mockSetProjectSettings: jest.Mock = jest.fn(async () => ({ crossProjectMemory: true }));
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  setProjectSettings: (...a: any[]) => mockSetProjectSettings(...a),
}));

const explicitUsers = new Set<string>();
jest.mock('../coding/seat-governance', () => ({
  __esModule: true,
  resolveCodingSeatModel: jest.fn(async () => 'cql-litellm:api-optimize-glm-5.3'),
  isExplicitModelSource: (s: string | null) => s === 'spawn-param' || s === 'explicit',
  isCodingModelPickValue: (v: string | null) => !!v && v.trim() !== '' && v.trim() !== 'glm-5.2',
  isCodingModelExplicit: jest.fn(async (userId: string) => explicitUsers.has(userId)),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { SEAT_APPLY: 'seat_apply' },
}));

import { applySeatsToExistingSessions, classifyProjectOverride, isBuiltInCodingId, LIVE_SESSION_STATUSES } from './seat-apply.service';

const SEAT = 'cql-litellm:api-optimize-glm-5.3';

beforeEach(() => {
  jest.clearAllMocks();
  storeRows.length = 0;
  sessions.length = 0;
  prefs.length = 0;
  explicitUsers.clear();
  storeRows.push(
    { namespacePath: 'p-machine:settings', value: { codingModel: 'glm-5.3', codingModelSource: 'machine' } },
    { namespacePath: 'p-legacy-builtin:settings', value: { codingModel: 'kimi-k3' } },
    { namespacePath: 'p-user:settings', value: { codingModel: 'glm-5.3', codingModelSource: 'user' } },
    { namespacePath: 'p-legacy-registry:settings', value: { codingModel: 'ollama:qwen3' } },
    { namespacePath: 'p-none:settings', value: { crossProjectMemory: false } },
    { namespacePath: 'u1:memory', value: { codingModel: 'should-be-ignored (not a settings row)' } },
  );
  sessions.push(
    { id: 's-restamp', projectId: 'p1', model: 'glm-5.3', modelSource: null, status: 'ready' },
    { id: 's-explicit', projectId: 'p1', model: 'kimi-k3', modelSource: 'explicit', status: 'ready' },
    { id: 's-spawn', projectId: 'p1', model: 'kimi-k3', modelSource: 'spawn-param', status: 'running' },
    { id: 's-onseat', projectId: 'p1', model: SEAT, modelSource: null, status: 'provisioning' },
    { id: 's-archived', projectId: 'p1', model: 'glm-5.3', modelSource: null, status: 'archived' },
  );
  prefs.push(
    { userId: 'u-explicit', codingModel: 'kimi-k3' },
    { userId: 'u-ignored', codingModel: 'deepseek-flash' },
    { userId: 'u-default', codingModel: 'glm-5.2' },
    { userId: 'u-blank', codingModel: '' },
  );
  explicitUsers.add('u-explicit');
});

describe('pure classification', () => {
  it('built-in ids have no label prefix', () => {
    expect(isBuiltInCodingId('glm-5.3')).toBe(true);
    expect(isBuiltInCodingId('ollama:qwen3')).toBe(false);
    expect(isBuiltInCodingId('')).toBe(false);
  });

  it('classifyProjectOverride: machine → cleared; user → kept; legacy built-in → cleared; legacy registry → kept', () => {
    expect(classifyProjectOverride('glm-5.3', 'machine').action).toBe('cleared');
    expect(classifyProjectOverride('glm-5.3', 'user').action).toBe('kept');
    expect(classifyProjectOverride('ollama:qwen3', 'user').action).toBe('kept');
    expect(classifyProjectOverride('kimi-k3', null)).toMatchObject({ action: 'cleared', reason: expect.stringContaining('framework-stamped') });
    expect(classifyProjectOverride('ollama:qwen3', null)).toMatchObject({ action: 'kept', reason: expect.stringContaining('registry-spec') });
  });

  it('live statuses are ready / running / provisioning', () => {
    expect([...LIVE_SESSION_STATUSES]).toEqual(['ready', 'running', 'provisioning']);
  });
});

describe('applySeatsToExistingSessions', () => {
  it('DRY RUN reports the plan and writes nothing', async () => {
    const r = await applySeatsToExistingSessions({ dryRun: true, actorId: 'admin-1' });
    expect(r.dryRun).toBe(true);
    expect(r.seat).toBe(SEAT);
    expect(r.projects).toMatchObject({ cleared: 2, kept: 2 });
    expect(r.projects.rows.map(x => [x.projectId, x.action])).toEqual(expect.arrayContaining([
      ['p-machine', 'cleared'], ['p-legacy-builtin', 'cleared'], ['p-user', 'kept'], ['p-legacy-registry', 'kept'],
    ]));
    expect(r.projects.rows.find(x => x.projectId === 'p-none')).toBeUndefined();
    expect(r.projects.rows.find(x => x.projectId.startsWith('u1'))).toBeUndefined();
    expect(r.sessions).toMatchObject({ restamped: 1, explicit: 2, alreadyOnSeat: 1 });
    expect(r.sessions.rows.find(x => x.sessionId === 's-restamp')).toMatchObject({ action: 'restamped', from: 'glm-5.3', to: SEAT });
    expect(r.sessions.rows.find(x => x.sessionId === 's-archived')).toBeUndefined();
    expect(r.prefs).toMatchObject({ explicit: 1, ignored: 1 });
    expect(r.prefs.rows.map(x => [x.userId, x.action])).toEqual(expect.arrayContaining([['u-explicit', 'explicit'], ['u-ignored', 'ignored']]));
    expect(r.prefs.rows.find(x => x.userId === 'u-default')).toBeUndefined();
    expect(r.prefs.rows.find(x => x.userId === 'u-blank')).toBeUndefined();
    expect(r.errors).toEqual([]);
    // Nothing written.
    expect(mockSetProjectSettings).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
    // Telemetry + audit still recorded (value = sessions to re-stamp).
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'seat_apply', value: 1, meta: expect.objectContaining({ dryRun: true, seat: SEAT, projects: { cleared: 2, kept: 2 }, sessions: { restamped: 1, explicit: 2, alreadyOnSeat: 1 }, prefs: { explicit: 1, ignored: 1 }, actorId: 'admin-1' }) }));
    expect(mockActivityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'admin-1', action: 'model_roles.apply_seats_preview' }) }));
  });

  it('APPLY writes exactly the plan: clears the two overrides, re-stamps the one session, touches no explicit pick and no preference', async () => {
    const r = await applySeatsToExistingSessions({ dryRun: false, actorId: 'admin-1' });
    expect(r.dryRun).toBe(false);
    expect(mockSetProjectSettings).toHaveBeenCalledTimes(2);
    expect(mockSetProjectSettings).toHaveBeenCalledWith('p-machine', { codingModel: '' });
    expect(mockSetProjectSettings).toHaveBeenCalledWith('p-legacy-builtin', { codingModel: '' });
    expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
    expect(mockSessionUpdate).toHaveBeenCalledWith({ where: { id: 's-restamp' }, data: { model: SEAT } });
    expect(sessions.find(s => s.id === 's-explicit')!.model).toBe('kimi-k3');
    expect(sessions.find(s => s.id === 's-spawn')!.model).toBe('kimi-k3');
    expect(mockActivityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'model_roles.apply_seats' }) }));
  });

  it('a per-row write failure is counted under errors and never throws; the rest still applies', async () => {
    mockSetProjectSettings.mockImplementation(async (id: string) => { if (id === 'p-machine') throw new Error('store hiccup'); return {}; });
    const r = await applySeatsToExistingSessions({ dryRun: false });
    expect(r.errors).toEqual([expect.stringContaining('p-machin')]);
    expect(mockSetProjectSettings).toHaveBeenCalledWith('p-legacy-builtin', { codingModel: '' });
    expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
    expect(mockActivityCreate).not.toHaveBeenCalled(); // no actor → no audit row
  });

  it('dryRun omitted = a dry run', async () => {
    const r = await applySeatsToExistingSessions({ dryRun: undefined as any });
    expect(r.dryRun).toBe(true);
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });
});

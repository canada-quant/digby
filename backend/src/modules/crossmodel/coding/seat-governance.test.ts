/**
 * Seats govern sessions (owner 2026-09-28) — coding/seat-governance.ts, the ONE
 * resolver shared by the stamping path and run-executor. Pins the precedence
 * (explicit session pick → HUMAN-set project override → a preference the user
 * set THEMSELVES → the coding_default seat live → the stamp as the record),
 * the explicit-preference marker (fail-closed; the schema default "glm-5.2" and
 * '' are never picks; '' clears the marker), the machine-written project
 * override that never shadows the seat, every fail-open step, and the kill
 * switch's pure helpers.
 */

const store = new Map<string, Record<string, unknown>>();
const mockStoreGet: jest.Mock = jest.fn(async (ns: string[], key: string) => store.get(`${ns.join('/')}::${key}`) ?? null);
const mockStorePut: jest.Mock = jest.fn(async (ns: string[], key: string, value: Record<string, unknown>) => { store.set(`${ns.join('/')}::${key}`, value); });
const mockStoreDelete: jest.Mock = jest.fn(async (ns: string[], key: string) => { store.delete(`${ns.join('/')}::${key}`); });
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
  storeDelete: (...a: any[]) => mockStoreDelete(...a),
}));

const mockPrefFindUnique: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userPreferences: { findUnique: (...a: any[]) => mockPrefFindUnique(...a) } },
}));

const mockProjectCodingModel: jest.Mock = jest.fn(async (): Promise<string | null> => null);
const mockProjectCodingModelSource: jest.Mock = jest.fn(async (): Promise<'user' | 'machine' | null> => null);
const mockResolveOneCodingPick: jest.Mock = jest.fn(async (pick: string): Promise<string | null> => (pick === 'glm-5.2' ? 'glm-5.3' : ['glm-5.3', 'deepseek-flash', 'kimi-k3'].includes(pick) || pick.includes(':') ? pick : null));
jest.mock('./coding-data.service', () => ({
  __esModule: true,
  projectCodingModel: (...a: any[]) => mockProjectCodingModel(...a),
  projectCodingModelSource: (...a: any[]) => mockProjectCodingModelSource(...a),
  resolveOneCodingPick: (...a: any[]) => mockResolveOneCodingPick(...a),
}));

const mockResolveRoleModelForRun: jest.Mock = jest.fn(async (_role: string, fallback: string) => fallback);
jest.mock('./coding-model', () => ({
  __esModule: true,
  resolveRoleModelForRun: (...a: any[]) => mockResolveRoleModelForRun(...a),
}));

import {
  SEAT_GOVERNS_SESSIONS_DISABLED_ENV,
  CODING_PREFS_STORE_NS,
  CODING_MODEL_EXPLICIT_KEY,
  seatGovernsSessionsDisabled,
  isCodingModelPickValue,
  isExplicitModelSource,
  markCodingModelExplicit,
  isCodingModelExplicit,
  resolveCodingSeatModel,
  resolveGoverningCodingModel,
} from './seat-governance';

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  delete process.env[SEAT_GOVERNS_SESSIONS_DISABLED_ENV];
  mockPrefFindUnique.mockResolvedValue(null);
  mockProjectCodingModel.mockResolvedValue(null);
  mockProjectCodingModelSource.mockResolvedValue(null);
  mockResolveRoleModelForRun.mockImplementation(async (_r: string, f: string) => f);
});

describe('pure helpers', () => {
  it('the kill switch reads 1 / true / on', () => {
    expect(seatGovernsSessionsDisabled()).toBe(false);
    process.env[SEAT_GOVERNS_SESSIONS_DISABLED_ENV] = '1';
    expect(seatGovernsSessionsDisabled()).toBe(true);
    process.env[SEAT_GOVERNS_SESSIONS_DISABLED_ENV] = 'on';
    expect(seatGovernsSessionsDisabled()).toBe(true);
  });

  it("a pick value is non-empty and not the schema default 'glm-5.2'", () => {
    expect(isCodingModelPickValue('kimi-k3')).toBe(true);
    expect(isCodingModelPickValue('cql-litellm:api-optimize-glm')).toBe(true);
    expect(isCodingModelPickValue('glm-5.2')).toBe(false);
    expect(isCodingModelPickValue('')).toBe(false);
    expect(isCodingModelPickValue('   ')).toBe(false);
    expect(isCodingModelPickValue(null)).toBe(false);
    expect(isCodingModelPickValue(undefined)).toBe(false);
  });

  it("only 'spawn-param' and 'explicit' are the session's own pick", () => {
    expect(isExplicitModelSource('spawn-param')).toBe(true);
    expect(isExplicitModelSource('explicit')).toBe(true);
    expect(isExplicitModelSource(null)).toBe(false);
    expect(isExplicitModelSource(undefined)).toBe(false);
    expect(isExplicitModelSource('seat')).toBe(false);
  });
});

describe('the explicit-preference marker', () => {
  it('round-trips through the context store and names the stored value', async () => {
    await markCodingModelExplicit('u1', 'kimi-k3', 'settings');
    expect(mockStorePut).toHaveBeenCalledWith(CODING_PREFS_STORE_NS('u1'), CODING_MODEL_EXPLICIT_KEY, expect.objectContaining({ model: 'kimi-k3', via: 'settings' }));
    expect(await isCodingModelExplicit('u1', 'kimi-k3')).toBe(true);
    // A different current value is not the marked one.
    expect(await isCodingModelExplicit('u1', 'deepseek-flash')).toBe(false);
  });

  it("'' and the schema default never mark — they CLEAR an existing marker", async () => {
    await markCodingModelExplicit('u1', 'kimi-k3', 'settings');
    await markCodingModelExplicit('u1', '', 'settings');
    expect(mockStoreDelete).toHaveBeenCalledWith(CODING_PREFS_STORE_NS('u1'), CODING_MODEL_EXPLICIT_KEY);
    expect(await isCodingModelExplicit('u1', 'kimi-k3')).toBe(false);
    await markCodingModelExplicit('u1', 'glm-5.2', 'set_preferences');
    expect(mockStorePut).toHaveBeenCalledTimes(1); // only the kimi-k3 write
    expect(await isCodingModelExplicit('u1', 'glm-5.2')).toBe(false);
  });

  it('fail-CLOSED: no marker, a store error, no user, or a non-pick value → false', async () => {
    expect(await isCodingModelExplicit('u1', 'kimi-k3')).toBe(false);
    mockStoreGet.mockRejectedValueOnce(new Error('store down'));
    expect(await isCodingModelExplicit('u1', 'kimi-k3')).toBe(false);
    expect(await isCodingModelExplicit('', 'kimi-k3')).toBe(false);
    expect(await isCodingModelExplicit('u1', 'glm-5.2')).toBe(false);
    // A store write failure never throws out of the marker.
    mockStorePut.mockRejectedValueOnce(new Error('store down'));
    await expect(markCodingModelExplicit('u1', 'kimi-k3', 'settings')).resolves.toBeUndefined();
  });
});

describe('resolveGoverningCodingModel — precedence', () => {
  it("1. an explicit session pick ('spawn-param' / 'explicit') wins over everything", async () => {
    mockProjectCodingModel.mockResolvedValue('kimi-k3');
    await markCodingModelExplicit('u1', 'deepseek-flash', 'settings');
    mockResolveRoleModelForRun.mockResolvedValue('edge:seat');
    for (const modelSource of ['spawn-param', 'explicit']) {
      const d = await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', stampedModel: 'glm-5.3', modelSource });
      expect(d).toMatchObject({ model: 'glm-5.3', source: 'explicit' });
    }
    expect(mockProjectCodingModel).not.toHaveBeenCalled();
  });

  it('2. a human-set (or legacy no-provenance) project override beats the preference and the seat', async () => {
    mockProjectCodingModel.mockResolvedValue('kimi-k3');
    mockProjectCodingModelSource.mockResolvedValue('user');
    await markCodingModelExplicit('u1', 'deepseek-flash', 'settings');
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', stampedModel: 'glm-5.3', modelSource: null, storedPref: 'deepseek-flash' })).toMatchObject({ model: 'kimi-k3', source: 'project' });
    mockProjectCodingModelSource.mockResolvedValue(null); // legacy override, no record → treated as user-set
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', storedPref: 'deepseek-flash' })).toMatchObject({ model: 'kimi-k3', source: 'project' });
  });

  it('2b. a MACHINE-written project override never shadows the seat', async () => {
    mockProjectCodingModel.mockResolvedValue('kimi-k3');
    mockProjectCodingModelSource.mockResolvedValue('machine');
    mockResolveRoleModelForRun.mockResolvedValue('edge:seat');
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', stampedModel: 'glm-5.3', modelSource: null, storedPref: null })).toMatchObject({ model: 'edge:seat', source: 'seat' });
    expect(mockResolveOneCodingPick).not.toHaveBeenCalledWith('kimi-k3', 'u1');
  });

  it('2c. a stale project pick (no longer resolves) falls through', async () => {
    mockProjectCodingModel.mockResolvedValue('ghost:model');
    mockResolveOneCodingPick.mockImplementation(async (pick: string) => (pick === 'ghost:model' ? null : pick));
    await markCodingModelExplicit('u1', 'kimi-k3', 'settings');
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', storedPref: 'kimi-k3' })).toMatchObject({ model: 'kimi-k3', source: 'preference' });
  });

  it('3. a preference counts ONLY with the explicit marker; the default "glm-5.2" row never does', async () => {
    mockResolveRoleModelForRun.mockResolvedValue('edge:seat');
    // Unmarked stored value — the pre-2026-09-28 "any resolvable pref is a pick" trap.
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', storedPref: 'kimi-k3' })).toMatchObject({ model: 'edge:seat', source: 'seat' });
    // The schema default, even if marked somehow, is never a pick.
    store.set(`${CODING_PREFS_STORE_NS('u1').join('/')}::${CODING_MODEL_EXPLICIT_KEY}`, { model: 'glm-5.2', at: 'x', via: 'settings' });
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', storedPref: 'glm-5.2' })).toMatchObject({ model: 'edge:seat', source: 'seat' });
    // Marked → the pick applies.
    await markCodingModelExplicit('u1', 'kimi-k3', 'settings');
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', storedPref: 'kimi-k3' })).toMatchObject({ model: 'kimi-k3', source: 'preference' });
  });

  it('3b. storedPref undefined → the preference row is loaded here (a prisma error is fail-open to the seat)', async () => {
    await markCodingModelExplicit('u1', 'deepseek-flash', 'settings');
    mockPrefFindUnique.mockResolvedValue({ codingModel: 'deepseek-flash' });
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', stampedModel: 'glm-5.3' })).toMatchObject({ model: 'deepseek-flash', source: 'preference' });
    expect(mockPrefFindUnique).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { codingModel: true } });
    mockPrefFindUnique.mockRejectedValue(new Error('db down'));
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', stampedModel: 'glm-5.3' })).toMatchObject({ model: 'glm-5.3', source: 'seat' });
  });

  it('4. the seat is resolved LIVE (the stamp is not consulted) — the coding_default seat, glm-5.3 fallback', async () => {
    mockResolveRoleModelForRun.mockResolvedValue('cql-litellm:api-optimize-glm-5.3');
    const d = await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', stampedModel: 'kimi-k3', modelSource: null, storedPref: '' });
    expect(d).toMatchObject({ model: 'cql-litellm:api-optimize-glm-5.3', source: 'seat' });
    expect(mockResolveRoleModelForRun).toHaveBeenCalledWith('coding_default', 'glm-5.3');
    expect(await resolveCodingSeatModel()).toBe('cql-litellm:api-optimize-glm-5.3');
  });

  it('5. the stamp is the last-resort RECORD when the seat lookup throws', async () => {
    mockResolveRoleModelForRun.mockRejectedValue(new Error('roles store down'));
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', stampedModel: 'kimi-k3', modelSource: null, storedPref: '' })).toMatchObject({ model: 'kimi-k3', source: 'stamp' });
    // No stamp at all (stamping time) → the built-in default, still 'stamp'.
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', storedPref: '' })).toMatchObject({ model: 'glm-5.3', source: 'stamp' });
    expect(await resolveCodingSeatModel()).toBe('glm-5.3');
  });

  it('every project-step failure is fail-open to the next step', async () => {
    mockProjectCodingModel.mockRejectedValue(new Error('settings down'));
    mockResolveRoleModelForRun.mockResolvedValue('edge:seat');
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', stampedModel: 'kimi-k3', storedPref: '' })).toMatchObject({ model: 'edge:seat', source: 'seat' });
    // A provenance lookup failure is treated as legacy (applies).
    mockProjectCodingModel.mockResolvedValue('kimi-k3');
    mockProjectCodingModelSource.mockRejectedValue(new Error('settings down'));
    expect(await resolveGoverningCodingModel({ userId: 'u1', projectId: 'p1', storedPref: '' })).toMatchObject({ model: 'kimi-k3', source: 'project' });
  });
});

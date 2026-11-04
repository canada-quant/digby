/**
 * Human-spawned coding sessions (cohesive chat live fixes, 2026-09-28 —
 * platform/human-spawn.ts). Pins the ONE spawn-mode resolver: a spawn on a
 * human turn of a plain chat defaults to 'auto' (an explicit arg or a
 * preference the user set THEMSELVES still wins; an unmarked stored 'ask'
 * does not), a machine spawn resolves exactly as before, a supervisor parent
 * never counts as a human spawn, the explicit-preference marker round-trips
 * through the context store (fail-closed on read errors), and the kill
 * switch turns the predicate off.
 */

const store = new Map<string, Record<string, unknown>>();
const mockStoreGet: jest.Mock = jest.fn(async (ns: string[], key: string) => store.get(`${ns.join('/')}::${key}`) ?? null);
const mockStorePut: jest.Mock = jest.fn(async (ns: string[], key: string, value: Record<string, unknown>) => { store.set(`${ns.join('/')}::${key}`, value); });
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));

import {
  CODING_PREFS_STORE_NS,
  PERMISSION_MODE_EXPLICIT_KEY,
  isHumanSpawn,
  resolveSpawnPermissionMode,
  markPermissionModeExplicit,
  isPermissionModeExplicit,
} from './human-spawn';

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
});

describe('isHumanSpawn', () => {
  const human = { userTurnAt: new Date(), machineTriggered: false };

  it('a human turn of a plain chat is a human spawn', () => {
    expect(isHumanSpawn(human, null)).toBe(true);
    expect(isHumanSpawn(human, { isSupervisor: false, isProjectSupervisor: false })).toBe(true);
  });

  it('a machine turn is never a human spawn — no anchor, or an executor-classified machine trigger with an anchor', () => {
    expect(isHumanSpawn({ userTurnAt: undefined }, null)).toBe(false);
    expect(isHumanSpawn({ userTurnAt: new Date(), machineTriggered: true }, null)).toBe(false);
  });

  it('a supervisor-class parent keeps the machine-lane semantics for its children', () => {
    expect(isHumanSpawn(human, { isSupervisor: true })).toBe(false);
    expect(isHumanSpawn(human, { isProjectSupervisor: true })).toBe(false);
  });
});

describe('resolveSpawnPermissionMode', () => {
  it("human spawn: 'auto' by default — an unmarked stored 'ask' (the pre-2026-09-17 default) does not cripple the user's own ask", () => {
    expect(resolveSpawnPermissionMode({ humanSpawn: true })).toEqual({ mode: 'auto', source: 'human-spawn-default' });
    expect(resolveSpawnPermissionMode({ humanSpawn: true, prefMode: 'ask' })).toEqual({ mode: 'auto', source: 'human-spawn-default' });
    expect(resolveSpawnPermissionMode({ humanSpawn: true, prefMode: 'ask', prefExplicit: false })).toEqual({ mode: 'auto', source: 'human-spawn-default' });
    expect(resolveSpawnPermissionMode({ humanSpawn: true, prefMode: 'auto', prefExplicit: true })).toEqual({ mode: 'auto', source: 'human-spawn-default' });
  });

  it('human spawn: a preference the user set THEMSELVES is honoured', () => {
    expect(resolveSpawnPermissionMode({ humanSpawn: true, prefMode: 'ask', prefExplicit: true })).toEqual({ mode: 'ask', source: 'user-pref' });
    expect(resolveSpawnPermissionMode({ humanSpawn: true, prefMode: 'plan', prefExplicit: true })).toEqual({ mode: 'plan', source: 'user-pref' });
  });

  it('an explicit permissionMode argument wins on every path; an invalid one is ignored', () => {
    expect(resolveSpawnPermissionMode({ humanSpawn: true, explicit: 'plan', prefMode: 'ask', prefExplicit: true })).toEqual({ mode: 'plan', source: 'spawn-param' });
    expect(resolveSpawnPermissionMode({ humanSpawn: false, explicit: 'ask' })).toEqual({ mode: 'ask', source: 'spawn-param' });
    expect(resolveSpawnPermissionMode({ humanSpawn: true, explicit: 'yolo', prefMode: 'ask' })).toEqual({ mode: 'auto', source: 'human-spawn-default' });
  });

  it('machine spawn: explicit → stored preference → auto, byte-identical to before (the marker is irrelevant)', () => {
    expect(resolveSpawnPermissionMode({ humanSpawn: false, prefMode: 'ask' })).toEqual({ mode: 'ask', source: 'user-pref' });
    expect(resolveSpawnPermissionMode({ humanSpawn: false, prefMode: 'ask', prefExplicit: false })).toEqual({ mode: 'ask', source: 'user-pref' });
    expect(resolveSpawnPermissionMode({ humanSpawn: false, prefMode: 'bogus' })).toEqual({ mode: 'auto', source: 'default' });
    expect(resolveSpawnPermissionMode({ humanSpawn: false })).toEqual({ mode: 'auto', source: 'default' });
  });
});

describe('the explicit-preference marker', () => {
  it('markPermissionModeExplicit writes { mode, at, via } under the user coding-prefs namespace; isPermissionModeExplicit reads it back for the SAME mode only', async () => {
    await markPermissionModeExplicit('u1', 'ask', 'settings');
    expect(mockStorePut).toHaveBeenCalledWith(CODING_PREFS_STORE_NS('u1'), PERMISSION_MODE_EXPLICIT_KEY, expect.objectContaining({ mode: 'ask', via: 'settings', at: expect.any(String) }));
    expect(await isPermissionModeExplicit('u1', 'ask')).toBe(true);
    // The stored preference moved on (e.g. a DB-level change) — the marker no longer vouches for it.
    expect(await isPermissionModeExplicit('u1', 'plan')).toBe(false);
    expect(await isPermissionModeExplicit('u2', 'ask')).toBe(false);
  });

  it('an invalid mode is never marked; an empty user / mode reads false', async () => {
    await markPermissionModeExplicit('u1', 'bogus', 'settings');
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(await isPermissionModeExplicit('', 'ask')).toBe(false);
    expect(await isPermissionModeExplicit('u1', null)).toBe(false);
  });

  it('fails CLOSED on store errors: a mode we cannot prove deliberate does not override the ask; a write error never throws', async () => {
    mockStoreGet.mockRejectedValueOnce(new Error('db down'));
    expect(await isPermissionModeExplicit('u1', 'ask')).toBe(false);
    mockStorePut.mockRejectedValueOnce(new Error('db down'));
    await expect(markPermissionModeExplicit('u1', 'ask', 'settings')).resolves.toBeUndefined();
  });
});

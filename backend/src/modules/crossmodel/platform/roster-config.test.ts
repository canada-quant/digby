/**
 * roster 2026-10-06 D-1 / D-2: the store-backed switches for the session roster + the lead's call_in tool.
 */
const mockStoreGet: jest.Mock = jest.fn();
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: (...a: any[]) => mockStoreGet(...a) }));

import { parseRosterConfig, rosterConfig, DEFAULT_ROSTER_CONFIG, ROSTER_CONFIG_NS, ROSTER_CONFIG_KEY, __resetRosterConfigForTests } from './roster-config';

beforeEach(() => { __resetRosterConfigForTests(); mockStoreGet.mockReset(); });

describe('parseRosterConfig (pure)', () => {
  it('defaults: session roster SHADOW, call_in CANARY, nobody on the canary — nothing acts until the store says so', () => {
    for (const row of [null, undefined, {}, 'junk', { sessionRoster: 'bogus', callIn: 7, rosterCanaryUserIds: 'u1' }]) {
      const c = parseRosterConfig(row);
      expect(c.sessionRoster).toBe('shadow');
      expect(c.callIn).toBe('canary');
      expect([...c.canary]).toEqual([]);
    }
    expect(DEFAULT_ROSTER_CONFIG.sessionRoster).toBe('shadow');
    expect(DEFAULT_ROSTER_CONFIG.callIn).toBe('canary');
  });

  it('reads the three fields and ignores the turn plan\'s own (actCanaryUserIds is NOT the roster canary)', () => {
    const c = parseRosterConfig({ sessionRoster: 'act', callIn: 'off', rosterCanaryUserIds: [' u1 ', '', 3, 'u2'], actCanaryUserIds: ['u9'], modelPick: 'act' });
    expect(c).toMatchObject({ sessionRoster: 'act', callIn: 'off' });
    expect([...c.canary].sort()).toEqual(['u1', 'u2']);
    expect(c.canary.has('u9')).toBe(false);
  });
});

describe('rosterConfig (store row, 30 s cache, fail-open)', () => {
  it('reads the shared turn-plan config row once per TTL', async () => {
    mockStoreGet.mockResolvedValue({ sessionRoster: 'act', callIn: 'act', rosterCanaryUserIds: ['u1'] });
    const a = await rosterConfig();
    const b = await rosterConfig();
    expect(a).toBe(b);
    expect(a.sessionRoster).toBe('act');
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
    expect(mockStoreGet).toHaveBeenCalledWith(ROSTER_CONFIG_NS, ROSTER_CONFIG_KEY);
    expect(ROSTER_CONFIG_NS).toEqual(['instance', 'turn-plan']);
  });

  it('a store failure serves the defaults (never throws)', async () => {
    mockStoreGet.mockRejectedValue(new Error('db down'));
    await expect(rosterConfig()).resolves.toMatchObject({ sessionRoster: 'shadow', callIn: 'canary' });
  });
});

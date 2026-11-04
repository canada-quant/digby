/** Roster policy — the store-backed model-access switches (roster 2026-10-06 C-1 / C-3 / C-4; frontier hard rule 2026-10-06 late). */
const mockStoreGet = jest.fn();
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: (...a: any[]) => mockStoreGet(...a) }));

import {
  actDecision, applyRosterKillSwitches, autoPickFrontierEnabled, autoPickPolicy, normalizeRosterPolicy, pickCostPerUsd, quickWebCapDecision, rolePickDecision,
  rosterPolicy, __resetIgnoredAllNoteForTests, __resetRosterPolicyForTests, DEFAULT_AUTO_PICK_POLICY, DEFAULT_COST_PER_USD, MAX_COST_PER_USD,
} from './roster-policy';

const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

describe('normalizeRosterPolicy', () => {
  it('defaults: open models only (owner 2026-10-06 late — pickers never choose frontier), cost weight 1, role pick + Quick web budget in shadow, no canaries', () => {
    const p = normalizeRosterPolicy(null);
    expect(DEFAULT_AUTO_PICK_POLICY).toBe('open_only');
    expect(p).toMatchObject({ autoPickPolicy: 'open_only', storedAutoPickPolicy: 'open_only', costPerUsd: DEFAULT_COST_PER_USD, rolePick: 'shadow', quickWebCap: 'shadow' });
    expect(p.rolePickCanaryUserIds.size).toBe(0);
  });
  it('reads the fields it owns and ignores the rest of the turn-plan row; malformed values take defaults; the cost weight is capped; a stored all is still PARSED', () => {
    const p = normalizeRosterPolicy({ actCanaryUserIds: ['x'], modelPick: 'act', autoPickPolicy: 'open_only', costPerUsd: 2.5, rolePick: 'act', rolePickCanaryUserIds: [OWNER, '', 3], quickWebCap: 'off', quickWebCapCanaryUserIds: [OWNER] });
    expect(p).toMatchObject({ autoPickPolicy: 'open_only', costPerUsd: 2.5, rolePick: 'act', quickWebCap: 'off' });
    expect([...p.rolePickCanaryUserIds]).toEqual([OWNER]);
    expect(normalizeRosterPolicy({ autoPickPolicy: 'frontier', costPerUsd: -1, rolePick: 'yes' })).toMatchObject({ autoPickPolicy: 'open_only', costPerUsd: DEFAULT_COST_PER_USD, rolePick: 'shadow' });
    expect(normalizeRosterPolicy({ autoPickPolicy: 'all' })).toMatchObject({ autoPickPolicy: 'all', storedAutoPickPolicy: 'all' });
    expect(normalizeRosterPolicy({ costPerUsd: 1000 }).costPerUsd).toBe(MAX_COST_PER_USD);
    expect(normalizeRosterPolicy({ costPerUsd: 0 }).costPerUsd).toBe(0);
  });
});

describe('the frontier hard rule — a stored all is ignored; only the env opt-in restores C-1', () => {
  const stored = normalizeRosterPolicy({ autoPickPolicy: 'all', costPerUsd: 1, rolePick: 'act', quickWebCap: 'act' });
  it('no env → open_only whatever the store says (the stored value is kept for readouts)', () => {
    expect(applyRosterKillSwitches(stored, {})).toMatchObject({ autoPickPolicy: 'open_only', storedAutoPickPolicy: 'all' });
  });
  it('AUTO_PICK_FRONTIER_ENABLED=1 honours the stored all again; open_only stays open_only', () => {
    expect(applyRosterKillSwitches(stored, { AUTO_PICK_FRONTIER_ENABLED: '1' }).autoPickPolicy).toBe('all');
    expect(applyRosterKillSwitches(normalizeRosterPolicy({ autoPickPolicy: 'open_only' }), { AUTO_PICK_FRONTIER_ENABLED: '1' }).autoPickPolicy).toBe('open_only');
  });
  it('AUTO_PICK_FRONTIER_DISABLED=1 (or FRONTIER_SEATS_REFUSE=1) beats the opt-in', () => {
    expect(applyRosterKillSwitches(stored, { AUTO_PICK_FRONTIER_ENABLED: '1', AUTO_PICK_FRONTIER_DISABLED: '1' }).autoPickPolicy).toBe('open_only');
    expect(applyRosterKillSwitches(stored, { AUTO_PICK_FRONTIER_ENABLED: '1', FRONTIER_SEATS_REFUSE: '1' }).autoPickPolicy).toBe('open_only');
    expect(autoPickFrontierEnabled({ AUTO_PICK_FRONTIER_ENABLED: 'true' })).toBe(true);
    expect(autoPickFrontierEnabled({ AUTO_PICK_FRONTIER_ENABLED: '1', FRONTIER_SEATS_REFUSE: '1' })).toBe(false);
    expect(autoPickFrontierEnabled({})).toBe(false);
  });
  it('MODEL_PICK_COST_DISABLED=1 → no cost term; ROLE_PICK_DISABLED=1 / QUICK_LANE_WEB_CAP_DISABLED=1 → off', () => {
    const p = applyRosterKillSwitches(stored, { MODEL_PICK_COST_DISABLED: '1', ROLE_PICK_DISABLED: 'true', QUICK_LANE_WEB_CAP_DISABLED: '1' });
    expect(p).toMatchObject({ costPerUsd: 0, rolePick: 'off', quickWebCap: 'off' });
  });
});

describe('actDecision — act mode, or a canary user while the mode is shadow', () => {
  const ids = new Set([OWNER]);
  it.each([
    ['act', 'someone', true, false],
    ['shadow', OWNER, true, true],
    ['shadow', 'someone', false, false],
    ['shadow', null, false, false],
    ['off', OWNER, false, false],
  ] as const)('%s / %s → acts %s (canary %s)', (mode, user, acts, canary) => {
    expect(actDecision(mode, ids, user)).toEqual({ mode, acts, canary });
  });
});

describe('the store reader (30 s cache; a read failure serves the defaults)', () => {
  const notifier = jest.fn();
  beforeEach(() => { __resetRosterPolicyForTests(); __resetIgnoredAllNoteForTests(notifier); notifier.mockReset(); mockStoreGet.mockReset(); });
  afterAll(() => __resetIgnoredAllNoteForTests());
  it('reads ["instance","turn-plan"] / config and applies the env switches per call — a stored all reads open_only without the opt-in', async () => {
    mockStoreGet.mockResolvedValue({ autoPickPolicy: 'all', costPerUsd: 0.5, rolePick: 'shadow', rolePickCanaryUserIds: [OWNER], quickWebCap: 'act' });
    expect(await autoPickPolicy({})).toBe('open_only');
    expect(await autoPickPolicy({ AUTO_PICK_FRONTIER_ENABLED: '1' })).toBe('all');
    expect(await autoPickPolicy({ AUTO_PICK_FRONTIER_ENABLED: '1', AUTO_PICK_FRONTIER_DISABLED: '1' })).toBe('open_only');
    expect(await pickCostPerUsd({})).toBe(0.5);
    expect(await rolePickDecision(OWNER, {})).toEqual({ mode: 'shadow', acts: true, canary: true });
    expect(await rolePickDecision('other', {})).toEqual({ mode: 'shadow', acts: false, canary: false });
    expect(await quickWebCapDecision('other', {})).toEqual({ mode: 'act', acts: true, canary: false });
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
    expect(mockStoreGet).toHaveBeenCalledWith(['instance', 'turn-plan'], 'config');
  });
  it('the ignored stored all is said ONCE per process (log + loop_metrics notifier), never per pick; an open_only row says nothing', async () => {
    mockStoreGet.mockResolvedValue({ autoPickPolicy: 'all' });
    await rosterPolicy({}); await rosterPolicy({}); await autoPickPolicy({});
    expect(notifier).toHaveBeenCalledTimes(1);
    __resetRosterPolicyForTests(); __resetIgnoredAllNoteForTests(notifier); notifier.mockReset();
    mockStoreGet.mockResolvedValue({ autoPickPolicy: 'open_only' });
    await rosterPolicy({});
    expect(notifier).not.toHaveBeenCalled();
    // Under the opt-in the stored all is honoured — nothing is ignored, nothing is said.
    __resetRosterPolicyForTests(); __resetIgnoredAllNoteForTests(notifier);
    mockStoreGet.mockResolvedValue({ autoPickPolicy: 'all' });
    await rosterPolicy({ AUTO_PICK_FRONTIER_ENABLED: '1' });
    expect(notifier).not.toHaveBeenCalled();
  });
  it('a store failure never throws: the defaults stand (open_only / shadow — nothing acts)', async () => {
    mockStoreGet.mockRejectedValue(new Error('db down'));
    expect(await autoPickPolicy({})).toBe('open_only');
    expect((await rolePickDecision(OWNER, {})).acts).toBe(false);
  });
});

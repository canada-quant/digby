/**
 * Patience plan Phase 1a (2026-09-25) — rate-limit.service riders:
 *   - getPatienceAutoOnly: SystemSetting `patience_auto_only` on the 60 s cache,
 *     env PATIENCE_AUTO_ONLY as the boot default, DB error → cached/boot value;
 *   - checkAnonDeepResearchQuota: the non-reserving twin of the anon reserve
 *     (same key + limit, never increments, fails CLOSED);
 *   - deepResearchAllowance: guests off Level 3 until proven (guest_no_research),
 *     signed-in from the usage key, `strict` fails CLOSED (quota_unavailable).
 */
const store = new Map<string, string>();
let redisDown = false;
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => { if (redisDown) throw new Error('down'); return store.get(k) ?? null; }),
    incr: jest.fn(async (k: string) => { if (redisDown) throw new Error('down'); const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; }),
    decr: jest.fn(async (k: string) => { const n = Number(store.get(k) ?? 0) - 1; store.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
  },
}));
const mockSettingFind: jest.Mock = jest.fn();
const mockSettingUpsert: jest.Mock = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: { systemSetting: { findUnique: (...a: any[]) => mockSettingFind(...a), upsert: (...a: any[]) => mockSettingUpsert(...a) } },
}));
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mockRecordMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({ ...jest.requireActual('./platform/loop-metrics.service'), recordLoopMetric: (...a: any[]) => mockRecordMetric(...a) }));

import {
  getPatienceAutoOnly, invalidatePatienceAutoOnlyCache, patienceAutoOnlyBootDefault, PATIENCE_AUTO_ONLY_KEY, PATIENCE_AUTO_ONLY_BY_KEY,
  setPatienceAutoOnly, getPatienceAutoOnlyState, getDepthPolicyPublic, patienceSwitchLine,
  checkAnonDeepResearchQuota, reserveAnonDeepResearchQuota, deepResearchAllowance, invalidateLimitCache,
  PATIENCE_SWITCH_METRIC_KIND, parsePatienceSwitchValue,
} from './rate-limit.service';
import { LOOP_METRIC_KINDS } from './platform/loop-metrics.service';

const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  store.clear();
  redisDown = false;
  delete process.env.PATIENCE_AUTO_ONLY;
  delete process.env.ANON_DEEP_RESEARCH_DAILY_LIMIT;
  invalidatePatienceAutoOnlyCache();
  invalidateLimitCache();
  mockSettingFind.mockReset();
  mockSettingUpsert.mockReset();
  mockSettingUpsert.mockImplementation(async ({ where, create }: any) => ({ key: where.key, value: create.value, updatedAt: new Date('2026-09-26T21:00:00Z') }));
  // deep_research_daily_limit row absent → default 5
  mockSettingFind.mockImplementation(async ({ where }: any) => (where.key === PATIENCE_AUTO_ONLY_KEY ? null : null));
});

describe('getPatienceAutoOnly', () => {
  it('no row + no env → false (Phase 1a default); env PATIENCE_AUTO_ONLY=1 is the boot default', async () => {
    expect(await getPatienceAutoOnly()).toBe(false);
    expect(patienceAutoOnlyBootDefault()).toBe(false);
    process.env.PATIENCE_AUTO_ONLY = '1';
    invalidatePatienceAutoOnlyCache();
    expect(await getPatienceAutoOnly()).toBe(true);
  });
  it('the SystemSetting row wins over the env (1|true|on = on; anything else = off) and is cached until invalidated', async () => {
    process.env.PATIENCE_AUTO_ONLY = '1';
    mockSettingFind.mockImplementation(async ({ where }: any) => (where.key === PATIENCE_AUTO_ONLY_KEY ? { key: PATIENCE_AUTO_ONLY_KEY, value: '0' } : null));
    expect(await getPatienceAutoOnly()).toBe(false);
    mockSettingFind.mockImplementation(async ({ where }: any) => (where.key === PATIENCE_AUTO_ONLY_KEY ? { key: PATIENCE_AUTO_ONLY_KEY, value: 'true' } : null));
    expect(await getPatienceAutoOnly()).toBe(false); // cached
    invalidatePatienceAutoOnlyCache();
    expect(await getPatienceAutoOnly()).toBe(true);
    expect(mockSettingFind).toHaveBeenCalledWith({ where: { key: PATIENCE_AUTO_ONLY_KEY } });
  });
  it('a DB error never throws: returns the cached value, else the boot default', async () => {
    mockSettingFind.mockRejectedValue(new Error('db down'));
    expect(await getPatienceAutoOnly()).toBe(false);
    process.env.PATIENCE_AUTO_ONLY = 'on';
    invalidatePatienceAutoOnlyCache();
    expect(await getPatienceAutoOnly()).toBe(true);
  });
});

// ── audit 2026-09-26: the audited flip + state (finding docs-drift-3 #3) ─────
describe('parsePatienceSwitchValue + kill switches', () => {
  it('strict for the PUT: 1|true|on → true, 0|false|off → false, anything else → null (the reader stays lenient: "maybe" reads OFF)', async () => {
    expect(parsePatienceSwitchValue('1')).toBe(true);
    expect(parsePatienceSwitchValue(' On ')).toBe(true);
    expect(parsePatienceSwitchValue(true)).toBe(true);
    expect(parsePatienceSwitchValue('0')).toBe(false);
    expect(parsePatienceSwitchValue('off')).toBe(false);
    expect(parsePatienceSwitchValue(false)).toBe(false);
    expect(parsePatienceSwitchValue('maybe')).toBeNull();
    expect(parsePatienceSwitchValue(undefined)).toBeNull();
    mockSettingFind.mockImplementation(async ({ where }: any) => (where.key === PATIENCE_AUTO_ONLY_KEY ? { key: PATIENCE_AUTO_ONLY_KEY, value: 'maybe' } : null));
    expect(await getPatienceAutoOnly()).toBe(false);
  });
  it('the metric kind is registered', () => {
    expect(PATIENCE_SWITCH_METRIC_KIND).toBe('patience_switch');
    expect(LOOP_METRIC_KINDS.PATIENCE_SWITCH).toBe(PATIENCE_SWITCH_METRIC_KIND);
    expect(PATIENCE_AUTO_ONLY_BY_KEY).toBe('patience_auto_only_by');
  });
});

describe('setPatienceAutoOnly (idempotent, audited, telemetered)', () => {
  const rows = new Map<string, { key: string; value: string; updatedAt: Date }>();
  beforeEach(() => {
    rows.clear();
    mockSettingUpsert.mockReset();
    mockRecordMetric.mockReset();
    mockSettingFind.mockImplementation(async ({ where }: any) => rows.get(where.key) ?? null);
    mockSettingUpsert.mockImplementation(async ({ where, update, create }: any) => {
      const row = { key: where.key, value: String(rows.has(where.key) ? update.value : create.value), updatedAt: new Date('2026-09-27T01:00:00.000Z') };
      rows.set(where.key, row);
      return row;
    });
  });

  it('a real flip writes the value + the `_by` audit row, invalidates the cache and records ONE flipped row (previous from the STORED truth)', async () => {
    rows.set(PATIENCE_AUTO_ONLY_KEY, { key: PATIENCE_AUTO_ONLY_KEY, value: '1', updatedAt: new Date('2026-09-26T20:35:16.556Z') });
    expect(await getPatienceAutoOnly()).toBe(true); // primes the cache
    const flip = await setPatienceAutoOnly(false, 'paul@sunday.market');
    expect(flip).toMatchObject({ key: PATIENCE_AUTO_ONLY_KEY, enabled: false, changed: true, setting: { value: '0' } });
    expect(rows.get(PATIENCE_AUTO_ONLY_KEY)?.value).toBe('0');
    expect(rows.get(PATIENCE_AUTO_ONLY_BY_KEY)?.value).toBe('paul@sunday.market');
    expect(mockRecordMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordMetric.mock.calls[0][0]).toEqual({ kind: 'patience_switch', meta: { action: 'flipped', enabled: false, by: 'paul@sunday.market', previous: true, previousSource: 'setting' } });
    expect(await getPatienceAutoOnly()).toBe(false); // the cache was invalidated by the flip
  });

  it('an unchanged value writes NOTHING (changed:false, no audit row, no telemetry) so `since` stays the real flip time', async () => {
    rows.set(PATIENCE_AUTO_ONLY_KEY, { key: PATIENCE_AUTO_ONLY_KEY, value: '1', updatedAt: new Date('2026-09-26T20:35:16.556Z') });
    const flip = await setPatienceAutoOnly(true, 'paul@sunday.market');
    expect(flip).toMatchObject({ changed: false, setting: { value: '1', updatedAt: new Date('2026-09-26T20:35:16.556Z') } });
    expect(mockSettingUpsert).not.toHaveBeenCalled();
    expect(rows.has(PATIENCE_AUTO_ONLY_BY_KEY)).toBe(false);
    expect(mockRecordMetric).not.toHaveBeenCalled();
  });

  it('no row yet: the first write always lands (the env boot default is not a stored truth), previousSource env', async () => {
    const flip = await setPatienceAutoOnly(false, 'admin@example.com');
    expect(flip.changed).toBe(true);
    expect(rows.get(PATIENCE_AUTO_ONLY_KEY)?.value).toBe('0');
    expect(mockRecordMetric.mock.calls[0][0].meta).toMatchObject({ previous: false, previousSource: 'env' });
  });

  it('an audit-row write failure never fails the flip (the value row is already written)', async () => {
    mockSettingUpsert.mockImplementation(async ({ where, create }: any) => {
      if (where.key === PATIENCE_AUTO_ONLY_BY_KEY) throw new Error('audit down');
      const row = { key: where.key, value: String(create.value), updatedAt: new Date() };
      rows.set(where.key, row);
      return row;
    });
    const flip = await setPatienceAutoOnly(true, 'admin@example.com');
    expect(flip.changed).toBe(true);
    expect(rows.get(PATIENCE_AUTO_ONLY_KEY)?.value).toBe('1');
    expect(mockRecordMetric).toHaveBeenCalledTimes(1);
  });
});

describe('getPatienceAutoOnlyState + patienceSwitchLine', () => {
  it('no row → the env boot default with source env (unset = OFF; PATIENCE_AUTO_ONLY=1 = ON)', async () => {
    mockSettingFind.mockResolvedValue(null);
    expect(await getPatienceAutoOnlyState()).toMatchObject({ key: PATIENCE_AUTO_ONLY_KEY, enabled: false, since: null, updatedBy: null, source: 'env', bootDefault: false, envVar: 'PATIENCE_AUTO_ONLY', line: 'Always Auto: OFF (no store row; env PATIENCE_AUTO_ONLY boot default)' });
    process.env.PATIENCE_AUTO_ONLY = '1';
    expect(await getPatienceAutoOnlyState()).toMatchObject({ enabled: true, source: 'env', bootDefault: true });
  });

  it('the prod shape (row=1 since 2026-09-26 20:35:16Z, no `_by` row) reads ON / since / updatedBy null and names the revert hazard', async () => {
    mockSettingFind.mockImplementation(async ({ where }: any) => (where.key === PATIENCE_AUTO_ONLY_KEY ? { key: PATIENCE_AUTO_ONLY_KEY, value: '1', updatedAt: new Date('2026-09-26T20:35:16.556Z') } : null));
    const s = await getPatienceAutoOnlyState();
    expect(s).toMatchObject({ enabled: true, since: '2026-09-26T20:35:16.556Z', updatedBy: null, source: 'setting', bootDefault: false });
    expect(s.line).toBe('Always Auto: ON since 2026-09-26 20:35Z by unknown (store row; deleting it reverts to the env boot default = OFF)');
  });

  it('with an audit row the line names the admin; a DB error reports the cached/boot value without throwing', async () => {
    mockSettingFind.mockImplementation(async ({ where }: any) => (
      where.key === PATIENCE_AUTO_ONLY_KEY ? { key: PATIENCE_AUTO_ONLY_KEY, value: '0', updatedAt: new Date('2026-09-27T01:00:00.000Z') }
        : where.key === PATIENCE_AUTO_ONLY_BY_KEY ? { key: PATIENCE_AUTO_ONLY_BY_KEY, value: 'paul@sunday.market', updatedAt: new Date() } : null));
    expect((await getPatienceAutoOnlyState()).line).toBe('Always Auto: OFF since 2026-09-27 01:00Z by paul@sunday.market (store row; deleting it reverts to the env boot default = OFF)');
    mockSettingFind.mockRejectedValue(new Error('db down'));
    expect(await getPatienceAutoOnlyState()).toMatchObject({ enabled: false, source: 'env', since: null });
    expect(patienceSwitchLine({ key: PATIENCE_AUTO_ONLY_KEY, enabled: true, since: null, updatedBy: null, source: 'setting', bootDefault: false, envVar: 'PATIENCE_AUTO_ONLY' })).toContain('since unknown by unknown');
  });
});

describe('checkAnonDeepResearchQuota', () => {
  it('mirrors the reserve key + limit and never increments', async () => {
    expect(await checkAnonDeepResearchQuota('24.68.1.2')).toMatchObject({ allowed: true, used: 0, limit: 2, remaining: 2 });
    expect(store.size).toBe(0);
    await reserveAnonDeepResearchQuota('24.68.1.2');
    await reserveAnonDeepResearchQuota('24.68.1.2');
    expect(await checkAnonDeepResearchQuota('24.68.1.2')).toMatchObject({ allowed: false, used: 2, remaining: 0 });
    expect(store.get(`deep_research_anon_usage:24.68.1.2:${today()}`)).toBe('2');
    expect(await checkAnonDeepResearchQuota('24.68.1.3')).toMatchObject({ allowed: true });
  });
  it('fails closed on Redis error and when the limit is 0', async () => {
    redisDown = true;
    expect((await checkAnonDeepResearchQuota('24.68.1.2')).allowed).toBe(false);
    redisDown = false;
    process.env.ANON_DEEP_RESEARCH_DAILY_LIMIT = '0';
    expect((await checkAnonDeepResearchQuota('24.68.1.2')).allowed).toBe(false);
  });
});

describe('deepResearchAllowance', () => {
  it('guests: guest_no_research until guestAllowed (the hop-count prerequisite); then the anon check', async () => {
    expect(await deepResearchAllowance({ userId: null, clientIp: '24.68.1.2' })).toEqual({ allowed: false, reasonKey: 'guest_no_research' });
    expect(await deepResearchAllowance({ userId: null, clientIp: '24.68.1.2', guestAllowed: true })).toMatchObject({ allowed: true, limit: 2 });
    process.env.ANON_DEEP_RESEARCH_DAILY_LIMIT = '0';
    expect(await deepResearchAllowance({ userId: null, clientIp: '24.68.1.2', guestAllowed: true })).toMatchObject({ allowed: false, reasonKey: 'guest_no_research' });
  });
  it('signed-in: allowed while used < limit (non-reserving), quota_exhausted at the limit', async () => {
    expect(await deepResearchAllowance({ userId: 'u1' })).toMatchObject({ allowed: true, remaining: 5, limit: 5 });
    store.set(`deep_research_usage:u1:${today()}`, '5');
    expect(await deepResearchAllowance({ userId: 'u1' })).toMatchObject({ allowed: false, reasonKey: 'quota_exhausted' });
    expect(store.get(`deep_research_usage:u1:${today()}`)).toBe('5'); // never incremented
  });
  it('Redis error: strict (the switch) fails CLOSED with quota_unavailable; non-strict keeps the fail-open posture', async () => {
    redisDown = true;
    expect(await deepResearchAllowance({ userId: 'u1', strict: true })).toEqual({ allowed: false, reasonKey: 'quota_unavailable' });
    expect(await deepResearchAllowance({ userId: 'u1' })).toEqual({ allowed: true });
  });
});

// ── Audit 2026-09-26: the flip is audited + idempotent; the state names the actor ──
describe('setPatienceAutoOnly / getPatienceAutoOnlyState / getDepthPolicyPublic', () => {
  const rows = new Map<string, { key: string; value: string; updatedAt: Date }>();
  beforeEach(() => {
    rows.clear();
    mockSettingFind.mockImplementation(async ({ where }: any) => rows.get(where.key) ?? null);
    mockSettingUpsert.mockImplementation(async ({ where, create }: any) => {
      const row = { key: where.key, value: create.value, updatedAt: new Date('2026-09-26T21:00:00Z') };
      rows.set(where.key, row);
      return row;
    });
  });

  it('a real flip writes the value + the _by companion, invalidates the cache and reports changed:true', async () => {
    expect(await getPatienceAutoOnly()).toBe(false); // cached OFF
    const flip = await setPatienceAutoOnly(true, 'admin@digby.example.com');
    expect(flip).toMatchObject({ key: PATIENCE_AUTO_ONLY_KEY, enabled: true, changed: true, setting: { value: '1' } });
    expect(rows.get(PATIENCE_AUTO_ONLY_KEY)?.value).toBe('1');
    expect(rows.get(PATIENCE_AUTO_ONLY_BY_KEY)?.value).toBe('admin@digby.example.com');
    expect(await getPatienceAutoOnly()).toBe(true); // cache invalidated on this box
    const state = await getPatienceAutoOnlyState();
    expect(state).toMatchObject({ key: PATIENCE_AUTO_ONLY_KEY, enabled: true, since: '2026-09-26T21:00:00.000Z', updatedBy: 'admin@digby.example.com', source: 'setting', bootDefault: false, envVar: 'PATIENCE_AUTO_ONLY' });
    expect(state.line).toContain('by admin@digby.example.com');
  });

  it('an unchanged STORED value writes NOTHING (changed:false) — `since` stays the real flip time; a missing row is always written (the env boot default is not a stored truth)', async () => {
    const first = await setPatienceAutoOnly(false, 'admin@digby.example.com'); // no row + boot default OFF ⇒ the first write still lands
    expect(first).toMatchObject({ changed: true, setting: { value: '0' } });
    mockSettingUpsert.mockClear();
    rows.delete(PATIENCE_AUTO_ONLY_BY_KEY);
    rows.set(PATIENCE_AUTO_ONLY_KEY, { key: PATIENCE_AUTO_ONLY_KEY, value: '1', updatedAt: new Date('2026-09-26T20:35:16.556Z') });
    const same = await setPatienceAutoOnly(true, 'later@digby.example.com');
    expect(same).toMatchObject({ changed: false, setting: { value: '1' } });
    expect(mockSettingUpsert).not.toHaveBeenCalled();
    expect(rows.has(PATIENCE_AUTO_ONLY_BY_KEY)).toBe(false);
  });

  it('the pre-audit prod row (=1, no _by companion) reports updatedBy null with its real since', async () => {
    rows.set(PATIENCE_AUTO_ONLY_KEY, { key: PATIENCE_AUTO_ONLY_KEY, value: '1', updatedAt: new Date('2026-09-26T20:35:16.556Z') });
    expect(await getPatienceAutoOnlyState()).toMatchObject({ enabled: true, since: '2026-09-26T20:35:16.556Z', updatedBy: null, source: 'setting' });
  });

  it('a _by write failure never fails the flip', async () => {
    mockSettingUpsert.mockImplementation(async ({ where, create }: any) => {
      if (where.key === PATIENCE_AUTO_ONLY_BY_KEY) throw new Error('down');
      const row = { key: where.key, value: create.value, updatedAt: new Date() };
      rows.set(where.key, row);
      return row;
    });
    expect((await setPatienceAutoOnly(true, 'a')).changed).toBe(true);
    expect(rows.get(PATIENCE_AUTO_ONLY_KEY)?.value).toBe('1');
  });

  it('the state read fails open to the cached/boot value (source env, no since)', async () => {
    mockSettingFind.mockImplementation(async () => { throw new Error('db down'); });
    expect(await getPatienceAutoOnlyState()).toMatchObject({ enabled: false, since: null, updatedBy: null, source: 'env' });
  });

  it('getDepthPolicyPublic mirrors the switch; a reader failure fails open', async () => {
    rows.set(PATIENCE_AUTO_ONLY_KEY, { key: PATIENCE_AUTO_ONLY_KEY, value: '1', updatedAt: new Date() });
    expect(await getDepthPolicyPublic()).toEqual({ autoOnly: true });
    invalidatePatienceAutoOnlyCache();
    mockSettingFind.mockImplementation(async () => { throw new Error('db down'); });
    expect(await getDepthPolicyPublic()).toEqual({ autoOnly: false }); // no cache, boot default
  });
});

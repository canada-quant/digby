/**
 * Supervisor OFF switch (owner 2026-09-26) — platform/supervisor-switch.ts:
 *   - cached readers: no row + no env → ON; env FLEET_SUPERVISOR_ENABLED /
 *     PROJECT_SUPERVISORS_ENABLED is the boot default; the SystemSetting row
 *     wins (1|true|on / 0|false|off; anything else → boot default); 60 s cache,
 *     invalidated on PUT; a DB error returns the cached/boot value, never OFF;
 *   - state (admin GET + surfaces): since = the row's updatedAt, updatedBy =
 *     the `<key>_by` audit row, skipped = the Redis counter, the status line;
 *   - setSupervisorSwitch: idempotent (unchanged → no write, `since` honest),
 *     a real flip upserts value + `_by`, invalidates, resets the counter and
 *     writes the {action:'flipped'} telemetry row;
 *   - skips: exact Redis INCR + ONE loop_metrics row per (target, source,
 *     chat) per window with the coalesced count; supervisorWakeSkip is free
 *     for plain chats and fail-open on any error; supervisorWakeSkipById
 *     reads the chat flags ONLY when a switch is off;
 *   - the spawn refusal text; the admin-only pin (no platform tool names the
 *     keys or writes SystemSettings); the LOOP_METRIC_KINDS mirror; the
 *     doctrine sentence; the board-line prefix.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const settings = new Map<string, { key: string; value: string; updatedAt: Date }>();
let settingsDown = false;
const mockSettingFind: jest.Mock = jest.fn(async ({ where }: any) => {
  if (settingsDown) throw new Error('db down');
  return settings.get(where.key) ?? null;
});
const mockSettingUpsert: jest.Mock = jest.fn(async ({ where, update, create }: any) => {
  const row = { key: where.key, value: String(update?.value ?? create?.value), updatedAt: new Date('2026-09-26T18:00:00Z') };
  settings.set(where.key, row);
  return row;
});
const mockChatFind: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    systemSetting: { findUnique: (...a: any[]) => mockSettingFind(...a), upsert: (...a: any[]) => mockSettingUpsert(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFind(...a) },
  },
}));
const redisStore = new Map<string, string>();
const mockRedis = {
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  incr: jest.fn(async (k: string) => { const n = Number(redisStore.get(k) ?? 0) + 1; redisStore.set(k, String(n)); return n; }),
  del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  FLEET_SUPERVISOR_ENABLED_KEY, PROJECT_SUPERVISORS_ENABLED_KEY, SUPERVISOR_SWITCH_BY_SUFFIX,
  FLEET_SUPERVISOR_ENABLED_ENV, PROJECT_SUPERVISORS_ENABLED_ENV,
  ADMIN_ONLY_SETTING_KEYS, SUPERVISOR_SWITCH_METRIC_KIND, SUPERVISOR_SWITCH_SKIPPED_STATUS, SUPERVISOR_SWITCH_SKIP_REASON,
  SUPERVISOR_SWITCH_CACHE_TTL_MS, SUPERVISOR_SWITCH_METRIC_WINDOW_MS, skippedCounterKey,
  parseSwitchValue, isSupervisorSwitchKey, switchTargetForKey,
  fleetSupervisorEnabledBootDefault, projectSupervisorsEnabledBootDefault,
  getFleetSupervisorEnabled, getProjectSupervisorsEnabled, supervisorSwitchEnabled, invalidateSupervisorSwitchCache,
  getSupervisorSwitchState, supervisorSwitchLine, setSupervisorSwitch,
  recordSupervisorSwitchSkip, resetSupervisorSwitchMetricWindowForTests, supervisorTargetFor, supervisorWakeSkip, supervisorWakeSkipById,
  anySupervisorSwitchOff, supervisorSpawnRefusal,
} from './supervisor-switch';
import { LOOP_METRIC_KINDS } from './loop-metrics.service';
import { SUPERVISOR_SWITCH_BOARD_PREFIX } from './board-digest.service';

const setRow = (key: string, value: string, updatedAt = new Date('2026-09-26T17:30:00Z')) => settings.set(key, { key, value, updatedAt });
const flips = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === SUPERVISOR_SWITCH_METRIC_KIND && m.meta?.action === 'flipped');
const skips = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === SUPERVISOR_SWITCH_METRIC_KIND && m.meta?.action === 'skipped');
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  redisStore.clear();
  settingsDown = false;
  delete process.env[FLEET_SUPERVISOR_ENABLED_ENV];
  delete process.env[PROJECT_SUPERVISORS_ENABLED_ENV];
  invalidateSupervisorSwitchCache();
  resetSupervisorSwitchMetricWindowForTests();
  mockChatFind.mockResolvedValue(null);
});

describe('parse + keys', () => {
  it('parses 1|true|on and 0|false|off (case/space-insensitive); anything else is null', () => {
    for (const v of ['1', 'true', 'ON', ' on ', true]) expect(parseSwitchValue(v)).toBe(true);
    for (const v of ['0', 'false', 'OFF', ' off ', false]) expect(parseSwitchValue(v)).toBe(false);
    for (const v of ['', 'yes', 'maybe', null, undefined, 2]) expect(parseSwitchValue(v)).toBeNull();
  });
  it('names the two keys, their targets and the audit companions', () => {
    expect(isSupervisorSwitchKey(FLEET_SUPERVISOR_ENABLED_KEY)).toBe(true);
    expect(isSupervisorSwitchKey(PROJECT_SUPERVISORS_ENABLED_KEY)).toBe(true);
    expect(isSupervisorSwitchKey('deep_research_daily_limit')).toBe(false);
    expect(switchTargetForKey(FLEET_SUPERVISOR_ENABLED_KEY)).toBe('fleet');
    expect(switchTargetForKey(PROJECT_SUPERVISORS_ENABLED_KEY)).toBe('project');
    expect(switchTargetForKey('patience_auto_only')).toBeNull();
    expect(ADMIN_ONLY_SETTING_KEYS).toEqual([
      'fleet_supervisor_enabled', 'project_supervisors_enabled', 'fleet_supervisor_enabled_by', 'project_supervisors_enabled_by',
      'patience_auto_only', 'patience_auto_only_by',
    ]);
    expect(SUPERVISOR_SWITCH_BY_SUFFIX).toBe('_by');
    expect(SUPERVISOR_SWITCH_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('cached readers', () => {
  it('no row + no env → ON for both; the env var is the boot default', async () => {
    expect(await getFleetSupervisorEnabled()).toBe(true);
    expect(await getProjectSupervisorsEnabled()).toBe(true);
    expect(fleetSupervisorEnabledBootDefault()).toBe(true);
    process.env[FLEET_SUPERVISOR_ENABLED_ENV] = '0';
    process.env[PROJECT_SUPERVISORS_ENABLED_ENV] = 'off';
    invalidateSupervisorSwitchCache();
    expect(fleetSupervisorEnabledBootDefault()).toBe(false);
    expect(projectSupervisorsEnabledBootDefault()).toBe(false);
    expect(await getFleetSupervisorEnabled()).toBe(false);
    expect(await getProjectSupervisorsEnabled()).toBe(false);
    // An unparseable env value is not a flip — still the ON default.
    process.env[FLEET_SUPERVISOR_ENABLED_ENV] = 'maybe';
    invalidateSupervisorSwitchCache();
    expect(await getFleetSupervisorEnabled()).toBe(true);
  });

  it('the SystemSetting row wins over env; an unparseable row falls back to the boot default; cached until invalidated', async () => {
    process.env[FLEET_SUPERVISOR_ENABLED_ENV] = '1';
    setRow(FLEET_SUPERVISOR_ENABLED_KEY, '0');
    expect(await getFleetSupervisorEnabled()).toBe(false);
    setRow(FLEET_SUPERVISOR_ENABLED_KEY, 'true');
    expect(await getFleetSupervisorEnabled()).toBe(false); // cached
    invalidateSupervisorSwitchCache();
    expect(await getFleetSupervisorEnabled()).toBe(true);
    setRow(FLEET_SUPERVISOR_ENABLED_KEY, 'garbage');
    invalidateSupervisorSwitchCache();
    expect(await getFleetSupervisorEnabled()).toBe(true); // boot default (env 1)
    expect(mockSettingFind).toHaveBeenCalledWith({ where: { key: FLEET_SUPERVISOR_ENABLED_KEY } });
  });

  it('a DB error never throws and never reads as OFF: the cached value, else the boot default', async () => {
    setRow(PROJECT_SUPERVISORS_ENABLED_KEY, '0');
    expect(await supervisorSwitchEnabled('project')).toBe(false);
    settingsDown = true;
    expect(await supervisorSwitchEnabled('project')).toBe(false); // still cached
    invalidateSupervisorSwitchCache();
    expect(await supervisorSwitchEnabled('project')).toBe(true); // boot default, not OFF
  });
});

describe('state + line', () => {
  it('reports enabled / since / updatedBy / skipped per target and a null line when both are ON', async () => {
    const st = await getSupervisorSwitchState();
    expect(st.fleet).toMatchObject({ target: 'fleet', key: FLEET_SUPERVISOR_ENABLED_KEY, enabled: true, since: null, updatedBy: null, skipped: 0, source: 'env', bootDefault: true, envVar: FLEET_SUPERVISOR_ENABLED_ENV });
    expect(st.project).toMatchObject({ target: 'project', key: PROJECT_SUPERVISORS_ENABLED_KEY, enabled: true, source: 'env' });
    expect(st.line).toBeNull();
  });

  it('an OFF target carries since (row updatedAt), updatedBy (the _by row) and skipped (the counter) in the line', async () => {
    setRow(FLEET_SUPERVISOR_ENABLED_KEY, '0', new Date('2026-09-26T17:30:00Z'));
    setRow(`${FLEET_SUPERVISOR_ENABLED_KEY}_by`, 'paul@sunday.market');
    redisStore.set(skippedCounterKey('fleet'), '7');
    const st = await getSupervisorSwitchState();
    expect(st.fleet).toMatchObject({ enabled: false, since: '2026-09-26T17:30:00.000Z', updatedBy: 'paul@sunday.market', skipped: 7, source: 'setting' });
    expect(st.project.enabled).toBe(true);
    expect(st.line).toBe('Fleet supervisor: OFF since 2026-09-26 17:30Z by paul@sunday.market — wakes skipped: 7');
  });

  it('the line joins both OFF targets; an env-only OFF says boot/env; an unreadable counter says n/a', async () => {
    process.env[PROJECT_SUPERVISORS_ENABLED_ENV] = '0';
    setRow(FLEET_SUPERVISOR_ENABLED_KEY, '0');
    mockRedis.get.mockRejectedValue(new Error('redis down'));
    const st = await getSupervisorSwitchState();
    expect(st.line).toBe(
      `Fleet supervisor: OFF since 2026-09-26 17:30Z by unknown — wakes skipped: n/a · Project supervisors: OFF since boot (env ${PROJECT_SUPERVISORS_ENABLED_ENV}) by env — wakes skipped: n/a`,
    );
    expect(supervisorSwitchLine({ fleet: { ...st.fleet, enabled: true }, project: { ...st.project, enabled: true } })).toBeNull();
  });
});

describe('setSupervisorSwitch (the PUT)', () => {
  it('an unchanged value writes nothing (since stays honest) and records no flip', async () => {
    const r = await setSupervisorSwitch(FLEET_SUPERVISOR_ENABLED_KEY, true, 'paul@sunday.market');
    expect(r).toMatchObject({ target: 'fleet', enabled: true, changed: false, setting: null });
    expect(mockSettingUpsert).not.toHaveBeenCalled();
    expect(flips()).toHaveLength(0);
  });

  it('a real flip upserts the value + the _by audit row, invalidates the cache, resets the counter and writes the flipped row', async () => {
    expect(await getFleetSupervisorEnabled()).toBe(true); // prime the cache
    redisStore.set(skippedCounterKey('fleet'), '12');
    const r = await setSupervisorSwitch(FLEET_SUPERVISOR_ENABLED_KEY, false, 'paul@sunday.market');
    expect(r).toMatchObject({ target: 'fleet', enabled: false, changed: true, setting: { key: FLEET_SUPERVISOR_ENABLED_KEY, value: '0' } });
    expect(mockSettingUpsert).toHaveBeenCalledWith({ where: { key: FLEET_SUPERVISOR_ENABLED_KEY }, update: { value: '0' }, create: { key: FLEET_SUPERVISOR_ENABLED_KEY, value: '0' } });
    expect(mockSettingUpsert).toHaveBeenCalledWith({ where: { key: 'fleet_supervisor_enabled_by' }, update: { value: 'paul@sunday.market' }, create: { key: 'fleet_supervisor_enabled_by', value: 'paul@sunday.market' } });
    expect(mockRedis.del).toHaveBeenCalledWith(skippedCounterKey('fleet'));
    expect(flips()).toEqual([expect.objectContaining({ meta: { target: 'fleet', action: 'flipped', enabled: false, by: 'paul@sunday.market' } })]);
    expect(await getFleetSupervisorEnabled()).toBe(false); // cache invalidated — the new value is live on this box
    // Back on: idempotent second write is a no-op.
    await setSupervisorSwitch(FLEET_SUPERVISOR_ENABLED_KEY, true, 'paul@sunday.market');
    expect(await getFleetSupervisorEnabled()).toBe(true);
    await setSupervisorSwitch(FLEET_SUPERVISOR_ENABLED_KEY, true, 'paul@sunday.market');
    expect(flips()).toHaveLength(2);
  });

  it('refuses a non-switch key', async () => {
    await expect(setSupervisorSwitch('deep_research_daily_limit', false, 'x')).rejects.toThrow('not a supervisor switch key');
  });
});

describe('skips + wake gates', () => {
  it('recordSupervisorSwitchSkip INCRs the exact counter and writes ONE row per (target, source, chat) per window with the coalesced count', async () => {
    recordSupervisorSwitchSkip({ target: 'fleet', source: 'hook', chatId: 'c1' });
    recordSupervisorSwitchSkip({ target: 'fleet', source: 'hook', chatId: 'c1' });
    recordSupervisorSwitchSkip({ target: 'fleet', source: 'hook', chatId: 'c1' });
    recordSupervisorSwitchSkip({ target: 'fleet', source: 'schedule', chatId: 'c1' });
    recordSupervisorSwitchSkip({ target: 'project', source: 'hook', chatId: 'c2' });
    await flush();
    expect(redisStore.get(skippedCounterKey('fleet'))).toBe('4');
    expect(redisStore.get(skippedCounterKey('project'))).toBe('1');
    const rows = skips();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'supervisor_switch', sessionId: 'c1', meta: { target: 'fleet', action: 'skipped', source: 'hook', chatId: 'c1', suppressed: 0 } });
    expect(rows[1].meta).toMatchObject({ target: 'fleet', source: 'schedule' });
    expect(rows[2].meta).toMatchObject({ target: 'project', source: 'hook', chatId: 'c2' });
    // Past the window the next row carries the coalesced count.
    const realNow = Date.now;
    Date.now = () => realNow() + SUPERVISOR_SWITCH_METRIC_WINDOW_MS + 1;
    try {
      recordSupervisorSwitchSkip({ target: 'fleet', source: 'hook', chatId: 'c1' });
    } finally {
      Date.now = realNow;
    }
    expect(skips()[3].meta).toMatchObject({ source: 'hook', suppressed: 2 });
  });

  it('supervisorTargetFor / supervisorWakeSkip: plain chats cost nothing; a supervisor chat is skipped only while its switch is OFF; errors fail open', async () => {
    expect(supervisorTargetFor(null)).toBeNull();
    expect(supervisorTargetFor({ isSupervisor: false, isProjectSupervisor: false })).toBeNull();
    expect(supervisorTargetFor({ isSupervisor: true })).toBe('fleet');
    expect(supervisorTargetFor({ isProjectSupervisor: true })).toBe('project');
    expect(await supervisorWakeSkip({ isSupervisor: false }, 'hook', 'c0')).toBeNull();
    expect(mockSettingFind).not.toHaveBeenCalled();
    expect(await supervisorWakeSkip({ isSupervisor: true }, 'hook', 'c1')).toBeNull(); // ON
    setRow(FLEET_SUPERVISOR_ENABLED_KEY, '0');
    invalidateSupervisorSwitchCache();
    expect(await supervisorWakeSkip({ isSupervisor: true }, 'hook', 'c1')).toBe('fleet');
    expect(await supervisorWakeSkip({ isProjectSupervisor: true }, 'hook', 'c2')).toBeNull(); // project still ON
    expect(skips()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ target: 'fleet', source: 'hook', chatId: 'c1' }) })]);
    // Fail-open: a DB error with an empty cache reads as ON (boot default).
    settingsDown = true;
    invalidateSupervisorSwitchCache();
    expect(await supervisorWakeSkip({ isSupervisor: true }, 'hook', 'c1')).toBeNull();
  });

  it('supervisorWakeSkipById reads the chat flags ONLY when a switch is off (all-ON steady state adds no query)', async () => {
    expect(await supervisorWakeSkipById('c1', 'schedule')).toBeNull();
    expect(mockChatFind).not.toHaveBeenCalled();
    expect(await anySupervisorSwitchOff()).toBe(false);
    setRow(PROJECT_SUPERVISORS_ENABLED_KEY, 'off');
    invalidateSupervisorSwitchCache();
    expect(await anySupervisorSwitchOff()).toBe(true);
    mockChatFind.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: true });
    expect(await supervisorWakeSkipById('c9', 'schedule')).toBe('project');
    expect(mockChatFind).toHaveBeenCalledWith({ where: { id: 'c9' }, select: { isSupervisor: true, isProjectSupervisor: true } });
    mockChatFind.mockResolvedValue({ isSupervisor: true, isProjectSupervisor: false });
    expect(await supervisorWakeSkipById('c8', 'schedule')).toBeNull(); // fleet still ON
    mockChatFind.mockRejectedValue(new Error('db'));
    expect(await supervisorWakeSkipById('c7', 'schedule')).toBeNull(); // fail-open
    expect(await supervisorWakeSkipById(null, 'schedule')).toBeNull();
  });

  it('supervisorSpawnRefusal names the switch, the admin path and the no-workaround rule only while OFF', async () => {
    expect(await supervisorSpawnRefusal('project', 'sup-1')).toBeNull();
    setRow(PROJECT_SUPERVISORS_ENABLED_KEY, '0');
    invalidateSupervisorSwitchCache();
    const text = await supervisorSpawnRefusal('project', 'sup-1');
    expect(text).toContain('spawn REFUSED');
    expect(text).toContain('Project supervisors switch is OFF');
    expect(text).toContain('Account → Admin → Settings → Supervisors');
    expect(text).toContain(PROJECT_SUPERVISORS_ENABLED_KEY);
    expect(text).toContain('do not re-arm');
    expect(skips()[0].meta).toMatchObject({ target: 'project', source: 'spawn_guard', chatId: 'sup-1' });
    expect(await supervisorSpawnRefusal('fleet', 'sup-2')).toBeNull(); // fleet ON
  });
});

describe('pins', () => {
  it('LOOP_METRIC_KINDS mirrors the kind; the status/reason constants are the ones the hook/schedule rows carry', () => {
    expect(LOOP_METRIC_KINDS.SUPERVISOR_SWITCH).toBe(SUPERVISOR_SWITCH_METRIC_KIND);
    expect(SUPERVISOR_SWITCH_METRIC_KIND).toBe('supervisor_switch');
    expect(SUPERVISOR_SWITCH_SKIPPED_STATUS).toBe('skipped:supervisor_off');
    expect(SUPERVISOR_SWITCH_SKIP_REASON).toBe('supervisor_off');
    expect(SUPERVISOR_SWITCH_BOARD_PREFIX).toBe('[SUPERVISOR SWITCH — harness-measured]');
  });

  it('ADMIN-ONLY: no platform tool schema, account tool or tool-name registry names the keys or writes SystemSettings', () => {
    const dir = __dirname;
    const sources = ['platform-tools.ts', 'account-tools.ts', 'platform-tool-names.ts', 'coord-tools.ts', 'control-tools.ts']
      .map((f) => path.join(dir, f))
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, 'utf8'));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const src of sources) {
      for (const key of ADMIN_ONLY_SETTING_KEYS) expect(src).not.toContain(key);
      expect(src).not.toMatch(/systemSetting\.(upsert|update|create|delete)/);
    }
    // The ONE writer is the admin REST route.
    const controller = fs.readFileSync(path.join(dir, '..', 'crossmodel.controller.ts'), 'utf8');
    expect(controller).toContain('isSupervisorSwitchKey(key)');
    expect(controller).toContain('setSupervisorSwitch(key, parsed');
    const routes = fs.readFileSync(path.join(dir, '..', 'crossmodel.routes.ts'), 'utf8');
    expect(routes).toContain("router.get('/admin/settings/supervisors', controller.getAdminSupervisorSettings);");
  });
});

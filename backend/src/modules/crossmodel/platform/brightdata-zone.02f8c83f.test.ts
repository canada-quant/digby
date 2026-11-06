/**
 * Ticket 02f8c83f — "Bright Data zone is never validated in code: a nonexistent
 * zone looks healthy while search is silently dead."
 *
 * THE LIVE INCIDENT THIS REPLAYS (digby.cql.ca, 2026-11-06): the stored search
 * config row had `zone: null`, so resolution fell back to
 * `DEFAULT_UNLOCKER_ZONE = 'web_unlocker1'` — a zone that does NOT exist on the
 * account (the real ones were web_unlocker2 / mcp_serp / scraping_browser49 /
 * sm_project_serp_scraper / sm_project_residential_proxy). Bright Data answered
 * every SERP and scrape with **HTTP 200 and a zero-byte body**, putting the
 * truth only in headers:
 *
 *     x-brd-status-code: 407
 *     x-brd-err-code:    client_10002
 *     x-brd-error:       Zone not found
 *
 * So the settings page showed a saved, readable key next to a green
 * "(default: web_unlocker1)" while search returned nothing at all. It was
 * fixed BY HAND on the box; there was no code that could reject or even flag
 * an unresolvable zone.
 *
 * Pins:
 *  1. `isZoneErrorCode` / `zoneErrorFromHeaders` recognise the provider's own
 *     err-code (client_10002) and NOT a plain ACL/policy code.
 *  2. `probeAccountZones` reads the documented
 *     `GET https://api.brightdata.com/zone/get_active_zones` and returns the
 *     account's real zones; it NEVER throws, and an unreachable provider is
 *     reported as UNVERIFIED (`ok:false`), never as a clean bill of health.
 *  3. `zoneSaveErrorMessage` is operator-actionable: names the zone, the
 *     provider err-code, WHY it is silent (200 + empty body), and the zones
 *     that DO exist — so the fix is one paste.
 *  4. `saveWebSearchConfig` REJECTS a save whose zone is not on the account
 *     (explicit zone AND the default-fallback leg), and still saves when the
 *     zone exists or when the provider cannot be asked.
 *  5. `getWebSearchConfigStatus` reports the RESOLVED zone and whether it
 *     exists (verified/unverified/does-not-exist) plus any zone rejection the
 *     search tier actually observed.
 *  6. The direct tier classifies a 200-with-empty-body carrying
 *     x-brd-err-code: client_10002 as a ZONE CONFIG ERROR — `zone_<code>`,
 *     never `serp_*` / `empty_body` ("no results").
 */

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockGet(...a), post: (...a: any[]) => mockPost(...a) },
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    searchProviderConfig: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef-02f8c83f';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

import prisma from '../../../config/database';
import {
  ACTIVE_ZONES_URL,
  ZONE_NOT_FOUND_CODE,
  __clearZoneProbeCache,
  isZoneErrorCode,
  probeAccountZones,
  unblockerZones,
  zoneErrorFromHeaders,
  zoneSaveErrorMessage,
} from './brightdata-zone';
import {
  DEFAULT_UNLOCKER_ZONE,
  __clearSearchCredsCache,
  getWebSearchConfigStatus,
  resolveSearchCredentials,
  resolveWireZone,
  saveWebSearchConfig,
} from './search-provider-config';
import { encryptValue } from '../coding/credentials.service';
import {
  __clearZoneFailureForTest,
  __resetSearchConfigStateForTest,
  lastZoneFailure,
  recordZoneFailure,
} from './search-config-state';

const mockedRow = prisma.searchProviderConfig as jest.Mocked<typeof prisma.searchProviderConfig>;

/** The account's REAL zones at the incident (measured live on digby.cql.ca). */
const LIVE_ZONES = [
  { name: 'web_unlocker2', type: 'unblocker' },
  { name: 'mcp_serp', type: 'serp' },
  { name: 'scraping_browser49', type: 'browser_api' },
  { name: 'sm_project_serp_scraper', type: 'unblocker' },
  { name: 'sm_project_residential_proxy', type: 'res_rotating' },
];

const STORE_KEY = 'brd-store-key-02f8c83f';
/** Local alias so the literal never drifts from the constant under test. */
const WEB_UNLOCKER_1 = 'web_unlocker1';

function makeRow(over: Partial<{ apiKeyEnc: string; zone: string | null; enabled: boolean }> = {}) {
  return {
    id: 'row-1',
    provider: 'brightdata',
    apiKeyEnc: over.apiKeyEnc ?? encryptValue(STORE_KEY),
    zone: over.zone ?? null,
    enabled: over.enabled ?? true,
    updatedBy: 'admin@edge.local',
    createdAt: new Date('2026-11-06T00:00:00Z'),
    updatedAt: new Date('2026-11-06T00:00:00Z'),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  __clearZoneProbeCache();
  __clearSearchCredsCache();
  __resetSearchConfigStateForTest();
  __clearZoneFailureForTest();
  delete process.env.BRIGHTDATA_API_TOKEN;
  delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
});

afterEach(() => {
  delete process.env.BRIGHTDATA_API_TOKEN;
  delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
});

// ── 1. the provider's own zone err-code ──────────────────────────────────────
describe('1. a zone rejection is recognised by the provider err-code, not by the body', () => {
  it('client_10002 is the ZONE code (the live value: 407 "Zone not found")', () => {
    expect(ZONE_NOT_FOUND_CODE).toBe('client_10002');
    expect(isZoneErrorCode('client_10002')).toBe(true);
    expect(isZoneErrorCode('CLIENT_10002')).toBe(true); // header case never guaranteed
    expect(isZoneErrorCode(' client_10002 ')).toBe(true);
  });

  it('an ACL / policy code is NOT a zone code (different fix, different class)', () => {
    expect(isZoneErrorCode('client_10030')).toBe(false); // ip_forbidden
    expect(isZoneErrorCode('policy_20020')).toBe(false);
    expect(isZoneErrorCode('')).toBe(false);
    expect(isZoneErrorCode(undefined)).toBe(false);
  });

  it('zoneErrorFromHeaders extracts the live header triple and ignores ACL headers', () => {
    const live = zoneErrorFromHeaders({
      'x-brd-status-code': '407',
      'x-brd-err-code': 'client_10002',
      'x-brd-error': 'Zone not found',
    });
    expect(live).toEqual({ code: 'client_10002', detail: 'Zone not found' });

    expect(zoneErrorFromHeaders({ 'x-brd-err-code': 'client_10030', 'x-brd-err': '407 ip_forbidden' })).toBeNull();
    expect(zoneErrorFromHeaders({})).toBeNull();
    expect(zoneErrorFromHeaders(undefined)).toBeNull();
  });
});

// ── 2. the account's real zone list ──────────────────────────────────────────
describe('2. probeAccountZones — ask the account which zones EXIST (never throws)', () => {
  it('reads the documented endpoint with the token and returns the live zone list', async () => {
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const probe = await probeAccountZones(STORE_KEY);

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, cfg] = mockGet.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/zone/get_active_zones');
    expect(url).toBe(ACTIVE_ZONES_URL);
    expect(cfg.headers.Authorization).toBe(`Bearer ${STORE_KEY}`);
    expect(probe.ok).toBe(true);
    expect(probe.zones.map(z => z.name)).toEqual(LIVE_ZONES.map(z => z.name));
    // The default zone at the incident was NOT among them — this is the defect.
    expect(probe.zones.map(z => z.name)).not.toContain(DEFAULT_UNLOCKER_ZONE);
  });

  it('accepts a JSON string body and a {zones:[…]} wrapper (provider shape drift)', async () => {
    mockGet.mockResolvedValue({ status: 200, data: JSON.stringify(LIVE_ZONES) });
    expect((await probeAccountZones(STORE_KEY, { skipCache: true })).ok).toBe(true);

    mockGet.mockResolvedValue({ status: 200, data: { zones: LIVE_ZONES } });
    const wrapped = await probeAccountZones(STORE_KEY, { skipCache: true });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.zones).toHaveLength(LIVE_ZONES.length);
  });

  it('an empty/unrecognized list is UNVERIFIED, never "the account has no zones"', async () => {
    mockGet.mockResolvedValue({ status: 200, data: {} });
    const probe = await probeAccountZones(STORE_KEY, { skipCache: true });
    expect(probe.ok).toBe(false);
    expect(probe.zones).toEqual([]);
    expect(probe.reason).toMatch(/empty|unrecognized/i);
  });

  it('a non-2xx / network failure / missing token is UNVERIFIED and never throws', async () => {
    mockGet.mockResolvedValue({ status: 401, data: 'unauthorized' });
    expect(await probeAccountZones(STORE_KEY, { skipCache: true })).toMatchObject({ ok: false });

    mockGet.mockRejectedValue(new Error('ETIMEDOUT'));
    const down = await probeAccountZones(STORE_KEY, { skipCache: true });
    expect(down.ok).toBe(false);
    expect(down.reason).toContain('ETIMEDOUT');

    expect(await probeAccountZones('')).toMatchObject({ ok: false });
    expect(mockGet).toHaveBeenCalledTimes(2); // no request without a token
  });

  it('caches for the TTL so an admin page load does not hammer the provider', async () => {
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
    await probeAccountZones(STORE_KEY);
    await probeAccountZones(STORE_KEY);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await probeAccountZones(STORE_KEY, { skipCache: true });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('unblockerZones lists the zones that can actually serve search', () => {
    expect(unblockerZones(LIVE_ZONES)).toEqual(['web_unlocker2', 'mcp_serp', 'scraping_browser49', 'sm_project_serp_scraper']);
    expect(unblockerZones([{ name: 'res', type: 'res_rotating' }])).toEqual([]);
  });
});

// ── 3. the operator-facing save error ────────────────────────────────────────
describe('3. zoneSaveErrorMessage — actionable at save time (names zone, err-code, real zones)', () => {
  it('names the bad zone, the provider err-code, why it is SILENT, and the zones that exist', () => {
    const msg = zoneSaveErrorMessage('web_unlocker1', LIVE_ZONES);
    expect(msg).toContain('"web_unlocker1"');
    expect(msg).toContain('does not exist');
    expect(msg).toContain(ZONE_NOT_FOUND_CODE);
    expect(msg).toContain('407');
    expect(msg).toContain('HTTP 200 with an empty body');
    expect(msg).toContain('web_unlocker2');
    expect(msg).toContain('do not rotate it');
  });

  it('the DEFAULT-fallback leg says so explicitly (the live trap: no zone saved at all)', () => {
    const msg = zoneSaveErrorMessage(DEFAULT_UNLOCKER_ZONE, LIVE_ZONES, { fromDefault: true });
    expect(msg).toMatch(/No zone was given/i);
    expect(msg).toContain('web_unlocker1');
    expect(msg).toContain('web_unlocker2');
  });
});

// ── 4. SAVE rejects an unresolvable zone ─────────────────────────────────────
describe('4. saveWebSearchConfig — an unresolvable zone is rejected AT SAVE TIME', () => {
  it('REPLAYS THE INCIDENT: a key saved with a nonexistent zone is refused, naming zone + err-code', async () => {
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
    mockedRow.findUnique.mockResolvedValue(null as any); // first save

    const err = await saveWebSearchConfig({ apiKey: STORE_KEY, zone: WEB_UNLOCKER_1 }, 'admin@edge.local')
      .then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('"web_unlocker1"');
    expect(err!.message).toContain(ZONE_NOT_FOUND_CODE);
    expect(err!.message).toContain('web_unlocker2');
    // NOTHING was written — a dead config must never reach the store.
    expect(mockedRow.create).not.toHaveBeenCalled();
    expect(mockedRow.update).not.toHaveBeenCalled();
  });

  it('THE DEFAULT TRAP: saving a key with NO zone is refused when the default does not exist', async () => {
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
    mockedRow.findUnique.mockResolvedValue(null as any);

    await expect(saveWebSearchConfig({ apiKey: STORE_KEY }, 'admin@edge.local'))
      .rejects.toThrow(/No zone was given.*"web_unlocker1"/s);
    expect(mockedRow.create).not.toHaveBeenCalled();
  });

  it('a zone that DOES exist saves normally', async () => {
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
    mockedRow.findUnique.mockResolvedValue(null as any);
    mockedRow.create.mockResolvedValue(makeRow({ zone: 'web_unlocker2' }) as any);

    await saveWebSearchConfig({ apiKey: STORE_KEY, zone: 'web_unlocker2' }, 'admin@edge.local');

    expect(mockedRow.create).toHaveBeenCalledTimes(1);
    expect((mockedRow.create.mock.calls[0][0] as any).data.zone).toBe('web_unlocker2');
  });

  it('a provider we cannot ASK never blocks the save (unverified, not blocked)', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('timeout of 4000ms exceeded'), { code: 'ECONNABORTED' }));
    mockedRow.findUnique.mockResolvedValue(null as any);
    mockedRow.create.mockResolvedValue(makeRow({ zone: 'whatever_zone' }) as any);

    await saveWebSearchConfig({ apiKey: STORE_KEY, zone: 'whatever_zone' }, 'admin@edge.local');

    expect(mockedRow.create).toHaveBeenCalledTimes(1);
  });

  it('an UNCHANGED save (enabled toggle only) never RE-VALIDATES — it cannot fail on a zone it did not touch', async () => {
    // The stored zone does not exist on the account; toggling the key OFF/ON
    // must still succeed (an operator must always be able to disable a key).
    // The probe that runs is the STATUS read at the end (fresh verification in
    // the response) — never a save-time rejection.
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: 'not_a_real_zone' }) as any);
    mockedRow.update.mockResolvedValue(makeRow({ zone: 'not_a_real_zone', enabled: false }) as any);
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const status = await saveWebSearchConfig({ enabled: false }, 'admin@edge.local');

    expect(mockedRow.update).toHaveBeenCalledTimes(1);
    // …and the response tells the truth about that zone rather than going green.
    expect(status.zoneVerified).toBe(false);
    expect(status.resolvedZone).toBe('not_a_real_zone');
  });

  it('an existing row keeps its stored key for the probe when only the zone changes', async () => {
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: null }) as any);
    mockedRow.update.mockResolvedValue(makeRow({ zone: 'mcp_serp' }) as any);

    await saveWebSearchConfig({ zone: 'mcp_serp' }, 'admin@edge.local');

    // The STORED key authenticated the probe — no key was re-entered.
    expect(mockGet.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${STORE_KEY}`);
    expect(mockedRow.update).toHaveBeenCalledTimes(1);
  });
});

// ── 5. the admin status read tells the truth ─────────────────────────────────
describe('5. getWebSearchConfigStatus — the admin surface can no longer show a dead zone as healthy', () => {
  it('REPLAYS THE INCIDENT: row zone null → resolvedZone is the DEFAULT and zoneVerified is FALSE', async () => {
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: null }) as any);
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const status = await getWebSearchConfigStatus();

    expect(status.storeConfigured).toBe(true);
    expect(status.storeReadable).toBe(true); // the key was never the problem
    expect(status.zone).toBeNull(); // nothing stored…
    expect(status.resolvedZone).toBe(DEFAULT_UNLOCKER_ZONE); // …so the dead default is in use
    expect(status.zoneVerified).toBe(false); // ← what the old UI could never say
    expect(status.activeZones).toContain('web_unlocker2');
    expect(status.activeZones).not.toContain(DEFAULT_UNLOCKER_ZONE);
  });

  it('a zone that exists reads verified:true', async () => {
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: 'web_unlocker2' }) as any);
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const status = await getWebSearchConfigStatus();

    expect(status.resolvedZone).toBe('web_unlocker2');
    expect(status.zoneVerified).toBe(true);
  });

  it('an unreachable provider reads UNVERIFIED (null) with the reason — never green', async () => {
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: 'web_unlocker2' }) as any);
    mockGet.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.brightdata.com'));

    const status = await getWebSearchConfigStatus();

    expect(status.zoneVerified).toBeNull();
    expect(status.zoneProbeError).toContain('ENOTFOUND');
  });

  it('a zone rejection the search tier OBSERVED is surfaced as evidence the zone is dead', async () => {
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: 'web_unlocker1' }) as any);
    mockGet.mockRejectedValue(new Error('provider unreachable')); // probe cannot answer
    recordZoneFailure({ at: Date.parse('2026-11-06T04:12:00Z'), zone: 'web_unlocker1', code: ZONE_NOT_FOUND_CODE });

    const status = await getWebSearchConfigStatus();

    expect(status.zoneError).toEqual({
      zone: 'web_unlocker1',
      code: ZONE_NOT_FOUND_CODE,
      at: '2026-11-06T04:12:00.000Z',
    });
  });

  it('nothing configured → no zone resolved and no probe attempted', async () => {
    mockedRow.findUnique.mockResolvedValue(null as any);
    const status = await getWebSearchConfigStatus();
    expect(status.source).toBeNull();
    expect(status.resolvedZone).toBeNull();
    expect(status.zoneVerified).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('the env leg normalizes the empty env zone to the same default the tier uses', async () => {
    process.env.BRIGHTDATA_API_TOKEN = 'brd-env-token';
    // env zone unset → brightdata-direct falls back to the default; the status read must agree
    mockedRow.findUnique.mockResolvedValue(null as any);
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const status = await getWebSearchConfigStatus();

    expect(status.source).toBe('env');
    expect(status.resolvedZone).toBe(DEFAULT_UNLOCKER_ZONE);
    expect(status.zoneVerified).toBe(false);
    expect((await resolveSearchCredentials())!.zone).toBe(''); // the raw env leg is untouched
  });
});

// ── 7. ONE zone resolution: panel === wire, and save validates the wire ──────
describe('7. resolveWireZone is the single source of truth (reviewer F1/F2)', () => {
  it('order is store zone → env zone → built-in default', () => {
    expect(resolveWireZone('stored_zone')).toBe('stored_zone');
    process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = 'env_zone1';
    expect(resolveWireZone(null)).toBe('env_zone1');
    expect(resolveWireZone('')).toBe('env_zone1');
    expect(resolveWireZone('   ')).toBe('env_zone1');
    expect(resolveWireZone('stored_zone')).toBe('stored_zone'); // a stored choice always wins
    delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
    expect(resolveWireZone(null)).toBe(DEFAULT_UNLOCKER_ZONE);
  });

  it('F1 FALSE-RED REGRESSION: env zone dead + stored zone REAL must read VERIFIED, not "search is dead"', async () => {
    // Every compose file ships BRIGHTDATA_WEB_UNLOCKER_ZONE:-web_unlocker1, so
    // this is the ordinary install shape. Before the shared resolver the panel
    // reported the (unused) env zone and screamed about a working config.
    process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = DEFAULT_UNLOCKER_ZONE;
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: 'web_unlocker2' }) as any);
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const status = await getWebSearchConfigStatus();

    expect(status.resolvedZone).toBe('web_unlocker2'); // the STORED zone — what goes on the wire
    expect(status.zoneVerified).toBe(true); // no false alarm
  });

  it('F1 FALSE-GREEN REGRESSION: stored zone dead must read DOES-NOT-EXIST even when the env zone is real', async () => {
    process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = 'web_unlocker2'; // real, but NOT what the store uses
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: DEFAULT_UNLOCKER_ZONE }) as any);
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const status = await getWebSearchConfigStatus();

    expect(status.resolvedZone).toBe(DEFAULT_UNLOCKER_ZONE); // the dead stored zone is what ships
    expect(status.zoneVerified).toBe(false); // …and it is reported dead, never green
  });

  it('the PANEL zone equals the WIRE zone for every env × row combination', async () => {
    const combos: Array<{ env?: string; row: string | null }> = [
      { env: undefined, row: null },
      { env: undefined, row: 'web_unlocker2' },
      { env: DEFAULT_UNLOCKER_ZONE, row: null },
      { env: DEFAULT_UNLOCKER_ZONE, row: 'web_unlocker2' },
      { env: 'web_unlocker2', row: DEFAULT_UNLOCKER_ZONE },
      { env: 'web_unlocker2', row: null },
    ];
    for (const c of combos) {
      delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
      if (c.env) process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = c.env;
      __clearSearchCredsCache();
      mockedRow.findUnique.mockResolvedValue(makeRow({ zone: c.row }) as any);
      mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

      const status = await getWebSearchConfigStatus();
      const creds = await resolveSearchCredentials();
      expect({ env: c.env, row: c.row, zone: status.resolvedZone })
        .toEqual({ env: c.env, row: c.row, zone: creds!.zone });
    }
    delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
  });

  it('F2 REGRESSION: the save validates the zone the WIRE will use — every env × row combination', async () => {
    // The reviewer's finding was that validation checked a value the tier never
    // used. With ONE resolver the check and the wire are the same value, so the
    // invariant is exact: the save is rejected iff the wire zone is absent.
    const combos: Array<{ env?: string; row: string | null; save: { zone?: string } }> = [
      { env: 'web_unlocker2', row: null, save: {} },                            // wire = env zone, exists
      { env: DEFAULT_UNLOCKER_ZONE, row: null, save: {} },                      // wire = env zone, ABSENT
      { env: 'web_unlocker2', row: DEFAULT_UNLOCKER_ZONE, save: {} },           // wire = stored zone, ABSENT
      { env: DEFAULT_UNLOCKER_ZONE, row: 'web_unlocker2', save: {} },           // wire = stored zone, exists
      { env: DEFAULT_UNLOCKER_ZONE, row: null, save: { zone: 'mcp_serp' } },    // wire = explicit, exists
      { env: 'web_unlocker2', row: null, save: { zone: 'nope_zone' } },         // wire = explicit, ABSENT
    ];
    for (const c of combos) {
      jest.clearAllMocks();
      delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
      if (c.env) process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = c.env;
      __clearSearchCredsCache();
      mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
      mockedRow.findUnique.mockResolvedValue(c.row === null ? null as any : makeRow({ zone: c.row }) as any);
      mockedRow.create.mockResolvedValue(makeRow({ zone: c.save.zone ?? c.row }) as any);
      mockedRow.update.mockResolvedValue(makeRow({ zone: c.save.zone ?? c.row }) as any);

      const wireZone = resolveWireZone(c.save.zone !== undefined ? c.save.zone : c.row);
      const wireExists = LIVE_ZONES.some(z => z.name === wireZone);
      const outcome = await saveWebSearchConfig({ apiKey: STORE_KEY, ...c.save }, 'admin@edge.local')
        .then(() => 'saved', () => 'rejected');

      expect({ env: c.env, row: c.row, save: c.save.zone, wire: wireZone, outcome })
        .toEqual({ env: c.env, row: c.row, save: c.save.zone, wire: wireZone, outcome: wireExists ? 'saved' : 'rejected' });
      // Nothing dead can ever reach the store.
      if (!wireExists) expect(mockedRow.create).not.toHaveBeenCalled();
    }
    delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
  });

  it('F1: with the env TOKEN in play the panel reports the ENV zone (what the tier uses), not the stored one', async () => {
    process.env.BRIGHTDATA_API_TOKEN = 'brd-env-token';
    process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = 'web_unlocker2';
    __clearSearchCredsCache();
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: DEFAULT_UNLOCKER_ZONE }) as any);
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const status = await getWebSearchConfigStatus();
    const creds = await resolveSearchCredentials();

    expect(status.source).toBe('env');
    expect(status.resolvedZone).toBe('web_unlocker2'); // the stored (dead) zone is NOT in use
    expect(status.resolvedZone).toBe(creds!.zone); // panel === wire
    expect(status.zoneVerified).toBe(true); // …so it is green, correctly
  });

  it('F2: env zone real + row zone null is ACCEPTED when the operator names a real zone', async () => {
    process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = 'web_unlocker2';
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
    mockedRow.findUnique.mockResolvedValue(null as any);
    mockedRow.create.mockResolvedValue(makeRow({ zone: 'mcp_serp' }) as any);

    await saveWebSearchConfig({ apiKey: STORE_KEY, zone: 'mcp_serp' }, 'admin@edge.local');
    expect(mockedRow.create).toHaveBeenCalledTimes(1);
  });

  it('F2: a real stored zone passes even when the ENV zone is dead (no false rejection)', async () => {
    process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = DEFAULT_UNLOCKER_ZONE; // dead, but unused
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
    mockedRow.findUnique.mockResolvedValue(null as any);
    mockedRow.create.mockResolvedValue(makeRow({ zone: 'web_unlocker2' }) as any);

    await saveWebSearchConfig({ apiKey: STORE_KEY, zone: 'web_unlocker2' }, 'admin@edge.local');
    expect(mockedRow.create).toHaveBeenCalledTimes(1);
  });
});

// ── 8. a repaired config stops rendering the old failure (reviewer F3) ──────
describe('8. a stale zone rejection never outlives the fix', () => {
  it('a save CLEARS the recorded rejection (the operator just fixed it)', async () => {
    recordZoneFailure({ at: Date.now() - 60_000, zone: DEFAULT_UNLOCKER_ZONE, code: ZONE_NOT_FOUND_CODE });
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: 'web_unlocker2' }) as any);
    mockedRow.update.mockResolvedValue(makeRow({ zone: 'web_unlocker2' }) as any);

    const status = await saveWebSearchConfig({ zone: 'web_unlocker2' }, 'admin@edge.local');

    expect(status.zoneError).toBeNull();
    expect(status.zoneVerified).toBe(true);
  });

  it('a VERIFIED probe clears the rejection it supersedes', async () => {
    recordZoneFailure({ at: Date.now() - 60_000, zone: DEFAULT_UNLOCKER_ZONE, code: ZONE_NOT_FOUND_CODE });
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: 'web_unlocker2' }) as any);
    mockGet.mockResolvedValue({ status: 200, data: LIVE_ZONES });

    const status = await getWebSearchConfigStatus();

    expect(status.zoneVerified).toBe(true);
    expect(status.zoneError).toBeNull(); // never blames the NEW zone for the OLD failure
  });

  it('a rejection about a DIFFERENT zone is not attributed to the current one', async () => {
    recordZoneFailure({ at: Date.now() - 60_000, zone: DEFAULT_UNLOCKER_ZONE, code: ZONE_NOT_FOUND_CODE });
    mockedRow.findUnique.mockResolvedValue(makeRow({ zone: 'not_on_account' }) as any);
    mockGet.mockRejectedValue(new Error('provider unreachable')); // cannot verify

    const status = await getWebSearchConfigStatus();

    expect(status.resolvedZone).toBe('not_on_account');
    expect(status.zoneError).toBeNull(); // stale record ≠ evidence about this zone
  });
});
describe('6. direct tier — a 200-with-empty-body zone rejection is NEVER "no results"', () => {
  const loadDirect = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../brightdata-direct');
  };

  beforeEach(() => {
    jest.resetModules();
    __clearZoneFailureForTest();
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  });

  it('REPLAYS THE LIVE RESPONSE: 200 + zero-byte body + client_10002 → zone_<code> miss, not serp_*/empty_body', async () => {
    mockPost.mockResolvedValue({
      data: '',
      status: 200,
      headers: { 'x-brd-status-code': '407', 'x-brd-err-code': ZONE_NOT_FOUND_CODE, 'x-brd-error': 'Zone not found' },
    });
    const { tryDirectBrightData, classifyDirectMiss, DirectZoneError } = loadDirect();
    const onMiss = jest.fn();

    const out = await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss });

    expect(out).toBeNull(); // the tier still fails over — but now it SAYS why
    const miss = onMiss.mock.calls[0][0];
    expect(miss.class).toBe(`zone_${ZONE_NOT_FOUND_CODE}`);
    expect(miss.class).not.toBe('empty_body');
    expect(miss.class).not.toMatch(/^serp_/); // never mistaken for a content shape
    expect(miss.code).toBe(ZONE_NOT_FOUND_CODE);
    expect(miss.detail).toBe('web_unlocker1'); // the zone that was put on the wire
    expect(classifyDirectMiss(new DirectZoneError(ZONE_NOT_FOUND_CODE, 200, 'Zone not found', 'web_unlocker1')))
      .toEqual({ class: `zone_${ZONE_NOT_FOUND_CODE}`, status: 200, code: ZONE_NOT_FOUND_CODE, detail: 'web_unlocker1' });
  });

  it('logs a ZONE CONFIG ERROR naming the zone and the fix — not the generic upstream text', async () => {
    mockPost.mockResolvedValue({
      data: '',
      status: 200,
      headers: { 'x-brd-err-code': ZONE_NOT_FOUND_CODE, 'x-brd-error': 'Zone not found' },
    });
    const { tryDirectBrightData } = loadDirect();
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();

    await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, {});

    const line = (logger.warn as jest.Mock).mock.calls.map(c => String(c[0])).find(m => m.includes('ZONE CONFIG ERROR'));
    expect(line).toBeDefined();
    expect(line).toContain('web_unlocker1');
    expect(line).toContain(ZONE_NOT_FOUND_CODE);
    expect(line).toContain('get_active_zones');
    expect(line).toContain('does not exist');
  });

  it('records the rejection for the admin surface (search-config-state leaf)', async () => {
    mockPost.mockResolvedValue({
      data: '',
      status: 200,
      headers: { 'x-brd-err-code': ZONE_NOT_FOUND_CODE, 'x-brd-error': 'Zone not found' },
    });
    const { tryDirectBrightData } = loadDirect();

    await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, {});

    // Read the leaf through the SAME (post-resetModules) module graph the tier
    // loaded, so this asserts the real wiring rather than a stale copy.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { lastZoneFailure: freshLastZoneFailure } = require('../platform/search-config-state');
    expect(freshLastZoneFailure()).toMatchObject({ zone: 'web_unlocker1', code: ZONE_NOT_FOUND_CODE });
  });

  it('an ACL rejection stays a plain upstream class (no zone false-positive)', async () => {
    mockPost.mockResolvedValue({
      data: '',
      status: 200,
      headers: { 'x-brd-err-code': 'client_10030', 'x-brd-err': '407 ip_forbidden' },
    });
    const { tryDirectBrightData } = loadDirect();
    const onMiss = jest.fn();

    await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss });

    expect(onMiss.mock.calls[0][0].class).toBe('upstream_client_10030');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { lastZoneFailure: freshLastZoneFailure } = require('../platform/search-config-state');
    expect(freshLastZoneFailure()).toBeNull(); // not a zone problem — never recorded as one
  });

  it('scrape (not just search) is classified as a zone error too', async () => {
    mockPost.mockResolvedValue({
      data: '',
      status: 200,
      headers: { 'x-brd-err-code': ZONE_NOT_FOUND_CODE, 'x-brd-error': 'Zone not found' },
    });
    const { tryDirectBrightData } = loadDirect();
    const onMiss = jest.fn();

    await tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com/a' }, 60_000, { onMiss });

    expect(onMiss.mock.calls[0][0].class).toBe(`zone_${ZONE_NOT_FOUND_CODE}`);
  });
});
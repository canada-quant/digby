/**
 * Ticket 6f4d42f2 — admin-settable Bright Data search credentials for
 * self-hosted / Digby Edge instances.
 *
 * Regression pins (the ticket's acceptance bar):
 *  1. CREDENTIAL-RESOLUTION ORDER: env BRIGHTDATA_API_TOKEN takes precedence
 *     over the admin store (cloud-deploy backwards compatibility — the store
 *     can NEVER override env); the store arms search only when env is absent.
 *  2. NOT-CONFIGURED ERROR MESSAGE: with no env key, no stored key and no
 *     gateway token, the agent-facing surfaces return the operator-actionable
 *     "search not configured — set a Bright Data key in Admin → Settings"
 *     message (search-config-state.SEARCH_NOT_CONFIGURED_MSG), NOT the
 *     generic unreachable/rate-limited wording.
 *  3. NO-ECHO: the status read (what the admin UI shows) never carries the
 *     key itself — only a masked preview.
 *  4. The 30 s resolver cache: a saved key arms the direct tier WITHOUT a
 *     process restart (the save path clears the cache).
 *
 * The store is mocked at the prisma edge (findUnique/deleteMany/create/update
 * — the only calls the service makes) and the encryption is the REAL
 * credentials.service AES-256-GCM round trip (key derived from JWT_SECRET), so
 * this suite also pins that a JWT_SECRET rotation degrades to
 * storeReadable:false instead of throwing.
 */

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

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../../config/database';
import {
  resolveSearchCredentials,
  resolveStoreBrightDataCredentials,
  getWebSearchConfigStatus,
  saveWebSearchConfig,
  SEARCH_PROVIDER_BRIGHTDATA,
  DEFAULT_UNLOCKER_ZONE,
  __clearSearchCredsCache,
} from './search-provider-config';
import { encryptValue, decryptValue } from '../coding/credentials.service';
import { SEARCH_NOT_CONFIGURED_MSG, lastSearchConfigState, __resetSearchConfigStateForTest } from './search-config-state';

// The REAL AES-256-GCM round trip is part of what this suite pins (including
// the JWT_SECRET-rotation degradation) — give the crypto a deterministic key.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef-6f4d42f2';
// The store leg is gated on DATABASE_URL (no DB in this process = no store —
// the prod degradation contract); the prisma edge is mocked, so the gate just
// needs the env var present.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const mockedRow = prisma.searchProviderConfig as jest.Mocked<typeof prisma.searchProviderConfig>;

function makeRow(over: Partial<{ apiKeyEnc: string; zone: string | null; enabled: boolean; updatedBy: string | null }> = {}) {
  return {
    id: 'row-1',
    provider: SEARCH_PROVIDER_BRIGHTDATA,
    apiKeyEnc: over.apiKeyEnc ?? encryptValue('brd-store-key-xyz'),
    zone: over.zone ?? null,
    enabled: over.enabled ?? true,
    updatedBy: over.updatedBy ?? 'admin@edge.local',
    createdAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-20T00:00:00Z'),
  };
}

const ENV_TOKEN = 'brd-env-token-aaa';
const ENV_ZONE = 'env_zone1';

describe('search-provider-config (ticket 6f4d42f2) — admin-settable Bright Data credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __clearSearchCredsCache();
    __resetSearchConfigStateForTest();
    delete process.env.BRIGHTDATA_API_TOKEN;
    delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
  });

  afterEach(() => {
    delete process.env.BRIGHTDATA_API_TOKEN;
    delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
  });

  describe('1. credential-resolution order (env → store)', () => {
    it('env BRIGHTDATA_API_TOKEN wins over a stored key (the store can never override env)', async () => {
      mockedRow.findUnique.mockResolvedValue(makeRow() as any);
      process.env.BRIGHTDATA_API_TOKEN = ENV_TOKEN;
      process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE = ENV_ZONE;

      const creds = await resolveSearchCredentials();

      expect(creds).not.toBeNull();
      expect(creds!.source).toBe('env');
      expect(creds!.token).toBe(ENV_TOKEN);
      expect(creds!.zone).toBe(ENV_ZONE);
      // The store must not even be consulted for the token when env is set.
      expect(mockedRow.findUnique).not.toHaveBeenCalled();
    });

    it('falls back to the admin store when env is absent — source "store", zone from the row', async () => {
      const stored = makeRow({ zone: 'my_unlocker_zone' });
      mockedRow.findUnique.mockResolvedValue(stored as any);

      const creds = await resolveSearchCredentials();

      expect(creds).not.toBeNull();
      expect(creds!.source).toBe('store');
      expect(creds!.token).toBe('brd-store-key-xyz');
      expect(creds!.zone).toBe('my_unlocker_zone');
    });

    it('store zone falls back to the default zone when the row has none', async () => {
      mockedRow.findUnique.mockResolvedValue(makeRow({ zone: null }) as any);
      const creds = await resolveSearchCredentials();
      expect(creds!.zone).toBe(DEFAULT_UNLOCKER_ZONE);
    });

    it('resolves null when NOTHING is configured (no env, no stored row)', async () => {
      mockedRow.findUnique.mockResolvedValue(null as any);
      expect(await resolveSearchCredentials()).toBeNull();
    });

    it('resolves null when the stored row is disabled (enabled=false)', async () => {
      mockedRow.findUnique.mockResolvedValue(makeRow({ enabled: false }) as any);
      expect(await resolveSearchCredentials()).toBeNull();
    });

    it('resolves null (does not throw) when the stored key no longer decrypts — JWT_SECRET rotation', async () => {
      mockedRow.findUnique.mockResolvedValue(makeRow({ apiKeyEnc: 'not-a-valid-ciphertext' }) as any);
      expect(await resolveStoreBrightDataCredentials()).toBeNull();
      expect(await resolveSearchCredentials()).toBeNull();
    });

    it('resolves null (does not throw) when the store read itself fails — a DB outage must not break search', async () => {
      mockedRow.findUnique.mockRejectedValue(new Error('connection refused'));
      expect(await resolveStoreBrightDataCredentials()).toBeNull();
    });

    it('a disabled store does not shadow env — env still wins when set', async () => {
      mockedRow.findUnique.mockResolvedValue(makeRow({ enabled: false }) as any);
      process.env.BRIGHTDATA_API_TOKEN = ENV_TOKEN;
      const creds = await resolveSearchCredentials();
      expect(creds!.source).toBe('env');
      expect(creds!.token).toBe(ENV_TOKEN);
    });
  });

  describe('2. the resolver cache arms search without a restart', () => {
    it('caches the store read (30 s TTL) — one prisma call serves repeated resolutions', async () => {
      mockedRow.findUnique.mockResolvedValue(makeRow() as any);
      await resolveStoreBrightDataCredentials();
      await resolveStoreBrightDataCredentials();
      await resolveStoreBrightDataCredentials();
      expect(mockedRow.findUnique).toHaveBeenCalledTimes(1);
    });

    it('a save clears the cache — the next resolution sees the new key immediately', async () => {
      mockedRow.findUnique.mockResolvedValue(null as any);
      expect(await resolveSearchCredentials()).toBeNull();

      const saved = makeRow({ apiKeyEnc: encryptValue('brd-new-key') });
      mockedRow.findUnique.mockResolvedValue(saved as any);
      mockedRow.create.mockResolvedValue(saved as any);

      await saveWebSearchConfig({ apiKey: 'brd-new-key' }, 'admin@edge.local');

      const creds = await resolveSearchCredentials();
      expect(creds!.source).toBe('store');
      expect(creds!.token).toBe('brd-new-key');
    });
  });

  describe('3. save (admin write path)', () => {
    it('stores the key ENCRYPTED — the prisma row never carries the plaintext', async () => {
      const saved = makeRow({ apiKeyEnc: encryptValue('brd-plaintext-secret') });
      mockedRow.create.mockResolvedValue(saved as any);
      mockedRow.findUnique.mockResolvedValue(null as any); // first save

      await saveWebSearchConfig({ apiKey: 'brd-plaintext-secret', zone: 'zone9' }, 'admin@edge.local');

      const createArg = mockedRow.create.mock.calls[0][0] as any;
      expect(createArg.data.apiKeyEnc).not.toContain('brd-plaintext-secret');
      expect(decryptValue(createArg.data.apiKeyEnc)).toBe('brd-plaintext-secret');
      expect(createArg.data.zone).toBe('zone9');
      expect(createArg.data.provider).toBe(SEARCH_PROVIDER_BRIGHTDATA);
    });

    it('requires a key the first time (no row to update) — operator-actionable error', async () => {
      mockedRow.findUnique.mockResolvedValue(null as any);
      await expect(saveWebSearchConfig({ zone: 'zone9' }, 'admin@edge.local')).rejects.toThrow(/provide apiKey/i);
    });

    it('rejects a multiline key (the store_secret single-line rule)', async () => {
      mockedRow.findUnique.mockResolvedValue(null as any);
      await expect(saveWebSearchConfig({ apiKey: 'line1\nline2' }, 'admin@edge.local')).rejects.toThrow(/single line/i);
    });

    it('clear deletes the row and resets resolution to null', async () => {
      mockedRow.deleteMany.mockResolvedValue(1 as any);
      mockedRow.findUnique.mockResolvedValue(null as any);
      await saveWebSearchConfig({ clear: true }, 'admin@edge.local');
      expect(mockedRow.deleteMany).toHaveBeenCalledWith({ where: { provider: SEARCH_PROVIDER_BRIGHTDATA } });
      expect(await resolveSearchCredentials()).toBeNull();
    });
  });

  describe('4. the status read NEVER echoes the key (admin UI surface)', () => {
    it('carries a masked preview only — the plaintext key appears nowhere in the payload', async () => {
      const stored = makeRow({ apiKeyEnc: encryptValue('brd-super-secret-9876') });
      mockedRow.findUnique.mockResolvedValue(stored as any);

      const status = await getWebSearchConfigStatus();

      const json = JSON.stringify(status);
      expect(json).not.toContain('brd-super-secret-9876');
      expect(status.storePreview).toBe('••••9876');
      expect(status.source).toBe('store');
      expect(status.storeConfigured).toBe(true);
      expect(status.storeReadable).toBe(true);
      expect(status.envPrecedence).toBe(false);
    });

    it('marks an unreadable stored key (JWT_SECRET rotated) instead of throwing', async () => {
      mockedRow.findUnique.mockResolvedValue(makeRow({ apiKeyEnc: 'garbage-ciphertext' }) as any);
      const status = await getWebSearchConfigStatus();
      expect(status.storeReadable).toBe(false);
      expect(status.storePreview).toBeNull();
      expect(status.source).toBeNull(); // not usable — not configured
    });

    it('reports envPrecedence + source env when the env token is set (store ignored)', async () => {
      mockedRow.findUnique.mockResolvedValue(makeRow() as any);
      process.env.BRIGHTDATA_API_TOKEN = ENV_TOKEN;
      const status = await getWebSearchConfigStatus();
      expect(status.source).toBe('env');
      expect(status.envPrecedence).toBe(true);
    });
  });

  describe('5. the not-configured message the agent-facing surfaces render', () => {
    it('names the missing configuration and where to set it (Admin → Settings), not the generic degraded wording', () => {
      expect(SEARCH_NOT_CONFIGURED_MSG).toMatch(/not configured/i);
      expect(SEARCH_NOT_CONFIGURED_MSG).toMatch(/Admin → Settings/i);
      expect(SEARCH_NOT_CONFIGURED_MSG).toMatch(/Bright Data API key/i);
      // NOT the generic wording the owner's self-hosted chat hit.
      expect(SEARCH_NOT_CONFIGURED_MSG).not.toMatch(/gateway is recovering/i);
      expect(SEARCH_NOT_CONFIGURED_MSG).not.toMatch(/rate-limited/i);
    });

    it('the config-state leaf records the armed flag the consumers branch on', () => {
      expect(lastSearchConfigState()).toBeNull(); // fresh process state
    });
  });
});

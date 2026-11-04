/**
 * Store-only instance wiring (ticket 6f4d42f2, reviewer Blocking 1).
 *
 * The adversarial review of 16e1f577c proved dynamically that the admin-saved
 * key NEVER armed the direct tier: routeMcpTool's gate is the SYNC
 * directBrightDataAvailable(), which reads the env TOKEN const plus
 * brightdata-direct's _lastStoreCreds memo — and that memo was written ONLY
 * inside resolveDirectBrightDataCreds(), whose callers are reachable only
 * THROUGH the gate itself. On a store-only instance (no env
 * BRIGHTDATA_API_TOKEN — the default docker-compose.selfhost.yml shape, both
 * tokens default empty) every search_engine / scrape_as_markdown /
 * scrape_batch call therefore silently returned null forever, while the admin
 * UI reported source:'store'.
 *
 * The fix: mcp-search's per-call pre-flight (noteSearchConfiguredState,
 * awaited at the top of EVERY callMcpTool, BEFORE the gate evaluates) resolves
 * the composite credential state and primes the store memo via
 * noteStoreCredsForAvailability(). This suite pins the wiring END-TO-END
 * through the REAL callMcpTool — no wholesale './mcp-search' mock, only
 * logger/axios/prisma (the same surfaces the reviewer's repro mocked):
 *
 *   A. cold store-only process → search WORKS on the first call, with the
 *      STORE key on the wire (pre-flight primes before the gate).
 *   B. memo TTL expiry self-heals: after __resetDirectCredsForTest() (same
 *      gate read as a real 30 s expiry), the NEXT call re-primes and still
 *      works — the reviewer proved the pre-fix code never self-healed.
 *   C. env token still wins: the env credential arms the gate and the env
 *      key goes on the wire (backwards-compatible cloud behavior).
 *   D. nothing configured → both tiers dead → null + the not-configured
 *      state leaf recorded (the actionable message, not a silent null).
 *   E. the leaf records anyBackendArmed:true when the store key exists
 *      (admin UI honesty — no false 'not configured').
 */

const mockPost = jest.fn();
const mockGet = jest.fn();

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a), get: (...a: any[]) => mockGet(...a) },
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

const STORE_KEY = 'brd-store-key-wiring-6f4d42f2';

// Keep the process env in the store-only shape for every test (the reviewer's
// repro pinned the same three deletions).
beforeEach(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'wiring-secret-0123456789abcdef';
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://wiring:wiring@localhost:5432/wiring';
  delete process.env.BRIGHTDATA_API_TOKEN;
  delete process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE;
  delete process.env.MCP_DIGBY_TOKEN;
});

function loadFresh(withEnvToken?: string) {
  jest.resetModules();
  if (withEnvToken) process.env.BRIGHTDATA_API_TOKEN = withEnvToken;
  else delete process.env.BRIGHTDATA_API_TOKEN;
  delete process.env.MCP_DIGBY_TOKEN;
  const { encryptValue } = require('../coding/credentials.service');
  const prisma = require('../../../config/database').default;
  const row = {
    id: 'row-1',
    provider: 'brightdata',
    apiKeyEnc: encryptValue(STORE_KEY),
    zone: 'web_unlocker1',
    enabled: true,
    updatedBy: 'admin@edge.local',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  (prisma.searchProviderConfig.findUnique as jest.Mock).mockResolvedValue(row);
  const mcpSearch = require('../mcp-search');
  const bd = require('../brightdata-direct');
  const state = require('./search-config-state');
  return { mcpSearch, bd, state, prisma };
}

function loadFreshWithNoCreds() {
  jest.resetModules();
  delete process.env.BRIGHTDATA_API_TOKEN;
  delete process.env.MCP_DIGBY_TOKEN;
  const prisma = require('../../../config/database').default;
  (prisma.searchProviderConfig.findUnique as jest.Mock).mockResolvedValue(null);
  const mcpSearch = require('../mcp-search');
  const bd = require('../brightdata-direct');
  const state = require('./search-config-state');
  return { mcpSearch, bd, state, prisma };
}

const SERP = { data: '{"organic":[{"link":"https://example.com/a","title":"A"}]}' };

// Module marker — without any import/export this file would be a global script
// and its top-level consts would collide with the other script-style suites
// that declare a global `mockPost` (the mcp-search.test.ts TS2451 note).
export {};

describe('store-only instance wiring (6f4d42f2, reviewer Blocking 1)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockPost.mockResolvedValue(SERP);
  });

  it('A. cold store-only process: first search works with the STORE key', async () => {
    const { mcpSearch } = loadFresh();
    const r = await mcpSearch.callMcpTool('search_engine', { query: 'q1' });
    const headers = (mockPost.mock.calls[0]?.[2] || {}).headers || {};
    expect(r).not.toBeNull();
    expect(String(headers.Authorization || '')).toContain(STORE_KEY);
    expect(mockPost.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('B. memo expiry self-heals: reset → next call still works (pre-fix code never did)', async () => {
    const { mcpSearch, bd } = loadFresh();
    // First call primes the memo via the pre-flight.
    const r1 = await mcpSearch.callMcpTool('search_engine', { query: 'q1' });
    expect(r1).not.toBeNull();
    // Simulate the 30 s store-memo TTL expiring (same gate read as real
    // expiry — the reviewer's repro C used this exact seam).
    bd.__resetDirectCredsForTest();
    mockPost.mockClear();
    const r2 = await mcpSearch.callMcpTool('search_engine', { query: 'q2' });
    const headers = (mockPost.mock.calls[0]?.[2] || {}).headers || {};
    expect(r2).not.toBeNull();
    expect(String(headers.Authorization || '')).toContain(STORE_KEY);
  });

  it('C. env token wins: env credential arms the gate, env key on the wire', async () => {
    const { mcpSearch } = loadFresh('brd-env-token-wiring');
    const r = await mcpSearch.callMcpTool('search_engine', { query: 'q' });
    const headers = (mockPost.mock.calls[0]?.[2] || {}).headers || {};
    expect(r).not.toBeNull();
    expect(String(headers.Authorization || '')).toContain('brd-env-token-wiring');
    expect(String(headers.Authorization || '')).not.toContain(STORE_KEY);
  });

  it('D. nothing configured: null answer + not-configured leaf recorded (not silent)', async () => {
    const { mcpSearch, state } = loadFreshWithNoCreds();
    const r = await mcpSearch.callMcpTool('search_engine', { query: 'q' });
    expect(r).toBeNull();
    const leaf = state.lastSearchConfigState();
    expect(leaf).not.toBeNull();
    expect(leaf!.anyBackendArmed).toBe(false);
  });

  it('E. store key present → leaf records anyBackendArmed:true', async () => {
    const { mcpSearch, state } = loadFresh();
    await mcpSearch.callMcpTool('search_engine', { query: 'q' });
    const leaf = state.lastSearchConfigState();
    expect(leaf).not.toBeNull();
    expect(leaf!.anyBackendArmed).toBe(true);
  });
});

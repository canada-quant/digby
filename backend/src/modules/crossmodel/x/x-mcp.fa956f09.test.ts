/**
 * x-mcp client — read-path health recording (ticket fa956f09, 2026-09-24).
 *
 * The 2026-09-22 outage: x_search / x_get_trends silently returned null /
 * empty for a full day while the integrations UI showed X "connected". The
 * client's failure paths (missing API key, empty gateway payload, JSON-RPC
 * error, non-string content, network throw) each returned null with NO
 * warning on two of the paths and NO health state recorded anywhere.
 *
 * Pins (fa956f09):
 *   1. every read failure path records recordReadOutcome('x', false, reason);
 *   2. a successful read records recordReadOutcome('x', true);
 *   3. a gateway "success" whose payload is x-mcp's honest DEGRADED sentinel
 *      (23c68866) also records a FAILURE — the user is getting no data even
 *      though the RPC round-trip succeeded;
 *   4. write tools never record read health (they measure auth, not the
 *      platform read path);
 *   5. the two previously-SILENT null paths now warn.
 *
 * x-mcp reads X_MCP_API_KEY at module load, so the key is set before the
 * module is required (github-mcp.test.ts lazy-require pattern).
 */

jest.mock('axios');
jest.mock('./token-manager', () => ({
  __esModule: true,
  getValidToken: jest.fn(async () => 'xox-token'),
  resolveXToken: jest.fn(async () => ({ ok: true, token: 'xox-token' })),
}));
jest.mock('../integration-health', () => ({
  __esModule: true,
  recordReadOutcome: jest.fn(),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import axios from 'axios';
import logger from '../../../utils/logger';
import { recordReadOutcome } from '../integration-health';
import { getValidToken } from './token-manager';

const mockPost = axios.post as jest.Mock;
const mockRecord = recordReadOutcome as jest.Mock;
const mockWarn = logger.warn as jest.Mock;

let xMcp: typeof import('./x-mcp');

beforeAll(() => {
  process.env.X_MCP_API_KEY = 'test-key';
  process.env.X_MCP_URL = 'http://x-mcp-test:8000/mcp';
  xMcp = require('./x-mcp');
});

beforeEach(() => {
  jest.clearAllMocks();
});

/** JSON-RPC success response body (SSE single-data-line shape). */
function sseBody(payload: object): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function okResult(text: string): object {
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } };
}

describe('read-path health recording (fa956f09)', () => {
  it('a successful x_search records health ok', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('# X search — "AI"\n\n real posts')) });
    const out = await xMcp.search('AI', 'u1');
    expect(out).toContain('# X search');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith('x', true, undefined);
  });

  it('a gateway JSON-RPC error records a FAILURE with the error text', async () => {
    mockPost.mockResolvedValue({ data: sseBody({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'gateway timeout' } }) });
    const out = await xMcp.search('AI', 'u1');
    expect(out).toBeNull();
    expect(mockRecord).toHaveBeenCalledWith('x', false, expect.stringContaining('gateway timeout'));
  });

  it('the previously-SILENT empty-payload path warns AND records a failure', async () => {
    // 200 with a body carrying NO data: lines and not JSON — the 2026-09-22
    // gateway outage shape. Old behavior: return null with no log at all.
    mockPost.mockResolvedValue({ data: '' });
    const out = await xMcp.getTrends(undefined, 'u1');
    expect(out).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('empty payload'));
    expect(mockRecord).toHaveBeenCalledWith('x', false, expect.stringContaining('empty payload'));
  });

  it('the previously-SILENT non-string content path warns AND records a failure', async () => {
    mockPost.mockResolvedValue({ data: sseBody({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'image' }] } }) });
    const out = await xMcp.getTrends(undefined, 'u1');
    expect(out).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('non-string content'));
    expect(mockRecord).toHaveBeenCalledWith('x', false, expect.stringContaining('non-string content'));
  });

  it('an empty content STRING is no-data — records a failure, never health ok (reviewer nuance)', async () => {
    // The gateway "succeeded" but the content text is '' — every consumer
    // treats '' as no-data, so the health row must not call it ok (else the
    // UI badges connected+healthy while reads return nothing).
    mockPost.mockResolvedValue({ data: sseBody(okResult('')) });
    const out = await xMcp.getTrends(undefined, 'u1');
    expect(out).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('empty content string'));
    expect(mockRecord).toHaveBeenCalledWith('x', false, expect.stringContaining('empty content string'));
    expect(mockRecord).not.toHaveBeenCalledWith('x', true, undefined);
  });

  it('a network throw records a failure with the error message', async () => {
    mockPost.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const out = await xMcp.search('AI', 'u1');
    expect(out).toBeNull();
    expect(mockRecord).toHaveBeenCalledWith('x', false, expect.stringContaining('ECONNREFUSED'));
  });

  it('x-mcp\'s honest DEGRADED sentinel records a FAILURE (gateway ok ≠ data ok, 23c68866)', async () => {
    mockPost.mockResolvedValue({
      data: sseBody(okResult('⚠ X READ DEGRADED — could not fetch X trending topics: x.com served its login wall to the unauthenticated scrape path (X anti-bot blocks public scraping of this surface).')),
    });
    const out = await xMcp.getTrends(undefined, 'u1');
    expect(out).toContain('X READ DEGRADED');
    expect(mockRecord).toHaveBeenCalledWith('x', false, expect.stringContaining('degraded read'));
  });

  it('write tools never record read health (auth is not read-path health)', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('posted')) });
    await xMcp.postTweet('u1', 'hello');
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('honest write-tool auth resolution (fa956f09)', () => {
  it('a refresh-failed connected user hears "reconnect X", not "not connected"', async () => {
    const { resolveXToken } = jest.requireMock('./token-manager') as any;
    (resolveXToken as jest.Mock).mockResolvedValueOnce({
      ok: false,
      reason: 'refresh_failed',
      message: 'The user\'s X token refresh failed (auth expired or revoked) — ask them to reconnect X in Account → Integrations.',
    });
    const out = await xMcp.postTweet('u1', 'hello');
    expect(out).toContain('reconnect X');
    expect(out).not.toContain('has not connected');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a genuinely not-connected user still hears the not-connected message', async () => {
    const { resolveXToken } = jest.requireMock('./token-manager') as any;
    (resolveXToken as jest.Mock).mockResolvedValueOnce({
      ok: false,
      reason: 'not_connected',
      message: 'User has not connected their X account.',
    });
    const out = await xMcp.postTweet('u1', 'hello');
    expect(out).toContain('has not connected');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('reads keep using getValidToken (null token is fine — reads work unauthenticated)', async () => {
    (getValidToken as jest.Mock).mockResolvedValueOnce(null);
    mockPost.mockResolvedValue({ data: sseBody(okResult('# X trends\n\n 1. Real trend')) });
    const out = await xMcp.getTrends(undefined, 'u1');
    expect(out).toContain('# X trends');
    expect(mockRecord).toHaveBeenCalledWith('x', true, undefined);
  });
});

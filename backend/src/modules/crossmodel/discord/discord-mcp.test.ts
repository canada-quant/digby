/**
 * discord-mcp client — read-path health recording (ticket c0e2769b, fixing the
 * fa956f09-class defects found in the first commit).
 *
 * Defects pinned (c0e2769b):
 *   1. strict read failures never latched health: every read call ran in
 *      strict mode, so every failure path THREW before recording. Now every
 *      failure path records recordReadOutcome('discord', false, reason) BEFORE
 *      the strict throw, unconditionally (strict or not).
 *   2. SUCCESS was gated on !strict (the inverted slack/x contract): the six
 *      real read functions ran strict, so a successful read never recorded
 *      health-ok. Now reads record ok on success (reads opt in via
 *      readHealth:true, matching x-mcp).
 *   3. writes polluted read health: write tools with strict=false called the
 *      recording helper unconditionally. Now writes never record read health
 *      (readHealth unset — they measure auth, not the platform read path).
 *   4. container "Error …" text answers were unclassified: an actionable
 *      upstream class (auth / rate limit / provider down) is a read-path
 *      failure. Now classified via classifyUpstreamErrorText (slack-mcp
 *      parity, 2026-10-04) — record false, surface the standard line, return
 *      '' from the read wrappers.
 *   5. a gateway "success" whose payload is the honest empty sentinel also
 *      records a FAILURE — the user is getting no data even though the RPC
 *      round-trip succeeded (x-mcp reviewer nuance, fa956f09).
 *
 * Also pins: probeHealth is a liveness ping, NEVER a health row (slack/x
 * contract — the status surface must not skew integration health).
 *
 * Transport mock: axios only — the whole suite runs with zero network.
 */

jest.mock('axios');
jest.mock('../integration-health', () => ({
  __esModule: true,
  recordReadOutcome: jest.fn(async () => undefined),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import axios from 'axios';
import logger from '../../../utils/logger';
import { recordReadOutcome } from '../integration-health';

const mockPost = axios.post as jest.Mock;
const mockRecord = recordReadOutcome as jest.Mock;
const mockWarn = logger.warn as jest.Mock;

process.env.DISCORD_MCP_API_KEY = 'test-key';
process.env.DISCORD_MCP_URL = 'http://discord-mcp-test:8000/mcp';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = require('./discord-mcp') as typeof import('./discord-mcp');

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

describe('read-path health recording (c0e2769b)', () => {
  it('a successful read records health ok (strict reads previously never did — defect 2)', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('TestBot#0001 — 2 servers')) });
    const out = await mcp.getBotInfo();
    expect(out).toBe('[Discord Bot]\nTestBot#0001 — 2 servers');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith('discord', true, undefined);
  });

  it('a strict read failure records the failure BEFORE throwing (defect 1)', async () => {
    // empty payload → record(false) → THEN the strict throw; the wrapper
    // catches and surfaces the platform-outage line. The health row must
    // exist even though the call threw.
    mockPost.mockResolvedValue({ data: '' });
    const out = await mcp.getBotInfo();
    expect(out).toContain('empty payload from gateway'); // surfaced, not '' — users get a readable line
    expect(out).toContain('platform-side outage');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    // Before the fix: this fired 0 times because the throw preceded recording.
    expect(mockRecord).toHaveBeenCalledWith('discord', false, expect.stringContaining('empty payload'));
  });

  it('a network throw on a read records a failure with the error message', async () => {
    mockPost.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const out = await mcp.getBotInfo();
    expect(out).toContain('ECONNREFUSED');
    expect(mockRecord).toHaveBeenCalledWith('discord', false, expect.stringContaining('ECONNREFUSED'));
  });

  it('a JSON-RPC error body records a failure with the error text', async () => {
    mockPost.mockResolvedValue({ data: sseBody({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'gateway timeout' } }) });
    const out = await mcp.getBotInfo();
    expect(out).toContain('gateway timeout');
    expect(mockRecord).toHaveBeenCalledWith('discord', false, expect.stringContaining('gateway timeout'));
  });

  it('non-string content records a failure (x-mcp pin 5 class)', async () => {
    mockPost.mockResolvedValue({ data: sseBody({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'image' }] } }) });
    const out = await mcp.getBotInfo();
    expect(out).toContain('non-string content');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('non-string content'));
    expect(mockRecord).toHaveBeenCalledWith('discord', false, expect.stringContaining('non-string content'));
  });

  it('an empty content STRING is no-data — records a failure, never health ok', async () => {
    // The gateway "succeeded" but the content text is '' — every consumer
    // treats '' as no-data, so the health row must not call it ok.
    mockPost.mockResolvedValue({ data: sseBody(okResult('')) });
    const out = await mcp.getBotInfo();
    expect(out).toBe('');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('empty content string'));
    expect(mockRecord).toHaveBeenCalledWith('discord', false, expect.stringContaining('empty content string'));
    expect(mockRecord).not.toHaveBeenCalledWith('discord', true, undefined);
  });
});

describe('container error-text classification (slack-mcp parity, defect 4)', () => {
  it('an auth-shaped "Error …" text records a failure and surfaces the admin-token line', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('Error discordGetBotInfo: invalid_auth')) });
    const out = await mcp.getBotInfo();
    expect(out).toBe("Discord get bot info call was rejected by Discord (invalid_auth) — the Discord connection needs re-authorizing: an admin must re-issue the Discord bot token (DISCORD_BOT_TOKEN in the discord-mcp container).");
    expect(mockRecord).toHaveBeenCalledWith('discord', false, expect.stringContaining('auth'));
  });

  it('a rate-limit-shaped "Error …" text records a failure with the rate_limited class', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('Error discordListGuilds: A rate limit was exceeded (retry-after: 30)')) });
    const out = await mcp.listGuilds();
    expect(out).toMatch(/^Discord list guilds call was rate-limited by Discord/);
    expect(mockRecord).toHaveBeenCalledWith('discord', false, expect.stringContaining('rate_limited'));
  });

  it('a down-shaped "Error …" text records a failure with the down class', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('Error discordListChannels: An HTTP protocol error occurred: statusCode = 503')) });
    const out = await mcp.listChannels('guild-1');
    expect(out).toMatch(/^Discord list channels call failed on Discord's side/);
    expect(mockRecord).toHaveBeenCalledWith('discord', false, expect.stringContaining('down'));
  });

  it('a NON-actionable container error (channel_not_found) passes through as data — health ok, no surfaced error line', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('Error discordChannelHistory: An API error occurred: channel_not_found')) });
    const out = await mcp.getChannelHistory('chan-1', 20);
    expect(out).toBe('[Discord Channel History: chan-1]\nError discordChannelHistory: An API error occurred: channel_not_found');
    expect(mockRecord).toHaveBeenCalledWith('discord', true, undefined);
  });
});

describe('writes never record read health (defect 3)', () => {
  it('sendMessage succeeds without recording any health row', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('sent')) });
    const out = await mcp.sendMessage('chan-1', 'hello');
    expect(out).toBe('sent');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('sendDm FAILS without recording any health row (auth, not read path)', async () => {
    mockPost.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const out = await mcp.sendDm('user-1', 'hello');
    expect(out).toBeNull();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('probeHealth is a liveness ping, not a health row', () => {
  it('a successful probe records NOTHING', async () => {
    mockPost.mockResolvedValue({ data: sseBody(okResult('TestBot#0001')) });
    const ok = await mcp.probeHealth();
    expect(ok).toBe(true);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('a failed probe records NOTHING (status surface, not integration health)', async () => {
    mockPost.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const ok = await mcp.probeHealth();
    expect(ok).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

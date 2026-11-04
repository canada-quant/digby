/**
 * slack-mcp client — failure surfacing (2026-10-04, integrations/integration-error.ts).
 *
 * A failed READ used to return '' — the coding executor then answered "No
 * result from Slack — the integration may not be connected … or nothing
 * matched", and integration-context dropped the leg — so the model could not
 * tell the user to reconnect Slack or that the service was down. Pinned here:
 * a provider 401 (the container's "Error …" text) → the reconnect line; a
 * provider 5xx → the down line; the slack-mcp CONTAINER failing → the
 * platform-side line (never "reconnect"); a connected user with no usable token
 * → the reconnect line; the kill switch restores ''; an empty-but-successful
 * answer and a never-connected user still read as before; WRITES unchanged.
 *
 * Boundaries mocked: axios (the transport), ./token-manager, logger.
 * SLACK_MCP_API_KEY is read at import, so the module is required after it is set.
 */
export {};

import { PassThrough } from 'stream';

const mockPost: jest.Mock = jest.fn();
const mockGetValidToken: jest.Mock = jest.fn();
const mockHasConnected: jest.Mock = jest.fn();

jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));
jest.mock('./token-manager', () => ({
  __esModule: true,
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
  hasSlackConnected: (...a: any[]) => mockHasConnected(...a),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

process.env.SLACK_MCP_API_KEY = 'test-key';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = require('./slack-mcp') as typeof import('./slack-mcp');

/** Answer the JSON-RPC call with one SSE frame carrying `text` (or a JSON-RPC error). */
function answer(payload: { text?: string; rpcError?: string }) {
  mockPost.mockImplementation((_url: string, body: any) => {
    const stream = new PassThrough();
    const frame = payload.rpcError
      ? { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: payload.rpcError } }
      : { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: payload.text }] } };
    setImmediate(() => { stream.write(`data: ${JSON.stringify(frame)}\n\n`); stream.end(); });
    return Promise.resolve({ data: stream });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue('user-token');
  mockHasConnected.mockResolvedValue(true);
  delete process.env.INTEGRATION_ERROR_SURFACE_DISABLED;
});

describe('slack-mcp read failures surface ONE readable line', () => {
  it('a Slack 401 (the container\'s "Error …" text) tells the model to reconnect Slack', async () => {
    answer({ text: 'Error slackSearchMessages: An API error occurred: invalid_auth' });
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe('Slack search messages call was rejected by Slack (An API error occurred: invalid_auth) — the Slack connection needs re-authorizing: Account → Integrations → Slack → reconnect.');
  });

  it('a Slack 5xx → the down line; a rate limit → the rate-limited line', async () => {
    answer({ text: 'Error slackSearchMessages: An HTTP protocol error occurred: statusCode = 503' });
    expect(await mcp.searchMessages('u1', 'launch plan')).toMatch(/^Slack search messages call failed on Slack's side \(.+\) — Slack is unavailable right now; try again later\.$/);
    answer({ text: 'Error slackSearchMessages: A rate limit was exceeded (url: search.messages, retry-after: 30)' });
    expect(await mcp.searchMessages('u1', 'launch plan')).toMatch(/^Slack search messages call was rate-limited by Slack \(.+\) — try again in a minute\.$/);
  });

  it('the slack-mcp CONTAINER failing (HTTP 502 / refused service key / unreachable / JSON-RPC error) is never "reconnect"', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }));
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe("Slack search messages call failed: Digby's slack-mcp service did not answer (HTTP 502) — a platform-side outage, not the user's Slack connection (reconnecting will not help); try again shortly.");
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
    const key = await mcp.searchMessages('u1', 'launch plan');
    expect(key).toContain("refused Digby's service key");
    expect(key).not.toContain('re-authorizing');
    mockPost.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8000'), { code: 'ECONNREFUSED' }));
    expect(await mcp.searchMessages('u1', 'launch plan')).toContain('did not answer (network error: ECONNREFUSED)');
    answer({ rpcError: 'Invalid arguments' });
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe('Slack search messages call failed (MCP error: Invalid arguments).');
  });

  it('a connected user whose token cannot be used → reconnect; a never-connected user stays ""', async () => {
    mockGetValidToken.mockResolvedValue(null);
    expect(await mcp.searchMessages('u1', 'launch plan')).toMatch(/^Slack search messages call could not be called: the Slack connection has no valid token \(.+\) — the user should reconnect Slack in Account → Integrations\.$/);
    mockHasConnected.mockResolvedValue(false);
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe('');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('kill switch INTEGRATION_ERROR_SURFACE_DISABLED=1 restores the empty string (and the raw container text)', async () => {
    process.env.INTEGRATION_ERROR_SURFACE_DISABLED = '1';
    mockPost.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 502 } }));
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe('');
    answer({ text: 'Error slackSearchMessages: An API error occurred: invalid_auth' });
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe('[Slack Search Results]\nError slackSearchMessages: An API error occurred: invalid_auth');
    mockGetValidToken.mockResolvedValue(null);
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe('');
  });

  it('an empty-but-successful answer and an unclassified error still read as the container\'s own words', async () => {
    answer({ text: 'No messages found for "launch plan".' });
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe('[Slack Search Results]\nNo messages found for "launch plan".');
    answer({ text: 'Error slackSearchMessages: An API error occurred: channel_not_found' });
    expect(await mcp.searchMessages('u1', 'launch plan')).toBe('[Slack Search Results]\nError slackSearchMessages: An API error occurred: channel_not_found');
  });

  it('WRITES are unchanged: a failed call is still null, the container\'s error text still raw', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 502 } }));
    expect(await mcp.postMessage('u1', '#general', 'hi')).toBeNull();
    answer({ text: 'Error slackSearchMessages: An API error occurred: invalid_auth' });
    expect(await mcp.postMessage('u1', '#general', 'hi')).toBe('Error slackSearchMessages: An API error occurred: invalid_auth');
  });
});

// ── Ticket 24541fb3: DM/group-DM DISCOVERY (the review's MAJOR finding) ────────
//
// The scope fix heals DM reads BY ID, but slack_list_channels (the agent's only
// conversation-enumeration tool) requested public_channel,private_channel only —
// DMs and group-DMs were UNDISCOVERABLE even with the scopes granted. This block
// pins the discovery contract: the backend wrapper must ask the container for
// ALL conversation types by default (and honor an explicit override).
describe('slack-mcp listChannels — DM discovery (ticket 24541fb3)', () => {
  it('defaults to ALL conversation types (im,mpim included) — DMs are discoverable', async () => {
    answer({ text: 'Total: 55 channel(s)' });
    await mcp.listChannels('u1');
    const body = mockPost.mock.calls[0][1] as { params?: { arguments?: Record<string, unknown> } };
    expect(body.params?.arguments?.types).toBe('public_channel,private_channel,im,mpim');
    expect(body.params?.arguments?.limit).toBe(50);
  });

  it('an explicit types override is passed through (e.g. channels only)', async () => {
    answer({ text: 'Total: 49 channel(s)' });
    await mcp.listChannels('u1', 50, 'public_channel,private_channel');
    const body = mockPost.mock.calls[0][1] as { params?: { arguments?: Record<string, unknown> } };
    expect(body.params?.arguments?.types).toBe('public_channel,private_channel');
  });

  it('a failed listing still surfaces the readable reconnect/down line (not silently empty)', async () => {
    answer({ text: 'Error slackListChannels: An API error occurred: missing_scope, needed: im:read' });
    const out = await mcp.listChannels('u1');
    expect(out).toContain('needs re-authorizing');
  });
});

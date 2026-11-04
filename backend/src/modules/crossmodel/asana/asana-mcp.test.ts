/**
 * asana-mcp client — failure surfacing (2026-10-04, integrations/integration-error.ts).
 *
 * A failed READ used to return '' — the coding executor then answered "No
 * result from Asana — the integration may not be connected … or nothing
 * matched", and integration-context dropped the leg — so the model could not
 * tell the user to reconnect Asana or that the service was down. Pinned here:
 * a provider 401 (the container's "Error …" text) → the reconnect line; a
 * provider 5xx → the down line; the asana-mcp CONTAINER failing → the
 * platform-side line (never "reconnect"); a connected user with no usable token
 * → the reconnect line; the kill switch restores ''; an empty-but-successful
 * answer and a never-connected user still read as before; WRITES unchanged.
 *
 * Boundaries mocked: axios (the transport), ./token-manager, logger.
 * ASANA_MCP_API_KEY is read at import, so the module is required after it is set.
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
  hasAsanaConnected: (...a: any[]) => mockHasConnected(...a),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

process.env.ASANA_MCP_API_KEY = 'test-key';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = require('./asana-mcp') as typeof import('./asana-mcp');

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

describe('asana-mcp read failures surface ONE readable line', () => {
  it('a Asana 401 (the container\'s "Error …" text) tells the model to reconnect Asana', async () => {
    answer({ text: 'Error listing projects: Not Authorized' });
    expect(await mcp.listProjects('u1')).toBe('Asana list projects call was rejected by Asana (Not Authorized) — the Asana connection needs re-authorizing: Account → Integrations → Asana → reconnect.');
  });

  it('a Asana 5xx → the down line; a rate limit → the rate-limited line', async () => {
    answer({ text: 'Error listing projects: Request failed with status code 500' });
    expect(await mcp.listProjects('u1')).toMatch(/^Asana list projects call failed on Asana's side \(.+\) — Asana is unavailable right now; try again later\.$/);
    answer({ text: 'Error listing projects: You have made too many requests recently. Please, be chill.' });
    expect(await mcp.listProjects('u1')).toMatch(/^Asana list projects call was rate-limited by Asana \(.+\) — try again in a minute\.$/);
  });

  it('the asana-mcp CONTAINER failing (HTTP 502 / refused service key / unreachable / JSON-RPC error) is never "reconnect"', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }));
    expect(await mcp.listProjects('u1')).toBe("Asana list projects call failed: Digby's asana-mcp service did not answer (HTTP 502) — a platform-side outage, not the user's Asana connection (reconnecting will not help); try again shortly.");
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
    const key = await mcp.listProjects('u1');
    expect(key).toContain("refused Digby's service key");
    expect(key).not.toContain('re-authorizing');
    mockPost.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8000'), { code: 'ECONNREFUSED' }));
    expect(await mcp.listProjects('u1')).toContain('did not answer (network error: ECONNREFUSED)');
    answer({ rpcError: 'Invalid arguments' });
    expect(await mcp.listProjects('u1')).toBe('Asana list projects call failed (MCP error: Invalid arguments).');
  });

  it('a connected user whose token cannot be used → reconnect; a never-connected user stays ""', async () => {
    mockGetValidToken.mockResolvedValue(null);
    expect(await mcp.listProjects('u1')).toMatch(/^Asana list projects call could not be called: the Asana connection has no valid token \(.+\) — the user should reconnect Asana in Account → Integrations\.$/);
    mockHasConnected.mockResolvedValue(false);
    expect(await mcp.listProjects('u1')).toBe('');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('kill switch INTEGRATION_ERROR_SURFACE_DISABLED=1 restores the empty string (and the raw container text)', async () => {
    process.env.INTEGRATION_ERROR_SURFACE_DISABLED = '1';
    mockPost.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 502 } }));
    expect(await mcp.listProjects('u1')).toBe('');
    answer({ text: 'Error listing projects: Not Authorized' });
    expect(await mcp.listProjects('u1')).toBe('[Asana — Projects]\nError listing projects: Not Authorized');
    mockGetValidToken.mockResolvedValue(null);
    expect(await mcp.listProjects('u1')).toBe('');
  });

  it('an empty-but-successful answer and an unclassified error still read as the container\'s own words', async () => {
    answer({ text: 'No projects found.' });
    expect(await mcp.listProjects('u1')).toBe('[Asana — Projects]\nNo projects found.');
    answer({ text: 'Error listing projects: workspace: Not a recognized ID: 123' });
    expect(await mcp.listProjects('u1')).toBe('[Asana — Projects]\nError listing projects: workspace: Not a recognized ID: 123');
  });

  it('WRITES are unchanged: a failed call is still null, the container\'s error text still raw', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 502 } }));
    expect(await mcp.createTask('u1', { name: 'x' })).toBeNull();
    answer({ text: 'Error listing projects: Not Authorized' });
    expect(await mcp.createTask('u1', { name: 'x' })).toBe('Error listing projects: Not Authorized');
  });
});

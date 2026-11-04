/**
 * Google WRITE tools (2026-09-23, owner: "add all of that"): the one-account
 * write resolver (label / only-account / ambiguous), the granted-scope precheck
 * that turns a pre-change account into a re-consent instruction instead of a
 * Google 403, the MCP call + envelope, and the scope leaf.
 */
export {};
process.env.GOOGLE_MCP_API_KEY = 'test-key';
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockGetAllValidTokens = jest.fn();
const mockHasGoogleConnected = jest.fn();
jest.mock('./token-manager', () => ({ __esModule: true, getAllValidTokens: (...a: any[]) => mockGetAllValidTokens(...a), hasGoogleConnected: (...a: any[]) => mockHasGoogleConnected(...a) }));
const mockPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));
jest.mock('../pdf-extract', () => ({ __esModule: true, extractPdfText: jest.fn() }));
jest.mock('mammoth', () => ({ __esModule: true, extractRawText: jest.fn() }));
const mockFindFirst = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { googleOAuthToken: { findFirst: (...a: any[]) => mockFindFirst(...a) } } }));

const gm = require('./google-mcp') as typeof import('./google-mcp');
const scopes = require('./google-scopes') as typeof import('./google-scopes');
const G = 'https://www.googleapis.com/auth/';
const READ = [`${G}gmail.readonly`, `${G}gmail.send`, `${G}calendar.events`, `${G}drive.readonly`, `${G}documents.readonly`, `${G}spreadsheets.readonly`];
const ALL = [...READ, `${G}documents`, `${G}spreadsheets`, `${G}presentations`, `${G}drive.file`, `${G}gmail.compose`];

function sse(text: string) {
  return async (_url: string, body: any) => {
    const payload = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } };
    const handlers: Record<string, (...a: any[]) => void> = {};
    const stream = { on(ev: string, cb: any) { handlers[ev] = cb; if (ev === 'data') setImmediate(() => { handlers['data']?.(Buffer.from(`data: ${JSON.stringify(payload)}\n`)); handlers['end']?.(); }); return stream; }, destroy() {} };
    return { data: stream };
  };
}

beforeEach(() => { jest.clearAllMocks(); mockHasGoogleConnected.mockResolvedValue(true); mockFindFirst.mockResolvedValue({ scopes: ALL }); });

describe('google-scopes leaf', () => {
  it('names the five write scopes and what each tool needs', () => {
    expect(scopes.GOOGLE_WRITE_SCOPES).toHaveLength(5);
    expect(scopes.missingGoogleWriteScopes(READ)).toHaveLength(5);
    expect(scopes.missingGoogleWriteScopes(ALL)).toEqual([]);
    expect(scopes.missingScopesForTool('docs_create_document', READ)).toEqual([`${G}documents`]);
    expect(scopes.missingScopesForTool('calendar_create_event', READ)).toEqual([]); // already granted by the read set
    expect(scopes.missingScopesForTool('drive_upload_file', [`${G}drive`])).toEqual([]); // broad drive implies drive.file
    expect(scopes.GOOGLE_WRITE_TOOL_NAMES).toHaveLength(11);
  });
});

describe('resolveGoogleWriteAccount', () => {
  it('one account, no label → that account (when scopes suffice)', async () => {
    mockGetAllValidTokens.mockResolvedValue([{ token: 't1', label: 'Personal', email: 'p@x.com' }]);
    const r = await gm.resolveGoogleWriteAccount('u', 'docs_create_document');
    expect(r).toMatchObject({ ok: true, token: 't1', label: 'Personal' });
  });
  it('two accounts, no label → ambiguous (a write never guesses)', async () => {
    mockGetAllValidTokens.mockResolvedValue([{ token: 't1', label: 'Personal' }, { token: 't2', label: 'Work', email: 'w@x.com' }]);
    const r = await gm.resolveGoogleWriteAccount('u', 'docs_create_document');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe('ambiguous'); expect(r.message).toContain('Work (w@x.com)'); }
  });
  it('label picks the account; a missing write scope becomes the re-consent instruction', async () => {
    mockGetAllValidTokens.mockResolvedValue([{ token: 't1', label: 'Personal' }, { token: 't2', label: 'Work', email: 'w@x.com' }]);
    mockFindFirst.mockResolvedValue({ scopes: READ });
    const r = await gm.resolveGoogleWriteAccount('u', 'sheets_append_rows', 'w@x.com');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missing_scopes');
      expect(r.message).toContain('"Work" (w@x.com)');
      expect(r.message).toContain('spreadsheets');
      expect(r.message).toContain('Update permissions');
    }
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u', label: 'Work' } }));
  });
  it('not connected → the connect hint', async () => {
    mockGetAllValidTokens.mockResolvedValue([]); mockHasGoogleConnected.mockResolvedValue(false);
    const r = await gm.resolveGoogleWriteAccount('u', 'docs_create_document');
    expect(r).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});

describe('runGoogleWriteTool', () => {
  it('calls the MCP tool with the ONE resolved token and returns its text + account', async () => {
    mockGetAllValidTokens.mockResolvedValue([{ token: 'tok-work', label: 'Work', email: 'w@x.com' }]);
    mockPost.mockImplementation(sse('Created Google Doc "Plan" — documentId abc123XYZ — https://docs.google.com/document/d/abc123XYZ/edit'));
    const r = await gm.runGoogleWriteTool('u', 'docs_create_document', { title: 'Plan' });
    expect(r.ok).toBe(true);
    expect(r.account).toBe('Work (w@x.com)');
    expect(r.text).toContain('documentId abc123XYZ');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1].params).toEqual({ name: 'docs_create_document', arguments: { title: 'Plan' } });
    expect(mockPost.mock.calls[0][2].headers['X-Google-Token']).toBe('tok-work');
  });
  it('a dead google-mcp connector still answers the no_result envelope (2026-10-04: read-side error surfacing never changes writes)', async () => {
    mockGetAllValidTokens.mockResolvedValue([{ token: 'tok-work', label: 'Work', email: 'w@x.com' }]);
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
    const r = await gm.runGoogleWriteTool('u', 'docs_create_document', { title: 'Plan' });
    expect(r).toEqual({ ok: false, text: 'Google docs_create_document returned no result — the MCP bridge may be down; try again in a minute.', reason: 'no_result' });
  });
  it('refusals never reach the transport', async () => {
    mockGetAllValidTokens.mockResolvedValue([{ token: 't1', label: 'A' }, { token: 't2', label: 'B' }]);
    const r = await gm.runGoogleWriteTool('u', 'docs_create_document', { title: 'x' });
    expect(r.ok).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

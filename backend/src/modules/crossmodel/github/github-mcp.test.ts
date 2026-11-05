/**
 * github-mcp client — pins the JSON-RPC payload keys sent to the github-mcp
 * server. The server's zod schemas require snake_case (e.g. `issue_number`);
 * a camelCase key is rejected with -32602 and the tool silently returns ''.
 */
import { PassThrough } from 'stream';
import axios from 'axios';
import { getAllValidTokens } from './token-manager';

jest.mock('axios');
jest.mock('./token-manager', () => ({
  getAllValidTokens: jest.fn(),
  getValidToken: jest.fn(),
}));
jest.mock('../../../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const mockPost = axios.post as jest.Mock;
const mockTokens = getAllValidTokens as jest.Mock;

// github-mcp reads GITHUB_MCP_API_KEY into a module-level const at load time,
// so it must be set BEFORE the module is required. Requiring lazily (not a
// top-level import) keeps axios/token-manager mock instances stable.
let getIssue: typeof import('./github-mcp').getIssue;

beforeAll(() => {
  process.env.GITHUB_MCP_API_KEY = 'test-key';
  getIssue = require('./github-mcp').getIssue;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockTokens.mockResolvedValue([{ token: 'ghp_x', label: 'Personal', username: 'paul' }]);
});

/** Capture the JSON-RPC body, then answer with a matching SSE stream. */
function stubMcp(payload: object) {
  mockPost.mockImplementation((_url: string, body: any) => {
    const stream = new PassThrough();
    const id = body.id;
    // Emit on next tick, after callMcpWithToken attaches its stream handlers.
    setImmediate(() => {
      stream.write(`data: ${JSON.stringify({ id, ...payload })}\n\n`);
      stream.end();
    });
    return Promise.resolve({ data: stream });
  });
}

test('getIssue sends snake_case issue_number (server zod schema requires it)', async () => {
  stubMcp({ result: { content: [{ type: 'text', text: 'Issue body here' }] } });
  const out = await getIssue('user-1', 'example-org', 'crossmodel', 42);

  expect(mockPost).toHaveBeenCalledTimes(1);
  const body = mockPost.mock.calls[0][1];
  expect(body.params.name).toBe('github_get_issue');
  // THE regression guard: must be issue_number, NOT issueNumber.
  expect(body.params.arguments).toEqual({
    owner: 'example-org',
    repo: 'crossmodel',
    issue_number: 42,
  });
  expect(body.params.arguments).not.toHaveProperty('issueNumber');
  expect(out).toContain('[GitHub Issue #42: example-org/crossmodel]');
  expect(out).toContain('Issue body here');
});

test('a JSON-RPC error now SURFACES its reason (2026-10-04) — INTEGRATION_ERROR_SURFACE_DISABLED=1 restores the silent empty string', async () => {
  stubMcp({ error: { message: 'invalid_type: path [issue_number]' } });
  const out = await getIssue('user-1', 'o', 'r', 7);
  expect(out).toBe('GitHub get issue call failed (MCP error: invalid_type: path [issue_number]).');

  process.env.INTEGRATION_ERROR_SURFACE_DISABLED = '1';
  try {
    expect(await getIssue('user-1', 'o', 'r', 7)).toBe('');
  } finally {
    delete process.env.INTEGRATION_ERROR_SURFACE_DISABLED;
  }
});

// ── Failure surfacing (2026-10-04, integrations/integration-error.ts) ─────────
// A failed read used to reach the model as '' → "No result from GitHub — the
// integration may not be connected … or nothing matched".
describe('failed reads surface ONE readable line', () => {
  const textAnswer = (text: string) => ({ result: { content: [{ type: 'text', text }] } });

  test('a GitHub 401 ("Bad credentials" from github-mcp) tells the model to reconnect GitHub', async () => {
    stubMcp(textAnswer('Error getting issue #7: Bad credentials'));
    const out = await getIssue('user-1', 'o', 'r', 7);
    expect(out).toBe('GitHub get issue call was rejected by GitHub (Bad credentials) — the GitHub connection needs re-authorizing: Account → Integrations → GitHub → reconnect (or replace the Personal Access Token).');
  });

  test('an auth failure on one credential falls through to the next connected one', async () => {
    mockTokens.mockResolvedValue([
      { token: 'ghp_dead', label: 'Personal', username: 'paul' },
      { token: 'ghp_live', label: 'Work', username: 'workpaul' },
    ]);
    let call = 0;
    mockPost.mockImplementation((_url: string, body: any) => {
      const stream = new PassThrough();
      const text = call++ === 0 ? 'Error getting issue #7: Bad credentials' : 'Issue body from Work';
      setImmediate(() => { stream.write(`data: ${JSON.stringify({ id: body.id, result: { content: [{ type: 'text', text }] } })}\n\n`); stream.end(); });
      return Promise.resolve({ data: stream });
    });
    const out = await getIssue('user-1', 'o', 'r', 7);
    expect(out).toContain('Issue body from Work');
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  test('GitHub 5xx / rate limit text → the down / rate-limited lines', async () => {
    stubMcp(textAnswer('Error listing issues: Server Error (HTTP 502)'));
    const listIssues = require('./github-mcp').listIssues;
    expect(await listIssues('user-1', 'o', 'r')).toMatch(/^GitHub list issues call failed on GitHub's side \(Server Error \(HTTP 502\)\) — GitHub is unavailable right now; try again later\.$/);
    stubMcp(textAnswer('Error listing issues: API rate limit exceeded for user ID 1.'));
    expect(await listIssues('user-1', 'o', 'r')).toMatch(/was rate-limited by GitHub \(API rate limit exceeded/);
  });

  test('the github-mcp CONTAINER failing (HTTP 502 / service key 401) is a platform-side line, never "reconnect"', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }));
    const out = await getIssue('user-1', 'o', 'r', 7);
    expect(out).toBe("GitHub get issue call failed: Digby's github-mcp service did not answer (HTTP 502) — a platform-side outage, not the user's GitHub connection (reconnecting will not help); try again shortly.");
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
    const keyOut = await getIssue('user-1', 'o', 'r', 7);
    expect(keyOut).toContain("refused Digby's service key");
    expect(keyOut).not.toContain('re-authorizing');
  });

  test('kill switch: a container failure degrades to the empty string again', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }));
    process.env.INTEGRATION_ERROR_SURFACE_DISABLED = '1';
    try {
      expect(await getIssue('user-1', 'o', 'r', 7)).toBe('');
    } finally {
      delete process.env.INTEGRATION_ERROR_SURFACE_DISABLED;
    }
  });

  test('an empty-but-successful answer still reads as empty / the container\'s own words; no connection stays ""', async () => {
    stubMcp(textAnswer('No issues found in o/r.'));
    const listIssues = require('./github-mcp').listIssues;
    expect(await listIssues('user-1', 'o', 'r')).toBe('[GitHub Issues: o/r]\nNo issues found in o/r.');
    stubMcp(textAnswer('Error getting issue #7: Not Found'));
    expect(await getIssue('user-1', 'o', 'r', 7)).toBe('[GitHub Issue #7: o/r]\nError getting issue #7: Not Found'); // unclassified → unchanged
    mockTokens.mockResolvedValue([]);
    expect(await getIssue('user-1', 'o', 'r', 7)).toBe(''); // not connected (hasGitHubConnected unmocked → false)
  });

  // fs-code-knowledge review (2026-10-22): getFileContents is the supervisor's
  // existence check. GitHub answers 404 for a repo a token cannot SEE, so the
  // first connected account's "Not Found" text used to be returned as THE answer
  // and the account that can see the private repo was never tried.
  describe('getFileContents: a per-account "Not Found" is a miss, not the answer', () => {
    const notFound = 'Error getting file src/a.ts: Not Found - https://docs.github.com/rest/repos/contents#get-repository-content';
    const byToken = (answers: Record<string, string | Error>) => {
      mockPost.mockImplementation((_url: string, body: any, cfg: any) => {
        const a = answers[cfg.headers['X-GitHub-Token']];
        if (a instanceof Error) return Promise.reject(a);
        const stream = new PassThrough();
        setImmediate(() => { stream.write(`data: ${JSON.stringify({ id: body.id, result: { content: [{ type: 'text', text: a }] } })}\n\n`); stream.end(); });
        return Promise.resolve({ data: stream });
      });
    };
    const twoAccounts = () => mockTokens.mockResolvedValue([
      { token: 'ghp_old', label: 'Personal', username: 'paul' },
      { token: 'ghp_work', label: 'Work', username: 'workpaul' },
    ]);
    const getFileContents = () => require('./github-mcp').getFileContents as typeof import('./github-mcp').getFileContents;

    test('first account 404s, second account has the file → the second account\'s file', async () => {
      twoAccounts();
      byToken({ ghp_old: notFound, ghp_work: '# src/a.ts\n```\nexport const a = 1;\n```' });
      const out = await getFileContents()('user-1', 'example-org', 'crossmodel', 'src/a.ts');
      expect(out).toContain('export const a = 1;');
      expect(out).not.toContain('Not Found');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    test('every account 404s → the 404, saying every connected account was tried', async () => {
      twoAccounts();
      byToken({ ghp_old: notFound, ghp_work: notFound });
      const out = await getFileContents()('user-1', 'example-org', 'crossmodel', 'src/a.ts');
      expect(out).toContain('[GitHub File: example-org/crossmodel/src/a.ts]');
      expect(out).toContain('Not Found');
      expect(out).toContain('every connected GitHub account (2) answered Not Found');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    test('one account 404s, the other could not be checked → the 404 names the unchecked account', async () => {
      twoAccounts();
      byToken({ ghp_old: notFound, ghp_work: 'Error getting file src/a.ts: Bad credentials' });
      const out = await getFileContents()('user-1', 'example-org', 'crossmodel', 'src/a.ts');
      expect(out).toContain('Not Found');
      expect(out).toMatch(/1 other connected GitHub account could not be checked \(GitHub get file contents call was rejected by GitHub \(Bad credentials\)/);
    });

    test('a single account 404 stays the 404 (no account-count line)', async () => {
      byToken({ ghp_x: notFound });
      const out = await getFileContents()('user-1', 'o', 'r', 'src/a.ts');
      expect(out).toBe(`[GitHub File: o/r/src/a.ts]\n${notFound}`);
    });

    test('kill switch GITHUB_NOT_FOUND_FALLTHROUGH_DISABLED=1 → the first account\'s 404 is the answer again', async () => {
      twoAccounts();
      byToken({ ghp_old: notFound, ghp_work: 'file body' });
      process.env.GITHUB_NOT_FOUND_FALLTHROUGH_DISABLED = '1';
      try {
        const out = await getFileContents()('user-1', 'o', 'r', 'src/a.ts');
        expect(out).toBe(`[GitHub File: o/r/src/a.ts]\n${notFound}`);
        expect(mockPost).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.GITHUB_NOT_FOUND_FALLTHROUGH_DISABLED;
      }
    });

    test('other reads keep first-answer semantics (getIssue "Not Found" unchanged)', async () => {
      twoAccounts();
      byToken({ ghp_old: 'Error getting issue #7: Not Found', ghp_work: 'Issue body' });
      expect(await getIssue('user-1', 'o', 'r', 7)).toBe('[GitHub Issue #7: o/r]\nError getting issue #7: Not Found');
    });
  });

  test('listUserRepos: one failed account rides under the other\'s section; all failed → the failure lines', async () => {
    mockTokens.mockResolvedValue([
      { token: 'ghp_a', label: 'Personal', username: 'paul' },
      { token: 'ghp_b', label: 'Work', username: 'workpaul' },
    ]);
    mockPost.mockImplementation((_url: string, body: any, cfg: any) => {
      const stream = new PassThrough();
      const text = cfg.headers['X-GitHub-Token'] === 'ghp_a' ? 'repo-a' : 'Error listing repositories: Bad credentials';
      setImmediate(() => { stream.write(`data: ${JSON.stringify({ id: body.id, result: { content: [{ type: 'text', text }] } })}\n\n`); stream.end(); });
      return Promise.resolve({ data: stream });
    });
    const listUserRepos = require('./github-mcp').listUserRepos;
    const partial = await listUserRepos('user-1');
    expect(partial).toContain('--- Personal (@paul) ---\nrepo-a');
    expect(partial).toContain('--- Work (@workpaul) ---\nGitHub list repos call was rejected by GitHub (Bad credentials)');

    mockPost.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const all = await listUserRepos('user-1');
    expect(all).toContain("Digby's github-mcp service did not answer (network error: ECONNREFUSED)");
    expect(all).toContain('--- Personal (@paul) ---');
  });
});

// ── searchCode scoping (ticket 0b35a32c) ─────────────────────────────────────
// The mishap: a plain query ("065caccb") was forwarded to GitHub /search/code
// BARE — a GitHub-wide search — and returned 12 hits in unrelated PUBLIC repos
// (defold/defold, aliarabat/OpenStack, …), none in the connected account's
// repos; and repo:example-org/crossmodel returned 0 because GitHub does not
// index that user-owned private repo. These tests pin the fix: unscoped
// queries are auto-scoped per connected account; explicit scopes pass through.
let searchCode: typeof import('./github-mcp').searchCode;
let buildScopedCodeQuery: typeof import('./github-mcp').buildScopedCodeQuery;
const mockGet = axios.get as jest.Mock;

beforeAll(() => {
  searchCode = require('./github-mcp').searchCode;
  buildScopedCodeQuery = require('./github-mcp').buildScopedCodeQuery;
});

test('searchCode scopes a plain query to the connected account — REPLAY of ticket 0b35a32c', async () => {
  mockTokens.mockResolvedValue([{ token: 'ghp_replay', label: 'Personal', username: 'paul' }]);
  mockGet.mockResolvedValue({ data: [{ login: 'canada-quant' }] }); // /user/orgs
  stubMcp({ result: { content: [{ type: 'text', text: '# results' }] } });

  const out = await searchCode('user-1', '065caccb');

  expect(mockPost).toHaveBeenCalledTimes(1);
  const sentQ = mockPost.mock.calls[0][1].params.arguments.query;
  // THE regression guard: "065caccb" must NOT reach GitHub bare (ticket 0b35a32c).
  expect(sentQ).toContain('065caccb');
  expect(sentQ).toContain('user:paul');
  expect(sentQ).toContain('org:canada-quant');
  expect(sentQ).toContain('fork:true');
  expect(out).toContain('scoped to the connected GitHub account');
  expect(out).toContain('effective query:');
  expect(out).toContain('default branch only');
  // PRODUCER PIN (ticket 659b5074 review): sse-adapter's Sources-harvest gate
  // keys on this result LEADING with "[GitHub Code Search — " (both forms).
  // If this prefix ever changes, the listing gate silently stops working —
  // pin the leading marker here at the producer.
  expect(out.startsWith('[GitHub Code Search — ')).toBe(true);
});

test('searchCode passes an explicit repo: scope through unchanged (ticket 0b35a32c symptom 3 path)', async () => {
  mockTokens.mockResolvedValue([{ token: 'ghp_explicit', label: 'Personal', username: 'paul' }]);
  stubMcp({ result: { content: [{ type: 'text', text: 'No code results found' }] } });

  const out = await searchCode('user-1', 'repo:example-org/crossmodel 8e88474e');

  expect(mockPost).toHaveBeenCalledTimes(1);
  const sentQ = mockPost.mock.calls[0][1].params.arguments.query;
  expect(sentQ).toBe('repo:example-org/crossmodel 8e88474e');
  expect(mockGet).not.toHaveBeenCalled(); // no scope lookup for explicit scopes
  expect(out).toContain('explicit scope');
  expect(out).toContain('default branch only');
  // PRODUCER PIN (ticket 659b5074 review): the explicit-scope listing must
  // ALSO lead with the marker the sse-adapter harvest gate keys on.
  expect(out.startsWith('[GitHub Code Search — ')).toBe(true);
});

test('searchCode merges labeled sections across connected accounts for unscoped queries', async () => {
  mockTokens.mockResolvedValue([
    { token: 'ghp_a', label: 'Personal', username: 'paul' },
    { token: 'ghp_b', label: 'Work', username: 'workpaul' },
  ]);
  mockGet.mockResolvedValue({ data: [] }); // no orgs
  stubMcp({ result: { content: [{ type: 'text', text: 'hits' }] } });

  const out = await searchCode('user-1', 'findMe');

  expect(mockPost).toHaveBeenCalledTimes(2);
  const queries = mockPost.mock.calls.map((c) => c[1].params.arguments.query);
  expect(queries).toContain('findMe user:paul fork:true');
  expect(queries).toContain('findMe user:workpaul fork:true');
  expect(out).toContain('--- Personal (@paul)');
  expect(out).toContain('--- Work (@workpaul)');
});

test('searchCode falls back to user-only scope when the org lookup fails', async () => {
  mockTokens.mockResolvedValue([{ token: 'ghp_orgfail', label: 'Personal', username: 'paul' }]);
  mockGet.mockRejectedValue(new Error('boom'));
  stubMcp({ result: { content: [{ type: 'text', text: 'hits' }] } });

  const out = await searchCode('user-1', 'findMe');

  const sentQ = mockPost.mock.calls[0][1].params.arguments.query;
  expect(sentQ).toBe('findMe user:paul fork:true');
  expect(out).toContain('effective query:');
});

test('searchCode resolves the login via /user when token-manager has no username', async () => {
  mockTokens.mockResolvedValue([{ token: 'ghp_nousername', label: 'PAT' }]);
  mockGet
    .mockResolvedValueOnce({ data: { login: 'resolved-paul' } }) // /user
    .mockResolvedValueOnce({ data: [] }); // /user/orgs
  stubMcp({ result: { content: [{ type: 'text', text: 'hits' }] } });

  const out = await searchCode('user-1', 'findMe');

  const sentQ = mockPost.mock.calls[0][1].params.arguments.query;
  expect(sentQ).toBe('findMe user:resolved-paul fork:true');
  expect(out).not.toContain('UNSCOPED');
});

test('buildScopedCodeQuery leaves explicit scopes and unscopeable queries alone', () => {
  expect(buildScopedCodeQuery('repo:o/r term', 'paul', ['org1']).q).toBe('repo:o/r term');
  expect(buildScopedCodeQuery('term owner:paul', 'paul').q).toBe('term owner:paul');
  expect(buildScopedCodeQuery('org:canada-quant import', 'paul').q).toBe('org:canada-quant import');
  expect(buildScopedCodeQuery('   ', 'paul').scoped).toBe(false);
  expect(buildScopedCodeQuery('term').scoped).toBe(false); // no login → cannot scope
  expect(buildScopedCodeQuery('term', 'paul').q).toBe('term user:paul fork:true');
  expect(buildScopedCodeQuery('term', 'paul', ['a', 'b']).q).toBe('term user:paul org:a org:b fork:true');
});

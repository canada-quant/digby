/**
 * User-added MCP servers (ticket e294f9a4) — the service over an IN-MEMORY
 * context store (the real store module on a fake prisma): CRUD with secrets
 * encrypted at rest, the save-time probe ("self-integrating"), health
 * transitions + recovery ("self-healing"), the worker sweep, and the run seam
 * (schemas, doctrine, machine-run write gate, per-run circuit, telemetry,
 * failed calls feeding health).
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { USER_MCP_CALL: 'user_mcp_call', USER_MCP_HEALTH: 'user_mcp_health' },
}));

// ── In-memory "store" table behind the REAL context-store + user-mcp.store ──
const mockRows = new Map<string, { namespacePath: string; key: string; value: any }>();
const mk = (ns: string, key: string) => `${ns}\u0000${key}`;
const clone = (v: any) => JSON.parse(JSON.stringify(v));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    contextStoreEntry: {
      findUnique: async ({ where }: any) => {
        const r = mockRows.get(mk(where.namespacePath_key.namespacePath, where.namespacePath_key.key));
        return r ? { value: clone(r.value), expiresAt: null } : null;
      },
      upsert: async ({ where, create, update }: any) => {
        const id = mk(where.namespacePath_key.namespacePath, where.namespacePath_key.key);
        const prev = mockRows.get(id);
        mockRows.set(id, prev ? { ...prev, value: clone(update.value) } : { namespacePath: create.namespacePath, key: create.key, value: clone(create.value) });
      },
      deleteMany: async ({ where }: any) => { mockRows.delete(mk(where.namespacePath, where.key)); return { count: 1 }; },
      findMany: async ({ where }: any) => [...mockRows.values()]
        .filter((r) => r.namespacePath === where.namespacePath && (!where.key?.startsWith || r.key.startsWith(where.key.startsWith)))
        .map((r) => ({ key: r.key, value: clone(r.value) })),
    },
    $executeRaw: async (_strings: TemplateStringsArray, json: string, ns: string, key: string) => {
      const r = mockRows.get(mk(ns, key));
      if (!r) return 0;
      r.value = { ...r.value, ...JSON.parse(json) };
      return 1;
    },
  },
}));

const mockProbe = jest.fn();
const mockConnect = jest.fn();
jest.mock('./mcp-client', () => {
  const actual = jest.requireActual('./mcp-client');
  return { ...actual, probeMcpServer: (...a: any[]) => mockProbe(...a), connectMcp: (...a: any[]) => mockConnect(...a) };
});

import {
  createServer, updateServer, deleteServer, listServers, testServer, testDraft, runUserMcpHealthSweepOnce,
  loadUserMcpRunTools, _resetProbeBudget,
} from './user-mcp.service';
import { McpClientError } from './mcp-client';
import { decryptSecret } from './user-mcp.store';

const U = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOOLS = [
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
];
const okProbe = (tools = TOOLS) => ({ ok: true, latencyMs: 42, info: { transport: 'streamable_http', protocolVersion: '2025-06-18', serverName: 'linear', serverVersion: '1', instructions: null, hasTools: true }, tools, truncated: false });
const failProbe = (errorClass = 'network', error = 'connection refused') => ({ ok: false, latencyMs: 5, error, errorClass });

const ENV = { ...process.env };
beforeEach(() => {
  mockRows.clear();
  mockProbe.mockReset();
  mockConnect.mockReset();
  mockRecordLoopMetric.mockClear();
  _resetProbeBudget();
  process.env = { ...ENV, JWT_SECRET: 'unit-test-secret-'.padEnd(40, 'x') };
});
afterAll(() => { process.env = ENV; });

const addLinear = async (over: Record<string, unknown> = {}) => {
  mockProbe.mockResolvedValueOnce(okProbe());
  return createServer(U, { name: 'Linear', url: 'https://mcp.linear.app/mcp', authHeader: 'Authorization', authValue: 'lin_api_SECRET1234', templateId: 'linear', ...over });
};

describe('CRUD — secrets encrypted at rest, never returned', () => {
  it('create: stores URL + token ENCRYPTED, normalizes a bare token to "Bearer …", probes at once and caches the tools (self-integrating)', async () => {
    const { server, probe } = await addLinear();
    expect(probe).toMatchObject({ ok: true, toolCount: 2, transport: 'streamable_http', serverName: 'linear' });
    expect(mockProbe).toHaveBeenCalledWith(
      { url: 'https://mcp.linear.app/mcp', transport: 'auto', headers: { Authorization: 'Bearer lin_api_SECRET1234' } },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(server).toMatchObject({ name: 'Linear', slug: 'linear', url: 'https://mcp.linear.app/mcp', hasAuth: true, authPreview: '••••1234', enabled: true, machineWrites: false, templateId: 'linear', authUnreadable: false });
    expect(server.health.status).toBe('healthy');
    expect(server.tools.map((t) => [t.exposedName, t.readOnly, t.enabled])).toEqual([['mcp_linear_list_issues', true, true], ['mcp_linear_create_issue', false, true]]);
    const raw = JSON.stringify([...mockRows.values()]);
    expect(raw).not.toContain('lin_api_SECRET1234');
    const row = [...mockRows.values()].find((r) => r.namespacePath === 'user-mcp')!.value;
    expect(decryptSecret(row.authEnc)).toBe('Bearer lin_api_SECRET1234');
    expect(decryptSecret(row.urlEnc)).toBe('https://mcp.linear.app/mcp');
    expect(JSON.stringify(server)).not.toMatch(/SECRET1234|urlEnc|authEnc/);
  });

  it('a URL that EMBEDS a secret is stored encrypted and shown masked (query values + token-looking path segments)', async () => {
    mockProbe.mockResolvedValueOnce(okProbe());
    const { server } = await createServer(U, { name: 'Zap', url: 'https://mcp.example.com/api/s/a1B2c3D4e5F6g7H8i9J0/mcp?token=qq-SECRET-qq' });
    expect(server.url).toBe('https://mcp.example.com/api/s/••••/mcp?token=••••');
    const raw = JSON.stringify([...mockRows.values()]);
    expect(raw).not.toContain('a1B2c3D4e5F6g7H8i9J0');
    expect(raw).not.toContain('qq-SECRET-qq');
    expect(mockProbe.mock.calls[0][0].url).toBe('https://mcp.example.com/api/s/a1B2c3D4e5F6g7H8i9J0/mcp?token=qq-SECRET-qq');
  });

  it('create refuses private / plain-http URLs, reserved headers and the per-user cap; slugs stay unique', async () => {
    await expect(createServer(U, { name: 'x', url: 'https://10.0.0.1/mcp' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createServer(U, { name: 'x', url: 'http://mcp.example.com/mcp' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createServer(U, { name: 'x', url: 'https://mcp.example.com/mcp', authHeader: 'Host', authValue: 'a' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createServer(U, { name: '', url: 'https://mcp.example.com/mcp' })).rejects.toMatchObject({ statusCode: 400 });
    await addLinear();
    mockProbe.mockResolvedValueOnce(okProbe());
    const second = await createServer(U, { name: 'Linear', url: 'https://mcp.linear.app/mcp' });
    expect(second.server.slug).toBe('linear2');
    expect(second.server.hasAuth).toBe(false);
    process.env.USER_MCP_MAX_SERVERS = '2';
    await expect(createServer(U, { name: 'third', url: 'https://mcp.example.com/mcp' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('list is per user; update: rename keeps the slug, "" clears the token (re-probe), disabledTools + machineWrites persist; delete removes both rows', async () => {
    const { server } = await addLinear();
    mockProbe.mockResolvedValue(okProbe());
    await createServer(OTHER, { name: 'Other', url: 'https://mcp.example.com/mcp' });
    expect((await listServers(U)).map((s) => s.id)).toEqual([server.id]);

    const renamed = await updateServer(U, server.id, { name: 'Linear Work', disabledTools: ['create_issue'], machineWrites: true });
    expect(renamed!.server).toMatchObject({ name: 'Linear Work', slug: 'linear', machineWrites: true });
    expect(renamed!.probe).toBeNull(); // nothing connection-relevant changed
    expect(renamed!.server.tools.find((t) => t.name === 'create_issue')!.enabled).toBe(false);

    const cleared = await updateServer(U, server.id, { authValue: '' });
    expect(cleared!.server).toMatchObject({ hasAuth: false, authPreview: null, authHeader: '' });
    expect(cleared!.probe).toMatchObject({ ok: true });
    expect(mockProbe).toHaveBeenLastCalledWith(expect.objectContaining({ headers: {} }), expect.anything());

    expect(await updateServer(OTHER, server.id, { name: 'hijack' })).toBeNull();
    expect(await deleteServer(OTHER, server.id)).toBe(false);
    expect(await deleteServer(U, server.id)).toBe(true);
    expect([...mockRows.keys()].some((k) => k.includes(server.id))).toBe(false);
  });

  it('testDraft probes WITHOUT storing anything and scrubs the token from the error', async () => {
    mockProbe.mockResolvedValueOnce(failProbe('auth', 'HTTP 401 — rejected Bearer draft-TOKEN-xyz'));
    const p = await testDraft(U, { url: 'https://mcp.example.com/mcp', authHeader: 'Authorization', authValue: 'draft-TOKEN-xyz' });
    expect(p).toMatchObject({ ok: false, errorClass: 'auth' });
    expect(p.error).toBe('HTTP 401 — rejected •••');
    expect(mockRows.size).toBe(0);
  });

  it('USER_MCP_DISABLED=1: the CRUD answers 404 and runs get no tools', async () => {
    await addLinear();
    process.env.USER_MCP_DISABLED = '1';
    await expect(listServers(U)).rejects.toMatchObject({ statusCode: 404 });
    expect(await loadUserMcpRunTools(U, { machine: false })).toBeNull();
    expect(await runUserMcpHealthSweepOnce()).toMatch(/disabled/);
  });
});

describe('health — degraded → unhealthy → auto-recovery (self-healing)', () => {
  it('Test failures degrade, then mark unhealthy (tools omitted with ONE status line); a good probe heals and re-syncs the tool list', async () => {
    const { server } = await addLinear();
    mockProbe.mockResolvedValue(failProbe());
    const t1 = await testServer(U, server.id);
    expect(t1!.server.health).toMatchObject({ status: 'degraded', consecutiveFailures: 1, lastErrorClass: 'network' });
    // degraded still offers the tools, with a flaky note
    let run = await loadUserMcpRunTools(U, { machine: false });
    expect(run!.toolCount).toBe(2);
    expect(run!.statusLines[0]).toMatch(/flaky/);
    await testServer(U, server.id);
    const t3 = await testServer(U, server.id);
    expect(t3!.server.health.status).toBe('unhealthy');
    run = await loadUserMcpRunTools(U, { machine: false });
    expect(run!.toolCount).toBe(0);
    expect(run!.statusLines).toEqual([expect.stringMatching(/^MCP server "Linear" is UNHEALTHY \(network: connection refused.*tools are omitted this run/)]);
    expect(run!.doctrine).toMatch(/- Linear: UNHEALTHY/);
    // the server comes back with one more tool
    mockProbe.mockResolvedValue(okProbe([...TOOLS, { name: 'search_docs', description: 'Search', annotations: { readOnlyHint: true } } as any]));
    const healed = await testServer(U, server.id);
    expect(healed!.server.health).toMatchObject({ status: 'healthy', consecutiveFailures: 0, lastError: null });
    expect(healed!.server.tools.map((t) => t.name)).toEqual(['list_issues', 'create_issue', 'search_docs']);
    const transitions = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === 'user_mcp_health').map((m) => `${m.meta.from}>${m.meta.to}`);
    expect(transitions).toEqual(['unknown>healthy', 'healthy>degraded', 'degraded>unhealthy', 'unhealthy>healthy']);
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((m) => m.meta?.to === 'healthy' && m.meta?.from === 'unhealthy').meta.recovered).toBe(true);
  });

  it('a 401 is unhealthy at once; a token change resets health and re-probes', async () => {
    const { server } = await addLinear();
    mockProbe.mockResolvedValueOnce(failProbe('auth', 'HTTP 401 — the server rejected the credentials'));
    expect((await testServer(U, server.id))!.server.health.status).toBe('unhealthy');
    mockProbe.mockResolvedValueOnce(okProbe());
    const fixed = await updateServer(U, server.id, { authValue: 'lin_api_NEW99999' });
    expect(fixed!.probe).toMatchObject({ ok: true });
    expect(fixed!.server).toMatchObject({ authPreview: '••••9999', health: { status: 'healthy', consecutiveFailures: 0 } });
  });

  it('the sweep probes only ENABLED servers that are DUE, and reports a one-line summary', async () => {
    const a = await addLinear();
    mockProbe.mockResolvedValueOnce(okProbe());
    const b = await createServer(U, { name: 'Paused', url: 'https://mcp.example.com/mcp', enabled: false });
    expect(b.probe).toBeNull(); // a disabled server is not probed on save
    mockProbe.mockReset();
    // a is healthy, next check in 30 min ⇒ not due now
    expect(await runUserMcpHealthSweepOnce()).toMatch(/^servers 2, checked 0,/);
    expect(mockProbe).not.toHaveBeenCalled();
    mockProbe.mockResolvedValue(failProbe('timeout', 'the server did not answer in time'));
    const later = Date.now() + 31 * 60_000;
    const summary = await runUserMcpHealthSweepOnce(later);
    expect(summary).toMatch(/^servers 2, checked 1, healthy 0, degraded 1, unhealthy 0, recovered 0/);
    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect((await listServers(U)).find((s) => s.id === a.server.id)!.health.status).toBe('degraded');
  });
});

describe('the run seam (loadUserMcpRunTools)', () => {
  const fakeConn = (callTool: jest.Mock) => ({ info: {}, listTools: jest.fn(), callTool, close: jest.fn(async () => {}) });

  it('offers mcp_<slug>_<tool> schemas + a doctrine naming the server; disabled tools are left out', async () => {
    const { server } = await addLinear();
    await updateServer(U, server.id, { disabledTools: ['create_issue'] });
    const run = await loadUserMcpRunTools(U, { machine: false });
    expect(run!.schemas.map((s) => s.function.name)).toEqual(['mcp_linear_list_issues']);
    expect(run!.schemas[0].function.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
    expect(run!.doctrine).toMatch(/## Your MCP servers/);
    expect(run!.doctrine).toMatch(/- Linear — 1 tool\(s\): mcp_linear_list_issues/);
    expect(run!.serverHints).toEqual(expect.arrayContaining(['linear']));
    expect(await loadUserMcpRunTools(OTHER, { machine: false })).toBeNull();
    expect(await loadUserMcpRunTools(null, { machine: false })).toBeNull();
  });

  it('an UNATTENDED run sees read-only tools only (unless the user allowed machine writes); a by-name write call is refused', async () => {
    const { server } = await addLinear();
    let run = await loadUserMcpRunTools(U, { machine: true });
    expect(run!.schemas.map((s) => s.function.name)).toEqual(['mcp_linear_list_issues']);
    expect(run!.doctrine).toMatch(/1 tool\(s\) that change data are withheld/);
    // the human run sees both; calling the write from a MACHINE context is refused before any network
    run = await loadUserMcpRunTools(U, { machine: false });
    const refused = JSON.parse(await run!.execute('mcp_linear_create_issue', { title: 'x' }, { machineTriggered: true }));
    expect(refused).toMatchObject({ ok: false, reason: 'machine_run' });
    expect(mockConnect).not.toHaveBeenCalled();
    await updateServer(U, server.id, { machineWrites: true });
    run = await loadUserMcpRunTools(U, { machine: true });
    expect(run!.schemas.map((s) => s.function.name)).toEqual(['mcp_linear_list_issues', 'mcp_linear_create_issue']);
  });

  it('per-server and total tool caps bound the list', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, description: 'x', annotations: { readOnlyHint: true } }));
    mockProbe.mockResolvedValueOnce(okProbe(many as any));
    await createServer(U, { name: 'Big', url: 'https://mcp.example.com/mcp' });
    mockProbe.mockResolvedValueOnce(okProbe(many as any));
    await createServer(U, { name: 'Big2', url: 'https://mcp2.example.com/mcp' });
    process.env.USER_MCP_MAX_TOOLS_PER_SERVER = '20';
    process.env.USER_MCP_MAX_TOOLS_TOTAL = '25';
    const run = await loadUserMcpRunTools(U, { machine: false });
    expect(run!.toolCount).toBe(25);
    expect(run!.schemas.filter((s) => s.function.name.startsWith('mcp_big_'))).toHaveLength(20);
  });

  it('execute: success is labelled + telemetered and feeds health; the token is scrubbed from the result', async () => {
    await addLinear();
    const callTool = jest.fn(async () => ({ content: [{ type: 'text', text: 'ISSUE-1 open (auth was Bearer lin_api_SECRET1234)' }] }));
    mockConnect.mockResolvedValue(fakeConn(callTool));
    const run = await loadUserMcpRunTools(U, { machine: false });
    const out = await run!.execute('mcp_linear_list_issues', { q: 'bug' }, { userTurnAt: new Date(), sessionId: 'chat-1', runId: 'run-1' });
    expect(out).toBe('[MCP · Linear · list_issues]\nISSUE-1 open (auth was •••)');
    expect(callTool).toHaveBeenCalledWith('list_issues', { q: 'bug' }, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(mockConnect).toHaveBeenCalledWith({ url: 'https://mcp.linear.app/mcp', transport: 'streamable_http', headers: { Authorization: 'Bearer lin_api_SECRET1234' } }, expect.anything());
    const row = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((m) => m.kind === 'user_mcp_call');
    expect(row).toMatchObject({ sessionId: 'chat-1', runId: 'run-1', unit: 'ms', meta: { slug: 'linear', tool: 'list_issues', ok: true, errorClass: null, machine: false, readOnly: true } });
    // the connection is reused within the run
    await run!.execute('mcp_linear_list_issues', {}, { userTurnAt: new Date() });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect((await listServers(U))[0].health).toMatchObject({ status: 'healthy', callsOk: 2 });
  });

  it('execute: a tool\'s own isError and a JSON-RPC rejection are NOT server failures; a transport failure is (and short-circuits after 2 in one run)', async () => {
    await addLinear();
    const callTool = jest.fn()
      .mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'title is required' }] })
      .mockRejectedValueOnce(new McpClientError('rpc', 'the server answered an error -32602: bad params', undefined, { rpcCode: -32602 }))
      .mockRejectedValueOnce(new McpClientError('network', 'connection refused'))
      .mockRejectedValueOnce(new McpClientError('timeout', 'the server did not answer in time'));
    mockConnect.mockResolvedValue(fakeConn(callTool));
    const run = await loadUserMcpRunTools(U, { machine: false });
    const ctx = { userTurnAt: new Date() };
    expect(await run!.execute('mcp_linear_create_issue', {}, ctx)).toMatch(/^\[MCP · Linear · create_issue — the TOOL reported an error\]\ntitle is required/);
    expect(await run!.execute('mcp_linear_create_issue', {}, ctx)).toMatch(/the server rejected the call\]\nthe server answered an error -32602/);
    expect(await run!.execute('mcp_linear_list_issues', {}, ctx)).toMatch(/^MCP SERVER UNAVAILABLE — "Linear" did not answer list_issues: connection refused\. Do not retry/);
    expect(await run!.execute('mcp_linear_list_issues', {}, ctx)).toMatch(/^MCP SERVER UNAVAILABLE .*did not answer in time/);
    expect(await run!.execute('mcp_linear_list_issues', {}, ctx)).toMatch(/failed 2 times this run; not calling it again/);
    expect(callTool).toHaveBeenCalledTimes(4);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
    const h = (await listServers(U))[0].health;
    expect(h.status).toBe('degraded');
    expect(h.callsFailed).toBeGreaterThanOrEqual(1);
    const kinds = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === 'user_mcp_call').map((m) => m.meta.errorClass);
    expect(kinds).toEqual(['tool_error', 'rpc', 'network', 'timeout']);
  });

  it('an unknown mcp_ name answers not_available', async () => {
    await addLinear();
    const run = await loadUserMcpRunTools(U, { machine: false });
    expect(JSON.parse(await run!.execute('mcp_linear_nope', {}, { userTurnAt: new Date() }))).toMatchObject({ ok: false, reason: 'not_available' });
  });

  it('a server never reached is listed as "not connected yet" and offers nothing; a disabled server is invisible', async () => {
    mockProbe.mockResolvedValueOnce(failProbe('auth', 'HTTP 401'));
    const { server } = await createServer(U, { name: 'Notion', url: 'https://mcp.notion.com/mcp' });
    let run = await loadUserMcpRunTools(U, { machine: false });
    expect(run!.toolCount).toBe(0);
    expect(run!.statusLines[0]).toMatch(/"Notion" is UNHEALTHY \(auth: HTTP 401/);
    await updateServer(U, server.id, { enabled: false });
    run = await loadUserMcpRunTools(U, { machine: false });
    expect(run).toBeNull();
  });
});

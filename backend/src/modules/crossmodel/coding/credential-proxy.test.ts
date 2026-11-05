/**
 * build 2026-10-08 ISO — the credential proxy (credential-proxy.ts): the raw
 * platform OAuth token is injected UPSTREAM by the backend, never handed to
 * the sandbox. Capabilities (HMAC from JWT_SECRET, expiry, session-bound),
 * the fail-to-direct decision, the scrubber values, the route allowlist and
 * the streaming handler on a real Express app with a fake upstream.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import {
  mintCapability, verifyCapability, credentialProxyBaseUrl, decideProxyEnv, buildProxyEnv, credentialScrubValues,
  countRawPlatformCreds, resolveUpstream, handleCredentialProxy, credentialProxyHealth, CAP_TTL_MS,
  __resetCredentialProxyMemoForTest, buildGhKitEnv, ghProxyShellPrefix, ghKitEnabled, GH_KIT_ROOT, type ProxyDeps,
} from './credential-proxy';

const SECRET_ENV = { JWT_SECRET: 's'.repeat(48), FRONTEND_URL: 'https://digby.ai,http://localhost:8247' } as any;
const U = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

beforeEach(() => { __resetCredentialProxyMemoForTest(); });

describe('capabilities', () => {
  it('round-trips; a tampered, expired, or unsigned capability is refused', () => {
    const now = 1_700_000_000_000;
    const cap = mintCapability({ sessionId: 's1', userId: U, githubLabel: 'Work' }, now, SECRET_ENV)!;
    expect(cap).toMatch(/^dcp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyCapability(cap, now + 1000, SECRET_ENV)).toEqual({ sessionId: 's1', userId: U, githubLabel: 'Work', exp: now + CAP_TTL_MS });
    const [p, payload, sig] = cap.split('.');
    const forged = Buffer.from(JSON.stringify({ s: 's1', u: 'attacker', l: null, e: now + CAP_TTL_MS })).toString('base64url');
    expect(verifyCapability(`${p}.${forged}.${sig}`, now, SECRET_ENV)).toBeNull();
    expect(verifyCapability(`${p}.${payload}.${sig.slice(0, -2)}AA`, now, SECRET_ENV)).toBeNull();
    expect(verifyCapability(cap, now + CAP_TTL_MS + 1, SECRET_ENV)).toBeNull();
    expect(verifyCapability(cap, now, { JWT_SECRET: 'x'.repeat(48) } as any)).toBeNull(); // other key
    expect(mintCapability({ sessionId: 's1', userId: U }, now, {} as any)).toBeNull();
  });
  it('the base URL is FRONTEND_URL\'s first https entry + the proxy path (http / unset → null)', () => {
    expect(credentialProxyBaseUrl(SECRET_ENV)).toBe('https://digby.ai/api/crossmodel/coding/cred-proxy');
    expect(credentialProxyBaseUrl({ FRONTEND_URL: 'http://localhost:8247' } as any)).toBeNull();
    expect(credentialProxyBaseUrl({} as any)).toBeNull();
  });
});

describe('decideProxyEnv (fail-to-direct)', () => {
  const healthy = jest.fn(async () => new Response(JSON.stringify({ ok: true, credentialProxy: true }), { status: 200 })) as any;
  it('switch off → direct (no fetch)', async () => {
    expect(await decideProxyEnv({ userId: U, sessionId: 's1' }, { env: SECRET_ENV, fetchImpl: healthy })).toEqual({ mode: 'direct', reason: 'switch' });
    expect(healthy).not.toHaveBeenCalled();
  });
  it('canary user + https base + key + healthy proxy → proxy with a verifiable capability', async () => {
    const env = { ...SECRET_ENV, CODING_CREDENTIAL_PROXY: U.slice(0, 8) };
    const d = await decideProxyEnv({ userId: U, sessionId: 's1' }, { env, fetchImpl: healthy });
    expect(d.mode).toBe('proxy');
    expect(verifyCapability((d as any).cap, Date.now(), env)?.sessionId).toBe('s1');
  });
  it('unreachable proxy / no https base / no key → fail_to_direct with the reason', async () => {
    const env = { ...SECRET_ENV, CODING_CREDENTIAL_PROXY: '1' };
    const down = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    expect(await decideProxyEnv({ userId: U, sessionId: 's1' }, { env, fetchImpl: down })).toEqual({ mode: 'fail_to_direct', reason: 'proxy_unreachable' });
    expect(await decideProxyEnv({ userId: U, sessionId: 's1' }, { env: { ...env, FRONTEND_URL: 'http://x' }, fetchImpl: healthy })).toEqual({ mode: 'fail_to_direct', reason: 'no_https_base_url' });
    expect(await decideProxyEnv({ userId: U, sessionId: 's1' }, { env: { ...env, JWT_SECRET: '' }, fetchImpl: healthy })).toEqual({ mode: 'fail_to_direct', reason: 'no_signing_key' });
  });
});

describe('the shell env + the scrubber', () => {
  it('proxy env carries NO raw platform credential; the capability is scrubbed, github.com is not', () => {
    const env: Record<string, string> = { AWS_SECRET_ACCESS_KEY: 'user-managed-secret-123', ...buildProxyEnv('https://digby.ai/api/crossmodel/coding/cred-proxy', 'dcp1.payload.sig-long', ['github']) };
    expect(countRawPlatformCreds(env)).toBe(0);
    expect(env.GIT_CONFIG_KEY_0).toBe('url.https://digby.ai/api/crossmodel/coding/cred-proxy/git/github.com/.insteadOf');
    expect(env.GIT_CONFIG_VALUE_1).toBe('X-Digby-Cap: dcp1.payload.sig-long');
    const scrub = credentialScrubValues(env);
    expect(scrub).toEqual(expect.arrayContaining(['dcp1.payload.sig-long', 'X-Digby-Cap: dcp1.payload.sig-long', 'user-managed-secret-123']));
    expect(scrub).not.toContain('https://github.com/');
    expect(scrub).not.toContain('https://digby.ai/api/crossmodel/coding/cred-proxy');
  });
  it('direct mode keeps today\'s rule: every value ≥ 8 chars', () => {
    const env = { GITHUB_TOKEN: 'gho_abcdefgh123', GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', SHORT: 'abc' };
    expect(credentialScrubValues(env)).toEqual(['gho_abcdefgh123', 'credential.https://github.com.helper']);
    expect(countRawPlatformCreds(env)).toBe(1);
  });
});

describe('resolveUpstream — the fixed allowlist', () => {
  it('git: only smart-HTTP paths on github.com', () => {
    expect(resolveUpstream('git', undefined, ['github.com', 'o', 'r.git', 'info', 'refs'], '?service=git-upload-pack')).toMatchObject({ url: 'https://github.com/o/r.git/info/refs?service=git-upload-pack', op: 'info_refs', auth: 'basic' });
    expect(resolveUpstream('git', undefined, ['github.com', 'o', 'r', 'git-receive-pack'], '')).toMatchObject({ op: 'push' });
    expect(resolveUpstream('git', undefined, ['github.com', 'o', 'r.git', 'git-upload-pack'], '')).toMatchObject({ op: 'fetch' });
    expect(resolveUpstream('git', undefined, ['github.com', 'settings', 'tokens'], '')).toHaveProperty('error');
    expect(resolveUpstream('git', undefined, ['gitlab.com', 'o', 'r', 'git-upload-pack'], '')).toHaveProperty('error');
    expect(resolveUpstream('git', undefined, ['github.com', 'o', 'r', 'info', 'refs'], '')).toHaveProperty('error'); // no ?service=
    expect(resolveUpstream('git', undefined, ['github.com', '..', 'r', 'git-upload-pack'], '')).toHaveProperty('error');
  });
  it('api: four provider hosts, nothing else', () => {
    expect(resolveUpstream('api', 'github', ['repos', 'o', 'r', 'pulls'], '?state=open')).toMatchObject({ url: 'https://api.github.com/repos/o/r/pulls?state=open', auth: 'bearer' });
    expect(resolveUpstream('api', 'google', ['sheets.googleapis.com', 'v4', 'spreadsheets', 'abc:batchUpdate'], '')).toMatchObject({ url: 'https://sheets.googleapis.com/v4/spreadsheets/abc:batchUpdate' });
    expect(resolveUpstream('api', 'google', ['evil.example.com', 'x'], '')).toHaveProperty('error');
    expect(resolveUpstream('api', 'slack', ['chat.postMessage'], '')).toMatchObject({ url: 'https://slack.com/api/chat.postMessage' });
    expect(resolveUpstream('api', 'asana', ['tasks', '1'], '')).toMatchObject({ url: 'https://app.asana.com/api/1.0/tasks/1' });
    expect(resolveUpstream('api', 'aws', ['x'], '')).toHaveProperty('error');
  });
  it('build 2026-10-11 ISO-GH: api.github.com/graphql is op graphql; the API root (gh auth status) resolves; still only api.github.com', () => {
    expect(resolveUpstream('api', 'github', ['graphql'], '')).toMatchObject({ url: 'https://api.github.com/graphql', op: 'graphql', auth: 'bearer' });
    expect(resolveUpstream('api', 'github', ['repos', 'o', 'r', 'graphql'], '')).toMatchObject({ op: 'api' });
    expect(resolveUpstream('api', 'github', [], '')).toMatchObject({ url: 'https://api.github.com/', op: 'api' });
    expect(resolveUpstream('api', 'github', ['..', 'x'], '')).toHaveProperty('error');
  });
});

describe('the gh kit env (build 2026-10-11 ISO-GH)', () => {
  it('code + a short versioned path — no secret, nothing the scrubber masks, socket path far under the 108-byte cap', () => {
    const base = 'https://digby.ai/api/crossmodel/coding/cred-proxy';
    const kit = buildGhKitEnv(base);
    expect(kit.DIGBY_GH_KIT_DIR).toMatch(new RegExp(`^${GH_KIT_ROOT}/[0-9a-f]{12}$`));
    expect(Buffer.byteLength(`${kit.DIGBY_GH_KIT_DIR}/fw.sock`)).toBeLessThan(100);
    expect(buildGhKitEnv('https://other.example/x').DIGBY_GH_KIT_DIR).not.toBe(kit.DIGBY_GH_KIT_DIR); // base in the version
    const env = { ...buildProxyEnv(base, 'dcp1.payload.sig-long', ['github']), ...kit };
    expect(countRawPlatformCreds(env)).toBe(0);
    expect(JSON.stringify(kit)).not.toMatch(/dcp1\.|gho_/);
    const scrub = credentialScrubValues(env);
    expect(scrub).toContain('dcp1.payload.sig-long');
    for (const v of Object.values(kit)) expect(scrub).not.toContain(v);
    expect(ghProxyShellPrefix(env)).toContain('__digby_gh_kit');
    expect(ghProxyShellPrefix({ GITHUB_TOKEN: 'gho_x' })).toBe('');
    expect(ghKitEnabled({} as any)).toBe(true);
    expect(ghKitEnabled({ CREDENTIAL_PROXY_GH_DISABLED: '1' } as any)).toBe(false);
  });
});

describe('handleCredentialProxy on a real Express app', () => {
  let base: string;
  let server: import('http').Server;
  let upstreamCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: Buffer | null }>;
  let rows: any[];
  let session: { userId: string; status: string } | null;
  let token: string | null;
  let upstreamImpl: (url: string) => Response | Promise<Response>;
  const prevSecret = process.env.JWT_SECRET;

  const deps: ProxyDeps = {
    fetchImpl: (async (url: any, init: any) => {
      let body: Buffer | null = null;
      if (init?.body) {
        if (typeof init.body === 'string') body = Buffer.from(init.body);
        else { const chunks: Buffer[] = []; for await (const c of init.body as any) chunks.push(Buffer.from(c)); body = Buffer.concat(chunks); }
      }
      upstreamCalls.push({ url: String(url), method: init.method, headers: init.headers, body });
      return upstreamImpl(String(url));
    }) as any,
    loadSession: async () => session,
    tokenFor: async () => token,
    record: (meta) => rows.push(meta),
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET_ENV.JWT_SECRET;
    const app = express();
    app.use(express.json());
    app.get('/coding/cred-proxy/health', credentialProxyHealth);
    app.get('/coding/cred-proxy/git/*splat', (req, res) => { void handleCredentialProxy('git', req, res, deps); });
    app.post('/coding/cred-proxy/git/*splat', (req, res) => { void handleCredentialProxy('git', req, res, deps); });
    app.get('/coding/cred-proxy/api/:provider/*splat', (req, res) => { void handleCredentialProxy('api', req, res, deps); });
    app.get('/coding/cred-proxy/api/:provider', (req, res) => { void handleCredentialProxy('api', req, res, deps); });
    app.post('/coding/cred-proxy/api/:provider/*splat', (req, res) => { void handleCredentialProxy('api', req, res, deps); });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/coding/cred-proxy`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    if (prevSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevSecret;
  });
  beforeEach(() => {
    upstreamCalls = []; rows = [];
    session = { userId: U, status: 'ready' };
    token = 'gho_REALTOKEN_never_in_the_sandbox';
    upstreamImpl = () => new Response('001e# service=git-upload-pack\n0000', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
  });
  const cap = () => mintCapability({ sessionId: 's1', userId: U }, Date.now(), process.env)!;

  it('health answers without a capability (the fail-to-direct probe target)', async () => {
    const r = await fetch(`${base}/health`);
    expect(await r.json()).toEqual({ ok: true, credentialProxy: true });
  });

  it('no / bad capability, an archived or foreign session → uniform 401, nothing forwarded', async () => {
    expect((await fetch(`${base}/git/github.com/o/r.git/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect((await fetch(`${base}/git/github.com/o/r.git/info/refs?service=git-upload-pack`, { headers: { 'x-digby-cap': 'dcp1.x.y' } })).status).toBe(401);
    session = { userId: U, status: 'archived' };
    expect((await fetch(`${base}/git/github.com/o/r.git/info/refs?service=git-upload-pack`, { headers: { 'x-digby-cap': cap() } })).status).toBe(401);
    session = { userId: 'someone-else', status: 'ready' };
    expect((await fetch(`${base}/git/github.com/o/r.git/info/refs?service=git-upload-pack`, { headers: { 'x-digby-cap': cap() } })).status).toBe(401);
    expect(upstreamCalls).toEqual([]);
  });

  it('git info/refs: the REAL token goes upstream as Basic auth; the capability never does; body streams back', async () => {
    const r = await fetch(`${base}/git/github.com/o/r.git/info/refs?service=git-upload-pack`, { headers: { 'x-digby-cap': cap(), 'git-protocol': 'version=2', authorization: 'Basic c2FuZGJveDp4' } });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('service=git-upload-pack');
    expect(r.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement');
    const call = upstreamCalls[0];
    expect(call.url).toBe('https://github.com/o/r.git/info/refs?service=git-upload-pack');
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('x-access-token:gho_REALTOKEN_never_in_the_sandbox').toString('base64')}`);
    expect(call.headers['x-digby-cap']).toBeUndefined();
    expect(call.headers['git-protocol']).toBe('version=2');
    expect(call.headers['accept-encoding']).toBe('identity');
    expect(rows).toEqual([]); // a successful info/refs is the pack op's preamble — not counted
  });

  it('git push: the pack body is forwarded byte-for-byte and one push row is recorded', async () => {
    upstreamImpl = () => new Response('000eunpack ok\n0000', { status: 200 });
    const pack = Buffer.from([0x30, 0x30, 0x39, 0x34, 0x00, 0xff, 0x10, 0x20]);
    const r = await fetch(`${base}/git/github.com/o/r.git/git-receive-pack`, { method: 'POST', headers: { 'x-digby-cap': cap(), 'content-type': 'application/x-git-receive-pack-request' }, body: pack });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('unpack ok');
    expect(upstreamCalls[0].body?.equals(pack)).toBe(true);
    expect(rows).toEqual([expect.objectContaining({ phase: 'request', provider: 'github', op: 'push', status: 200, ok: true })]);
  });

  it('a path outside the allowlist → 400 + a refused row; a provider not connected → 403', async () => {
    expect((await fetch(`${base}/git/github.com/settings/tokens`, { headers: { 'x-digby-cap': cap() } })).status).toBe(400);
    expect(rows[0]).toMatchObject({ op: 'refused', status: 400 });
    token = null;
    const r = await fetch(`${base}/api/github/user`, { headers: { 'x-digby-cap': cap() } });
    expect(r.status).toBe(403);
    expect(rows[1]).toMatchObject({ provider: 'github', status: 403, reason: 'not_connected' });
    expect(upstreamCalls).toEqual([]);
  });

  it('ISO canary 2026-10-09: git with NO connected GitHub account goes upstream anonymously (direct-mode parity) — never with sandbox auth', async () => {
    // Prod replay: the test account (no GitHub link) fetched the public octocat repo through the proxy and got 403 not_connected.
    token = null;
    const r = await fetch(`${base}/git/github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${cap()}` } });
    expect(r.status).toBe(200);
    expect(upstreamCalls[0].url).toBe('https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack');
    expect(upstreamCalls[0].headers.authorization).toBeUndefined();
    expect(upstreamCalls[0].headers['x-digby-cap']).toBeUndefined();
    upstreamImpl = () => new Response('0008NAK\n', { status: 200 });
    const f = await fetch(`${base}/git/github.com/octocat/Hello-World.git/git-upload-pack`, { method: 'POST', headers: { 'x-digby-cap': cap(), 'content-type': 'application/x-git-upload-pack-request' }, body: Buffer.from('0000') });
    expect(f.status).toBe(200);
    expect(upstreamCalls[1].headers.authorization).toBeUndefined();
    expect(rows).toEqual([expect.objectContaining({ provider: 'github', op: 'fetch', status: 200, ok: true, anonymous: true })]);
    // GitHub's own refusal of a private repo passes through unchanged.
    upstreamImpl = () => new Response('', { status: 401 });
    expect((await fetch(`${base}/git/github.com/o/private.git/info/refs?service=git-upload-pack`, { headers: { 'x-digby-cap': cap() } })).status).toBe(401);
    // REST and the kill switch keep the 403.
    expect((await fetch(`${base}/api/github/user`, { headers: { 'x-digby-cap': cap() } })).status).toBe(403);
    process.env.CREDENTIAL_PROXY_ANON_GIT_DISABLED = '1';
    try {
      expect((await fetch(`${base}/git/github.com/o/r.git/info/refs?service=git-upload-pack`, { headers: { 'x-digby-cap': cap() } })).status).toBe(403);
    } finally { delete process.env.CREDENTIAL_PROXY_ANON_GIT_DISABLED; }
  });

  it('REST passthrough: Bearer token upstream, a JSON body re-serialized, Authorization: Bearer <cap> accepted', async () => {
    upstreamImpl = () => new Response(JSON.stringify({ number: 7 }), { status: 201, headers: { 'content-type': 'application/json' } });
    const r = await fetch(`${base}/api/github/repos/o/r/pulls`, { method: 'POST', headers: { authorization: `Bearer ${cap()}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 't', head: 'h', base: 'main' }) });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ number: 7 });
    expect(upstreamCalls[0]).toMatchObject({ url: 'https://api.github.com/repos/o/r/pulls', method: 'POST' });
    expect(upstreamCalls[0].headers.authorization).toBe('Bearer gho_REALTOKEN_never_in_the_sandbox');
    expect(JSON.parse(upstreamCalls[0].body!.toString())).toEqual({ title: 't', head: 'h', base: 'main' });
    expect(rows[0]).toMatchObject({ provider: 'github', op: 'api', status: 201, ok: true });
  });

  it('build 2026-10-11 ISO-GH: a gh GraphQL call — op graphql, client gh; the gh tag and the capability never go upstream', async () => {
    upstreamImpl = () => new Response(JSON.stringify({ data: { viewer: { login: 'octocat' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const r = await fetch(`${base}/api/github/graphql`, { method: 'POST', headers: { 'x-digby-cap': cap(), 'x-digby-client': 'gh', 'content-type': 'application/json; charset=utf-8', 'user-agent': 'GitHub CLI 2.100.0' }, body: JSON.stringify({ query: 'query{viewer{login}}' }) });
    expect(await r.json()).toEqual({ data: { viewer: { login: 'octocat' } } });
    expect(upstreamCalls[0]).toMatchObject({ url: 'https://api.github.com/graphql', method: 'POST' });
    expect(upstreamCalls[0].headers['x-digby-client']).toBeUndefined();
    expect(upstreamCalls[0].headers['x-digby-cap']).toBeUndefined();
    expect(upstreamCalls[0].headers.authorization).toBe('Bearer gho_REALTOKEN_never_in_the_sandbox');
    expect(JSON.stringify(upstreamCalls[0])).not.toContain('dcp1.');
    expect(rows).toEqual([expect.objectContaining({ provider: 'github', op: 'graphql', status: 200, ok: true, client: 'gh' })]);
    // the API root (gh auth status reads X-OAuth-Scopes there); gh's User-Agent alone tags the row too
    upstreamImpl = () => new Response('{}', { status: 200, headers: { 'x-oauth-scopes': 'repo' } });
    const root = await fetch(`${base}/api/github`, { headers: { 'x-digby-cap': cap(), 'user-agent': 'GitHub CLI 2.100.0' } });
    expect(root.headers.get('x-oauth-scopes')).toBe('repo');
    expect(upstreamCalls[1].url).toBe('https://api.github.com/');
    expect(rows[1]).toMatchObject({ op: 'api', status: 200, client: 'gh' });
    // without the tag a plain curl row carries no client
    await fetch(`${base}/api/github/user`, { headers: { 'x-digby-cap': cap() } });
    expect(rows[2].client).toBeUndefined();
  });

  it('an unreachable upstream → 502 and an ok:false row', async () => {
    upstreamImpl = () => { throw new Error('ENOTFOUND'); };
    const r = await fetch(`${base}/git/github.com/o/r.git/git-upload-pack`, { method: 'POST', headers: { 'x-digby-cap': cap(), 'content-type': 'application/x-git-upload-pack-request' }, body: '0000' });
    expect(r.status).toBe(502);
    expect(rows[0]).toMatchObject({ op: 'fetch', status: 502, ok: false });
  });
});

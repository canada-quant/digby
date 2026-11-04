/**
 * build 2026-10-11 ISO-GH — the gh CLI through the credential proxy, end to end.
 *
 * The chain under test is the one a proxy-mode lane runs, with nothing mocked
 * but the far end: bash runs THE shell prefix (ghProxyShellPrefix) with THE
 * env (buildProxyEnv + buildGhKitEnv) → the kit's gh wrapper → the kit's node
 * forwarder on a unix socket → THE proxy handler (handleCredentialProxy on a
 * real Express app) → a local Express app standing in for api.github.com.
 *
 *  - always on: a stub `gh` (node) that speaks to the socket exactly the way
 *    gh's http_unix_socket transport does (plain HTTP/1.1, Host api.github.com,
 *    `Authorization: token <GH_TOKEN>`), so CI exercises the whole chain;
 *  - opt-in: the REAL gh binary (DIGBY_TEST_GH_BIN=/path/to/gh — the official
 *    release tarball, e.g. the pinned 2.100.0 container.service provisions):
 *    gh pr view / pr list / issue list / repo view (GraphQL), gh api (REST +
 *    graphql), gh run list / workflow list (REST), gh auth status.
 *
 * Invariants: the raw GitHub token exists only on the fake upstream's side;
 * the capability never reaches the upstream; every gh request is a
 * credential_proxy row with client 'gh' and op 'api' | 'graphql'.
 */
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { AddressInfo } from 'net';
import {
  mintCapability, buildProxyEnv, buildGhKitEnv, ghProxyShellPrefix, handleCredentialProxy, countRawPlatformCreds,
  ghForwarderJs, ghKitVersion, type ProxyDeps,
} from './credential-proxy';

const U = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
const REAL = 'gho_REALTOKEN_never_in_the_sandbox';
const REAL_GH = process.env.DIGBY_TEST_GH_BIN || '';

type Seen = { method: string; url: string; headers: Record<string, any>; body: string };

let tmp: string;
let kitRoot: string;
let repo: string;
let stubDir: string;
let ghUp: http.Server; let ghOrigin: string;
let proxy: http.Server; let base: string;
let seen: Seen[];
let rows: any[];
const prevSecret = process.env.JWT_SECRET;

function run(cmd: string, env: Record<string, string>, cwd: string, timeout = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', cmd], { env, cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function gql(query: string): any {
  if (/pullRequest\(number/.test(query)) return { repository: { pullRequest: { number: 7, title: 'Add widget', state: 'OPEN', url: 'https://github.com/octo/demo/pull/7', id: 'PR_1' } } };
  if (/repo_000/.test(query)) return { viewer: { login: 'octocat' }, repo_000: { id: 'R_1', name: 'demo', owner: { login: 'octo' }, viewerPermission: 'WRITE', defaultBranchRef: { name: 'main' }, isPrivate: true, parent: null } };
  if (/pullRequests\(/.test(query)) return { repository: { pullRequests: { totalCount: 1, nodes: [{ number: 7, title: 'Add widget', state: 'OPEN', url: 'https://github.com/octo/demo/pull/7' }], pageInfo: { hasNextPage: false, endCursor: null } } } };
  if (/issues\(/.test(query)) return { repository: { hasIssuesEnabled: true, issues: { totalCount: 1, nodes: [{ number: 3, title: 'Bug', state: 'OPEN', url: 'https://github.com/octo/demo/issues/3' }], pageInfo: { hasNextPage: false, endCursor: null } } } };
  if (/repository\(/.test(query)) return { repository: { id: 'R_1', name: 'demo', nameWithOwner: 'octo/demo', owner: { id: 'U_1', login: 'octo' }, description: 'demo repo', isPrivate: true, defaultBranchRef: { name: 'main' }, url: 'https://github.com/octo/demo', hasIssuesEnabled: true, viewerPermission: 'WRITE' } };
  if (/viewer/.test(query)) return { viewer: { login: 'octocat' } };
  return {};
}

beforeAll(async () => {
  process.env.JWT_SECRET = 's'.repeat(48);
  // /tmp, not jest's TMPDIR: a unix socket path must stay under 108 bytes (prod's is 43:
  // /tmp/digby-proc/gh-proxy/<12 hex>/fw.sock).
  tmp = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'ghx-'));
  kitRoot = path.join(tmp, 'kit');
  // The stand-in for api.github.com: records everything, answers the shapes gh asks for.
  const fake = express();
  fake.use(express.raw({ type: () => true, limit: '5mb' }));
  fake.use((req, res, next) => { seen.push({ method: req.method, url: req.originalUrl, headers: req.headers, body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '' }); next(); });
  fake.post('/graphql', (req, res) => {
    let q = '';
    try { q = JSON.parse((req.body as Buffer).toString('utf8')).query || ''; } catch { /* not json */ }
    res.json({ data: gql(q) });
  });
  fake.get('/user', (_req, res) => { res.setHeader('x-oauth-scopes', 'repo, workflow, read:org'); res.json({ login: 'octocat', id: 1 }); });
  fake.get('/', (_req, res) => { res.setHeader('x-oauth-scopes', 'repo, workflow, read:org'); res.json({}); });
  fake.get('/repos/octo/demo/pulls', (_req, res) => { res.json([{ number: 7, title: 'Add widget' }]); });
  fake.get('/repos/octo/demo/actions/runs', (_req, res) => { res.json({ total_count: 1, workflow_runs: [{ id: 42, name: 'CI', display_title: 'Add widget', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: 'abc123', event: 'push', workflow_id: 1, run_attempt: 1, run_number: 9, html_url: 'https://github.com/octo/demo/actions/runs/42', created_at: '2026-10-11T10:00:00Z', updated_at: '2026-10-11T10:05:00Z', run_started_at: '2026-10-11T10:00:00Z' }] }); });
  fake.get('/repos/octo/demo/actions/workflows', (_req, res) => { res.json({ total_count: 1, workflows: [{ id: 1, node_id: 'W_1', name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }); });
  fake.use((_req, res) => { res.status(404).json({ message: 'Not Found' }); });
  await new Promise<void>((r) => { ghUp = fake.listen(0, '127.0.0.1', () => r()); });
  ghOrigin = `http://127.0.0.1:${(ghUp.address() as AddressInfo).port}`;

  // THE proxy handler; its fetch sends https://api.github.com/... to the stand-in.
  const deps: ProxyDeps = {
    fetchImpl: ((url: any, init: any) => fetch(String(url).replace(/^https:\/\/api\.github\.com/, ghOrigin), init)) as any,
    loadSession: async () => ({ userId: U, status: 'ready' }),
    tokenFor: async () => REAL,
    record: (meta) => rows.push(meta),
  };
  const app = express();
  app.use(express.json({ limit: '75mb' }));
  app.use(express.urlencoded({ extended: true, limit: '75mb' }));
  // The same routes coding-public.routes.ts mounts (incl. the API root gh auth status reads scopes from).
  for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    (app as any)[m]('/coding/cred-proxy/api/:provider/*splat', (req: any, res: any) => { void handleCredentialProxy('api', req, res, deps); });
  }
  app.get('/coding/cred-proxy/api/:provider', (req: any, res: any) => { void handleCredentialProxy('api', req, res, deps); });
  await new Promise<void>((r) => { proxy = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/coding/cred-proxy`;

  // A repo whose origin is github.com — gh resolves octo/demo from it.
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[]) => new Promise<void>((res, rej) => execFile('git', args, { cwd: repo, env: { PATH: process.env.PATH || '', HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' } }, (e) => (e ? rej(e) : res())));
  await g(['init', '-q', '-b', 'main']);
  await g(['remote', 'add', 'origin', 'https://github.com/octo/demo.git']);
  await g(['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '--allow-empty', '-m', 'init']);

  // The CI stand-in for gh: speaks to the socket exactly like gh's http_unix_socket transport.
  stubDir = path.join(tmp, 'stubbin');
  fs.mkdirSync(stubDir);
  fs.writeFileSync(path.join(stubDir, 'gh'), [
    '#!/usr/bin/env node',
    "const http = require('http'); const fs = require('fs'); const { execFileSync } = require('child_process');",
    "const out = { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || null, tokenIsCap: /^dcp1\\./.test(process.env.GH_TOKEN || ''), path0: (process.env.PATH || '').split(':')[0] };",
    "out.remotes = execFileSync('git', ['remote', '-v'], { encoding: 'utf8' });",
    "if (!process.env.GH_CONFIG_DIR) { console.log(JSON.stringify(out)); process.exit(0); }",
    "const sock = /http_unix_socket: (.*)/.exec(fs.readFileSync(process.env.GH_CONFIG_DIR + '/config.yml', 'utf8'))[1].trim();",
    "const [method, p, host, body] = [process.argv[2], process.argv[3], process.argv[4] || 'api.github.com', process.argv[5]];",
    "const req = http.request({ socketPath: sock, method, path: p, headers: { host, authorization: 'token ' + process.env.GH_TOKEN, 'user-agent': 'GitHub CLI stub', ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}) } }, (res) => {",
    "  let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { out.status = res.statusCode; out.body = b; console.log(JSON.stringify(out)); });",
    "});",
    "req.on('error', (e) => { out.error = e.code; console.log(JSON.stringify(out)); process.exit(3); });",
    "req.end(body || undefined);",
  ].join('\n'), { mode: 0o755 });
});

afterAll(async () => {
  // Stop every forwarder a test started (they detach from the shell).
  try {
    for (const v of fs.readdirSync(kitRoot)) {
      const pid = Number(fs.readFileSync(path.join(kitRoot, v, 'fw.pid'), 'utf8'));
      if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    }
  } catch { /* no kit */ }
  await new Promise((r) => ghUp.close(r));
  await new Promise((r) => proxy.close(r));
  if (prevSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevSecret;
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { seen = []; rows = []; });

/** The proxy-mode shell env of a run (the GIT rewrite + capability + gh kit) and the command line the lane's shell would run. */
function shell(extraPath: string[]): { env: Record<string, string>; prefix: string } {
  const cap = mintCapability({ sessionId: 's1', userId: U }, Date.now(), process.env)!;
  const kit = buildGhKitEnv(base, kitRoot);
  const env: Record<string, string> = {
    ...buildProxyEnv(base, cap, ['github']), ...kit,
    PATH: [...extraPath, path.dirname(process.execPath), process.env.PATH || '/usr/bin:/bin'].join(':'),
    HOME: tmp, DIGBY_USER_ID: U, GIT_CONFIG_NOSYSTEM: '1', DIGBY_GH_FW_IDLE_MS: '120000',
    GH_TELEMETRY: 'false', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1',
  };
  return { env, prefix: ghProxyShellPrefix(env) };
}

function noCapUpstream(): void {
  for (const s of seen) {
    expect(JSON.stringify(s.headers)).not.toContain('dcp1.');
    expect(s.body).not.toContain('dcp1.');
  }
}

describe('the gh kit in the shell (always on)', () => {
  it('the prefix materializes the kit once, puts it first on PATH and leaves no kit env in the user command', async () => {
    const { env, prefix } = shell([stubDir]);
    expect(countRawPlatformCreds(env)).toBe(0);
    const kitDir = env.DIGBY_GH_KIT_DIR;
    expect(kitDir).toBe(path.join(kitRoot, ghKitVersion(base)));
    const r = await run(`${prefix}echo "PATH0=\${PATH%%:*}"; env | grep -c '^DIGBY_GH_KIT_' || true; command -v gh`, env, repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`PATH0=${kitDir}`);
    expect(r.stdout.split('\n')[1]).toBe('0');
    expect(r.stdout).toContain(`${kitDir}/gh`);
    for (const f of ['gh', 'git/git', 'fw.js', 'config/config.yml']) expect(fs.existsSync(path.join(kitDir, f))).toBe(true);
    expect(fs.readFileSync(path.join(kitDir, 'fw.js'), 'utf8')).toBe(ghForwarderJs());
    expect(fs.readFileSync(path.join(kitDir, 'config/config.yml'), 'utf8')).toBe(`version: "1"\ngit_protocol: https\nhttp_unix_socket: ${kitDir}/fw.sock\n`);
    expect(fs.statSync(path.join(kitDir, 'gh')).mode & 0o777).toBe(0o700);
    const before = fs.statSync(path.join(kitDir, 'gh')).mtimeMs;
    await run(`${prefix}true`, env, repo);
    expect(fs.statSync(path.join(kitDir, 'gh')).mtimeMs).toBe(before); // second command: no rewrite
    expect(ghProxyShellPrefix({ GITHUB_TOKEN: 'x' })).toBe(''); // direct mode: the prefix is byte-identical
  });

  it('REST + GraphQL go wrapper → forwarder → proxy: the real token only upstream, the capability never; rows say client gh', async () => {
    const { env, prefix } = shell([stubDir]);
    const rest = await run(`${prefix}gh GET /repos/octo/demo/pulls?state=open`, env, repo);
    expect(rest.code).toBe(0);
    const o = JSON.parse(rest.stdout.trim().split('\n').pop()!);
    expect(o).toMatchObject({ status: 200, tokenIsCap: true, path0: `${env.DIGBY_GH_KIT_DIR}/git` });
    expect(JSON.parse(o.body)).toEqual([{ number: 7, title: 'Add widget' }]);
    const gq = await run(`${prefix}gh POST /graphql api.github.com '{"query":"query{viewer{login}}"}'`, env, repo);
    expect(JSON.parse(JSON.parse(gq.stdout.trim().split('\n').pop()!).body)).toEqual({ data: { viewer: { login: 'octocat' } } });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /repos/octo/demo/pulls?state=open', 'POST /graphql']);
    for (const s of seen) expect(s.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(seen[1].body).toBe('{"query":"query{viewer{login}}"}');
    noCapUpstream();
    expect(seen.some((s) => 'x-digby-client' in s.headers)).toBe(false);
    expect(rows).toEqual([
      expect.objectContaining({ phase: 'request', provider: 'github', op: 'api', status: 200, ok: true, client: 'gh' }),
      expect.objectContaining({ phase: 'request', provider: 'github', op: 'graphql', status: 200, ok: true, client: 'gh' }),
    ]);
  });

  it('gh sees the github.com remote (the git shim); the shell itself keeps the proxy rewrite', async () => {
    const { env, prefix } = shell([stubDir]);
    const r = await run(`${prefix}git remote -v | head -1; gh GET /user`, env, repo);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toContain(`${base}/git/github.com/octo/demo.git`); // the lane's git: through the proxy
    const o = JSON.parse(lines[lines.length - 1]);
    expect(o.remotes).toContain('origin\thttps://github.com/octo/demo.git (fetch)'); // gh's git: parseable
  });

  it('the lane\'s own GH_TOKEN wins (plain gh, no proxy config); no capability = direct mode = plain gh', async () => {
    const { env, prefix } = shell([stubDir]);
    const own = await run(`${prefix}GH_TOKEN=ghp_lane_own gh`, env, repo);
    expect(JSON.parse(own.stdout.trim().split('\n').pop()!)).toMatchObject({ GH_CONFIG_DIR: null, tokenIsCap: false });
    const direct = { ...env };
    delete direct.DIGBY_CREDENTIAL_PROXY_TOKEN;
    const d = await run(`${prefix}gh`, direct, repo);
    expect(JSON.parse(d.stdout.trim().split('\n').pop()!)).toMatchObject({ GH_CONFIG_DIR: null });
    expect(seen).toEqual([]);
  });

  it('uploads.github.com with the capability is refused at the forwarder (not on the proxy allowlist) — nothing reaches the proxy', async () => {
    const { env, prefix } = shell([stubDir]);
    const r = await run(`${prefix}gh POST /repos/octo/demo/releases/1/assets?name=a.zip uploads.github.com`, env, repo);
    const o = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(o.status).toBe(501);
    expect(JSON.parse(o.body).message).toMatch(/uploads\.github\.com/);
    expect(rows).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('a forwarder that cannot start (no node) leaves gh unauthenticated with one line — never a broken shell', async () => {
    const { env, prefix } = shell([]);
    const noNode = path.join(tmp, 'nonode');
    fs.mkdirSync(noNode, { recursive: true });
    fs.writeFileSync(path.join(noNode, 'gh'), '#!/bin/sh\necho "real-gh GH_CONFIG_DIR=[$GH_CONFIG_DIR]"\n', { mode: 0o755 });
    const kitDir = path.join(tmp, 'kit-nonode');
    const e2 = { ...env, ...buildGhKitEnv('http://127.0.0.1:9/none', kitDir), PATH: `${noNode}:/usr/bin:/bin` };
    const r = await run(`${ghProxyShellPrefix(e2)}gh pr view 7`, e2, repo);
    if (fs.existsSync('/usr/bin/node') || fs.existsSync('/bin/node')) return; // the host ships node on the system PATH — nothing to prove here
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('real-gh GH_CONFIG_DIR=[]');
    expect(r.stderr).toContain('forwarder did not start');
  });
});

describe('the forwarder\'s routing (pure)', () => {
  const fw = (() => {
    const f = path.join(os.tmpdir(), `fw-${process.pid}-${Date.now()}.js`);
    fs.writeFileSync(f, ghForwarderJs());
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require(f);
    fs.rmSync(f, { force: true });
    return m as { route: (base: string, host: string, url: string, headers: Record<string, string>) => any };
  })();
  const CAP = 'dcp1.eyJzIjoiczEifQ.c2ln';
  it('api.github.com + capability → the proxy with X-Digby-Cap; Authorization dropped', () => {
    const r = fw.route('https://digby.example.com/api/crossmodel/coding/cred-proxy/', 'api.github.com', '/graphql', { authorization: `token ${CAP}`, 'content-type': 'application/json', connection: 'close', host: 'api.github.com' });
    expect(r).toEqual({ kind: 'proxy', url: 'https://digby.example.com/api/crossmodel/coding/cred-proxy/api/github/graphql', headers: { 'content-type': 'application/json', 'x-digby-cap': CAP, 'x-digby-client': 'gh' } });
  });
  it('any other host: direct, and a capability-shaped Authorization never travels there', () => {
    expect(fw.route('https://d/x', 'productionresultssa0.blob.core.windows.net', '/logs?sig=1', { authorization: `token ${CAP}` })).toEqual({ kind: 'direct', url: 'https://productionresultssa0.blob.core.windows.net/logs?sig=1', headers: {} });
    expect(fw.route('https://d/x', 'api.github.com', '/user', { authorization: 'token ghp_lane_own' })).toEqual({ kind: 'direct', url: 'https://api.github.com/user', headers: { authorization: 'token ghp_lane_own' } });
    expect(fw.route('https://d/x', 'uploads.github.com', '/x', { authorization: `Bearer ${CAP}` })).toMatchObject({ kind: 'refuse', status: 501 });
    expect(fw.route('https://d/x', 'evil.example/../x', '/', {})).toMatchObject({ kind: 'refuse', status: 400 });
  });
});

// ── the REAL gh binary (opt-in: DIGBY_TEST_GH_BIN) ─────────────────────────────
const realGh = REAL_GH && fs.existsSync(REAL_GH) ? describe : describe.skip;
realGh(`the real gh binary (${REAL_GH || 'DIGBY_TEST_GH_BIN unset'})`, () => {
  const ghDir = () => {
    const d = path.join(tmp, 'realgh');
    if (!fs.existsSync(d)) { fs.mkdirSync(d); fs.symlinkSync(REAL_GH, path.join(d, 'gh')); }
    return d;
  };
  const cases: Array<[string, RegExp]> = [
    ['gh pr view 7 --json number,title', /"number":7.*"title":"Add widget"/],
    ['gh pr list --json number,title', /"number":7/],
    ['gh issue list --json number,title', /"number":3/],
    ['gh repo view --json name,owner', /"name":"demo"/],
    ['gh api repos/octo/demo/pulls', /"Add widget"/],
    ['gh api graphql -f query=\'query{viewer{login}}\'', /"login":"octocat"/],
    ['gh run list --json databaseId,status,conclusion --limit 1', /"databaseId":42/],
    ['gh workflow list', /CI/],
    ['gh auth status', /github\.com/],
  ];
  it.each(cases)('%s', async (cmd, want) => {
    const { env, prefix } = shell([ghDir()]);
    const r = await run(`${prefix}${cmd}`, env, repo);
    if (r.code !== 0 || !want.test(r.stdout + r.stderr)) {
      // eslint-disable-next-line no-console
      console.log(cmd, r, seen.map((s) => `${s.method} ${s.url} ${s.body.slice(0, 300)}`));
    }
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toMatch(want);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.headers.authorization).toBe(`Bearer ${REAL}`);
    noCapUpstream();
    expect(rows.length).toBe(seen.length);
    for (const row of rows) expect(row).toMatchObject({ provider: 'github', ok: true, client: 'gh' });
    expect(rows.map((x) => x.op).every((op) => op === 'api' || op === 'graphql')).toBe(true);
  }, 60_000);
});

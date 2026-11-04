/**
 * REAL-SOCKET pins for the in-container egress shim (ticket 4ed6eb2e): the exact
 * proxy.js / socks-connect.js payloads the service embeds are spawned as real
 * `node` processes against a fixture upstream SOCKS5, and the wire behavior is
 * asserted end-to-end:
 *  - method negotiation REQUIRES username/password (RFC 1929) — no-auth denied
 *  - wrong password / unknown user → auth failure; the upstream never sees it
 *  - policy: allow-list (exact, wildcard, port-scoped, CIDR), explicit deny-all
 *    via `allow: []`, session override beating the user default, allow-all when
 *    no policy files exist at all
 *  - success relays raw bytes both ways (the SSH/ProxyCommand data path)
 *  - socks-connect.js bridges stdio through the shim with its env credentials
 */
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('./container.service', () => ({ __esModule: true, isDockerAvailable: jest.fn() }));
jest.mock('./workspace.service', () => ({ __esModule: true, CODING_WORKSPACE_ROOT: '/app/coding-workspaces' }));
jest.mock('./credentials.service', () => ({ __esModule: true, getCredentialValueDecrypted: jest.fn() }));

import { egressProxyJs, socksConnectJs } from './dev-container.service';
import { passwordHash, egressUsername, ipv6Bytes } from './egress-policy';

const PASS = 'test-pass-123';
const USER = egressUsername('aca5a594-cafb-40a9-9286-bdff6e0ec01a'); // 's'+12 hex — the shim rejects any other shape

/** Minimal no-auth upstream SOCKS5 (stands in for tailscaled's :1057): records
 *  CONNECT destinations, always grants them, then echoes whatever it receives. */
function startUpstream(): Promise<{ port: number; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const srv = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    let stage: 'greet' | 'req' | 'pipe' = 'greet';
    c.on('data', (d) => {
      if (stage === 'pipe') { c.write(d); return; }
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.slice(2 + n);
        c.write(Buffer.from([5, 0]));
        stage = 'req';
      } else if (stage === 'req') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host = '';
        let need = 0;
        if (atyp === 1) { need = 10; if (buf.length < need) return; host = Array.from(buf.slice(4, 8)).join('.'); }
        else if (atyp === 3) { const dl = buf[4]; need = 5 + dl + 2; if (buf.length < need) return; host = buf.slice(5, 5 + dl).toString(); }
        else if (atyp === 4) { need = 22; if (buf.length < need) return; const p: string[] = []; for (let i = 4; i < 20; i += 2) p.push(buf.readUInt16BE(i).toString(16)); host = p.join(':'); }
        else { c.end(); return; }
        const port = buf.readUInt16BE(need - 2);
        seen.push(`${host}:${port}`);
        buf = buf.slice(need);
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        stage = 'pipe';
        if (buf.length) c.write(buf); // pipelined bytes echo back
      }
    });
    c.on('error', () => {});
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      port: (srv.address() as net.AddressInfo).port,
      seen,
      close: () => new Promise((r) => srv.close(() => r())),
    }));
  });
}

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

/** A shim client: negotiate method 2, auth, CONNECT. Resolves the reply code
 *  (0 = granted; 2 = not allowed; 1 = auth failed; 0xff = method denied) and,
 *  on success, the live relay socket. */
function socksConnect(shimPort: number, user: string, pass: string, dest: string, port: number): Promise<{ code: number; sock?: net.Socket }> {
  return new Promise((resolve) => {
    const c = net.connect(shimPort, '127.0.0.1');
    let stage: 'greet' | 'auth' | 'req' = 'greet';
    let buf = Buffer.alloc(0);
    const done = (code: number, sock?: net.Socket) => { c.removeAllListeners('data'); resolve({ code, sock }); };
    c.on('error', () => done(-1));
    c.on('connect', () => c.write(Buffer.from([5, 1, 2])));
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[1] !== 2) { done(0xff); return; }
        buf = buf.slice(2);
        const u = Buffer.from(user); const p = Buffer.from(pass);
        c.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        stage = 'auth';
      } else if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0) { done(buf[1]); return; }
        buf = buf.slice(2);
        let req: Buffer;
        if (net.isIPv4(dest)) {
          req = Buffer.concat([Buffer.from([5, 1, 0, 1]), Buffer.from(dest.split('.').map(Number)), Buffer.from([port >> 8, port & 255])]);
        } else if (net.isIPv6(dest)) {
          const b16 = ipv6Bytes(dest);
          if (!b16) { done(-1); return; }
          req = Buffer.concat([Buffer.from([5, 1, 0, 4]), b16, Buffer.from([port >> 8, port & 255])]);
        } else {
          const hb = Buffer.from(dest);
          req = Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([port >> 8, port & 255])]);
        }
        c.write(req);
        stage = 'req';
      } else {
        if (buf.length < 10) return;
        const code = buf[1];
        if (code === 0) done(0, c); else { c.end(); done(code); }
      }
    });
  });
}

/** Offer only the no-auth method; the shim must answer 0xff ("no acceptable methods"). */
function negotiateNoAuthOnly(shimPort: number): Promise<number> {
  return new Promise((resolve) => {
    const c = net.connect(shimPort, '127.0.0.1');
    let buf = Buffer.alloc(0);
    c.on('error', () => resolve(-1));
    c.on('connect', () => c.write(Buffer.from([5, 1, 0])));
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2) { const m = buf[1]; c.end(); resolve(m); }
    });
  });
}

describe('egress shim (real sockets)', () => {
  let dir = '';
  let shimPort = 0;
  let upstream: { port: number; seen: string[]; close: () => Promise<void> };
  let shim: ChildProcess;

  beforeAll(async () => {
    upstream = await startUpstream();
    shimPort = await freePort();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-egress-test-'));
    fs.mkdirSync(path.join(dir, 'creds'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'proxy.js'), egressProxyJs());
    shim = spawn('node', [path.join(dir, 'proxy.js')], {
      env: { ...process.env, DIGBY_EGRESS_DIR: dir, DIGBY_EGRESS_PORT: String(shimPort), DIGBY_EGRESS_UP_PORT: String(upstream.port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // Wait until the shim answers a method probe with [5,2].
    // Internal budget sits just under the 15000ms hook budget below (was 5000): under
    // shared-box load a slow-but-healthy shim tripped the 5s internal deadline while
    // jest would still have allowed the start — a beforeAll throw here fails ALL suite
    // tests (the all-14-fail load flake, ticket 8bde7210). Keep the margin small so a
    // genuinely dead shim still gets the readable 'shim did not start' error.
    const deadline = Date.now() + 13000;
    for (;;) {
      const ok = await new Promise<boolean>((resolve) => {
        const c = net.connect(shimPort, '127.0.0.1');
        c.on('error', () => resolve(false));
        c.on('connect', () => c.write(Buffer.from([5, 1, 2])));
        c.on('data', (d) => { const yes = d.length >= 2 && d[0] === 5 && d[1] === 2; c.end(); resolve(yes); });
        setTimeout(() => { c.destroy(); resolve(false); }, 300).unref();
      });
      if (ok) return;
      if (Date.now() > deadline) throw new Error('shim did not start');
      await new Promise((r) => setTimeout(r, 60));
    }
  }, 15000);

  afterAll(async () => {
    shim?.kill('SIGKILL');
    await upstream?.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    upstream.seen.length = 0;
    for (const f of fs.readdirSync(path.join(dir, 'creds'))) fs.rmSync(path.join(dir, 'creds', f));
    try { fs.rmSync(path.join(dir, 'default.json')); } catch { /* ignore */ }
  });

  const writeCred = (body: object) => fs.writeFileSync(path.join(dir, 'creds', `${USER}.json`), JSON.stringify(body));

  it('requires username/password auth: no-auth-only clients get 0xff', async () => {
    expect(await negotiateNoAuthOnly(shimPort)).toBe(0xff);
  });

  it('rejects a wrong password before any policy work; the upstream never sees the dest', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS) });
    const r = await socksConnect(shimPort, USER, 'wrong-pass', 'box-1', 22);
    expect(r.code).toBe(1);
    expect(upstream.seen).toEqual([]);
  });

  it('rejects an unknown user (no cred file match)', async () => {
    const r = await socksConnect(shimPort, 'sdeadbeefdeadbeef', PASS, 'box-1', 22);
    expect(r.code).toBe(1);
    expect(upstream.seen).toEqual([]);
  });

  it('cred file WITHOUT allow (and no default.json) → allow-all (the legacy-compatible grant)', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS) }); // no 'allow' key → allow: null → allow-all
    const r = await socksConnect(shimPort, USER, PASS, 'box-1', 22);
    expect(r.code).toBe(0);
    expect(upstream.seen).toEqual(['box-1:22']);
    r.sock!.end();
  });

  it('session allow-list: denied dest gets reply code 2 and never reaches upstream; allowed dest relays', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS), allow: ['box-1', '.ts.net'] });
    const denied = await socksConnect(shimPort, USER, PASS, 'other-host', 443);
    expect(denied.code).toBe(2);
    expect(upstream.seen).toEqual([]);
    const exact = await socksConnect(shimPort, USER, PASS, 'box-1', 443);
    expect(exact.code).toBe(0); exact.sock!.end();
    const wild = await socksConnect(shimPort, USER, PASS, 'deep.node.ts.net', 443);
    expect(wild.code).toBe(0); wild.sock!.end();
    expect(upstream.seen).toEqual(['box-1:443', 'deep.node.ts.net:443']);
  });

  it('explicit deny-all via allow: [] (distinct from INHERIT/absent)', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS), allow: [] });
    const r = await socksConnect(shimPort, USER, PASS, 'box-1', 22);
    expect(r.code).toBe(2);
    expect(upstream.seen).toEqual([]);
  });

  it('user default.json applies when the cred file omits allow; session override beats the default', async () => {
    fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify({ v: 1, allow: ['.ts.net'] }));
    writeCred({ v: 1, pwHash: passwordHash(PASS) }); // INHERIT → default
    const fromDefault = await socksConnect(shimPort, USER, PASS, 'a.ts.net', 443);
    expect(fromDefault.code).toBe(0); fromDefault.sock!.end();
    writeCred({ v: 1, pwHash: passwordHash(PASS), allow: ['box-1'] }); // session override
    const overridden = await socksConnect(shimPort, USER, PASS, 'a.ts.net', 443);
    expect(overridden.code).toBe(2);
    expect(upstream.seen).toEqual(['a.ts.net:443']);
  });

  it('port-scoped rules gate the port too', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS), allow: ['box-1:22'] });
    expect((await socksConnect(shimPort, USER, PASS, 'box-1', 22)).code).toBe(0);
    expect((await socksConnect(shimPort, USER, PASS, 'box-1', 23)).code).toBe(2);
  });

  it('IPv4 destinations match CIDR rules; hostname rules never match IP literals', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS), allow: ['100.64.0.0/10'] });
    const ok = await socksConnect(shimPort, USER, PASS, '100.64.1.9', 22);
    expect(ok.code).toBe(0); ok.sock!.end();
    writeCred({ v: 1, pwHash: passwordHash(PASS), allow: ['box-1'] });
    const denied = await socksConnect(shimPort, USER, PASS, '100.64.1.9', 22);
    expect(denied.code).toBe(2);
  });

  it('IPv6 destinations match v6 CIDR rules by PREFIX (adversarial review F3)', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS), allow: ['fd7a:115c:a1e0::/48'] });
    const ok = await socksConnect(shimPort, USER, PASS, 'fd7a:115c:a1e0::5', 22);
    expect(ok.code).toBe(0); ok.sock!.end();
    const ok2 = await socksConnect(shimPort, USER, PASS, 'fd7a:115c:a1e0:abcd::99', 22);
    expect(ok2.code).toBe(0); ok2.sock!.end();
    const denied = await socksConnect(shimPort, USER, PASS, 'fd7a:115c:a1e1::5', 22); // next /48 over
    expect(denied.code).toBe(2);
    expect(upstream.seen).toEqual(['fd7a:115c:a1e0:0:0:0:0:5:22', 'fd7a:115c:a1e0:abcd:0:0:0:99:22']);
  });

  it('corrupt default.json fails CLOSED (deny-all) — never a silent allow-all (adversarial review F2)', async () => {
    fs.writeFileSync(path.join(dir, 'default.json'), '{not json!!');
    writeCred({ v: 1, pwHash: passwordHash(PASS) }); // INHERIT → consults default.json
    const r = await socksConnect(shimPort, USER, PASS, 'box-1', 22);
    expect(r.code).toBe(2);
    expect(upstream.seen).toEqual([]);
    // …while a VALID default.json without an allow key stays the allow-all default.
    fs.writeFileSync(path.join(dir, 'default.json'), '{"v":1}');
    const ok = await socksConnect(shimPort, USER, PASS, 'box-1', 22);
    expect(ok.code).toBe(0); ok.sock!.end();
  });

  it('a granted connection relays raw bytes both ways (the SSH data path)', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS) }); // allow-all
    const r = await socksConnect(shimPort, USER, PASS, 'box-1', 22);
    expect(r.code).toBe(0);
    const pong = await new Promise<Buffer>((resolve) => {
      r.sock!.once('data', (d) => resolve(d));
      r.sock!.write(Buffer.from('ping-ssh-banner'));
    });
    expect(pong.toString()).toBe('ping-ssh-banner');
    r.sock!.end();
  });

  it('socks-connect.js bridges stdio through the shim using env credentials', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS) });
    const helperFile = path.join(dir, 'socks-connect.js');
    fs.writeFileSync(helperFile, socksConnectJs());
    const proc = spawn('node', [helperFile, 'box-1', '22'], {
      env: { ...process.env, DIGBY_TAILNET_PROXY: `socks5h://${USER}:${PASS}@127.0.0.1:${shimPort}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (d) => { chunks.push(d); if (Buffer.concat(chunks).toString().includes('through-the-shim')) resolve(Buffer.concat(chunks)); });
      proc.on('exit', (code) => reject(new Error(`socks-connect exited early: ${code}`)));
      // Internal budget sits just under the 10000ms jest budget below (was 5000):
      // under shared-box load the relay finished inside the jest budget but after the
      // 5s internal timer → 'timeout waiting for relay' flake (ticket 8bde7210). The
      // 1s margin keeps this readable error for a genuinely hung relay.
      setTimeout(() => reject(new Error('timeout waiting for relay')), 9000).unref();
      proc.stdin.write('through-the-shim');
    });
    expect(out.toString()).toContain('through-the-shim');
    expect(upstream.seen).toEqual(['box-1:22']);
    proc.kill('SIGKILL');
  }, 10000);

  it('socks-connect.js exits non-zero with a message when the shim policy denies the dest', async () => {
    writeCred({ v: 1, pwHash: passwordHash(PASS), allow: [] });
    const helperFile = path.join(dir, 'socks-connect.js');
    fs.writeFileSync(helperFile, socksConnectJs());
    const proc = spawn('node', [helperFile, 'box-1', '22'], {
      env: { ...process.env, DIGBY_TAILNET_PROXY: `socks5h://${USER}:${PASS}@127.0.0.1:${shimPort}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const errText = await new Promise<string>((resolve) => {
      let t = '';
      proc.stderr.on('data', (d) => { t += d.toString(); });
      proc.on('exit', () => resolve(t));
    });
    expect(errText).toMatch(/socks-connect: proxy denied box-1:22 by egress policy \(code 2\)/);
  }, 10000);
});

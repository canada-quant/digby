/**
 * relay-core — Digby Edge (Phase 3) relay frame multiplexer + proxy handler.
 * Unit-tested WITHOUT real sockets: deps (db/redis/verifyToken/resolveToken)
 * are injected and the tunnel socket is a fake capturing sent frames. Pins:
 * uniform 401 upgrade auth (unknown/revoked), online/offline marking + Redis
 * presence, frame validation (unknown type/streamId → error frame, never a
 * crash), per-ping revoke re-check (hard close), proxy auth (401/403/404),
 * offline → 502, stream cap → 503, body cap → 413, and streamed head/data/end.
 */

import { EventEmitter } from 'events';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config/env', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32) } }));
jest.mock('../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../utils/jwt', () => ({ verifyAccessToken: jest.fn() }));
jest.mock('../modules/crossmodel/instances/instances.service', () => ({
  resolveInstanceByToken: jest.fn(),
  PRESENCE_KEY_PREFIX: 'inst:presence:',
}));

import {
  RelayCore, InstanceConnection, MAX_STREAMS_PER_INSTANCE, FORWARD_HEADER,
  TUNNEL_PATH, TUNNEL_PATHS, isTunnelPath, PROXY_PATH_RE, MESSAGES_PATH_RE,
} from './relay-core';
import { API_PREFIXES, CANONICAL_API_PREFIX, ALIAS_API_PREFIX } from '../api-prefixes';

const INSTANCE = { id: 'inst-1', ownerUserId: 'admin-1', name: 'home-lab', status: 'pending', protocolVersion: 1 };

class FakeSocket {
  sent: string[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  private handlers = new Map<string, Array<(...a: any[]) => void>>();
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closeCalls.push([code, reason]); }
  on(event: string, cb: (...a: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) || []), cb]);
  }
  emit(event: string, ...args: any[]) {
    for (const cb of this.handlers.get(event) || []) cb(...args);
  }
  frames(): any[] { return this.sent.map(s => JSON.parse(s)); }
  lastFrame(): any { return this.frames()[this.sent.length - 1]; }
}

class FakeRes extends EventEmitter {
  headersSent = false;
  statusCode = 0;
  headers: Record<string, any> = {};
  body: Buffer[] = [];
  ended = false;
  writeHead(status: number, headers: Record<string, any>) {
    this.statusCode = status; this.headers = headers; this.headersSent = true;
  }
  write(chunk: Buffer | string) { this.body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
  end(chunk?: Buffer | string) { if (chunk) this.write(chunk); this.ended = true; this.emit('close'); }
  text() { return Buffer.concat(this.body).toString('utf8'); }
}

class FakeReq extends EventEmitter {
  method = 'GET';
  headers: Record<string, any> = {};
  constructor(public url: string) { super(); }
  destroy() { /* noop */ }
}

const mkDeps = (over: any = {}) => {
  const rows: any[] = [{ ...INSTANCE }];
  const presence = new Map<string, string>();
  return {
    rows,
    presence,
    db: {
      connectedInstance: {
        findUnique: jest.fn(async ({ where, select }: any) => {
          const r = rows.find(x => x.id === where.id) || null;
          if (r && select?.status) return { status: r.status };
          return r;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const i = rows.findIndex(x => x.id === where.id);
          if (i >= 0) rows[i] = { ...rows[i], ...data };
          return rows[i];
        }),
      },
    },
    redis: {
      setEx: jest.fn(async (k: string, _t: number, v: string) => { presence.set(k, v); }),
      del: jest.fn(async (k: string) => { presence.delete(k); }),
      get: jest.fn(async (k: string) => presence.get(k) ?? null),
    },
    verifyToken: jest.fn((token: string) => {
      if (token === 'good-admin') return { userId: 'admin-1', email: 'a@b.c', role: 'ADMIN' };
      if (token === 'good-user') return { userId: 'admin-1', email: 'a@b.c', role: 'USER' };
      throw new Error('invalid token');
    }),
    resolveToken: jest.fn(async (token: string) => (token === 'dgi_good' ? { ...INSTANCE } : null)),
    claimPair: jest.fn(async () => null),
    ...over,
  };
};

const flush = () => new Promise(r => setImmediate(r));

let deps: ReturnType<typeof mkDeps>;
let core: RelayCore;

beforeEach(() => {
  deps = mkDeps();
  core = new RelayCore(deps);
});

describe('authenticateTunnelRequest (uniform 401 surface)', () => {
  it('rejects missing/malformed headers, unknown tokens, and revoked instances', async () => {
    expect(await core.authenticateTunnelRequest(undefined)).toBeNull();
    expect(await core.authenticateTunnelRequest('Token dgi_good')).toBeNull();
    expect(await core.authenticateTunnelRequest('Bearer dgi_wrong')).toBeNull();
    deps.resolveToken.mockResolvedValueOnce({ ...INSTANCE, status: 'revoked' });
    expect(await core.authenticateTunnelRequest('Bearer dgi_good')).toBeNull();
  });

  it('accepts a valid dgi_ token', async () => {
    const result = await core.authenticateTunnelRequest('Bearer dgi_good');
    expect(result?.instance.id).toBe('inst-1');
    expect(result?.pairedToken).toBeUndefined();
    expect(deps.resolveToken).toHaveBeenCalledWith('dgi_good');
  });
});

describe('device-activation auth (dgp_ first contact)', () => {
  const MINTED = { instance: { ...INSTANCE, id: 'inst-9' }, token: `dgi_${'f'.repeat(48)}` };

  it('a dgp_ token goes to claimPair with the ?name= param and returns the minted row + token', async () => {
    deps.claimPair.mockResolvedValueOnce(MINTED);
    const result = await core.authenticateTunnelRequest('Bearer dgp_ABCD2345', 'home lab');
    expect(deps.claimPair).toHaveBeenCalledWith('dgp_ABCD2345', 'home lab');
    expect(deps.resolveToken).not.toHaveBeenCalled();
    expect(result?.instance.id).toBe('inst-9');
    expect(result?.pairedToken).toBe(MINTED.token);
  });

  it('unknown/expired/consumed dgp_ → the SAME null as any bad token (uniform 401)', async () => {
    expect(await core.authenticateTunnelRequest('Bearer dgp_NOPE1234')).toBeNull();
    expect(deps.claimPair).toHaveBeenCalledWith('dgp_NOPE1234', undefined);
  });

  it('handleTunnelUpgrade sends the paired frame BEFORE attaching, then the tunnel is live', async () => {
    deps.claimPair.mockResolvedValueOnce(MINTED);
    const auth = await core.authenticateTunnelRequest('Bearer dgp_ABCD2345', 'home lab');
    const sock = new FakeSocket();
    core.handleTunnelUpgrade(auth!, sock as any);
    await flush();

    const first = sock.frames()[0];
    expect(first).toEqual({ v: 1, type: 'paired', instanceId: 'inst-9', token: MINTED.token });
    // Attached as usual: online-mark + presence on the MINTED row's id.
    expect(core.connections.has('inst-9')).toBe(true);
    expect(deps.redis.setEx).toHaveBeenCalledWith('inst:presence:inst-9', 90, expect.any(String));
    expect(deps.db.connectedInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-9' },
      data: { status: 'online', lastSeenAt: expect.any(Date) },
    });
    // And the socket answers frames like any established tunnel.
    sock.emit('message', JSON.stringify({ v: 1, type: 'ping' }));
    await flush();
    expect(sock.frames().some(f => f.type === 'pong')).toBe(true);
  });

  it('handleTunnelUpgrade without a pairedToken sends nothing before attach', async () => {
    const sock = new FakeSocket();
    core.handleTunnelUpgrade({ instance: INSTANCE }, sock as any);
    await flush();
    expect(sock.frames().some(f => f.type === 'paired')).toBe(false);
    expect(core.connections.has('inst-1')).toBe(true);
  });
});

describe('attachConnection', () => {
  it('marks the instance online and seeds Redis presence', async () => {
    const sock = new FakeSocket();
    core.attachConnection(INSTANCE, sock as any);
    await flush();
    expect(deps.db.connectedInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-1' },
      data: { status: 'online', lastSeenAt: expect.any(Date) },
    });
    expect(deps.redis.setEx).toHaveBeenCalledWith('inst:presence:inst-1', 90, expect.any(String));
  });

  it('a reconnect replaces the stale socket', async () => {
    const first = new FakeSocket();
    core.attachConnection(INSTANCE, first as any);
    const second = new FakeSocket();
    core.attachConnection(INSTANCE, second as any);
    expect(first.closeCalls).toEqual([[4000, 'replaced']]);
    expect(core.connections.get('inst-1')).toBeDefined();
  });

  it('on close: drops presence + marks offline', async () => {
    const sock = new FakeSocket();
    core.attachConnection(INSTANCE, sock as any);
    await flush();
    sock.emit('close');
    await flush();
    expect(deps.redis.del).toHaveBeenCalledWith('inst:presence:inst-1');
    expect(deps.rows[0].status).toBe('offline');
    expect(core.connections.has('inst-1')).toBe(false);
  });
});

describe('frame validation (never crashes, error frames back)', () => {
  let sock: FakeSocket;
  let conn: InstanceConnection;
  beforeEach(() => {
    sock = new FakeSocket();
    conn = core.attachConnection(INSTANCE, sock as any);
  });

  it('unknown frame type → error frame with the streamId echoed', () => {
    conn.handleMessage(JSON.stringify({ v: 1, type: 'explode', streamId: 's1' }));
    expect(sock.lastFrame()).toEqual({ v: 1, type: 'error', streamId: 's1', message: 'unknown frame type "explode"' });
  });

  it('non-JSON and non-v1 frames → error frame', () => {
    conn.handleMessage('not json at all');
    expect(sock.lastFrame().message).toContain('not JSON');
    conn.handleMessage(JSON.stringify({ v: 2, type: 'ping' }));
    expect(sock.lastFrame().message).toContain('v: 1');
  });

  it('data/end/head for an unknown streamId → error frame, nothing thrown', () => {
    for (const type of ['data', 'end', 'head']) {
      conn.handleMessage(JSON.stringify({ v: 1, type, streamId: 'nope' }));
      expect(sock.lastFrame()).toMatchObject({ type: 'error', streamId: 'nope', message: 'unknown streamId' });
    }
  });

  it('ping → pong + presence refresh; revoked status hard-closes the tunnel', async () => {
    conn.handleMessage(JSON.stringify({ v: 1, type: 'ping' }));
    await flush();
    expect(sock.frames().some(f => f.type === 'pong')).toBe(true);
    expect(deps.redis.setEx).toHaveBeenCalledWith('inst:presence:inst-1', 90, expect.any(String));
    expect(sock.closeCalls).toEqual([]);

    deps.rows[0].status = 'revoked';
    conn.handleMessage(JSON.stringify({ v: 1, type: 'ping' }));
    await flush();
    expect(sock.closeCalls).toEqual([[4403, 'revoked']]);
  });
});

describe('handleProxyRequest auth + failure shapes', () => {
  const proxy = async (req: FakeReq, res: FakeRes) => {
    const p = core.handleProxyRequest(req as any, res as any);
    await flush(); // let the handler reach readBody
    req.emit('end');
    await p;
  };

  it('401 with no token and with an invalid token', async () => {
    const res1 = new FakeRes();
    await proxy(new FakeReq('/api/crossmodel/instances/inst-1/proxy/crossmodel/chats'), res1);
    expect(res1.statusCode).toBe(401);

    const req2 = new FakeReq('/api/crossmodel/instances/inst-1/proxy/crossmodel/chats');
    req2.headers.authorization = 'Bearer garbage';
    const res2 = new FakeRes();
    await proxy(req2, res2);
    expect(res2.statusCode).toBe(401);
  });

  it('accepts the cm_access cookie as well as Bearer', async () => {
    const sock = new FakeSocket();
    core.attachConnection(INSTANCE, sock as any);
    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/crossmodel/chats');
    req.headers.cookie = 'cm_access=good-admin; other=1';
    const res = new FakeRes();
    await proxy(req, res);
    expect(sock.frames().some(f => f.type === 'open')).toBe(true);
  });

  it('403 for a non-admin caller', async () => {
    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/x');
    req.headers.authorization = 'Bearer good-user';
    const res = new FakeRes();
    await proxy(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.text()).toContain('admin');
  });

  it('404 for an unknown instance and for a foreign owner (no enumeration)', async () => {
    const req1 = new FakeReq('/api/crossmodel/instances/nope/proxy/x');
    req1.headers.authorization = 'Bearer good-admin';
    const res1 = new FakeRes();
    await proxy(req1, res1);
    expect(res1.statusCode).toBe(404);

    deps.rows[0].ownerUserId = 'someone-else';
    const req2 = new FakeReq('/api/crossmodel/instances/inst-1/proxy/x');
    req2.headers.authorization = 'Bearer good-admin';
    const res2 = new FakeRes();
    await proxy(req2, res2);
    expect(res2.statusCode).toBe(404);
  });

  it('502 when the instance is offline', async () => {
    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/x');
    req.headers.authorization = 'Bearer good-admin';
    const res = new FakeRes();
    await proxy(req, res);
    expect(res.statusCode).toBe(502);
    expect(res.text()).toContain('instance offline');
  });

  it('413 when the request body exceeds 1 MB', async () => {
    const sock = new FakeSocket();
    core.attachConnection(INSTANCE, sock as any);
    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/x');
    req.headers.authorization = 'Bearer good-admin';
    const res = new FakeRes();
    const p = core.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('data', Buffer.alloc(1024 * 1024 + 1));
    await p;
    expect(res.statusCode).toBe(413);
  });
});

describe('handleProxyRequest streaming', () => {
  it('forwards open with the stripped prefix + query, streams head/data/end', async () => {
    const sock = new FakeSocket();
    const conn = core.attachConnection(INSTANCE, sock as any);
    await flush();

    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/crossmodel/stream?chatId=c1');
    req.headers.authorization = 'Bearer good-admin';
    req.headers['x-custom'] = 'kept';
    const res = new FakeRes();
    const p = core.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('end');
    await p;

    const open = sock.frames().find(f => f.type === 'open');
    expect(open).toMatchObject({
      streamId: 'inst-1:1',
      method: 'GET',
      path: '/crossmodel/stream?chatId=c1',
    });
    expect(open.headers['x-custom']).toBe('kept');

    // Edge answers: head first (SSE), then chunks, then end.
    conn.handleMessage(JSON.stringify({ v: 1, type: 'head', streamId: 'inst-1:1', status: 200, headers: { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked', 'connection': 'keep-alive' } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['transfer-encoding']).toBeUndefined(); // hop-by-hop stripped
    expect(res.headers.connection).toBeUndefined();

    conn.handleMessage(JSON.stringify({ v: 1, type: 'data', streamId: 'inst-1:1', chunk: Buffer.from('data: hello\n\n').toString('base64') }));
    expect(res.text()).toBe('data: hello\n\n');
    expect(res.ended).toBe(false);

    conn.handleMessage(JSON.stringify({ v: 1, type: 'end', streamId: 'inst-1:1', status: 200, headers: {} }));
    expect(res.ended).toBe(true);
    expect(conn.streams.size).toBe(0);
  });

  it('a POST body travels base64 in the open frame', async () => {
    const sock = new FakeSocket();
    core.attachConnection(INSTANCE, sock as any);
    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/crossmodel/chats');
    req.method = 'POST';
    req.headers.authorization = 'Bearer good-admin';
    const res = new FakeRes();
    const p = core.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('data', Buffer.from('{"prompt":"hi"}'));
    req.emit('end');
    await p;
    const open = sock.frames().find(f => f.type === 'open');
    expect(Buffer.from(open.body, 'base64').toString()).toBe('{"prompt":"hi"}');
  });

  it('caps concurrent streams per instance at 64 → 503', async () => {
    const sock = new FakeSocket();
    const conn = core.attachConnection(INSTANCE, sock as any);
    for (let i = 0; i < MAX_STREAMS_PER_INSTANCE; i++) {
      conn.openStream(new FakeRes() as any, 'GET', '/x', {}, Buffer.alloc(0));
    }
    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/x');
    req.headers.authorization = 'Bearer good-admin';
    const res = new FakeRes();
    const p = core.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('end');
    await p;
    expect(res.statusCode).toBe(503);
  });

  it('edge error frame → 502 with the message when the head is not committed', async () => {
    const sock = new FakeSocket();
    const conn = core.attachConnection(INSTANCE, sock as any);
    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/x');
    req.headers.authorization = 'Bearer good-admin';
    const res = new FakeRes();
    const p = core.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('end');
    await p;
    conn.handleMessage(JSON.stringify({ v: 1, type: 'error', streamId: 'inst-1:1', message: 'local request failed' }));
    expect(res.statusCode).toBe(502);
    expect(res.text()).toContain('local request failed');
    expect(res.ended).toBe(true);
  });

  it('tunnel drop mid-stream fails the pending response', async () => {
    const sock = new FakeSocket();
    core.attachConnection(INSTANCE, sock as any);
    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/x');
    req.headers.authorization = 'Bearer good-admin';
    const res = new FakeRes();
    const p = core.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('end');
    await p;
    sock.emit('close');
    await flush();
    expect(res.statusCode).toBe(502);
    expect(res.text()).toContain('instance offline');
    expect(res.ended).toBe(true);
  });
});

describe('handleMessagesRequest (Phase 5 cloud→edge messaging)', () => {
  const URL = '/api/crossmodel/instances/inst-1/chats/chat-9/messages';
  const post = async (body: any, over: { token?: string; method?: string; url?: string } = {}) => {
    const req = new FakeReq(over.url || URL);
    req.method = over.method || 'POST';
    if (over.token) req.headers.authorization = `Bearer ${over.token}`;
    const res = new FakeRes();
    const p = core.handleMessagesRequest(req as any, res as any);
    await flush(); // let the handler reach readBody
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
    await p;
    return res;
  };

  it('401 with no token and with an invalid token', async () => {
    expect((await post({ message: 'hi' })).statusCode).toBe(401);
    expect((await post({ message: 'hi' }, { token: 'garbage' })).statusCode).toBe(401);
  });

  it('403 for a non-admin caller', async () => {
    const res = await post({ message: 'hi' }, { token: 'good-user' });
    expect(res.statusCode).toBe(403);
    expect(res.text()).toContain('admin');
  });

  it('404 for an unknown instance and for a foreign owner (no enumeration)', async () => {
    expect((await post({ message: 'hi' }, { token: 'good-admin', url: '/api/crossmodel/instances/nope/chats/chat-9/messages' })).statusCode).toBe(404);
    deps.rows[0].ownerUserId = 'someone-else';
    expect((await post({ message: 'hi' }, { token: 'good-admin' })).statusCode).toBe(404);
  });

  it('405 for a non-POST method (auth passes, method rejected)', async () => {
    expect((await post(undefined, { token: 'good-admin', method: 'GET' })).statusCode).toBe(405);
  });

  it('400 for invalid JSON, a missing message, and an out-of-range depth', async () => {
    expect((await post('not json{', { token: 'good-admin' })).statusCode).toBe(400);
    expect((await post({}, { token: 'good-admin' })).statusCode).toBe(400);
    const res = await post({ message: '  ' }, { token: 'good-admin' });
    expect(res.statusCode).toBe(400);
    expect(res.text()).toContain('message is required');
    expect((await post({ message: 'hi', depth: 11 }, { token: 'good-admin' })).statusCode).toBe(400);
    expect((await post({ message: 'hi', sourceLabel: 7 }, { token: 'good-admin' })).statusCode).toBe(400);
  });

  it('502 when the instance is offline', async () => {
    const res = await post({ message: 'hi' }, { token: 'good-admin' });
    expect(res.statusCode).toBe(502);
    expect(res.text()).toContain('instance offline');
  });

  it('happy path: forwards POST /crossmodel/cloud-link/receive with chatId merged into the JSON body', async () => {
    const sock = new FakeSocket();
    core.attachConnection(INSTANCE, sock as any);
    const res = await post({ message: 'hello edge', sourceLabel: 'cloud "home"', depth: 2 }, { token: 'good-admin' });
    const open = sock.frames().find((f) => f.type === 'open');
    expect(open).toMatchObject({ streamId: 'inst-1:1', method: 'POST', path: '/crossmodel/cloud-link/receive' });
    // Only content-type is forwarded — the edge tunnel client injects the
    // local JWT + x-cloud-relay itself and strips any incoming auth headers.
    expect(open.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(Buffer.from(open.body, 'base64').toString())).toEqual({
      chatId: 'chat-9', message: 'hello edge', sourceLabel: 'cloud "home"', depth: 2,
    });
    // The edge's status + JSON body stream straight back to the caller.
    const conn = core.connections.get('inst-1')!;
    conn.handleMessage(JSON.stringify({ v: 1, type: 'head', streamId: 'inst-1:1', status: 200, headers: { 'content-type': 'application/json' } }));
    conn.handleMessage(JSON.stringify({ v: 1, type: 'data', streamId: 'inst-1:1', chunk: Buffer.from('{"success":true,"data":{"delivery":"started"}}').toString('base64') }));
    conn.handleMessage(JSON.stringify({ v: 1, type: 'end', streamId: 'inst-1:1', status: 200, headers: {} }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.text())).toEqual({ success: true, data: { delivery: 'started' } });
    expect(res.ended).toBe(true);
  });

  it("passes the edge's error status + body through (e.g. 400 hook depth exceeded)", async () => {
    const sock = new FakeSocket();
    const conn = core.attachConnection(INSTANCE, sock as any);
    const res = await post({ message: 'hi', depth: 4 }, { token: 'good-admin' });
    conn.handleMessage(JSON.stringify({ v: 1, type: 'head', streamId: 'inst-1:1', status: 400, headers: { 'content-type': 'application/json' } }));
    conn.handleMessage(JSON.stringify({ v: 1, type: 'data', streamId: 'inst-1:1', chunk: Buffer.from('{"error":"hook depth exceeded"}').toString('base64') }));
    conn.handleMessage(JSON.stringify({ v: 1, type: 'end', streamId: 'inst-1:1', status: 400, headers: {} }));
    expect(res.statusCode).toBe(400);
    expect(res.text()).toContain('hook depth exceeded');
  });
});

describe('peer forwarding (multi-box prod: relay per box, socket in one)', () => {
  const MY_ADDR = '10.0.0.16:4302';
  const PEER_ADDR = '10.0.0.11:4301';
  const SAVED = process.env.RELAY_ADVERTISE_ADDR;
  beforeEach(() => { process.env.RELAY_ADVERTISE_ADDR = MY_ADDR; });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.RELAY_ADVERTISE_ADDR;
    else process.env.RELAY_ADVERTISE_ADDR = SAVED;
  });

  /** Fake ClientRequest: captures the call; respond/error on demand. */
  const mkHttpRequest = () => {
    const calls: any[] = [];
    const httpRequest = jest.fn((url: any, opts: any, cb: any) => {
      const req: any = new EventEmitter();
      req.end = jest.fn((body?: Buffer) => {
        calls.push({ url, opts, body });
        const peerRes: any = new EventEmitter();
        peerRes.statusCode = 200;
        peerRes.headers = { 'content-type': 'application/json' };
        peerRes.pipe = (dest: any) => { dest.write(Buffer.from('{"via":"peer"}')); dest.end(); };
        cb(peerRes);
      });
      req.destroy = jest.fn();
      return req;
    });
    return { httpRequest, calls };
  };

  it('attach/ping/detach maintain the socket-ownership key alongside presence', async () => {
    const sock = new FakeSocket();
    core.attachConnection(INSTANCE, sock as any);
    await flush();
    expect(deps.redis.setEx).toHaveBeenCalledWith('inst:socket:inst-1', 90, MY_ADDR);

    sock.emit('message', JSON.stringify({ v: 1, type: 'ping' }));
    await flush(); await flush();
    expect(deps.redis.setEx).toHaveBeenLastCalledWith('inst:socket:inst-1', 90, MY_ADDR);

    sock.emit('close');
    await flush(); await flush();
    expect(deps.redis.del).toHaveBeenCalledWith('inst:socket:inst-1');
  });

  it('proxy with no local tunnel but a peer-held socket forwards box-to-box and streams the peer response', async () => {
    const { httpRequest, calls } = mkHttpRequest();
    const peerDeps = mkDeps({ httpRequest });
    const peerCore = new RelayCore(peerDeps);
    // Pretend the peer relay owns the socket.
    await peerDeps.redis.setEx('inst:socket:inst-1', 90, PEER_ADDR);

    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/crossmodel/chats');
    req.headers.authorization = 'Bearer good-admin';
    const res = new FakeRes();
    const p = peerCore.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('end');
    await p;
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://${PEER_ADDR}/api/crossmodel/instances/inst-1/proxy/crossmodel/chats`);
    expect(calls[0].opts.headers[FORWARD_HEADER]).toBe('1');
    expect(calls[0].opts.headers.authorization).toBe('Bearer good-admin'); // peer re-auths the caller
    expect(res.statusCode).toBe(200);
    expect(res.text()).toBe('{"via":"peer"}');
    expect(res.ended).toBe(true);
  });

  it('never re-forwards a forwarded request (loop guard) — 502 offline instead', async () => {
    const { httpRequest } = mkHttpRequest();
    const peerDeps = mkDeps({ httpRequest });
    const peerCore = new RelayCore(peerDeps);
    await peerDeps.redis.setEx('inst:socket:inst-1', 90, PEER_ADDR);

    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/crossmodel/chats');
    req.headers.authorization = 'Bearer good-admin';
    req.headers[FORWARD_HEADER] = '1';
    const res = new FakeRes();
    const p = peerCore.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('end');
    await p;

    expect(httpRequest).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(502);
    expect(res.text()).toContain('instance offline');
  });

  it('a stale self-addressed socket key is treated as offline (no self-forward loop)', async () => {
    const { httpRequest } = mkHttpRequest();
    const selfDeps = mkDeps({ httpRequest });
    const selfCore = new RelayCore(selfDeps);
    await selfDeps.redis.setEx('inst:socket:inst-1', 90, MY_ADDR); // my own advertise addr

    const req = new FakeReq('/api/crossmodel/instances/inst-1/proxy/crossmodel/chats');
    req.headers.authorization = 'Bearer good-admin';
    const res = new FakeRes();
    const p = selfCore.handleProxyRequest(req as any, res as any);
    await flush();
    req.emit('end');
    await p;

    expect(httpRequest).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(502);
  });

  it('messages endpoint forwards the RAW request to the peer (peer re-runs auth + validation)', async () => {
    const { httpRequest, calls } = mkHttpRequest();
    const peerDeps = mkDeps({ httpRequest });
    const peerCore = new RelayCore(peerDeps);
    await peerDeps.redis.setEx('inst:socket:inst-1', 90, PEER_ADDR);

    const req = new FakeReq('/api/crossmodel/instances/inst-1/chats/chat-9/messages');
    req.method = 'POST';
    req.headers.authorization = 'Bearer good-admin';
    req.headers['content-type'] = 'application/json';
    const res = new FakeRes();
    const p = peerCore.handleMessagesRequest(req as any, res as any);
    await flush();
    const payload = Buffer.from(JSON.stringify({ message: 'hello edge' }));
    req.emit('data', payload);
    req.emit('end');
    await p;
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://${PEER_ADDR}/api/crossmodel/instances/inst-1/chats/chat-9/messages`);
    expect(calls[0].opts.method).toBe('POST');
    expect(Buffer.from(calls[0].body).toString()).toBe(payload.toString());
    expect(calls[0].opts.headers['content-length']).toBe(String(payload.length));
    expect(res.statusCode).toBe(200);
  });
});

/**
 * RELAY PREFIX ALIASING — leg (b) phase 1, relay leg
 * (docs/LEG_B_CROSSMODEL_RENAME_PLAN.md §3, "Known phase-1 gap").
 *
 * The backend serves every router under both prefixes; the relay is a separate
 * process and originally matched the literal old one, so
 * /api/digby/instances/{tunnel,proxy,messages} fell through to the backend and
 * 404'd. Same silent-failure shape as api-prefixes.test.ts: not a compile
 * error, just one URL shape dead while the other works.
 */
describe('relay prefix aliasing (both API prefixes served)', () => {
  it('serves the tunnel endpoint under EVERY prefix, canonical first', () => {
    expect(TUNNEL_PATHS).toEqual(API_PREFIXES.map((p) => `${p}/instances/tunnel`));
    for (const prefix of API_PREFIXES) {
      expect(isTunnelPath(`${prefix}/instances/tunnel`)).toBe(true);
    }
    // The canonical path is unchanged — emitted URLs and the edge client still
    // dial /api/crossmodel, which is what makes this additive.
    expect(TUNNEL_PATH).toBe(`${CANONICAL_API_PREFIX}/instances/tunnel`);
    expect(TUNNEL_PATH).toBe('/api/crossmodel/instances/tunnel');
    expect(ALIAS_API_PREFIX).toBe('/api/digby');
  });

  it('rejects near-miss tunnel paths (no prefix-smuggling, no suffix)', () => {
    for (const bad of [
      '/instances/tunnel',                       // no prefix at all
      '/api/other/instances/tunnel',             // unknown prefix
      '/api/digby/instances/tunnel/extra',       // trailing segment
      '/api/digbyx/instances/tunnel',            // prefix is not a plain prefix
      '/api/crossmodel/instances/tunnelX',
    ]) {
      expect(isTunnelPath(bad)).toBe(false);
    }
  });

  it('PROXY_PATH_RE matches both prefixes and captures the same groups', () => {
    for (const prefix of API_PREFIXES) {
      const m = PROXY_PATH_RE.exec(`${prefix}/instances/inst-1/proxy/crossmodel/chats`);
      expect(m).not.toBeNull();
      expect(m![1]).toBe('inst-1');
      expect(m![2]).toBe('/crossmodel/chats');
    }
    // A bare /proxy with no edge path is still valid (group 2 absent).
    const bare = PROXY_PATH_RE.exec('/api/digby/instances/inst-1/proxy');
    expect(bare).not.toBeNull();
    expect(bare![2]).toBeUndefined();
    // Not the proxy family under an unknown prefix.
    expect(PROXY_PATH_RE.test('/api/other/instances/inst-1/proxy/x')).toBe(false);
  });

  it('MESSAGES_PATH_RE matches both prefixes with instanceId + chatId intact', () => {
    for (const prefix of API_PREFIXES) {
      const m = MESSAGES_PATH_RE.exec(`${prefix}/instances/inst-1/chats/chat-9/messages`);
      expect(m).not.toBeNull();
      expect(m![1]).toBe('inst-1');
      expect(m![2]).toBe('chat-9');
    }
    expect(MESSAGES_PATH_RE.test('/api/other/instances/inst-1/chats/chat-9/messages')).toBe(false);
    expect(MESSAGES_PATH_RE.test('/api/digby/instances/inst-1/chats/chat-9/messages/extra')).toBe(false);
  });

  it('handleProxyRequest runs the SAME auth/ownership path on the alias prefix', async () => {
    const proxy = async (url: string, token?: string) => {
      const req = new FakeReq(url);
      if (token) req.headers.authorization = `Bearer ${token}`;
      const res = new FakeRes();
      const p = core.handleProxyRequest(req as any, res as any);
      await flush();
      req.emit('end');
      await p;
      return res;
    };
    // Behavioural parity: the alias prefix reaches the handler (NOT a 404 for
    // "Not found"), and it enforces the same 401/403/404 ladder as the old one.
    expect((await proxy('/api/digby/instances/inst-1/proxy/x')).statusCode).toBe(401);
    expect((await proxy('/api/digby/instances/inst-1/proxy/x', 'garbage')).statusCode).toBe(401);
    expect((await proxy('/api/digby/instances/inst-1/proxy/x', 'good-user')).statusCode).toBe(403);
    expect((await proxy('/api/digby/instances/nope/proxy/x', 'good-admin')).statusCode).toBe(404);
  });

  it('handleMessagesRequest runs the SAME path on the alias prefix', async () => {
    const post = async (url: string, token?: string, method = 'POST') => {
      const req = new FakeReq(url);
      req.method = method;
      if (token) req.headers.authorization = `Bearer ${token}`;
      const res = new FakeRes();
      const p = core.handleMessagesRequest(req as any, res as any);
      await flush();
      req.emit('data', Buffer.from(JSON.stringify({ message: 'hi' })));
      req.emit('end');
      await p;
      return res;
    };
    expect((await post('/api/digby/instances/inst-1/chats/chat-9/messages')).statusCode).toBe(401);
    expect((await post('/api/digby/instances/inst-1/chats/chat-9/messages', 'good-user')).statusCode).toBe(403);
    expect((await post('/api/digby/instances/nope/chats/chat-9/messages', 'good-admin')).statusCode).toBe(404);
    expect((await post('/api/digby/instances/inst-1/chats/chat-9/messages', 'good-admin', 'GET')).statusCode).toBe(405);
  });
});

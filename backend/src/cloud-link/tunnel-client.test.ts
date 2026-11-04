/**
 * tunnel-client — Digby Edge (Phase 3) edge-side tunnel client.
 * Pins: no-op when unlinked/disabled, WS dial-out with the decrypted dgi_
 * token (http→ws/https→wss), 30s ping cadence, open-frame dispatch to the
 * local REST API (incoming authorization/cookie STRIPPED, a 60s locally-signed
 * JWT + x-cloud-relay injected), streamed head/data/end frames, exponential
 * backoff reconnect, 401/4403 → state='error' + NO retry, and relay-side
 * aborts destroying in-flight local requests. ws + http are mocked; the JWT
 * is signed and verified for real.
 */

import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.JWT_SECRET = TEST_SECRET;
process.env.PORT = '4000';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config/env', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: process.env.JWT_SECRET } }));
jest.mock('../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../utils/jwt', () => ({ verifyAccessToken: jest.fn() }));
jest.mock('../modules/crossmodel/instances/instances.service', () => ({
  resolveInstanceByToken: jest.fn(),
  PRESENCE_KEY_PREFIX: 'inst:presence:',
}));

// ── ws mock: capture every constructed socket + its sent frames ─────────────
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  url: string;
  opts: any;
  constructor(url: string, opts?: any) {
    super();
    this.url = url;
    this.opts = opts;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { /* tests emit 'close' explicitly */ }
  frames(): any[] { return this.sent.map(s => JSON.parse(s)); }
}
jest.mock('ws', () => ({ __esModule: true, default: FakeWebSocket, WebSocketServer: jest.fn() }));

// ── http mock: capture requests, drive responses manually ───────────────────
class FakeClientRequest extends EventEmitter {
  written: Buffer[] = [];
  ended = false;
  destroyed = false;
  write(chunk: Buffer) { this.written.push(chunk); }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
class FakeIncomingMessage extends EventEmitter {
  statusCode = 200;
  headers: Record<string, any> = { 'content-type': 'application/json' };
}
const mockHttpRequest = jest.fn();
jest.mock('http', () => ({ request: (...args: any[]) => mockHttpRequest(...args) }));

// ── prisma mock ──────────────────────────────────────────────────────────────
const linkRow: any = { current: null };
const mockCloudLinkUpdate = jest.fn(async () => ({}));
jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    cloudLink: {
      findFirst: jest.fn(async () => linkRow.current),
      update: mockCloudLinkUpdate,
    },
    user: {
      findUnique: jest.fn(async () => ({ id: 'admin-1', email: 'a@b.c', role: 'ADMIN' })),
    },
  },
}));

import { CloudLinkTunnel } from './tunnel-client';
import { encryptValue } from '../modules/crossmodel/coding/credentials.service';

const TUNNEL_TOKEN = `dgi_${'a'.repeat(48)}`;

const seedLink = (state = 'linked', cloudUrl = 'https://digby.example.com') => {
  linkRow.current = {
    id: 'link-1',
    cloudUrl,
    tokenEnc: encryptValue(TUNNEL_TOKEN),
    instanceName: 'home-lab',
    pairedByUserId: 'admin-1',
    state,
  };
};

/** Flush microtasks (works under fake timers, which fake setImmediate). */
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

let tunnel: CloudLinkTunnel;

beforeEach(() => {
  FakeWebSocket.instances = [];
  mockHttpRequest.mockReset();
  linkRow.current = null;
  mockCloudLinkUpdate.mockClear();
  delete process.env.CLOUD_LINK_DISABLED;
  tunnel = new CloudLinkTunnel();
  jest.useFakeTimers();
});

afterEach(() => {
  tunnel.stop();
  jest.useRealTimers();
});

describe('start', () => {
  it('does nothing when unlinked, unlinked-state, or CLOUD_LINK_DISABLED', async () => {
    await tunnel.start();
    expect(FakeWebSocket.instances).toHaveLength(0);

    seedLink('error');
    await tunnel.start();
    expect(FakeWebSocket.instances).toHaveLength(0);

    seedLink();
    process.env.CLOUD_LINK_DISABLED = '1';
    await tunnel.start();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('dials wss with the decrypted dgi_ token and pings every 30s', async () => {
    seedLink();
    await tunnel.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://digby.example.com/api/crossmodel/instances/tunnel');
    expect(ws.opts.headers.authorization).toBe(`Bearer ${TUNNEL_TOKEN}`);

    ws.emit('open');
    expect(tunnel.isConnected()).toBe(true);
    jest.advanceTimersByTime(30_000);
    expect(ws.frames().filter(f => f.type === 'ping')).toHaveLength(1);
    jest.advanceTimersByTime(30_000);
    expect(ws.frames().filter(f => f.type === 'ping')).toHaveLength(2);
  });

  it('maps plain http cloud URLs to ws://', async () => {
    seedLink('linked', 'http://192.168.1.10:8080/');
    await tunnel.start();
    expect(FakeWebSocket.instances[0].url).toBe('ws://192.168.1.10:8080/api/crossmodel/instances/tunnel');
  });
});

describe('open frame dispatch', () => {
  const setupConnected = async () => {
    seedLink();
    await tunnel.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    return ws;
  };

  it('strips caller auth/cookie, injects a 60s local JWT + x-cloud-relay, streams head/data/end', async () => {
    const ws = await setupConnected();
    const fakeReq = new FakeClientRequest();
    let respondWith: ((res: FakeIncomingMessage) => void) | null = null;
    mockHttpRequest.mockImplementation((_opts: any, cb: any) => { respondWith = cb; return fakeReq; });

    ws.emit('message', Buffer.from(JSON.stringify({
      v: 1, type: 'open', streamId: 'inst-1:7', method: 'POST', path: '/crossmodel/chats/c1/messages',
      headers: { authorization: 'Bearer CLOUD-CALLER-JWT', cookie: 'cm_access=secret', 'x-keep': 'yes' },
      body: Buffer.from('{"prompt":"hi"}').toString('base64'),
    })));

    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    const [opts] = mockHttpRequest.mock.calls[0];
    expect(opts.hostname).toBe('127.0.0.1');
    expect(opts.port).toBe(4000);
    expect(opts.method).toBe('POST');
    expect(opts.path).toBe('/api/crossmodel/chats/c1/messages');
    // The cloud caller's credentials never reach the local API.
    expect(opts.headers.cookie).toBeUndefined();
    expect(opts.headers['x-keep']).toBe('yes');
    expect(opts.headers['x-cloud-relay']).toBe('1');
    const injected = (opts.headers.authorization as string).replace('Bearer ', '');
    expect(injected).not.toBe('CLOUD-CALLER-JWT');
    const payload = jwt.verify(injected, TEST_SECRET) as any;
    expect(payload.userId).toBe('admin-1');
    expect(payload.role).toBe('ADMIN');
    expect(payload.exp - payload.iat).toBe(60);
    // The proxied body is written to the local request.
    expect(Buffer.concat(fakeReq.written).toString()).toBe('{"prompt":"hi"}');
    expect(fakeReq.ended).toBe(true);

    // Local response streams back: head first, then data chunks, then end.
    const res = new FakeIncomingMessage();
    respondWith!(res);
    res.emit('data', Buffer.from('chunk-1'));
    res.emit('data', Buffer.from('chunk-2'));
    res.emit('end');

    const frames = ws.frames();
    const head = frames.find(f => f.type === 'head');
    expect(head).toMatchObject({ streamId: 'inst-1:7', status: 200, headers: { 'content-type': 'application/json' } });
    const data = frames.filter(f => f.type === 'data');
    expect(data.map(f => Buffer.from(f.chunk, 'base64').toString())).toEqual(['chunk-1', 'chunk-2']);
    const end = frames.find(f => f.type === 'end');
    expect(end).toMatchObject({ streamId: 'inst-1:7', status: 200 });
    // head precedes data precedes end, on the wire.
    const types = frames.map(f => f.type).filter(t => ['head', 'data', 'end'].includes(t));
    expect(types).toEqual(['head', 'data', 'data', 'end']);
  });

  it('local request failure → error frame', async () => {
    const ws = await setupConnected();
    const fakeReq = new FakeClientRequest();
    mockHttpRequest.mockImplementation(() => fakeReq);
    ws.emit('message', Buffer.from(JSON.stringify({ v: 1, type: 'open', streamId: 's1', method: 'GET', path: '/x', headers: {} })));
    fakeReq.emit('error', new Error('ECONNREFUSED'));
    expect(ws.frames().at(-1)).toMatchObject({ type: 'error', streamId: 's1', message: 'ECONNREFUSED' });
  });

  it('relay-side abort (error frame or WS close) destroys the in-flight local request', async () => {
    const ws = await setupConnected();
    const reqA = new FakeClientRequest();
    const reqB = new FakeClientRequest();
    mockHttpRequest.mockImplementationOnce(() => reqA).mockImplementationOnce(() => reqB);
    ws.emit('message', Buffer.from(JSON.stringify({ v: 1, type: 'open', streamId: 'a', method: 'GET', path: '/x', headers: {} })));
    ws.emit('message', Buffer.from(JSON.stringify({ v: 1, type: 'open', streamId: 'b', method: 'GET', path: '/y', headers: {} })));

    ws.emit('message', Buffer.from(JSON.stringify({ v: 1, type: 'error', streamId: 'a', message: 'client disconnected' })));
    expect(reqA.destroyed).toBe(true);
    expect(reqB.destroyed).toBe(false);

    ws.emit('close', 1006, Buffer.from(''));
    expect(reqB.destroyed).toBe(true);
  });
});

describe('reconnect + token rejection', () => {
  it('reconnects with exponential backoff after an abnormal close', async () => {
    seedLink();
    await tunnel.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('close', 1006, Buffer.from(''));
    expect(FakeWebSocket.instances).toHaveLength(1);

    jest.advanceTimersByTime(1_500); // first backoff: 1s + ≤25% jitter
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].emit('close', 1006, Buffer.from(''));
    jest.advanceTimersByTime(2_600); // second backoff: 2s + jitter
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('relay close 4403 (revoked) → state=error, NO retry', async () => {
    seedLink();
    await tunnel.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit('close', 4403, Buffer.from('revoked'));
    await flush();
    expect(mockCloudLinkUpdate).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { state: 'error', lastError: 'token rejected — re-pair' },
    });
    jest.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(tunnel.isConnected()).toBe(false);
  });

  it('HTTP 401 on the upgrade → state=error, NO retry', async () => {
    seedLink();
    await tunnel.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit('unexpected-response', {}, { statusCode: 401, resume: jest.fn() });
    ws.emit('close', 1006, Buffer.from(''));
    await flush();
    expect(mockCloudLinkUpdate).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { state: 'error', lastError: 'token rejected — re-pair' },
    });
    jest.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('pending-pair mode (device activation — the edge minted the code)', () => {
  const seedPending = () => {
    linkRow.current = {
      id: 'link-1',
      cloudUrl: 'https://digby.example.com',
      tokenEnc: '', // no token until the relay answers with a paired frame
      instanceName: 'home-lab',
      pairedByUserId: 'admin-1',
      state: 'pending',
    };
  };

  it('dials with Bearer dgp_<code> + ?name=, and a pre-pair close redials every ~3s with the same code', async () => {
    seedPending();
    await tunnel.startPendingPairing('ABCD2345', Date.now() + 600_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://digby.example.com/api/crossmodel/instances/tunnel?name=home-lab');
    expect(ws.opts.headers.authorization).toBe('Bearer dgp_ABCD2345');

    // An accepted dial is NOT a live tunnel yet — no connected flag, no pings.
    ws.emit('open');
    expect(tunnel.isConnected()).toBe(false);
    jest.advanceTimersByTime(60_000);
    expect(ws.frames()).toHaveLength(0);

    // Socket dropped before pairing → redial ~3s later with the same code.
    ws.emit('close', 1006, Buffer.from(''));
    jest.advanceTimersByTime(3_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].opts.headers.authorization).toBe('Bearer dgp_ABCD2345');
    expect(mockCloudLinkUpdate).not.toHaveBeenCalled();
  });

  it('a 401 before the cloud redeems the code is EXPECTED — retries, never an error state', async () => {
    seedPending();
    await tunnel.startPendingPairing('ABCD2345', Date.now() + 600_000);
    const ws = FakeWebSocket.instances[0];
    ws.emit('unexpected-response', {}, { statusCode: 401, resume: jest.fn() });
    await flush();
    expect(mockCloudLinkUpdate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].opts.headers.authorization).toBe('Bearer dgp_ABCD2345');
  });

  it('is a no-op without a pending row or when CLOUD_LINK_DISABLED', async () => {
    await tunnel.startPendingPairing('ABCD2345', Date.now() + 600_000);
    expect(FakeWebSocket.instances).toHaveLength(0);

    seedPending();
    process.env.CLOUD_LINK_DISABLED = '1';
    await tunnel.startPendingPairing('ABCD2345', Date.now() + 600_000);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('paired frame: token stored encrypted + state=linked, and the SAME socket continues as the live tunnel', async () => {
    seedPending();
    await tunnel.startPendingPairing('ABCD2345', Date.now() + 600_000);
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    const token = `dgi_${'d'.repeat(48)}`;
    ws.emit('message', Buffer.from(JSON.stringify({ v: 1, type: 'paired', instanceId: 'inst-9', token })));
    await flush();

    expect(mockCloudLinkUpdate).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { tokenEnc: expect.any(String), state: 'linked', lastError: null },
    });
    const stored = (mockCloudLinkUpdate.mock.calls[0] as any[])[0].data.tokenEnc as string;
    expect(stored).not.toContain(token); // AES-256-GCM, not plaintext
    expect(tunnel.isConnected()).toBe(true);

    // No disconnect, no redial: the ping cadence starts on the same socket.
    jest.advanceTimersByTime(30_000);
    expect(ws.frames().filter(f => f.type === 'ping')).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // A later drop reconnects in NORMAL mode with the real dgi_ token.
    ws.emit('close', 1006, Buffer.from(''));
    jest.advanceTimersByTime(1_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].opts.headers.authorization).toBe(`Bearer ${token}`);
    expect(FakeWebSocket.instances[1].url).toBe('wss://digby.example.com/api/crossmodel/instances/tunnel');
  });

  it('a malformed paired frame (no dgi_ token) → error state, no retry', async () => {
    seedPending();
    await tunnel.startPendingPairing('ABCD2345', Date.now() + 600_000);
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({ v: 1, type: 'paired', instanceId: 'inst-9' })));
    await flush();
    expect(mockCloudLinkUpdate).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { state: 'error', lastError: 'cloud sent a malformed paired frame — re-pair' },
    });
    jest.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('code TTL lapse → state=error with a clear re-generate message, retries stop', async () => {
    seedPending();
    await tunnel.startPendingPairing('ABCD2345', Date.now() + 2_000);
    const ws = FakeWebSocket.instances[0];
    ws.emit('close', 1006, Buffer.from(''));

    // Within the TTL a redial is scheduled…
    jest.advanceTimersByTime(1_500);
    expect(FakeWebSocket.instances).toHaveLength(1);
    // …but by the time it fires the code has expired → error, no more retries.
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(mockCloudLinkUpdate).toHaveBeenCalledWith({
      where: { id: 'link-1' },
      data: { state: 'error', lastError: 'pairing code expired — generate a new one' },
    });
    jest.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(tunnel.isConnected()).toBe(false);
  });
});

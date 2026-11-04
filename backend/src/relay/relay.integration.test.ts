/**
 * relay (integration) — Digby Edge (Phase 3). Real HTTP server + real ws
 * client on an ephemeral port through createRelayServer's actual transport:
 * a bad tunnel token gets a 401 upgrade rejection, a good one upgrades, and a
 * proxied HTTP request round-trips down the tunnel and streams back. DB /
 * Redis / token verification are injected fakes (same seams as the unit
 * tests); everything on the wire is real.
 */

import http from 'http';
import WebSocket from 'ws';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config/env', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32) } }));
jest.mock('../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../config/redis', () => ({ __esModule: true, default: { isOpen: true } }));
jest.mock('../utils/jwt', () => ({ verifyAccessToken: jest.fn() }));
jest.mock('../modules/crossmodel/instances/instances.service', () => ({
  resolveInstanceByToken: jest.fn(),
  PRESENCE_KEY_PREFIX: 'inst:presence:',
}));

import { createRelayServer } from '../relay';
import { RelayCore, TUNNEL_PATH } from './relay-core';

const INSTANCE = { id: 'inst-1', ownerUserId: 'admin-1', name: 'home-lab', status: 'pending', protocolVersion: 1 };

const mkCore = () => new RelayCore({
  db: {
    connectedInstance: {
      findUnique: jest.fn(async () => ({ ...INSTANCE })),
      update: jest.fn(async () => ({})),
    },
  },
  redis: { setEx: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), get: jest.fn(async () => null) },
  verifyToken: (token: string) => {
    if (token === 'good-admin') return { userId: 'admin-1', email: 'a@b.c', role: 'ADMIN' };
    throw new Error('bad token');
  },
  resolveToken: async (token: string) => (token === 'dgi_good' ? { ...INSTANCE } : null),
});

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = createRelayServer(mkCore());
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise(r => server.close(r));
});

const connectEdge = (token: string) => new WebSocket(`ws://127.0.0.1:${port}${TUNNEL_PATH}`, {
  headers: { authorization: `Bearer ${token}` },
});

describe('tunnel upgrade over a real socket', () => {
  it('rejects a bad token with HTTP 401 (no WS handshake)', async () => {
    const ws = connectEdge('dgi_wrong');
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode || 0));
      ws.on('open', () => resolve(101));
    });
    expect(status).toBe(401);
  });

  it('upgrades a good token and answers a ping with a pong', async () => {
    const ws = connectEdge('dgi_good');
    await new Promise<void>(r => ws.on('open', r));
    ws.send(JSON.stringify({ v: 1, type: 'ping' }));
    const frame = await new Promise<any>(r => ws.on('message', (raw) => r(JSON.parse(raw.toString()))));
    expect(frame).toMatchObject({ v: 1, type: 'pong' });
    ws.close();
    await new Promise(r => setImmediate(r));
  });
});

describe('proxy round-trip through a real tunnel', () => {
  it('streams an SSE-shaped response from the edge back to the HTTP caller', async () => {
    const edge = connectEdge('dgi_good');
    await new Promise<void>(r => edge.on('open', r));

    // The fake edge: answer any open with head + two chunks + end.
    edge.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== 'open') return;
      const { streamId } = frame;
      expect(frame.path).toBe('/crossmodel/stream?chatId=c1');
      edge.send(JSON.stringify({ v: 1, type: 'head', streamId, status: 200, headers: { 'content-type': 'text/event-stream' } }));
      edge.send(JSON.stringify({ v: 1, type: 'data', streamId, chunk: Buffer.from('data: one\n\n').toString('base64') }));
      edge.send(JSON.stringify({ v: 1, type: 'data', streamId, chunk: Buffer.from('data: two\n\n').toString('base64') }));
      edge.send(JSON.stringify({ v: 1, type: 'end', streamId, status: 200, headers: { 'content-type': 'text/event-stream' } }));
    });

    const { status, contentType, body } = await new Promise<any>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port,
        path: '/api/crossmodel/instances/inst-1/proxy/crossmodel/stream?chatId=c1',
        headers: { authorization: 'Bearer good-admin' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'],
          body: Buffer.concat(chunks).toString(),
        }));
      });
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(200);
    expect(contentType).toBe('text/event-stream');
    expect(body).toBe('data: one\n\ndata: two\n\n');

    edge.close();
    await new Promise(r => setImmediate(r));
  });

  it('401s the proxy without a caller token', async () => {
    const status = await new Promise<number>((resolve) => {
      http.get({
        host: '127.0.0.1', port,
        path: '/api/crossmodel/instances/inst-1/proxy/crossmodel/chats',
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
    });
    expect(status).toBe(401);
  });

  it('GET /health answers 200', async () => {
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode || 0));
      });
    });
    expect(status).toBe(200);
  });
});

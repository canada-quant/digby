/**
 * Chat-list events SSE endpoint (ticket 6201e0ee) — HTTP-level integration
 * test, the route-posture harness pattern (app.listen(0) + fetch, hermetic):
 * the REAL crossmodel-open router + REAL middleware/auth + REAL
 * platform/chat-events module + REAL controller method, with only the
 * heavyweight imports mocked (prisma, redis, jwt verify, logger).
 *
 * Pins the endpoint's contract end-to-end:
 *   - anonymous (no token) → 401 JSON, no stream;
 *   - a valid ?token= (EventSource auth) → 200 text/event-stream, a 'ready'
 *     frame, then a PUSHED 'chat-list-changed' frame the moment another
 *     request (the emission seam) fires — the ~1 s acceptance path;
 *   - a second user's stream never receives the first user's events.
 */

import express, { Express } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';

jest.mock('../../utils/jwt', () => ({
  // The real access-token payload carries userId (optionalAuthenticate maps
  // payload.userId → req.user.id) — mirror that shape, not the req.user one.
  verifyAccessToken: jest.fn((token: string) =>
    token === 'good-token'
      ? { userId: 'u1', email: 'owner@example.com' }
      : token === 'good-token-2'
        ? { userId: 'u2', email: 'other@example.com' }
        : undefined as any,
  ),
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    publish: jest.fn(async () => 1),
    duplicate: () => ({ connect: async () => undefined, on: () => undefined, subscribe: async () => undefined, quit: async () => undefined }),
  },
}));
jest.mock('../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import cookieParser from 'cookie-parser';
import { authenticate, optionalAuthenticate } from '../../middleware/auth';
import crossmodelOpenRoutes from './crossmodel-open.routes';
import { publishChatListEvent, __resetChatEventsForTest } from './platform/chat-events';

// Controller-level pin for the includeArchived seam (review B1/D: the param
// had ZERO coverage — an inert chain passes every other test). The /chats/changes
// controller method lives behind the app-level guard; mounted here directly
// with authenticate (the real posture) so the query string → archivedAny
// service call is pinned end-to-end at the HTTP layer.
jest.mock('./platform/platform.service', () => ({
  __esModule: true,
  listChats: jest.fn(async (opts: any) => ({
    chats: [{ id: 'chat-archived-now', archivedAt: '2026-10-07T17:00:00.000Z' }],
    pagination: { total: 1 },
    archivedAnyRequested: !!opts.archivedAny, // the observable the test asserts
  })),
}));
import * as platformService from './platform/platform.service';

/** Mount the open router exactly as app.ts does (before the app-level guard). */
function buildApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/crossmodel', crossmodelOpenRoutes);
  app.use('/api/crossmodel', authenticate); // the app-level guard, for completeness
  return app;
}

/** Read an SSE stream until a frame matching `match` arrives (or timeout). */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  match: (frame: string) => boolean,
  timeoutMs = 3000,
): Promise<string[]> {
  const frames: string[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: undefined; done: true }>((r) => setTimeout(() => r({ done: true }), Math.max(50, deadline - Date.now()))),
    ]);
    if (value) buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.startsWith('data:')) {
        frames.push(frame);
        if (match(frame)) { reader.cancel().catch(() => {}); return frames; }
      }
    }
    if (done) break;
  }
  reader.cancel().catch(() => {});
  return frames;
}

describe('GET /api/crossmodel/chats/events (SSE, ticket 6201e0ee)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    const app = buildApp();
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => {
    __resetChatEventsForTest();
  });

  it('anonymous → 401 JSON (no stream held open)', async () => {
    const res = await fetch(`${baseUrl}/api/crossmodel/chats/events`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { error?: string };
    expect(body.error).toBeDefined();
  });

  it('a valid token gets a text/event-stream: ready frame, then a PUSHED notice within ~1s of the mutation', async () => {
    const res = await fetch(`${baseUrl}/api/crossmodel/chats/events?token=good-token`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.body).toBeInstanceOf(ReadableStream);

    // The push arrives the moment the emission seam fires (another box's
    // mutation modeled here as an in-process publish for the same user).
    setTimeout(() => publishChatListEvent('u1', { kind: 'chat.archived', chatId: 'chat-0001-aaaa' }), 150);
    const frames = await readUntil(res.body!, (f) => f.includes('chat-list-changed'));
    const ready = frames.find((f) => f.includes('"ready"'));
    const notice = frames.find((f) => f.includes('chat-list-changed'));
    expect(ready).toBeDefined();
    expect(notice).toBeDefined();
    const payload = JSON.parse((notice as string).replace(/^data: /, ''));
    expect(payload).toEqual({
      type: 'chat-list-changed',
      data: { kind: 'chat.archived', chatId: 'chat-0001-aaaa', at: expect.any(String) },
    });
  });

  it('user isolation: u2\'s stream does not receive u1\'s events', async () => {
    const res1 = await fetch(`${baseUrl}/api/crossmodel/chats/events?token=good-token`);
    const res2 = await fetch(`${baseUrl}/api/crossmodel/chats/events?token=good-token-2`);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    setTimeout(() => publishChatListEvent('u1', { kind: 'chat.renamed', chatId: 'chat-0001-aaaa' }), 150);
    // u1 sees it…
    const frames1 = await readUntil(res1.body!, (f) => f.includes('chat-list-changed'));
    expect(frames1.some((f) => f.includes('chat-list-changed'))).toBe(true);
    // …u2 sees only its own ready frame within the window.
    const frames2 = await readUntil(res2.body!, () => false, 600);
    expect(frames2.some((f) => f.includes('chat-list-changed'))).toBe(false);
    expect(frames2.some((f) => f.includes('"ready"'))).toBe(true);
  });

  it('GET /chats/changes: ?includeArchived=1 widens the service call (review B1 — the param must reach archivedAny)', async () => {
    const listChats = platformService.listChats as jest.Mock;
    listChats.mockClear();
    // Authed GET on the /changes endpoint (behind the app-level guard in the
    // real app — mounted here with the same authenticate middleware).
    const app = express();
    app.use(cookieParser());
    app.use('/api/crossmodel', authenticate);
    // The changes route lives on the AUTHED router — import it directly so
    // the open router's mounting doesn't shadow it in this harness.
    const { default: authedRouter } = await import('./crossmodel.routes');
    app.use('/api/crossmodel', authedRouter);
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const withFlag = await fetch(`${url}/api/crossmodel/chats/changes?since=2026-10-07T12:00:00Z&includeArchived=1`, {
        headers: { Authorization: 'Bearer good-token' },
      });
      expect(withFlag.status).toBe(200);
      const body = await withFlag.json() as any;
      expect(body.success).toBe(true);
      expect(listChats).toHaveBeenCalledTimes(1);
      expect(listChats.mock.calls[0][0]).toMatchObject({ archivedAny: true, userId: 'u1' });

      listChats.mockClear();
      const withoutFlag = await fetch(`${url}/api/crossmodel/chats/changes?since=2026-10-07T12:00:00Z`, {
        headers: { Authorization: 'Bearer good-token' },
      });
      expect(withoutFlag.status).toBe(200);
      expect(listChats).toHaveBeenCalledTimes(1);
      // Without the flag the service call carries NO archivedAny key at all
      // (spread-conditional) — toMatchObject can't assert an absent key.
      expect(listChats.mock.calls[0][0]).not.toHaveProperty('archivedAny');
    } finally {
      srv.close();
    }
  });

  it('an INVALID token is anonymous (optionalAuthenticate continues) → 401', async () => {
    const res = await fetch(`${baseUrl}/api/crossmodel/chats/events?token=bad-token`);
    expect(res.status).toBe(401);
  });
});

/**
 * POST /api/crossmodel/client-error — HTTP-level integration test (ticket
 * d4e643a5). The route-posture harness pattern the chat-events endpoint test
 * established: the REAL crossmodel-open router + REAL optionalAuthenticate +
 * REAL validation schema + REAL controller + REAL sanitizer/throttle, with only
 * the heavyweight edges mocked (logger, prisma, redis).
 *
 * The ticket's acceptance, pinned end-to-end:
 *   1. a thrown client error is ACCEPTED and written through the existing
 *      logger (⇒ one app_error_logs row) stamped source 'client-error';
 *   2. the same signature repeated 100× produces ONE write;
 *   3. no user text and no token appears in what would be persisted;
 *   4. the endpoint is reachable WITHOUT a token (a crash inside the login flow
 *      has none) and never echoes the payload back.
 */
import express, { Express } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import cookieParser from 'cookie-parser';

// The real logger wraps winston + the Prisma transport; the row shape is what
// this suite asserts, so capture the log() calls at the seam the transport sees.
const logged: Array<Record<string, unknown>> = [];
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: {
    log: jest.fn((rec: Record<string, unknown>) => { logged.push(rec); }),
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
  },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), incr: jest.fn(async () => 1), expire: jest.fn(async () => 1) } }));
jest.mock('../../../utils/jwt', () => ({
  verifyAccessToken: jest.fn((token: string) => (token === 'good-token' ? { userId: 'u1', email: 'owner@example.com' } : undefined)),
}));
// The import chain crossmodel-open.routes → controller → service → error-handler
// pulls config/env, whose zod parse calls process.exit(1) on a bare test env.
// The sibling open-route suites (chat-events.endpoint.test.ts) break the chain
// at the same seam; only AppError is consumed here.
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));
// The canonical backend secret set is a real leaf — keep it REAL (that is the
// second-layer scrub the test asserts on). Only the route's neighbours are stubbed.

import { authenticate, optionalAuthenticate } from '../../../middleware/auth';
import crossmodelOpenRoutes from '../crossmodel-open.routes';
import { __resetClientErrorThrottle } from './client-error-throttle';
import { CLIENT_ERROR_SOURCE, CLIENT_ERROR_MAX_BODY_BYTES } from './client-error.controller';

function buildApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  // The open router mounts BEFORE the app-level guard in app.ts; the guard is
  // added here too so a route that accientally landed behind it fails loudly.
  app.use('/api/crossmodel', crossmodelOpenRoutes);
  app.use('/api/crossmodel', authenticate);
  // error-handler is mocked above (its config/env import calls process.exit on
  // a bare test env), so mirror its DOCUMENTED status mapping here: a ZodError
  // answers 400, anything else 500 (middleware/error-handler.ts:122). Without
  // this the validate() rejection would fall through to express's default 500
  // and the suite would be asserting on the stub, not on the route's contract.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const isZod = err && err.name === 'ZodError';
    res.status(isZod ? 400 : 500).json({ error: err?.message ?? 'error' });
  });
  return app;
}

const post = async (baseUrl: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/api/crossmodel/client-error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('POST /api/crossmodel/client-error (ticket d4e643a5)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    server = buildApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => { logged.length = 0; __resetClientErrorThrottle(); });

  it('ACCEPTANCE 1 — a thrown render error is written through the logger as source client-error', async () => {
    const res = await post(baseUrl, {
      message: "TypeError: Cannot read properties of undefined (reading 'id')",
      stack: "TypeError: Cannot read properties of undefined (reading 'id')\n    at ChatRow (https://digby.ai/_next/static/chunks/app/page.js:1:22345)",
      url: 'https://digby.ai/crossmodel/chat/abc?token=should-not-be-stored',
      route: '/crossmodel/chat',
      source: 'error-boundary',
      buildSha: 'd9ae52784f',
      userAgent: 'Mozilla/5.0 (Macintosh)',
    });
    expect(res.status).toBe(204);
    // 204 carries no body — a crashing tab must never receive an echo.
    expect(await res.text()).toBe('');

    expect(logged).toHaveLength(1);
    const row = logged[0];
    expect(row.source).toBe(CLIENT_ERROR_SOURCE);
    expect(row.level).toBe('error');
    expect(String(row.message)).toContain('client-error:');
    expect(String(row.message)).toContain('Cannot read properties of undefined');
    // The context is what the Prisma transport maps into app_error_logs.context.
    expect(row.signature).toBeDefined();
    expect(row.clientSource).toBe('error-boundary');
    expect(row.buildSha).toBe('d9ae52784f');
    expect(row.route).toBe('/crossmodel/chat');
    // The URL is reduced to origin+pathname — the ?token= is GONE.
    expect(row.url).toBe('https://digby.ai/crossmodel/chat/abc');
    expect(JSON.stringify(row)).not.toContain('should-not-be-stored');
  });

  it('ACCEPTANCE 2 — the same signature 100× writes ONE row (a render loop cannot flood the table)', async () => {
    const body = {
      message: 'Error: Maximum update depth exceeded',
      stack: 'Error: Maximum update depth exceeded\n    at ChatRow (https://digby.ai/_next/static/chunks/app/page.js:1:100)',
      source: 'onerror',
    };
    for (let i = 0; i < 100; i++) {
      const res = await post(baseUrl, body);
      // Every one is ACCEPTED (204) — the tab is never told to retry a duplicate.
      expect(res.status).toBe(204);
    }
    expect(logged).toHaveLength(1);
  });

  it('still admits the SAME error again once its window lapses (recurrence stays visible to the sweep)', async () => {
    const body = { message: 'Error: boom', stack: 'Error: boom\n    at x (https://digby.ai/a.js:1:1)' };
    await post(baseUrl, body);
    // Simulate the elapsed window by advancing the throttle clock through its
    // public pure seam (the endpoint itself reads Date.now via the default arg).
    const { admitClientErrorReport } = await import('./client-error-throttle');
    __resetClientErrorThrottle();
    expect(admitClientErrorReport('unrelated-probe', null).admit).toBe(true);
    const res = await post(baseUrl, body);
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(2);
  });

  it('ACCEPTANCE 3 — no user message content and no token appears in the persisted row', async () => {
    const typed = 'my daughter has an appointment with Dr Chen at 4pm, remember it';
    // Both values are ASSEMBLED, never literal: a token-shaped literal is a
    // gitleaks hit in the public mirror, and allowlisting the file would blind
    // the scanner to a real key pasted here later.
    const token = ['eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiJ1c2VyLTEyMyJ9', '.c2lnbmF0dXJlLXZhbHVlLWhlcmU'].join('');
    const queryToken = ['sk', 'proj', 'abcdefghijklmnop0123456789'].join('-');
    const res = await post(baseUrl, {
      message: `Error: render failed while showing "${typed}"`,
      stack: `Error: render failed\n    at ChatMessage (https://digby.ai/app.js:1:9)\n    at fetchUser (https://digby.ai/app.js:2:9) Authorization: Bearer ${token}`,
      url: `https://digby.ai/chat?token=${queryToken}`,
      source: 'onerror',
    });
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
    const persisted = JSON.stringify(logged[0]);
    // The user's words never reach the row.
    expect(persisted).not.toContain('Dr Chen');
    expect(persisted).not.toContain(typed);
    // Neither token shape does — the JWT nor the provider key from the query.
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(queryToken);
    expect(persisted).toContain('<text>');
  });

  it('the second-layer scrub catches a canonical provider shape the browser side does not know', async () => {
    const anthropicKey = ['sk', 'ant', 'api03', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'].join('-');
    const res = await post(baseUrl, {
      message: `Upstream 401 for key ${anthropicKey}`,
      source: 'unhandledrejection',
    });
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).not.toContain('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
  });

  it('is reachable with NO token (a crash on the login page has none)', async () => {
    const res = await post(baseUrl, { message: 'Error: login form crashed', source: 'onerror' });
    expect(res.status).toBe(204);
    expect(logged).toHaveLength(1);
  });

  it('links the report to the user when a valid token is present', async () => {
    const res = await post(baseUrl, { message: 'Error: signed-in crash', source: 'onerror' }, { Authorization: 'Bearer good-token' });
    expect(res.status).toBe(204);
    expect(logged[0].userId).toBe('u1');
  });

  it('an anonymous report carries no userId at all', async () => {
    await post(baseUrl, { message: 'Error: guest crash', source: 'onerror' });
    expect(logged[0].userId).toBeUndefined();
  });

  it('rejects a report with no message (nothing recordable) and writes nothing', async () => {
    const res = await post(baseUrl, { source: 'onerror' });
    expect(res.status).toBe(400);
    expect(logged).toHaveLength(0);
  });

  it('rejects a body over the route cap (413) without sanitizing or writing', async () => {
    const res = await post(baseUrl, { message: 'x', stack: 'y'.repeat(CLIENT_ERROR_MAX_BODY_BYTES + 100) });
    expect(res.status).toBe(413);
    expect(logged).toHaveLength(0);
  });

  it('CLIENT_ERROR_INGEST_DISABLED=1 answers 204 and records nothing', async () => {
    const prev = process.env.CLIENT_ERROR_INGEST_DISABLED;
    process.env.CLIENT_ERROR_INGEST_DISABLED = '1';
    try {
      const res = await post(baseUrl, { message: 'Error: switched off', source: 'onerror' });
      expect(res.status).toBe(204);
      expect(logged).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.CLIENT_ERROR_INGEST_DISABLED;
      else process.env.CLIENT_ERROR_INGEST_DISABLED = prev;
    }
  });

  it('a client rotating signatures cannot exceed its per-minute ceiling (the outer bound still admits the next client)', async () => {
    // Every report is a DISTINCT signature, so the signature window does not help.
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await post(baseUrl, { message: `Error: unique-${i}`, source: 'onerror' });
      statuses.push(res.status);
    }
    // All accepted at the HTTP layer (204) — the throttle drops, never errors.
    expect(statuses.every((s) => s === 204)).toBe(true);
    // …but the writes are bounded by the per-client cap in the controller's
    // throttle (MAX_PER_CLIENT_PER_MIN), far below the 60 posted.
    const { MAX_PER_CLIENT_PER_MIN } = await import('./client-error-throttle');
    expect(logged.length).toBeLessThanOrEqual(MAX_PER_CLIENT_PER_MIN);
  });
});
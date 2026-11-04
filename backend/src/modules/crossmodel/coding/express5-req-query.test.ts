/**
 * Express 5 req.query getter — regression pins for the two mutation sites the
 * reviewer caught AFTER the core migration (PR #324 first round):
 *
 *  (1) coding-preview.controller.ts cookieToQuery wrote `(req.query as any)
 *      .token = c` — under v5 the write lands on a throwaway re-parse and the
 *      dcp-cookie → ?token copy silently vanishes (preview sub-resources 401
 *      on the dedicated preview host). Fix: defineProperty shadow.
 *  (2) coding-stream.controller.ts streamCapabilityRun did `delete (req.query
 *      as any).message` after queueing — under v5 the delete no-ops, so
 *      streamRunInner re-read the query message and double-queued (busy 409
 *      on an otherwise fine attach). Fix: explicit message-override param.
 *
 * Both tests drive REAL express apps (port 0 + fetch) so req.query is the v5
 * prototype getter — a mocked plain-object req.query would not pin anything.
 */

import express from 'express';
import type { Server } from 'http';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('./container.service', () => ({
  ensureSessionContainer: jest.fn(),
  execInContainer: jest.fn(),
}));
jest.mock('./workspace.service', () => ({ worktreePath: jest.fn(() => '/tmp/wt') }));

const mockQueueAgentRun: jest.Mock = jest.fn(async () => ({ id: 'r1' }));
const mockGetActiveRun: jest.Mock = jest.fn(async () => null);
const mockGetLatestRun: jest.Mock = jest.fn(async () => null);
const mockGetEventsAfter: jest.Mock = jest.fn(async () => []);
jest.mock('./run-state', () => ({
  queueAgentRun: (...a: any[]) => mockQueueAgentRun(...a),
  getActiveRunForSession: (...a: any[]) => mockGetActiveRun(...a),
  getLatestRunForSession: (...a: any[]) => mockGetLatestRun(...a),
  getAgentEventsAfter: (...a: any[]) => mockGetEventsAfter(...a),
  SessionBusyError: class SessionBusyError extends Error {
    readonly code = 'BUSY';
    constructor() { super('busy'); this.name = 'SessionBusyError'; }
  },
}));

const mockGetSessionForUser: jest.Mock = jest.fn();
const mockEnsureChatWorkspaceState: jest.Mock = jest.fn(async () => null);
jest.mock('./coding-data.service', () => ({
  getSessionForUser: (...a: any[]) => mockGetSessionForUser(...a),
  updateSessionState: jest.fn(async () => {}),
  ensureChatWorkspaceState: (...a: any[]) => mockEnsureChatWorkspaceState(...a),
  appendCodingMessage: jest.fn(async () => ({ id: 'msg1' })),
  CLAIMABLE_ROW_FRESH_MS: 15 * 60 * 1000,
}));

jest.mock('./session-run-lock', () => ({
  isSessionRunLocked: jest.fn(async () => false),
  requestRunCancel: jest.fn(async () => {}),
  pushSteerMessage: jest.fn(async () => {}),
  getApprovalPendingSession: jest.fn(async () => null),
  publishApprovalResolution: jest.fn(async () => {}),
  getQuestionPendingSession: jest.fn(async () => null),
  publishQuestionResolution: jest.fn(async () => {}),
}));
jest.mock('./pending-durable', () => ({
  loadDurablePending: jest.fn(async () => null),
  markDurableResolved: jest.fn(async () => {}),
  currentIdForFingerprint: jest.fn(async () => null),
}));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  consumeCapSkipNotice: jest.fn(async () => 0),
  restoreCapSkipNotice: jest.fn(async () => {}),
}));

// 7f546b03: coding-stream.controller now statically imports AppError —
// error-handler reaches config/env (process.exit at import in a keyless test
// env), so it's mocked at the boundary (same shape as platform.service.test).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

import streamController from './coding-stream.controller';
import previewController from './coding-preview.controller';

async function call(
  app: express.Express,
  path: string,
  headers: Record<string, string> = {},
  init: { method?: string; body?: string } = {},
) {
  const server: Server = await new Promise((resolve) => {
    // Bind to 127.0.0.1 explicitly (the fetch below targets it): a port-0 listen on
    // the dual-stack wildcard can be handed a port number another jest worker holds
    // on 127.0.0.1, and the request then lands on THAT server (a 200 whose body is
    // not ours) — the full-suite-only flake seen on the 2026-09-28 backlog merge.
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers, ...init });
    const body: any = await r.json().catch(() => null);
    return { status: r.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const authed = (req: any, _res: any, next: any) => {
  req.user = { id: 'u1' };
  next();
};

describe('cookieToQuery (Express 5 req.query getter)', () => {
  function buildApp() {
    const app = express();
    app.get('/p', previewController.cookieToQuery.bind(previewController), (req, res) => {
      res.json({ token: (req.query as any).token ?? null });
    });
    return app;
  }

  it('copies the dcp cookie into ?token so downstream auth sees it', async () => {
    const r = await call(buildApp(), '/p', { cookie: 'dcp=preview-token-123' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBe('preview-token-123');
  });

  it('an explicit ?token= wins over the cookie (precedence preserved)', async () => {
    const r = await call(buildApp(), '/p?token=explicit', { cookie: 'dcp=from-cookie' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBe('explicit');
  });
});

describe('streamCapabilityRun → streamRunInner (no double-queue under Express 5)', () => {
  const CHAT = { id: 's1', userId: 'u1', projectId: 'p1', title: 't' };
  const SESSION: any = {
    id: 's1', userId: 'u1', projectId: 'p1', title: 't', status: 'ready',
    worktreePath: '/x', project: { id: 'p1' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockGetActiveRun.mockResolvedValue(null);
    mockQueueAgentRun.mockResolvedValue({ id: 'r1' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('queues once, then attaches with an explicit EMPTY message override', async () => {
    const innerSpy = jest
      .spyOn(streamController as any, 'streamRunInner')
      .mockImplementation((async (_req: any, res: any, override?: string) => {
        res.json({ override: override ?? null });
      }) as any);
    const app = express();
    app.get('/s', authed, (req, res) => {
      const message = typeof req.query.message === 'string' ? req.query.message : '';
      return (streamController as any).streamCapabilityRun(req, res, CHAT, message);
    });

    const r = await call(app, '/s?message=hello');
    expect(r.status).toBe(200);
    // The pin: pre-fix, streamRunInner was invoked with NO override and re-read
    // the still-present query message (the delete no-ops under v5) → 409.
    expect(r.body.override).toBe('');
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({ message: 'hello' }));
    innerSpy.mockRestore();
  });

  it('streamRunInner with an empty override ignores ?message= entirely (no second queue)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION });
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const tailSpy = jest
      .spyOn(streamController as any, 'tailActiveRun')
      .mockImplementation((async (_req: any, res: any, run: any) => {
        res.json({ tailed: run.id });
      }) as any);
    const app = express();
    // The mounted shape (/coding/sessions/:id/stream) — PE-01: a route with
    // neither :id nor ?chatId= now answers 400 instead of an undefined lookup.
    app.get('/s2/:id', authed, (req, res) => (streamController as any).streamRunInner(req, res, ''));

    const r = await call(app, '/s2/s1?message=hello');
    expect(r.status).toBe(200);
    expect(r.body.tailed).toBe('r1');
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
    tailSpy.mockRestore();
  });
});

/* PE-01 / 7acaa7ba: the unified chat stream is mounted WITHOUT a route param
 * (`GET /api/crossmodel/stream?chatId=…`, crossmodel-open.routes.ts) and hands
 * a workspace-attached chat to streamCapabilityRun. Under real Express
 * req.params is `{}` there, so the attach's old `req.params.id` read was
 * undefined → prisma findUnique({ where: { id: undefined } }) → 500 after the
 * run had already been queued. These drive the REAL streamRunInner (only the
 * tailer is stubbed) through a real Express app with the prod route shapes. */
describe('streamCapabilityRun over GET/POST /stream (no :id route param) — PE-01 / 7acaa7ba', () => {
  const CHAT = { id: 's1', userId: 'u1', projectId: 'p1', title: 't' };
  const SESSION: any = {
    id: 's1', userId: 'u1', projectId: 'p1', title: 't', status: 'ready',
    worktreePath: '/x', project: { id: 'p1' },
  };
  let tailSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockGetSessionForUser.mockResolvedValue({ ...SESSION });
    mockQueueAgentRun.mockResolvedValue({ id: 'r-new' });
    // No active run at the busy check; the just-queued row is visible to the attach.
    mockGetActiveRun.mockResolvedValueOnce(null).mockResolvedValue({ id: 'r-new', status: 'queued' });
    tailSpy = jest
      .spyOn(streamController as any, 'tailActiveRun')
      .mockImplementation((async (_req: any, res: any, run: any) => {
        res.json({ tailed: run.id });
      }) as any);
  });
  afterEach(() => tailSpy.mockRestore());

  it('GET /stream?chatId=s1&message=… on a workspace-attached chat: queues once, attaches by the seeded id (no 500)', async () => {
    const app = express();
    // The prod shape: the chat is resolved from ?chatId= by the chat controller
    // and handed over; the route itself carries no `:id`.
    app.get('/stream', authed, (req, res) => {
      const message = typeof req.query.message === 'string' ? req.query.message : '';
      return (streamController as any).streamCapabilityRun(req, res, CHAT, message);
    });
    const r = await call(app, '/stream?chatId=s1&message=fix%20formatting');
    expect(r.status).toBe(200);
    expect(r.body.tailed).toBe('r-new');
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({ message: 'fix formatting' }));
    expect(mockGetSessionForUser).toHaveBeenCalledWith('s1', 'u1', 'read', expect.anything());
    for (const c of mockGetSessionForUser.mock.calls) expect(c[0]).toBe('s1');
  });

  it('POST /stream (chatId + message in the BODY, empty query): the same seeded attach', async () => {
    const app = express();
    app.use(express.json());
    app.post('/stream', authed, (req, res) => {
      const message = typeof req.body?.message === 'string' ? req.body.message : '';
      return (streamController as any).streamCapabilityRun(req, res, CHAT, message);
    });
    const r = await call(app, '/stream', { 'content-type': 'application/json' }, {
      method: 'POST', body: JSON.stringify({ chatId: 's1', message: 'good gift for a 9 year old' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.tailed).toBe('r-new');
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
    for (const c of mockGetSessionForUser.mock.calls) expect(c[0]).toBe('s1');
  });

  it('the raw attach with neither :id nor ?chatId= answers 400, not a Prisma 500', async () => {
    const app = express();
    app.get('/attach', authed, (req, res) => (streamController as any).streamRun(req, res));
    const r = await call(app, '/attach');
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/session id/i);
    expect(mockGetSessionForUser).not.toHaveBeenCalled();
  });
});

/**
 * Account-deletion tests (M2-prep — App Store 5.1.1(v) / Play Data-deletion).
 *
 * Two layers:
 *  1. SERVICE: password re-auth, the FK-less cleanup (user_memory_facts +
 *     context-store user namespace) BEFORE the cascade delete, idempotency on
 *     an already-deleted user, and the logger call.
 *  2. HTTP POSTURE: the route mounts on /api/auth (BEFORE the app-level
 *     guard), so it carries its own inline authenticate — anon requests 401,
 *     missing password 400s, wrong password 401s, success clears cookies.
 *
 * Hermetic: prisma + logger + password utils + jwt mocked (the
 * push.service.test pattern); app.listen(0) + fetch like route-posture.test.
 */

import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'http';

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    userMemoryFact: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    contextStoreEntry: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
// bcrypt is slow and env-dependent — tests control the verdict.
jest.mock('../../utils/password', () => ({
  __esModule: true,
  hashPassword: jest.fn(),
  comparePassword: jest.fn(),
}));
// middleware/auth pulls verifyAccessToken — tests control the verdict.
jest.mock('../../utils/jwt', () => ({
  __esModule: true,
  verifyAccessToken: jest.fn(),
}));
// auth.controller pulls context.service → config/database + much of the
// crossmodel module tree; its handlers never run in these tests (only
// deleteAccount does, which never touches it), so a load-time stub suffices.
jest.mock('../crossmodel/context.service', () => ({
  __esModule: true,
  default: {},
}));
// Account deletion clears the chat-scope memory mirror of the user's supervisor
// chats after the commit (dynamic import) — the real module pulls the memory graph.
const mockMemClear = jest.fn(async (..._a: any[]) => undefined);
jest.mock('../crossmodel/memory/unified-memory.service', () => ({
  __esModule: true,
  memClear: (...a: any[]) => mockMemClear(...a),
}));
// error-handler pulls config/env → process.exit without env vars (CI is env-less).
jest.mock('../../config/env', () => ({
  __esModule: true,
  env: {},
}));

import authRoutes from './auth.routes';
import authService from './auth.service';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { comparePassword } from '../../utils/password';
import { verifyAccessToken } from '../../utils/jwt';
import { errorHandler } from '../../middleware/error-handler';

const mockedPrisma = prisma as unknown as {
  user: { findUnique: jest.Mock; delete: jest.Mock };
  userMemoryFact: { deleteMany: jest.Mock };
  contextStoreEntry: { deleteMany: jest.Mock };
  $transaction: jest.Mock;
};
const mockedCompare = comparePassword as jest.Mock;
const mockedVerify = verifyAccessToken as jest.Mock;

/** The transaction mock returns whatever the callback produces. */
function mockTransaction(): {
  tx: {
    userMemoryFact: { deleteMany: jest.Mock };
    userMemoryFactVersion: { deleteMany: jest.Mock };
    contextStoreEntry: { deleteMany: jest.Mock };
    crossModelChat: { findMany: jest.Mock };
    supervisorState: { findMany: jest.Mock };
    user: { delete: jest.Mock };
  };
} {
  const tx = {
    userMemoryFact: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    userMemoryFactVersion: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
    contextStoreEntry: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    crossModelChat: { findMany: jest.fn().mockResolvedValue([]) },
    supervisorState: { findMany: jest.fn().mockResolvedValue([]) },
    user: { delete: jest.fn().mockResolvedValue({}) },
  };
  mockedPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  return { tx };
}

// ── SERVICE LAYER ─────────────────────────────────────────────────────────────

describe('authService.deleteAccount (M2-prep 5.1.1(v))', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('re-auths with the password, cleans FK-less rows, then hard-deletes the user', async () => {
    (mockedPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      password: 'hashed',
      deletedAt: null,
    });
    mockedCompare.mockResolvedValue(true);
    const { tx } = mockTransaction();

    const result = await authService.deleteAccount('u1', { password: 'pw' });

    expect(result).toEqual({ deleted: true });
    expect(mockedCompare).toHaveBeenCalledWith('pw', 'hashed');
    // FK-less cleanup ran, in order, BEFORE the user delete — all inside the tx.
    expect(tx.userMemoryFact.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    // 2026-10-20: the fact value history (user_memory_fact_versions) goes with the account.
    expect(tx.userMemoryFactVersion.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(tx.contextStoreEntry.deleteMany).toHaveBeenCalledWith({
      where: { namespacePath: { startsWith: 'u1:' } },
    });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(logger.info).toHaveBeenCalledWith('User account deleted: a@b.c');
  });

  it("also clears the chat-keyed store rows of the user's chats (thread state + the supervisor cold archive) inside the tx, and the supervisor chats' memory mirror after it (review 2026-10-23)", async () => {
    (mockedPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', email: 'a@b.c', password: 'hashed', deletedAt: null });
    mockedCompare.mockResolvedValue(true);
    const { tx } = mockTransaction();
    tx.crossModelChat.findMany.mockResolvedValue([{ id: 'fs-chat' }, { id: 'plain-chat' }]);
    tx.supervisorState.findMany.mockResolvedValue([{ chatId: 'fs-chat' }]);

    await authService.deleteAccount('u1', { password: 'pw' });

    expect(tx.crossModelChat.findMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { id: true } });
    expect(tx.contextStoreEntry.deleteMany).toHaveBeenCalledWith({
      where: { namespacePath: { in: ['fs-chat:thread', 'fs-chat:supervisor-archive', 'plain-chat:thread', 'plain-chat:supervisor-archive'] } },
    });
    // the store sweep runs BEFORE the cascade (in the same transaction)
    const sweepOrder = tx.contextStoreEntry.deleteMany.mock.invocationCallOrder[1];
    expect(sweepOrder).toBeLessThan(tx.user.delete.mock.invocationCallOrder[0]);
    await new Promise((r) => setImmediate(r));
    expect(mockMemClear).toHaveBeenCalledWith({ type: 'chat', id: 'fs-chat' });
    expect(mockMemClear).toHaveBeenCalledTimes(1);
  });

  // fs-durable-memory re-review (2026-10-23), item 2: the in-tx sweep runs
  // BEFORE the cascade, so a supervisor write whose cold-archive puts land
  // after that statement (and whose hot write still succeeds before the user
  // delete) left rows behind. A second pass after the commit catches them; a
  // write after THAT fails on the chat FK and purges itself (upsertDoc).
  it('sweeps the chat-keyed store rows a second time AFTER the commit (a racing supervisor write cannot outlive the account)', async () => {
    (mockedPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', email: 'a@b.c', password: 'hashed', deletedAt: null });
    mockedCompare.mockResolvedValue(true);
    const { tx } = mockTransaction();
    tx.crossModelChat.findMany.mockResolvedValue([{ id: 'fs-chat' }]);
    mockedPrisma.contextStoreEntry.deleteMany.mockClear();

    await authService.deleteAccount('u1', { password: 'pw' });

    // the default client (not the tx) — after the cascade
    expect(mockedPrisma.contextStoreEntry.deleteMany).toHaveBeenCalledWith({
      where: { namespacePath: { in: ['fs-chat:thread', 'fs-chat:supervisor-archive'] } },
    });
    expect(mockedPrisma.contextStoreEntry.deleteMany.mock.invocationCallOrder[0]).toBeGreaterThan(tx.user.delete.mock.invocationCallOrder[0]);
  });

  it('a failed post-commit sweep never fails the (already committed) deletion', async () => {
    (mockedPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', email: 'a@b.c', password: 'hashed', deletedAt: null });
    mockedCompare.mockResolvedValue(true);
    const { tx } = mockTransaction();
    tx.crossModelChat.findMany.mockResolvedValue([{ id: 'fs-chat' }]);
    mockedPrisma.contextStoreEntry.deleteMany.mockRejectedValueOnce(new Error('store down'));
    await expect(authService.deleteAccount('u1', { password: 'pw' })).resolves.toEqual({ deleted: true });
  });

  it('rejects a wrong password (401) — a stolen bearer token cannot delete the account', async () => {
    (mockedPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      password: 'hashed',
      deletedAt: null,
    });
    mockedCompare.mockResolvedValue(false);

    await expect(authService.deleteAccount('u1', { password: 'wrong' })).rejects.toMatchObject({
      statusCode: 401,
      message: 'Invalid credentials',
    });
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-deleted user resolves {deleted:true} without touching the DB', async () => {
    (mockedPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await authService.deleteAccount('gone', { password: 'pw' });

    expect(result).toEqual({ deleted: true });
    expect(mockedCompare).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// Review 2026-10-23: the ADMIN hard delete (crossmodel.controller adminDeleteUser) was a raw FK cascade — it left the
// FK-less rows behind, now including the supervisor ledger's cold archive (up to 180 closed owner directives per
// supervisor chat, text + evidence) and its chat-scope mirror. Both delete paths share ONE cleanup.
describe('purgeUserAccount — the shared FK-less cleanup (self-service + admin delete)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('runs the same in-tx sweep, cascade, post-commit sweep and mirror clear as deleteAccount — with no password', async () => {
    const { purgeUserAccount } = jest.requireActual('./auth.service');
    const { tx } = mockTransaction();
    tx.crossModelChat.findMany.mockResolvedValue([{ id: 'fs-chat' }]);
    tx.supervisorState.findMany.mockResolvedValue([{ chatId: 'fs-chat' }]);
    mockedPrisma.contextStoreEntry.deleteMany.mockClear();

    await purgeUserAccount('u9');

    expect(mockedCompare).not.toHaveBeenCalled();
    expect(tx.userMemoryFact.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u9' } });
    expect(tx.contextStoreEntry.deleteMany).toHaveBeenCalledWith({ where: { namespacePath: { startsWith: 'u9:' } } });
    expect(tx.contextStoreEntry.deleteMany).toHaveBeenCalledWith({ where: { namespacePath: { in: ['fs-chat:thread', 'fs-chat:supervisor-archive'] } } });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'u9' } });
    expect(mockedPrisma.contextStoreEntry.deleteMany).toHaveBeenCalledWith({ where: { namespacePath: { in: ['fs-chat:thread', 'fs-chat:supervisor-archive'] } } });
    expect(mockMemClear).toHaveBeenCalledWith({ type: 'chat', id: 'fs-chat' });
  });

  // Integration recheck 2026-10-23: the admin path used to run the cascade as a bare statement (no client timeout);
  // inside purgeUserAccount's interactive transaction it got Prisma's DEFAULT 5 s, so a large account's
  // chats → messages → … cascade failed. The transaction now carries explicit, generous options; the cascade stays
  // inside it, atomic with the FK-less sweep (the self-service path keeps that guarantee byte-for-byte).
  it('runs the sweep + cascade in ONE transaction with explicit generous options — never the default 5 s (both delete paths)', async () => {
    const { purgeUserAccount, ACCOUNT_PURGE_TX_OPTIONS } = jest.requireActual('./auth.service');
    expect(ACCOUNT_PURGE_TX_OPTIONS.timeout).toBeGreaterThanOrEqual(5 * 60_000);
    expect(ACCOUNT_PURGE_TX_OPTIONS.maxWait).toBeGreaterThan(2_000);
    const { tx } = mockTransaction();

    await purgeUserAccount('u9');
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), ACCOUNT_PURGE_TX_OPTIONS);
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'u9' } });
    expect(mockedPrisma.user.delete).not.toHaveBeenCalled(); // the cascade is inside the tx, never a separate statement

    // the self-service delete goes through the same transaction shape
    mockedPrisma.$transaction.mockClear();
    (mockedPrisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', email: 'a@b.c', password: 'hashed', deletedAt: null });
    mockedCompare.mockResolvedValue(true);
    await authService.deleteAccount('u1', { password: 'pw' });
    expect(mockedPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), ACCOUNT_PURGE_TX_OPTIONS);
  });
});

// ── HTTP POSTURE ──────────────────────────────────────────────────────────────

describe('DELETE /api/auth/account (HTTP posture)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedVerify.mockReturnValue({
      userId: 'u1',
      email: 'a@b.c',
      role: 'user',
      isChild: false,
      parentId: null,
    });
  });

  /** Start the router on an ephemeral port; run fn; always close. */
  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const app: Express = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    // The real app mounts the global error handler (ZodError → 400 mapping).
    app.use(errorHandler);
    // Explicit host: the fetch targets 127.0.0.1 (a port-0 wildcard bind can be handed a
    // port another jest worker holds on 127.0.0.1). A host arg binds asynchronously, so
    // wait for 'listening' before reading the address.
    const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const { port } = server.address() as { port: number };
      await fn(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('401s without a token (inline authenticate — /api/auth mounts before the guard)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/account`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'pw' }),
      });
      expect(res.status).toBe(401);
    });
  });

  it('400s on a missing password (zod validation)', async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/account`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  it('200s with {deleted:true} on success and clears the session cookies', async () => {
    (mockedPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'u1',
      email: 'a@b.c',
      password: 'hashed',
      deletedAt: null,
    });
    mockedCompare.mockResolvedValue(true);
    mockTransaction();

    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/account`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok',
        },
        body: JSON.stringify({ password: 'pw' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { deleted: boolean } };
      expect(body.success).toBe(true);
      expect(body.data.deleted).toBe(true);
      // Both session cookies are cleared (refreshToken + cm_access).
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
    });
  });
});

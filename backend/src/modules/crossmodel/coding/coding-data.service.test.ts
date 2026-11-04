/**
 * One-Digby merge (Phase 1 Commit A) — data-layer shape + access invariants.
 * The legacy /coding/* API contract is frozen; these tests pin the mapping and
 * the owner/member access rules.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRedisExists: jest.Mock = jest.fn(async () => 0);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
    exists: (...a: any[]) => mockRedisExists(...a),
  },
}));

// Stranded-steer recovery (6a99225c) is lazy-imported by the sweep — mocked so
// these tests pin WHEN it is invoked without pulling run-state into the graph.
const mockRecoverStrandedSteers: jest.Mock = jest.fn(async () => false);
jest.mock('./steer-recovery', () => ({
  __esModule: true,
  recoverStrandedSteers: (...a: any[]) => mockRecoverStrandedSteers(...a),
}));

// Agent-mode auto-grant seam (owner 2026-09-07): autonomy.service is lazy-
// imported by createCodingChat / updateSessionState / ensureChatWorkspaceState
// — mocked so these tests pin WHEN the sync fires (the grant semantics
// themselves are pinned in platform/autonomy.service.test.ts) without pulling
// crossmodel.service into the graph.
const mockSyncAutonomy: jest.Mock = jest.fn(async () => 'granted');
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  syncAutonomyWithAgentMode: (...a: any[]) => mockSyncAutonomy(...a),
}));

// Fleet-supervisor provisioning seam (ticket 3217e287): supervisor.service is
// lazy-imported by createCodingChat — mocked so these tests pin WHEN the
// ensure fires (and that an unsupervised project gates it out) without pulling
// the fleet graph into the test process.
const mockEnsureFleetSupervisor: jest.Mock = jest.fn(async () => null);
jest.mock('../platform/supervisor.service', () => ({
  __esModule: true,
  ensureFleetSupervisor: (...a: any[]) => mockEnsureFleetSupervisor(...a),
}));

/** Flush the fire-and-forget dynamic-import chain (microtasks + macrotasks). */
async function flushSideEffects(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const mockPrisma: any = {
  crossModelProject: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })), delete: jest.fn() },
  crossModelChat: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  crossModelMessage: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), upsert: jest.fn() },
  chatCodingState: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  codingMessage: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  agentRun: { findMany: jest.fn(), count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 0 })) },
  activity: { create: jest.fn(async () => ({})) },
  projectMember: { findUnique: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
  $executeRawUnsafe: jest.fn(async () => 0),
  contextStoreEntry: { deleteMany: jest.fn(async () => ({ count: 0 })) },
};

jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time (reached via folder-tree-ops,
// imported by coding-data.service since P2) — mock AppError (same shape).
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

import logger from '../../../utils/logger';
import {
  toLegacyProject, toLegacySession, getSessionForUser, createCodingChat, reconcileCodingUnify, updateSessionState,
  appendCodingMessage, updateCodingMessage, deleteCodingProjectData,
  listCodingTranscript, listCodingTranscriptPage, stripInlineImageData, listRecentCodingTranscript, countCodingTranscriptMessages,
  sweepOrphanedRunningSessions, listRunningSessionIdsForUser, CLAIMABLE_ROW_FRESH_MS, ORPHAN_SWEEP_GRACE_MS,
  stripSupervisorCodingSatelliteAtFinalize, healOrphanedRunningSession,
} from './coding-data.service';

const CHAT = { id: 'c1', userId: 'u1', projectId: 'p1', title: 'Fix bug', mode: 'code', updatedAt: new Date('2026-07-02') };
const STATE = {
  id: 'c1', projectId: 'p1', userId: 'u1', title: 'stale-title', branch: 'digby/session-c1',
  baseBranch: 'main', worktreePath: '/wt/c1', permissionMode: 'auto', model: 'glm-5.2',
  status: 'ready', errorMessage: null, createdAt: new Date('2026-07-01'), updatedAt: new Date('2026-07-01'),
};

describe('legacy shape mapping', () => {
  it('project shape derives provider from repoProvider and empty-strings a null repoUrl', () => {
    const p = toLegacyProject({
      id: 'p1', userId: 'u1', name: 'proj', repoUrl: null, repoProvider: 'blank',
      defaultBranch: 'main', githubLabel: null, createdAt: new Date(), updatedAt: new Date(),
    }, 3);
    expect(p.provider).toBe('blank');
    expect(p.repoUrl).toBe('');
    expect(p._count).toEqual({ sessions: 3 });
  });

  it('session shape takes owner + title from the CHAT row, run state from the satellite', () => {
    const s = toLegacySession(CHAT, STATE);
    expect(s.id).toBe('c1');
    expect(s.title).toBe('Fix bug');          // chat wins over the stale satellite copy
    expect(s.userId).toBe('u1');
    expect(s.branch).toBe('digby/session-c1');
    expect(s.status).toBe('ready');
    expect(s.updatedAt).toEqual(new Date('2026-07-02')); // max(chat, state)
  });
});

describe('getSessionForUser access rules', () => {
  beforeEach(() => jest.clearAllMocks());

  it('owner gets the session at any access level', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ ...CHAT, codingState: STATE });
    expect(await getSessionForUser('c1', 'u1', 'owner')).toBeTruthy();
    expect(await getSessionForUser('c1', 'u1', 'read')).toBeTruthy();
  });

  it('a blank/undefined id is NOT-FOUND, not a raw Prisma validation error (FO firing 44: the id:undefined class fired ~6x/day via error-handler)', async () => {
    expect(await getSessionForUser(undefined as unknown as string, 'u1', 'owner', { includeProject: true })).toBeNull();
    expect(await getSessionForUser('', 'u1', 'read')).toBeNull();
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
  });

  it("a project member gets 'read' but NEVER 'owner' (mutations stay owner-only)", async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ ...CHAT, codingState: STATE });
    mockPrisma.projectMember.findUnique.mockResolvedValue({ role: 'editor' });
    expect(await getSessionForUser('c1', 'member', 'read')).toBeTruthy();
    expect(await getSessionForUser('c1', 'member', 'owner')).toBeNull();
  });

  it('a stranger gets nothing', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ ...CHAT, codingState: STATE });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    mockPrisma.crossModelProject.findUnique.mockResolvedValue(null);
    expect(await getSessionForUser('c1', 'rando', 'read')).toBeNull();
  });

  // ── 7acaa7ba: ancestor-folder membership grants READ on the coding surface ──
  // (getChatAccess/getProjectAccess walk ancestors; the leaf-only check here
  // made an ancestor member 404 on a coding chat in a child folder.)
  it('an EDITOR row on an ANCESTOR folder grants read (leaf row absent)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ ...CHAT, codingState: STATE });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null); // no leaf row
    // getAncestorChain: leaf project p1 → chain rows root→mid→p1.
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1', parentId: 'mid', path: '/root/mid/p1' });
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'root', userId: 'u1', parentId: null, path: '/root' },
      { id: 'mid', userId: 'u1', parentId: 'root', path: '/root/mid' },
      { id: 'p1', userId: 'u1', parentId: 'mid', path: '/root/mid/p1' },
    ]);
    mockPrisma.projectMember.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where.userId === 'u-member' ? [{ role: 'editor' }] : []));
    expect(await getSessionForUser('c1', 'u-member', 'read')).toBeTruthy();
    // …but still NEVER owner (mutations stay owner-only).
    expect(await getSessionForUser('c1', 'u-member', 'owner')).toBeNull();
  });

  it('FOLDERS_INHERITANCE=off keeps the ancestor-blind (pre-7acaa7ba) behavior', async () => {
    const prev = process.env.FOLDERS_INHERITANCE;
    process.env.FOLDERS_INHERITANCE = 'off';
    try {
      mockPrisma.crossModelChat.findUnique.mockResolvedValue({ ...CHAT, codingState: STATE });
      mockPrisma.projectMember.findUnique.mockResolvedValue(null);
      mockPrisma.projectMember.findMany.mockResolvedValue([{ role: 'editor' }]);
      expect(await getSessionForUser('c1', 'u-member', 'read')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.FOLDERS_INHERITANCE; else process.env.FOLDERS_INHERITANCE = prev;
    }
  });

  it('a plain chat (no codingState) is not a session', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ ...CHAT, codingState: null });
    expect(await getSessionForUser('c1', 'u1', 'owner')).toBeNull();
  });
});

describe('createCodingChat', () => {
  it('creates the chat and the satellite with the SAME id in one transaction', async () => {
    mockPrisma.crossModelChat.create.mockResolvedValue({ ...CHAT, id: 'new1' });
    mockPrisma.chatCodingState.create.mockResolvedValue({ ...STATE, id: 'new1', branch: 'pending' });
    const s = await createCodingChat({ projectId: 'p1', userId: 'u1', title: 'T', permissionMode: 'ask', model: 'glm-5.2' });
    expect(s.id).toBe('new1');
    expect(mockPrisma.chatCodingState.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: 'new1' }) }),
    );
    expect(mockPrisma.crossModelChat.create).toHaveBeenCalledWith(
      // P5-B: 'code' is never persisted — the satellite is the coding marker;
      // the chat's mode records only the patience pipeline — 'auto' since the
      // owner's 2026-09-26 directive (routed per send; L2 preset = the fallback).
      expect.objectContaining({ data: expect.objectContaining({ mode: 'auto' }) }),
    );
  });

  // Agent-mode auto-grant (owner 2026-09-07): a session CREATED in Auto
  // materializes its Autonomy grant immediately; other modes never do.
  it("a session created with permissionMode 'auto' syncs the auto-grant for the new chat id", async () => {
    jest.clearAllMocks();
    mockPrisma.crossModelChat.create.mockResolvedValue({ ...CHAT, id: 'new-auto' });
    mockPrisma.chatCodingState.create.mockResolvedValue({ ...STATE, id: 'new-auto', branch: 'pending' });
    await createCodingChat({ projectId: 'p1', userId: 'u1', title: 'T', permissionMode: 'auto', model: 'glm-5.2' });
    expect(mockSyncAutonomy).toHaveBeenCalledWith({ chatId: 'new-auto', permissionMode: 'auto' });
  });

  it("a session created with permissionMode 'ask' never touches the autonomy grant", async () => {
    jest.clearAllMocks();
    mockPrisma.crossModelChat.create.mockResolvedValue({ ...CHAT, id: 'new-ask' });
    mockPrisma.chatCodingState.create.mockResolvedValue({ ...STATE, id: 'new-ask', branch: 'pending' });
    await createCodingChat({ projectId: 'p1', userId: 'u1', title: 'T', permissionMode: 'ask', model: 'glm-5.2' });
    expect(mockSyncAutonomy).not.toHaveBeenCalled();
  });

  it('an auto-grant hiccup is best-effort — session creation still succeeds', async () => {
    jest.clearAllMocks();
    mockPrisma.crossModelChat.create.mockResolvedValue({ ...CHAT, id: 'new-auto' });
    mockPrisma.chatCodingState.create.mockResolvedValue({ ...STATE, id: 'new-auto', branch: 'pending' });
    mockSyncAutonomy.mockRejectedValueOnce(new Error('db hiccup'));
    const s = await createCodingChat({ projectId: 'p1', userId: 'u1', title: 'T', permissionMode: 'auto', model: 'glm-5.2' });
    expect(s.id).toBe('new-auto');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('autonomy auto-grant failed'));
  });

  // Supervision opt-out (owner 2026-09-13, ticket 3217e287): creating a
  // session in an UNSUPERVISED project must NOT auto-provision the fleet
  // supervisor; a supervised project keeps the trigger.
  it('a session created in a SUPERVISED project ensures the fleet supervisor (fire-and-forget)', async () => {
    jest.clearAllMocks();
    mockPrisma.crossModelChat.create.mockResolvedValue({ ...CHAT, id: 'new-sup' });
    mockPrisma.chatCodingState.create.mockResolvedValue({ ...STATE, id: 'new-sup', branch: 'pending' });
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: true });
    await createCodingChat({ projectId: 'p1', userId: 'u1', title: 'T', permissionMode: 'ask', model: 'glm-5.2' });
    await flushSideEffects();
    expect(mockEnsureFleetSupervisor).toHaveBeenCalledWith('u1');
  });

  it('a session created in an UNSUPERVISED project does NOT ensure the fleet supervisor (ticket 3217e287)', async () => {
    jest.clearAllMocks();
    mockPrisma.crossModelChat.create.mockResolvedValue({ ...CHAT, id: 'new-unsup' });
    mockPrisma.chatCodingState.create.mockResolvedValue({ ...STATE, id: 'new-unsup', branch: 'pending' });
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ supervised: false });
    const s = await createCodingChat({ projectId: 'p1', userId: 'u1', title: 'T', permissionMode: 'ask', model: 'glm-5.2' });
    await flushSideEffects();
    expect(s.id).toBe('new-unsup'); // creation itself is unaffected
    expect(mockEnsureFleetSupervisor).not.toHaveBeenCalled();
  });
});

// Agent-mode auto-grant sync on MODE FLIPS (owner 2026-09-07): the side panel's
// Mode row (coding.controller.updateSession) is the only permissionMode writer —
// every such write keeps the chat's Autonomy grant in step. The grant/revoke/
// never-touch-manual semantics are pinned in platform/autonomy.service.test.ts;
// here we pin WHEN the sync fires and that it propagates failures (a stale
// grant on a chat the owner just put back under supervision must surface).
describe('updateSessionState — agent-mode autonomy sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.chatCodingState.update.mockResolvedValue({});
  });

  it("flipping a chat TO auto syncs the auto-grant AFTER the state write", async () => {
    await updateSessionState('c1', { permissionMode: 'auto' });
    expect(mockPrisma.chatCodingState.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { permissionMode: 'auto' } });
    expect(mockSyncAutonomy).toHaveBeenCalledWith({ chatId: 'c1', permissionMode: 'auto' });
  });

  it('flipping AWAY from auto syncs too (the service revokes only an auto-granted row)', async () => {
    await updateSessionState('c1', { permissionMode: 'plan' });
    expect(mockSyncAutonomy).toHaveBeenCalledWith({ chatId: 'c1', permissionMode: 'plan' });
  });

  it('non-mode updates (status/branch/worktree) never touch the autonomy grant', async () => {
    await updateSessionState('c1', { status: 'ready', worktreePath: '/wt/c1' });
    expect(mockSyncAutonomy).not.toHaveBeenCalled();
  });

  it('a sync failure on a mode flip PROPAGATES (never silently strand a stale grant)', async () => {
    mockSyncAutonomy.mockRejectedValueOnce(new Error('db down'));
    await expect(updateSessionState('c1', { permissionMode: 'ask' })).rejects.toThrow('db down');
  });
});

describe('reconcileCodingUnify', () => {
  it('is idempotent (ON CONFLICT DO NOTHING inserts + orphan delete) and reports counts', async () => {
    mockPrisma.$executeRawUnsafe.mockResolvedValue(0);
    const r1 = await reconcileCodingUnify();
    const r2 = await reconcileCodingUnify();
    expect(r1).toEqual({ projects: 0, chats: 0, orphans: 0 });
    expect(r2).toEqual(r1);
    // Insert SQL must be conflict-safe so double-runs can't duplicate.
    const sqls = mockPrisma.$executeRawUnsafe.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(sqls).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(sqls).toContain('DELETE FROM "crossmodel_chats"');
  });
});

describe('deleteCodingProjectData', () => {
  beforeEach(() => jest.clearAllMocks());

  it('relocates child folders to truthful roots BEFORE the delete, in one transaction (Finding 2)', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p1', path: '/p1' });
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'c1' }]);
    const rows = [
      { id: 'kid', parentId: 'p1', depth: 1, path: '/p1/kid' },
      { id: 'gkid', parentId: 'kid', depth: 2, path: '/p1/kid/gkid' },
    ];
    mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where, orderBy }: any = {}) => {
      let out = rows;
      if (where?.parentId !== undefined) out = out.filter((r) => r.parentId === where.parentId);
      if (where?.path?.startsWith) out = out.filter((r) => r.path.startsWith(where.path.startsWith));
      if (orderBy?.depth === 'asc') out = [...out].sort((a, b) => a.depth - b.depth);
      return out.map(({ id, path, depth }) => ({ id, path, depth }));
    });
    await deleteCodingProjectData('p1');

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // The child became a truthful root; its descendant was re-anchored first.
    expect(mockPrisma.crossModelProject.updateMany).toHaveBeenCalledWith({
      where: { path: { startsWith: '/p1/kid/' } }, data: { depth: { increment: -1 } },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'gkid' }, data: { path: '/kid/gkid' },
    });
    expect(mockPrisma.crossModelProject.update).toHaveBeenCalledWith({
      where: { id: 'kid' }, data: { parentId: null, depth: 0, path: '/kid' },
    });
    // …then the coding chats die with the project and the row is deleted.
    expect(mockPrisma.chatCodingState.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'p1' } });
    expect(mockPrisma.crossModelChat.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['c1'] } } });
    expect(mockPrisma.crossModelProject.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    // Ordering: every relocation write precedes the project-row delete.
    const lastRelocation = Math.max(...mockPrisma.crossModelProject.update.mock.invocationCallOrder);
    expect(lastRelocation).toBeLessThan(mockPrisma.crossModelProject.delete.mock.invocationCallOrder[0]);
  });

  it("clears the deleted coding chats' chat-keyed store rows in the same transaction (review 2026-10-23)", async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p1', path: '/p1' });
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    await deleteCodingProjectData('p1');
    expect(mockPrisma.contextStoreEntry.deleteMany).toHaveBeenCalledWith({ where: { namespacePath: { in: ['c1:thread', 'c1:supervisor-archive', 'c2:thread', 'c2:supervisor-archive'] } } });
    expect(mockPrisma.contextStoreEntry.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockPrisma.crossModelProject.delete.mock.invocationCallOrder[0]);
  });

  // fs-durable-memory re-review (2026-10-23), item 2: the in-tx sweep runs
  // before the chat rows die, so a racing supervisor write's cold-archive puts
  // could land after it. A second best-effort pass after the commit.
  it('sweeps the dead chats\' chat-keyed store rows again AFTER the commit', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p1', path: '/p1' });
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'c1' }]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    await deleteCodingProjectData('p1');
    const calls = mockPrisma.contextStoreEntry.deleteMany.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([{ where: { namespacePath: { in: ['c1:thread', 'c1:supervisor-archive'] } } }]);
    expect(mockPrisma.contextStoreEntry.deleteMany.mock.invocationCallOrder[1]).toBeGreaterThan(mockPrisma.crossModelProject.delete.mock.invocationCallOrder[0]);
  });

  it('a childless project deletes with zero relocation writes', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'p1', path: '/p1' });
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    await deleteCodingProjectData('p1');
    expect(mockPrisma.crossModelProject.update).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelProject.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelProject.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });
});

// ── P5-A: transcript dual-write + read-switch ────────────────────────────────

const MSG = {
  id: 'm1', chatId: 'c1', role: 'assistant', content: 'hi',
  parts: [{ type: 'text', text: 'hi' }], createdAt: new Date('2026-07-03T00:00:00Z'),
};

/** Pin the two P5-A env flags per test (they're read per call, not at import). */
function useTranscriptEnv() {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    jest.clearAllMocks();
    saved.d = process.env.TRANSCRIPT_DUAL_WRITE;
    saved.r = process.env.TRANSCRIPT_READ;
    delete process.env.TRANSCRIPT_DUAL_WRITE;
    delete process.env.TRANSCRIPT_READ;
  });
  afterEach(() => {
    if (saved.d === undefined) delete process.env.TRANSCRIPT_DUAL_WRITE; else process.env.TRANSCRIPT_DUAL_WRITE = saved.d;
    if (saved.r === undefined) delete process.env.TRANSCRIPT_READ; else process.env.TRANSCRIPT_READ = saved.r;
  });
}

describe('P5-A dual-write', () => {
  useTranscriptEnv();

  it('appendCodingMessage writes the legacy row AND the mirror in ONE transaction (id/parts/createdAt preserved)', async () => {
    mockPrisma.codingMessage.create.mockResolvedValue(MSG);
    const row = await appendCodingMessage({ chatId: 'c1', role: 'assistant', content: 'hi', parts: MSG.parts });
    expect(row).toEqual(MSG);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingMessage.create).toHaveBeenCalledWith({
      data: { chatId: 'c1', role: 'assistant', content: 'hi', parts: MSG.parts },
    });
    expect(mockPrisma.crossModelMessage.upsert).toHaveBeenCalledWith({
      where: { id: 'm1' },
      create: { id: 'm1', chatId: 'c1', role: 'assistant', content: 'hi', parts: MSG.parts, createdAt: MSG.createdAt },
      update: { content: 'hi', parts: MSG.parts },
    });
  });

  it('omits parts on both sides when the message has none (nullable jsonb stays NULL)', async () => {
    mockPrisma.codingMessage.create.mockResolvedValue({ ...MSG, id: 'm2', role: 'user', content: 'q', parts: null });
    await appendCodingMessage({ chatId: 'c1', role: 'user', content: 'q' });
    expect(mockPrisma.codingMessage.create).toHaveBeenCalledWith({ data: { chatId: 'c1', role: 'user', content: 'q' } });
    const upsert = mockPrisma.crossModelMessage.upsert.mock.calls[0][0];
    expect(upsert.create).toEqual({ id: 'm2', chatId: 'c1', role: 'user', content: 'q', createdAt: MSG.createdAt });
    expect(upsert.create).not.toHaveProperty('parts');
  });

  it('skips the mirror entirely when TRANSCRIPT_DUAL_WRITE=off (no transaction, no upsert)', async () => {
    process.env.TRANSCRIPT_DUAL_WRITE = 'off';
    mockPrisma.codingMessage.create.mockResolvedValue(MSG);
    const row = await appendCodingMessage({ chatId: 'c1', role: 'user', content: 'q' });
    expect(row).toEqual(MSG);
    expect(mockPrisma.codingMessage.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('updateCodingMessage mirrors the mutation via upsert in the same transaction (post-insert updates are covered)', async () => {
    const updated = { ...MSG, content: 'hi there' };
    mockPrisma.codingMessage.update.mockResolvedValue(updated);
    const row = await updateCodingMessage('m1', { content: 'hi there', parts: MSG.parts });
    expect(row).toEqual(updated);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingMessage.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { content: 'hi there', parts: MSG.parts } });
    // upsert (not update): a pre-dual-write row may have no mirror yet — it gets created.
    expect(mockPrisma.crossModelMessage.upsert).toHaveBeenCalledWith({
      where: { id: 'm1' },
      create: { id: 'm1', chatId: 'c1', role: 'assistant', content: 'hi there', parts: MSG.parts, createdAt: MSG.createdAt },
      update: { content: 'hi there', parts: MSG.parts },
    });
  });

  it('updateCodingMessage touches only the legacy table when dual-write is off', async () => {
    process.env.TRANSCRIPT_DUAL_WRITE = 'off';
    mockPrisma.codingMessage.update.mockResolvedValue(MSG);
    await updateCodingMessage('m1', { content: 'x', parts: MSG.parts });
    expect(mockPrisma.codingMessage.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('P5-A read-switch', () => {
  useTranscriptEnv();

  it("merged mode (default) serves crossmodel_messages when the chat has mirrored rows", async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValue(2);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([MSG]);
    const rows = await listCodingTranscript('c1');
    expect(rows).toEqual([MSG]);
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { chatId: 'c1' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, chatId: true, role: true, content: true, parts: true, metadata: true, createdAt: true, updatedAt: true },
    });
    expect(mockPrisma.codingMessage.findMany).not.toHaveBeenCalled();
  });

  it('no per-chat fallback: a chat with legacy rows but ZERO mirrored rows still reads merged (slice 3)', async () => {
    // Pre-slice-3 this chat was served from coding_messages and logged a warn. The
    // fallback is retired: it was removed only after the fleet-wide subset check proved
    // every legacy message has a mirror row in the SAME chat, so this state should not
    // occur — and if it somehow does, a warn is no longer the safety net.
    mockPrisma.crossModelMessage.count.mockResolvedValue(0);
    mockPrisma.codingMessage.count.mockResolvedValue(3);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    const rows = await listCodingTranscript('c-not-backfilled');
    expect(rows).toEqual([]);
    expect(mockPrisma.codingMessage.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({ where: { chatId: 'c-not-backfilled' }, orderBy: { createdAt: 'asc' }, select: expect.anything() });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an empty chat reads merged (no fallback, no warn)', async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValue(0);
    mockPrisma.codingMessage.count.mockResolvedValue(0);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    const rows = await listCodingTranscript('c-empty');
    expect(rows).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('TRANSCRIPT_READ=legacy forces the legacy table without touching the merged one', async () => {
    process.env.TRANSCRIPT_READ = 'legacy';
    mockPrisma.codingMessage.findMany.mockResolvedValue([MSG]);
    const rows = await listCodingTranscript('c1');
    expect(rows).toEqual([MSG]);
    expect(mockPrisma.codingMessage.findMany).toHaveBeenCalledWith({ where: { chatId: 'c1' }, orderBy: { createdAt: 'asc' } });
    expect(mockPrisma.crossModelMessage.count).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('listRecentCodingTranscript keeps the newest-first + take contract on the merged side', async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValue(5);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([MSG]);
    const rows = await listRecentCodingTranscript('c1', 25);
    expect(rows).toEqual([MSG]);
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { chatId: 'c1' },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, chatId: true, role: true, content: true, parts: true, metadata: true, createdAt: true, updatedAt: true },
    });
  });

  it('countCodingTranscriptMessages reads the merged table unconditionally (slice 3: no per-chat fallback)', async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValue(4);
    expect(await countCodingTranscriptMessages('c-count', 'user')).toBe(4);
    expect(mockPrisma.crossModelMessage.count).toHaveBeenLastCalledWith({ where: { chatId: 'c-count', role: 'user' } });

    jest.clearAllMocks();
    // Zero mirrored rows no longer routes the count to coding_messages.
    mockPrisma.crossModelMessage.count.mockResolvedValue(0);
    mockPrisma.codingMessage.count.mockResolvedValue(2);
    expect(await countCodingTranscriptMessages('c-count', 'user')).toBe(0);
    expect(mockPrisma.codingMessage.count).not.toHaveBeenCalled();
  });
});

describe('listCodingTranscriptPage (session-open paging, 2026-08-31)', () => {
  useTranscriptEnv();

  it('merged path pages newest-first with the +1 probe and returns chronological rows + cursor', async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValue(60);
    const older = { ...MSG, id: 'm-old', createdAt: new Date('2026-07-02T00:00:00Z') };
    const newer = { ...MSG, id: 'm-new', createdAt: new Date('2026-07-03T00:00:00Z') };
    // take = limit+1 → 3 rows back for limit 2 (newest-first from the DB).
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([newer, older, { ...MSG, id: 'm-probe' }]);
    const page = await listCodingTranscriptPage('c1', { limit: 2 });
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { chatId: 'c1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      select: { id: true, chatId: true, role: true, content: true, parts: true, metadata: true, createdAt: true, updatedAt: true },
    });
    expect(page.hasMore).toBe(true);
    expect(page.rows.map(r => r.id)).toEqual(['m-old', 'm-new']); // chronological within the page
    expect(page.nextBefore).toBe('m-old');
  });

  it('no extra row → hasMore false and no cursor', async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValue(2);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([MSG]);
    const page = await listCodingTranscriptPage('c1', { limit: 2 });
    expect(page.hasMore).toBe(false);
    expect(page.nextBefore).toBeUndefined();
  });

  it('surfaces updatedAt so last-write (≈finalize) is distinguishable from insert-time createdAt (ticket 68916075)', async () => {
    // Coding runs INSERT the assistant row at run start (persistPartial) and
    // rewrite it in place through finalize — transcript reads must expose the
    // last-write stamp or a long run's final answer reads as backdated.
    mockPrisma.crossModelMessage.count.mockResolvedValue(2);
    const openedAt = new Date('2026-07-03T00:00:00Z');   // run start (row INSERT)
    const finalizedAt = new Date('2026-07-03T01:22:00Z'); // 82 min later (last rewrite)
    const finalized = { ...MSG, createdAt: openedAt, updatedAt: finalizedAt };
    const predating = { ...MSG, id: 'm-old', updatedAt: null }; // row predating the field
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([finalized, predating]); // DB order: newest-first
    const page = await listCodingTranscriptPage('c1', { limit: 2 });
    // chronological within the page → the finalized row is LAST.
    expect(page.rows[1].updatedAt).toEqual(finalizedAt);
    expect(page.rows[1].createdAt).toEqual(openedAt); // never restamped — ordering contract
    expect(page.rows[0].updatedAt).toBeNull();        // honest "predates this field"
  });

  it('the before cursor pages strictly older rows via the compound (createdAt, id) filter', async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValue(60);
    const cursorAt = new Date('2026-07-03T00:00:00Z');
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ chatId: 'c1', createdAt: cursorAt });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    await listCodingTranscriptPage('c1', { limit: 50, before: 'm-cursor' });
    expect(mockPrisma.crossModelMessage.findUnique).toHaveBeenCalledWith({
      where: { id: 'm-cursor' }, select: { chatId: true, createdAt: true },
    });
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { chatId: 'c1', OR: [{ createdAt: { lt: cursorAt } }, { createdAt: cursorAt, id: { lt: 'm-cursor' } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      select: { id: true, chatId: true, role: true, content: true, parts: true, metadata: true, createdAt: true, updatedAt: true },
    });
  });

  it('a foreign/missing before cursor is a 400, not a silent full read', async () => {
    mockPrisma.crossModelMessage.count.mockResolvedValue(60);
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ chatId: 'c-other', createdAt: new Date() });
    await expect(listCodingTranscriptPage('c1', { limit: 50, before: 'm-foreign' })).rejects.toMatchObject({ statusCode: 400 });
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue(null);
    await expect(listCodingTranscriptPage('c1', { limit: 50, before: 'm-gone' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('pages merged unconditionally — no per-chat fallback (slice 3)', async () => {
    // Before slice 3, zero mirrored rows + legacy rows paged coding_messages. Retired.
    mockPrisma.crossModelMessage.count.mockResolvedValue(0);
    mockPrisma.codingMessage.count.mockResolvedValue(30);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([MSG]);
    const page = await listCodingTranscriptPage('c-legacy', { limit: 50 });
    expect(page.rows).toEqual([MSG]);
    expect(mockPrisma.codingMessage.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { chatId: 'c-legacy' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      select: expect.anything(),
    });
  });
});

describe('stripInlineImageData', () => {
  it('swaps inline base64 for the lazy URL and leaves every other part untouched', () => {
    const msgs = [{
      id: 'm1',
      parts: [
        { type: 'text', text: 'here' },
        { type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'a.png' },
        { type: 'image', mediaType: 'image/png', data: '' }, // empty data stays as-is
        { type: 'tool_result', name: 'bash', result: 'ok' },
      ],
    }];
    stripInlineImageData('c1', msgs);
    expect(msgs[0].parts).toEqual([
      { type: 'text', text: 'here' },
      { type: 'image', mediaType: 'image/png', data: undefined, name: 'a.png', url: '/api/crossmodel/coding/sessions/c1/messages/m1/image/1' },
      { type: 'image', mediaType: 'image/png', data: '' },
      { type: 'tool_result', name: 'bash', result: 'ok' },
    ]);
  });

  it('a message without parts is a no-op', () => {
    const msgs: Array<{ id: string; parts?: unknown }> = [{ id: 'm1' }];
    expect(() => stripInlineImageData('c1', msgs)).not.toThrow();
  });
});

describe('listRunningSessionIdsForUser (sidebar spinner reconciliation)', () => {
  it('returns running ids for own sessions plus member-project sessions', async () => {
    mockPrisma.projectMember.findMany.mockResolvedValue([{ projectId: 'p2' }]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const ids = await listRunningSessionIdsForUser('u1');
    expect(ids).toEqual(['s1', 's2']);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { codingState: { is: { status: 'running' } }, OR: [{ userId: 'u1' }, { projectId: { in: ['p2'] } }] },
      select: { id: true },
    });
  });

  it('omits the project OR-clause when the caller has no memberships', async () => {
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    const ids = await listRunningSessionIdsForUser('u1');
    expect(ids).toEqual([]);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { codingState: { is: { status: 'running' } }, OR: [{ userId: 'u1' }] },
      select: { id: true },
    });
  });
});

describe('sweepOrphanedRunningSessions (Phase-2 worker guard; Phase-3 H1 fail-closed + grace window)', () => {
  const STALE = () => new Date(Date.now() - 10 * 60_000); // well past ORPHAN_SWEEP_GRACE_MS
  const FRESH = () => new Date();                          // inside the 2-min grace window

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisExists.mockResolvedValue(0); // no session lock held anywhere
  });

  it('skips sessions with a claimable agent_runs row (a worker owns/will claim them); heals the rest', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: 's1', updatedAt: STALE() }, { id: 's2', updatedAt: STALE() }, { id: 's3', updatedAt: STALE() },
    ]);
    // s2 has a queued/interrupted/running row — ONE batched lookup for the whole candidate set.
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 's2' }]);
    mockPrisma.chatCodingState.update.mockResolvedValue({});

    const healed = await sweepOrphanedRunningSessions();

    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledWith({
      where: {
        sessionId: { in: ['s1', 's2', 's3'] },
        status: { in: ['queued', 'interrupted', 'running'] },
        updatedAt: { gte: expect.any(Date) },
      },
      select: { sessionId: true },
    });
    const flipped = mockPrisma.chatCodingState.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(flipped).toEqual(['s1', 's3']); // s2 NOT flipped — worker-owned
    expect(healed).toBe(2);
  });

  it('stranded-steer recovery (6a99225c): invoked for each HEALED session only, labelled orphan-heal', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: 's1', updatedAt: STALE() }, { id: 's2', updatedAt: STALE() }, { id: 's3', updatedAt: STALE() },
    ]);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 's2' }]); // worker-owned — NOT healed
    mockPrisma.chatCodingState.update.mockResolvedValue({});

    expect(await sweepOrphanedRunningSessions()).toBe(2);
    expect(mockRecoverStrandedSteers.mock.calls.map((c: any[]) => c[0])).toEqual(['s1', 's3']);
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'orphan-heal');
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s3', 'orphan-heal');
  });

  it('a recovery failure never claws back the heal (best-effort, per-session)', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1', updatedAt: STALE() }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.update.mockResolvedValue({});
    mockRecoverStrandedSteers.mockRejectedValueOnce(new Error('redis down'));

    expect(await sweepOrphanedRunningSessions()).toBe(1);
    expect(mockPrisma.chatCodingState.update).toHaveBeenCalledWith(
      { where: { id: 's1' }, data: { status: 'ready', errorMessage: null } }, // 911b6c45: heal flips clear the stale error text
    );
  });

  it('nothing healed → no recovery pass', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    expect(await sweepOrphanedRunningSessions()).toBe(0);
    expect(mockRecoverStrandedSteers).not.toHaveBeenCalled();
  });

  it('freshness bound: the claimable lookup only counts rows touched within CLAIMABLE_ROW_FRESH_MS', async () => {
    // 2026-07-31 zombie incident: an UNBOUNDED claimable match let stale
    // queued/interrupted rows (worker dead, runs flipped interrupted by
    // boot-reconcile) park sessions 'running' forever. The lookup must pass a
    // ~15-min-ago lower bound on agent_runs.updatedAt.
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1', updatedAt: STALE() }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.update.mockResolvedValue({});

    const before = Date.now();
    const healed = await sweepOrphanedRunningSessions();
    const after = Date.now();

    expect(healed).toBe(1);
    const gte = mockPrisma.agentRun.findMany.mock.calls[0][0].where.updatedAt.gte as Date;
    expect(gte).toBeInstanceOf(Date);
    // gte ≈ (call time) - CLAIMABLE_ROW_FRESH_MS, within the call's duration.
    expect(gte.getTime()).toBeGreaterThanOrEqual(before - CLAIMABLE_ROW_FRESH_MS - 1000);
    expect(gte.getTime()).toBeLessThanOrEqual(after - CLAIMABLE_ROW_FRESH_MS + 1000);
    // And it must sit strictly INSIDE the 10-min-stale test row's past — i.e. a
    // worker row dead for hours (the incident shape) falls OUTSIDE the bound.
    expect(CLAIMABLE_ROW_FRESH_MS).toBeGreaterThan(ORPHAN_SWEEP_GRACE_MS);
  });

  it('still skips a lock-held session even with no claimable row', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1', updatedAt: STALE() }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([]);
    mockRedisExists.mockResolvedValue(1); // live on some instance

    const healed = await sweepOrphanedRunningSessions();
    expect(healed).toBe(0);
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
  });

  it('returns 0 without querying agent_runs when nothing is running', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    expect(await sweepOrphanedRunningSessions()).toBe(0);
    expect(mockPrisma.agentRun.findMany).not.toHaveBeenCalled();
  });

  it('(d) regression: a STALE session with no row + no lock still flips to ready, clearing errorMessage (911b6c45)', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1', updatedAt: STALE() }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.update.mockResolvedValue({});

    expect(await sweepOrphanedRunningSessions()).toBe(1);
    expect(mockPrisma.chatCodingState.update).toHaveBeenCalledWith(
      { where: { id: 's1' }, data: { status: 'ready', errorMessage: null } },
    );
  });

  it('(a) FAIL CLOSED: a claimable-lookup DB error aborts the whole pass — NOTHING flipped', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: 's1', updatedAt: STALE() }, { id: 's2', updatedAt: STALE() },
    ]);
    mockPrisma.agentRun.findMany.mockRejectedValue(new Error('db down'));

    expect(await sweepOrphanedRunningSessions()).toBe(0);
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
    expect(mockRedisExists).not.toHaveBeenCalled(); // no per-session work after the abort
  });

  it('(b) FAIL CLOSED: a Redis error on the lock check aborts the whole pass', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: 's1', updatedAt: STALE() }, { id: 's2', updatedAt: STALE() },
    ]);
    mockPrisma.agentRun.findMany.mockResolvedValue([]);
    mockRedisExists.mockRejectedValue(new Error('redis down'));

    expect(await sweepOrphanedRunningSessions()).toBe(0);
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
  });

  it('(c) grace window: a session flipped running < 2 min ago is skipped even with no row + no lock', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1', updatedAt: FRESH() }]);

    expect(await sweepOrphanedRunningSessions()).toBe(0);
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
    // Filtered BEFORE any per-session work — not even the claimable lookup runs.
    expect(mockPrisma.agentRun.findMany).not.toHaveBeenCalled();
    expect(mockRedisExists).not.toHaveBeenCalled();
  });

  it('(c) grace window: only the stale subset is sweep-eligible (fresh sessions leave the claimable lookup too)', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: 's-fresh', updatedAt: FRESH() }, { id: 's-stale', updatedAt: STALE() },
    ]);
    mockPrisma.agentRun.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.update.mockResolvedValue({});

    expect(await sweepOrphanedRunningSessions()).toBe(1);
    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledWith({
      where: {
        sessionId: { in: ['s-stale'] },
        status: { in: ['queued', 'interrupted', 'running'] },
        updatedAt: { gte: expect.any(Date) },
      },
      select: { sessionId: true },
    });
    const flipped = mockPrisma.chatCodingState.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(flipped).toEqual(['s-stale']);
  });
});

// TICKET-LANE ARCHIVE GAPS B6 (2026-10-21): the ticket dispatcher heals ONE
// stuck 'running' lane satellite before archiving it — the sweep's predicates
// for a single id, fail-closed, guarded write.
describe('healOrphanedRunningSession — the orphan sweep for one session (TICKET-LANE ARCHIVE GAPS B6)', () => {
  const STALE = () => new Date(Date.now() - 10 * 60_000);
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisExists.mockResolvedValue(0);
    mockPrisma.agentRun.count.mockResolvedValue(0);
    mockPrisma.chatCodingState.updateMany.mockResolvedValue({ count: 1 });
  });

  it('a stale running satellite with no fresh claimable row and no lock is healed to ready (errorMessage cleared, write guarded on running), steers recovered', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 's1', status: 'running', updatedAt: STALE() });
    expect(await healOrphanedRunningSession('s1')).toBe('healed');
    expect(mockPrisma.agentRun.count).toHaveBeenCalledWith({
      where: { sessionId: 's1', status: { in: ['queued', 'interrupted', 'running'] }, updatedAt: { gte: expect.any(Date) } },
    });
    const gte = mockPrisma.agentRun.count.mock.calls[0][0].where.updatedAt.gte as Date;
    expect(Math.abs(Date.now() - CLAIMABLE_ROW_FRESH_MS - gte.getTime())).toBeLessThan(5_000);
    expect(mockPrisma.chatCodingState.updateMany).toHaveBeenCalledWith({ where: { id: 's1', status: 'running' }, data: { status: 'ready', errorMessage: null } });
    expect(mockRecoverStrandedSteers).toHaveBeenCalledWith('s1', 'orphan-heal');
  });

  it('not running / missing → not_running; inside the grace window → grace; nothing written', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValueOnce({ id: 's1', status: 'ready', updatedAt: STALE() });
    expect(await healOrphanedRunningSession('s1')).toBe('not_running');
    mockPrisma.chatCodingState.findUnique.mockResolvedValueOnce(null);
    expect(await healOrphanedRunningSession('s1')).toBe('not_running');
    mockPrisma.chatCodingState.findUnique.mockResolvedValueOnce({ id: 's1', status: 'running', updatedAt: new Date() });
    expect(await healOrphanedRunningSession('s1')).toBe('grace');
    expect(mockPrisma.agentRun.count).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.updateMany).not.toHaveBeenCalled();
  });

  it('a fresh claimable run row → owned; a held run lock → locked; nothing written either way', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 's1', status: 'running', updatedAt: STALE() });
    mockPrisma.agentRun.count.mockResolvedValueOnce(1);
    expect(await healOrphanedRunningSession('s1')).toBe('owned');
    expect(mockRedisExists).not.toHaveBeenCalled();
    mockRedisExists.mockResolvedValueOnce(1);
    expect(await healOrphanedRunningSession('s1')).toBe('locked');
    expect(mockPrisma.chatCodingState.updateMany).not.toHaveBeenCalled();
    expect(mockRecoverStrandedSteers).not.toHaveBeenCalled();
  });

  it('FAIL CLOSED: a DB or Redis error answers error and writes nothing; a lost race (0 rows updated) is not_running', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 's1', status: 'running', updatedAt: STALE() });
    mockPrisma.agentRun.count.mockRejectedValueOnce(new Error('db down'));
    expect(await healOrphanedRunningSession('s1')).toBe('error');
    mockRedisExists.mockRejectedValueOnce(new Error('redis down'));
    expect(await healOrphanedRunningSession('s1')).toBe('error');
    expect(mockPrisma.chatCodingState.updateMany).not.toHaveBeenCalled();
    mockPrisma.chatCodingState.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await healOrphanedRunningSession('s1')).toBe('not_running');
    expect(mockRecoverStrandedSteers).not.toHaveBeenCalled();
  });
});

describe('stripSupervisorCodingSatelliteAtFinalize — supervisor lanes are plain chats (run-finalize path, rollout watch 2026-09-14)', () => {
  beforeEach(() => {
    mockPrisma.crossModelChat.findUnique.mockReset();
    mockPrisma.chatCodingState.findUnique.mockReset();
    mockPrisma.chatCodingState.delete.mockReset().mockResolvedValue({});
    mockPrisma.agentRun.count.mockReset().mockResolvedValue(0);
    mockPrisma.agentRun.updateMany.mockReset().mockResolvedValue({ count: 0 });
    mockPrisma.activity.create.mockReset().mockResolvedValue({});
  });

  it('an ordinary coding session: one flags read, nothing else touched', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', isSupervisor: false, isProjectSupervisor: false });
    expect(await stripSupervisorCodingSatelliteAtFinalize('sess-1')).toBe(false);
    expect(mockPrisma.chatCodingState.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.delete).not.toHaveBeenCalled();
  });

  it('a project supervisor lane with a satellite and 2 queued wakes: queued runs cancelled, satellite deleted, audit row written', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', isSupervisor: false, isProjectSupervisor: true });
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'sup-1', branch: 'digby/session-sup-1', worktreePath: '/w/sup-1' });
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 2 });
    expect(await stripSupervisorCodingSatelliteAtFinalize('sup-1')).toBe(true);
    expect(mockPrisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 'sup-1', status: 'queued' }, data: expect.objectContaining({ status: 'cancelled' }) }));
    expect(mockPrisma.chatCodingState.delete).toHaveBeenCalledWith({ where: { id: 'sup-1' } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'u1', action: 'project_supervisor.strip_coding_state', metadata: expect.objectContaining({ chatId: 'sup-1', cancelledQueuedRuns: 2, path: 'run-finalize' }) }) });
  });

  it('a supervisor lane whose satellite is already gone → false, no writes', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', isSupervisor: true, isProjectSupervisor: false });
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
    expect(await stripSupervisorCodingSatelliteAtFinalize('fleet')).toBe(false);
    expect(mockPrisma.agentRun.updateMany).not.toHaveBeenCalled();
  });

  it('another run already RUNNING for the lane → defer (that finalize strips); DB error → false, never throws', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', isSupervisor: false, isProjectSupervisor: true });
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'sup-1', branch: 'b', worktreePath: null });
    mockPrisma.agentRun.count.mockResolvedValue(1);
    expect(await stripSupervisorCodingSatelliteAtFinalize('sup-1')).toBe(false);
    expect(mockPrisma.chatCodingState.delete).not.toHaveBeenCalled();
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('down'));
    expect(await stripSupervisorCodingSatelliteAtFinalize('sup-1')).toBe(false);
  });
});

// ── 22P05 boundary pin (FO firing 20, 2026-09-24) ─────────────────────────────
// The FINAL-transcript persist path (updateCodingMessage) and the append path
// failed 5× for run e8975be5 on `unsupported Unicode escape sequence` — a lone
// surrogate in the content. Both seams must strip before any create/update.
describe('coding transcript persist 22P05 strip (FO firing 20)', () => {
  const LONE = '\uDE48'; // unpaired low surrogate
  const PAIR = '🥨'; // U+1F968 — valid pair, must survive

  it('appendCodingMessage strips lone surrogates from content/parts before create', async () => {
    mockPrisma.codingMessage.create.mockClear();
    mockPrisma.crossModelMessage.upsert.mockClear();
    (mockPrisma.$transaction as jest.Mock).mockClear();
    mockPrisma.codingMessage.create.mockResolvedValue({ id: 'm9', chatId: 'c1', role: 'assistant', content: 'x', parts: null, metadata: null, createdAt: new Date(0) });
    await appendCodingMessage({ chatId: 'c1', role: 'assistant', content: `a${LONE}b ${PAIR}`, parts: [{ type: 'text', text: `p${LONE}q` }] } as any);
    const arg = (mockPrisma.codingMessage.create as jest.Mock).mock.calls[0][0];
    expect(arg.data.content).toBe(`ab ${PAIR}`);
    expect(arg.data.parts[0].text).toBe('pq');
  });

  it('updateCodingMessage (the final-transcript persist seam) strips before update', async () => {
    mockPrisma.codingMessage.update.mockClear();
    (mockPrisma.$transaction as jest.Mock).mockClear();
    mockPrisma.codingMessage.update.mockResolvedValue({ id: 'm1', chatId: 'c1', role: 'assistant', content: 'x', parts: null, metadata: null, createdAt: new Date(0) });
    mockPrisma.crossModelMessage.upsert.mockClear();
    await updateCodingMessage('m1', { content: `f${LONE}g`, parts: [{ type: 'text', text: PAIR }] });
    const arg = (mockPrisma.codingMessage.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.content).toBe('fg');
    expect(arg.data.parts[0].text).toBe(PAIR);
  });
});

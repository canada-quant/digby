/**
 * idle-chat-archiver (ticket bb86cee8) — per-project auto-archive of idle chats.
 *
 * Pins:
 *   (a) an idle chat in an enabled project is archived THROUGH platform.service
 *       archiveChat — never a hand-rolled prisma update (the archivedAt stamp +
 *       satellite flip + chat.archive audit live inside archiveChat; those
 *       internals are pinned by platform.service.test.ts's archiveChat
 *       describe — "owner archives a PLAIN chat — archivedAt stamped …
 *       chat.archive audited" and the CODING-chat satellite-flip case);
 *   (b) a recently-active chat is skipped;
 *   (c) isSupervisor / isProjectSupervisor chats are skipped;
 *   (d) a chat with an ENABLED schedule is skipped;
 *   (e) a chat with an ACTIVE share link is skipped (an expired or revoked
 *       link does NOT protect it);
 *   (f) one candidate's archiveChat refusal never aborts the pass;
 *   (g) a project with autoArchiveIdleDays null is untouched;
 *   plus: the 200/pass scan cap is a TOTAL across projects (backlog logs
 *   "MORE REMAIN"), and the one-line summary reports the pass.
 *
 * Scaffolding mirrors run-reaper.child.test.ts: mock prisma at the boundary;
 * platform.service is mocked to its archiveChat seam (the archiver module
 * imports nothing else from it).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null), update: jest.fn() },
  chatSchedule: { count: jest.fn(async () => 0) },
  chatShareLink: { findUnique: jest.fn(async () => null) },
  chatCodingState: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// The archive seam — THE archiver (platform.service archiveChat). Mocked at
// the module boundary like run-reaper.child.test.ts mocks coding-data.service;
// its stamp/satellite/audit internals are pinned in platform.service.test.ts.
const mockArchiveChat: jest.Mock = jest.fn(async () => ({ id: 'x', archived: true }));
jest.mock('./platform/platform.service', () => ({
  __esModule: true,
  archiveChat: (...a: any[]) => mockArchiveChat(...a),
}));

import { runIdleChatArchiverOnce, IDLE_ARCHIVE_SCAN_CAP, IDLE_ARCHIVE_CASCADE_MAX_PER_PASS } from './idle-chat-archiver';

/** Third review (2026-10-22): the pass's ONE cascade budget and the folder's own idle bar ride every archive (cascade on). */
// Fifth review (2026-10-22): + the pass's restore-audit memo (one Map for every cascade of the pass).
const CASCADE_30D = { cascadeBudget: { remaining: IDLE_ARCHIVE_CASCADE_MAX_PER_PASS }, cascadeIdleMs: 30 * 86_400_000, restoreAuditCache: expect.any(Map) };
import logger from '../../utils/logger';

const OWNER = 'u-owner';
const PROJECT = { id: 'proj-1', autoArchiveIdleDays: 30 };

/** A fresh-read chat row that passes every skip check (idle, ordinary). */
function liveChat(id: string, updatedAt: Date) {
  return {
    id, userId: OWNER, archivedAt: null, updatedAt,
    isSupervisor: false, isProjectSupervisor: false,
  };
}

/** Wire one enabled project whose scan returns the given candidate ids, each
 *  resolved on the fresh read by freshRead (default: a passing idle chat). */
function wireProject(candidateIds: string[], freshRead?: (id: string) => any) {
  mockPrisma.crossModelProject.findMany.mockResolvedValue([PROJECT]);
  mockPrisma.crossModelChat.findMany.mockResolvedValue(candidateIds.map((id) => ({ id })));
  const idle = new Date(Date.now() - 60 * 86_400_000); // 60d > the 30d window
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
    freshRead ? freshRead(where.id) : liveChat(where.id, idle));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
  mockPrisma.chatSchedule.count.mockResolvedValue(0);
  mockPrisma.chatShareLink.findUnique.mockResolvedValue(null);
  mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
  mockArchiveChat.mockResolvedValue({ id: 'x', archived: true });
});

describe('candidate scan', () => {
  it('scans only projects with the feature on, chats archivedAt:null and updatedAt older than the window, oldest first', async () => {
    wireProject([]);
    const before = Date.now();
    await runIdleChatArchiverOnce();
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { autoArchiveIdleDays: { not: null } },
      select: { id: true, autoArchiveIdleDays: true },
    });
    const [args] = mockPrisma.crossModelChat.findMany.mock.calls[0];
    expect(args.where.projectId).toBe(PROJECT.id);
    expect(args.where.archivedAt).toBeNull();
    expect(args.orderBy).toEqual({ updatedAt: 'asc' });
    const cutoff = args.where.updatedAt.lt.getTime();
    // The window is the project's 30 days.
    expect(before - cutoff).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000);
    expect(before - cutoff).toBeLessThanOrEqual(30 * 86_400_000 + 5000);
  });

  it('(g) a project with autoArchiveIdleDays null is untouched (the scan never sees it)', async () => {
    // The DB filter carries this; with no enabled projects the pass is a no-op.
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    await runIdleChatArchiverOnce();
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    // …and the common case stays silent (no summary line).
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('per-candidate archiving', () => {
  it('(a) an idle chat in an enabled project is archived THROUGH archiveChat — never a raw prisma update', async () => {
    wireProject(['chat-1']);
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: OWNER, chatId: 'chat-1', archived: true, ...CASCADE_30D });
    // The job itself NEVER hand-rolls the stamp — the archivedAt write and the
    // chat.archive audit happen inside archiveChat (pinned in
    // platform.service.test.ts: archivedAt stamped + activity action
    // 'chat.archive'; satellite flip for coding chats).
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('(b) a recently-active chat (updatedAt inside the window on the fresh read) is skipped', async () => {
    wireProject(['chat-1'], () => liveChat('chat-1', new Date(Date.now() - 5 * 86_400_000)));
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('(b2) a chat archived between scan and fresh read is skipped', async () => {
    wireProject(['chat-1'], () => ({ ...liveChat('chat-1', new Date(Date.now() - 60 * 86_400_000)), archivedAt: new Date() }));
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('(c) the Fleet Supervisor chat is skipped', async () => {
    wireProject(['chat-1'], () => ({ ...liveChat('chat-1', new Date(Date.now() - 60 * 86_400_000)), isSupervisor: true }));
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('(c2) a Project Supervisor chat is skipped', async () => {
    wireProject(['chat-1'], () => ({ ...liveChat('chat-1', new Date(Date.now() - 60 * 86_400_000)), isProjectSupervisor: true }));
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('(d) a chat with an ENABLED schedule is skipped', async () => {
    wireProject(['chat-1']);
    mockPrisma.chatSchedule.count.mockResolvedValue(1);
    await runIdleChatArchiverOnce();
    expect(mockPrisma.chatSchedule.count).toHaveBeenCalledWith({ where: { sessionId: 'chat-1', enabled: true } });
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('(e) a chat with an ACTIVE share link is skipped', async () => {
    wireProject(['chat-1']);
    mockPrisma.chatShareLink.findUnique.mockResolvedValue({ isActive: true, expiresAt: null });
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('(e2) a chat with an unexpiring-but-future-expiry ACTIVE share link is skipped; revoked or expired links do NOT protect it', async () => {
    wireProject(['chat-1', 'chat-2', 'chat-3']);
    mockPrisma.chatShareLink.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.chatId === 'chat-1') return { isActive: true, expiresAt: new Date(Date.now() + 86_400_000) }; // active, future expiry
      if (where.chatId === 'chat-2') return { isActive: false, expiresAt: null }; // revoked
      return { isActive: true, expiresAt: new Date(Date.now() - 86_400_000) }; // expired
    });
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).toHaveBeenCalledTimes(2);
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId).sort()).toEqual(['chat-2', 'chat-3']);
  });

  it('a chat whose satellite is running or provisioning is skipped (ready/error/archived are not)', async () => {
    wireProject(['c-run', 'c-prov', 'c-ready']);
    mockPrisma.chatCodingState.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'c-run') return { status: 'running' };
      if (where.id === 'c-prov') return { status: 'provisioning' };
      return { status: 'ready' };
    });
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: OWNER, chatId: 'c-ready', archived: true, ...CASCADE_30D });
  });

  it('(f) one candidate\'s archiveChat refusal (409-class) never aborts the pass', async () => {
    wireProject(['refused-1', 'fine-1', 'refused-2', 'fine-2']);
    mockArchiveChat.mockImplementation(async ({ chatId }: any) => {
      if (chatId.startsWith('refused')) {
        const err: any = new Error('Cannot archive while a run is active');
        err.statusCode = 409;
        throw err;
      }
      return { id: chatId, archived: true };
    });
    await expect(runIdleChatArchiverOnce()).resolves.toBeUndefined();
    expect(mockArchiveChat).toHaveBeenCalledTimes(4);
    // Summary line reports 2 archived / 2 skipped and keeps going.
    const summary = (logger.info as jest.Mock).mock.calls.map((c) => String(c[0])).find((l) => l.includes('pass complete'));
    expect(summary).toMatch(/4 candidate\(s\) examined, 2 archived, 2 skipped/);
  });

  it('(f2) an unexpected per-candidate error (no statusCode) also skips-and-logs at warn', async () => {
    wireProject(['boom', 'fine-1']);
    mockArchiveChat.mockImplementation(async ({ chatId }: any) => {
      if (chatId === 'boom') throw new Error('db hiccup');
      return { id: chatId, archived: true };
    });
    await expect(runIdleChatArchiverOnce()).resolves.toBeUndefined();
    expect(mockArchiveChat).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('mixed batch: only the fully idle, unprotected chat is archived', async () => {
    wireProject(['busy', 'supervisor', 'scheduled', 'shared', 'idle']);
    const idle = new Date(Date.now() - 60 * 86_400_000);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'busy') return liveChat('busy', new Date());
      if (where.id === 'supervisor') return { ...liveChat('supervisor', idle), isSupervisor: true };
      return liveChat(where.id, idle);
    });
    mockPrisma.chatSchedule.count.mockImplementation(async ({ where }: any) => (where.sessionId === 'scheduled' ? 2 : 0));
    mockPrisma.chatShareLink.findUnique.mockImplementation(async ({ where }: any) =>
      where.chatId === 'shared' ? { isActive: true, expiresAt: null } : null);
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: OWNER, chatId: 'idle', archived: true, ...CASCADE_30D });
  });
});

describe('scan cap + summary', () => {
  it('the 200/pass cap is a TOTAL across enabled projects; hitting it logs MORE REMAIN', async () => {
    const projects = [
      { id: 'p1', autoArchiveIdleDays: 30 },
      { id: 'p2', autoArchiveIdleDays: 30 },
    ];
    mockPrisma.crossModelProject.findMany.mockResolvedValue(projects);
    const idle = new Date(Date.now() - 60 * 86_400_000);
    mockPrisma.crossModelChat.findMany.mockImplementation(async ({ take }: any) =>
      Array.from({ length: take }, (_v, i) => ({ id: `c-${i}` })));
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => liveChat(where.id, idle));
    await runIdleChatArchiverOnce();
    expect(mockArchiveChat).toHaveBeenCalledTimes(IDLE_ARCHIVE_SCAN_CAP);
    // The second project was never scanned — the budget was exhausted on p1.
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1);
    const summary = (logger.info as jest.Mock).mock.calls.map((c) => String(c[0])).find((l) => l.includes('pass complete'));
    expect(summary).toMatch(new RegExp(`${IDLE_ARCHIVE_SCAN_CAP} candidate\\(s\\) examined, ${IDLE_ARCHIVE_SCAN_CAP} archived, 0 skipped`));
    expect(summary).toMatch(/MORE REMAIN/);
  });

  it('a drained pass logs the one-line summary without MORE REMAIN', async () => {
    wireProject(['chat-1']);
    await runIdleChatArchiverOnce();
    const summary = (logger.info as jest.Mock).mock.calls.map((c) => String(c[0])).find((l) => l.includes('pass complete'));
    expect(summary).toMatch(/1 project\(s\) enabled, 1 candidate\(s\) examined, 1 archived, 0 skipped/);
    expect(summary).not.toMatch(/MORE REMAIN/);
  });

  it('a failing candidate scan for one project never aborts the others (best-effort isolation)', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-bad', autoArchiveIdleDays: 30 },
      { id: 'p-good', autoArchiveIdleDays: 30 },
    ]);
    const idle = new Date(Date.now() - 60 * 86_400_000);
    mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) => {
      if (where.projectId === 'p-bad') throw new Error('db down');
      return [{ id: 'chat-1' }];
    });
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => liveChat(where.id, idle));
    await expect(runIdleChatArchiverOnce()).resolves.toBeUndefined();
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('p-bad'));
  });

  it('a failing project scan ends the pass quietly (warn, never throw)', async () => {
    mockPrisma.crossModelProject.findMany.mockRejectedValue(new Error('db down'));
    await expect(runIdleChatArchiverOnce()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('project scan failed'));
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });
});

describe('third review (2026-10-22) — the cascade under the idle archiver', () => {
  it('every archive of ONE pass shares ONE cascade budget (never 50 children per archived chat) and passes the folder\'s own N-day bar as each child\'s idle window; ARCHIVE_CASCADE_DISABLED=1 restores the pre-cascade call', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-14', autoArchiveIdleDays: 14 }]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, userId: OWNER, archivedAt: null, updatedAt: new Date(Date.now() - 20 * 86_400_000), isSupervisor: false, isProjectSupervisor: false }));
    await runIdleChatArchiverOnce();
    const calls = mockArchiveChat.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.chatId)).toEqual(['a', 'b']);
    expect(calls[0].cascadeBudget).toBe(calls[1].cascadeBudget);
    expect(calls[0].cascadeBudget).toEqual({ remaining: IDLE_ARCHIVE_CASCADE_MAX_PER_PASS });
    expect(calls.every((c: any) => c.cascadeIdleMs === 14 * 86_400_000)).toBe(true);
    // Fifth review (2026-10-22): ONE restore-audit memo per pass too.
    expect(calls[0].restoreAuditCache).toBeInstanceOf(Map);
    expect(calls[0].restoreAuditCache).toBe(calls[1].restoreAuditCache);
    mockArchiveChat.mockClear();
    process.env.ARCHIVE_CASCADE_DISABLED = '1';
    try {
      await runIdleChatArchiverOnce();
      expect(mockArchiveChat.mock.calls.map((c: any[]) => c[0])).toEqual([{ userId: OWNER, chatId: 'a', archived: true }, { userId: OWNER, chatId: 'b', archived: true }]);
    } finally {
      delete process.env.ARCHIVE_CASCADE_DISABLED;
    }
  });
});

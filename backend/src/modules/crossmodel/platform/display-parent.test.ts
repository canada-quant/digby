/**
 * platform/display-parent.ts — the display-only sidebar nesting stamp (2026-10-21,
 * lanefix/nesting). Pins: an agent-origin lane in a folder with a Project
 * Supervisor is stamped with THAT supervisor (same owner, unarchived, oldest);
 * no supervisor / another owner's / an archived one ⇒ null; the write is
 * guarded on a NULL column (never overwritten); the kill switch issues no query
 * and no write; any error degrades to null (a spawn is never failed).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Chat = { id: string; projectId: string | null; userId: string; isProjectSupervisor?: boolean; archivedAt?: Date | null; createdAt: number; displayParentChatId?: string | null };

const chats: Chat[] = [];
const mockPrisma: any = {
  crossModelChat: {
    findFirst: jest.fn(async ({ where }: any) => {
      const rows = chats
        .filter((c) => c.projectId === where.projectId && c.userId === where.userId && !!c.isProjectSupervisor === where.isProjectSupervisor && (c.archivedAt ?? null) === where.archivedAt)
        .sort((a, b) => a.createdAt - b.createdAt);
      return rows[0] ? { id: rows[0].id } : null;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const row = chats.find((c) => c.id === where.id && (c.displayParentChatId ?? null) === where.displayParentChatId);
      if (row) row.displayParentChatId = data.displayParentChatId;
      return { count: row ? 1 : 0 };
    }),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { displayParentNestingDisabled, resolveProjectSupervisorChatId, stampDisplayParent } from './display-parent';

const OWNER = 'u-owner';
const OTHER = 'u-other';
const P = 'proj-crossmodel';

function seed(rows: Chat[]) {
  chats.length = 0;
  chats.push(...rows);
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DISPLAY_PARENT_NESTING_DISABLED;
  seed([
    { id: 'ps-daee2916', projectId: P, userId: OWNER, isProjectSupervisor: true, createdAt: 1 },
    { id: 'lane-b839643b', projectId: P, userId: OWNER, createdAt: 5 },
  ]);
});

afterAll(() => { delete process.env.DISPLAY_PARENT_NESTING_DISABLED; });

describe('displayParentNestingDisabled', () => {
  it("reads DISPLAY_PARENT_NESTING_DISABLED === '1' only", () => {
    expect(displayParentNestingDisabled({} as any)).toBe(false);
    expect(displayParentNestingDisabled({ DISPLAY_PARENT_NESTING_DISABLED: '0' } as any)).toBe(false);
    expect(displayParentNestingDisabled({ DISPLAY_PARENT_NESTING_DISABLED: '1' } as any)).toBe(true);
  });
});

describe('resolveProjectSupervisorChatId', () => {
  it('finds the unarchived supervisor of the SAME owner, oldest first', async () => {
    chats.push({ id: 'ps-later', projectId: P, userId: OWNER, isProjectSupervisor: true, createdAt: 9 });
    expect(await resolveProjectSupervisorChatId(P, OWNER)).toBe('ps-daee2916');
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({
      where: { projectId: P, userId: OWNER, isProjectSupervisor: true, archivedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('is null with no project or user (no query)', async () => {
    expect(await resolveProjectSupervisorChatId('', OWNER)).toBeNull();
    expect(await resolveProjectSupervisorChatId(P, '')).toBeNull();
    expect(mockPrisma.crossModelChat.findFirst).not.toHaveBeenCalled();
  });
});

describe('stampDisplayParent', () => {
  it('an agent lane in a folder with a Project Supervisor is stamped with it', async () => {
    expect(await stampDisplayParent({ chatId: 'lane-b839643b', projectId: P, userId: OWNER })).toBe('ps-daee2916');
    expect(mockPrisma.crossModelChat.updateMany).toHaveBeenCalledWith({
      where: { id: 'lane-b839643b', displayParentChatId: null },
      data: { displayParentChatId: 'ps-daee2916' },
    });
    expect(chats.find((c) => c.id === 'lane-b839643b')!.displayParentChatId).toBe('ps-daee2916');
  });

  it('no Project Supervisor in the folder ⇒ null, no write', async () => {
    seed([{ id: 'lane', projectId: P, userId: OWNER, createdAt: 1 }]);
    expect(await stampDisplayParent({ chatId: 'lane', projectId: P, userId: OWNER })).toBeNull();
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });

  it("another owner's supervisor is never used", async () => {
    seed([
      { id: 'ps-other', projectId: P, userId: OTHER, isProjectSupervisor: true, createdAt: 1 },
      { id: 'lane', projectId: P, userId: OWNER, createdAt: 2 },
    ]);
    expect(await stampDisplayParent({ chatId: 'lane', projectId: P, userId: OWNER })).toBeNull();
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });

  it('an archived supervisor is never used', async () => {
    seed([
      { id: 'ps-arch', projectId: P, userId: OWNER, isProjectSupervisor: true, archivedAt: new Date('2026-10-01T00:00:00Z'), createdAt: 1 },
      { id: 'lane', projectId: P, userId: OWNER, createdAt: 2 },
    ]);
    expect(await stampDisplayParent({ chatId: 'lane', projectId: P, userId: OWNER })).toBeNull();
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });

  it('the supervisor itself is never its own display parent', async () => {
    expect(await stampDisplayParent({ chatId: 'ps-daee2916', projectId: P, userId: OWNER })).toBeNull();
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });

  it('an already-stamped chat is never overwritten (guarded on NULL)', async () => {
    chats.find((c) => c.id === 'lane-b839643b')!.displayParentChatId = 'ps-earlier';
    expect(await stampDisplayParent({ chatId: 'lane-b839643b', projectId: P, userId: OWNER })).toBeNull();
    expect(chats.find((c) => c.id === 'lane-b839643b')!.displayParentChatId).toBe('ps-earlier');
  });

  it('DISPLAY_PARENT_NESTING_DISABLED=1 ⇒ no query and no write', async () => {
    process.env.DISPLAY_PARENT_NESTING_DISABLED = '1';
    expect(await stampDisplayParent({ chatId: 'lane-b839643b', projectId: P, userId: OWNER })).toBeNull();
    expect(mockPrisma.crossModelChat.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });

  it('a DB error degrades to null and never throws', async () => {
    mockPrisma.crossModelChat.findFirst.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(stampDisplayParent({ chatId: 'lane-b839643b', projectId: P, userId: OWNER })).resolves.toBeNull();
    mockPrisma.crossModelChat.updateMany.mockRejectedValueOnce(new Error('write failed'));
    await expect(stampDisplayParent({ chatId: 'lane-b839643b', projectId: P, userId: OWNER })).resolves.toBeNull();
  });
});

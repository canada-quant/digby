/**
 * User Space (P3 §2) — ensureUserSpace: the ensureFleetSupervisor invariants
 * (find-first → create with P2002 convergence → NEVER throw) plus the two
 * provider variants: adults get a 'blank' (workspace-capable) space, KID
 * accounts a PLAIN one (repoProvider null — kid chats must never become
 * codeCapable, spec §2/§4c).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  crossModelProject: { findFirst: jest.fn(), create: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { ensureUserSpace, USER_SPACE_NAME } from './user-space.service';

const OWNER = 'u-owner-1234';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
  mockPrisma.crossModelProject.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelProject.create.mockImplementation(async ({ data }: any) => ({ id: data.id, repoProvider: data.repoProvider }));
});

describe('ensureUserSpace', () => {
  it('returns the EXISTING space on the find-first path (no create, idempotent)', async () => {
    mockPrisma.crossModelProject.findFirst.mockResolvedValue({ id: 'space-1', repoProvider: 'blank' });
    const s = await ensureUserSpace(OWNER);
    expect(s).toEqual({ id: 'space-1', repoProvider: 'blank' });
    expect(mockPrisma.crossModelProject.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelProject.findFirst).toHaveBeenCalledWith({
      where: { userId: OWNER, isUserSpace: true },
      select: { id: true, repoProvider: true },
    });
  });

  it('creates the hidden space for an ADULT: blank provider, private, SUPERVISED (fleet hooks stay live), rooted folder-tree invariants', async () => {
    const s = await ensureUserSpace(OWNER);
    expect(s).toMatchObject({ repoProvider: 'blank' });
    const data = mockPrisma.crossModelProject.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: OWNER,
      name: USER_SPACE_NAME, // 'Workspace'
      isUserSpace: true,
      isPublic: false,
      supervised: true, // 2026-09-02: false would deafen hooks + the attention watchdog for auto-filed chats
      repoProvider: 'blank',
      depth: 0,
    });
    expect(data.path).toBe(`/${data.id}`); // materialized root path
  });

  it('creates a PLAIN space (repoProvider null) for a KID account — kid chats are never codeCapable (§4c)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: true });
    const s = await ensureUserSpace(OWNER);
    expect(s).toMatchObject({ repoProvider: null });
    expect(mockPrisma.crossModelProject.create.mock.calls[0][0].data.repoProvider).toBeNull();
  });

  it('P2002 convergence: a concurrent ensure loses the create race and re-reads the WINNER', async () => {
    mockPrisma.crossModelProject.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    mockPrisma.crossModelProject.findFirst
      .mockResolvedValueOnce(null) // the initial find-first miss
      .mockResolvedValueOnce({ id: 'space-winner', repoProvider: 'blank' }); // the post-race re-read
    const s = await ensureUserSpace(OWNER);
    expect(s).toEqual({ id: 'space-winner', repoProvider: 'blank' });
  });

  it('NEVER throws: a DB outage logs + returns null (the triggering chat proceeds unfiled)', async () => {
    mockPrisma.crossModelProject.findFirst.mockRejectedValue(new Error('db down'));
    await expect(ensureUserSpace(OWNER)).resolves.toBeNull();
  });

  it('returns null for an unknown user (and never creates)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(ensureUserSpace(OWNER)).resolves.toBeNull();
    expect(mockPrisma.crossModelProject.create).not.toHaveBeenCalled();
  });

  it('returns null for an empty userId without touching the DB', async () => {
    await expect(ensureUserSpace('')).resolves.toBeNull();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });
});

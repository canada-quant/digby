/**
 * MERGE-1 slice 1 (owner completion directive 2026-11-03) — ONE capability
 * rule, many surfaces.
 *
 * THE DEFECT THIS PINS. The coding capability was re-implemented inline at
 * three list surfaces instead of being read from the one canonical resolver
 * (`getChatCapability`, coding-data.service.ts). One copy had DRIFTED: the
 * fleet supervisor view computed `codeCapable = !!satellite` with no
 * folder-chain leg, so a supervisor chat filed in a workspace folder reported
 * codeCapable=false there while the sidebar (listChats) and the folder tree
 * (getProject) both said true. Same chat, two answers — and the answer the
 * fleet UI got was the wrong one.
 *
 * WHAT IS FROZEN HERE:
 *   1. `capabilityFrom` — the pure predicate — is THE rule: a satellite marks
 *      the chat coding; a resolvable workspace folder makes it attachable;
 *      workspaceReady needs an actual worktree.
 *   2. `getChatCapabilities` (batch) agrees with `getChatCapability` (single)
 *      on every chat shape. This is the anti-drift assertion: if a future edit
 *      teaches one path a rule the other does not know, this fails.
 *   3. The batch reader keeps the list surfaces' N+1 discipline: ONE satellite
 *      query for the whole set, and ONE folder-chain lookup per DISTINCT
 *      projectId (not per chat).
 *   4. THE ROUTING INVARIANT the slice must not break: `hasWorkspaceState` —
 *      never `codeCapable` — is what decides the coding pipeline. A chat that
 *      is codeCapable but satellite-less must NOT report hasWorkspaceState
 *      (that is exactly "no session enters a stream path its capability does
 *      not grant": attachable ≠ currently coding).
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

const mockPrisma: any = {
  chatCodingState: { findUnique: jest.fn(), findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// The folder-chain leg is the seam that drifted. Mocked so the test can state
// "this folder resolves to a workspace" / "it does not" without a project tree.
const mockGetNearestWorkspaceFolder: jest.Mock = jest.fn(async () => null);
jest.mock('../platform/folder-inheritance', () => ({
  __esModule: true,
  getNearestWorkspaceFolder: (...a: any[]) => mockGetNearestWorkspaceFolder(...a),
}));

import { capabilityFrom, getChatCapability, getChatCapabilities } from './coding-data.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockGetNearestWorkspaceFolder.mockResolvedValue(null);
});

describe('capabilityFrom — THE rule, in one place', () => {
  it('a satellite marks the chat coding AND attachable', () => {
    expect(capabilityFrom(true, '/w/x', false)).toEqual({
      codeCapable: true,
      hasWorkspaceState: true,
      workspaceReady: true,
    });
  });

  it('a satellite whose worktree is not provisioned is coding but not ready', () => {
    expect(capabilityFrom(true, null, false)).toEqual({
      codeCapable: true,
      hasWorkspaceState: true,
      workspaceReady: false,
    });
  });

  it('a satellite-less chat in a workspace folder is attachable but NOT coding', () => {
    // The routing invariant: codeCapable gates attach triggers only. It must
    // never imply hasWorkspaceState, or a plain chat would open the coding
    // pipeline just by living in the right folder.
    expect(capabilityFrom(false, null, true)).toEqual({
      codeCapable: true,
      hasWorkspaceState: false,
      workspaceReady: false,
    });
  });

  it('a satellite-less chat outside any workspace folder is neither', () => {
    expect(capabilityFrom(false, null, false)).toEqual({
      codeCapable: false,
      hasWorkspaceState: false,
      workspaceReady: false,
    });
  });
});

describe('getChatCapability (single) — satellite / folder-chain resolution', () => {
  it('reads the satellite and skips the folder-chain lookup entirely', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ worktreePath: '/w/a' });

    const cap = await getChatCapability({ id: 'c1', projectId: 'p1' });

    expect(cap).toEqual({ codeCapable: true, hasWorkspaceState: true, workspaceReady: true });
    expect(mockGetNearestWorkspaceFolder).not.toHaveBeenCalled();
  });

  it('falls back to the folder chain for a satellite-less chat', async () => {
    mockGetNearestWorkspaceFolder.mockResolvedValue({ id: 'p1', repoProvider: 'github' });

    const cap = await getChatCapability({ id: 'c2', projectId: 'p1' });

    expect(cap).toEqual({ codeCapable: true, hasWorkspaceState: false, workspaceReady: false });
    expect(mockGetNearestWorkspaceFolder).toHaveBeenCalledWith('p1');
  });

  it('a chat in no folder is never capable', async () => {
    const cap = await getChatCapability({ id: 'c3', projectId: null });
    expect(cap.codeCapable).toBe(false);
    expect(mockGetNearestWorkspaceFolder).not.toHaveBeenCalled();
  });

  it('preloadedState === null means "already known satellite-less" (no second query)', async () => {
    mockGetNearestWorkspaceFolder.mockResolvedValue(null);

    const cap = await getChatCapability({ id: 'c4', projectId: 'p1' }, null);

    expect(cap.hasWorkspaceState).toBe(false);
    expect(mockPrisma.chatCodingState.findUnique).not.toHaveBeenCalled();
  });
});

describe('getChatCapabilities (batch) — agrees with the single reader', () => {
  it('returns the SAME answer as getChatCapability for every shape', async () => {
    // satellites: s1 ready, s2 not provisioned; plain: p-sat-less in a
    // workspace folder, p-orphan in no folder, p-plain in a non-workspace folder.
    mockPrisma.chatCodingState.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 's1') return { worktreePath: '/w/1' };
      if (where.id === 's2') return { worktreePath: null };
      return null;
    });
    mockPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: 's1', worktreePath: '/w/1' },
      { id: 's2', worktreePath: null },
    ]);
    mockGetNearestWorkspaceFolder.mockImplementation(async (id: string) =>
      id === 'ws-folder' ? { id, repoProvider: 'github' } : null,
    );

    const chats = [
      { id: 's1', projectId: 'ws-folder' },
      { id: 's2', projectId: null },
      { id: 'p-sat-less', projectId: 'ws-folder' },
      { id: 'p-orphan', projectId: null },
      { id: 'p-plain', projectId: 'plain-folder' },
    ];

    const batch = await getChatCapabilities(chats);
    const singles = await Promise.all(chats.map((c) => getChatCapability(c)));

    chats.forEach((c, i) => {
      expect(batch.get(c.id)).toEqual(singles[i]);
    });
    expect(batch.size).toBe(chats.length);
  });

  it('keeps the list surfaces N+1-free: ONE satellite query, ONE folder leg per distinct project', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    mockGetNearestWorkspaceFolder.mockResolvedValue({ id: 'ws', repoProvider: 'github' });

    await getChatCapabilities([
      { id: 'a', projectId: 'ws' },
      { id: 'b', projectId: 'ws' },
      { id: 'c', projectId: 'ws' },
      { id: 'd', projectId: 'other' },
    ]);

    // 4 chats -> 1 satellite query, not 4.
    expect(mockPrisma.chatCodingState.findMany).toHaveBeenCalledTimes(1);
    // 2 distinct projectIds -> 2 folder-chain lookups, not 4.
    expect(mockGetNearestWorkspaceFolder).toHaveBeenCalledTimes(2);
    expect(mockPrisma.chatCodingState.findUnique).not.toHaveBeenCalled();
  });

  it('an empty list queries nothing', async () => {
    const out = await getChatCapabilities([]);
    expect(out.size).toBe(0);
    expect(mockPrisma.chatCodingState.findMany).not.toHaveBeenCalled();
  });

  it('preloadedStates is honored (the chat-status poller reuses its own satellite row)', async () => {
    const preloaded = new Map<string, { worktreePath: string | null } | null>([
      ['s1', { worktreePath: '/w/1' }],
      ['p1', null],
    ]);

    const out = await getChatCapabilities([{ id: 's1' }, { id: 'p1' }], preloaded);

    expect(out.get('s1')).toEqual({ codeCapable: true, hasWorkspaceState: true, workspaceReady: true });
    expect(out.get('p1')!.hasWorkspaceState).toBe(false);
    expect(mockPrisma.chatCodingState.findMany).not.toHaveBeenCalled();
  });

  it('a satellite query failure degrades to "no satellites", never throws', async () => {
    mockPrisma.chatCodingState.findMany.mockRejectedValue(new Error('db down'));
    mockGetNearestWorkspaceFolder.mockResolvedValue(null);

    const out = await getChatCapabilities([{ id: 'x', projectId: 'p' }]);

    expect(out.get('x')).toEqual({ codeCapable: false, hasWorkspaceState: false, workspaceReady: false });
  });
});

describe('cross-surface agreement — the drift that motivated the slice', () => {
  it('a satellite-less chat in a workspace folder is codeCapable on EVERY surface', async () => {
    // This is the exact fleet case: the supervisor chat lives in a workspace
    // folder. Before the slice the fleet view answered false here while the
    // sidebar answered true. All three now read the same rule.
    mockGetNearestWorkspaceFolder.mockResolvedValue({ id: 'ws', repoProvider: 'github' });

    const single = await getChatCapability({ id: 'sup', projectId: 'ws' });
    const batch = await getChatCapabilities([{ id: 'sup', projectId: 'ws' }]);

    expect(single.codeCapable).toBe(true);
    expect(batch.get('sup')!.codeCapable).toBe(true);
    // …and both still refuse to call it coding.
    expect(single.hasWorkspaceState).toBe(false);
    expect(batch.get('sup')!.hasWorkspaceState).toBe(false);
  });
});
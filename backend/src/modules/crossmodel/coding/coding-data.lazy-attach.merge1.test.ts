/**
 * MERGE-1 remainder (a) — THE LAZY-ATTACH INVARIANT, pinned.
 *
 * WHAT WAS ASKED. "Confirm the lazy ChatWorkspaceState seam — check whether
 * ensureChatWorkspaceState already IS it; verify no eager create survives
 * outside createCodingChat."
 *
 * WHAT THE AUDIT FOUND (2026-11-04), and why this file exists rather than a
 * refactor: the seam WAS already lazy and already singular. Across the whole
 * backend there are exactly TWO non-test `chatCodingState.create` call sites —
 * `createCodingChat` (a chat BORN a coding session, one transaction) and
 * `ensureChatWorkspaceState` (a chat that GAINS the capability on demand) — and
 * every attach entry point (send-time router, attach_workspace tool,
 * POST /chats/:id/coding, the stream backstop) funnels through the latter. The
 * `mode='code'` routing guard named in the charter is already gone: capacity is
 * read off the satellite, never off a chat-row mode marker.
 *
 * So the risk was never "the seam is in the wrong place" — it is that NOTHING
 * PINNED IT. A future caller could add a third create site (an eager attach at
 * profile-read time, say) or reintroduce a mode guard, and every existing test
 * would stay green: 213 files touch the `chatCodingState` delegate, but not one
 * asserted that the WRITES are confined. That is the gap this file closes, from
 * both directions:
 *   1. BEHAVIOUR — every decision ensureChatWorkspaceState makes, including the
 *      three that must attach NOTHING.
 *   2. SHAPE — a source pin that the create sites stay at two and that no
 *      capability reader writes, so a new one fails the build instead of
 *      quietly converting plain chats into sessions.
 *
 * The behavioural half is mutation-proven: deleting the supervisor belt turns
 * "a supervisor lane is refused" red (verified 2026-11-04 — a retargeted seam
 * that stays green under mutation is vacuous).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
    exists: jest.fn(async () => 0),
  },
}));

// The agent-mode auto-grant seam — lazy-imported by ensureChatWorkspaceState.
// Pinned here because "attach" and "materialize the grant" are one decision:
// a lazily-attached session created in Auto is a session CREATED in Auto.
const mockSyncAutonomy: jest.Mock = jest.fn(async () => 'granted');
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  syncAutonomyWithAgentMode: (...a: any[]) => mockSyncAutonomy(...a),
}));

// The folder-chain resolver — mocked so the two workspace-resolution legs (the
// chat's own folder vs an ANCESTOR folder) can be driven independently.
const mockNearestWorkspace: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('../platform/folder-inheritance', () => ({
  __esModule: true,
  getNearestWorkspaceFolder: (...a: any[]) => mockNearestWorkspace(...a),
  getAncestorChain: jest.fn(async (): Promise<any[]> => []),
}));

// Branch identity is assigned EAGERLY (a stable name from the first moment) —
// pinned as a value, so the module is stubbed rather than exercised.
jest.mock('./workspace.service', () => ({
  __esModule: true,
  sessionBranchName: (id: string) => `digby/session-${id.slice(0, 8)}`,
}));

// Seat governance resolves the stamped model through half the coding graph;
// stub the decision so this file pins the ATTACH, not the seat.
jest.mock('./seat-governance', () => ({
  __esModule: true,
  seatGovernsSessionsDisabled: () => false,
  resolveGoverningCodingModel: jest.fn(async () => ({ model: 'glm-5.3', source: 'seat', detail: 'coding_default seat' })),
}));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), update: jest.fn() },
  chatCodingState: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(async () => []),
    update: jest.fn(),
  },
  crossModelProject: { findFirst: jest.fn(), findUnique: jest.fn() },
  userPreferences: { findUnique: jest.fn(async () => null) },
  projectMember: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(), count: jest.fn() },
  codingMessage: { findMany: jest.fn(), count: jest.fn() },
  agentRun: { findMany: jest.fn(), count: jest.fn(async () => 0) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
  $executeRawUnsafe: jest.fn(async () => 0),
  contextStoreEntry: { deleteMany: jest.fn(async () => ({ count: 0 })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { ensureChatWorkspaceState } from './coding-data.service';

const CHAT_ID = 'c1';
const chat = { id: CHAT_ID, userId: 'u1', projectId: 'p1', title: 'Fix bug' };

/** Wire the chat-row reads ensureChatWorkspaceState makes, in order:
 *  1. getSessionForUser's findUnique (include codingState) — EXISTING satellite?
 *  2. the supervisor-belt findUnique (select isSupervisor/isProjectSupervisor). */
function wireChat(opts: {
  state?: any;
  isSupervisor?: boolean;
  isProjectSupervisor?: boolean;
} = {}): void {
  mockPrisma.crossModelChat.findUnique.mockImplementation(async (args: any) => {
    if (args?.select?.isSupervisor !== undefined) {
      return { isSupervisor: opts.isSupervisor === true, isProjectSupervisor: opts.isProjectSupervisor === true };
    }
    return {
      id: CHAT_ID,
      userId: 'u1',
      projectId: 'p1',
      title: 'Fix bug',
      updatedAt: new Date('2026-07-02'),
      codingState: opts.state ?? null,
    };
  });
}

const EXISTING_STATE = {
  id: CHAT_ID, projectId: 'p1', userId: 'u1', title: 'stale-title',
  branch: 'digby/session-c1', baseBranch: 'main', worktreePath: '/wt/c1',
  permissionMode: 'auto', model: 'glm-5.3', status: 'ready', errorMessage: null,
  createdAt: new Date('2026-07-01'), updatedAt: new Date('2026-07-01'),
};

const CREATED = {
  id: CHAT_ID, projectId: 'p1', userId: 'u1', title: 'Fix bug',
  branch: 'digby/session-c1', baseBranch: 'main', worktreePath: null,
  permissionMode: 'auto', model: 'glm-5.3', status: 'provisioning', errorMessage: null,
  createdAt: new Date('2026-07-01'), updatedAt: new Date('2026-07-01'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.userPreferences.findUnique.mockResolvedValue(null);
  mockPrisma.crossModelProject.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelProject.findUnique.mockResolvedValue(null);
  mockPrisma.chatCodingState.create.mockResolvedValue(CREATED);
  mockNearestWorkspace.mockResolvedValue(null);
});

// ── Behaviour: the three paths that must attach NOTHING ──────────────────────

describe('ensureChatWorkspaceState — refusing to attach', () => {
  it('an ALREADY-ATTACHED chat is a plain READ — zero creates', async () => {
    wireChat({ state: EXISTING_STATE });
    const session = await ensureChatWorkspaceState(chat);

    expect(session).not.toBeNull();
    expect(session!.id).toBe(CHAT_ID);
    // The early return is the whole reason a read-path caller (getChatStatus,
    // a list surface) can call this idempotently without minting rows.
    expect(mockPrisma.chatCodingState.create).not.toHaveBeenCalled();
  });

  it('a chat in NO folder can never attach — null, zero creates', async () => {
    wireChat();
    const session = await ensureChatWorkspaceState({ ...chat, projectId: null });

    expect(session).toBeNull();
    expect(mockPrisma.chatCodingState.create).not.toHaveBeenCalled();
  });

  // ⚠ MUTATION-PROVEN (2026-11-04): these two cases MUST have a resolvable
  // workspace, or they are vacuous. First cut left findFirst returning null, so
  // both passed by bailing at the no-workspace guard — stubbing the supervisor
  // belt to `if (false)` left them GREEN. With a workspace wired, deleting the
  // belt turns BOTH red (verified). The belt is then the only thing standing
  // between a supervisor lane and a satellite.
  const RESOLVABLE = {
    id: 'p1', userId: 'u1', name: 'Repo', repoUrl: 'https://x/y', repoProvider: 'github',
    defaultBranch: 'main', githubLabel: null,
  };

  it('a SUPERVISOR lane is refused — the belt behind every attach entry point', async () => {
    // Rollout watch 2026-09-14: two project supervisors were lazily attached by
    // an agent send and woke as CODING runs. Supervisors orchestrate workers;
    // they are not workers. Every attach path funnels here, so this is the belt.
    wireChat({ isSupervisor: true });
    mockPrisma.crossModelProject.findFirst.mockResolvedValue(RESOLVABLE);

    const session = await ensureChatWorkspaceState(chat);

    expect(session).toBeNull();
    expect(mockPrisma.chatCodingState.create).not.toHaveBeenCalled();
  });

  it('a PROJECT supervisor lane is refused too (the second flag, not the first)', async () => {
    wireChat({ isProjectSupervisor: true });
    mockPrisma.crossModelProject.findFirst.mockResolvedValue(RESOLVABLE);

    const session = await ensureChatWorkspaceState(chat);

    expect(session).toBeNull();
    expect(mockPrisma.chatCodingState.create).not.toHaveBeenCalled();
  });

  it('a NON-supervisor chat in the SAME resolvable folder DOES attach (the control)', async () => {
    // Without this, the two cases above could pass for the wrong reason again:
    // this proves the fixture reaches the attach decision, so their null is the
    // belt's doing and not an unresolvable-workspace bail.
    wireChat();
    mockPrisma.crossModelProject.findFirst.mockResolvedValue(RESOLVABLE);

    const session = await ensureChatWorkspaceState(chat);

    expect(session).not.toBeNull();
    expect(mockPrisma.chatCodingState.create).toHaveBeenCalledTimes(1);
  });

  it('no workspace resolvable from the folder chain → null, zero creates', async () => {
    // The chat's own folder is not a repo, and no ancestor owns a workspace.
    wireChat();
    mockPrisma.crossModelProject.findFirst.mockResolvedValue(null);
    mockNearestWorkspace.mockResolvedValue(null);

    const session = await ensureChatWorkspaceState(chat);
    expect(session).toBeNull();
    expect(mockPrisma.chatCodingState.create).not.toHaveBeenCalled();
  });
});

// ── Behaviour: the two paths that DO attach, and where they file the row ─────

describe('ensureChatWorkspaceState — where the satellite is filed', () => {
  it('the chat folder IS the workspace → filed under the chat folder', async () => {
    wireChat();
    mockPrisma.crossModelProject.findFirst.mockResolvedValue({
      id: 'p1', userId: 'u1', name: 'Repo', repoUrl: 'https://x/y', repoProvider: 'github',
      defaultBranch: 'trunk', githubLabel: null,
    });

    const session = await ensureChatWorkspaceState(chat);

    expect(session).not.toBeNull();
    expect(mockPrisma.chatCodingState.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.chatCodingState.create.mock.calls[0][0].data;
    // The satellite SHARES the chat id (One-Digby: id == chat id).
    expect(data.id).toBe(CHAT_ID);
    expect(data.projectId).toBe('p1');
    expect(data.baseBranch).toBe('trunk');
    // No folder-chain lookup was needed: the leaf folder resolved directly.
    expect(mockNearestWorkspace).not.toHaveBeenCalled();
  });

  it('an ANCESTOR owns the workspace → filed under the ANCESTOR, never the chat folder', async () => {
    // The load-bearing case: the whole run path reads
    // session.project.repoUrl/provider off state.projectId, so a satellite
    // filed under the leaf would resolve NO repo and fail at provision time.
    wireChat();
    mockPrisma.crossModelProject.findFirst.mockResolvedValue(null); // leaf is not a repo
    mockNearestWorkspace.mockResolvedValue({
      id: 'root-ws', userId: 'u1', name: 'Workspace', repoUrl: 'https://x/w', repoProvider: 'github',
      defaultBranch: 'main', githubLabel: null,
    });

    const session = await ensureChatWorkspaceState(chat);

    expect(session).not.toBeNull();
    expect(mockNearestWorkspace).toHaveBeenCalledWith('p1');
    const data = mockPrisma.chatCodingState.create.mock.calls[0][0].data;
    expect(data.projectId).toBe('root-ws');
  });

  it('the created row NEVER provisions eagerly — branch now, worktree later', async () => {
    wireChat();
    mockPrisma.crossModelProject.findFirst.mockResolvedValue({
      id: 'p1', userId: 'u1', name: 'Repo', repoUrl: 'https://x/y', repoProvider: 'github',
      defaultBranch: 'main', githubLabel: null,
    });

    await ensureChatWorkspaceState(chat);

    const data = mockPrisma.chatCodingState.create.mock.calls[0][0].data;
    // A stable branch identity from the first moment (continuity chaining and
    // the UI key off it) …
    expect(data.branch).toBe('digby/session-c1');
    // … but NO worktreePath and NO status flip: ensureRunnable provisions on
    // demand at run start. An eager clone for a maybe-never run is the exact
    // cost this lazy seam exists to avoid.
    expect(data.worktreePath).toBeUndefined();
    expect(data.status).toBeUndefined();
  });
});

// ── Behaviour: the auto-grant rides the attach decision ─────────────────────

describe('ensureChatWorkspaceState — agent-mode grant', () => {
  function wireResolvable(): void {
    wireChat();
    mockPrisma.crossModelProject.findFirst.mockResolvedValue({
      id: 'p1', userId: 'u1', name: 'Repo', repoUrl: 'https://x/y', repoProvider: 'github',
      defaultBranch: 'main', githubLabel: null,
    });
  }

  it("permissionMode 'auto' materializes the grant for the newly attached chat", async () => {
    wireResolvable();
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ codingPermissionMode: 'auto', codingModel: null });

    await ensureChatWorkspaceState(chat);
    await new Promise((r) => setImmediate(r));

    expect(mockSyncAutonomy).toHaveBeenCalledWith({ chatId: CHAT_ID, permissionMode: 'auto' });
  });

  it("permissionMode 'ask' never touches the grant", async () => {
    wireResolvable();
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ codingPermissionMode: 'ask', codingModel: null });

    await ensureChatWorkspaceState(chat);
    await new Promise((r) => setImmediate(r));

    expect(mockSyncAutonomy).not.toHaveBeenCalled();
  });
});

// ── Shape: the invariant that a new create site cannot appear unnoticed ─────

describe('the lazy-attach invariant holds across the whole tree (source pin)', () => {
  // __dirname = backend/src/modules/crossmodel/coding → three levels up = backend/src
  // (NOT four: that lands on backend/ and sweeps node_modules/.prisma/client,
  // whose generated .d.ts mentions the delegate and would pollute the census).
  const SRC = join(__dirname, '..', '..', '..');

  /** Every non-test .ts file under backend/src. */
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  const files = walk(SRC).map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));

  it('exactly TWO chatCodingState.create sites exist, both in coding-data.service', () => {
    const CREATE = /chatCodingState\s*\.\s*create\s*\(/g;
    const hits = files.flatMap((f) => {
      const n = (f.text.match(CREATE) || []).length;
      return n ? [{ file: relative(SRC, f.path), n }] : [];
    });

    // createCodingChat (a chat BORN a session) + ensureChatWorkspaceState (a
    // chat that GAINS the capability). A third one is an eager attach, and
    // eager attaches are how plain chats become sessions by accident.
    expect(hits).toEqual([{ file: join('modules', 'crossmodel', 'coding', 'coding-data.service.ts'), n: 2 }]);
  });

  it('no un-awaited fire-and-forget create hides behind the delegate', () => {
    // A `.create(` on the delegate is fine ONLY as `await`ed (or as a
    // transaction-client call inside $transaction). An unawaited one can land
    // AFTER a caller checked "no satellite" and raced a second insert.
    for (const f of files) {
      for (const line of f.text.split('\n')) {
        if (!/chatCodingState\s*\.\s*create\s*\(/.test(line)) continue;
        expect(line).toMatch(/await|tx\./);
      }
    }
  });

  it("no `mode === 'code'` routing guard survives — capacity comes from the satellite", () => {
    // The charter line: "delete the mode='code' guard". Coding is a CAPABILITY
    // of a chat, not a mode marker on it. A reintroduced guard would mean two
    // sources of truth for "is this a coding session?" and they can disagree —
    // the exact drift slice 1 was spent converging.
    const GUARD = /\.mode\s*[=!]==?\s*['"]code['"]/;
    const offenders = files.filter((f) => GUARD.test(f.text)).map((f) => relative(SRC, f.path));
    expect(offenders).toEqual([]);
  });

  it('the capability READERS never write — reading a chat must not convert it', () => {
    // getChatCapability / getChatCapabilities answer "is this coding?" for every
    // list surface. If either could create, EVERY sidebar render of a
    // code-capable folder would attach a satellite to every chat in it.
    const service = files.find((f) => f.path.endsWith(join('coding', 'coding-data.service.ts')))!.text;
    const start = service.indexOf('export async function getChatCapability(');
    const end = service.indexOf('Stored codingModel pref', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const readers = service.slice(start, end);

    expect(readers).not.toMatch(/\.create\s*\(/);
    expect(readers).not.toMatch(/\$transaction/);
    // …and they delegate to the ONE pure predicate, never re-implement it.
    expect(readers).toContain('capabilityFrom(');
  });
});
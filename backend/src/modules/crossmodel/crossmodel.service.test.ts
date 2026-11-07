/**
 * crossmodel.service wiring test — createChat fire-and-forget ensures the
 * owner's ONE global fleet supervisor (dynamic import of
 * platform/supervisor.service, mocked here as the boundary). Pins:
 *   - any chat whose filing project is supervised → ensure(userId) (no
 *     per-chat wiring — the wildcard hook covers new chats);
 *   - the createChat return value is NOT blocked on the supervisor (it resolves
 *     before the side effect completes — fire-and-forget);
 *   - a chat filed into an UNSUPERVISED project triggers NO supervisor work
 *     (ticket 3217e287 — auto-scaffolding is gated on the project's flag);
 *   - a supervisor-side-effect failure never rejects createChat.
 * Also covers updateChat project moves: a coding chat (ChatCodingState
 * satellite) may move ONLY into a plain folder (both rows flipped in ONE
 * transaction); workspace-project / null / missing targets are refused. A
 * PLAIN chat's null move RE-FILES into the owner's user space (User Space P3
 * §3 — never a disconnect unless the ensure hiccups). Every move with a
 * non-null target ALSO authorizes the DESTINATION project (getProjectAccess:
 * owner or editor/admin member — viewer/none 404-shaped), and a failed
 * satellite lookup aborts the whole move instead of degrading to a chat-only
 * flip. createChat's null-projectId auto-filing into the user space is
 * covered here too (mocked user-space boundary).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn(), delete: jest.fn(async () => ({})) },
  crossModelMessage: { findMany: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn(async () => []) },
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  chatCodingState: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), delete: jest.fn(async () => ({})) },
  projectMember: { findUnique: jest.fn(), findMany: jest.fn() },
  user: { findMany: jest.fn() }, // messageAuthors resolution (f89d1213)
  chatFile: { findMany: jest.fn() }, // chip → ChatFile fileId injection (c6e8edda)
  pendingChatMessage: { findMany: jest.fn() }, // queued-user-message enrichment (c0b2b0c8)
  chatSchedule: { groupBy: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../middleware/error-handler', () => ({
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

// Per-chat lead pick validator (WI-O #4c) — updateChat reaches it via DYNAMIC
// import; mocked as the boundary (the real leaf dynamically imports
// model-roles.service → axios/context-store).
const mockResolveChatLeadPick = jest.fn(async (pick: string, _userId?: string): Promise<string | null> => (['kimi-k3', 'glm-5.3', 'deepseek-flash'].includes(pick) ? pick : null));
jest.mock('./chat-agent/chat-lead-model', () => ({
  __esModule: true,
  resolveChatLeadPick: (...a: any[]) => mockResolveChatLeadPick(...(a as [string, string?])),
  chatLeadBuiltInOptions: jest.fn(async () => ['kimi-k3', 'glm-5.3', 'deepseek-flash', 'qwen3.6-27b']),
}));

// The fleet boundary — the createChat wiring reaches it via DYNAMIC import,
// which jest.mock intercepts.
const mockEnsure = jest.fn();
jest.mock('./platform/supervisor.service', () => ({
  __esModule: true,
  ensureFleetSupervisor: (...a: any[]) => mockEnsure(...a),
}));

// The User Space boundary (P3 §3 auto-filing) — createChat (null projectId)
// and updateChat (plain-chat null move) reach it via DYNAMIC import.
const mockEnsureUserSpace = jest.fn();
jest.mock('./platform/user-space.service', () => ({
  __esModule: true,
  ensureUserSpace: (...a: any[]) => mockEnsureUserSpace(...a),
}));

// Destination-project authorization — updateChat reaches platform.service's
// getProjectAccess via DYNAMIC import (cycle avoidance), which jest.mock
// intercepts too.
const mockGetProjectAccess = jest.fn();
jest.mock('./platform/platform.service', () => ({
  __esModule: true,
  getProjectAccess: (...a: any[]) => mockGetProjectAccess(...a),
}));

// listChats' dynamic-import boundaries (the capability + attention enrichment):
// the real modules pull the coding/agent graphs (config/redis → config/env →
// process.exit at import), so the seams are mocked per .digby/notes/learnings.md.
const mockGetChatCapability = jest.fn();
jest.mock('./coding/coding-data.service', () => ({
  __esModule: true,
  getChatCapability: (...a: any[]) => mockGetChatCapability(...a),
}));
const mockGetBusyChatIds = jest.fn();
const mockIsChatBusy = jest.fn(async (..._a: any[]): Promise<boolean> => false);
jest.mock('./chat-agent/chat-busy', () => ({
  __esModule: true,
  getBusyChatIds: (...a: any[]) => mockGetBusyChatIds(...a),
  // Ticket 5060c3d2: getChatById carries the SAME cross-process busy truth on
  // the single-chat read, so the open path can attach to a live run without
  // relying on local marks + a one-shot tri-state probe.
  isChatBusy: (...a: any[]) => mockIsChatBusy(...a),
}));
const mockGetPendingAttentionMap = jest.fn();
jest.mock('./coding/session-run-lock', () => ({
  __esModule: true,
  getPendingAttentionMap: (...a: any[]) => mockGetPendingAttentionMap(...a),
}));

// deleteChat's unified-memory cleanup (dynamic import) — the real module pulls
// the memory/env graph, so the seam is mocked like the other dynamic imports.
const mockMemReplaceRef = jest.fn(async (..._args: any[]) => ({}));
const mockMemClear = jest.fn(async (..._args: any[]) => undefined);
jest.mock('./memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: (...a: any[]) => mockMemReplaceRef(...a),
  memClear: (...a: any[]) => mockMemClear(...a),
}));
// deleteChat clears the chat's FK-less chat-keyed store rows (review 2026-10-23).
const mockStoreDeleteChatScoped = jest.fn(async (..._args: any[]) => 2);
jest.mock('./memory/context-store', () => ({
  __esModule: true,
  ...jest.requireActual('./memory/context-store'),
  storeDeleteChatScoped: (...a: any[]) => mockStoreDeleteChatScoped(...a),
}));

import crossModelService from './crossmodel.service';

/** Flush the fire-and-forget dynamic-import chain (microtasks + a macrotask). */
async function flushSideEffects(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsure.mockResolvedValue({ id: 'sup1' });
  // Archive scope (archive-scope.ts): no archived folders by default — the
  // hidden-project resolution short-circuits on its first empty query.
  mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
  // Auto-filing default: the owner's user space resolves (tests that care
  // override with mockResolvedValueOnce / mockResolvedValue + re-pin after).
  mockEnsureUserSpace.mockResolvedValue({ id: 'space-1', repoProvider: 'blank' });
  mockPrisma.crossModelChat.create.mockImplementation(async ({ select }: any) => ({
    id: 'chat-1',
    title: 'T',
    mode: 'thinking',
    projectId: 'proj-1',
    isSupervisor: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
});

describe('createChat — Fleet Supervisor ensure', () => {
  it('a chat created WITH a projectId ensures the global supervisor (fire-and-forget, no per-chat wiring)', async () => {
    const chat = await crossModelService.createChat('u1', 'My chat', 'thinking', 'proj-1');

    // The return value is immediate (shape unchanged, isSupervisor now selected).
    expect(chat).toMatchObject({ id: 'chat-1', messages: [], messageCount: 0, isSupervisor: false });

    await flushSideEffects();
    expect(mockEnsure).toHaveBeenCalledWith('u1');
    // An EXPLICIT folder never touches the user space (auto-filing is null-only).
    expect(mockEnsureUserSpace).not.toHaveBeenCalled();
  });

  it('a chat created WITHOUT a projectId ALSO ensures the supervisor — it watches the WHOLE fleet', async () => {
    await crossModelService.createChat('u1', 'Standalone', 'fast');
    await flushSideEffects();
    expect(mockEnsure).toHaveBeenCalledWith('u1');
  });

  // Supervision opt-out (owner 2026-09-13, ticket 3217e287): auto-provisioning
  // is gated on the filing project's `supervised` flag.
  it('a chat created in an UNSUPERVISED project does NOT ensure the supervisor (ticket 3217e287)', async () => {
    mockPrisma.crossModelChat.create.mockImplementationOnce(async () => ({
      id: 'chat-quiet',
      title: 'T',
      mode: 'thinking',
      projectId: 'proj-unsup',
      isSupervisor: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      project: { supervised: false },
    }));
    const chat = await crossModelService.createChat('u1', 'Quiet chat', 'thinking', 'proj-unsup');
    await flushSideEffects();
    expect(mockEnsure).not.toHaveBeenCalled();
    // The filing project's flag informed the gate but is stripped from the return.
    expect(chat).not.toHaveProperty('project');
    expect(chat).toMatchObject({ id: 'chat-quiet', projectId: 'proj-unsup' });
  });

  it('a chat created in a SUPERVISED project still ensures the supervisor', async () => {
    mockPrisma.crossModelChat.create.mockImplementationOnce(async () => ({
      id: 'chat-watched',
      title: 'T',
      mode: 'thinking',
      projectId: 'proj-sup',
      isSupervisor: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      project: { supervised: true },
    }));
    await crossModelService.createChat('u1', 'Watched chat', 'thinking', 'proj-sup');
    await flushSideEffects();
    expect(mockEnsure).toHaveBeenCalledWith('u1');
  });

  it('a supervisor-side-effect failure never rejects createChat', async () => {
    mockEnsure.mockRejectedValue(new Error('supervisor exploded'));
    await expect(crossModelService.createChat('u1', 'T', 'fast', 'proj-1')).resolves.toMatchObject({ id: 'chat-1' });
    await flushSideEffects(); // the rejection is swallowed by the fire-and-forget catch
  });
});

describe('createChat — User Space auto-filing (P3 §3)', () => {
  it('a chat created WITHOUT a projectId is filed into the owner\'s user space', async () => {
    await crossModelService.createChat('u1', 'Standalone', 'fast');

    expect(mockEnsureUserSpace).toHaveBeenCalledWith('u1');
    expect(mockPrisma.crossModelChat.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ project: { connect: { id: 'space-1' } } }),
      }),
    );
  });

  it('a user-space hiccup (null) leaves the chat UNFILED — creation never fails on it', async () => {
    mockEnsureUserSpace.mockResolvedValueOnce(null);
    await crossModelService.createChat('u1', 'Standalone', 'fast');

    const data = mockPrisma.crossModelChat.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('project');
  });
});

// ── updateChat project moves (Fleet-HQ re-homing) ────────────────────────────
//
// Every move with a non-null target FIRST authorizes the DESTINATION project
// via platform.service.getProjectAccess: the mover must be its owner or an
// editor/admin member (viewer or none → 404-shaped, no existence leak) —
// filing a chat into a project injects that project's systemPrompt + RAG scope
// and grants its editors write on the chat.
// A coding chat (ChatCodingState satellite) may then move ONLY into a plain
// folder (repoProvider NULL): the chat row AND the satellite's projectId flip
// in ONE transaction (the run path keys off the satellite; a chat-only flip
// would split-brain it). Moves to a workspace project (repoProvider set) or to
// null are refused 400. A failed satellite lookup rejects the WHOLE move —
// never degrades to a chat-only flip. A PLAIN chat's null move re-files into
// the owner's user space (P3 §3 — the disconnect path survives only as the
// ensure-hiccup fallback).

const OWNER = 'u-owner';
const CHAT = {
  id: 'chat-1', userId: OWNER, projectId: 'proj-repo', title: 'Fleet session',
  mode: 'thinking', isSupervisor: false,
  createdAt: new Date('2026-07-01'), updatedAt: new Date('2026-07-02'),
};

/** Wire the standard access fixtures: findUnique (access + full), member, messages. */
function mockChatAccess(chat: any, memberRole: string | null) {
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
    if (select?.userId && !select?.title) return { id: chat.id, userId: chat.userId, projectId: chat.projectId };
    return { ...chat };
  });
  mockPrisma.projectMember.findUnique.mockResolvedValue(memberRole ? { role: memberRole } : null);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.update.mockResolvedValue({ ...chat });
}

describe('updateChat — project moves (coding-chat re-homing)', () => {
  beforeEach(() => {
    mockChatAccess(CHAT, null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null); // default: plain chat
    mockPrisma.chatCodingState.update.mockResolvedValue({});
    mockPrisma.crossModelProject.findUnique.mockResolvedValue(null);
    // Default destination: a plain folder the mover OWNS (write access granted).
    mockGetProjectAccess.mockImplementation(async (projectId: string) => ({
      project: { id: projectId, repoProvider: null },
      role: 'owner',
    }));
  });

  it('coding chat → plain folder: succeeds, ONE transaction updates both rows', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: CHAT.id });

    const chat = await crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'fleet-hq' });

    expect(chat).toMatchObject({ id: CHAT.id });
    // Destination authorized through the ONE shared helper (no bare lookup).
    expect(mockGetProjectAccess).toHaveBeenCalledWith('fleet-hq', OWNER);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // Chat row: connect to the plain folder (sidebar filing + prompt/RAG scope).
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: CHAT.id },
      data: { project: { connect: { id: 'fleet-hq' } } },
    });
    // Satellite row: the coding engine's project pointer moves with it.
    expect(mockPrisma.chatCodingState.update).toHaveBeenCalledWith({
      where: { id: CHAT.id },
      data: { projectId: 'fleet-hq' },
    });
  });

  it('coding chat → workspace project (repoProvider set): 400, nothing written', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: CHAT.id });
    mockGetProjectAccess.mockResolvedValue({ project: { id: 'proj-2', repoProvider: 'github' }, role: 'owner' });

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'proj-2' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('re-key its repo') });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
  });

  it('coding chat → null: 400 (must stay filed in a folder), nothing written', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: CHAT.id });

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: null }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('must stay filed in a folder') });
    expect(mockGetProjectAccess).not.toHaveBeenCalled(); // no destination to authorize
    expect(mockEnsureUserSpace).not.toHaveBeenCalled(); // the null-400 fires BEFORE the user-space re-file
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('coding chat → missing target project: 404, nothing written', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: CHAT.id });
    mockGetProjectAccess.mockResolvedValue(null);

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'gone' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Project not found') });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('plain chat → project: destination authorized, then connect (no transaction)', async () => {
    await crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'proj-2' });

    expect(mockGetProjectAccess).toHaveBeenCalledWith('proj-2', OWNER);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: CHAT.id },
      data: { project: { connect: { id: 'proj-2' } } },
    });
  });

  it('plain chat → null: RE-FILES into the owner\'s user space (User Space §3 — "No folder (ungrouped)" IS the user space now)', async () => {
    await crossModelService.updateChat(CHAT.id, OWNER, { projectId: null });

    expect(mockEnsureUserSpace).toHaveBeenCalledWith(OWNER);
    expect(mockGetProjectAccess).not.toHaveBeenCalled(); // the owner's own space needs no destination authz
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: CHAT.id },
      data: { project: { connect: { id: 'space-1' } } },
    });
  });

  it('plain chat → null: a user-space hiccup (null) falls back to the legacy disconnect — the move never fails on it', async () => {
    mockEnsureUserSpace.mockResolvedValueOnce(null);
    await crossModelService.updateChat(CHAT.id, OWNER, { projectId: null });

    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: CHAT.id },
      data: { project: { disconnect: true } },
    });
  });

  it('non-owner with no membership: still rejected (404, no existence leak)', async () => {
    mockChatAccess({ ...CHAT, userId: 'someone-else' }, null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: CHAT.id });

    await expect(crossModelService.updateChat(CHAT.id, 'u-rando', { projectId: 'fleet-hq' }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('project editor (write, not owner): still rejected from moving (403)', async () => {
    mockChatAccess({ ...CHAT, userId: 'someone-else' }, 'editor');

    await expect(crossModelService.updateChat(CHAT.id, 'u-editor', { projectId: 'fleet-hq' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  // ── Framework-surface guard (ticket 9471d338) — the move_chat chokepoint ────
  // The Digby Framework project (repoUrl = the instance's own repo, here the
  // production slug) is the platform surface: NO chat may move INTO it and its
  // lanes may never move OUT of it. These run through the same updateChat seam
  // as every UI move and the move_chat tool; the probes read repoUrl off
  // prisma.crossModelProject.findUnique (the production identity leg).
  it('chat → framework project (repoUrl = own repo): 403, nothing written', async () => {
    mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) => (
      where?.id === 'fw-proj' ? { id: 'fw-proj', repoUrl: 'example-org/crossmodel' } : null
    ));

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'fw-proj' }))
      .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('Digby Framework') });
    expect(mockGetProjectAccess).not.toHaveBeenCalled(); // the guard fires BEFORE destination authz
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
  });

  it('a framework lane (chat filed in the framework project) cannot move OUT: 400, nothing written', async () => {
    mockChatAccess({ ...CHAT, projectId: 'fw-proj' }, null);
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'fw-proj', repoUrl: 'https://github.com/example-org/crossmodel' });

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'plain-2' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Framework lanes') });
    expect(mockGetProjectAccess).not.toHaveBeenCalled(); // refusal precedes destination work entirely
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
  });

  it('negative control: a plain repoUrl project still moves in freely (guard scoped to the framework row)', async () => {
    mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) => (
      where?.id === 'other-repo-proj' ? { id: 'other-repo-proj', repoUrl: 'example-org/schooltime' } : null
    ));

    await crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'other-repo-proj' });
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: CHAT.id },
      data: { project: { connect: { id: 'other-repo-proj' } } },
    });
  });
});

// ── getChatById — opt-in transcript paging (initial-load cap) ───────────────
//
// No `messageLimit` → legacy full-transcript load, unchanged apart from the
// ADDITIVE row id (no paging envelope keys, legacy asc/no-take query shape +
// id in the select — ticket 017f090b: feedback rows link back via messageId).
// With `messageLimit`: newest-N page, chronological within the page, +
// hasMoreMessages and a nextMessagesBefore envelope cursor (the oldest
// RETURNED message id). Paged message DTOs additionally carry the row id
// (unified plain-view transcript keys — One-Session P2 flip blocker M4).
// `messagesBefore` validates the cursor belongs to THIS chat (400 otherwise)
// and filters createdAt < cursor.createdAt.

const t = (s: number) => new Date(`2026-08-01T00:00:0${s}.000Z`);
const msgRow = (id: string, createdAt: Date) => ({
  id, role: 'user', content: `msg ${id}`, metadata: null, parts: null, createdAt,
});

// ── updateChat lead-model override (WI-O #4c) ────────────────────────────────
describe('updateChat — per-chat lead model (WI-O #4c)', () => {
  beforeEach(() => {
    mockChatAccess(CHAT, null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null); // default: plain chat
  });

  it('a pick the Digby seat offers persists on the chat row (write access: owner)', async () => {
    await crossModelService.updateChat(CHAT.id, OWNER, { leadModel: 'deepseek-flash' });
    expect(mockResolveChatLeadPick).toHaveBeenCalledWith('deepseek-flash', OWNER);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: CHAT.id }, data: { leadModel: 'deepseek-flash' } });
  });

  it("'' and null CLEAR the override (stored as null) without consulting the validator", async () => {
    await crossModelService.updateChat(CHAT.id, OWNER, { leadModel: '' });
    expect(mockPrisma.crossModelChat.update).toHaveBeenLastCalledWith({ where: { id: CHAT.id }, data: { leadModel: null } });
    await crossModelService.updateChat(CHAT.id, OWNER, { leadModel: null });
    expect(mockPrisma.crossModelChat.update).toHaveBeenLastCalledWith({ where: { id: CHAT.id }, data: { leadModel: null } });
    expect(mockResolveChatLeadPick).not.toHaveBeenCalled();
  });

  it('a pick the seat does not offer is refused 400 naming the offered built-ins; nothing written', async () => {
    await expect(crossModelService.updateChat(CHAT.id, OWNER, { leadModel: 'gpt-9' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('kimi-k3 / glm-5.3 / deepseek-flash') });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('a supervisor chat refuses the override (its seat is platform-managed)', async () => {
    mockChatAccess({ ...CHAT, isSupervisor: true }, null);
    await expect(crossModelService.updateChat(CHAT.id, OWNER, { leadModel: 'deepseek-flash' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('platform seat') });
    mockChatAccess({ ...CHAT, isProjectSupervisor: true }, null);
    await expect(crossModelService.updateChat(CHAT.id, OWNER, { leadModel: 'deepseek-flash' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('a coding session refuses the override (set_session_model owns the satellite model)', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: CHAT.id });
    await expect(crossModelService.updateChat(CHAT.id, OWNER, { leadModel: 'deepseek-flash' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('set_session_model') });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });
});

describe('getChatById — live run truth (ticket 5060c3d2)', () => {
  beforeEach(() => {
    mockChatAccess(CHAT, null);
    mockIsChatBusy.mockResolvedValue(false);
  });

  // Owner report: "when i leave a chat and come back mid response i dont see
  // the current progress". The open path had only LOCAL marks (dead after the
  // unmount) plus ONE one-shot probe whose tri-state `null` means UNKNOWN — so
  // a fresh tab / hard reload during a run rendered a settled chat with no
  // spinner and no answer. The chat GET is the one round trip the view always
  // makes, so it must carry the same cross-process busy truth listChats ships.

  it('reports running:true on the PAGED shape (the shape the unified view uses) when a run is live', async () => {
    mockIsChatBusy.mockResolvedValue(true);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m1', t(1))]);

    const chat: any = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 50 });

    expect(mockIsChatBusy).toHaveBeenCalledWith(CHAT.id);
    expect(chat.running).toBe(true);
  });

  it('reports running:false on the paged shape when nothing is answering', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m1', t(1))]);

    const chat: any = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 50 });

    expect(chat.running).toBe(false);
  });

  it('reports running on the LEGACY (unpaged) shape too — both returns carry it', async () => {
    mockIsChatBusy.mockResolvedValue(true);

    const chat: any = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(chat.running).toBe(true);
    // Still the legacy shape: no paging envelope keys.
    expect(chat).not.toHaveProperty('hasMoreMessages');
  });

  it('a liveness hiccup degrades to running:false instead of failing the whole GET', async () => {
    // Best-effort discipline, same as every other busy read: a Redis/DB
    // hiccup must never 500 a transcript fetch — the chat simply reads idle.
    mockIsChatBusy.mockRejectedValue(new Error('redis down'));
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m1', t(1))]);

    const chat: any = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 50 });

    expect(chat.running).toBe(false);
    expect(chat.messages.map((m: any) => m.id)).toEqual(['m1']); // transcript intact
  });
});

describe('getChatById — transcript paging', () => {
  beforeEach(() => {
    mockChatAccess(CHAT, null); // owner access; message findMany defaults to []
  });

  it('default (no paging): returns ALL messages, NO paging envelope keys, legacy query shape', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m1', t(1)), msgRow('m2', t(2)), msgRow('m3', t(3))]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(chat.messages.map((m) => m.content)).toEqual(['msg m1', 'msg m2', 'msg m3']);
    // Additive (ticket 017f090b): legacy DTOs now carry the row id too.
    expect(chat.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(chat).not.toHaveProperty('hasMoreMessages');
    expect(chat).not.toHaveProperty('nextMessagesBefore');
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { chatId: CHAT.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true, updatedAt: true },
    });
    expect(mockPrisma.crossModelMessage.findUnique).not.toHaveBeenCalled(); // no cursor lookup
  });

  it('maps updatedAt into message DTOs when set, omits it when null (ticket 68916075)', async () => {
    // Coding-run assistant rows are INSERTed at run start and rewritten in place
    // through finalize — the DTO exposes the last-write stamp (≈ finalize) so
    // readers can tell it apart from insert-time createdAt (never restamped).
    const openedAt = t(1);
    const finalizedAt = new Date('2026-08-01T01:22:00.000Z');
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { ...msgRow('m1', openedAt), updatedAt: finalizedAt },
      { ...msgRow('m2', t(2)), updatedAt: null }, // row predating the field
    ]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect((chat.messages[0] as any).updatedAt).toBe(finalizedAt.toISOString());
    expect(chat.messages[0].timestamp).toBe(openedAt.toISOString()); // ordering contract intact
    expect(chat.messages[1]).not.toHaveProperty('updatedAt');
  });

  it('messageLimit=2 over 3 rows: NEWEST 2 chronologically + hasMoreMessages + cursor = oldest returned id', async () => {
    // The (mocked) DB honors desc + take(limit+1): all 3 rows, newest first —
    // the 3rd row is the hasMore probe and is NOT returned.
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m3', t(3)), msgRow('m2', t(2)), msgRow('m1', t(1))]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 2 });

    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { chatId: CHAT.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true, updatedAt: true },
    });
    expect(chat.messages.map((m) => m.content)).toEqual(['msg m2', 'msg m3']); // chronological within page
    expect((chat as any).hasMoreMessages).toBe(true);
    expect((chat as any).nextMessagesBefore).toBe('m2');
    // Paged DTOs carry the row id (unified plain view keys — flip blocker M4);
    // the legacy branch carries ids too since ticket 017f090b (additive).
    expect(chat.messages.map((m: any) => m.id)).toEqual(['m2', 'm3']);
  });

  it('messagesBefore cursor: validates it, filters with a COMPOUND (createdAt, id) cursor, pages to older rows', async () => {
    const cursorDate = t(3);
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ chatId: CHAT.id, createdAt: cursorDate });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m2', t(2)), msgRow('m1', t(1))]); // desc, no probe row

    const chat = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 2, messagesBefore: 'cursor-id' });

    expect(mockPrisma.crossModelMessage.findUnique).toHaveBeenCalledWith({
      where: { id: 'cursor-id' },
      select: { chatId: true, createdAt: true },
    });
    // Compound cursor mirroring the [createdAt desc, id desc] sort — the
    // (createdAt = cursor, id < cursor) arm keeps a row that shares the
    // cursor's millisecond reachable (a plain `lt` strands it in NO page).
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: {
        chatId: CHAT.id,
        OR: [
          { createdAt: { lt: cursorDate } },
          { createdAt: cursorDate, id: { lt: 'cursor-id' } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true, updatedAt: true },
    });
    expect(chat.messages.map((m) => m.content)).toEqual(['msg m1', 'msg m2']);
    expect((chat as any).hasMoreMessages).toBe(false); // exactly limit rows → no probe row → no older page
    expect(chat).not.toHaveProperty('nextMessagesBefore');
  });

  it('a row TIED at the cursor timestamp (same createdAt, lower id) is returned by the next page', async () => {
    // m3a and m3b share t(3) (drain handoffs can write two rows in the same
    // ms); the cursor is m3b, so m3a must come back in the older page via the
    // id-tiebreak arm — before the compound cursor it was permanently skipped.
    const tied = t(3);
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ chatId: CHAT.id, createdAt: tied });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m3a', tied), msgRow('m2', t(2))]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 2, messagesBefore: 'm3b' });

    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId: CHAT.id,
          OR: [
            { createdAt: { lt: tied } },
            { createdAt: tied, id: { lt: 'm3b' } },
          ],
        },
      }),
    );
    expect(chat.messages.map((m) => m.content)).toEqual(['msg m2', 'msg m3a']);
  });

  it('a cursor belonging to a DIFFERENT chat → 400 AppError, no transcript query', async () => {
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ chatId: 'someone-elses-chat', createdAt: t(3) });

    await expect(crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 2, messagesBefore: 'foreign-id' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'Invalid before cursor for this chat' });
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('a cursor that does not exist → 400 AppError, no transcript query', async () => {
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue(null);

    await expect(crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 2, messagesBefore: 'gone-id' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'Invalid before cursor for this chat' });
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });
});

// ── getChatById pending-messages enrichment (ticket c0b2b0c8) ────────────────
//
// A queued user message (sent while a run was active) persists as a
// pendingChatMessage row with source 'user' and is delivered INTO the active
// run as a steer. Before this fix, a transcript reload DROPPED the queued
// bubble: the client re-rendered only persisted crossmodel_messages, while
// the queue lived server-side. getChatById now enriches BOTH return paths
// (legacy full load and paged load) with `pendingMessages` — the user-source
// rows only (an agent's send_chat_message enqueue is NOT a human bubble),
// ids prefixed `pending-` (no collision with row ids or the view's local
// tmp-*/steer-* echo ids). Fail-open: an enrichment hiccup returns [] and the
// transcript still loads (pre-fix behaviour).
describe('getChatById — pendingMessages enrichment (c0b2b0c8)', () => {
  const pendRow = (id: string, content: string, createdAt: Date, mode: any = null) => ({
    id, content, mode, createdAt,
  });

  beforeEach(() => {
    mockChatAccess(CHAT, null); // owner access; message findMany defaults to []
  });

  it('legacy full load: user-source pending rows ride along as pendingMessages (pending- ids)', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m1', t(1))]);
    const when = new Date('2026-08-01T00:00:09.000Z');
    mockPrisma.pendingChatMessage.findMany.mockResolvedValue([
      pendRow('pq1', 'queued while busy', when),
    ]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(mockPrisma.pendingChatMessage.findMany).toHaveBeenCalledWith({
      where: { chatId: CHAT.id, source: 'user' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, content: true, mode: true, createdAt: true },
    });
    expect(chat.pendingMessages).toEqual([
      { id: 'pending-pq1', role: 'user', content: 'queued while busy', timestamp: when.toISOString(), pending: true },
    ]);
    // The persisted transcript itself is untouched — pending rows are additive.
    expect(chat.messages.map((m) => m.content)).toEqual(['msg m1']);
  });

  it('paged load: pendingMessages ride along too (queue is chat-scoped, not page-scoped)', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m3', t(3)), msgRow('m2', t(2))]);
    const when = new Date('2026-08-01T00:00:09.000Z');
    mockPrisma.pendingChatMessage.findMany.mockResolvedValue([
      pendRow('pq1', 'first queued', when),
      pendRow('pq2', 'second queued', new Date('2026-08-01T00:00:10.000Z')),
    ]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 2 });

    expect(chat.messages.map((m) => m.content)).toEqual(['msg m2', 'msg m3']); // page unchanged
    expect(chat.pendingMessages?.map((m) => m.id)).toEqual(['pending-pq1', 'pending-pq2']); // oldest-first
    expect(chat.pendingMessages?.map((m) => m.content)).toEqual(['first queued', 'second queued']);
  });

  it('user-source ONLY: the where-clause pins source user — agent/webhook enqueues never render as human bubbles', async () => {
    // The mock returns whatever we give it; the CONTRACT is the query shape.
    mockPrisma.pendingChatMessage.findMany.mockResolvedValue([]);

    await crossModelService.getChatById(CHAT.id, OWNER);

    expect(mockPrisma.pendingChatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId: CHAT.id, source: 'user' } }),
    );
  });

  it('empty queue: no pendingMessages key at all (legacy payload stays byte-identical)', async () => {
    mockPrisma.pendingChatMessage.findMany.mockResolvedValue([]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(chat).not.toHaveProperty('pendingMessages');
  });

  it('fail-open: an enrichment hiccup returns NO pendingMessages and the transcript still loads', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m1', t(1))]);
    mockPrisma.pendingChatMessage.findMany.mockRejectedValue(new Error('pending table unavailable'));

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(chat.messages.map((m) => m.content)).toEqual(['msg m1']);
    expect(chat).not.toHaveProperty('pendingMessages'); // fail-open, not a 500
  });
});

// ── getChatById messageAuthors resolution (ticket f89d1213) ─────────────────
//
// Shared-project chats: user rows persisted since the ticket carry
// metadata.authorId (the real sender). getChatById resolves the DISTINCT
// stamped ids into display names in ONE batched users query — never an N+1 —
// and returns them as the ADDITIVE `messageAuthors` field so the frontend can
// label teammate messages ("From: <name>"). Legacy chats (no stamps) trigger
// NO users query and keep their exact payload shape; a lookup failure degrades
// to no map (the transcript must still load).

describe('getChatById — messageAuthors resolution (f89d1213)', () => {
  const stamped = (content: string, authorId: string, createdAt: Date) => ({
    role: 'user', content, metadata: { authorId }, parts: null, createdAt,
  });

  beforeEach(() => {
    mockChatAccess(CHAT, null); // owner access
  });

  it('stamped user rows → ONE batched users query (distinct ids, NO email) + the additive map', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      stamped('mine', 'u-owner', t(1)),
      stamped('teammate msg', 'u-editor', t(2)),
      stamped('teammate again', 'u-editor', t(3)), // duplicate id — must dedupe
      { role: 'assistant', content: 'an answer', metadata: { models: {} }, parts: null, createdAt: t(4) },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'u-owner', name: 'Paul C', firstName: null, lastName: null },
      { id: 'u-editor', name: null, firstName: 'Edna', lastName: 'Editor' }, // name falls back to first+last
    ]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['u-owner', 'u-editor'] } },
      select: { id: true, name: true, firstName: true, lastName: true }, // email intentionally never selected
    });
    expect((chat as any).messageAuthors).toEqual({ 'u-owner': 'Paul C', 'u-editor': 'Edna Editor' });
    // The rows themselves still carry their metadata stamp for the frontend.
    expect((chat.messages[1] as any).metadata).toEqual({ authorId: 'u-editor' });
  });

  it('legacy chat (no stamps): NO users query and NO messageAuthors key — payload shape unchanged', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([msgRow('m1', t(1))]); // metadata: null

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(chat).not.toHaveProperty('messageAuthors');
  });

  it('a users-lookup failure degrades to no map — the transcript still loads', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([stamped('x', 'u-editor', t(1))]);
    mockPrisma.user.findMany.mockRejectedValue(new Error('db down'));

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(chat.messages).toHaveLength(1);
    expect(chat).not.toHaveProperty('messageAuthors');
  });

  it('the PAGED branch resolves the map for its page too', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { id: 'm2', role: 'user', content: 'newer', metadata: { authorId: 'u-editor' }, parts: null, createdAt: t(2) },
      { id: 'm1', role: 'user', content: 'older', metadata: null, parts: null, createdAt: t(1) },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u-editor', name: 'Edna', firstName: null, lastName: null }]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 2 });

    expect((chat as any).messageAuthors).toEqual({ 'u-editor': 'Edna' });
  });
});

// ── getChatById attachment-chip fileId injection (ticket c6e8edda) ──────────
//
// User-row chips (metadata.attachments) stamped at send time carry the staged
// uploadId; the durable ChatFile row (persisted at consumption) holds the
// bytes. getChatById joins them at read time — ONE batched chat_files query,
// fully guarded on malformed metadata, NEW metadata objects — so image chips
// can render inline. Chips without an uploadId or without a ChatFile match
// pass through unchanged; legacy transcripts (no stamps) cost ZERO queries;
// a lookup failure must never fail the transcript load.

describe('getChatById — attachment chip fileId injection (c6e8edda)', () => {
  const chipped = (id: string, attachments: any, createdAt: Date) => ({
    id, role: 'user', content: `msg ${id}`, metadata: { attachments }, parts: null, createdAt,
  });

  beforeEach(() => {
    mockChatAccess(CHAT, null); // owner access
    mockPrisma.chatFile.findMany.mockResolvedValue([]);
  });

  it('matching chips gain fileId + mimeType via ONE batched, deduped query (legacy path)', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      chipped('m1', [{ filename: 'a.png', type: 'image', uploadId: 'up-1' }], t(1)),
      chipped('m2', [
        { filename: 'b.png', type: 'image', uploadId: 'up-2' },
        { filename: 'a2.png', type: 'image', uploadId: 'up-1' }, // duplicate id — deduped in the query
      ], t(2)),
    ]);
    mockPrisma.chatFile.findMany.mockResolvedValue([
      { id: 'file-1', uploadId: 'up-1', mimeType: 'image/png' },
      { id: 'file-2', uploadId: 'up-2', mimeType: 'image/webp' },
    ]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(mockPrisma.chatFile.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatFile.findMany).toHaveBeenCalledWith({
      where: { chatId: CHAT.id, uploadId: { in: ['up-1', 'up-2'] } },
      select: { id: true, uploadId: true, mimeType: true },
    });
    expect((chat.messages[0] as any).metadata.attachments).toEqual([
      { filename: 'a.png', type: 'image', uploadId: 'up-1', fileId: 'file-1', mimeType: 'image/png' },
    ]);
    expect((chat.messages[1] as any).metadata.attachments).toEqual([
      { filename: 'b.png', type: 'image', uploadId: 'up-2', fileId: 'file-2', mimeType: 'image/webp' },
      { filename: 'a2.png', type: 'image', uploadId: 'up-1', fileId: 'file-1', mimeType: 'image/png' },
    ]);
  });

  it('a chip WITHOUT a ChatFile match (or without an uploadId) passes through unchanged', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      chipped('m1', [
        { filename: 'expired.png', type: 'image', uploadId: 'up-gone' },
        { filename: 'legacy.png', type: 'image' }, // pre-c6e8edda chip — no uploadId
      ], t(1)),
    ]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(mockPrisma.chatFile.findMany).toHaveBeenCalledTimes(1); // up-gone collected
    expect((chat.messages[0] as any).metadata.attachments).toEqual([
      { filename: 'expired.png', type: 'image', uploadId: 'up-gone' },
      { filename: 'legacy.png', type: 'image' },
    ]);
  });

  it('malformed metadata (non-array attachments, non-object chips) is left byte-identical', async () => {
    const weirdMeta = { attachments: 'not-an-array' };
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { id: 'm1', role: 'user', content: 'x', metadata: weirdMeta, parts: null, createdAt: t(1) },
      { id: 'm2', role: 'user', content: 'y', metadata: { attachments: [null, 42, { filename: 'ok.png', type: 'image', uploadId: 'up-1' }] }, parts: null, createdAt: t(2) },
    ]);
    mockPrisma.chatFile.findMany.mockResolvedValue([{ id: 'file-1', uploadId: 'up-1', mimeType: 'image/png' }]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect((chat.messages[0] as any).metadata).toEqual({ attachments: 'not-an-array' });
    expect((chat.messages[1] as any).metadata.attachments).toEqual([
      null, 42, { filename: 'ok.png', type: 'image', uploadId: 'up-1', fileId: 'file-1', mimeType: 'image/png' },
    ]);
  });

  it('legacy transcripts (no uploadId stamps anywhere) cost ZERO chat_files queries', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      msgRow('m1', t(1)), // metadata: null
      chipped('m2', [{ filename: 'old.png', type: 'image' }], t(2)), // chip without uploadId
    ]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(mockPrisma.chatFile.findMany).not.toHaveBeenCalled();
    expect((chat.messages[1] as any).metadata.attachments).toEqual([{ filename: 'old.png', type: 'image' }]);
  });

  it('the injection does NOT mutate the loaded rows — message DTOs get NEW metadata objects', async () => {
    const storedMeta = { attachments: [{ filename: 'a.png', type: 'image', uploadId: 'up-1' }], origin: 'user' };
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { id: 'm1', role: 'user', content: 'x', metadata: storedMeta, parts: null, createdAt: t(1) },
    ]);
    mockPrisma.chatFile.findMany.mockResolvedValue([{ id: 'file-1', uploadId: 'up-1', mimeType: 'image/png' }]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    // The Prisma-loaded metadata object is untouched (no fileId on it)…
    expect(storedMeta.attachments[0]).toEqual({ filename: 'a.png', type: 'image', uploadId: 'up-1' });
    // …and the DTO carries a NEW metadata object with the injection.
    const dtoMeta = (chat.messages[0] as any).metadata;
    expect(dtoMeta).not.toBe(storedMeta);
    expect(dtoMeta.origin).toBe('user'); // sibling keys preserved
    expect(dtoMeta.attachments[0].fileId).toBe('file-1');
  });

  it('the PAGED branch injects for its page too', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      chipped('m2', [{ filename: 'b.png', type: 'image', uploadId: 'up-2' }], t(2)),
      chipped('m1', [{ filename: 'a.png', type: 'image', uploadId: 'up-1' }], t(1)),
    ]);
    mockPrisma.chatFile.findMany.mockResolvedValue([
      { id: 'file-1', uploadId: 'up-1', mimeType: 'image/png' },
      { id: 'file-2', uploadId: 'up-2', mimeType: 'image/png' },
    ]);

    const chat = await crossModelService.getChatById(CHAT.id, OWNER, 'read', { messageLimit: 2 });

    expect(mockPrisma.chatFile.findMany).toHaveBeenCalledTimes(1);
    expect((chat.messages[0] as any).metadata.attachments[0].fileId).toBe('file-1');
    expect((chat.messages[1] as any).metadata.attachments[0].fileId).toBe('file-2');
  });

  it('a chat_files lookup failure degrades to unstamped chips — the transcript still loads', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      chipped('m1', [{ filename: 'a.png', type: 'image', uploadId: 'up-1' }], t(1)),
    ]);
    mockPrisma.chatFile.findMany.mockRejectedValue(new Error('db down'));

    const chat = await crossModelService.getChatById(CHAT.id, OWNER);

    expect(chat.messages).toHaveLength(1);
    expect((chat.messages[0] as any).metadata.attachments).toEqual([
      { filename: 'a.png', type: 'image', uploadId: 'up-1' },
    ]);
  });
});

// ── updateChat destination-project authorization (audit P1) ─────────────────
//
// The mover owning the CHAT is not enough: without write access on the TARGET
// project, a move would pull the target's [KNOWLEDGE BASE] / systemPrompt into
// the mover's queries and grant the target's editors write on the chat.

describe('updateChat — destination-project authorization', () => {
  beforeEach(() => {
    mockChatAccess(CHAT, null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
    mockPrisma.chatCodingState.update.mockResolvedValue({});
    mockPrisma.crossModelProject.findUnique.mockResolvedValue(null);
  });

  it("move into another user's project (no membership): 404-shaped, nothing written", async () => {
    mockGetProjectAccess.mockResolvedValue(null); // stranger — access helper hides existence

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'victims-folder' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Project not found') });
    expect(mockGetProjectAccess).toHaveBeenCalledWith('victims-folder', OWNER);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('coding chat into an inaccessible project: 404 BEFORE any satellite/repo-key logic', async () => {
    mockGetProjectAccess.mockResolvedValue(null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: CHAT.id });

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'victims-folder' }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.chatCodingState.findUnique).not.toHaveBeenCalled(); // auth gate fires first
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('destination VIEWER member: 404-shaped rejection (read access is not filing access)', async () => {
    mockGetProjectAccess.mockResolvedValue({ project: { id: 'shared', repoProvider: null }, role: 'viewer' });

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'shared' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('insufficient permissions') });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('destination EDITOR member: allowed (write access on the target, sharing semantics)', async () => {
    mockGetProjectAccess.mockResolvedValue({ project: { id: 'team-folder', repoProvider: null }, role: 'editor' });

    const chat = await crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'team-folder' });

    expect(chat).toMatchObject({ id: CHAT.id });
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: CHAT.id },
      data: { project: { connect: { id: 'team-folder' } } },
    });
  });

  it('satellite lookup failure: the WHOLE move rejects — never degrades to a chat-only flip', async () => {
    mockGetProjectAccess.mockResolvedValue({ project: { id: 'fleet-hq', repoProvider: null }, role: 'owner' });
    mockPrisma.chatCodingState.findUnique.mockRejectedValue(new Error('connection pool timeout'));

    await expect(crossModelService.updateChat(CHAT.id, OWNER, { projectId: 'fleet-hq' }))
      .rejects.toThrow('connection pool timeout');
    // The chat row must NOT move while the satellite state is unknown.
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ── listChats — hasActiveSchedule sidebar flag ────────────────────────────────
//
// The sidebar's schedule indicator is merged into the chat-list serializer via
// ONE batched chatSchedule.groupBy over the page's chat ids (the chat list is
// a hot path — never a per-chat query). True only for chats with an ENABLED
// schedule row; a lookup failure degrades every row to false (never a 500).

describe('listChats — hasActiveSchedule sidebar flag', () => {
  const CHAT_ROW = (id: string) => ({
    id,
    title: `Chat ${id}`,
    mode: 'thinking',
    projectId: null,
    isSupervisor: false,
    userId: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { chatMessages: 0 },
    chatMessages: [],
  });

  beforeEach(() => {
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([CHAT_ROW('c1'), CHAT_ROW('c2'), CHAT_ROW('c3')]);
    mockPrisma.crossModelChat.count.mockResolvedValue(3);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    mockGetChatCapability.mockResolvedValue({ codeCapable: false, hasWorkspaceState: false });
    mockGetBusyChatIds.mockResolvedValue(new Set<string>());
    mockGetPendingAttentionMap.mockResolvedValue(new Map());
  });

  it('true only for chats with an ENABLED schedule — ONE batched groupBy, no N+1', async () => {
    mockPrisma.chatSchedule.groupBy.mockResolvedValue([{ sessionId: 'c2' }]);

    const r = await crossModelService.listChats('u1', 1, 20);

    expect(mockPrisma.chatSchedule.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatSchedule.groupBy).toHaveBeenCalledWith({
      by: ['sessionId'],
      where: { sessionId: { in: ['c1', 'c2', 'c3'] }, enabled: true },
    });
    const flagById = new Map(r.chats.map((c: any) => [c.id, c.hasActiveSchedule]));
    expect(flagById.get('c1')).toBe(false);
    expect(flagById.get('c2')).toBe(true);
    expect(flagById.get('c3')).toBe(false);
  });

  it('a schedule-lookup failure degrades every chat to false (the list never 500s on it)', async () => {
    mockPrisma.chatSchedule.groupBy.mockRejectedValue(new Error('db hiccup'));

    const r = await crossModelService.listChats('u1', 1, 20);

    expect(r.chats).toHaveLength(3);
    expect(r.chats.every((c: any) => c.hasActiveSchedule === false)).toBe(true);
  });
});

// ── listChats ↔ getChatAccess — visibility-scope parity (feedback 23783c5b) ──
//
// A fleet supervisor 404'd on get/send for four chats it believed list_chats had
// shown it, and filed "list/get/send appear to use different visibility scopes".
// They do NOT: listChats' WHERE is exactly { caller's own chats } ∪ { chats in
// projects the caller is a member of (any role) } — feed-backed chats included
// (listed like any own chat since b6ce8490) — and
// getChatAccess grants owner/read/write on precisely the same relationship
// (owner → owner; project editor/admin → write; viewer → read; else none). The
// incident ids were mis-transcribed (phantom-id class — a fresh live probe 404s
// all four for the owner). This block PINS the invariant: the where-clause
// evaluator below throws on ANY unknown key/operator, so a future scope source
// added to one path without the other fails loudly instead of drifting.

describe('listChats ↔ getChatAccess — visibility-scope parity (feedback 23783c5b)', () => {
  const ROW = (id: string, userId: string, projectId: string | null, feed: { id: string } | null = null, archivedAt: Date | null = null) => ({
    id,
    title: `Chat ${id}`,
    mode: 'thinking',
    projectId,
    isSupervisor: false,
    userId,
    archivedAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    feed,
    _count: { chatMessages: 0 },
    chatMessages: [],
  });
  // Every visibility shape: own solo / own in member project / member project as
  // viewer / member project as editor / NON-member project / someone else's solo
  // / own but feed-backed (LISTED since b6ce8490 — the retired sidebar
  // "Feeds" section used to hide it; pinned at the b6ce8490 regression test below)
  // / own but ARCHIVED / own inside an ARCHIVED folder (archive-scope hiding).
  const CHATS = [
    ROW('own-solo', 'u1', null),
    ROW('own-in-p1', 'u1', 'p1'),
    ROW('other-p1-viewer', 'u2', 'p1'),
    ROW('other-p2-editor', 'u2', 'p2'),
    ROW('other-p3-none', 'u2', 'p3'),
    ROW('other-solo', 'u3', null),
    ROW('own-feed', 'u1', null, { id: 'f1' }),
    ROW('own-archived', 'u1', null, null, new Date('2026-09-08')),
    ROW('own-in-archived-p4', 'u1', 'p4'), // NOT stamped — hidden via its archived folder
  ];
  const MEMBERSHIPS: Record<string, string> = { p1: 'viewer', p2: 'editor' };
  // p4 is an ARCHIVED folder owned by u1 (archive-scope's hidden set).
  const ARCHIVED_PROJECTS = [{ id: 'p4', path: '/p4' }];

  // Prisma-semantics evaluation of listChats' WHERE clause against a fixture row
  // — for EXACTLY the operators listChats emits today (visibility OR, archive
  // exclusions, and the q/projectId/mode sibling narrowers). Unknown key
  // or operator ⇒ throw: the scope drifted, re-audit this parity test. (The
  // feeds retirement removed listChats' feed exclusion — feed chats list like
  // any own chat (b6ce8490) — so a `feed` key here is drift, not a supported
  // operator; the own-feed fixture row above pins its inclusion.)
  const evalWhere = (row: any, where: any): boolean => {
    for (const [key, cond] of Object.entries<any>(where)) {
      if (key === 'OR') {
        if (!Array.isArray(cond) || !cond.some((branch) => evalWhere(row, branch))) return false;
      } else if (key === 'AND') {
        if (!Array.isArray(cond) || !cond.every((branch) => evalWhere(row, branch))) return false;
      } else if (key === 'archivedAt') {
        // Archive exclusion (owner 2026-09-08): default lists emit null;
        // the Archived view emits { not: null }.
        if (cond === null) {
          if (row.archivedAt !== null) return false;
        } else if (cond && typeof cond === 'object' && Object.keys(cond).join(',') === 'not' && cond.not === null) {
          if (row.archivedAt === null) return false;
        } else {
          throw new Error(`unknown archivedAt operator: ${JSON.stringify(cond)} — scope drifted, re-audit parity`);
        }
      } else if (key === 'userId') {
        if (row.userId !== cond) return false;
      } else if (key === 'projectId') {
        if (cond && typeof cond === 'object' && 'in' in cond) {
          if (!cond.in.includes(row.projectId)) return false;
        } else if (cond && typeof cond === 'object' && 'notIn' in cond) {
          // Prisma notIn — the archive-scope hidden-folder exclusion.
          if (cond.notIn.includes(row.projectId)) return false;
        } else if (row.projectId !== cond) return false;
      } else if (key === 'title') {
        if (!cond || typeof cond !== 'object' || typeof cond.contains !== 'string') {
          throw new Error(`unknown title operator: ${JSON.stringify(cond)} — scope drifted, re-audit parity`);
        }
        if (!String(row.title).toLowerCase().includes(cond.contains.toLowerCase())) return false;
      } else if (key === 'mode') {
        if (row.mode !== cond) return false;
      } else if (key === 'updatedAt') {
        // Delta watermark (d6b2eef5 / 6201e0ee): gte against the row's stamp.
        if (!cond || typeof cond !== 'object' || Object.keys(cond).join(',') !== 'gte') {
          throw new Error(`unknown updatedAt operator: ${JSON.stringify(cond)} — scope drifted, re-audit parity`);
        }
        if (!(row.updatedAt >= cond.gte)) return false;
      } else {
        throw new Error(`unknown where-clause key "${key}" — visibility scope drifted, re-audit parity`);
      }
    }
    return true;
  };

  beforeEach(() => {
    mockPrisma.projectMember.findMany.mockResolvedValue([{ projectId: 'p1' }, { projectId: 'p2' }]);
    // archive-scope's two queries: archived roots (where.archivedAt present),
    // then subtree expansion (path startsWith — none here, p4 has no children).
    mockPrisma.crossModelProject.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.archivedAt ? ARCHIVED_PROJECTS : []));
    mockPrisma.crossModelChat.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(CHATS.filter((row) => evalWhere(row, where))));
    mockPrisma.crossModelChat.count.mockImplementation(({ where }: any) =>
      Promise.resolve(CHATS.filter((row) => evalWhere(row, where)).length));
    mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(CHATS.find((row) => row.id === where.id) ?? null));
    mockPrisma.projectMember.findUnique.mockImplementation(({ where }: any) => {
      const { projectId, userId } = where.projectId_userId;
      const role = userId === 'u1' ? MEMBERSHIPS[projectId] : undefined;
      return Promise.resolve(role ? { role } : null);
    });
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    mockPrisma.chatSchedule.groupBy.mockResolvedValue([]);
    mockGetChatCapability.mockResolvedValue({ codeCapable: false, hasWorkspaceState: false });
    mockGetBusyChatIds.mockResolvedValue(new Set<string>());
    mockGetPendingAttentionMap.mockResolvedValue(new Map());
  });

  it('listChats returns exactly the chats getChatAccess grants on (own + any-role member projects), minus archived chats; feed chats ARE listed (b6ce8490)', async () => {
    const listed: string[] = (await crossModelService.listChats('u1', 1, 50)).chats.map((c: any) => c.id).sort();

    const hiddenProjectIds = new Set(ARCHIVED_PROJECTS.map((p) => p.id));
    const expected: string[] = [];
    for (const chat of CHATS) {
      const { access } = await crossModelService.getChatAccess(chat.id, 'u1');
      // The ONE intentional divergence: archived chats (own stamp OR archived
      // folder) leave the default list for the Archived view. Feed-backed
      // chats used to be the second divergence (1c0341d57 delegated them to a
      // sidebar "Feeds" section) — retired: that section no longer exists, so
      // they list like any own chat (b6ce8490: the chat an agent JUST created
      // was invisible to its owner).
      const archived = chat.archivedAt !== null || (chat.projectId !== null && hiddenProjectIds.has(chat.projectId));
      if (access !== 'none' && !archived) expected.push(chat.id);
    }
    expect(listed).toEqual(expected.sort());
    expect(listed).toEqual(['other-p1-viewer', 'other-p2-editor', 'own-feed', 'own-in-p1', 'own-solo']);
  });

  it('archive divergence: archived chats stay owner-accessible (never tombstoned) but leave the default list; ?archived=true lists ONLY own stamped chats', async () => {
    // Direct-id access survives archival — restore views and old links work.
    await expect(crossModelService.getChatAccess('own-archived', 'u1')).resolves.toEqual({ access: 'owner', exists: true });
    await expect(crossModelService.getChatAccess('own-in-archived-p4', 'u1')).resolves.toEqual({ access: 'owner', exists: true });

    const listed: string[] = (await crossModelService.listChats('u1', 1, 50)).chats.map((c: any) => c.id);
    expect(listed).not.toContain('own-archived'); // own stamp
    expect(listed).not.toContain('own-in-archived-p4'); // hidden via archived folder

    // The Archived browse view: individually-stamped OWN chats only — a chat
    // riding inside an archived folder is restored WITH the folder, never
    // listed one by one.
    const archivedView: string[] = (await crossModelService.listChats('u1', 1, 50, { archived: true })).chats.map((c: any) => c.id);
    expect(archivedView).toEqual(['own-archived']);
  });

  it('getChatAccess grades the same relationships owner/read/write/none — and the phantom-id shapes 404', async () => {
    await expect(crossModelService.getChatAccess('own-solo', 'u1')).resolves.toEqual({ access: 'owner', exists: true });
    await expect(crossModelService.getChatAccess('other-p1-viewer', 'u1')).resolves.toEqual({ access: 'read', exists: true });
    await expect(crossModelService.getChatAccess('other-p2-editor', 'u1')).resolves.toEqual({ access: 'write', exists: true });
    // Exists but invisible → 'none' (the 404 path never leaks existence)…
    await expect(crossModelService.getChatAccess('other-p3-none', 'u1')).resolves.toEqual({ access: 'none', exists: true });
    await expect(crossModelService.getChatAccess('other-solo', 'u1')).resolves.toEqual({ access: 'none', exists: true });
    // …and a never-existent (mis-transcribed) id → exists:false, same 404.
    await expect(crossModelService.getChatAccess('b92ef13f-936b-4a31-b268-a40d594f8e27', 'u1')).resolves.toEqual({ access: 'none', exists: false });
  });

  it('b6ce8490 regression: a feed-backed own chat is LISTED and owner-accessible — the retired Feeds section must never hide it again', async () => {
    await expect(crossModelService.getChatAccess('own-feed', 'u1')).resolves.toEqual({ access: 'owner', exists: true });
    const listed: string[] = (await crossModelService.listChats('u1', 1, 50)).chats.map((c: any) => c.id);
    expect(listed).toContain('own-feed');
  });

  // ── archivedAny (ticket 6201e0ee, review B1/D) — the push-kicked delta ──
  it('archivedAny: a just-archived row IS reported (the sidebar drops it), but chats inside archived FOLDERS stay hidden — the scope a6b7023ed pinned', async () => {
    // WITHOUT the flag: another lane's archive is structurally invisible
    // (the row left the default list) — the exact gap the ticket files.
    const plain: string[] = (await crossModelService.listChats('u1', 1, 50)).chats.map((c: any) => c.id);
    expect(plain).not.toContain('own-archived');
    expect(plain).not.toContain('own-in-archived-p4');

    // WITH the flag: the stamped row rides the response (the client's
    // !archivedAt render filter drops it)…
    const widened: string[] = (await crossModelService.listChats('u1', 1, 50, { archivedAny: true })).chats.map((c: any) => c.id);
    expect(widened).toContain('own-archived');
    // …but folder-archived chats stay hidden (their own archivedAt reads
    // null — the client CANNOT filter them, so they must never arrive).
    expect(widened).not.toContain('own-in-archived-p4');
    // And the archived-folder hiding is REAL in the emitted where-clause:
    const page = mockPrisma.crossModelChat.findMany.mock.calls.at(-1)![0];
    expect(JSON.stringify(page.where)).toContain('notIn');
  });

  it('archivedAny composes with the delta watermark (updatedAfter) — the push-kicked fetch shape', async () => {
    const since = new Date('2026-10-07T12:00:00Z');
    const rows: string[] = (await crossModelService.listChats('u1', 1, 50, { archivedAny: true, updatedAfter: since })).chats.map((c: any) => c.id);
    // The fixture rows all share one updatedAt (new Date()) — the composition
    // is pinned on the WHERE, not the fixture clock:
    expect(rows).toContain('own-archived');
    const page = mockPrisma.crossModelChat.findMany.mock.calls.at(-1)![0];
    expect(page.where.updatedAt).toEqual({ gte: since });
    expect(JSON.stringify(page.where)).toContain('notIn');
    expect(page.where).not.toHaveProperty('archivedAt'); // row-level exclusion dropped, folder half kept
  });
});

// ── updateChat — Fleet Supervisor guard ──────────────────────────────────────
//
// The Fleet Supervisor is a pinned system row: its title is a fixed label and
// it must stay ungrouped (it spans the whole fleet). Renames/moves are refused
// 400 — covers the UI rename/move AND the rename_chat/move_chat tools. Mode
// changes stay allowed, and normal chats are untouched by the guard.

describe('updateChat — Fleet Supervisor guard', () => {
  const SUP_CHAT = {
    id: 'sup1', userId: 'u1', projectId: null, isSupervisor: true,
    title: 'Fleet Supervisor', mode: 'thinking', createdAt: new Date(), updatedAt: new Date(),
  };
  const PLAIN_CHAT = { ...SUP_CHAT, id: 'chat-9', title: 'Plain', isSupervisor: false };

  beforeEach(() => {
    mockChatAccess(SUP_CHAT, null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
    mockPrisma.crossModelChat.update.mockImplementation(async ({ data }: any) => data);
  });

  it('REFUSES to rename the supervisor (fixed system label)', async () => {
    await expect(crossModelService.updateChat('sup1', 'u1', { title: 'Unanswered Test Question' }))
      .rejects.toThrow('The Fleet Supervisor chat cannot be renamed or moved');
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('REFUSES to move the supervisor into a project (it spans the fleet ungrouped)', async () => {
    // The guard fires BEFORE destination authorization — no project lookup at all.
    await expect(crossModelService.updateChat('sup1', 'u1', { projectId: 'proj-9' }))
      .rejects.toThrow('The Fleet Supervisor chat cannot be renamed or moved');
    expect(mockGetProjectAccess).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('still allows a MODE change on the supervisor', async () => {
    await expect(crossModelService.updateChat('sup1', 'u1', { mode: 'fast' })).resolves.toBeTruthy();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledTimes(1);
  });

  it("a MODE change to 'auto' PERSISTS 'auto' (owner 2026-09-26 — no longer rewritten to the L2 default)", async () => {
    await expect(crossModelService.updateChat('sup1', 'u1', { mode: 'auto' })).resolves.toBeTruthy();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mode: 'auto' }) }));
  });

  it('renames a NORMAL chat unchanged (guard only fires for isSupervisor)', async () => {
    mockChatAccess(PLAIN_CHAT, null);
    mockPrisma.crossModelChat.update.mockImplementation(async ({ data }: any) => data);
    await expect(crossModelService.updateChat('chat-9', 'u1', { title: 'New name' })).resolves.toBeTruthy();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'chat-9' },
      data: { title: 'New name', titlePinned: true, titleStep: null }, // session titles 2026-09-27: a REST/UI rename pins
    });
  });
});

// ── updateChat — Project Supervisor guard (hardening 2026-09-14) ─────────────
//
// A project supervisor chat (isProjectSupervisor; isSupervisor stays FLEET-only)
// is pinned the same way: its title tracks the project name and its projectId
// IS its identity (state doc, project-scope hook, sweep all key on the row). A
// move into a supervised project trips the partial unique index (raw P2002 →
// 500); a move into a lane-less project re-homes the row while the origin
// project scaffolds an amnesiac lane. Same 400 shape as the fleet guard with a
// SEPARATE message (the fleet string above is pinned); mode changes stay
// allowed; a plain chat is untouched.

describe('updateChat — Project Supervisor guard', () => {
  const PROJ_SUP_CHAT = {
    id: 'psup1', userId: 'u1', projectId: 'proj-A', isSupervisor: false, isProjectSupervisor: true,
    title: 'Apollo Supervisor', mode: 'thinking', createdAt: new Date(), updatedAt: new Date(),
  };
  const MSG = 'A project supervisor chat is pinned to its project and cannot be renamed or moved';

  beforeEach(() => {
    mockChatAccess(PROJ_SUP_CHAT, null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
    mockPrisma.crossModelChat.update.mockImplementation(async ({ data }: any) => data);
  });

  it('getChatById selects isProjectSupervisor (without it the guard reads undefined and is dead code)', async () => {
    await crossModelService.getChatById('psup1', 'u1', 'read');
    const fullSelect = mockPrisma.crossModelChat.findUnique.mock.calls
      .map((c: any[]) => c[0]?.select)
      .find((s: any) => s?.title);
    expect(fullSelect).toEqual(expect.objectContaining({ isSupervisor: true, isProjectSupervisor: true }));
  });

  it('REFUSES to rename the project supervisor (title tracks the project name; healed every 15 min)', async () => {
    await expect(crossModelService.updateChat('psup1', 'u1', { title: 'My notes' }))
      .rejects.toMatchObject({ statusCode: 400, message: MSG });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('REFUSES to move the project supervisor into another project (projectId is its identity)', async () => {
    // The guard fires BEFORE destination authorization — no project lookup, no P2002 reachable.
    await expect(crossModelService.updateChat('psup1', 'u1', { projectId: 'proj-B' }))
      .rejects.toMatchObject({ statusCode: 400, message: MSG });
    expect(mockGetProjectAccess).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('REFUSES to move the project supervisor out to null (it must stay in its project)', async () => {
    await expect(crossModelService.updateChat('psup1', 'u1', { projectId: null }))
      .rejects.toMatchObject({ statusCode: 400, message: MSG });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('still allows a MODE change on the project supervisor (mirrors the fleet lane)', async () => {
    await expect(crossModelService.updateChat('psup1', 'u1', { mode: 'deep_research' })).resolves.toBeTruthy();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'psup1' },
      data: { mode: 'deep_research' },
    });
  });

  it('keeps the FLEET message byte-identical for the fleet lane (separate guards, separate strings)', async () => {
    mockChatAccess({ ...PROJ_SUP_CHAT, id: 'sup1', projectId: null, isSupervisor: true, isProjectSupervisor: false, title: 'Fleet Supervisor' }, null);
    await expect(crossModelService.updateChat('sup1', 'u1', { title: 'x' }))
      .rejects.toThrow('The Fleet Supervisor chat cannot be renamed or moved');
  });

  it('renames a NORMAL chat unchanged (isProjectSupervisor false/undefined never trips the guard)', async () => {
    mockChatAccess({ ...PROJ_SUP_CHAT, id: 'chat-9', isProjectSupervisor: false, title: 'Plain' }, null);
    mockPrisma.crossModelChat.update.mockImplementation(async ({ data }: any) => data);
    await expect(crossModelService.updateChat('chat-9', 'u1', { title: 'New name' })).resolves.toBeTruthy();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'chat-9' },
      data: { title: 'New name', titlePinned: true, titleStep: null }, // session titles 2026-09-27: a REST/UI rename pins
    });
  });
});

// ── searchChatsAndMessages — deep search across chats + messages (ticket 4fd1de3c) ──
//
// Case-insensitive substring search (Prisma `contains`/insensitive = ILIKE)
// over the caller's OWN chats: title matches first (strong signal), then
// message-content matches (newest-first, capped per chat), all scoped to userId.
// Feed-backed chats ARE searched (b6ce8490 — no dedicated sidebar section
// exists, so search is one of their only discovery surfaces). Snippets window
// the match in context.

describe('searchChatsAndMessages — deep search', () => {
  beforeEach(() => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  });

  it('empty / whitespace query short-circuits — no DB queries, empty results', async () => {
    const r1 = await crossModelService.searchChatsAndMessages('u1', '');
    const r2 = await crossModelService.searchChatsAndMessages('u1', '   ');
    expect(r1.results).toEqual([]);
    expect(r2.results).toEqual([]);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('scopes BOTH legs to the caller (userId + archivedAt:null; feed chats ARE searchable — b6ce8490), ILIKE via contains/insensitive', async () => {
    await crossModelService.searchChatsAndMessages('u1', 'invoice');

    // Archive (owner 2026-09-08): search defaults exclude archived chats on
    // both legs (no archived folders in this fixture ⇒ the bare stamp filter).
    // Feed-backed chats lost their dedicated sidebar section (1c0341d57's
    // "Feeds" was removed), so search is one of their ONLY discovery
    // surfaces — b6ce8490: never exclude them again.
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', title: { contains: 'invoice', mode: 'insensitive' }, archivedAt: null },
        orderBy: { updatedAt: 'desc' },
      }),
    );
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          content: { contains: 'invoice', mode: 'insensitive' },
          chat: { userId: 'u1', archivedAt: null },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('chats inside an ARCHIVED folder leave both search legs (hidden-project exclusion rides the where clause)', async () => {
    // archive-scope resolves one archived folder (no descendants).
    mockPrisma.crossModelProject.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.archivedAt ? [{ id: 'p-arch', path: '/p-arch' }] : []));
    await crossModelService.searchChatsAndMessages('u1', 'invoice');

    const chatWhere = mockPrisma.crossModelChat.findMany.mock.calls[0][0].where;
    expect(chatWhere.archivedAt).toBeNull();
    expect(chatWhere.AND).toEqual([{ OR: [{ projectId: null }, { projectId: { notIn: ['p-arch'] } }] }]);
    const msgWhere = mockPrisma.crossModelMessage.findMany.mock.calls[0][0].where;
    expect(msgWhere.chat.AND).toEqual([{ OR: [{ projectId: null }, { projectId: { notIn: ['p-arch'] } }] }]);
  });

  it('title matches rank FIRST (role null, snippet=title); then message matches with windowed snippet', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: 'c1', title: 'Quarterly invoice review', projectId: 'p1', updatedAt: new Date('2026-08-01T00:00:00Z') },
    ]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      {
        chatId: 'c2', role: 'assistant',
        content: 'Here is a long message that mentions the invoice total somewhere in the middle of the text.',
        createdAt: new Date('2026-08-02T00:00:00Z'),
        chat: { title: 'Billing chat', projectId: null },
      },
    ]);

    const { results } = await crossModelService.searchChatsAndMessages('u1', 'invoice');

    expect(results).toHaveLength(2);
    // Title hit first.
    expect(results[0]).toMatchObject({
      chatId: 'c1', chatTitle: 'Quarterly invoice review', messageRole: null,
      snippet: 'Quarterly invoice review', projectId: 'p1',
      matchedAt: '2026-08-01T00:00:00.000Z',
    });
    // Message hit second, snippet contains the term, role carried through.
    expect(results[1]).toMatchObject({
      chatId: 'c2', chatTitle: 'Billing chat', messageRole: 'assistant', projectId: null,
      matchedAt: '2026-08-02T00:00:00.000Z',
    });
    expect(results[1].snippet.toLowerCase()).toContain('invoice');
  });

  it('caps message snippets per chat (a single chat cannot crowd out others)', async () => {
    const mk = (i: number) => ({
      chatId: 'c-hot', role: 'user', content: `hit number ${i} for term`,
      createdAt: new Date(`2026-08-0${(i % 9) + 1}T00:00:00Z`),
      chat: { title: 'Hot chat', projectId: null },
    });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([mk(1), mk(2), mk(3), mk(4), mk(5)]);

    const { results } = await crossModelService.searchChatsAndMessages('u1', 'term');

    // PER_CHAT_MESSAGE_CAP = 3 → only 3 of the 5 same-chat hits survive.
    expect(results.filter(r => r.chatId === 'c-hot')).toHaveLength(3);
  });

  it('caps total results at 50', async () => {
    const titles = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i}`, title: `term chat ${i}`, projectId: null, updatedAt: new Date('2026-08-01T00:00:00Z'),
    }));
    mockPrisma.crossModelChat.findMany.mockResolvedValue(titles);

    const { results } = await crossModelService.searchChatsAndMessages('u1', 'term');
    expect(results).toHaveLength(50);
  });

  // audit 2026-10-08 W1-3 (supervisors F3): the tt-rd 128K discussion lived in ARCHIVED lane 7b595cbd
  // ("Maxing GPU on · archived") — the search the supervisor ran excluded it and it told the owner
  // "archived sessions are fully searchable". includeArchived drops the exclusion and marks the hits.
  it('includeArchived: no archive exclusion on either leg; hits in an archived chat / folder carry archived:true', async () => {
    mockPrisma.crossModelProject.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.archivedAt ? [{ id: 'p-arch', path: '/p-arch' }] : []));
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: '7b595cbd-1', title: 'Maxing GPU on 128k', projectId: 'p-ttrd', updatedAt: new Date('2026-10-07T15:46:00Z'), archivedAt: new Date('2026-10-07T15:46:00Z') },
    ]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { chatId: '7b595cbd-1', role: 'user', content: 'is the best balance going to be Both at once: 128k + 2 lanes fits?', createdAt: new Date('2026-10-06T22:03:00Z'), chat: { title: 'Maxing GPU on', projectId: 'p-ttrd', archivedAt: new Date('2026-10-07T15:46:00Z') } },
      { chatId: 'c-live', role: 'assistant', content: '128k allocated context on node-a', createdAt: new Date('2026-10-08T17:58:00Z'), chat: { title: 'StAnne', projectId: 'p-arch', archivedAt: null } },
      { chatId: 'c-live2', role: 'assistant', content: '128k is set', createdAt: new Date('2026-10-08T17:59:00Z'), chat: { title: 'tt-rd PS', projectId: null, archivedAt: null } },
    ]);
    const { results } = await crossModelService.searchChatsAndMessages('u1', '128k', { includeArchived: true });
    expect(mockPrisma.crossModelChat.findMany.mock.calls[0][0].where).toEqual({ userId: 'u1', title: { contains: '128k', mode: 'insensitive' } });
    expect(mockPrisma.crossModelMessage.findMany.mock.calls[0][0].where.chat).toEqual({ userId: 'u1' });
    expect(results.map((r) => [r.chatId, r.archived ?? false])).toEqual([['7b595cbd-1', true], ['7b595cbd-1', true], ['c-live', true], ['c-live2', false]]);
  });
});

describe('deleteChat — audit trail (feedback 138b0347)', () => {
  it('audits chat.delete for EVERY caller — the coding-session DELETE endpoint delegates here and used to bypass the platform-layer row', async () => {
    // A newly created coding chat vanished with zero signal; the REST
    // /coding/sessions/:id delete (coding.controller.deleteSession) delegates
    // to THIS method, so the chat.delete Activity row must be written at this
    // canonical layer, not one layer up in platform.service.
    mockChatAccess({ id: 'c1', userId: 'u1', projectId: null, title: 'T', isSupervisor: false } as any, null);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null); // plain chat — no coding cleanup
    await crossModelService.deleteChat('c1', 'u1');
    expect(mockPrisma.crossModelChat.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1', action: 'chat.delete', resource: 'platform',
        metadata: { chatId: 'c1' },
      }),
    });
  });

  it("clears the chat's chat-keyed store rows (thread state + the supervisor cold archive) and its chat-scope memory — AFTER the row is gone (review 2026-10-23)", async () => {
    mockChatAccess({ id: 'c1', userId: 'u1', projectId: null, title: 'T', isSupervisor: true } as any, null);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
    await crossModelService.deleteChat('c1', 'u1');
    expect(mockStoreDeleteChatScoped).toHaveBeenCalledWith(['c1']);
    expect(mockMemClear).toHaveBeenCalledWith({ type: 'chat', id: 'c1' });
    expect(mockStoreDeleteChatScoped.mock.invocationCallOrder[0]).toBeGreaterThan(mockPrisma.crossModelChat.delete.mock.invocationCallOrder[0]);
  });

  it('a store-cleanup failure never fails the delete', async () => {
    mockChatAccess({ id: 'c1', userId: 'u1', projectId: null, title: 'T', isSupervisor: false } as any, null);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
    mockStoreDeleteChatScoped.mockRejectedValueOnce(new Error('store down'));
    await expect(crossModelService.deleteChat('c1', 'u1')).resolves.toMatchObject({ message: expect.any(String) });
  });

  it('an audit-write failure never blocks the delete (fail-open, warn only)', async () => {
    mockChatAccess({ id: 'c1', userId: 'u1', projectId: null, title: 'T', isSupervisor: false } as any, null);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
    mockPrisma.activity.create.mockRejectedValueOnce(new Error('activity down'));
    await expect(crossModelService.deleteChat('c1', 'u1')).resolves.toMatchObject({ message: expect.any(String) });
    expect(mockPrisma.crossModelChat.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
  });
});

// ── getChatAccess — folder-ancestor membership inheritance (ticket 7acaa7ba) ──
//
// The reported incident (breanne, editor on a parent folder "CQL Business Ops",
// viewer on its child "Canada Data Center Op"): getChatAccess consulted ONLY
// the leaf project's member row, while platform.service getProjectAccess walks
// the ancestor chain — so the two primitives disagreed for every member whose
// row sits on an ancestor folder. This block pins the aligned semantics:
// ancestor owner → 'owner'; ancestor editor/admin raises the rank (max);
// ancestor viewer alone → 'read'; FOLDERS_INHERITANCE=off = exact old behavior.

describe('getChatAccess — folder-ancestor membership inheritance (7acaa7ba)', () => {
  // Chain: root(folder-root, owner u9) → mid(parent folder) → leaf(project 'p-leaf').
  // The CHAT lives in 'p-leaf'; u2's rows sit on 'mid' only.
  const LEAF_CHAT = { id: 'chat-in-leaf', userId: 'u9', projectId: 'p-leaf' };
  const CHAIN_ROWS: Record<string, any> = {
    'folder-root': { id: 'folder-root', userId: 'u9', parentId: null, path: '/folder-root' },
    mid: { id: 'mid', userId: 'u9', parentId: 'folder-root', path: '/folder-root/mid' },
    'p-leaf': { id: 'p-leaf', userId: 'u9', parentId: 'mid', path: '/folder-root/mid/p-leaf' },
  };

  const setupLeafChat = () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where.id === LEAF_CHAT.id ? LEAF_CHAT : null));
    // getAncestorChain: leaf lookup then the chain findMany over the materialized path.
    mockPrisma.crossModelProject.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(CHAIN_ROWS[where.id] ?? null));
    mockPrisma.crossModelProject.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve((where.id?.in ?? []).map((id: string) => CHAIN_ROWS[id]).filter(Boolean)));
  };

  beforeEach(() => {
    setupLeafChat();
    mockPrisma.projectMember.findUnique.mockResolvedValue(null); // no leaf row by default
  });

  it('an EDITOR row on an ANCESTOR folder grants write (the breanne incident shape)', async () => {
    mockPrisma.projectMember.findMany.mockImplementation(({ where }: any) => {
      // where: { userId, projectId: { in: [ancestors] } } — u2 is editor on 'mid'.
      expect((where.projectId as any).in).toEqual(['folder-root', 'mid']);
      return Promise.resolve(where.userId === 'u2' ? [{ role: 'editor' }] : []);
    });
    await expect(crossModelService.getChatAccess('chat-in-leaf', 'u2')).resolves.toEqual({ access: 'write', exists: true });
  });

  it('an ancestor VIEWER row alone grants read (never write)', async () => {
    mockPrisma.projectMember.findMany.mockResolvedValue([{ role: 'viewer' }]);
    await expect(crossModelService.getChatAccess('chat-in-leaf', 'u2')).resolves.toEqual({ access: 'read', exists: true });
  });

  it('the leaf row and ancestor rows MAX together (viewer on leaf, editor on ancestor → write)', async () => {
    // The exact breanne prod shape: viewer on the leaf folder, editor on its parent.
    mockPrisma.projectMember.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where.projectId_userId.projectId === 'p-leaf' ? { role: 'viewer' } : null));
    mockPrisma.projectMember.findMany.mockResolvedValue([{ role: 'editor' }]);
    await expect(crossModelService.getChatAccess('chat-in-leaf', 'u2')).resolves.toEqual({ access: 'write', exists: true });
  });

  it('the OWNER of an ancestor folder gets owner access to every chat in the subtree', async () => {
    // u9 owns the whole chain; u77 owns 'mid' but not the leaf — still owner.
    CHAIN_ROWS.mid.userId = 'u77';
    try {
      await expect(crossModelService.getChatAccess('chat-in-leaf', 'u77')).resolves.toEqual({ access: 'owner', exists: true });
    } finally {
      CHAIN_ROWS.mid.userId = 'u9'; // restore
    }
  });

  it('a stranger with no rows anywhere stays none (no leak)', async () => {
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    await expect(crossModelService.getChatAccess('chat-in-leaf', 'u-stranger')).resolves.toEqual({ access: 'none', exists: true });
  });

  it('FOLDERS_INHERITANCE=off = exact pre-7acaa7ba behavior (leaf row only)', async () => {
    const prev = process.env.FOLDERS_INHERITANCE;
    process.env.FOLDERS_INHERITANCE = 'off';
    mockPrisma.projectMember.findMany.mockResolvedValue([{ role: 'editor' }]); // would grant write if inheritance ran
    try {
      await expect(crossModelService.getChatAccess('chat-in-leaf', 'u2')).resolves.toEqual({ access: 'none', exists: true });
    } finally {
      if (prev === undefined) delete process.env.FOLDERS_INHERITANCE; else process.env.FOLDERS_INHERITANCE = prev;
    }
  });

});

// ── listChats — lineage completion + the sidebar delta watermark (ticket d6b2eef5, 2026-09-28) ──
//
// A page carrying a CHILD whose parent is off-page pulls the missing ancestors
// (≤ 2 hops, the caller's own visibility scope, folder filter honoured) and
// splices them in before their first descendant, so the sidebar nests on
// first paint. `updatedAfter` is the delta poll's inclusive watermark.

describe('listChats — lineage completion + updatedAfter (ticket d6b2eef5)', () => {
  const ROW = (id: string, parentChatId: string | null = null, extra: Record<string, unknown> = {}) => ({
    id, title: `Chat ${id}`, mode: 'auto', projectId: null, parentChatId, isSupervisor: false, userId: 'u1',
    archivedAt: null, createdAt: new Date('2026-09-28T00:00:00Z'), updatedAt: new Date('2026-09-28T00:00:00Z'),
    _count: { chatMessages: 0 }, chatMessages: [], ...extra,
  });

  beforeEach(() => {
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.count.mockResolvedValue(2);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    mockPrisma.chatSchedule.groupBy.mockResolvedValue([]);
    mockGetChatCapability.mockResolvedValue({ codeCapable: false, hasWorkspaceState: false });
    mockGetBusyChatIds.mockResolvedValue(new Set<string>());
    mockGetPendingAttentionMap.mockResolvedValue(new Map());
  });

  it('pulls an off-page parent (and its parent, ≤ 2 hops) inside the caller\'s visibility scope and splices it before the first child; pagination total is untouched', async () => {
    const calls: any[] = [];
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      calls.push(args);
      if (args.skip !== undefined) return [ROW('child', 'parent'), ROW('other')];            // the page
      const ids: string[] = args.where?.AND?.[1]?.id?.in ?? [];
      if (ids.includes('parent')) return [ROW('parent', 'grand')];                           // hop 1
      if (ids.includes('grand')) return [ROW('grand')];                                      // hop 2
      return [];
    });

    const r = await crossModelService.listChats('u1', 1, 30);

    expect(r.chats.map((c: any) => c.id)).toEqual(['grand', 'parent', 'child', 'other']);
    expect(r.pagination).toEqual({ page: 1, limit: 30, total: 2, pages: 1 });
    expect(calls).toHaveLength(3);
    // The ancestor lookups carry the bare visibility scope (own ∪ member-project
    // chats, no archive — and no feed exclusion: feed chats list like any own
    // chat since b6ce8490) AND the id list — never the page's narrowing filters.
    const hop1 = calls[1].where;
    expect(hop1.AND[0]).toEqual(expect.objectContaining({ OR: [{ userId: 'u1' }] }));
    expect(hop1.AND[0].feed).toBeUndefined();
    expect(hop1.AND[1]).toEqual({ id: { in: ['parent'] } });
    expect(calls[1].skip).toBeUndefined();
    expect(calls[2].where.AND[1]).toEqual({ id: { in: ['grand'] } });
    // Every spliced row gets the same enrichment as a page row.
    for (const c of r.chats as any[]) expect(c).toEqual(expect.objectContaining({ running: false, hasActiveSchedule: false, codeCapable: false }));
  });

  it('a folder-filtered page keeps the folder filter on the ancestor lookup, so a parent in another folder never lands in this folder\'s list', async () => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) =>
      args.skip !== undefined ? [ROW('child', 'parent', { projectId: 'p1' })] : []);
    const r = await crossModelService.listChats('u1', 1, 30, { projectId: 'p1' });
    expect(r.chats.map((c: any) => c.id)).toEqual(['child']);
    const lookup = mockPrisma.crossModelChat.findMany.mock.calls[1][0];
    expect(lookup.where.projectId).toBe('p1');
  });

  it('no ancestor query when every parent is on the page or in the Archived view; a lookup failure leaves the plain page', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([ROW('parent'), ROW('child', 'parent')]);
    await crossModelService.listChats('u1', 1, 30);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1);

    mockPrisma.crossModelChat.findMany.mockClear();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([ROW('child', 'gone', { archivedAt: new Date() })]);
    await crossModelService.listChats('u1', 1, 30, { archived: true });
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1);

    mockPrisma.crossModelChat.findMany.mockClear();
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args.skip !== undefined) return [ROW('child', 'parent')];
      throw new Error('db hiccup');
    });
    const failed = await crossModelService.listChats('u1', 1, 30);
    expect(failed.chats.map((c: any) => c.id)).toEqual(['child']);
  });

  it('updatedAfter narrows the page to rows at/after the watermark (inclusive) — the delta poll — and never applies to the ancestor lookup', async () => {
    const since = new Date('2026-09-28T12:00:00Z');
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) =>
      args.skip !== undefined ? [ROW('child', 'parent', { updatedAt: since })] : [ROW('parent')]);
    const r = await crossModelService.listChats('u1', 1, 50, { updatedAfter: since });
    expect(r.chats.map((c: any) => c.id)).toEqual(['parent', 'child']);
    const page = mockPrisma.crossModelChat.findMany.mock.calls[0][0];
    expect(page.where.updatedAt).toEqual({ gte: since });
    const lookup = mockPrisma.crossModelChat.findMany.mock.calls[1][0];
    expect(lookup.where.AND[0].updatedAt).toBeUndefined();
    expect(mockPrisma.crossModelChat.count.mock.calls[0][0].where.updatedAt).toEqual({ gte: since });
  });
});

// ── Ghost mode (owner 2026-10-22): the per-chat private posture. updateChat
// refuses it on supervisor / coding rows (the same rule as the lead pick), and
// createChat persists it for a plain new chat. ─────────────────────────────
describe('updateChat — ghost mode (plain-chat posture)', () => {
  beforeEach(() => {
    mockChatAccess({ ...CHAT, isSupervisor: false, isProjectSupervisor: false }, null);
    mockPrisma.chatCodingState.findUnique.mockResolvedValue(null); // plain chat
    mockGetProjectAccess.mockResolvedValue({ project: { id: 'p1', repoProvider: null }, role: 'owner' });
  });

  it('a plain chat flips ghost mode on and off', async () => {
    const on = await crossModelService.updateChat(CHAT.id, OWNER, { ghostMode: true });
    expect(on).toBeTruthy();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalled();
    const off = await crossModelService.updateChat(CHAT.id, OWNER, { ghostMode: false });
    expect(off).toBeTruthy();
  });

  it('a supervisor chat refuses ghost mode (its models are platform seats; its memory is the audit trail)', async () => {
    mockChatAccess({ ...CHAT, isSupervisor: true, isProjectSupervisor: false }, null);
    await expect(crossModelService.updateChat(CHAT.id, OWNER, { ghostMode: true }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('supervisor chat cannot run in ghost mode') });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('a project supervisor chat refuses ghost mode too', async () => {
    mockChatAccess({ ...CHAT, isSupervisor: false, isProjectSupervisor: true }, null);
    await expect(crossModelService.updateChat(CHAT.id, OWNER, { ghostMode: true }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('supervisor chat cannot run in ghost mode') });
  });

  it('a coding session refuses ghost mode (the satellite agent is its model)', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: CHAT.id });
    await expect(crossModelService.updateChat(CHAT.id, OWNER, { ghostMode: true }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('coding session cannot run in ghost mode') });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });
});

// Ghost composer toggle review fix (2026-10-22): list rows carry
// isProjectSupervisor, so the web's ghost controls hide on a Project
// Supervisor chat (the side-panel switch read only the row and its save 400'd).
describe('listChats — the row select carries isProjectSupervisor (ghost controls hide on supervisor chats)', () => {
  beforeEach(() => {
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.count.mockResolvedValue(1);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    mockPrisma.chatSchedule.groupBy.mockResolvedValue([]);
    mockGetChatCapability.mockResolvedValue({ codeCapable: false, hasWorkspaceState: false });
    mockGetBusyChatIds.mockResolvedValue(new Set<string>());
    mockGetPendingAttentionMap.mockResolvedValue(new Map());
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{
      id: 'ps-1', title: 'Project Supervisor', mode: 'auto', projectId: 'p1', parentChatId: null,
      isSupervisor: false, isProjectSupervisor: true, ghostMode: false, userId: 'u1', archivedAt: null,
      createdAt: new Date(), updatedAt: new Date(), _count: { chatMessages: 0 }, chatMessages: [],
    }]);
  });

  it('REPRO: the page select asks for isProjectSupervisor and the row comes out with it', async () => {
    const r = await crossModelService.listChats('u1', 1, 20);
    const page = mockPrisma.crossModelChat.findMany.mock.calls[0][0];
    expect(page.select.isProjectSupervisor).toBe(true);
    expect(page.select.isSupervisor).toBe(true);
    expect(page.select.ghostMode).toBe(true);
    expect((r.chats as any[])[0]).toMatchObject({ id: 'ps-1', isProjectSupervisor: true, ghostMode: false });
  });
});

describe('createChat — ghost mode at create', () => {
  beforeEach(() => {
    mockEnsureUserSpace.mockResolvedValue({ id: 'space-1', repoProvider: 'blank' });
    mockPrisma.crossModelChat.create.mockImplementation(async () => ({
      id: 'chat-1', title: 'T', mode: 'auto', userId: OWNER, projectId: 'space-1', ghostMode: true, isSupervisor: false, isProjectSupervisor: false,
    }));
  });

  it('persists ghostMode:true when asked (and the default stays false)', async () => {
    const chat = await crossModelService.createChat(OWNER, 'T', 'auto', null, true);
    expect(chat.ghostMode).toBe(true);
    const data = mockPrisma.crossModelChat.create.mock.calls.at(-1)?.[0]?.data ?? {};
    expect(data.ghostMode).toBe(true);
    // default call: no ghost flag
    await crossModelService.createChat(OWNER, 'T2', 'auto', null, false);
    const data2 = mockPrisma.crossModelChat.create.mock.calls.at(-1)?.[0]?.data ?? {};
    expect(data2.ghostMode).toBeUndefined();
  });
});

// ── listChats — display-only nesting (2026-10-21, platform/display-parent.ts) ──
//
// A machine-spawned lane carries displayParentChatId = the folder's Project
// Supervisor. The row select carries it, the lineage completion pulls the
// supervisor onto a page carrying a parentless lane, and under
// DISPLAY_PARENT_NESTING_DISABLED=1 the field is never selected (rows are
// today's byte-for-byte).

describe('listChats — display parent (2026-10-21)', () => {
  const ROW = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: `Chat ${id}`, mode: 'auto', projectId: 'p-crossmodel', parentChatId: null, isSupervisor: false, userId: 'u1',
    archivedAt: null, createdAt: new Date('2026-10-21T00:00:00Z'), updatedAt: new Date('2026-10-21T00:00:00Z'),
    _count: { chatMessages: 0 }, chatMessages: [], ...extra,
  });

  beforeEach(() => {
    delete process.env.DISPLAY_PARENT_NESTING_DISABLED;
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.count.mockResolvedValue(1);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    mockPrisma.chatSchedule.groupBy.mockResolvedValue([]);
    mockGetChatCapability.mockResolvedValue({ codeCapable: false, hasWorkspaceState: false });
    mockGetBusyChatIds.mockResolvedValue(new Set<string>());
    mockGetPendingAttentionMap.mockResolvedValue(new Map());
  });
  afterAll(() => { delete process.env.DISPLAY_PARENT_NESTING_DISABLED; });

  it('the row select carries displayParentChatId and the supervisor is completed onto the page before its lane', async () => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args.skip !== undefined) return [ROW('lane-b839643b', { displayParentChatId: 'ps-daee2916' })];
      const ids: string[] = args.where?.AND?.[1]?.id?.in ?? [];
      return ids.includes('ps-daee2916') ? [ROW('ps-daee2916', { displayParentChatId: null })] : [];
    });
    const r = await crossModelService.listChats('u1', 1, 30, { projectId: 'p-crossmodel' });
    const page = mockPrisma.crossModelChat.findMany.mock.calls[0][0];
    expect(page.select.displayParentChatId).toBe(true);
    expect(page.select.parentChatId).toBe(true);
    // The ancestor lookup asks for the display parent, inside the folder filter.
    const lookup = mockPrisma.crossModelChat.findMany.mock.calls[1][0];
    expect(lookup.where.AND[1]).toEqual({ id: { in: ['ps-daee2916'] } });
    expect(lookup.where.projectId).toBe('p-crossmodel');
    expect(r.chats.map((c: any) => [c.id, c.displayParentChatId])).toEqual([['ps-daee2916', null], ['lane-b839643b', 'ps-daee2916']]);
  });

  it('REPRO (second review, finding 10): a lineage hop selects NO message aggregate — the count comes from a chatId-indexed groupBy and the newest rows from one bounded read per ancestor; the switch keeps the single full-select hop', async () => {
    const newest = { id: 'm-9', content: 'the supervisor\'s last word', createdAt: new Date('2026-10-21T01:00:00Z'), role: 'assistant', metadata: null };
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args.skip !== undefined) return [ROW('lane-1', { displayParentChatId: 'ps-1', parentChatId: 'fleet-1' })];
      const ids: string[] = args.where?.AND?.[1]?.id?.in ?? [];
      return ids.map((id) => { const { _count, chatMessages, ...plain } = ROW(id); return args.select?._count ? ROW(id) : plain; });
    });
    mockPrisma.crossModelMessage.groupBy.mockResolvedValueOnce([{ chatId: 'ps-1', _count: { _all: 42 } }]);
    mockPrisma.crossModelMessage.findMany.mockImplementation(async (args: any) => (args.where.chatId === 'ps-1' ? [newest] : []));
    const r = await crossModelService.listChats('u1', 1, 30);
    const hop = mockPrisma.crossModelChat.findMany.mock.calls[1][0];
    expect(hop.where.AND[1]).toEqual({ id: { in: ['fleet-1', 'ps-1'] } }); // two ids — the shape that aggregated the whole table
    expect(hop.select._count).toBeUndefined();
    expect(hop.select.chatMessages).toBeUndefined();
    expect(mockPrisma.crossModelMessage.groupBy).toHaveBeenCalledWith({ by: ['chatId'], where: { chatId: { in: ['fleet-1', 'ps-1'] } }, _count: { _all: true } });
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: 'ps-1' }, orderBy: { createdAt: 'desc' }, take: 3 }));
    const ps = (r.chats as any[]).find((c) => c.id === 'ps-1');
    expect(ps).toMatchObject({ messageCount: 42, lastMessage: "the supervisor's last word" });
    expect((r.chats as any[]).find((c) => c.id === 'fleet-1')).toMatchObject({ messageCount: 0, lastMessage: null });
    // a failed fill re-reads the hop with the full select (the pre-fix query)
    mockPrisma.crossModelChat.findMany.mockClear();
    mockPrisma.crossModelMessage.groupBy.mockRejectedValueOnce(new Error('db hiccup'));
    await crossModelService.listChats('u1', 1, 30);
    expect(mockPrisma.crossModelChat.findMany.mock.calls.map((c: any[]) => !!c[0].select._count)).toEqual([true, false, true]);
    // DISPLAY_PARENT_NESTING_DISABLED=1: the parent hop is the single full-select read, byte-for-byte
    process.env.DISPLAY_PARENT_NESTING_DISABLED = '1';
    mockPrisma.crossModelChat.findMany.mockClear();
    mockPrisma.crossModelMessage.groupBy.mockClear();
    await crossModelService.listChats('u1', 1, 30);
    expect(mockPrisma.crossModelChat.findMany.mock.calls.map((c: any[]) => !!c[0].select._count)).toEqual([true, true]);
    expect(mockPrisma.crossModelMessage.groupBy).not.toHaveBeenCalled();
  });

  it('DISPLAY_PARENT_NESTING_DISABLED=1 — the field is not selected and no ancestor lookup runs for it', async () => {
    process.env.DISPLAY_PARENT_NESTING_DISABLED = '1';
    mockPrisma.crossModelChat.findMany.mockResolvedValue([ROW('lane-b839643b')]);
    const r = await crossModelService.listChats('u1', 1, 30);
    const page = mockPrisma.crossModelChat.findMany.mock.calls[0][0];
    expect('displayParentChatId' in page.select).toBe(false);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1);
    expect('displayParentChatId' in (r.chats[0] as any)).toBe(false);
  });
});

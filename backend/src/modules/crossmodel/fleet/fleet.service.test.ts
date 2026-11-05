/**
 * Fleet Management — fleet.service unit tests with mocked Prisma.
 * Pins the owner-scoping invariants, the thread noise classifier (origin
 * marking + retro schedule-prompt matching + assistant inheritance), the
 * busy-chat queueing contract (main's pending_chat_messages via
 * message-queue.service), and the merged raw log.
 * Pattern follows platform/platform.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn() },
  crossModelProject: { findMany: jest.fn() },
  crossModelMessage: { findMany: jest.fn(), findUnique: jest.fn() },
  chatCodingState: { findUnique: jest.fn(), findMany: jest.fn() },
  chatSchedule: { findMany: jest.fn(), count: jest.fn() },
  pendingChatMessage: { count: jest.fn() },
  chatFile: { findMany: jest.fn() }, // chip → ChatFile fileId injection (c6e8edda)
  activity: { findMany: jest.fn(), create: jest.fn(async () => ({})) },
  eventHook: { findMany: jest.fn() },
  projectDigest: { findMany: jest.fn() },
  digestItemAck: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  // chat-busy's durable layer: worker-executed coding runs (agent_runs rows).
  agentRun: { findFirst: jest.fn(), findMany: jest.fn() },
};

jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// chat-busy's cross-process layer — the liveness keys chat runs on OTHER
// instances hold. Defaults: nothing remote (tests that care set the store).
const redisStore = new Map<string, string>();
const mockRedis = {
  set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
  mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
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

// platform.service (dynamic import in sendSupervisorMessage / dismissFleetSchedule) — record calls.
const mockSendChatMessage = jest.fn(async (..._args: any[]): Promise<any> => ({ queued: true }));
const mockCancelSchedule = jest.fn(async (..._args: any[]): Promise<any> => true);
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  sendChatMessage: (...a: any[]) => mockSendChatMessage(...a),
  cancelSchedule: (...a: any[]) => mockCancelSchedule(...a),
}));

// supervisor.service (dynamic import) — main owns supervisor identification
// (isSupervisor chat per owner) + provisioning. SUPERVISOR_TITLE is the real
// pinned title; SUPERVISOR_PROMPT_OPENER is the stock system-written prompt
// opener (the hidden-artifacts resolver requires title AND opener on legacy
// pre-flag dupes so a user chat merely RENAMED to the title stays visible).
const mockFindFleetSupervisorChat = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockEnsureFleetSupervisor = jest.fn(async (..._args: any[]): Promise<any> => null);
jest.mock('../platform/supervisor.service', () => ({
  __esModule: true,
  SUPERVISOR_TITLE: 'Fleet Supervisor',
  SUPERVISOR_PROMPT_OPENER: 'You are the Fleet Supervisor',
  findFleetSupervisorChat: (...a: any[]) => mockFindFleetSupervisorChat(...a),
  ensureFleetSupervisor: (...a: any[]) => mockEnsureFleetSupervisor(...a),
}));

// message-queue.service (dynamic import) — main's busy-chat queue boundary.
const mockCountPending = jest.fn(async (..._args: any[]): Promise<number> => 0);
const mockCountPendingUser = jest.fn(async (..._args: any[]): Promise<number> => 0);
const mockEnqueueChatMessage = jest.fn(async (..._args: any[]): Promise<any> => ({ id: 'pend-1', position: 1 }));
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  countPending: (...a: any[]) => mockCountPending(...a),
  countPendingUser: (...a: any[]) => mockCountPendingUser(...a),
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
}));

// owner-briefing.service (static import — the plain-English layer, owner
// 2026-09-04): mocked at the boundary so the bootstrap path is assertable and
// the real generator (Redis lock + utility-llm) never runs here. The kind
// constant is re-exported verbatim — classifyThreadRows keys on it.
const mockGenerateOwnerBriefing = jest.fn(async (..._args: any[]): Promise<boolean> => true);
jest.mock('./owner-briefing.service', () => ({
  __esModule: true,
  OWNER_BRIEFING_KIND: 'owner_briefing',
  generateOwnerBriefing: (...a: any[]) => mockGenerateOwnerBriefing(...a),
}));

// upload.controller + chat-gate (dynamic imports on the attachment send path).
// The real modules pull multer/pdf-extract — mock the three functions the
// fleet path uses and pin the CONTRACT, not their internals.
const mockLoadAttachment = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockCombineAttachments = jest.fn((..._args: any[]): any => undefined);
const mockMapAttachmentForAgent = jest.fn((..._args: any[]): any => ({}));
jest.mock('../upload.controller', () => ({
  __esModule: true,
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
  combineAttachments: (...a: any[]) => mockCombineAttachments(...a),
}));
jest.mock('../chat-agent/chat-gate', () => ({
  __esModule: true,
  mapAttachmentForAgent: (...a: any[]) => mockMapAttachmentForAgent(...a),
}));

import * as fleet from './fleet.service';
// The mocked AppError class — instanceof-compatible with the service's checks.
import { AppError } from '../../../middleware/error-handler';
import { startLiveRun, endLiveRun } from '../coding/live-runs';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const SUP = 'sup-chat-1';

const D = (s: string) => new Date(`2026-08-10T${s}Z`);
/** Raw transcript row (newest-first ordering is the CALLER's job). */
const M = (id: string, role: string, content: string, at: Date, metadata?: any) => ({
  id, role, content, createdAt: at, metadata: metadata ?? null,
});

/** Wire a provisioned, owned supervisor chat (plain — no coding satellite). */
function mockSupervisorProvisioned() {
  mockFindFleetSupervisorChat.mockResolvedValue({ id: SUP, title: 'Supervisor', userId: OWNER });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: SUP, userId: OWNER, title: 'Supervisor' });
  mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
}

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockFindFleetSupervisorChat.mockResolvedValue(null);
  mockEnsureFleetSupervisor.mockResolvedValue(null);
  mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
  mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  mockPrisma.chatCodingState.findUnique.mockResolvedValue(null);
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
  mockPrisma.chatSchedule.count.mockResolvedValue(0);
  mockPrisma.pendingChatMessage.count.mockResolvedValue(0);
  mockPrisma.chatFile.findMany.mockResolvedValue([]); // chip-less threads cost zero matches
  mockPrisma.activity.findMany.mockResolvedValue([]);
  mockPrisma.eventHook.findMany.mockResolvedValue([]);
  mockPrisma.projectDigest.findMany.mockResolvedValue([]);
  mockPrisma.digestItemAck.findMany.mockResolvedValue([]);
  mockPrisma.digestItemAck.deleteMany.mockResolvedValue({ count: 0 });
  mockSendChatMessage.mockResolvedValue({ queued: true, chatId: SUP, mode: 'thinking' });
  mockCountPending.mockResolvedValue(0);
  mockEnqueueChatMessage.mockResolvedValue({ id: 'pend-1', position: 1 });
});

// ── Discovery ─────────────────────────────────────────────────────────────────

describe('getFleetSupervisor', () => {
  it('returns the live view of the owner\'s auto-provisioned supervisor chat', async () => {
    mockSupervisorProvisioned();
    const r = await fleet.getFleetSupervisor(OWNER);
    expect(mockFindFleetSupervisorChat).toHaveBeenCalledWith(OWNER);
    expect(r.supervisor).toMatchObject({ id: SUP, title: 'Supervisor', running: false, codeCapable: false });
  });

  it('is read-only: supervisor null when not provisioned yet (never ensures)', async () => {
    const r = await fleet.getFleetSupervisor(OWNER);
    expect(r).toEqual({ supervisor: null, hidden: { chatIds: [], projectIds: [] } });
    expect(mockEnsureFleetSupervisor).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
  });

  it('annotates running + codingStatus for a supervisor with an active run', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ status: 'ready' });
    startLiveRun(`chat:${SUP}`); // chat-agent runs key on chat:<id> (live-runs chatRunKeys)
    try {
      const r = await fleet.getFleetSupervisor(OWNER);
      expect(r.supervisor).toMatchObject({ running: true, codeCapable: true, codingStatus: 'ready' });
    } finally {
      endLiveRun(`chat:${SUP}`);
    }
  });
});

// ── Sidebar-hidden fleet artifacts ────────────────────────────────────────────

describe('getSidebarHiddenFleetArtifacts', () => {
  /** The stock system-written supervisor prompt (legacy dupes carry its opener). */
  const STOCK_PROMPT = 'You are the Fleet Supervisor — an autonomous supervisor chat…';
  /** A chat row as the resolver's select returns it. */
  const C = (id: string, title: string, projectId: string | null, isSupervisor = false, systemPrompt: string | null = null) => ({
    id, title, projectId, isSupervisor, systemPrompt,
  });
  const P = (id: string, name: string) => ({ id, name });

  it('hides isSupervisor dupes AND legacy title+stock-prompt chats, leaving normal chats visible', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C('sup-1', 'Fleet Supervisor', null, true), // the pinned supervisor
      C('sup-dupe', 'Fleet Supervisor', null, true), // a second flagged one
      C('sup-legacy', 'Fleet Supervisor', null, false, STOCK_PROMPT), // legacy dupe — no flag, stock prompt
      C('c1', 'Fleet Supervisor ideas', null), // prefix only — NOT hidden
      C('c2', 'My research', null),
    ]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.chatIds).toEqual(['sup-1', 'sup-dupe', 'sup-legacy']);
    expect(r.projectIds).toEqual([]);
  });

  it('NEVER hides a user chat merely RENAMED to the supervisor title (no stock prompt)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C('c-renamed', 'Fleet Supervisor', null), // user rename — systemPrompt null
      C('c-custom', 'Fleet Supervisor', null, false, 'You are my custom helper.'), // custom prompt
    ]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.chatIds).toEqual([]);
    expect(r.projectIds).toEqual([]);
  });

  it("hides a project named 'Fleet HQ' even when EMPTY (trimmed, case-insensitive)", async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      P('p-hq', 'Fleet HQ'),
      P('p-hq2', '  fleet hq  '),
      P('p-close', 'Fleet HQ planning'), // not an exact match — visible
    ]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.chatIds).toEqual([]);
    expect(r.projectIds).toEqual(['p-hq', 'p-hq2']);
  });

  it("NEVER hides a 'Fleet HQ'-named project holding a VISIBLE user chat (names are user-editable)", async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C('sup-1', 'Fleet Supervisor', 'p-hq', true),
      C('c1', 'My research', 'p-hq'), // a real user chat — the folder must stay
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([P('p-hq', 'Fleet HQ')]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.chatIds).toEqual(['sup-1']);
    expect(r.projectIds).toEqual([]);
  });

  it("hides a 'Fleet HQ' project whose chats are ALL hidden fleet artifacts", async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C('sup-1', 'Fleet Supervisor', 'p-hq', true),
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([P('p-hq', 'Fleet HQ')]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.projectIds).toEqual(['p-hq']);
  });

  it('hides a folder containing ONLY supervisor(-titled) chats', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C('sup-1', 'Fleet Supervisor', 'p-fleet', true),
      C('sup-legacy', 'Fleet Supervisor', 'p-fleet', false, STOCK_PROMPT),
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([P('p-fleet', 'Agents')]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.chatIds).toEqual(['sup-1', 'sup-legacy']);
    expect(r.projectIds).toEqual(['p-fleet']);
  });

  // ── Framework surface (ticket 9471d338): the platform's own project never ────
  // renders in the sidebar. Identity = repoUrl → the instance's own repo slug
  // (production: example-org/crossmodel) — the same resolution the backend
  // guards use. Hides EVEN when it holds no chats (fresh instance), and its
  // lanes hide with it wherever they are filed.
  it('hides the framework project (repoUrl = own repo) even when it holds NO chats', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-fw', name: 'crossmodel', repoUrl: 'https://github.com/example-org/crossmodel' },
      P('p-user', 'Schooltime'),
    ]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.projectIds).toEqual(['p-fw']);
    expect(r.chatIds).toEqual([]);
  });

  it('hides every chat FILED in the framework project (its lanes leave the sidebar with it)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C('fw-op', 'Framework Operator', 'p-fw'),
      C('fw-lane', 'Ticket lane', 'p-fw'),
      C('c1', 'My research', null),
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-fw', name: 'crossmodel', repoUrl: 'example-org/crossmodel' },
    ]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.chatIds).toEqual(['fw-op', 'fw-lane']);
    expect(r.projectIds).toEqual(['p-fw']);
  });

  it('never hides a same-named user project (no repoUrl) — identity is the repo, never the name', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([C('c1', 'Notes', 'p-named')]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-named', name: 'crossmodel', repoUrl: null },
    ]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.chatIds).toEqual([]);
    expect(r.projectIds).toEqual([]);
  });

  it('a non-github repoUrl project stays a user folder', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-other', name: 'Other repo', repoUrl: 'https://github.com/paul/schooltime' },
    ]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.projectIds).toEqual([]);
  });

  it('NEVER hides a MIXED folder (supervisor chat + a legit user chat)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C('sup-1', 'Fleet Supervisor', 'p-mixed', true),
      C('c1', 'My research', 'p-mixed'),
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([P('p-mixed', 'Agents')]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r.chatIds).toEqual(['sup-1']); // the supervisor chat itself is still hidden
    expect(r.projectIds).toEqual([]); // but its folder stays — hiding it would strand c1
  });

  it('leaves a normal user project (no fleet artifacts) untouched', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C('c1', 'My research', 'p-work'),
      C('c2', 'Weekend plan', 'p-work'),
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([P('p-work', 'Work')]);
    const r = await fleet.getSidebarHiddenFleetArtifacts(OWNER);
    expect(r).toEqual({ chatIds: [], projectIds: [] });
  });

  it('surfaces the same hidden ids on getFleetSupervisor (supervisor shape unchanged)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      C(SUP, 'Fleet Supervisor', null, true),
      C('c1', 'My research', null),
    ]);
    const r = await fleet.getFleetSupervisor(OWNER);
    expect(r.supervisor).toMatchObject({ id: SUP });
    expect(r.hidden).toEqual({ chatIds: [SUP], projectIds: [] });
  });
});

// ── Overview ──────────────────────────────────────────────────────────────────

describe('getFleetOverview', () => {
  it('aggregates counts + summary rows without transcripts', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: SUP, title: 'Supervisor', projectId: 'p1' },
      { id: 'c2', title: 'Other', projectId: null },
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p1', name: 'Work', color: 'violet', emoji: '📁', supervised: true, updatedAt: D('10:00:00') },
    ]);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: 'c2', title: 'Other', status: 'running', branch: 'digby/session-c2', model: 'glm-5.2', updatedAt: D('11:00:00') },
    ]);
    mockPrisma.chatSchedule.findMany.mockResolvedValue([
      { id: 'sch1', sessionId: SUP, prompt: 'x'.repeat(150), kind: 'recurring', intervalSec: 900, nextRunAt: D('12:00:00'), enabled: true, lastStatus: 'started', runsCount: 3 },
    ]);
    mockPrisma.chatSchedule.count.mockResolvedValue(1);
    mockPrisma.pendingChatMessage.count.mockResolvedValue(2);
    startLiveRun('c2'); // coding runs key on the bare chat id
    try {
      const r = await fleet.getFleetOverview(OWNER);
      expect(r.supervisor).toMatchObject({ id: SUP });
      expect(r.counts).toEqual({ chats: 2, projects: 1, runningSessions: 1, enabledSchedules: 1, totalSchedules: 1, queuedMessages: 2 });
      expect(mockPrisma.pendingChatMessage.count).toHaveBeenCalledWith({ where: { userId: OWNER } });
      expect(r.projects[0]).toMatchObject({ id: 'p1', chatCount: 1, runningCount: 0, supervised: true });
      expect(r.sessions[0]).toMatchObject({ chatId: 'c2', status: 'running', running: true });
      expect(r.schedules[0]).toMatchObject({ id: 'sch1', chatId: SUP, chatTitle: 'Supervisor', runsCount: 3 });
      expect(r.schedules[0].promptSnippet).toHaveLength(100);
    } finally {
      endLiveRun('c2');
    }
  });

  it('project rows carry the supervised flag (fleet-supervision opt-out, ticket c992d730)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: SUP, title: 'Supervisor', projectId: null },
      { id: 'c2', title: 'Old project chat', projectId: 'p-ret' },
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-ret', name: 'Retired', color: 'amber', emoji: '🗄️', supervised: false, updatedAt: D('10:00:00') },
    ]);
    const r = await fleet.getFleetOverview(OWNER);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]).toMatchObject({ id: 'p-ret', supervised: false, chatCount: 1 });
  });

  it('the hidden USER-SPACE project never appears in the projects table or the projects count (User Space P3)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: SUP, title: 'Supervisor', projectId: null },
      // Auto-filed chats live in the space — they must NOT materialize a
      // "Workspace" card holding every chat (they render as ungrouped).
      { id: 'c2', title: 'Filed chat', projectId: 'p-space' },
      { id: 'c3', title: 'Work chat', projectId: 'p1' },
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p1', name: 'Work', color: 'violet', emoji: '📁', supervised: true, isUserSpace: false, updatedAt: D('10:00:00') },
      { id: 'p-space', name: 'Workspace', color: null, emoji: null, supervised: false, isUserSpace: true, updatedAt: D('10:00:00') },
    ]);
    const r = await fleet.getFleetOverview(OWNER);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]).toMatchObject({ id: 'p1', chatCount: 1 });
    expect(r.counts.projects).toBe(1);
    expect(r.counts.chats).toBe(3); // the chats themselves still count
  });

  it('counts enabledSchedules with a REAL count query, not the take:100-capped list', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([
      { id: 'sch1', sessionId: SUP, prompt: 'p', kind: 'recurring', intervalSec: 900, nextRunAt: D('12:00:00'), enabled: true, lastStatus: null, runsCount: 0 },
    ]);
    // An automation-heavy user: 120 enabled schedules, only 1 in the capped list.
    mockPrisma.chatSchedule.count.mockResolvedValue(120);
    const r = await fleet.getFleetOverview(OWNER);
    expect(mockPrisma.chatSchedule.count).toHaveBeenCalledWith({ where: { userId: OWNER, enabled: true } });
    expect(r.counts.enabledSchedules).toBe(120);
    expect(r.schedules).toHaveLength(1); // the table stays the 100-soonest page
  });

  it('counts a WORKER-executed coding run (agent_runs row, no registry entry) — P5 audit', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: SUP, title: 'Supervisor', projectId: null },
      { id: 'c2', title: 'Coding', projectId: null },
    ]);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: 'c2', title: 'Coding', status: 'running', branch: 'digby/session-c2', model: 'glm-5.2', updatedAt: D('11:00:00') },
    ]);
    // The run executes in the worker: the web registry is empty, only the
    // durable agent_runs row exists. Pre-fix runningSessions showed 0 here.
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 'c2' }]);
    const r = await fleet.getFleetOverview(OWNER);
    expect(r.counts.runningSessions).toBe(1);
    expect(r.sessions[0]).toMatchObject({ chatId: 'c2', running: true });
    // Batched, never per-chat: ONE MGET for all non-local chats, ONE agent_runs query.
    expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledTimes(1);
  });

  it("counts a chat run on the OTHER instance (Redis liveness key, no local registry entry)", async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: SUP, title: 'Supervisor', projectId: null },
    ]);
    redisStore.set(`cm:liverun:${SUP}`, '12345'); // instance A's heartbeat owns it
    const r = await fleet.getFleetOverview(OWNER);
    expect(r.counts.runningSessions).toBe(1);
    expect(r.supervisor).toMatchObject({ running: true });
  });

  it('excludes hidden fleet artifacts (Fleet HQ, fleet-dedicated folders) from projects rows + count', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: SUP, title: 'Supervisor', projectId: 'p-fleet', isSupervisor: true }, // hidden chat
      { id: 'c1', title: 'My research', projectId: 'p-work', isSupervisor: false },
      { id: 'c2', title: 'Plans', projectId: 'p-work', isSupervisor: false },
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-fleet', name: 'Agents', color: null, emoji: null, updatedAt: D('10:00:00') }, // only hidden chats → hidden
      { id: 'p-hq', name: 'Fleet HQ', color: null, emoji: null, updatedAt: D('10:00:00') }, // name match — hidden even empty
      { id: 'p-work', name: 'Work', color: 'violet', emoji: '📁', updatedAt: D('11:00:00') },
    ]);
    const r = await fleet.getFleetOverview(OWNER);
    expect(r.projects.map((p) => p.id)).toEqual(['p-work']);
    expect(r.projects[0]).toMatchObject({ chatCount: 2, runningCount: 0 });
    expect(r.counts.projects).toBe(1);
    // chats count is deliberately unfiltered (sidebar concern only) — pinned:
    expect(r.counts.chats).toBe(3);
  });

  it('keeps a MIXED folder (supervisor chat + user chat) in the projects table', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: SUP, title: 'Supervisor', projectId: 'p-mixed', isSupervisor: true },
      { id: 'c1', title: 'My research', projectId: 'p-mixed', isSupervisor: false },
    ]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-mixed', name: 'Agents', color: null, emoji: null, updatedAt: D('10:00:00') },
    ]);
    const r = await fleet.getFleetOverview(OWNER);
    expect(r.projects.map((p) => p.id)).toEqual(['p-mixed']);
    expect(r.projects[0]).toMatchObject({ chatCount: 2 }); // hidden chat still counts in its visible folder
    expect(r.counts.projects).toBe(1);
  });

  it('returns hooks with resolved titles — wildcard sourceChatId=null has sourceTitle=null', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: SUP, title: 'Supervisor', projectId: null },
      { id: 'c2', title: 'Other', projectId: null },
    ]);
    mockPrisma.eventHook.findMany.mockResolvedValue([
      {
        id: 'h-wild', userId: OWNER, sourceChatId: null, targetChatId: SUP, // the supervisor's wildcard hook
        eventTypes: ['run_completed', 'run_failed'], enabled: true, debounceSec: 60,
        lastFiredAt: D('12:30:00'), createdAt: D('09:00:00'),
      },
      {
        id: 'h-pair', userId: OWNER, sourceChatId: 'c2', targetChatId: 'gone', // deleted target → null title
        eventTypes: ['attention_needed'], enabled: false, debounceSec: 30,
        lastFiredAt: null, createdAt: D('10:00:00'),
      },
    ]);
    const r = await fleet.getFleetOverview(OWNER);
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith({
      where: { userId: OWNER },
      orderBy: { createdAt: 'asc' },
    });
    expect(r.hooks).toEqual([
      {
        id: 'h-wild', sourceChatId: null, sourceTitle: null, // wildcard = all chats
        targetChatId: SUP, targetTitle: 'Supervisor',
        eventTypes: ['run_completed', 'run_failed'], enabled: true, debounceSec: 60,
        lastFiredAt: D('12:30:00'),
      },
      {
        id: 'h-pair', sourceChatId: 'c2', sourceTitle: 'Other',
        targetChatId: 'gone', targetTitle: null,
        eventTypes: ['attention_needed'], enabled: false, debounceSec: 30,
        lastFiredAt: null,
      },
    ]);
  });
});

// ── Interactive thread classification ─────────────────────────────────────────

describe('getSupervisorThread', () => {
  // Chronological fixture: machine noise interleaved with a real exchange.
  //   m1 user    (no origin) "wake up and check"   — retro-matches a schedule prompt → NOISE
  //   m2 asst    (no origin)                        — inherits m1's noise → excluded
  //   m3 user    (no origin) "what did you find?"   — interactive
  //   m4 asst    (no origin)                        — inherits interactive → included
  //   m5 user    origin 'schedule'                  — NOISE
  //   m6 asst    origin 'schedule'                  — own origin → NOISE
  //   m7 user    origin 'agent'                     — NOISE (another agent talking)
  //   m8 asst    (no origin)                        — inherits m7's noise → excluded
  const ROWS = [
    M('m1', 'user', 'wake up and check', D('08:00:00')),
    M('m2', 'assistant', 'Checked — all green.', D('08:00:30')),
    M('m3', 'user', 'what did you find?', D('09:00:00')),
    M('m4', 'assistant', 'Nothing new.', D('09:00:20')),
    M('m5', 'user', 'hourly status sweep', D('10:00:00'), { origin: 'schedule' }),
    M('m6', 'assistant', 'Status: nominal.', D('10:00:25'), { origin: 'schedule' }),
    M('m7', 'user', 'ping from agent', D('11:00:00'), { origin: 'agent', sourceChatId: 'chat-9' }),
    M('m8', 'assistant', 'Acknowledged.', D('11:00:10')),
  ];
  const NEWEST_FIRST = [...ROWS].reverse();

  it('filters machine noise (marked + retro-matched) and keeps the interactive exchange', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ prompt: 'wake up and check' }]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(NEWEST_FIRST);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r.chatId).toBe(SUP);
    expect(r.messages.map((m: any) => m.id)).toEqual(['m3', 'm4']); // chronological
    expect(r.messages.every((m: any) => m.origin === 'user')).toBe(true);
    expect(r.hasMore).toBe(false);
    expect(r.queuedCount).toBe(0);
    expect(r.running).toBe(false);
  });

  it('includeMachine: true returns the FULL transcript — machine turns visible with their origin stamps (feedback 18061f31)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ prompt: 'wake up and check' }]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(NEWEST_FIRST);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50, includeMachine: true } as any);
    // The pane bug: machine-triggered wake prompts + replies vanished the moment
    // a run finished (visible only in Logs). Opt-in includes them in order.
    expect(r.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
    const byId = Object.fromEntries(r.messages.map((m: any) => [m.id, m]));
    expect(byId.m5.origin).toBe('schedule');
    expect(byId.m7.origin).toBe('agent');
    expect(byId.m3.origin).toBe('user');
    expect(r.hasMore).toBe(false);
  });

  it('reports the live queue depth from main\'s busy-chat queue', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([M('m1', 'user', 'hi', D('08:00:00'))]);
    mockCountPending.mockResolvedValue(2);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(mockCountPending).toHaveBeenCalledWith(SUP);
    expect(r.queuedCount).toBe(2);
  });

  it('surfaces metadata.attachments as filename+type chips; malformed metadata renders none', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m2', 'user', 'with a malformed row', D('08:01:00'), { attachments: 'not-an-array' }),
      M('m1', 'user', 'see attached', D('08:00:00'), { attachments: [{ filename: 'shot.png', type: 'image' }, { filename: 'spec.pdf', type: 'pdf' }] }),
    ]);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']); // chronological
    expect(r.messages[0].attachments).toEqual([
      { filename: 'shot.png', type: 'image' },
      { filename: 'spec.pdf', type: 'pdf' },
    ]);
    expect(r.messages[1].attachments).toBeUndefined();
    // No chip carries an uploadId → ZERO chat_files queries (c6e8edda).
    expect(mockPrisma.chatFile.findMany).not.toHaveBeenCalled();
  });

  it('chips with an uploadId gain fileId + mimeType from ONE batched ChatFile lookup (c6e8edda); unmatched chips pass through', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m1', 'user', 'see attached', D('08:00:00'), {
        attachments: [
          { filename: 'shot.png', type: 'image', uploadId: 'up-1' },
          { filename: 'gone.png', type: 'image', uploadId: 'up-expired' }, // no ChatFile row — unchanged
        ],
      }),
    ]);
    mockPrisma.chatFile.findMany.mockResolvedValue([{ id: 'file-1', uploadId: 'up-1', mimeType: 'image/png' }]);

    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });

    expect(mockPrisma.chatFile.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatFile.findMany).toHaveBeenCalledWith({
      where: { chatId: SUP, uploadId: { in: ['up-1', 'up-expired'] } },
      select: { id: true, uploadId: true, mimeType: true },
    });
    expect(r.messages[0].attachments).toEqual([
      { filename: 'shot.png', type: 'image', uploadId: 'up-1', fileId: 'file-1', mimeType: 'image/png' },
      { filename: 'gone.png', type: 'image', uploadId: 'up-expired' },
    ]);
  });

  it('an assistant row with no preceding user row in the window stays interactive', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([M('m9', 'assistant', 'orphan reply', D('12:00:00'))]);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.id)).toEqual(['m9']);
  });

  it('pages backward via the before cursor (message id → tie-safe (createdAt, id) bound)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ chatId: SUP, createdAt: D('09:00:00') });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([M('m1', 'user', 'old', D('08:00:00'))]);
    const r = await fleet.getSupervisorThread(OWNER, { before: 'm3', limit: 50 });
    // The id tiebreak keeps siblings sharing the cursor row's millisecond reachable.
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        chatId: SUP,
        OR: [{ createdAt: { lt: D('09:00:00') } }, { createdAt: D('09:00:00'), id: { lt: 'm3' } }],
      },
    }));
    expect(r.messages.map((m: any) => m.id)).toEqual(['m1']);
  });

  it('rejects a cursor belonging to another chat (400)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ chatId: 'other', createdAt: D('09:00:00') });
    await expect(fleet.getSupervisorThread(OWNER, { before: 'mx' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('scans PAST an all-noise newest window to reach the interactive rows behind it', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    // limit 2 → each raw fetch takes 3 (take+1 probe). Five newest raw pages
    // are 100% schedule noise (hasMore stays true through the cheap 5-page
    // budget); the 6th page holds the last real exchange. Before the
    // scan-deeper fix the first page returned [] here and the client rendered
    // a fake empty thread ("i see no messages", owner report 2026-08-15).
    const noisePage = (p: number) => [
      M(`n${p}-c`, 'assistant', 'All nominal.', D(`${15 - p}:00:30`), { origin: 'schedule' }),
      M(`n${p}-b`, 'assistant', 'Sweep done.', D(`${15 - p}:00:20`), { origin: 'schedule' }),
      M(`n${p}-a`, 'user', 'hourly sweep', D(`${15 - p}:00:00`), { origin: 'schedule' }),
    ];
    for (let p = 0; p < 5; p++) {
      mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce(noisePage(p));
    }
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([
      M('m2', 'assistant', 'Nothing new.', D('09:00:20')),
      M('m1', 'user', 'what did you find?', D('09:00:00')),
    ]);

    const first = await fleet.getSupervisorThread(OWNER, { limit: 2 });
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledTimes(6);
    expect(first.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']); // chronological
    expect(first.hasMore).toBe(false); // the interactive page was the transcript floor
  });

  it('all-noise beyond the hard scan cap → honest empty page with a usable nextBefore; the follow-up reaches the interactive rows', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    // 40 straight pages (the hard cap) of schedule noise, 3 rows each (limit 2
    // + 1 probe row → hasMore stays true through the whole scan).
    const noiseAt = (p: number, sec: number) => new Date(D('15:00:00').getTime() - p * 60_000 + sec * 1000);
    for (let p = 0; p < 40; p++) {
      mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([
        M(`n${p}-c`, 'assistant', 'All nominal.', noiseAt(p, 30), { origin: 'schedule' }),
        M(`n${p}-b`, 'assistant', 'Sweep done.', noiseAt(p, 20), { origin: 'schedule' }),
        M(`n${p}-a`, 'user', 'hourly sweep', noiseAt(p, 0), { origin: 'schedule' }),
      ]);
    }

    const first = await fleet.getSupervisorThread(OWNER, { limit: 2 });
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledTimes(40);
    expect(first.messages).toEqual([]); // the whole scanned window was noise
    expect(first.hasMore).toBe(true);
    // The cursor is the OLDEST raw row examined in the final fetch (n39-b) —
    // WITHOUT it the client's "Load earlier" renders but can never fire.
    expect(first.nextBefore).toBe('n39-b');

    // Follow-up with that cursor resolves its (createdAt, id) and fetches older raw…
    mockPrisma.crossModelMessage.findUnique.mockResolvedValue({ chatId: SUP, createdAt: noiseAt(39, 20) });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m2', 'assistant', 'Nothing new.', D('09:00:20')),
      M('m1', 'user', 'what did you find?', D('09:00:00')),
    ]);
    const second = await fleet.getSupervisorThread(OWNER, { before: first.nextBefore, limit: 2 });
    expect(mockPrisma.crossModelMessage.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'n39-b' } }),
    );
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {
        chatId: SUP,
        OR: [{ createdAt: { lt: noiseAt(39, 20) } }, { createdAt: noiseAt(39, 20), id: { lt: 'n39-b' } }],
      },
    }));
    expect(second.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
    expect(second.hasMore).toBe(false);
  });

  it('is an HONEST READ: no supervisor → empty thread shape, NEVER provisions', async () => {
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r).toEqual({ chatId: null, running: false, queuedCount: 0, queuedUserCount: 0, messages: [], hasMore: false });
    expect(mockEnsureFleetSupervisor).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('F3: the page carries queuedUserCount (the USER-typed subset) alongside queuedCount — the honest Status source', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([M('m1', 'user', 'hello', D('10:00:00'))]);
    mockCountPending.mockResolvedValue(3);      // 2 machine relays + 1 owner send…
    mockCountPendingUser.mockResolvedValue(1);  // …of which ONE is the owner's
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r.queuedCount).toBe(3);
    expect(r.queuedUserCount).toBe(1);
    expect(mockCountPendingUser).toHaveBeenCalledWith(SUP);
  });

  it('ticket 56d6b204: a hook-origin user row carrying metadata.childResult flattens childResult:true on its messages item (and a plain hook row without it does not)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    // A delivered child→parent result wake next to an ordinary hook wake —
    // the client's grouping probe reads `childResult` off the group's ANCHOR
    // row to mount the machine turn EXPANDED (the 2026-09-25 incident,
    // chat 6e36c834: the sub-session's completed DB-audit result stayed
    // hidden behind the collapsed accordion).
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m2', 'user', 'Fleet event from chat "X" (run_completed): routine completion', D('11:00:00'), { origin: 'hook' }),
      M('m1', 'user', 'Your sub-session "DB audit" (chat c-child) reported run_completed: all tables verified', D('10:00:00'), { origin: 'hook', childResult: true }),
    ]);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50, includeMachine: true } as any);
    const byId = Object.fromEntries(r.messages.map((m: any) => [m.id, m]));
    expect(r.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']); // chronological
    // The child-result wake flattens the expansion signal…
    expect(byId.m1.origin).toBe('hook');
    expect(byId.m1.childResult).toBe(true);
    // …and the ordinary hook wake (same shape, no metadata.childResult) does not.
    expect(byId.m2.origin).toBe('hook');
    expect(byId.m2.childResult).toBeUndefined();
  });

  it('fixer 2026-09-27 (upward-chatter-1): metadata.ownerAskReply flattens ownerAskReply:true on the owner-ask wake anchor and its answering reply (an ordinary hook row does not)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m3', 'user', 'Fleet event from chat "X" (run_completed): routine completion', D('12:00:00'), { origin: 'hook' }),
      M('m2', 'assistant', 'We are at 5.08 tok/s of record (msg 871d203b).', D('11:00:00'), { origin: 'hook', engine: 'agent', ownerAskReply: true }),
      M('m1', 'user', '[OWNER ASK UNANSWERED] The owner asked "what is going on" (msg 871d203b) …', D('10:00:00'), { origin: 'hook', ownerAskReply: true, ownerAskMessageIds: ['871d203b'] }),
    ]);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50, includeMachine: true } as any);
    const byId = Object.fromEntries(r.messages.map((m: any) => [m.id, m]));
    expect(byId.m1.ownerAskReply).toBe(true);
    expect(byId.m2.ownerAskReply).toBe(true);
    expect(byId.m3.ownerAskReply).toBeUndefined();
  });
});

// ── Send with queue ───────────────────────────────────────────────────────────

describe('getLatestSupervisorWakeNote (dashboard Fleet-summary card, platform task 2026-09-03)', () => {
  // Newest-first pages (fetchRawMessages orders createdAt desc):
  //   m8 user    origin 'user'     — the owner typing (interactive)
  //   m7 asst    origin 'schedule' — THE latest wake note ← must win
  //   m6 asst    (no origin)       — empty content, skipped
  //   m5 user    origin 'schedule' — the wake envelope
  //   m4 asst    (no origin)       — inherits m5's noise (legacy note, older)
  //   m3 user    (no origin)       — interactive
  const P1 = [
    M('m8', 'user', 'thanks', D('12:00:00'), { origin: 'user' }),
    M('m7', 'assistant', '**Fleet wake — 2 lanes green**\n\nDetails.', D('11:00:30'), { origin: 'schedule' }),
    M('m6', 'assistant', '  ', D('11:00:20')),
    M('m5', 'user', '[MACHINE-TRIGGERED RUN — SCHEDULED MESSAGE FIRED]', D('11:00:00'), { origin: 'schedule' }),
    M('m4', 'assistant', 'older wake note', D('10:00:30')),
    M('m3', 'user', 'what is up', D('09:00:00')),
  ];

  it('returns the NEWEST machine assistant note from the durable transcript (single source of truth)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(P1);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.chatId).toBe(SUP);
    expect(r.note?.id).toBe('m7');
    expect(r.note?.content).toContain('Fleet wake — 2 lanes green');
    expect(r.note?.createdAt).toBe(P1[1].createdAt.toISOString());
  });

  it('skips empty notes and interactive rows — falls through to the older machine note', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    // Only a legacy (origin-inherited) note exists: the wake envelope n1
    // PRECEDES the note n2 chronologically, so n2 inherits its noise.
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('n2', 'assistant', 'older wake note', D('10:00:30')),
      M('n1', 'user', '[MACHINE-TRIGGERED RUN — SCHEDULED MESSAGE FIRED]', D('10:00:00'), { origin: 'schedule' }),
      M('n0', 'user', 'what is up', D('09:00:00')),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('n2');
  });

  it('null note when the transcript has no machine notes; null chatId when no supervisor exists', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([M('m3', 'user', 'what is up', D('09:00:00'))]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.chatId).toBe(SUP);
    expect(r.note).toBeNull();

    mockFindFleetSupervisorChat.mockResolvedValue(null);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    const r2 = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r2).toEqual({ chatId: null, note: null });
  });

  it('skips a one-line no-op wake note and falls back to the last SUBSTANTIVE note (feedback f3256715)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    // Newest note = the owner-directed no-op one-liner; the older note is the
    // real summary the card must surface instead.
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('k3', 'assistant', 'WAKE: no-op (LiteLLM Gateway poller tick — plan 5/5, healthy)', D('12:00:30'), { origin: 'schedule' }),
      M('k2', 'user', '[MACHINE-TRIGGERED RUN — SCHEDULED MESSAGE FIRED]', D('12:00:00'), { origin: 'schedule' }),
      M('k1', 'assistant', '**Fleet wake — 2 lanes green**\n\nDetails.', D('11:00:30'), { origin: 'schedule' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('k1');
    expect(r.note?.content).toContain('Fleet wake — 2 lanes green');
  });

  it('a multi-line note whose headline MENTIONS no-ops is substantive — no false positive (f3256715)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('k5', 'assistant', '**Fleet wake — 2 lane completions, both no-ops**\n\nDetails.', D('12:00:30'), { origin: 'schedule' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('k5');
  });

  it('degenerate all-no-op window → the NEWEST no-op note still renders (never an empty card)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('k8', 'assistant', 'WAKE: no-op (poller tick)', D('12:00:30'), { origin: 'schedule' }),
      M('k7', 'assistant', 'wake: NO OP — nothing moved', D('11:00:30'), { origin: 'schedule' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('k8');
  });

  it('isNoopWakeNote: one-line markers classify; multi-line or unmarked content does not', () => {
    expect(fleet.isNoopWakeNote('WAKE: no-op (tick)')).toBe(true);
    expect(fleet.isNoopWakeNote('No op.')).toBe(true);
    expect(fleet.isNoopWakeNote('wake: NO-OPS tonight')).toBe(true);
    expect(fleet.isNoopWakeNote('**Fleet wake — 2 lane completions, both no-ops**\n\nDetails.')).toBe(false);
    expect(fleet.isNoopWakeNote('older wake note')).toBe(false);
    expect(fleet.isNoopWakeNote('')).toBe(false);
    expect(fleet.isNoopWakeNote('  \n ')).toBe(false);
  });

  it('stamps kind "wake" on every technical note it returns (additive shape, owner 2026-09-04)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(P1);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.kind).toBe('wake');
  });
});

describe('getLatestSupervisorWakeNote — owner briefings (owner 2026-09-04: plain-English layer)', () => {
  // Freshness is measured against the REAL clock (24h window) — fixtures use
  // relative times, unlike the stale absolute dates above.
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000);
  const BRIEFING = 'Your fleet finished its checks and everything is healthy. Nothing needs you right now.';

  it('prefers the newest briefing within 24h — even over a NEWER technical wake note — with kind "briefing"', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      // Newest-first: the wake note is NEWER than the briefing; the briefing still wins.
      M('w2', 'assistant', '**Fleet wake — digest relayed**\n\nDetails.', ago(10), { origin: 'schedule' }),
      M('b1', 'assistant', BRIEFING, ago(30), { kind: 'owner_briefing', sourceNoteId: 'w1' }),
      M('w1', 'assistant', '**Fleet wake — 2 lanes green**\n\nDetails.', ago(45), { origin: 'schedule' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('b1');
    expect(r.note?.kind).toBe('briefing');
    expect(r.note?.content).toBe(BRIEFING);
    // A briefing already exists in-window — the bootstrap must NOT fire.
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });

  it('a briefing OLDER than 24h never outranks a newer wake note — the technical note returns and the bootstrap fires from it', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('w1', 'assistant', '**Fleet wake — 2 lanes green**\n\nDetails.', ago(60), { origin: 'schedule' }),
      M('b0', 'assistant', BRIEFING, ago(25 * 60), { kind: 'owner_briefing' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('w1');
    expect(r.note?.kind).toBe('wake');
    expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
    expect(mockGenerateOwnerBriefing).toHaveBeenCalledWith({
      chatId: SUP,
      userId: OWNER,
      noteContent: '**Fleet wake — 2 lanes green**\n\nDetails.',
      sourceNoteId: 'w1',
    });
  });

  it('BOOTSTRAP: no briefing + a fresh clean wake note → returns the technical fallback for THIS request and fire-and-forgets a briefing', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('w1', 'assistant', '**Fleet wake — nudged one stalled lane**\n\nDetails.', ago(90), { origin: 'schedule' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('w1'); // this request still gets the technical parse
    expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
    expect(mockGenerateOwnerBriefing.mock.calls[0][0].sourceNoteId).toBe('w1');
  });

  it('a fresh no-op one-liner is a CLEAN note — the bootstrap fires from it too (the owner-complaint shape)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('k1', 'assistant', 'WAKE — 03:43Z. No-op; chain still gated, no action.', ago(20), { origin: 'schedule' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('k1');
    expect(r.note?.kind).toBe('wake');
    expect(mockGenerateOwnerBriefing).toHaveBeenCalledTimes(1);
  });

  it('no bootstrap from a STALE wake note (a fresh-timestamped briefing about day-old state would mislead)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('w1', 'assistant', '**Fleet wake — 2 lanes green**\n\nDetails.', ago(25 * 60), { origin: 'schedule' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('w1');
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });

  it('no bootstrap from a verifier-STRUCK fallback (guard chrome is not a clean note)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('s1', 'assistant', '[ACTION VERIFIER — MACHINE-WAKE NOTE STRUCK]\nreplaced', ago(15), { origin: 'schedule' }),
    ]);
    const r = await fleet.getLatestSupervisorWakeNote(OWNER);
    expect(r.note?.id).toBe('s1'); // last-resort fallback still renders
    expect(mockGenerateOwnerBriefing).not.toHaveBeenCalled();
  });
});

describe('getSupervisorThread — owner-briefing classifier exemption (owner 2026-09-04)', () => {
  // Chronological shape under test: wake w1 → its note a1 → the BRIEFING b1 →
  // the next wake w2. The briefing is the only interactive row; the wake turns
  // around it keep their noise classification (inheritance not broken).
  const T = [
    M('w2', 'user', '[MACHINE-TRIGGERED RUN — SCHEDULED MESSAGE FIRED]', D('13:00:00'), { origin: 'schedule' }),
    M('b1', 'assistant', 'Your fleet is healthy. Nothing needs you.', D('12:00:40'), { kind: 'owner_briefing', sourceNoteId: 'a1' }),
    M('a1', 'assistant', '**Fleet wake — 2 lanes green**\n\nDetails.', D('12:00:30')),
    M('w1', 'user', '[MACHINE-TRIGGERED RUN — SCHEDULED MESSAGE FIRED]', D('12:00:00'), { origin: 'schedule' }),
  ];

  it('the default (interactive) thread KEEPS the briefing as a regular assistant row — never machine noise', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(T);
    const page = await fleet.getSupervisorThread(OWNER, {});
    expect(page.messages.map((m) => m.id)).toEqual(['b1']);
    expect(page.messages[0].kind).toBe('owner_briefing');
    expect(page.messages[0].origin).toBe('briefing');
  });

  it('includeMachine: the briefing rides with its kind stamped while the surrounding wake turns stay noise-classified (inheritance unbroken)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(T);
    const page = await fleet.getSupervisorThread(OWNER, { includeMachine: true });
    expect(page.messages.map((m) => m.id)).toEqual(['w1', 'a1', 'b1', 'w2']);
    const byId = new Map(page.messages.map((m) => [m.id, m]));
    // The briefing did NOT break the wake note's inheritance: a1 (no own
    // origin) still inherits w1's machine origin.
    expect(byId.get('a1')!.origin).toBe('schedule');
    expect(byId.get('a1')!.kind).toBeUndefined();
    expect(byId.get('b1')!.origin).toBe('briefing');
    expect(byId.get('b1')!.kind).toBe('owner_briefing');
    expect(byId.get('w2')!.origin).toBe('schedule');
  });

  // ── Ticket 77c3a7e9: the owner-armed scheduled digest ANSWER is exempt
  // from noise classification (the owner's "buried in accordion" report) —
  // the row keeps its own origin 'schedule' (stamped by chat-agent finalize
  // alongside kind 'owner_digest'), so without this exemption the own-origin
  // branch would noise-classify it and the thread's noise filter would drop
  // it entirely. Parity: frontend machine-turn-grouping isOwnerDigest.
  it('ticket 77c3a7e9 — an owner_digest answer row is NEVER noise: default thread keeps it; includeMachine flattens its kind (frontend exemption parity)', async () => {
    mockSupervisorProvisioned();
    // Chronology: wake w1 → digest answer d1 (origin 'schedule', kind
    // 'owner_digest') → the next wake w2. The digest is interactive content.
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('w2', 'user', '[MACHINE-TRIGGERED RUN — SCHEDULED MESSAGE FIRED]', D('13:00:00'), { origin: 'schedule' }),
      M('d1', 'assistant', '**Daily digest — 3 items**\n\nThe morning X digest.', D('12:00:40'), { origin: 'schedule', kind: 'owner_digest' }),
      M('a1', 'assistant', 'wake internals', D('12:00:30')),
      M('w1', 'user', '[MACHINE-TRIGGERED RUN — SCHEDULED MESSAGE FIRED]', D('12:00:00'), { origin: 'schedule' }),
    ]);
    // Default (interactive) thread: the digest row survives the noise filter.
    const page = await fleet.getSupervisorThread(OWNER, {});
    expect(page.messages.map((m) => m.id)).toEqual(['d1']);
    expect(page.messages[0].kind).toBe('owner_digest');
    expect(page.messages[0].origin).toBe('digest');
    // includeMachine: the digest rides with its kind flattened so the client
    // grouping probe can exempt it; the wake turns keep their noise states.
    const full = await fleet.getSupervisorThread(OWNER, { includeMachine: true });
    expect(full.messages.map((m) => m.id)).toEqual(['w1', 'a1', 'd1', 'w2']);
    const byId = new Map(full.messages.map((m) => [m.id, m]));
    expect(byId.get('d1')!.kind).toBe('owner_digest');
    expect(byId.get('d1')!.origin).toBe('digest');
    expect(byId.get('w1')!.origin).toBe('schedule');
    expect(byId.get('a1')!.origin).toBe('schedule');
    expect(byId.get('w2')!.origin).toBe('schedule');
  });
});

describe('sendSupervisorMessage', () => {
  it('idle supervisor → delivers immediately (run started), nothing queued', async () => {
    mockSupervisorProvisioned();
    mockSendChatMessage.mockResolvedValueOnce({ queued: true, chatId: SUP, mode: 'thinking' }); // no position = started
    const r = await fleet.sendSupervisorMessage(OWNER, 'hello supervisor');
    expect(r).toEqual({ queued: false });
    expect(mockSendChatMessage).toHaveBeenCalledWith({
      userId: OWNER, chatId: SUP, content: 'hello supervisor',
      userTurnAt: expect.any(Date), // a REAL user turn — the confirmation anchor
      origin: { kind: 'user' },
      timingSurface: 'fleet', // DW-5 measure-first (FO firing 68): the platform seam stamps supervisor_send_timing
    });
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
  });

  it('busy supervisor → platform.service enqueues internally; the position maps to the queued contract', async () => {
    mockSupervisorProvisioned();
    mockSendChatMessage.mockResolvedValueOnce({ ok: true, queued: true, chatId: SUP, position: 3, note: 'queued' });
    const r = await fleet.sendSupervisorMessage(OWNER, 'hold this');
    expect(r).toEqual({ queued: true, position: 3 });
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled(); // platform.service did it
  });

  it('409 fallback (coding-surface busy) → enqueues via main\'s message-queue with source user', async () => {
    mockSupervisorProvisioned();
    mockSendChatMessage.mockRejectedValueOnce(new AppError(409, 'busy'));
    mockEnqueueChatMessage.mockResolvedValueOnce({ id: 'pend-9', position: 2 });
    const r = await fleet.sendSupervisorMessage(OWNER, 'hold this');
    expect(r).toEqual({ queued: true, position: 2 });
    expect(mockEnqueueChatMessage).toHaveBeenCalledWith({
      chatId: SUP, userId: OWNER, content: 'hold this', source: 'user',
    });
  });

  it('non-409 send failures propagate (never silently queued)', async () => {
    mockSupervisorProvisioned();
    mockSendChatMessage.mockRejectedValueOnce(new AppError(403, 'forbidden'));
    await expect(fleet.sendSupervisorMessage(OWNER, 'hi')).rejects.toMatchObject({ statusCode: 403 });
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
  });

  it('a FULL queue\'s 409 propagates (the only remaining 409 on the send path)', async () => {
    mockSupervisorProvisioned();
    mockSendChatMessage.mockRejectedValueOnce(new AppError(409, 'Message queue is full for this chat (20 pending)'));
    mockEnqueueChatMessage.mockRejectedValueOnce(new AppError(409, 'Message queue is full for this chat (20 pending)'));
    await expect(fleet.sendSupervisorMessage(OWNER, 'hi')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('provisioning lives on the SEND path: a missing supervisor is ensured here', async () => {
    mockEnsureFleetSupervisor.mockResolvedValue({ id: SUP, title: 'Supervisor', userId: OWNER });
    mockSendChatMessage.mockResolvedValueOnce({ queued: true, chatId: SUP, mode: 'thinking' });
    const r = await fleet.sendSupervisorMessage(OWNER, 'hello');
    expect(mockEnsureFleetSupervisor).toHaveBeenCalledWith(OWNER);
    expect(r).toEqual({ queued: false });
  });

  it('500s when the supervisor cannot be provisioned', async () => {
    await expect(fleet.sendSupervisorMessage(OWNER, 'hi')).rejects.toMatchObject({ statusCode: 500 });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  // ── Attachments (uploadIds) ───────────────────────────────────────────────

  it('attachments: resolves uploads and threads agent inputs + chip metadata into the platform send', async () => {
    mockSupervisorProvisioned();
    mockLoadAttachment.mockImplementation(async (id: string) =>
      id === 'up-1'
        ? { type: 'image', filename: 'shot.png', mimeType: 'image/png', base64: 'QUJD' }
        : { type: 'document', filename: 'notes.txt', extractedText: 'x'.repeat(80) });
    const composite = { type: 'image', filename: 'shot.png', mimeType: 'image/png', base64: 'QUJD', extractedText: `[notes.txt]\n${'x'.repeat(80)}` };
    mockCombineAttachments.mockReturnValue(composite);
    const mapped = {
      userImages: [{ mediaType: 'image/png', data: 'QUJD', name: 'shot.png' }],
      documentText: '═══ UPLOADED DOCUMENT CONTENT …',
    };
    mockMapAttachmentForAgent.mockReturnValue(mapped);
    mockSendChatMessage.mockResolvedValueOnce({ queued: true, chatId: SUP, mode: 'thinking' });

    const r = await fleet.sendSupervisorMessage(OWNER, 'what do you see?', ['up-1', 'up-2']);

    expect(r).toEqual({ queued: false });
    expect(mockLoadAttachment).toHaveBeenCalledWith('up-1');
    expect(mockLoadAttachment).toHaveBeenCalledWith('up-2');
    // Merge is EXACTLY the plain-chat SSE path's (same helper, raw order kept).
    expect(mockCombineAttachments).toHaveBeenCalledWith([
      expect.objectContaining({ filename: 'shot.png' }),
      expect.objectContaining({ filename: 'notes.txt' }),
    ]);
    expect(mockMapAttachmentForAgent).toHaveBeenCalledWith(composite);
    expect(mockSendChatMessage).toHaveBeenCalledWith({
      userId: OWNER, chatId: SUP, content: 'what do you see?',
      userTurnAt: expect.any(Date),
      origin: { kind: 'user' },
      timingSurface: 'fleet', // DW-5 measure-first (FO firing 68)
      agentAttachments: mapped,
      attachmentMeta: [
        // Chips carry the staged uploadId (c6e8edda) — the read-time ChatFile
        // fileId injection joins on it for the inline-image render.
        { filename: 'shot.png', type: 'image', uploadId: 'up-1' },
        { filename: 'notes.txt', type: 'document', uploadId: 'up-2' },
      ],
      queueUploadIds: ['up-1', 'up-2'], // staged ids ride a potential queue (ac65d51e)
    });
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
  });

  it('busy + attachments (ac65d51e): the 409 fallback enqueue CARRIES the staged uploadIds', async () => {
    mockSupervisorProvisioned();
    mockLoadAttachment.mockResolvedValue({ type: 'document', filename: 'a.txt', extractedText: 'x'.repeat(80) });
    mockCombineAttachments.mockReturnValue({ type: 'document', filename: 'a.txt', extractedText: 'x'.repeat(80) });
    mockMapAttachmentForAgent.mockReturnValue({ documentText: '═══ …' });
    mockSendChatMessage.mockRejectedValueOnce(new AppError(409, 'A run is already in progress for this chat.'));
    mockEnqueueChatMessage.mockResolvedValueOnce({ id: 'pend-7', position: 3 });

    const r = await fleet.sendSupervisorMessage(OWNER, 'read this', ['up-1']);

    expect(r).toEqual({ queued: true, position: 3 });
    expect(mockEnqueueChatMessage).toHaveBeenCalledWith({
      chatId: SUP, userId: OWNER, content: 'read this', source: 'user', uploadIds: ['up-1'],
    });
  });

  it('expired/lost uploads on ALL staged ids → hard 410, NOTHING sent (ticket 1aefc929: never silently text-only)', async () => {
    mockSupervisorProvisioned();
    mockLoadAttachment.mockResolvedValue(null); // Redis TTL expired

    await expect(fleet.sendSupervisorMessage(OWNER, 'file expired?', ['up-gone']))
      .rejects.toMatchObject({ statusCode: 410, message: expect.stringContaining('attachment expired') });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
  });

  it('partial loss: the survivor sends AND the message carries the honest drop annotation (ticket 1aefc929)', async () => {
    mockSupervisorProvisioned();
    mockLoadAttachment.mockImplementation(async (id: string) =>
      id === 'up-1'
        ? { type: 'image', filename: 'shot.png', mimeType: 'image/png', base64: 'QUJD' }
        : null);
    const composite = { type: 'image', filename: 'shot.png', mimeType: 'image/png', base64: 'QUJD' };
    mockCombineAttachments.mockReturnValue(composite);
    const mapped = { userImages: [{ mediaType: 'image/png', data: 'QUJD', name: 'shot.png' }] };
    mockMapAttachmentForAgent.mockReturnValue(mapped);
    mockSendChatMessage.mockResolvedValueOnce({ queued: true, chatId: SUP, mode: 'thinking' });

    const r = await fleet.sendSupervisorMessage(OWNER, 'two shots', ['up-1', 'up-gone']);

    expect(r).toEqual({ queued: false });
    expect(mockSendChatMessage).toHaveBeenCalledWith({
      userId: OWNER, chatId: SUP,
      content: expect.stringContaining('1 attachment(s) expired') as unknown as string,
      userTurnAt: expect.any(Date),
      origin: { kind: 'user' },
      timingSurface: 'fleet', // DW-5 measure-first (FO firing 68)
      agentAttachments: mapped,
      attachmentMeta: [{ filename: 'shot.png', type: 'image', uploadId: 'up-1' }],
      queueUploadIds: ['up-1', 'up-gone'], // ALL staged ids still ride a potential queue (ac65d51e)
    });
    expect(mockSendChatMessage.mock.calls[0][0].content).toContain('two shots');
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
  });

  it('a 409 with resolved uploads still queues — the staged ids ride the row (ac65d51e: the queue is no longer text-only)', async () => {
    mockSupervisorProvisioned();
    mockLoadAttachment.mockResolvedValue({ type: 'image', filename: 'tiny.png', base64: 'QUJD' });
    mockCombineAttachments.mockReturnValue({ type: 'image', filename: 'tiny.png', base64: 'QUJD' });
    mockMapAttachmentForAgent.mockReturnValue({}); // failed validation downstream
    mockSendChatMessage.mockRejectedValueOnce(new AppError(409, 'busy'));

    // attachmentMeta is non-empty (the upload RESOLVED) but the queue now
    // carries the staged ids — the drain re-resolves them at dequeue.
    const r = await fleet.sendSupervisorMessage(OWNER, 'hi', ['up-1']);
    expect(r).toEqual({ queued: true, position: 1 });
    expect(mockEnqueueChatMessage).toHaveBeenCalledWith({
      chatId: SUP, userId: OWNER, content: 'hi', source: 'user', uploadIds: ['up-1'],
    });
  });
});

// ── Queue depth ─────────────────────────────────────────────────────────────

describe('getQueuedCount', () => {
  it('delegates to main\'s countPending (a row is queued until drained)', async () => {
    mockCountPending.mockResolvedValue(2);
    const n = await fleet.getQueuedCount(SUP);
    expect(n).toBe(2);
    expect(mockCountPending).toHaveBeenCalledWith(SUP);
  });

  it('getQueuedUserCount delegates to countPendingUser (F3 — user-typed rows only)', async () => {
    mockCountPendingUser.mockResolvedValue(1);
    const n = await fleet.getQueuedUserCount(SUP);
    expect(n).toBe(1);
    expect(mockCountPendingUser).toHaveBeenCalledWith(SUP);
  });
});

// ── Raw log ───────────────────────────────────────────────────────────────────

describe('getFleetLog', () => {
  it('merges transcript + agent Activity rows newest-first with kinds/from/to', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ prompt: 'legacy wake' }]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m4', 'assistant', 'Reply to you.', D('10:30:00')),
      M('m3', 'user', 'agent ping', D('10:20:00'), { origin: 'agent', sourceChatId: 'chat-9' }),
      M('m2', 'user', 'legacy wake', D('10:10:00')), // retro: matches schedule prompt
      M('m1', 'user', 'my question', D('10:00:00')),
    ]);
    mockPrisma.activity.findMany.mockResolvedValue([
      { id: 'act-1', createdAt: D('10:25:00'), metadata: { origin: 'agent', sourceChatId: 'chat-7', chatId: 'chat-2', contentSnippet: 'delegated task' } },
      { id: 'act-2', createdAt: D('10:05:00'), metadata: { origin: 'user', chatId: SUP } }, // filtered out
    ]);
    const r = await fleet.getFleetLog(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.sourceId)).toEqual(['m4', 'act-1', 'm3', 'm2', 'm1']);
    const byId = Object.fromEntries(r.messages.map((m: any) => [m.sourceId, m]));
    expect(byId['m1']).toMatchObject({ kind: 'user_message', from: 'You', to: 'Supervisor', chatId: SUP });
    expect(byId['m2']).toMatchObject({ kind: 'machine_wake', from: 'Scheduler', to: 'Supervisor' });
    expect(byId['m3']).toMatchObject({ kind: 'agent_message', from: 'Agent (chat-9)', to: 'Supervisor' });
    expect(byId['m4']).toMatchObject({ kind: 'supervisor_reply', from: 'Supervisor', to: 'You' });
    expect(byId['act-1']).toMatchObject({
      kind: 'agent_message', from: 'Agent (chat-7)', to: 'Chat chat-2',
      summary: 'delegated task', chatId: 'chat-2',
    });
    expect(r.hasMore).toBe(false);
    expect(r.nextBefore).toBe(`${D('10:00:00').toISOString()}|m1`);
  });

  it('resolves from/to labels through the chat-title map (raw ids only as fallback)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: 'chat-7', title: 'Research bot' },
      { id: 'chat-2', title: 'Ops chat' },
      { id: 'chat-9', title: 'Scout' },
    ]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m3', 'user', 'agent ping', D('10:20:00'), { origin: 'agent', sourceChatId: 'chat-9' }),
    ]);
    mockPrisma.activity.findMany.mockResolvedValue([
      { id: 'act-1', createdAt: D('10:25:00'), metadata: { origin: 'agent', sourceChatId: 'chat-7', chatId: 'chat-2', contentSnippet: 'delegated' } },
    ]);
    const r = await fleet.getFleetLog(OWNER, { limit: 50 });
    const byId = Object.fromEntries(r.messages.map((m: any) => [m.sourceId, m]));
    expect(byId['act-1']).toMatchObject({ from: 'Agent (Research bot)', to: 'Ops chat' });
    expect(byId['m3']).toMatchObject({ from: 'Agent (Scout)' });
  });

  it('dedupes an agent→supervisor send: the transcript row is canonical, the Activity twin is dropped', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m3', 'user', 'agent ping', D('10:20:00'), { origin: 'agent', sourceChatId: 'chat-9' }),
    ]);
    mockPrisma.activity.findMany.mockResolvedValue([
      // The SAME send audited against the supervisor chat — must not render twice.
      { id: 'act-dup', createdAt: D('10:20:00'), metadata: { origin: 'agent', sourceChatId: 'chat-9', chatId: SUP, contentSnippet: 'agent ping' } },
      { id: 'act-other', createdAt: D('10:15:00'), metadata: { origin: 'agent', sourceChatId: 'chat-9', chatId: 'chat-2', contentSnippet: 'other' } },
    ]);
    const r = await fleet.getFleetLog(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.sourceId)).toEqual(['m3', 'act-other']);
  });

  it('hasMore when either source fills its page; nextBefore is the last kept (at|id) cursor', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    // limit 2 → transcript fetch takes 3 (hasMore true), activities take 2 (full page).
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      M('m3', 'user', 'c', D('10:03:00')), M('m2', 'user', 'b', D('10:02:00')), M('m1', 'user', 'a', D('10:01:00')),
    ]);
    mockPrisma.activity.findMany.mockResolvedValue([]);
    const r = await fleet.getFleetLog(OWNER, { limit: 2 });
    expect(r.messages).toHaveLength(2);
    expect(r.hasMore).toBe(true);
    expect(r.nextBefore).toBe(`${D('10:02:00').toISOString()}|m2`);
  });

  it('a page of ALL non-agent activities still returns a usable cursor (no hasMore dead-end)', async () => {
    // No supervisor (transcript skipped) + a full activities page that the
    // origin filter drops entirely — the OLD shape was { messages: [],
    // hasMore: true } with NO nextBefore: a dead "Load more" forever.
    mockPrisma.activity.findMany.mockResolvedValue([
      { id: 'act-u1', createdAt: D('10:05:00'), metadata: { origin: 'user', chatId: 'c1' } },
      { id: 'act-u2', createdAt: D('10:04:00'), metadata: { origin: 'user', chatId: 'c1' } },
    ]);
    const r = await fleet.getFleetLog(OWNER, { limit: 2 });
    expect(r.messages).toEqual([]);
    expect(r.hasMore).toBe(true);
    // Cursor = the oldest SCANNED activity, so the next page makes progress.
    expect(r.nextBefore).toBe(`${D('10:04:00').toISOString()}|act-u2`);
  });

  it('applies a legacy plain-ISO before cursor to BOTH sources (strict lt, no tiebreak)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    await fleet.getFleetLog(OWNER, { before: '2026-08-10T10:00:00.000Z', limit: 50 });
    const bound = new Date('2026-08-10T10:00:00.000Z');
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: SUP, createdAt: { lt: bound } },
    }));
    expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: OWNER, resource: 'platform', action: 'chat.message', createdAt: { lt: bound } }),
    }));
  });

  it('applies a compound (at|id) cursor to BOTH sources with the id tiebreak', async () => {
    mockSupervisorProvisioned();
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    await fleet.getFleetLog(OWNER, { before: '2026-08-10T10:00:00.000Z|row-5', limit: 50 });
    const bound = new Date('2026-08-10T10:00:00.000Z');
    const orBound = [{ createdAt: { lt: bound } }, { createdAt: bound, id: { lt: 'row-5' } }];
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: SUP, OR: orBound },
    }));
    expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: OWNER, resource: 'platform', action: 'chat.message', OR: orBound }),
    }));
  });

  it('still returns Activity rows when no supervisor is provisioned (transcript skipped)', async () => {
    mockPrisma.activity.findMany.mockResolvedValue([
      { id: 'act-1', createdAt: D('10:25:00'), metadata: { origin: 'agent', sourceChatId: 'chat-7', chatId: 'chat-2', contentSnippet: 's' } },
    ]);
    const r = await fleet.getFleetLog(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.sourceId)).toEqual(['act-1']);
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('400s on a malformed before cursor', async () => {
    await expect(fleet.getFleetLog(OWNER, { before: 'not-a-date' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ── Project digests (GET /fleet/digests — READ-ONLY projection) ───────────────

describe('getProjectDigests', () => {
  /** Stored project_digests row (the hourly cron's write shape). */
  const ROW = (id: string, projectId: string | null, status: string, updatedAt: Date, extra: any = {}) => ({
    id,
    userId: OWNER,
    projectId,
    status,
    summary: `summary for ${id}`,
    attentionItems: [{ kind: 'failed_run', title: 'Chat', detail: 'boom', runId: 'r1', chatId: 'c1', at: '2026-08-10T10:00:00.000Z' }],
    stats: { chatCount: 1 },
    signature: `sig-${id}`,
    windowStart: D('09:00:00'),
    windowEnd: D('10:00:00'),
    createdAt: D('10:00:00'),
    updatedAt,
    ...extra,
  });

  it('is owner-scoped and maps the stored rows (null project → Ungrouped; legacy rows: generatedAt = updatedAt)', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p1', name: 'Alpha' }]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([
      ROW('d1', 'p1', 'on_track', D('10:05:00')),
      ROW('d2', null, 'idle', D('10:04:00')),
    ]);

    const r = await fleet.getProjectDigests(OWNER);

    expect(mockPrisma.projectDigest.findMany).toHaveBeenCalledWith({
      where: { userId: OWNER },
      orderBy: { updatedAt: 'desc' },
    });
    expect(r.digests).toHaveLength(2);
    const alpha = r.digests.find((d: any) => d.projectId === 'p1')!;
    expect(alpha).toBeDefined();
    expect(alpha).toMatchObject({
      projectId: 'p1',
      projectName: 'Alpha',
      status: 'on_track',
      summary: 'summary for d1',
      generatedAt: D('10:05:00').toISOString(), // legacy row (no stats.generatedAt) → falls back to updatedAt
      updatedAt: D('10:05:00').toISOString(),
    });
    expect(alpha.attentionItems).toHaveLength(1);
    expect(alpha.stats).toEqual({ chatCount: 1 });
    const ungrouped = r.digests.find((d: any) => d.projectId === null)!;
    expect(ungrouped).toBeDefined();
    expect(ungrouped.projectName).toBe('Ungrouped');
  });

  it('projects goalProgress + etaSummary additively (Project Pulse); legacy rows default [] / null', async () => {
    const goalProgress = [{
      goalId: 'g1', title: 'Optimal multi-model routing', status: 'active',
      todosDone: 7, todosTotal: 18, blockedCount: 0, completed24h: 1, completed7d: 7,
      eta: { remaining: 11, pacePerDay: 1, etaDays: 11, class: 'on_pace' },
    }];
    const etaSummary = {
      goalsTracked: 1, goalsBlocked: 0, todosDone: 7, todosTotal: 18,
      todosRemaining: 11, blockedCount: 0, pacePerDay: 1, etaDays: 11, class: 'on_pace',
    };
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([
      ROW('d1', 'p1', 'on_track', D('10:05:00'), { goalProgress, etaSummary }),
      // Legacy pre-migration row: the columns are absent entirely.
      ROW('d2', 'p2', 'idle', D('10:04:00')),
    ]);

    const r = await fleet.getProjectDigests(OWNER);
    const alpha = r.digests.find((d: any) => d.projectId === 'p1')!;
    expect(alpha.goalProgress).toEqual(goalProgress);
    expect(alpha.etaSummary).toEqual(etaSummary);
    const beta = r.digests.find((d: any) => d.projectId === 'p2')!;
    expect(beta.goalProgress).toEqual([]);
    expect(beta.etaSummary).toBeNull();
  });

  it('reports the HONEST generation time from stats.generatedAt; updatedAt keeps the sweep touch', async () => {
    // The signature-skip sweep touches updatedAt without rewriting the summary
    // — generatedAt must stay the moment the text was actually written.
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p1', name: 'Alpha' }]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([
      ROW('d1', 'p1', 'on_track', D('10:05:00'), {
        stats: { chatCount: 1, generatedAt: D('06:00:00').toISOString() },
      }),
    ]);
    const r = await fleet.getProjectDigests(OWNER);
    expect(r.digests[0].generatedAt).toBe(D('06:00:00').toISOString());
    expect(r.digests[0].updatedAt).toBe(D('10:05:00').toISOString());
  });

  it('sorts by severity (blocked → needs_attention → on_track → idle), most-recent first within a tier', async () => {
    // Projects must exist for their digest rows to survive the orphan drop.
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' }, { id: 'p4', name: 'P4' },
    ]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([
      ROW('d-idle', null, 'idle', D('10:01:00')),
      ROW('d-track', 'p1', 'on_track', D('10:09:00')),
      ROW('d-blocked-old', 'p2', 'blocked', D('10:02:00')),
      ROW('d-attn', 'p3', 'needs_attention', D('10:03:00')),
      ROW('d-blocked-new', 'p4', 'blocked', D('10:08:00')),
    ]);

    const r = await fleet.getProjectDigests(OWNER);
    expect(r.digests.map((d: any) => d.projectId)).toEqual(['p4', 'p2', 'p3', 'p1', null]);
    expect(r.digests.map((d: any) => d.status)).toEqual(['blocked', 'blocked', 'needs_attention', 'on_track', 'idle']);
  });

  it('excludes digests of hidden fleet artifacts (the Fleet HQ folder)', async () => {
    // 'Fleet HQ' (trimmed/case-insensitive) is hidden even when empty — the
    // hidden-artifacts resolver runs on the mocked chats/projects below.
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p-hq', name: 'Fleet HQ' },
      { id: 'p1', name: 'Alpha' },
    ]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([
      ROW('d-hq', 'p-hq', 'blocked', D('10:05:00')),
      ROW('d1', 'p1', 'on_track', D('10:04:00')),
    ]);

    const r = await fleet.getProjectDigests(OWNER);
    expect(r.digests.map((d: any) => d.projectId)).toEqual(['p1']);
  });

  it('DROPS a digest whose project row is gone (ticket a8387f3f — orphan rows never render as phantom cards)', async () => {
    // Pre-a8387f3f this row rendered as an "Unknown project" card carrying its
    // stale status/stats (🟢 running, N schedules armed) for a deleted project.
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([ROW('d1', 'p-deleted', 'on_track', D('10:01:00'))]);
    const r = await fleet.getProjectDigests(OWNER);
    expect(r.digests).toEqual([]);
  });

  it('drops only the orphans: live projects + the UNGROUPED bucket survive', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p1', name: 'Alpha' }]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([
      ROW('d-orphan', 'p-deleted', 'blocked', D('10:09:00')), // highest severity — would sort FIRST if served
      ROW('d1', 'p1', 'on_track', D('10:05:00')),
      ROW('d2', null, 'idle', D('10:04:00')),
    ]);
    const r = await fleet.getProjectDigests(OWNER);
    expect(r.digests.map((d: any) => d.projectId)).toEqual(['p1', null]);
    expect(r.digests.find((d: any) => d.projectId === 'p1')!.projectName).toBe('Alpha');
    expect(r.digests.find((d: any) => d.projectId === null)!.projectName).toBe('Ungrouped');
  });

  it('keeps MEMBER-project rows with their real names (reviewer B1: the projects query is owned ∪ member-of)', async () => {
    // The sweep buckets the user's chats by projectId; a chat filed in a shared
    // project yields a legitimate digest row for a project the user does not
    // own. The widened query resolves its name; the orphan drop must not eat it.
    mockPrisma.crossModelProject.findMany.mockResolvedValue([
      { id: 'p1', name: 'Alpha' },
      { id: 'p-shared', name: 'Shared Team Folder' }, // returned via the members OR-leg
    ]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([
      ROW('d1', 'p1', 'on_track', D('10:05:00')),
      ROW('d2', 'p-shared', 'needs_attention', D('10:06:00')),
      ROW('d-orphan', 'p-deleted', 'blocked', D('10:09:00')),
    ]);
    const r = await fleet.getProjectDigests(OWNER);
    // archivedAt selected for the Pulse archived-folder hiding (owner 2026-09-08).
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { OR: [{ userId: OWNER }, { members: { some: { userId: OWNER } } }] },
      select: { id: true, name: true, path: true, archivedAt: true },
    });
    expect(r.digests.map((d: any) => d.projectId)).toEqual(['p-shared', 'p1']);
    expect(r.digests[0].projectName).toBe('Shared Team Folder');
  });

  it('keeps rows visible only via an OWNED ANCESTOR folder (reviewer B1-residual: path-prefix inheritance)', async () => {
    // getProjectAccess grants access through owned/member ancestors (flag
    // default-on). A chat filed in a subfolder reached only via inheritance
    // yields a legitimate digest row — the descendant query (materialized path
    // prefixes) must resolve its name and the orphan drop must not eat it.
    mockPrisma.crossModelProject.findMany.mockImplementation((args: any) => {
      const or: any[] = args?.where?.OR ?? [];
      const isDescendantLeg = or.some((c: any) => c?.path?.startsWith !== undefined);
      return Promise.resolve(isDescendantLeg
        ? [{ id: 'p-child', name: 'Inherited Subfolder' }]
        : [{ id: 'p-root', name: 'My Root', path: '/p-root' }]);
    });
    mockPrisma.projectDigest.findMany.mockResolvedValue([
      ROW('d-child', 'p-child', 'on_track', D('10:05:00')),
      ROW('d-orphan', 'p-deleted', 'blocked', D('10:09:00')),
    ]);
    const r = await fleet.getProjectDigests(OWNER);
    expect(mockPrisma.crossModelProject.findMany).toHaveBeenCalledWith({
      where: { OR: [{ path: { startsWith: '/p-root/' } }] },
      select: { id: true, name: true },
    });
    expect(r.digests.map((d: any) => d.projectId)).toEqual(['p-child']);
    expect(r.digests[0].projectName).toBe('Inherited Subfolder');
  });

  it('returns an empty list when the cron has never written a row', async () => {
    const r = await fleet.getProjectDigests(OWNER);
    expect(r).toEqual({ digests: [] });
  });
});

// ── Digest item acks (alertmanager-style silences) ────────────────────────────

describe('digestAttentionItemKey', () => {
  it('keys each kind on its stable ref id (goalId beats title; blocked_todo keys on the todo; chatId kinds on the chat)', () => {
    expect(fleet.digestAttentionItemKey({ kind: 'blocked_goal', title: 'Ship it', goalId: 'g1' })).toBe('blocked_goal:g1');
    // blocked_todo carries goalId as a BACKLINK — the todo is the blocked thing.
    expect(fleet.digestAttentionItemKey({ kind: 'blocked_todo', title: 'T', todoId: 't1', goalId: 'g1' })).toBe('blocked_todo:t1');
    expect(fleet.digestAttentionItemKey({ kind: 'awaiting_input', title: 'Chat', chatId: 'c1' })).toBe('awaiting_input:c1');
    // runId/scheduleId are deliberately ignored — a fresh run each hour would mint a new key and defeat the ack.
    expect(fleet.digestAttentionItemKey({ kind: 'failed_run', title: 'Chat', runId: 'r1', chatId: 'c1' })).toBe('failed_run:c1');
    expect(fleet.digestAttentionItemKey({ kind: 'session_error', title: 'Chat', chatId: 'c1' })).toBe('session_error:c1');
    expect(fleet.digestAttentionItemKey({ kind: 'stalled_session', title: 'Chat', runId: 'r9', chatId: 'c1' })).toBe('stalled_session:c1');
    // schedule-scoped kinds key on the durable SCHEDULE row (2026-08-16):
    // chat-keying collided two schedules on one chat under one key, so acking
    // schedule A's error silenced schedule B's future unrelated one.
    expect(fleet.digestAttentionItemKey({ kind: 'schedule_error', title: 'Sched', scheduleId: 's1', chatId: 'c1' })).toBe('schedule_error:s1');
    expect(fleet.digestAttentionItemKey({ kind: 'schedule_error', title: 'Sched B', scheduleId: 's2', chatId: 'c1' })).toBe('schedule_error:s2');
    // items without a scheduleId still fall through to the chat
    expect(fleet.digestAttentionItemKey({ kind: 'schedule_error', title: 'Sched', chatId: 'c1' })).toBe('schedule_error:c1');
    expect(fleet.digestAttentionItemKey({ kind: 'stuck_message', title: 'Chat', chatId: 'c1' })).toBe('stuck_message:c1');
  });

  it('falls back to the title when no ref id exists, and is deterministic across regenerations', () => {
    const a = fleet.digestAttentionItemKey({ kind: 'blocked_goal', title: 'Ship the MVP' });
    const b = fleet.digestAttentionItemKey({ title: 'Ship the MVP', kind: 'blocked_goal' }); // field order irrelevant
    expect(a).toBe('blocked_goal:Ship the MVP');
    expect(b).toBe(a);
  });
});

describe('getProjectDigests — ack projection', () => {
  const GOAL_ITEM = { kind: 'blocked_goal', title: 'Goal', detail: 'blocked', goalId: 'g1', at: D('09:30:00').toISOString() };
  const CHAT_ITEM = { kind: 'failed_run', title: 'Chat', detail: 'boom', runId: 'r1', chatId: 'c1', at: D('10:00:00').toISOString() };
  const rowWith = (items: any[]) => ({
    id: 'd1', userId: OWNER, projectId: 'p1', status: 'blocked', summary: 's',
    attentionItems: items, stats: { chatCount: 1 }, signature: 'sig-d1',
    windowStart: D('09:00:00'), windowEnd: D('10:00:00'), createdAt: D('10:00:00'), updatedAt: D('10:05:00'),
  });

  beforeEach(() => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p1', name: 'Alpha' }]);
    mockPrisma.projectDigest.findMany.mockResolvedValue([rowWith([GOAL_ITEM, CHAT_ITEM])]);
  });

  it('attaches a stable key to every item and loads the caller\'s acks once (owner-scoped)', async () => {
    const r = await fleet.getProjectDigests(OWNER);
    expect(mockPrisma.digestItemAck.findMany).toHaveBeenCalledWith({ where: { userId: OWNER } });
    const items = r.digests[0].attentionItems as any[];
    expect(items.map((i) => i.key)).toEqual(['blocked_goal:g1', 'failed_run:c1']);
    // Tidy shape: LIVE items carry NO acknowledged flag.
    expect(items.every((i) => !('acknowledged' in i))).toBe(true);
  });

  it('EXCLUDES acked items by default (indefinite ack and active snooze alike)', async () => {
    mockPrisma.digestItemAck.findMany.mockResolvedValue([
      { itemKey: 'blocked_goal:g1', snoozeUntil: null },
      { itemKey: 'failed_run:c1', snoozeUntil: new Date(Date.now() + 3_600_000) },
    ]);
    const r = await fleet.getProjectDigests(OWNER);
    expect(r.digests[0].attentionItems).toEqual([]);
  });

  it('showAcked keeps acked items flagged acknowledged (+ snoozeUntil when set)', async () => {
    const snooze = new Date(Date.now() + 24 * 3_600_000);
    mockPrisma.digestItemAck.findMany.mockResolvedValue([
      { itemKey: 'blocked_goal:g1', snoozeUntil: null },
      { itemKey: 'failed_run:c1', snoozeUntil: snooze },
    ]);
    const r = await fleet.getProjectDigests(OWNER, { showAcked: true });
    const items = r.digests[0].attentionItems as any[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'blocked_goal', key: 'blocked_goal:g1', acknowledged: true });
    expect('snoozeUntil' in items[0]).toBe(false); // indefinite ack — no snooze timestamp
    expect(items[1]).toMatchObject({
      kind: 'failed_run', key: 'failed_run:c1', acknowledged: true, snoozeUntil: snooze.toISOString(),
    });
  });

  it('an EXPIRED snooze resurfaces the item (no acknowledged flag, stale row left for the prune)', async () => {
    mockPrisma.digestItemAck.findMany.mockResolvedValue([
      { itemKey: 'blocked_goal:g1', snoozeUntil: new Date(Date.now() - 3_600_000) },
    ]);
    const r = await fleet.getProjectDigests(OWNER);
    const items = r.digests[0].attentionItems as any[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'blocked_goal', key: 'blocked_goal:g1' });
    expect('acknowledged' in items[0]).toBe(false);
  });

  it('never acks another user\'s items — ack rows are loaded for the caller only', async () => {
    mockPrisma.digestItemAck.findMany.mockResolvedValue([]); // the mock IS the caller's rows
    const r = await fleet.getProjectDigests(OWNER);
    expect(mockPrisma.digestItemAck.findMany).toHaveBeenCalledWith({ where: { userId: OWNER } });
    expect((r.digests[0].attentionItems as any[]).length).toBe(2);
  });
});

describe('ackDigestItem', () => {
  it('400s on a missing/empty/non-string key (and never writes)', async () => {
    await expect(fleet.ackDigestItem(OWNER, { key: '' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(fleet.ackDigestItem(OWNER, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(fleet.ackDigestItem(OWNER, { key: 42 })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.digestItemAck.upsert).not.toHaveBeenCalled();
  });

  it('400s on a key over 300 chars', async () => {
    await expect(fleet.ackDigestItem(OWNER, { key: 'k'.repeat(301) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(fleet.ackDigestItem(OWNER, { key: 'k'.repeat(300) })).resolves.toMatchObject({ success: true });
    expect(mockPrisma.digestItemAck.upsert).toHaveBeenCalledTimes(1);
  });

  it('400s on snoozeHours 0 / 721 / non-integer / non-number', async () => {
    for (const snoozeHours of [0, 721, 1.5, '24', -1]) {
      await expect(fleet.ackDigestItem(OWNER, { key: 'blocked_goal:g1', snoozeHours })).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(mockPrisma.digestItemAck.upsert).not.toHaveBeenCalled();
    // Bounds are inclusive: 1 and 720 are legal.
    await expect(fleet.ackDigestItem(OWNER, { key: 'k', snoozeHours: 1 })).resolves.toMatchObject({ success: true });
    await expect(fleet.ackDigestItem(OWNER, { key: 'k', snoozeHours: 720 })).resolves.toMatchObject({ success: true });
  });

  it('upserts an INDEFINITE ack (snoozeUntil null) when snoozeHours is omitted', async () => {
    const r = await fleet.ackDigestItem(OWNER, { key: 'blocked_goal:g1' });
    expect(mockPrisma.digestItemAck.upsert).toHaveBeenCalledWith({
      where: { userId_itemKey: { userId: OWNER, itemKey: 'blocked_goal:g1' } },
      create: { userId: OWNER, itemKey: 'blocked_goal:g1', snoozeUntil: null },
      update: { snoozeUntil: null },
    });
    expect(r).toEqual({ success: true, key: 'blocked_goal:g1', snoozeUntil: null });
  });

  it('upserts a snooze ~snoozeHours out and returns its ISO timestamp', async () => {
    const before = Date.now();
    const r = await fleet.ackDigestItem(OWNER, { key: 'failed_run:c1', snoozeHours: 24 });
    const arg = mockPrisma.digestItemAck.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ userId_itemKey: { userId: OWNER, itemKey: 'failed_run:c1' } });
    const t = (arg.create.snoozeUntil as Date).getTime();
    expect(t).toBeGreaterThanOrEqual(before + 24 * 3_600_000);
    expect(t).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
    expect(arg.update.snoozeUntil).toBe(arg.create.snoozeUntil); // re-ack refreshes the window
    expect(r.snoozeUntil).toBe((arg.create.snoozeUntil as Date).toISOString());
  });
});

describe('unackDigestItem', () => {
  it('deleteMany by (userId, itemKey) — idempotent, no 404 on a never-acked key', async () => {
    await expect(fleet.unackDigestItem(OWNER, 'blocked_goal:g1')).resolves.toEqual({ success: true });
    expect(mockPrisma.digestItemAck.deleteMany).toHaveBeenCalledWith({
      where: { userId: OWNER, itemKey: 'blocked_goal:g1' },
    });
  });
});

describe('dismissFleetSchedule', () => {
  it('cancels the caller\'s own schedule via the audited platform service', async () => {
    mockCancelSchedule.mockResolvedValue(true);
    await expect(fleet.dismissFleetSchedule(OWNER, 'sch1')).resolves.toEqual({ ok: true });
    expect(mockCancelSchedule).toHaveBeenCalledWith({ userId: OWNER, id: 'sch1' });
  });

  it('404s when the schedule is not the caller\'s (or already gone) — owner-scoping pinned', async () => {
    mockCancelSchedule.mockResolvedValue(false);
    await expect(fleet.dismissFleetSchedule(OWNER, 'sch-foreign')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── getFleetSchedules (Management Schedules tab) ──────────────────────────────

/** coding_schedule row fixture (the tab carries the FULL lifecycle fields). */
const SCH = (id: string, sessionId: string, over: any = {}) => ({
  id,
  sessionId,
  userId: OWNER,
  prompt: `prompt for ${id}`,
  kind: 'recurring',
  intervalSec: 3600,
  nextRunAt: D('09:00:00'),
  enabled: true,
  runsCount: 3,
  maxRuns: 500,
  expiresAt: D('23:59:00'),
  lastFiredAt: D('08:00:00'),
  lastStatus: 'started',
  createdAt: D('07:00:00'),
  ...over,
});

describe('getFleetSchedules', () => {
  it('queries owner-scoped, enabled-first then nextRunAt-asc, capped at 200', async () => {
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    await fleet.getFleetSchedules(OWNER);
    expect(mockPrisma.chatSchedule.findMany).toHaveBeenCalledWith({
      where: { userId: OWNER },
      orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
      take: 200,
    });
  });

  it('joins chat titles via ONE batched lookup over the DISTINCT session ids', async () => {
    mockPrisma.chatSchedule.findMany.mockResolvedValue([
      SCH('s1', 'c1'),
      SCH('s2', 'c2'),
      SCH('s3', 'c1'), // second schedule on the same chat — distinct() before the join
    ]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: 'c1', title: 'Alpha' },
      { id: 'c2', title: 'Beta' },
    ]);
    const r = await fleet.getFleetSchedules(OWNER);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] } },
      select: { id: true, title: true },
    });
    expect(r.schedules).toHaveLength(3);
    expect(r.schedules[0]).toMatchObject({ id: 's1', chatId: 'c1', chatTitle: 'Alpha' });
    expect(r.schedules[1]).toMatchObject({ id: 's2', chatId: 'c2', chatTitle: 'Beta' });
    expect(r.schedules[2]).toMatchObject({ id: 's3', chatId: 'c1', chatTitle: 'Alpha' });
  });

  it('carries the lifecycle fields + a 140-char prompt snippet', async () => {
    const long = 'x'.repeat(200);
    mockPrisma.chatSchedule.findMany.mockResolvedValue([
      SCH('s1', 'c-gone', { prompt: long, kind: 'once', intervalSec: null, maxRuns: 1, lastStatus: 'error:boom' }),
    ]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]); // chat deleted — row lingers until GC
    const r = await fleet.getFleetSchedules(OWNER);
    const row = r.schedules[0] as any;
    expect(row.chatTitle).toBeNull();
    expect(row.promptSnippet).toHaveLength(140);
    expect(row.promptSnippet).toBe(long.slice(0, 140));
    expect(row).toMatchObject({
      kind: 'once', intervalSec: null, maxRuns: 1, runsCount: 3,
      enabled: true, lastStatus: 'error:boom',
    });
    expect(row.nextRunAt).toEqual(D('09:00:00'));
    expect(row.lastFiredAt).toEqual(D('08:00:00'));
    expect(row.expiresAt).toEqual(D('23:59:00'));
  });

  it('empty fleet: no chat-title lookup at all', async () => {
    mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
    const r = await fleet.getFleetSchedules(OWNER);
    expect(r.schedules).toEqual([]);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// isVerifierStruckNote + picker fallback chain (owner bug 2026-09-04): a
// verifier-struck note must never headline the Fleet-summary card when a clean
// note exists; fallback order is clean > no-op > struck.
// ═════════════════════════════════════════════════════════════════════════════
describe('isVerifierStruckNote (dashboard summary picker)', () => {
  const { isVerifierStruckNote } = jest.requireActual('./fleet.service');
  it('detects both guard banners, leading whitespace tolerated', () => {
    expect(isVerifierStruckNote("[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]\nx")).toBe(true);
    expect(isVerifierStruckNote("  [HARNESS EVIDENCE GUARD — x]\ny")).toBe(true);
  });
  it('never flags clean sweeps or no-ops', () => {
    expect(isVerifierStruckNote('**Fleet sweep — all lanes idle, no owner action.**')).toBe(false);
    expect(isVerifierStruckNote('no-op')).toBe(false);
  });
});

/**
 * ============================================================================
 * DETECTOR-RECALL REPLAY — ticket 739e8191 (child-session relay visibility)
 * ============================================================================
 * classifyThreadRows is a RECALL filter (it decides what an owner never sees),
 * so these cases re-assert the PRIOR true positives still fire while the new
 * lineage exemption lets a SUB-SESSION's report reach the owner. Owner report
 * (chat 99e63f86, msg be494d38): "you dont see to communicate with the
 * user/human after you get a message from a sub session ie...you should then
 * relay to me whatever message was sent back from the subsession … ie the agent
 * has finished the work and everything is done". The parent DID relay — the
 * relay row (origin 'agent') and its reply were classified noise.
 */
describe('getSupervisorThread — child-session relay exemption (ticket 739e8191)', () => {
  const CHILD = 'child-lane-9';
  const SIBLING = 'sibling-lane-3';
  const relay = (title: string, id: string) =>
    `[AGENT-SENT MESSAGE — from chat "${title}" (${id}) in project "p", another Digby agent, NOT the owner.]\n` +
    `The work is finished and everything is done.\n\n[Agent message ${id.slice(0, 8)}]`;

  const ROWS = [
    M('w1', 'user', 'hourly sweep', D('21:00:00'), { origin: 'schedule' }),
    M('a1', 'assistant', 'Status: nominal.', D('21:00:20'), { origin: 'schedule' }),
    // THE RELAY under test: this chat's CHILD reports its finished work.
    M('r1', 'user', relay('crossmodel lane', CHILD), D('21:54:00'), { origin: 'agent', sourceChatId: CHILD }),
    M('r2', 'assistant', 'The lane finished — here is what it delivered.', D('21:54:20')),
    // A relay from a chat that is NOT a child — internal traffic, stays hidden.
    M('s1', 'user', relay('other lane', SIBLING), D('21:56:00'), { origin: 'agent', sourceChatId: SIBLING }),
    M('s2', 'assistant', 'Acknowledged.', D('21:56:10')),
  ];

  it('surfaces the child relay AND its reply to the owner (the delivered result is seen)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([...ROWS].reverse());
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: CHILD }]);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.id)).toEqual(['r1', 'r2']);
    // The relay is flattened with the marker every view layer already reads.
    expect((r.messages[0] as any).childResult).toBe(true);
    const reply = r.messages[1] as any;
    expect(reply.content).toContain('The lane finished');
  });

  it('DETECTOR-RECALL REPLAY: with no child lineage the relay and its reply stay hidden (today behaviour)', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([...ROWS].reverse());
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]); // no children known
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.id)).toEqual([]);
  });

  it('DETECTOR-RECALL REPLAY: a NON-child [AGENT-SENT MESSAGE] relay is still noise (supervisor fan-out never surfaces)', async () => {
    mockSupervisorProvisioned();
    // Only the sibling relays present — the new exemption must not touch them.
    mockPrisma.crossModelMessage.findMany.mockResolvedValue(
      [ROWS[4], ROWS[5]].reverse(),
    );
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: CHILD }]);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.id)).toEqual([]);
  });

  it('DETECTOR-RECALL REPLAY: an unarmed machine wake stays noise even when children exist', async () => {
    mockSupervisorProvisioned();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([ROWS[0], ROWS[1]].reverse());
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: CHILD }]);
    const r = await fleet.getSupervisorThread(OWNER, { limit: 50 });
    expect(r.messages.map((m: any) => m.id)).toEqual([]);
  });
});

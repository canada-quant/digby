/**
 * send_to_instance — Digby Edge (Phase 5) cloud→edge messaging platform tool.
 * Scaffolding mirrors platform-tools.autonomy.test.ts (do not modify that
 * file): the service layer, autonomy.service, agent-auth, axios, jsonwebtoken,
 * config/env and hooks.service are mocked so the GATE + the executor's relay
 * call shape are what get pinned.
 *
 * Pins:
 *   - CONSEQUENTIAL: the first call (no grant, no confirmationId) STAGES a
 *     needsConfirmation registration and never touches the instance registry
 *     or the relay; a chat whose ChatAutonomy grant names 'send_to_instance'
 *     executes directly (and is audited via auditAutonomousExecution);
 *   - ownership: unknown / foreign-owned / revoked instances all return the
 *     SAME "Instance not found" string (no cross-owner enumeration) and never
 *     reach the relay;
 *   - depth semantics: a user-anchored run (ctx.userTurnAt) sends depth 0; a
 *     machine-triggered run reads the fleet hook-depth stamp for THIS chat and
 *     sends depth+1 (the cloud→edge→cloud loop bound);
 *   - relay call shape: POST to 127.0.0.1:<RELAY_PORT||4100> with a Bearer
 *     60s-style JWT and { message, sourceLabel, depth };
 *   - relay 502 (or unreachable) → ok:false 'instance offline'; another
 *     non-2xx passes the edge's error message through;
 *   - a delivered message writes an Activity audit row (resource 'platform').
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tools.ts transitively imports plan.service → context-store → DB/env (process.exit).
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));

// The service layer under the tools — fully mocked (mirrors the autonomy suite).
const svc = {
  listChats: jest.fn(),
  createChat: jest.fn(),
  getChatStatus: jest.fn(),
  getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(),
  renameChat: jest.fn(),
  archiveChat: jest.fn(),
  moveChat: jest.fn(),
  deleteChat: jest.fn(),
  createProject: jest.fn(),
  getProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  moveFolder: jest.fn(),
  startCodingSession: jest.fn(),
  scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(),
  cancelSchedule: jest.fn(),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

// agent-auth pulls config/database + utils/jwt → config/env (process.exit).
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// autonomy.service under the gate — mocked (the real one pulls prisma chains).
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// The fleet hook-depth stamp (machine-run depth propagation) — mocked.
const mockDepthForChat = jest.fn(async () => 0);
jest.mock('./hooks.service', () => ({ __esModule: true, depthForChat: mockDepthForChat }));

// The executor's 60s caller JWT + env — mocked (env must never process.exit).
const mockJwtSign = jest.fn(() => 'signed-60s-jwt');
jest.mock('jsonwebtoken', () => ({ __esModule: true, default: { sign: mockJwtSign } }));
jest.mock('../../../config/env', () => ({ env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32) } }));

// The relay HTTP call — explicit factory so the dynamic import('axios') sees it.
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: mockAxiosPost } }));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// config/database: the confirmation registry (real, in-memory via the testkit)
// PLUS the instance registry / user lookup / Activity audit the executor uses.
const INSTANCE = { id: 'inst-1', ownerUserId: 'u1', name: 'home-lab', status: 'online' };
const mockDb = {
  connectedInstance: { findUnique: jest.fn(async (): Promise<any> => ({ ...INSTANCE })) },
  user: { findUnique: jest.fn(async (): Promise<any> => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })) },
  activity: { create: jest.fn(async () => ({})) },
};
const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { ...mockDb, pendingConfirmation: mockConfirmations.api },
}));

import { PLATFORM_TOOL_SCHEMA, executePlatformTool } from './platform-tools';
import { MUTATING_TOOLS, ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

const ARGS = { instanceId: 'inst-1', chatId: 'chat-9', message: 'hello edge' };

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  autonomySvc.getChatAutonomy.mockResolvedValue(null); // default: no grant
  mockDepthForChat.mockResolvedValue(0);
  mockDb.connectedInstance.findUnique.mockResolvedValue({ ...INSTANCE });
  mockDb.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' });
  mockAxiosPost.mockResolvedValue({ status: 200, data: { success: true, data: { delivery: 'started' } } });
});

describe('schema registration', () => {
  it('is in the platform tool schema and joins MUTATING_TOOLS', () => {
    const entry = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'send_to_instance');
    expect(entry).toBeDefined();
    expect(entry!.function.parameters.required).toEqual(['instanceId', 'chatId', 'message']);
    expect(MUTATING_TOOLS.has('send_to_instance')).toBe(true);
  });
});

describe('consequential gate', () => {
  it('STAGES a confirmation on the first call — no registry lookup, no relay call', async () => {
    const ctx = makeCtx({ userTurnAt: new Date() }); // user-anchored, no grant
    const out = await executePlatformTool(ctx, 'send_to_instance', ARGS);
    const parsed = JSON.parse(out);
    expect(parsed.needsConfirmation).toBe(true);
    expect(parsed.confirmationId).toBeTruthy();
    expect(parsed.summary).toContain('chat-9');
    expect(parsed.summary).toContain('inst-1');
    expect(mockDb.connectedInstance.findUnique).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('EXECUTES without a confirmation when the chat grant names send_to_instance', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_to_instance'], scheduleCap: 48 });
    const ctx = makeCtx(); // machine-triggered, no userTurnAt
    const out = await executePlatformTool(ctx, 'send_to_instance', ARGS);
    expect(JSON.parse(out)).toMatchObject({ ok: true, tool: 'send_to_instance', ids: { instanceId: 'inst-1', chatId: 'chat-9' } });
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith({ chatId: 'sess-1', tool: 'send_to_instance', userId: 'u1' });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('without a matching grant a machine-triggered run STILL stages', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48 });
    const ctx = makeCtx(); // no userTurnAt
    const out = await executePlatformTool(ctx, 'send_to_instance', ARGS);
    expect(JSON.parse(out).needsConfirmation).toBe(true);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('instance ownership gating (uniform not-found)', () => {
  beforeEach(() => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_to_instance'], scheduleCap: 48 });
  });

  it.each([
    ['unknown instance', null],
    ['foreign-owned instance', { ...INSTANCE, ownerUserId: 'someone-else' }],
    ['revoked instance', { ...INSTANCE, status: 'revoked' }],
  ])('%s → "Instance not found", relay never called', async (_label, row) => {
    mockDb.connectedInstance.findUnique.mockResolvedValue(row);
    const out = await executePlatformTool(makeCtx(), 'send_to_instance', ARGS);
    expect(out).toContain('Instance not found');
    expect(out).toContain('inst-1');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('relay call shape + depth propagation', () => {
  beforeEach(() => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_to_instance'], scheduleCap: 48 });
  });

  it('user-anchored run (userTurnAt) → depth 0, default sourceLabel from the instance name', async () => {
    const ctx = makeCtx({ userTurnAt: new Date() });
    await executePlatformTool(ctx, 'send_to_instance', ARGS);
    expect(mockDepthForChat).not.toHaveBeenCalled();
    expect(mockAxiosPost).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/api/crossmodel/instances/inst-1/chats/chat-9/messages',
      { message: 'hello edge', sourceLabel: 'cloud instance "home-lab"', depth: 0 },
      { headers: { Authorization: 'Bearer signed-60s-jwt' }, timeout: 10_000 },
    );
    expect(mockJwtSign).toHaveBeenCalledWith(
      { userId: 'u1', email: 'a@b.c', role: 'ADMIN' }, 'x'.repeat(32), { expiresIn: 60 },
    );
  });

  it('machine-triggered run → the fleet hook-depth stamp for THIS chat + 1', async () => {
    mockDepthForChat.mockResolvedValue(2);
    const ctx = makeCtx(); // no userTurnAt
    await executePlatformTool(ctx, 'send_to_instance', ARGS);
    expect(mockDepthForChat).toHaveBeenCalledWith('sess-1');
    expect(mockAxiosPost.mock.calls[0][1].depth).toBe(3);
  });

  it('a stamp-read failure degrades to depth 1 (best-effort ladder)', async () => {
    mockDepthForChat.mockRejectedValue(new Error('redis down'));
    const ctx = makeCtx();
    const out = await executePlatformTool(ctx, 'send_to_instance', ARGS);
    expect(JSON.parse(out).ok).toBe(true);
    expect(mockAxiosPost.mock.calls[0][1].depth).toBe(1);
  });

  it('a caller-supplied sourceLabel wins (clipped to 120 chars)', async () => {
    const ctx = makeCtx({ userTurnAt: new Date() });
    await executePlatformTool(ctx, 'send_to_instance', { ...ARGS, sourceLabel: 'deploy bot' });
    expect(mockAxiosPost.mock.calls[0][1].sourceLabel).toBe('deploy bot');
    await executePlatformTool(ctx, 'send_to_instance', { ...ARGS, sourceLabel: 'x'.repeat(200) });
    expect(mockAxiosPost.mock.calls[1][1].sourceLabel).toHaveLength(120);
  });

  it('requires instanceId, chatId and message', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_to_instance'], scheduleCap: 48 });
    const out = await executePlatformTool(makeCtx(), 'send_to_instance', { instanceId: 'inst-1', chatId: '', message: 'hi' });
    expect(out).toContain('requires instanceId, chatId and message');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('relay response mapping + audit', () => {
  beforeEach(() => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_to_instance'], scheduleCap: 48 });
  });

  it('relay 502 → ok:false "instance offline"', async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 502, data: { error: 'instance offline' } } });
    const out = await executePlatformTool(makeCtx(), 'send_to_instance', ARGS);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.tool).toBe('send_to_instance');
    expect(parsed.message).toContain('instance offline');
    expect(mockDb.activity.create).not.toHaveBeenCalled();
  });

  it('relay unreachable (no response) → also "instance offline"', async () => {
    mockAxiosPost.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:4100'));
    const out = await executePlatformTool(makeCtx(), 'send_to_instance', ARGS);
    expect(JSON.parse(out).message).toContain('instance offline');
  });

  it("another non-2xx passes the edge's error message through", async () => {
    mockAxiosPost.mockRejectedValue({ response: { status: 400, data: { error: 'hook depth exceeded' } } });
    const out = await executePlatformTool(makeCtx(), 'send_to_instance', ARGS);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('HTTP 400');
    expect(parsed.message).toContain('hook depth exceeded');
  });

  it('a delivered message writes an Activity audit row (resource platform)', async () => {
    mockAxiosPost.mockResolvedValue({ status: 200, data: { success: true, data: { delivery: 'queued', position: 2 } } });
    const out = await executePlatformTool(makeCtx(), 'send_to_instance', ARGS);
    expect(JSON.parse(out).message).toContain('queued');
    expect(mockDb.activity.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1', action: 'instance.message', resource: 'platform',
        metadata: { instanceId: 'inst-1', chatId: 'chat-9', delivery: 'queued', depth: 1 },
      },
    });
  });
});

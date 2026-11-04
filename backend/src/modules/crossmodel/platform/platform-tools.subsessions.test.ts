/**
 * Sub-session promotion (2026-09-02) — the platform-tools spawn/gate seams:
 *
 *   - LINEAGE (piece 1): start_coding_session records parentChatId on the new
 *     session when the CALLING chat resolves to a same-user chat — and never
 *     when the caller is foreign-user, unresolvable, or prisma is unavailable
 *     (best-effort: a lineage hiccup must never fail the spawn).
 *   - AUTO RESULT-HOOK (piece 2): the spawn wires ensureChildResultHook
 *     (child → parent) and reports the hook in the result; a wiring failure
 *     degrades the note, never the spawn.
 *   - JOURNAL INHERITANCE (piece 4): the child's first prompt is prefixed with
 *     the parent's [PARENT SESSION CONTEXT] block BEFORE startCodingSession
 *     (so the durable first-prompt stash carries it); no prompt = no injection.
 *   - IMPLICIT PARENT AUTONOMY (piece 3, gate wiring): a MACHINE-triggered run
 *     executes send_chat_message when implicitParentAutonomyAllows says the
 *     target is its own child; false ⇒ the normal needsConfirmation flow; a
 *     user-anchored run never consults the implicit scope.
 *
 * Scaffolding mirrors platform-tools.autonomy.test.ts (do not modify that file).
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
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

// The service layer under the tools — fully mocked.
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

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// autonomy.service under the gate — fully mocked, INCLUDING the new implicit
// parent→child check (the gate's optional-chain tolerates its absence, but this
// suite pins the wiring when it IS present).
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
  implicitParentAutonomyAllows: jest.fn(async () => false),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// hooks.service is loaded via DYNAMIC import at the spawn seam — mock the helper.
const mockEnsureChildResultHook: jest.Mock = jest.fn();
jest.mock('./hooks.service', () => ({
  __esModule: true,
  ensureChildResultHook: (...a: any[]) => mockEnsureChildResultHook(...a),
}));

// run-journal.service is loaded via DYNAMIC import at the spawn seam.
const mockBuildParentContextBlock: jest.Mock = jest.fn(async () => '');
jest.mock('../coding/run-journal.service', () => ({
  __esModule: true,
  buildParentContextBlock: (...a: any[]) => mockBuildParentContextBlock(...a),
}));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// config/database: the pending-confirmations registry PLUS the lineage reads/
// writes the spawn seam does (crossModelChat.findUnique / update).
const mockConfirmations = createPendingConfirmationTable();
const mockChatFindUnique: jest.Mock = jest.fn();
const mockChatUpdate: jest.Mock = jest.fn(async () => ({}));
const mockChatCount: jest.Mock = jest.fn(async () => 0);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      update: (...a: any[]) => mockChatUpdate(...a),
      count: (...a: any[]) => mockChatCount(...a),
    },
  },
}));

import { executePlatformTool, PLATFORM_TOOL_SCHEMA } from './platform-tools';
import { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return ctx;
}

/** Auto-mode coding orchestrator — full autonomy, so consequential spawns
 *  execute in ONE call (the seams under test live in the dispatch case). */
const autoCodingCtx = () => makeCtx({ agentSurface: 'coding' } as any);

const SPAWNED = {
  id: 'sess-new', title: 'Child task', projectId: 'p1',
  branch: 'digby/session-new', baseBranch: 'main', model: 'glm-5.2', permissionMode: 'auto',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  autonomySvc.getChatAutonomy.mockResolvedValue(null);
  autonomySvc.implicitParentAutonomyAllows.mockResolvedValue(false);
  svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
  mockChatFindUnique.mockResolvedValue({ id: 'sess-1', userId: 'u1' }); // caller = same-user chat
  mockChatUpdate.mockResolvedValue({});
  mockEnsureChildResultHook.mockResolvedValue({ id: 'hook-1', sourceChatId: 'sess-new', targetChatId: 'sess-1' });
  mockBuildParentContextBlock.mockResolvedValue('');
});

describe('start_coding_session — spawn guard (fan-out throughput review 2026-09-02)', () => {
  it('refuses a chat-initiated spawn past the hourly per-parent cap with a consolidation message', async () => {
    mockChatCount.mockResolvedValueOnce(8); // at default cap
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1', title: 'Ninth child' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('DIGBY_MAX_CHILD_SPAWNS_PER_HOUR');
    expect(mockChatCount).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ parentChatId: 'sess-1' }),
    }));
  });

  it('spawns normally under the cap', async () => {
    mockChatCount.mockResolvedValueOnce(3);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1', title: 'Child task' });
    expect(out).not.toContain('spawn REFUSED');
  });

  it('fails OPEN when the count query errors (guard is best-effort)', async () => {
    mockChatCount.mockRejectedValueOnce(new Error('db down'));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1', title: 'Child task' });
    expect(out).not.toContain('spawn REFUSED');
  });
});

describe('start_coding_session — lineage at spawn (piece 1)', () => {
  it('records parentChatId on the new session when the caller is a same-user chat, and wires the result hook', async () => {
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1', title: 'Child task' });
    // Lineage write: child row stamped with the CALLING chat id.
    expect(mockChatUpdate).toHaveBeenCalledWith({ where: { id: 'sess-new' }, data: { parentChatId: 'sess-1' } });
    // Auto result-hook (piece 2): child → parent, via the hooks.service helper.
    expect(mockEnsureChildResultHook).toHaveBeenCalledWith({ userId: 'u1', parentChatId: 'sess-1', childChatId: 'sess-new' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, tool: 'start_coding_session', ids: { sessionId: 'sess-new' } });
    expect(parsed.message).toMatch(/SUB-SESSION/);
    expect(parsed.message).toMatch(/hook hook-1/);
  });

  it('does NOT record lineage when the calling chat belongs to a DIFFERENT user', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'sess-1', userId: 'someone-else' });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1' });
    expect(mockChatUpdate).not.toHaveBeenCalled();
    expect(mockEnsureChildResultHook).not.toHaveBeenCalled();
    expect(JSON.parse(out).message).not.toMatch(/SUB-SESSION/);
  });

  it('does NOT record lineage when the calling chat does not resolve', async () => {
    mockChatFindUnique.mockResolvedValue(null);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1' });
    expect(mockChatUpdate).not.toHaveBeenCalled();
    expect(JSON.parse(out).message).not.toMatch(/SUB-SESSION/);
  });

  it('a lineage-read failure degrades to a PLAIN spawn (never fails the call)', async () => {
    mockChatFindUnique.mockRejectedValue(new Error('db down'));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1' });
    expect(svc.startCodingSession).toHaveBeenCalled();
    expect(JSON.parse(out)).toMatchObject({ ok: true, ids: { sessionId: 'sess-new' } });
  });

  it('a hook-wiring failure degrades the note, never the spawn (lineage still recorded)', async () => {
    mockEnsureChildResultHook.mockResolvedValue(null);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1' });
    expect(mockChatUpdate).toHaveBeenCalled();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toMatch(/result hook could not be wired/);
  });
});

describe('start_coding_session — journal inheritance (piece 4)', () => {
  it("prefixes the child's first prompt with the parent's [PARENT SESSION CONTEXT] block", async () => {
    mockBuildParentContextBlock.mockResolvedValue('[PARENT SESSION CONTEXT — …]\n- 2026-09-01: fixed the reaper → shipped');
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1', prompt: 'Do the follow-up task' });
    expect(mockBuildParentContextBlock).toHaveBeenCalledWith('sess-1');
    expect(svc.startCodingSession).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '[PARENT SESSION CONTEXT — …]\n- 2026-09-01: fixed the reaper → shipped\n\nDo the follow-up task',
    }));
  });

  it('no prompt = no injection (a context-only first message would start a goalless run)', async () => {
    mockBuildParentContextBlock.mockResolvedValue('[PARENT SESSION CONTEXT — …]\n- entry');
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1' });
    expect(mockBuildParentContextBlock).not.toHaveBeenCalled();
    expect(svc.startCodingSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: undefined }));
  });

  it('an empty parent journal leaves the prompt untouched', async () => {
    mockBuildParentContextBlock.mockResolvedValue('');
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1', prompt: 'Bare goal' });
    expect(svc.startCodingSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Bare goal' }));
  });

  it('an inheritance failure degrades to the RAW prompt (never fails the spawn)', async () => {
    mockBuildParentContextBlock.mockRejectedValue(new Error('journal down'));
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1', prompt: 'Bare goal' });
    expect(svc.startCodingSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Bare goal' }));
  });
});

describe('implicit parent→child autonomy (piece 3 — gate wiring)', () => {
  it('a MACHINE run EXECUTES send_chat_message when the target is its own child', async () => {
    autonomySvc.implicitParentAutonomyAllows.mockResolvedValue(true);
    svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'child-1', mode: 'single_thinking' });
    const ctx = makeCtx(); // NO userTurnAt — machine-triggered, no grant, not auto-coding
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'child-1', content: 'steer the child' });
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'child-1', userId: 'u1' }));
    expect(autonomySvc.implicitParentAutonomyAllows).toHaveBeenCalledWith({
      callerChatId: 'sess-1', userId: 'u1', tool: 'send_chat_message', args: { chatId: 'child-1', content: 'steer the child' },
    });
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith({
      chatId: 'sess-1', tool: 'send_chat_message', userId: 'u1', note: 'implicit parent→child autonomy',
    });
  });

  it('a MACHINE run targeting a NON-child stays on the confirmation flow', async () => {
    autonomySvc.implicitParentAutonomyAllows.mockResolvedValue(false);
    const ctx = makeCtx();
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'stranger-1', content: 'x' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
  });

  it('an implicit-check ERROR fails CLOSED into the confirmation flow', async () => {
    autonomySvc.implicitParentAutonomyAllows.mockRejectedValue(new Error('db down'));
    const ctx = makeCtx();
    const out = await executePlatformTool(ctx, 'cancel_schedule', { id: 'sch_1' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });

  it('a USER-anchored run never consults the implicit scope (the confirm protocol is the path)', async () => {
    const ctx = makeCtx({ userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'child-1', content: 'x' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(autonomySvc.implicitParentAutonomyAllows).not.toHaveBeenCalled();
  });

  it('a STORED grant still wins first (implicit scope not consulted)', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48 });
    svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'c1', mode: 'single_thinking' });
    const out = await executePlatformTool(makeCtx(), 'send_chat_message', { chatId: 'c1', content: 'x' });
    expect(out).not.toMatch(/needsConfirmation/);
    expect(autonomySvc.implicitParentAutonomyAllows).not.toHaveBeenCalled();
  });
});

describe('tool descriptions document the sub-session behaviors (close-out rider)', () => {
  const descOf = (name: string): string => {
    const tool = (PLATFORM_TOOL_SCHEMA as any[]).find((t) => t.function?.name === name);
    expect(tool).toBeDefined();
    return String(tool.function.description);
  };

  it.each(['send_chat_message', 'update_schedule', 'cancel_schedule'])(
    '%s tells models about the implicit parent scope (own children, no confirmation)',
    (name) => {
      const desc = descOf(name);
      expect(desc).toContain('without confirmation');
      expect(desc).toContain('implicit parent scope');
      expect(desc.toLowerCase()).toContain('child');
    },
  );

  it('start_coding_session documents the auto-wired child result hook + inherited parent journal context', () => {
    const desc = descOf('start_coding_session');
    expect(desc).toContain('CHILD');
    expect(desc).toContain('result hook');
    expect(desc).toContain('[PARENT SESSION CONTEXT]');
  });
});

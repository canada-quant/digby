/**
 * SHARED-PROJECT-DISPATCH (supervisor SOTA round 3, 2026-10-20; ticket
 * 22d667e7) — the start_coding_session executor for a project MEMBER: the
 * charter lookups (goal / todo stamped with the PROJECT OWNER's id resolve by
 * id + the caller's role on the project; no role = "not found"; kill switch
 * SPAWN_MEMBER_ACCESS_DISABLED=1 = caller-scoped again), the todo assignment
 * by id, the member-spawn envelope (role, owner identity, audit) and the
 * DIRECT child-result hook (a project-scope hook hears only same-owner lanes).
 *
 * Scaffolding mirrors platform-tools.project-supervisor-spawn.test.ts.
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
  getProjectAccess: jest.fn(),
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
  shortenFilingTitle: jest.fn(() => ({ shortened: false })),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

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

// Redis — the guard's breaker state (dynamic import). Indirection consts so
// clearAllMocks doesn't kill the wiring (canonical pattern).
const mockRedisGet: jest.Mock = jest.fn(async () => null);
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisIncr: jest.Mock = jest.fn(async () => 1);
const mockRedisExpire: jest.Mock = jest.fn(async () => 1);
const mockRedisTtl: jest.Mock = jest.fn(async () => -1);
// Hardening 2026-09-14: DECR (release on a failed spawn) + pTTL (lost-EXPIRE heal).
const mockRedisDecr: jest.Mock = jest.fn(async () => 0);
const mockRedisPttl: jest.Mock = jest.fn(async () => 300_000);
// 2026-10-20: the live worker-slot registry hash (coding/worker-slots.ts) the ceiling reads.
const mockRedisHGetAll: jest.Mock = jest.fn(async () => ({}));
const mockRedisHSet: jest.Mock = jest.fn(async () => 1);
const mockRedisHDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    incr: (...a: any[]) => mockRedisIncr(...a),
    expire: (...a: any[]) => mockRedisExpire(...a),
    ttl: (...a: any[]) => mockRedisTtl(...a),
    decr: (...a: any[]) => mockRedisDecr(...a),
    pTTL: (...a: any[]) => mockRedisPttl(...a),
    hGetAll: (...a: any[]) => mockRedisHGetAll(...a),
    hSet: (...a: any[]) => mockRedisHSet(...a),
    hDel: (...a: any[]) => mockRedisHDel(...a),
  },
}));

// The spend ledger (dynamic import in the guard).
const mockTrailingSpend: jest.Mock = jest.fn(async () => ({
  chatUsd: 0, projectUsd: 0, projectId: 'proj-1', chatCodingUsd: 0, projectCodingUsd: 0,
}));
jest.mock('../coding/spend-cap.service', () => ({
  __esModule: true,
  trailingSpend24h: (...a: any[]) => mockTrailingSpend(...a),
}));

// loop-metrics (dynamic import in the trip helper) — records breaker trips.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { PROJECT_SUPERVISOR_BREAKER: 'project_supervisor_breaker' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// config/database: the pending-confirmations registry PLUS the lineage reads/
// writes and the guard's DB checks (children findMany, coding states, live
// agent runs, hourly count).
const mockConfirmations = createPendingConfirmationTable();
const mockChatFindUnique: jest.Mock = jest.fn();
const mockChatUpdate: jest.Mock = jest.fn(async () => ({}));
const mockChatCount: jest.Mock = jest.fn(async () => 0);
const mockChatFindMany: jest.Mock = jest.fn(async () => []);
const mockCodingStateFindMany: jest.Mock = jest.fn(async () => []);
const mockAgentRunFindMany: jest.Mock = jest.fn(async () => []);
// Supervisor OFF switch (owner 2026-09-26): the SystemSetting read behind the
// spawn refusal — null (no row) = ON, every pre-existing test untouched.
const mockSettingFind: jest.Mock = jest.fn(async () => null);
// Session titles (2026-09-27): the goalId / todoId charter resolution in the spawn executor.
const mockTodoFindFirst: jest.Mock = jest.fn(async () => null);
const mockGoalFindFirst: jest.Mock = jest.fn(async () => null);
const mockTodoUpdateMany: jest.Mock = jest.fn(async () => ({ count: 1 }));
// audit 2026-10-06 T5-1: the ENABLED project-scope hook probe (default: a live hook — today's covered branch).
const mockEventHookFindFirst: jest.Mock = jest.fn(async () => ({ id: 'proj-hook-1' }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      update: (...a: any[]) => mockChatUpdate(...a),
      count: (...a: any[]) => mockChatCount(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
    },
    chatCodingState: {
      findMany: (...a: any[]) => mockCodingStateFindMany(...a),
    },
    agentRun: {
      findMany: (...a: any[]) => mockAgentRunFindMany(...a),
    },
    systemSetting: {
      findUnique: (...a: any[]) => mockSettingFind(...a),
    },
    projectTodo: {
      findFirst: (...a: any[]) => mockTodoFindFirst(...a),
      updateMany: (...a: any[]) => mockTodoUpdateMany(...a),
    },
    projectGoal: {
      findFirst: (...a: any[]) => mockGoalFindFirst(...a),
    },
    eventHook: {
      findFirst: (...a: any[]) => mockEventHookFindFirst(...a),
    },
  },
}));

import { executePlatformTool } from './platform-tools';
import { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-sup', userId: 'u1', permissionMode: 'auto',
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
  id: 'sess-new', title: 'Worker task', projectId: 'proj-1',
  branch: 'digby/session-new', baseBranch: 'main', model: 'glm-5.3', permissionMode: 'auto',
};

/** The calling chat IS a project supervisor for proj-1 (the lane under test). */
const SUPERVISOR_CALLER = { id: 'sess-sup', userId: 'u1', isProjectSupervisor: true, projectId: 'proj-1' };

const GUARD_ENVS = [
  'DIGBY_PROJECT_SUPERVISOR_SPAWNS_PER_HOUR',
  'DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS',
  'DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD',
  'DIGBY_PROJECT_SUPERVISOR_STORM_MAX_SPAWNS_10MIN',
  'DIGBY_PROJECT_SUPERVISOR_STORM_COOLDOWN_SEC',
  // Project-supervisor preflight 2026-09-14
  'DIGBY_PROJECT_SUPERVISOR_STORM_ENFORCE',
  // Hardening 2026-09-14: the hourly rate cap is observe-only unless armed.
  'DIGBY_PROJECT_SUPERVISOR_RATE_ENFORCE',
  'CODING_WORKER_CONCURRENCY',
  // 2026-10-20: the live slot registry's kill switch.
  'WORKER_SLOT_REGISTRY_DISABLED',
];




beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  for (const k of GUARD_ENVS) delete process.env[k];
  autonomySvc.getChatAutonomy.mockResolvedValue(null);
  svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
  mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
  mockChatUpdate.mockResolvedValue({});
  mockChatCount.mockResolvedValue(0);
  mockChatFindMany.mockResolvedValue([]);
  mockCodingStateFindMany.mockResolvedValue([]);
  mockAgentRunFindMany.mockResolvedValue([]);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisIncr.mockResolvedValue(1);
  mockRedisExpire.mockResolvedValue(1);
  mockRedisTtl.mockResolvedValue(-1);
  mockRedisDecr.mockResolvedValue(0);
  mockRedisPttl.mockResolvedValue(300_000); // a healthy window: TTL present
  mockRedisHGetAll.mockResolvedValue({}); // no worker has published its slots — the env / default chain applies
  mockTrailingSpend.mockResolvedValue({ chatUsd: 0, projectUsd: 0, projectId: 'proj-1', chatCodingUsd: 0, projectCodingUsd: 0 });
  mockEnsureChildResultHook.mockResolvedValue({ id: 'hook-1', sourceChatId: 'sess-new', targetChatId: 'sess-sup' });
  mockBuildParentContextBlock.mockResolvedValue('');
  mockEventHookFindFirst.mockResolvedValue({ id: 'proj-hook-1' });
  mockTodoFindFirst.mockResolvedValue(null);
  mockGoalFindFirst.mockResolvedValue(null);
  delete process.env.PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED;
  delete process.env.SPAWN_CHARTER_FIRST_PROMPT_DISABLED;
});


const EDITOR = 'u-editor';
const OWNER = 'u-owner';
/** The editor's project-supervisor chat on the SHARED project proj-1 (owned by OWNER). */
const MEMBER_SUPERVISOR = { id: 'sess-sup', userId: EDITOR, isProjectSupervisor: true, projectId: 'proj-1' };
const memberCtx = () => makeCtx({ agentSurface: 'coding', userId: EDITOR } as any);
/** The ticket 22d667e7 goal: created by the editor's supervisor seconds earlier, stamped with the PROJECT OWNER. */
const OWNER_GOAL = { id: 'goal-d1a9', title: 'Owner-requested site edits', projectId: 'proj-1', userId: OWNER };
const OWNER_TODO = { id: 'todo-447b', title: 'Fix the donate page', goalId: 'goal-d1a9', projectId: 'proj-1', userId: OWNER };

describe('SHARED-PROJECT-DISPATCH — charter lookups (ticket 22d667e7)', () => {
  beforeEach(() => {
    delete process.env.SPAWN_MEMBER_ACCESS_DISABLED;
    mockChatFindUnique.mockResolvedValue(MEMBER_SUPERVISOR);
  });
  afterEach(() => { delete process.env.SPAWN_MEMBER_ACCESS_DISABLED; });

  it('an editor\'s goalId (stamped with the project owner) resolves by id + its role on the project — the spawn proceeds with the charter', async () => {
    // Owner-scoped read (where.userId = the editor) misses; the by-id read finds the owner-stamped row.
    mockGoalFindFirst.mockImplementation(async ({ where }: any) => (where?.userId ? null : OWNER_GOAL));
    svc.getProjectAccess.mockResolvedValue({ project: { id: 'proj-1' }, role: 'editor' });
    const out = await executePlatformTool(memberCtx(), 'start_coding_session', { projectId: 'proj-1', goalId: 'goal-d1a9', prompt: 'Do the site edits' });
    expect(out).not.toMatch(/not found in your account/);
    expect(svc.getProjectAccess).toHaveBeenCalledWith('proj-1', EDITOR);
    expect(svc.startCodingSession).toHaveBeenCalledWith(expect.objectContaining({ userId: EDITOR, projectId: 'proj-1' }));
  });

  it('a todoId the editor can read resolves; the todo is then ASSIGNED by id (the row is the owner\'s)', async () => {
    mockTodoFindFirst.mockImplementation(async ({ where }: any) => (where?.userId ? null : OWNER_TODO));
    svc.getProjectAccess.mockResolvedValue({ project: { id: 'proj-1' }, role: 'editor' });
    const out = await executePlatformTool(memberCtx(), 'start_coding_session', { projectId: 'proj-1', todoId: 'todo-447b', prompt: 'Fix it' });
    expect(out).not.toMatch(/not found in your account/);
    expect(svc.startCodingSession).toHaveBeenCalled();
    const assign = mockTodoUpdateMany.mock.calls.find((c: any[]) => c[0]?.data?.assigneeChatId === 'sess-new');
    expect(assign?.[0]?.where).toEqual({ id: 'todo-447b', assigneeChatId: null });
  });

  it('a caller with NO role on the row\'s project still reads "not found" (no existence leak) and nothing spawns', async () => {
    mockGoalFindFirst.mockImplementation(async ({ where }: any) => (where?.userId ? null : OWNER_GOAL));
    svc.getProjectAccess.mockResolvedValue(null);
    const out = await executePlatformTool(memberCtx(), 'start_coding_session', { projectId: 'proj-1', goalId: 'goal-d1a9' });
    expect(out).toContain('goal goal-d1a9 not found in your account');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });

  it('SPAWN_MEMBER_ACCESS_DISABLED=1 restores the caller-scoped lookup (one read, no access check)', async () => {
    process.env.SPAWN_MEMBER_ACCESS_DISABLED = '1';
    mockGoalFindFirst.mockImplementation(async ({ where }: any) => (where?.userId ? null : OWNER_GOAL));
    const out = await executePlatformTool(memberCtx(), 'start_coding_session', { projectId: 'proj-1', goalId: 'goal-d1a9' });
    expect(out).toContain('not found in your account');
    expect(mockGoalFindFirst).toHaveBeenCalledTimes(1);
    expect(svc.getProjectAccess).not.toHaveBeenCalled();
  });
});

describe('SHARED-PROJECT-DISPATCH — a member-caused spawn', () => {
  beforeEach(() => {
    delete process.env.SPAWN_MEMBER_ACCESS_DISABLED;
    mockChatFindUnique.mockResolvedValue(MEMBER_SUPERVISOR);
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, userId: OWNER, spawnedByUserId: EDITOR, spawnedByRole: 'editor' });
  });

  it('the envelope names the role, the owner identity and the audit; a DIRECT child-result hook is wired (the project hook hears only same-owner lanes)', async () => {
    const out = await executePlatformTool(memberCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Site edit', prompt: 'go' });
    const env = JSON.parse(out);
    expect(env.ids).toMatchObject({ sessionId: 'sess-new', spawnedByUserId: EDITOR, spawnedByRole: 'editor', runUserId: OWNER });
    expect(env.message).toContain('SHARED PROJECT: you are editor (member)');
    expect(env.message).toContain('runs as the PROJECT OWNER');
    // The live project-scope hook is NOT trusted for an owner-owned child — the direct hook is wired.
    expect(mockEnsureChildResultHook).toHaveBeenCalledWith({ userId: EDITOR, parentChatId: 'sess-sup', childChatId: 'sess-new' });
    expect(env.message).toMatch(/runs as the project owner, which your project-scope hook does not hear/);
    // review fix: the credential exposure is STATED on the envelope (the owner decision covers it explicitly)
    expect(env.message).toContain("it runs with the owner's coding credentials and GitHub token");
  });

  it('an owner\'s own spawn keeps the project-scope hook (no direct hook, no member note)', async () => {
    mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(mockEnsureChildResultHook).not.toHaveBeenCalled();
    expect(out).not.toContain('SHARED PROJECT');
    expect(JSON.parse(out).ids.spawnedByUserId).toBeUndefined();
  });

  it('a 403 from the service (a viewer, or the kill switch) is a clean refusal naming the role — never a thrown tool error', async () => {
    const err: any = new Error('Cannot start a coding session in project "proj-1": your role on it is viewer (read-only member) — only the owner, an admin or an editor can start lanes there.');
    err.statusCode = 403;
    svc.startCodingSession.mockRejectedValue(err);
    const out = await executePlatformTool(memberCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Nope' });
    expect(out).toContain('viewer (read-only member)');
    expect(mockRedisDecr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
  });
});

describe('SHARED-PROJECT-DISPATCH — file_feedback carries the filer facts the auto-approval needs (review fix)', () => {
  beforeEach(() => {
    mockChatFindUnique.mockResolvedValue(MEMBER_SUPERVISOR);
    fb.fileFeedbackTicket.mockResolvedValue({ ticket: { id: 't-1', type: 'bug_report', priority: 2, title: 'Spawn refuses', status: 'open', context: {} } });
  });
  const ARGS = { type: 'bug_report', title: 'Spawn refuses', description: 'start_coding_session refused', about: 'digby_platform', digbyEvidence: 'reproduces in Digby\'s own API' };

  it('a MACHINE-turn platform filing from the member\'s project supervisor carries the seat, the CHAT\'s project and filerMachineTurn true', async () => {
    await executePlatformTool(memberCtx(), 'file_feedback', ARGS);
    expect(fb.fileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ filerSeat: 'project_supervisor', filerProjectId: 'proj-1', filerMachineTurn: true }));
  });

  it('a HUMAN turn (someone typing the ask in their own supervisor chat) is stamped filerMachineTurn false — never auto-approved', async () => {
    await executePlatformTool(makeCtx({ agentSurface: 'coding', userId: EDITOR, userTurnAt: new Date() } as any), 'file_feedback', ARGS);
    expect(fb.fileFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ filerSeat: 'project_supervisor', filerMachineTurn: false }));
  });

  it('a non-supervisor chat carries no seat (and so no filer facts)', async () => {
    mockChatFindUnique.mockResolvedValue({ ...MEMBER_SUPERVISOR, isProjectSupervisor: false });
    await executePlatformTool(memberCtx(), 'file_feedback', ARGS);
    const opts = fb.fileFeedbackTicket.mock.calls[0][0];
    expect(opts.filerSeat).toBeUndefined();
    expect(opts.filerMachineTurn).toBeUndefined();
  });
});

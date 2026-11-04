/**
 * Fleet supervisor (slice D) — the goal/todo/hook platform tools
 * (platform-tools.ts), with goals.service / hooks.service / autonomy.service
 * mocked at the module boundary (they pull prisma/crossmodel chains; the
 * dispatch reaches them via DYNAMIC import, which jest.mock intercepts).
 *
 * Pins:
 *   - name-set membership: the 5 read tools in PLATFORM_READ_TOOLS (and NOT in
 *     coding MUTATING_TOOLS), the 7 mutating tools in PLATFORM_MUTATING_TOOLS
 *     (and in coding MUTATING_TOOLS), and all 12 in CHAT_PROFILE_PLATFORM_TOOLS
 *     with no extra wiring;
 *   - schema registration (required args + cross-referencing descriptions);
 *   - dispatch arg mapping to the services (incl. createdByChatId =
 *     ctx.sessionId on goal_create, the todo_list exactly-one-filter rule, and
 *     hook_subscribe's eventTypes passthrough);
 *   - the fleet mutating tools are NOT consequential: a machine-triggered run
 *     (no ctx.userTurnAt) executes them directly — no pending confirmation is
 *     registered and the autonomy allowlist is never consulted;
 *   - service errors propagate to the caller (executeCodingTool turns them
 *     into model-visible "Tool … failed" strings);
 *   - the fleet list cap (100 rows) marks truncated payloads.
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

// The service layer under the tools — fully mocked (the fleet dispatch never
// touches platform.service, but platform-tools.ts imports it statically).
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
// agent-auth pulls config/database + utils/jwt → config/env, which calls
// process.exit(1) without env vars — mirror the constant (see platform-tools.test.ts).
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read',
    'chats:write',
    'folders:read',
    'folders:write',
    'schedules:write',
    'code:run',
  ] as const,
}));

jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// config/database for the DB-persisted confirmation registry (pending-confirmations.ts):
// the registry lazy-imports it at CALL time; the gate tests below run it for real
// against this in-memory table.
const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { pendingConfirmation: mockConfirmations.api } }));

// The feedback service under the feedback tools — fully mocked. FEEDBACK_TYPES
// is read at MODULE SCOPE by the tool schema, so mirror the real constant.
const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// autonomy.service under the consequential gate — fully mocked. The fleet
// tools must NEVER consult it (they are not consequential); the mock lets us
// pin that.
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async (): Promise<any> => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// The fleet services — fully mocked; dispatch arg mapping is what we pin.
const goalsSvc = {
  listGoals: jest.fn(),
  createGoal: jest.fn(),
  updateGoal: jest.fn(),
  getGoal: jest.fn(),
  listTodos: jest.fn(),
  createTodo: jest.fn(),
  updateTodo: jest.fn(),
  getTodo: jest.fn(),
  explainEmptyAccountWideTodoList: jest.fn(),
};
jest.mock('./goals.service', () => ({ __esModule: true, ...goalsSvc }));

const hooksSvc = {
  listHooks: jest.fn(),
  subscribeHook: jest.fn(),
  updateHook: jest.fn(),
  unsubscribeHook: jest.fn(),
  // Duplicate-coverage probe (ticket dd3a19fa) — consulted only on WILDCARD
  // subscribes; default [] = no covering hooks.
  findCoveringHooks: jest.fn(async (): Promise<any> => []),
};
jest.mock('./hooks.service', () => ({ __esModule: true, ...hooksSvc }));

// The supervisor-state service under update_supervisor_state (2026-08-22
// durable-state rebuild) — fully mocked; the supervisor-only guard + dispatch
// arg passthrough is what we pin. Reached via DYNAMIC import like the others.
const supStateSvc = {
  isSupervisorChat: jest.fn(async () => false),
  // three-state twin the supervisor-only executors read (review fixer
  // 2026-09-27): follows isSupervisorChat unless a test pins it to null
  supervisorChatFlag: jest.fn(async (): Promise<boolean | null> => supStateSvc.isSupervisorChat()),
  applyStateUpdate: jest.fn(async () => ({ applied: [] as string[], errors: [] as string[] })),
};
jest.mock('./supervisor-state.service', () => ({ __esModule: true, ...supStateSvc }));

// The platform-engineering lane under dispatch_platform_task (Option D,
// 2026-08-22) — fully mocked; the admin gate + degrade-to-ticket behavior is
// what we pin. Reached via DYNAMIC import like the others.
const laneSvc = {
  dispatchTaskToLane: jest.fn(async (): Promise<any> => ({ sent: true })),
  ticketLaneConcurrency: jest.fn(() => 3),
};
jest.mock('../feedback/ticket-dispatch.service', () => ({ __esModule: true, ...laneSvc }));

import {
  PLATFORM_TOOL_SCHEMA, PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS, executePlatformTool,
} from './platform-tools';
import { MUTATING_TOOLS, ToolContext } from '../coding/tools';
import { CHAT_PROFILE_PLATFORM_TOOLS } from '../coding/agent-profiles';
import { pendingConfirmationCount } from './pending-confirmations';

const FLEET_READ = ['goal_list', 'todo_list', 'hook_list', 'goal_get', 'todo_get'];
const FLEET_MUTATING = ['goal_create', 'goal_update', 'todo_create', 'todo_update', 'hook_subscribe', 'hook_update', 'hook_unsubscribe'];
const FLEET_ALL = [...FLEET_READ, ...FLEET_MUTATING];

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

const GOAL = {
  id: 'g1', projectId: 'p1', title: 'Ship v2', description: 'the release', status: 'active',
  blockedReason: null, createdByChatId: 'sess-1', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  dependsOnGoalIds: ['g0'], dependentGoalIds: [], todos: [{ id: 't1', title: 'step', status: 'pending' }],
};
const TODO = {
  id: 't1', goalId: 'g1', projectId: 'p1', title: 'step', status: 'pending',
  blockedReason: null, assigneeChatId: 'c9', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  dependsOnTodoIds: ['t0'],
};
const HOOK = {
  id: 'h1', sourceChatId: 'c1', targetChatId: 'c2', eventTypes: ['run_completed'],
  promptTemplate: '', enabled: true, debounceSec: 60, lastFiredAt: null, createdAt: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  autonomySvc.getChatAutonomy.mockResolvedValue(null);
});

describe('fleet tool registration', () => {
  it('read tools join PLATFORM_READ_TOOLS; mutating tools join PLATFORM_MUTATING_TOOLS', () => {
    for (const t of FLEET_READ) {
      expect(PLATFORM_READ_TOOLS).toContain(t);
      expect(PLATFORM_MUTATING_TOOLS).not.toContain(t);
      expect(MUTATING_TOOLS.has(t)).toBe(false); // never permission-gated
    }
    for (const t of FLEET_MUTATING) {
      expect(PLATFORM_MUTATING_TOOLS).toContain(t);
      expect(PLATFORM_READ_TOOLS).not.toContain(t);
      expect(MUTATING_TOOLS.has(t)).toBe(true); // auto/plan/ask gating via coding/tools.ts
    }
  });

  it('CHAT_PROFILE_PLATFORM_TOOLS picks all 12 up with no extra wiring', () => {
    for (const t of FLEET_ALL) expect(CHAT_PROFILE_PLATFORM_TOOLS).toContain(t);
  });

  it('all 12 are in PLATFORM_TOOL_SCHEMA with the expected required args', () => {
    const byName = new Map(PLATFORM_TOOL_SCHEMA.map((t) => [t.function.name, t]));
    for (const t of FLEET_ALL) expect(byName.has(t)).toBe(true);
    const required = (n: string) => (byName.get(n)!.function.parameters as any).required;
    expect(required('goal_list')).toBeUndefined(); // projectId optional — omitted = account-wide (owned projects, tagged)
    expect(required('goal_get')).toEqual(['goalId']);
    expect(required('goal_create')).toEqual(['projectId', 'title']);
    expect(required('goal_update')).toEqual(['goalId']);
    expect(required('todo_list')).toBeUndefined(); // goalId XOR projectId enforced at dispatch/service
    expect(required('todo_get')).toEqual(['todoId']);
    expect(required('todo_create')).toEqual(['goalId', 'title']);
    expect(required('todo_update')).toEqual(['todoId']);
    expect(required('hook_list')).toBeUndefined();
    expect(required('hook_subscribe')).toEqual(['targetChatId', 'eventTypes']); // sourceChatId optional (omitted = owner-scope wildcard)
    expect(required('hook_update')).toEqual(['hookId']); // every field optional — omitted fields keep stored values
    expect(required('hook_unsubscribe')).toEqual(['hookId']);
  });

  it('list descriptions advertise the account-wide default and projectName tagging', () => {
    const byName = new Map(PLATFORM_TOOL_SCHEMA.map((t) => [t.function.name, t.function.description]));
    for (const tool of ['goal_list', 'todo_list'] as const) {
      expect(byName.get(tool)).toMatch(/ACCOUNT-WIDE/);
      expect(byName.get(tool)).toMatch(/projectName/);
      expect(byName.get(tool)).toMatch(/OWNS/); // owned projects only — shared ones stay scoped
    }
  });

  it('descriptions cross-reference the fleet workflow', () => {
    const byName = new Map(PLATFORM_TOOL_SCHEMA.map((t) => [t.function.name, t.function.description]));
    expect(byName.get('goal_create')).toMatch(/todo_create/);
    expect(byName.get('goal_update')).toMatch(/todo_update/);
    expect(byName.get('todo_create')).toMatch(/hook_subscribe/);
    // hook_subscribe must explain the wake semantics + the autonomy grant nudge.
    expect(byName.get('hook_subscribe')).toMatch(/AUTONOMOUS run/);
    expect(byName.get('hook_subscribe')).toMatch(/depth-cap|capped at 3/i);
    expect(byName.get('hook_subscribe')).toMatch(/SAME OWNER/i);
    expect(byName.get('hook_subscribe')).toMatch(/set_chat_autonomy/);
    // …and the owner-scope WILDCARD (omit sourceChatId ⇒ all owned chats fan in).
    expect(byName.get('hook_subscribe')).toMatch(/wildcard/i);
    expect(byName.get('hook_list')).toMatch(/hook_unsubscribe/);
    // hook_list notes the wildcard representation (sourceChatId null).
    expect(byName.get('hook_list')).toMatch(/null for a WILDCARD/);
    // hook_update explains in-place semantics: keep-on-omit, pause via enabled,
    // and that rewiring endpoints stays a new hook_subscribe.
    expect(byName.get('hook_update')).toMatch(/IN PLACE/);
    expect(byName.get('hook_update')).toMatch(/Omitted fields keep/i);
    expect(byName.get('hook_update')).toMatch(/hook_subscribe/);
  });
});

describe('goal tools dispatch', () => {
  it('goal_list maps filters and returns the goals payload', async () => {
    goalsSvc.listGoals.mockResolvedValue([GOAL]);
    const out = await executePlatformTool(makeCtx(), 'goal_list', { projectId: 'p1', includeDescendants: true, status: 'blocked' });
    expect(goalsSvc.listGoals).toHaveBeenCalledWith({ userId: 'u1', projectId: 'p1', includeDescendants: true, status: 'blocked' });
    const parsed = JSON.parse(out);
    expect(parsed.goals).toEqual([GOAL]);
    expect(parsed.count).toBe(1);
  });

  it('goal_list defaults: omitted filters are not passed to the service', async () => {
    goalsSvc.listGoals.mockResolvedValue([GOAL]);
    await executePlatformTool(makeCtx(), 'goal_list', { projectId: 'p1' });
    expect(goalsSvc.listGoals).toHaveBeenCalledWith({ userId: 'u1', projectId: 'p1' });
  });

  it('goal_list without projectId lists ACCOUNT-WIDE (owned projects, tagged) — no other filter passed', async () => {
    goalsSvc.listGoals.mockResolvedValue([{ ...GOAL, projectName: 'P1' }]);
    const out = await executePlatformTool(makeCtx(), 'goal_list', {});
    expect(goalsSvc.listGoals).toHaveBeenCalledWith({ userId: 'u1' });
    expect(JSON.parse(out).goals[0].projectName).toBe('P1');
  });

  it('goal_list on an empty result says so (no JSON), with account-wide wording when unscoped', async () => {
    goalsSvc.listGoals.mockResolvedValue([]);
    expect(await executePlatformTool(makeCtx(), 'goal_list', { projectId: 'p1' })).toMatch(/No goals found for that project/);
    expect(await executePlatformTool(makeCtx(), 'goal_list', {})).toMatch(/No goals found in any of your projects/);
  });

  it('goal_list caps at 100 rows and marks the payload truncated', async () => {
    goalsSvc.listGoals.mockResolvedValue(Array.from({ length: 101 }, (_, i) => ({ ...GOAL, id: `g${i}` })));
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'goal_list', { projectId: 'p1' }));
    expect(parsed.goals).toHaveLength(100);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(101);
  });

  it('goal_create maps args, sets createdByChatId to the run chat, and returns the created goal', async () => {
    goalsSvc.createGoal.mockResolvedValue(GOAL);
    const out = await executePlatformTool(makeCtx(), 'goal_create', {
      projectId: 'p1', title: 'Ship v2', description: 'the release', dependsOnGoalIds: ['g0'],
    });
    expect(goalsSvc.createGoal).toHaveBeenCalledWith({
      userId: 'u1', projectId: 'p1', title: 'Ship v2', description: 'the release',
      createdByChatId: 'sess-1', dependsOnGoalIds: ['g0'],
      machineTriggered: true, // 2026-10-20: no ctx.userTurnAt ⇒ machine (goal_transition actorKind)
    });
    expect(out).toMatch(/Created goal g1 "Ship v2" \(status: active\)/);
    expect(JSON.parse(out.slice(out.indexOf('{')))).toEqual(GOAL);
  });

  it('goal_create notes when the goal STARTS BLOCKED on dependencies', async () => {
    goalsSvc.createGoal.mockResolvedValue({ ...GOAL, id: 'g2', status: 'blocked', blockedReason: '[deps] Waiting on 1 goal' });
    const out = await executePlatformTool(makeCtx(), 'goal_create', { projectId: 'p1', title: 'Ship v2' });
    expect(out).toMatch(/STARTS BLOCKED/);
    expect(out).toMatch(/auto-unblocks/);
  });

  it('goal_create validates projectId and title before hitting the service', async () => {
    expect(await executePlatformTool(makeCtx(), 'goal_create', { title: 'T' })).toMatch(/requires projectId/);
    expect(await executePlatformTool(makeCtx(), 'goal_create', { projectId: 'p1', title: '  ' })).toMatch(/non-empty title/);
    expect(goalsSvc.createGoal).not.toHaveBeenCalled();
  });

  it('goal_update maps every field through to the service', async () => {
    goalsSvc.updateGoal.mockResolvedValue({ ...GOAL, status: 'done' });
    const out = await executePlatformTool(makeCtx(), 'goal_update', {
      goalId: 'g1', title: 'T2', description: 'D2', status: 'done', blockedReason: 'r',
      dependsOnGoalIds: ['g2'], force: true,
    });
    expect(goalsSvc.updateGoal).toHaveBeenCalledWith({
      userId: 'u1', goalId: 'g1', title: 'T2', description: 'D2', status: 'done',
      blockedReason: 'r', dependsOnGoalIds: ['g2'], force: true,
      actingChatId: 'sess-1', // v1#8: goal_blocked emits from the ACTING chat
      machineTriggered: true, // 2026-10-20 (GOAL-OUTCOME-UNMET): no ctx.userTurnAt ⇒ machine close
    });
    expect(JSON.parse(out).status).toBe('done');
  });

  it('goal_update / goal_create / todo_create classify ORIGIN-aware (review fix 2026-10-20): an agent-origin or owner-dispatch run carrying the owner turn\'s userTurnAt is MACHINE and never forwards the owner text', async () => {
    goalsSvc.updateGoal.mockResolvedValue({ ...GOAL, status: 'done' });
    goalsSvc.createGoal.mockResolvedValue(GOAL);
    goalsSvc.createTodo.mockResolvedValue({ id: 't1', title: 't', status: 'pending' });
    const anchored = new Date();
    for (const extra of [{ machineTriggered: true }, { ownerDispatch: true }]) {
      jest.clearAllMocks();
      goalsSvc.updateGoal.mockResolvedValue({ ...GOAL, status: 'done' });
      goalsSvc.createGoal.mockResolvedValue(GOAL);
      goalsSvc.createTodo.mockResolvedValue({ id: 't1', title: 't', status: 'pending' });
      const ctx = makeCtx({ userTurnAt: anchored, userTurnText: 'close goal g1 — 5 tok/s is fine', ...extra });
      await executePlatformTool(ctx, 'goal_update', { goalId: 'g1', status: 'done' });
      const args = goalsSvc.updateGoal.mock.calls[0][0];
      expect(args.machineTriggered).toBe(true);
      expect(args).not.toHaveProperty('ownerTurnText');
      expect(args).not.toHaveProperty('ownerExplicit');
      await executePlatformTool(ctx, 'goal_create', { projectId: 'p1', title: 'T' });
      expect(goalsSvc.createGoal.mock.calls[0][0].machineTriggered).toBe(true);
      await executePlatformTool(ctx, 'todo_create', { goalId: 'g1', title: 't' });
      expect(goalsSvc.createTodo.mock.calls[0][0].machineTriggered).toBe(true);
    }
    // A genuine human turn: user-classified, and the owner's OWN text rides along
    // (goals.service decides whether it names the close — a model's call alone never accepts).
    jest.clearAllMocks();
    goalsSvc.updateGoal.mockResolvedValue({ ...GOAL, status: 'done' });
    await executePlatformTool(makeCtx({ userTurnAt: anchored, userTurnText: 'close goal g1 — 5 tok/s is fine' }), 'goal_update', { goalId: 'g1', status: 'done' });
    expect(goalsSvc.updateGoal.mock.calls[0][0]).toEqual(expect.objectContaining({ machineTriggered: false, ownerTurnText: 'close goal g1 — 5 tok/s is fine' }));
    expect(goalsSvc.updateGoal.mock.calls[0][0]).not.toHaveProperty('ownerExplicit');
  });

  it('goal_update without goalId is a validation error', async () => {
    expect(await executePlatformTool(makeCtx(), 'goal_update', { status: 'done' })).toMatch(/requires goalId/);
    expect(goalsSvc.updateGoal).not.toHaveBeenCalled();
  });

  it('service errors propagate to the caller (executeCodingTool renders them for the model)', async () => {
    goalsSvc.updateGoal.mockRejectedValue(new Error('Goal cannot be marked done: waiting on 1 goal(s) not done'));
    await expect(executePlatformTool(makeCtx(), 'goal_update', { goalId: 'g1', status: 'done' }))
      .rejects.toThrow('waiting on 1 goal');
  });

  it('goal_get resolves a bare id (no projectId) and returns the goal payload', async () => {
    goalsSvc.getGoal.mockResolvedValue(GOAL);
    const out = await executePlatformTool(makeCtx(), 'goal_get', { goalId: 'g1' });
    expect(goalsSvc.getGoal).toHaveBeenCalledWith({ userId: 'u1', goalId: 'g1' });
    expect(JSON.parse(out)).toEqual(GOAL);
  });

  it('goal_get without goalId is a validation error (service not called)', async () => {
    expect(await executePlatformTool(makeCtx(), 'goal_get', {})).toMatch(/requires goalId/);
    expect(goalsSvc.getGoal).not.toHaveBeenCalled();
  });
});

describe('todo tools dispatch', () => {
  it('todo_list accepts goalId OR projectId and maps the filter', async () => {
    goalsSvc.listTodos.mockResolvedValue([TODO]);
    let out = await executePlatformTool(makeCtx(), 'todo_list', { goalId: 'g1' });
    expect(goalsSvc.listTodos).toHaveBeenCalledWith({ userId: 'u1', goalId: 'g1' });
    expect(JSON.parse(out).todos).toEqual([TODO]);

    goalsSvc.listTodos.mockClear();
    out = await executePlatformTool(makeCtx(), 'todo_list', { projectId: 'p1' });
    expect(goalsSvc.listTodos).toHaveBeenCalledWith({ userId: 'u1', projectId: 'p1' });
  });

  it('todo_list with NO filter lists ACCOUNT-WIDE (owned projects, tagged)', async () => {
    goalsSvc.listTodos.mockResolvedValue([{ ...TODO, projectName: 'P1' }]);
    const out = await executePlatformTool(makeCtx(), 'todo_list', {});
    expect(goalsSvc.listTodos).toHaveBeenCalledWith({ userId: 'u1' });
    expect(JSON.parse(out).todos[0].projectName).toBe('P1');

    goalsSvc.listTodos.mockResolvedValue([]);
    goalsSvc.explainEmptyAccountWideTodoList.mockResolvedValue(null);
    expect(await executePlatformTool(makeCtx(), 'todo_list', {})).toMatch(/No todos found in any of your projects/);
    expect(goalsSvc.explainEmptyAccountWideTodoList).toHaveBeenCalledWith('u1');
  });

  // Replay pin: feedback 94b8e3a2 (2026-09-09) — a bare zero-row ACCOUNT-WIDE
  // todo_list read as data loss while the scoped form returned rows (the
  // caller's todos lived in member-shared/archived projects, both deliberately
  // excluded from the account-wide list). The empty path must EXPLAIN the
  // exclusion so a supervisor never rebuilds a board off a phantom "loss".
  it('todo_list empty ACCOUNT-WIDE result appends the exclusion diagnostic (feedback 94b8e3a2)', async () => {
    goalsSvc.listTodos.mockResolvedValue([]);
    goalsSvc.explainEmptyAccountWideTodoList.mockResolvedValue(
      '1 project(s) shared WITH you as a member hold 11 todo(s) — member-shared projects are deliberately EXCLUDED from the account-wide list (owner decision 2026-08-13); audit them one by one via todo_list(projectId) (list_projects enumerates your projects): "Shared" (pShared).',
    );
    const out = await executePlatformTool(makeCtx(), 'todo_list', {});
    expect(out).toMatch(/No todos found in any of your projects/);
    expect(out).toMatch(/shared WITH you as a member hold 11 todo\(s\)/);
    expect(out).toMatch(/EXCLUDED from the account-wide list/);
    // Scoped empty results keep the legacy short message (no diagnostic call).
    goalsSvc.explainEmptyAccountWideTodoList.mockClear();
    expect(await executePlatformTool(makeCtx(), 'todo_list', { projectId: 'pShared' })).toBe('No todos found for that filter.');
    expect(goalsSvc.explainEmptyAccountWideTodoList).not.toHaveBeenCalled();
  });

  it('todo_list still rejects BOTH filters together before hitting the service', async () => {
    expect(await executePlatformTool(makeCtx(), 'todo_list', { goalId: 'g1', projectId: 'p1' })).toMatch(/not both/);
    expect(goalsSvc.listTodos).not.toHaveBeenCalled();
  });

  it('todo_get resolves a bare id (no goalId/projectId) and returns the todo payload', async () => {
    goalsSvc.getTodo.mockResolvedValue(TODO);
    const out = await executePlatformTool(makeCtx(), 'todo_get', { todoId: 't1' });
    expect(goalsSvc.getTodo).toHaveBeenCalledWith({ userId: 'u1', todoId: 't1' });
    expect(JSON.parse(out)).toEqual(TODO);
  });

  it('todo_get without todoId is a validation error (service not called)', async () => {
    expect(await executePlatformTool(makeCtx(), 'todo_get', {})).toMatch(/requires todoId/);
    expect(goalsSvc.getTodo).not.toHaveBeenCalled();
  });

  it('todo_create maps assignee + dependencies and returns the created todo', async () => {
    goalsSvc.createTodo.mockResolvedValue(TODO);
    const out = await executePlatformTool(makeCtx(), 'todo_create', {
      goalId: 'g1', title: 'step', assigneeChatId: 'c9', dependsOnTodoIds: ['t0'],
    });
    expect(goalsSvc.createTodo).toHaveBeenCalledWith({
      // actingChatId (audit 2026-10-08 W5-5): an attributed create; a self-assignment never wakes the creator.
      userId: 'u1', goalId: 'g1', title: 'step', assigneeChatId: 'c9', dependsOnTodoIds: ['t0'], actingChatId: 'sess-1',
      machineTriggered: true, // 2026-10-20: todo_transition actorKind
    });
    expect(out).toMatch(/Created todo t1 "step" \(status: pending\)/);
  });

  it('todo_create validates goalId and title', async () => {
    expect(await executePlatformTool(makeCtx(), 'todo_create', { title: 't' })).toMatch(/requires goalId/);
    expect(await executePlatformTool(makeCtx(), 'todo_create', { goalId: 'g1' })).toMatch(/non-empty title/);
    expect(goalsSvc.createTodo).not.toHaveBeenCalled();
  });

  it('todo_update maps fields including assigneeChatId null (unassign)', async () => {
    goalsSvc.updateTodo.mockResolvedValue({ ...TODO, status: 'done', assigneeChatId: null });
    const out = await executePlatformTool(makeCtx(), 'todo_update', {
      todoId: 't1', status: 'done', assigneeChatId: null, force: true,
    });
    expect(goalsSvc.updateTodo).toHaveBeenCalledWith({
      userId: 'u1', todoId: 't1', status: 'done', assigneeChatId: null, force: true,
      // P4 v1#10: the dispatch threads the actor discriminator (no ctx.userTurnAt
      // in this fixture ⇒ machine); goals.service owns the evidence/force gates.
      machineTriggered: true,
      // Hardening 2026-09-14: the ACTING chat rides along (mirrors goal_update) so
      // goals.service can keep a supervisor's own todo close from waking itself.
      actingChatId: 'sess-1',
    });
    expect(JSON.parse(out).status).toBe('done');
  });

  it('todo_update without todoId is a validation error', async () => {
    expect(await executePlatformTool(makeCtx(), 'todo_update', { status: 'done' })).toMatch(/requires todoId/);
    expect(goalsSvc.updateTodo).not.toHaveBeenCalled();
  });
});

describe('hook tools dispatch', () => {
  it('hook_list maps the optional filters and returns the hooks payload', async () => {
    hooksSvc.listHooks.mockResolvedValue([HOOK]);
    const out = await executePlatformTool(makeCtx(), 'hook_list', { sourceChatId: 'c1', targetChatId: 'c2' });
    expect(hooksSvc.listHooks).toHaveBeenCalledWith({ userId: 'u1', sourceChatId: 'c1', targetChatId: 'c2' });
    const parsed = JSON.parse(out);
    expect(parsed.hooks).toEqual([HOOK]);
    expect(parsed.count).toBe(1);
  });

  it('hook_list with no filters lists everything the user owns', async () => {
    hooksSvc.listHooks.mockResolvedValue([]);
    const out = await executePlatformTool(makeCtx(), 'hook_list', {});
    expect(hooksSvc.listHooks).toHaveBeenCalledWith({ userId: 'u1' });
    expect(out).toMatch(/No event hooks found/);
  });

  it('hook_subscribe maps all args and answers with the wiring summary + autonomy reminder', async () => {
    hooksSvc.subscribeHook.mockResolvedValue({ ...HOOK, eventTypes: ['run_completed', 'todo_done'], promptTemplate: 'PT', debounceSec: 120 });
    const out = await executePlatformTool(makeCtx(), 'hook_subscribe', {
      sourceChatId: 'c1', targetChatId: 'c2', eventTypes: ['run_completed', 'todo_done'],
      promptTemplate: 'PT', debounceSec: 120,
    });
    expect(hooksSvc.subscribeHook).toHaveBeenCalledWith({
      userId: 'u1', sourceChatId: 'c1', targetChatId: 'c2',
      eventTypes: ['run_completed', 'todo_done'], promptTemplate: 'PT', debounceSec: 120,
      // Creator provenance (ticket dd3a19fa): the lane stamps itself on the row.
      createdVia: 'tool:hook_subscribe', createdByChatId: 'sess-1',
    });
    expect(out).toMatch(/hook h1/);
    expect(out).toMatch(/run_completed, todo_done/);
    expect(out).toMatch(/set_chat_autonomy/);
  });

  it('hook_subscribe omits optional args the model did not pass', async () => {
    hooksSvc.subscribeHook.mockResolvedValue(HOOK);
    // USER-anchored ctx: machine-triggered runs now REQUIRE promptTemplate
    // (ticket dd3a19fa guard) — arg-omission mapping is pinned on a user turn.
    await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'hook_subscribe', {
      sourceChatId: 'c1', targetChatId: 'c2', eventTypes: ['run_completed'],
    });
    expect(hooksSvc.subscribeHook).toHaveBeenCalledWith({
      userId: 'u1', sourceChatId: 'c1', targetChatId: 'c2', eventTypes: ['run_completed'],
      createdVia: 'tool:hook_subscribe', createdByChatId: 'sess-1',
    });
  });

  it('hook_subscribe without sourceChatId subscribes an owner-scope WILDCARD (null to the service)', async () => {
    hooksSvc.subscribeHook.mockResolvedValue({ ...HOOK, sourceChatId: null });
    const out = await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'hook_subscribe', {
      targetChatId: 'c2', eventTypes: ['run_completed'],
    });
    expect(hooksSvc.subscribeHook).toHaveBeenCalledWith({
      userId: 'u1', sourceChatId: null, targetChatId: 'c2', eventTypes: ['run_completed'],
      createdVia: 'tool:hook_subscribe', createdByChatId: 'sess-1',
    });
    expect(out).toMatch(/Subscribed/);
    expect(out).toMatch(/wildcard/i);
    expect(out).toMatch(/hook h1/);
  });

  it('hook_subscribe treats an empty-string sourceChatId as the wildcard too', async () => {
    hooksSvc.subscribeHook.mockResolvedValue({ ...HOOK, sourceChatId: null });
    await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'hook_subscribe', {
      sourceChatId: '', targetChatId: 'c2', eventTypes: ['run_completed'],
    });
    expect(hooksSvc.subscribeHook).toHaveBeenCalledWith({
      userId: 'u1', sourceChatId: null, targetChatId: 'c2', eventTypes: ['run_completed'],
      createdVia: 'tool:hook_subscribe', createdByChatId: 'sess-1',
    });
  });

  it('hook_subscribe validates targetChatId and a non-empty eventTypes array', async () => {
    expect(await executePlatformTool(makeCtx(), 'hook_subscribe', { eventTypes: ['run_completed'] }))
      .toMatch(/requires targetChatId/);
    expect(await executePlatformTool(makeCtx(), 'hook_subscribe', { sourceChatId: 'c1', targetChatId: 'c2' }))
      .toMatch(/requires eventTypes/);
    expect(await executePlatformTool(makeCtx(), 'hook_subscribe', { sourceChatId: 'c1', targetChatId: 'c2', eventTypes: [] }))
      .toMatch(/requires eventTypes/);
    expect(hooksSvc.subscribeHook).not.toHaveBeenCalled();
  });

  it('hook_update maps all provided args and answers with the refreshed wiring summary', async () => {
    hooksSvc.updateHook.mockResolvedValue({ ...HOOK, eventTypes: ['run_failed', 'attention_needed'], debounceSec: 30 });
    const out = await executePlatformTool(makeCtx(), 'hook_update', {
      hookId: 'h1', eventTypes: ['run_failed', 'attention_needed'], promptTemplate: 'PT2', debounceSec: 30, enabled: true,
    });
    expect(hooksSvc.updateHook).toHaveBeenCalledWith({
      userId: 'u1', hookId: 'h1',
      eventTypes: ['run_failed', 'attention_needed'], promptTemplate: 'PT2', debounceSec: 30, enabled: true,
    });
    expect(out).toMatch(/Updated hook h1/);
    expect(out).toMatch(/run_failed, attention_needed/);
    expect(out).toMatch(/debounce 30s/);
  });

  it('hook_update omits fields the model did not pass (keep-on-omit semantics)', async () => {
    hooksSvc.updateHook.mockResolvedValue(HOOK);
    await executePlatformTool(makeCtx(), 'hook_update', { hookId: 'h1', debounceSec: 0 });
    expect(hooksSvc.updateHook).toHaveBeenCalledWith({ userId: 'u1', hookId: 'h1', debounceSec: 0 });
  });

  it('hook_update announces a paused hook (enabled=false) with the drain-on-re-enable note', async () => {
    hooksSvc.updateHook.mockResolvedValue({ ...HOOK, enabled: false });
    const out = await executePlatformTool(makeCtx(), 'hook_update', { hookId: 'h1', enabled: false });
    expect(hooksSvc.updateHook).toHaveBeenCalledWith({ userId: 'u1', hookId: 'h1', enabled: false });
    expect(out).toMatch(/PAUSED/);
    expect(out).toMatch(/re-enabled/);
  });

  it('hook_update validates hookId and an eventTypes array that, when provided, is non-empty', async () => {
    expect(await executePlatformTool(makeCtx(), 'hook_update', { eventTypes: ['run_completed'] }))
      .toMatch(/requires hookId/);
    expect(await executePlatformTool(makeCtx(), 'hook_update', { hookId: 'h1', eventTypes: [] }))
      .toMatch(/non-empty array/);
    expect(hooksSvc.updateHook).not.toHaveBeenCalled();
  });

  it('hook_update reports a missing/foreign hook without inventing success', async () => {
    hooksSvc.updateHook.mockResolvedValue(null);
    expect(await executePlatformTool(makeCtx(), 'hook_update', { hookId: 'hX', enabled: false }))
      .toMatch(/No such hook "hX"/);
  });

  it('hook_unsubscribe reports both outcomes', async () => {
    hooksSvc.unsubscribeHook.mockResolvedValue(true);
    expect(await executePlatformTool(makeCtx(), 'hook_unsubscribe', { hookId: 'h1' })).toMatch(/Unsubscribed hook h1/);
    expect(hooksSvc.unsubscribeHook).toHaveBeenCalledWith({ userId: 'u1', hookId: 'h1' });

    hooksSvc.unsubscribeHook.mockResolvedValue(false);
    expect(await executePlatformTool(makeCtx(), 'hook_unsubscribe', { hookId: 'hX' })).toMatch(/No such hook "hX"/);
  });

  it('hook_unsubscribe without hookId is a validation error', async () => {
    expect(await executePlatformTool(makeCtx(), 'hook_unsubscribe', {})).toMatch(/requires hookId/);
    expect(hooksSvc.unsubscribeHook).not.toHaveBeenCalled();
  });
});

describe('fleet tools are NOT consequential (no confirmation gate)', () => {
  it('a MACHINE-triggered run executes all 7 mutating fleet tools directly', async () => {
    goalsSvc.createGoal.mockResolvedValue(GOAL);
    goalsSvc.updateGoal.mockResolvedValue(GOAL);
    goalsSvc.createTodo.mockResolvedValue(TODO);
    goalsSvc.updateTodo.mockResolvedValue(TODO);
    hooksSvc.subscribeHook.mockResolvedValue(HOOK);
    hooksSvc.updateHook.mockResolvedValue(HOOK);
    hooksSvc.unsubscribeHook.mockResolvedValue(true);

    const ctx = makeCtx(); // NO userTurnAt — schedule firing / hook wake
    const calls: Array<[string, any, jest.Mock]> = [
      ['goal_create', { projectId: 'p1', title: 'T' }, goalsSvc.createGoal],
      ['goal_update', { goalId: 'g1', status: 'done' }, goalsSvc.updateGoal],
      ['todo_create', { goalId: 'g1', title: 't' }, goalsSvc.createTodo],
      ['todo_update', { todoId: 't1', status: 'done' }, goalsSvc.updateTodo],
      ['hook_subscribe', { sourceChatId: 'c1', targetChatId: 'c2', eventTypes: ['run_completed'], promptTemplate: 'wake tpl {{summary}}' }, hooksSvc.subscribeHook],
      ['hook_update', { hookId: 'h1', debounceSec: 120 }, hooksSvc.updateHook],
      ['hook_unsubscribe', { hookId: 'h1' }, hooksSvc.unsubscribeHook],
    ];
    for (const [name, args, mock] of calls) {
      const out = await executePlatformTool(ctx, name, args);
      expect(out).not.toMatch(/needsConfirmation/);
      expect(mock).toHaveBeenCalledTimes(1);
    }
    // The autonomy allowlist is never consulted and no pending is registered —
    // these tools are organizational, so an unattended supervisor chat can use
    // them without a grant (unlike send_chat_message & friends).
    expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('a real USER turn also calls them directly (no confirmation either way)', async () => {
    goalsSvc.createGoal.mockResolvedValue(GOAL);
    const out = await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'goal_create', { projectId: 'p1', title: 'T' });
    expect(out).not.toMatch(/needsConfirmation/);
    expect(goalsSvc.createGoal).toHaveBeenCalledTimes(1);
    expect(await pendingConfirmationCount()).toBe(0);
  });
});

describe('update_supervisor_state dispatch (2026-08-22 durable-state rebuild)', () => {
  it('registers as a mutating platform tool with an all-optional schema', () => {
    expect(PLATFORM_MUTATING_TOOLS).toContain('update_supervisor_state');
    expect(PLATFORM_READ_TOOLS).not.toContain('update_supervisor_state');
    expect(CHAT_PROFILE_PLATFORM_TOOLS).toContain('update_supervisor_state');
    const entry = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'update_supervisor_state');
    expect(entry).toBeDefined();
    expect((entry!.function.parameters as any).required).toBeUndefined();
    expect(entry!.function.description).toMatch(/Fleet Supervisor only/);
  });

  it('a NON-supervisor chat gets the refusal object (never reaches the service merge)', async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(false);
    const out = await executePlatformTool(makeCtx(), 'update_supervisor_state', { notes: 'x' });
    // the refusal names the MODEL-FACING spelling (coding/tool-scope.ts, 2026-09-22)
    // and is the platform ok:false envelope (D5, 2026-09-27 — failure-shaped to
    // the derail streak; the legacy `error` key survives for old readers).
    expect(JSON.parse(out)).toEqual({
      ok: false, tool: 'save_supervisor_state', reason: 'supervisor_only',
      error: 'save_supervisor_state is only available on the Fleet Supervisor chat',
      message: 'save_supervisor_state is only available on the Fleet Supervisor chat',
    });
    expect(out).toMatch(/^\{\s*"ok":\s*false/);
    expect(supStateSvc.applyStateUpdate).not.toHaveBeenCalled();
  });

  it('a state-row read FAILURE answers state_read_failed — never the supervisor_only refusal the D5 ladder counts (review fixer 2026-09-27)', async () => {
    supStateSvc.supervisorChatFlag.mockResolvedValueOnce(null);
    const out = await executePlatformTool(makeCtx(), 'update_supervisor_state', { notes: 'x' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, tool: 'save_supervisor_state', reason: 'state_read_failed', transient: true });
    expect(out).toMatch(/^\{\s*"ok":\s*false/); // still failure-shaped to the streak
    expect(parsed.message).not.toMatch(/only available/);
    expect(supStateSvc.applyStateUpdate).not.toHaveBeenCalled();
    for (const tool of ['get_supervisor_state', 'register_infra_blocker', 'clear_infra_blocker'] as const) {
      supStateSvc.supervisorChatFlag.mockResolvedValueOnce(null);
      expect(JSON.parse(await executePlatformTool(makeCtx(), tool, { id: 'b1', label: 'x' }))).toMatchObject({ ok: false, tool, reason: 'state_read_failed' });
    }
  });

  it('the supervisor chat merges directly in a MACHINE run (not consequential: no grant, no confirmation)', async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    supStateSvc.applyStateUpdate.mockResolvedValue({ applied: ['notes replaced'], errors: [] });
    const ctx = makeCtx(); // NO userTurnAt — schedule firing / hook wake
    const out = await executePlatformTool(ctx, 'update_supervisor_state', { notes: 'sweep done' });
    expect(out).not.toMatch(/needsConfirmation/);
    // ctx.sessionId IS the owning chat id (same convention as file_feedback).
    expect(supStateSvc.applyStateUpdate).toHaveBeenCalledWith('sess-1', 'u1', { notes: 'sweep done' });
    expect(JSON.parse(out)).toEqual({ applied: ['notes replaced'], errors: [] });
    expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
    expect(await pendingConfirmationCount()).toBe(0);
  });

  // Ticket 69e07047 (2026-09-07): the supervisor reported merge failures as
  // "ok:false, error 'goalId must be a non-empty string'". The executor has exactly
  // two receipt shapes — the non-supervisor refusal { error } and the merge result
  // { applied, errors } — and failure modes ride the SECOND, never { ok:false, error }.
  it('a merge WITH errors still returns the { applied, errors } receipt — never { ok:false, error } (ticket 69e07047)', async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    supStateSvc.applyStateUpdate.mockResolvedValue({
      applied: [],
      errors: ["directive d1: 'done' requires evidence — the close was NOT applied."],
    });
    const out = await executePlatformTool(makeCtx(), 'update_supervisor_state', { directives: [{ id: 'd1', status: 'done' }] });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      applied: [],
      errors: ["directive d1: 'done' requires evidence — the close was NOT applied."],
    });
    expect(parsed).not.toHaveProperty('ok');
    expect(parsed).not.toHaveProperty('error');
    expect(out).not.toMatch(/goalId/);
    expect(out).not.toMatch(/must be a non-empty string/);
  });
});

describe('dispatch_platform_task (Option D — platform-engineering lane)', () => {
  beforeEach(() => {
    laneSvc.dispatchTaskToLane.mockReset().mockResolvedValue({ sent: true });
    fb.isAdminUser.mockReset().mockResolvedValue(false);
    fb.fileFeedbackTicket.mockReset().mockResolvedValue({
      deduped: false,
      ticket: { id: 'fb-1', type: 'enhancement', title: 't', priority: 0 },
    });
  });

  it('registers as a mutating platform tool every chat sees (admin gate lives at execution)', () => {
    expect(PLATFORM_MUTATING_TOOLS).toContain('dispatch_platform_task');
    expect(PLATFORM_READ_TOOLS).not.toContain('dispatch_platform_task');
    expect(CHAT_PROFILE_PLATFORM_TOOLS).toContain('dispatch_platform_task');
    const entry = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'dispatch_platform_task');
    expect(entry).toBeDefined();
    expect((entry!.function.parameters as any).required).toEqual(['title', 'description']);
    expect(entry!.function.description).toMatch(/Admin-only/);
    expect(entry!.function.description).toMatch(/feedback ticket instead/);
  });

  it('an ADMIN with an autonomy grant dispatches in a MACHINE run (consequential: grant bypasses the confirmation)', async () => {
    fb.isAdminUser.mockResolvedValue(true);
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
    const ctx = makeCtx(); // NO userTurnAt — machine-triggered run
    const out = await executePlatformTool(ctx, 'dispatch_platform_task', { title: 'Fix STT', description: 'Self-host whisper', priority: 2 });
    expect(out).not.toMatch(/needsConfirmation/);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, tool: 'dispatch_platform_task', ids: { title: 'Fix STT' } });
    expect(parsed.message).toContain('Dispatched to the platform-engineering lane');
    expect(laneSvc.dispatchTaskToLane).toHaveBeenCalledWith({
      sourceLabel: 'dispatch_platform_task',
      title: 'Fix STT',
      body: 'Self-host whisper\npriority: 2',
    });
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('an ADMIN whose lane is unconfigured DEGRADES to filing a feedback ticket (reason carried in the note)', async () => {
    fb.isAdminUser.mockResolvedValue(true);
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
    laneSvc.dispatchTaskToLane.mockResolvedValue({ sent: false, reason: 'no_lane' });
    const out = await executePlatformTool(makeCtx(), 'dispatch_platform_task', { title: 'Fix STT', description: 'Self-host whisper' });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.ids.filedTicketId).toBe('fb-1');
    expect(parsed.message).toContain('Not an admin / lane unavailable — filed as feedback ticket instead');
    expect(parsed.message).toContain('no_lane');
    // The degrade files the SAME shape the file_feedback case files (source 'agent').
    expect(fb.fileFeedbackTicket).toHaveBeenCalledTimes(1);
    const filed = fb.fileFeedbackTicket.mock.calls[0][0];
    expect(filed).toMatchObject({ type: 'enhancement', title: 'Fix STT', description: 'Self-host whisper', userId: 'u1' });
    expect(filed.context).toMatchObject({ sessionId: 'sess-1', surface: 'coding', codingSessionId: 'sess-1' });
  });

  it('FRESH TICKET LANES (2026-10-06): reason ticket_lane files the task as a ticket ON PURPOSE and says it gets its own lane', async () => {
    fb.isAdminUser.mockResolvedValue(true);
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
    laneSvc.dispatchTaskToLane.mockResolvedValue({ sent: false, reason: 'ticket_lane' });
    const out = await executePlatformTool(makeCtx(), 'dispatch_platform_task', { title: 'Fix red CI', description: 'deploy run failed' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, tool: 'dispatch_platform_task', ids: { filedTicketId: 'fb-1' } });
    expect(parsed.message).toBe("Filed as feedback ticket fb-1: platform tasks run in DEDICATED ticket lanes — one fresh coding session per ticket, at most 3 at once — and the ticket's adminNote names its lane once it starts (read it with get_feedback). Do not follow up on it in this run.");
    expect(parsed.message).not.toMatch(/lane unavailable/);
    expect(fb.fileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('a NON-admin never reaches the lane — the call degrades straight to a feedback ticket', async () => {
    fb.isAdminUser.mockResolvedValue(false);
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
    const out = await executePlatformTool(makeCtx(), 'dispatch_platform_task', { title: 'Please add themes', description: 'Dark mode please' });
    expect(JSON.parse(out)).toEqual({
      ok: true,
      tool: 'dispatch_platform_task',
      ids: { filedTicketId: 'fb-1' },
      message: 'Not an admin / lane unavailable — filed as feedback ticket instead: ticket fb-1 is in the triage queue. Do not follow up on it in this run.',
    });
    expect(laneSvc.dispatchTaskToLane).not.toHaveBeenCalled();
    expect(fb.fileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('a NON-admin in a PROJECT-SCOPED run is REFUSED instead of degrading (subject guard — user-project work never launders into the triage queue)', async () => {
    fb.isAdminUser.mockResolvedValue(false);
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
    const ctx = makeCtx({ agentSurface: 'coding', projectId: 'proj-1' } as any);
    const out = await executePlatformTool(ctx, 'dispatch_platform_task', { title: 'Fix upload in my app', description: 'Uploads 500 in the app under development' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, tool: 'dispatch_platform_task' });
    expect(parsed.message).toMatch(/NOT dispatched or filed/);
    expect(parsed.message).toMatch(/file_feedback/); // points at the classified escape hatch
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
    expect(laneSvc.dispatchTaskToLane).not.toHaveBeenCalled();
  });

  it("the chat sentinel projectId 'chat' does NOT count as project scope — a plain-chat non-admin still degrades to a ticket", async () => {
    fb.isAdminUser.mockResolvedValue(false);
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
    const ctx = makeCtx({ agentSurface: 'chat', projectId: 'chat' } as any);
    const out = await executePlatformTool(ctx, 'dispatch_platform_task', { title: 'Please add themes', description: 'Dark mode please' });
    expect(JSON.parse(out).ids.filedTicketId).toBe('fb-1');
    expect(fb.fileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('an ADMIN in a project-scoped run KEEPS the degrade when the lane is unavailable (deliberate confirmed dispatch is never lost)', async () => {
    fb.isAdminUser.mockResolvedValue(true);
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
    laneSvc.dispatchTaskToLane.mockResolvedValue({ sent: false, reason: 'capped' });
    const ctx = makeCtx({ agentSurface: 'coding', projectId: 'proj-1' } as any);
    const out = await executePlatformTool(ctx, 'dispatch_platform_task', { title: 'Fix STT', description: 'Self-host whisper' });
    expect(JSON.parse(out).ids.filedTicketId).toBe('fb-1');
    expect(fb.fileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('a MACHINE run WITHOUT a grant stages a confirmation instead of executing (consequential gate)', async () => {
    fb.isAdminUser.mockResolvedValue(true);
    const out = await executePlatformTool(makeCtx(), 'dispatch_platform_task', { title: 'T', description: 'D' });
    const reg = JSON.parse(out);
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect(reg.summary).toContain('platform-engineering lane');
    expect(laneSvc.dispatchTaskToLane).not.toHaveBeenCalled();
    expect(fb.isAdminUser).not.toHaveBeenCalled(); // the gate fires before any execution logic
  });

  it('requires title and description (no lane call, no ticket)', async () => {
    fb.isAdminUser.mockResolvedValue(true);
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
    const out = await executePlatformTool(makeCtx(), 'dispatch_platform_task', { title: '  ', description: '' });
    expect(out).toMatch(/requires title and description/);
    expect(laneSvc.dispatchTaskToLane).not.toHaveBeenCalled();
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
  });
});

// audit 2026-10-06 T5-3 / T5-5: goal_list / todo_list wiring of the project-id
// heal note and the compact account-wide rows. The service pieces are pinned in
// goals.service.test.ts; here the tool seam (the mocked module gains the new
// exports per test — an older mock without them keeps the legacy shape).
describe('audit 2026-10-06 T5-3 / T5-5 — goal_list / todo_list tool seam', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod: any = require('./goals.service');
  const INVENTED = 'f4f34898-c614-41c7-bf3d-a12b53ad7236';
  const REAL = 'f4f34898-afb7-47ae-9f9b-4c68757d09be';
  afterEach(() => {
    for (const k of ['resolveProjectIdForTool', 'projectIdHealDisabled', 'goalListCompactDisabled', 'compactAccountWideGoals', 'GOAL_LIST_COMPACT_HINT']) delete mod[k];
  });

  it('a healed project id is listed AND reported (projectIdCorrected) on both lists; the RESOLVED id reaches the service', async () => {
    mod.projectIdHealDisabled = () => false;
    mod.resolveProjectIdForTool = jest.fn(async () => ({ id: REAL, correctedFrom: INVENTED, tier: 'suffix' }));
    goalsSvc.listGoals.mockResolvedValue([GOAL]);
    const g = JSON.parse(await executePlatformTool(makeCtx(), 'goal_list', { projectId: INVENTED }));
    expect(goalsSvc.listGoals).toHaveBeenCalledWith({ userId: 'u1', projectId: REAL });
    expect(g.projectIdCorrected).toMatchObject({ from: INVENTED, to: REAL });
    expect(g.projectIdCorrected.note).toContain('[PROJECT ID CORRECTED]');
    goalsSvc.listTodos.mockResolvedValue([TODO]);
    const t = JSON.parse(await executePlatformTool(makeCtx(), 'todo_list', { projectId: INVENTED }));
    expect(goalsSvc.listTodos).toHaveBeenCalledWith({ userId: 'u1', projectId: REAL });
    expect(t.projectIdCorrected).toMatchObject({ from: INVENTED, to: REAL });
    goalsSvc.listTodos.mockResolvedValue([]);
    expect(await executePlatformTool(makeCtx(), 'todo_list', { projectId: INVENTED })).toMatch(/^\[PROJECT ID CORRECTED\].*No todos found for that filter\.$/);
  });

  it('no correction (a real id / plain prefix) and the kill switch leave the payload byte-identical', async () => {
    mod.projectIdHealDisabled = () => false;
    mod.resolveProjectIdForTool = jest.fn(async (id: string) => ({ id }));
    goalsSvc.listGoals.mockResolvedValue([GOAL]);
    expect(JSON.parse(await executePlatformTool(makeCtx(), 'goal_list', { projectId: 'p1' })).projectIdCorrected).toBeUndefined();
    mod.projectIdHealDisabled = () => true;
    mod.resolveProjectIdForTool = jest.fn(async () => ({ id: REAL, correctedFrom: INVENTED }));
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'goal_list', { projectId: INVENTED }));
    expect(goalsSvc.listGoals).toHaveBeenLastCalledWith({ userId: 'u1', projectId: INVENTED });
    expect(out.projectIdCorrected).toBeUndefined();
    expect(mod.resolveProjectIdForTool).not.toHaveBeenCalled();
  });

  it('ACCOUNT-WIDE goal_list renders the compact rows + hint; scoped stays full; GOAL_LIST_COMPACT_DISABLED restores full rows', async () => {
    mod.goalListCompactDisabled = () => false;
    mod.compactAccountWideGoals = jest.fn(() => ({ goals: [{ id: 'g1', compact: 'row' }], total: 3, truncated: true }));
    mod.GOAL_LIST_COMPACT_HINT = 'narrow by projectId';
    goalsSvc.listGoals.mockResolvedValue([GOAL, GOAL, GOAL]);
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'goal_list', {}));
    expect(out).toEqual({ goals: [{ id: 'g1', compact: 'row' }], count: 1, compact: true, truncated: true, total: 3, hint: 'narrow by projectId' });
    expect(mod.compactAccountWideGoals).toHaveBeenCalledWith([GOAL, GOAL, GOAL], { maxRows: 100 });
    const scoped = JSON.parse(await executePlatformTool(makeCtx(), 'goal_list', { projectId: 'p1' }));
    expect(scoped.compact).toBeUndefined();
    expect(scoped.goals).toEqual([GOAL, GOAL, GOAL]);
    mod.goalListCompactDisabled = () => true;
    const legacy = JSON.parse(await executePlatformTool(makeCtx(), 'goal_list', {}));
    expect(legacy.compact).toBeUndefined();
    expect(legacy.goals).toEqual([GOAL, GOAL, GOAL]);
  });
});

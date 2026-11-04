/**
 * Fleet supervisor — CAPSTONE end-to-end acceptance scenario.
 *
 * One continuous narrative wiring the REAL services together (autonomy.service,
 * goals.service, hooks.service, the platform-tools consequential gate +
 * dispatch, pending-confirmations) against in-memory fakes at the true
 * infrastructure boundaries ONLY: config/database (stateful prisma fake),
 * config/redis (map), crossmodel.service.getChatAccess (owner), the hook
 * delivery edge (schedule.service.fireScheduleTarget), and platform.service
 * (sendChatMessage capture). Each unit slice is covered in its own test file;
 * this file proves the LOOP:
 *
 *   1. grant autonomy (full user-turn confirmation flow)
 *   2. machine-run supervisor plans a project (goal → todos → dep-block) + subscribes hooks
 *   3. worker run completes → hook event → sweep wakes the supervisor
 *   4. woken supervisor AUTONOMOUSLY nudges another chat (gate passes via
 *      grant; denied after revoke; other chats never inherit the grant)
 *   5. progress propagation (todo done → dependent unblocks → goal auto-done, todo_done events)
 *   6. per-chat schedule cap from the grant
 *   7. loop safety (self-hook suppression, depth cap)
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
// agent-auth pulls config/database + utils/jwt → config/env (process.exit at import).
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
// error-handler imports config/env — mirror AppError's shape.
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// ── Stateful in-memory prisma fake ────────────────────────────────────────────
// Only the shapes the fleet services actually use: scalar equality, {in},
// {has}, {lt}, one-level nested relation filters ({goal:{userId}} / {todo:{userId}}),
// select, orderBy createdAt, take, and $transaction(callback|array).
function matchWhere(row: any, where: any, resolve: Record<string, (r: any) => any>): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (k === 'OR' && Array.isArray(v)) return v.some((sub) => matchWhere(row, sub, resolve));
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const cond: any = v;
      if ('in' in cond) return cond.in.includes(row[k]);
      if ('has' in cond) return Array.isArray(row[k]) && row[k].includes(cond.has);
      if ('lt' in cond) return new Date(row[k]).getTime() < new Date(cond.lt).getTime();
      if ('lte' in cond) return row[k] != null && new Date(row[k]).getTime() <= new Date(cond.lte).getTime();
      if ('gt' in cond) return new Date(row[k]).getTime() > new Date(cond.gt).getTime();
      if ('gte' in cond) return row[k] != null && new Date(row[k]).getTime() >= new Date(cond.gte).getTime();
      if (resolve[k]) { const rel = resolve[k](row); return !!rel && matchWhere(rel, cond, {}); }
      return false;
    }
    // null matches both null and never-set (undefined) — prisma semantics.
    return v === null ? row[k] == null : row[k] === v;
  });
}
function pick(row: any, select: any) {
  const out: any = {};
  for (const k of Object.keys(select ?? {})) if (select[k]) out[k] = row[k];
  return out;
}
function makeTable(name: string, defaults: any = {}, resolve: Record<string, (r: any) => any> = {}) {
  const rows: any[] = [];
  let ctr = 0;
  const api: any = {
    rows,
    findUnique: jest.fn(async ({ where, select }: any) => {
      const r = rows.find((row) => matchWhere(row, where, resolve)) ?? null;
      return r && select ? pick(r, select) : r;
    }),
    findFirst: jest.fn(async ({ where, select }: any = {}) => {
      const r = rows.find((row) => matchWhere(row, where, resolve)) ?? null;
      return r && select ? pick(r, select) : r;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: any = {}) => {
      let out = rows.filter((row) => matchWhere(row, where, resolve));
      if (orderBy?.createdAt) out = [...out].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
      if (take) out = out.slice(0, take);
      return out;
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = { ...defaults, ...data, id: data.id ?? `${name}-${++ctr}`, createdAt: data.createdAt ?? new Date(), updatedAt: new Date() };
      rows.push(row);
      return row;
    }),
    createMany: jest.fn(async ({ data }: any) => {
      for (const d of data) rows.push({ ...d });
      return { count: data.length };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = rows.find((row) => matchWhere(row, where, resolve));
      if (!r) throw new Error(`${name} row not found for update`);
      Object.assign(r, data, { updatedAt: new Date() });
      return r;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const m = rows.filter((row) => matchWhere(row, where, resolve));
      m.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
      return { count: m.length };
    }),
    delete: jest.fn(async ({ where }: any) => {
      const i = rows.findIndex((row) => matchWhere(row, where, resolve));
      if (i < 0) throw new Error(`${name} row not found for delete`);
      return rows.splice(i, 1)[0];
    }),
    deleteMany: jest.fn(async ({ where }: any = {}) => {
      const m = rows.filter((row) => matchWhere(row, where, resolve));
      m.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { count: m.length };
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const r = rows.find((row) => matchWhere(row, where, resolve));
      if (r) { Object.assign(r, update, { updatedAt: new Date() }); return r; }
      const row = { ...defaults, ...create, id: create.id ?? `${name}-${++ctr}`, createdAt: new Date(), updatedAt: new Date() };
      rows.push(row);
      return row;
    }),
  };
  return api;
}

const tables: Record<string, any> = {};
const goalTbl = () => tables.projectGoal;
const todoTbl = () => tables.projectTodo;
tables.chatAutonomy = makeTable('ca', { scheduleCap: 48 });
tables.eventHook = makeTable('hook', { enabled: true, debounceSec: 60, promptTemplate: '', lastFiredAt: null });
tables.hookEvent = makeTable('he', { status: 'pending', attempts: 0, retryAt: null }, {
  hook: (r: any) => (tables.eventHook as any).rows.find((h: any) => h.id === r.hookId),
});
tables.projectGoal = makeTable('goal', { status: 'active', description: '' });
tables.projectTodo = makeTable('todo', { status: 'pending' });
tables.goalDependency = makeTable('gd', {}, { goal: (r) => goalTbl().rows.find((g: any) => g.id === r.goalId) });
tables.todoDependency = makeTable('td', {}, { todo: (r) => todoTbl().rows.find((t: any) => t.id === r.todoId) });
tables.crossModelChat = makeTable('chat');
tables.crossModelProject = makeTable('proj');
tables.projectMember = makeTable('pm');
tables.activity = makeTable('act');
// DB-persisted confirmation registry (pending-confirmations.ts) — the full
// user-turn confirmation flow below stages/consumes real rows against this table.
tables.pendingConfirmation = makeTable('cf', { status: 'pending', result: null, resolvedAt: null });

const mockPrisma: any = new Proxy(tables, {
  get(target, prop: string) {
    if (prop === '$transaction') {
      return async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg));
    }
    // hooks.service's atomic claim (UPDATE hook_events … RETURNING): flip the
    // pending rows and hand them back, exactly like Postgres. The fake can't
    // parse the SQL template, so it claims every pending row — these scenarios
    // only ever sweep one pending group at a time.
    if (prop === '$queryRaw') {
      return async (...args: any[]) => {
        // Scope the claim to the ids interpolated into the template (P3: two
        // groups can be pending in one sweep — a fleet-wide flip would hand
        // group A the rows of group B). Prisma.join(ids) arrives as a Sql
        // value whose .values are the ids; bare strings ride along too.
        const idSet = new Set<string>();
        const collect = (v: any): void => {
          if (typeof v === 'string') idSet.add(v);
          else if (Array.isArray(v)) v.forEach(collect);
          else if (v && typeof v === 'object' && 'values' in v) collect((v as any).values);
        };
        args.slice(1).forEach(collect);
        const pending = tables.hookEvent.rows.filter(
          (r: any) => r.status === 'pending' && (idSet.size === 0 || idSet.has(r.id)),
        );
        pending.forEach((r: any) => { r.status = 'delivering'; r.updatedAt = new Date(); });
        return pending;
      };
    }
    return target[prop];
  },
});
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// ── In-memory Redis ───────────────────────────────────────────────────────────
const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  },
}));

// ── True edges ────────────────────────────────────────────────────────────────
const mockGetChatAccess = jest.fn();
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

const svc = {
  listChats: jest.fn(), createChat: jest.fn(), getChatStatus: jest.fn(), getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(async () => ({ ok: true })), renameChat: jest.fn(), archiveChat: jest.fn(),
  moveChat: jest.fn(), deleteChat: jest.fn(), createProject: jest.fn(), getProject: jest.fn(),
  updateProject: jest.fn(), deleteProject: jest.fn(), moveFolder: jest.fn(), startCodingSession: jest.fn(),
  scheduleChatRun: jest.fn(), listSchedules: jest.fn(), cancelSchedule: jest.fn(),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(), listFeedbackTickets: jest.fn(), updateFeedbackTicket: jest.fn(), isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// The hook delivery edge — the machine-run fire path. Deliveries also consume
// the shared daily machine-run budget (default: under the cap).
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
  notifyDailyCapOnce: jest.fn(async () => {}),
}));

// REAL modules under test:
import { executePlatformTool } from './platform-tools';
import { getChatAutonomy } from './autonomy.service';
import { emitHookEvent, sweepHookEvents } from './hooks.service';
import type { ToolContext } from '../coding/tools';

// ── Fixture helpers ───────────────────────────────────────────────────────────
const U = 'u1';
const SUP = 'sup-1'; // supervisor chat (plain)
const W1 = 'w-1';    // worker chat in project P1
const W2 = 'w-2';    // worker chat in project P2
const P1 = 'p1';
const P2 = 'p2';

function makeCtx(overrides: any = {}) {
  return {
    worktree: '/wt', sessionId: SUP, userId: U, permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}
const J = (s: string) => JSON.parse(s);

/** Full consequential grant flow: register pending in one user turn, confirm from a NEW user turn. */
async function grantAutonomy(allowedTools: string[], scheduleCap?: number) {
  const args: any = { chatId: SUP, allowedTools, ...(scheduleCap != null ? { scheduleCap } : {}) };
  const r1 = await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'set_chat_autonomy', args);
  const need = J(r1);
  expect(need.needsConfirmation).toBe(true);
  const r2 = await executePlatformTool(
    makeCtx({ userTurnAt: new Date(Date.now() + 5_000) }),
    'set_chat_autonomy',
    { ...args, confirmationId: need.confirmationId },
  );
  return r2;
}

beforeAll(() => {
  // Fleet: supervisor S (plain), workers W1 (in P1) + W2 (in P2) — all owned by U.
  tables.crossModelChat.rows.push(
    { id: SUP, userId: U, title: 'Fleet Supervisor', projectId: null },
    { id: W1, userId: U, title: 'Worker One', projectId: P1 },
    { id: W2, userId: U, title: 'Worker Two', projectId: P2 },
  );
  tables.crossModelProject.rows.push(
    { id: P1, userId: U, name: 'Project One', path: `/${P1}`, parentId: null, depth: 0 },
    { id: P2, userId: U, name: 'Project Two', path: `/${P2}`, parentId: null, depth: 0 },
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockFireScheduleTarget.mockResolvedValue({ started: true });
});

describe('fleet-supervisor acceptance scenario', () => {
  let goalId: string;
  let todoA: string;
  let todoB: string;
  let runHookId: string;

  it('stage 1 — autonomy grant requires the full user-turn confirmation flow, then persists', async () => {
    // A MACHINE-triggered run can register a pending but never confirm it.
    const machineTry = await executePlatformTool(makeCtx(), 'set_chat_autonomy', { chatId: SUP, allowedTools: ['send_chat_message'] });
    expect(J(machineTry).needsConfirmation).toBe(true);
    const machineConfirm = await executePlatformTool(makeCtx(), 'set_chat_autonomy', {
      chatId: SUP, allowedTools: ['send_chat_message'], confirmationId: J(machineTry).confirmationId,
    });
    expect(machineConfirm).toContain('not started by a real user message');
    expect(tables.chatAutonomy.rows).toHaveLength(0); // nothing granted

    const r2 = await grantAutonomy(['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'], 120);
    expect(String(r2)).toContain('Autonomy granted');
    const grant = tables.chatAutonomy.rows.find((r: any) => r.chatId === SUP);
    expect(grant.allowedTools).toHaveLength(4);
    expect(grant.scheduleCap).toBe(120);
    expect(tables.activity.rows.some((a: any) => String(a.type ?? a.action ?? '').includes('autonomy'))).toBe(true);
  });

  it('stage 2 — machine-run supervisor plans a project: goal, dependent todos (dep-blocked), hooks', async () => {
    const machine = makeCtx(); // no userTurnAt — scheduled supervisor run
    const gOut = String(await executePlatformTool(machine, 'goal_create', { projectId: P1, title: 'Ship v2', description: 'Get v2 out' }));
    goalId = /Created goal ([\w-]+)/.exec(gOut)![1];
    expect(tables.projectGoal.rows.find((r: any) => r.id === goalId)).toMatchObject({ status: 'active', createdByChatId: SUP });

    const aOut = String(await executePlatformTool(machine, 'todo_create', { goalId, title: 'Build the thing', assigneeChatId: W1 }));
    todoA = /Created todo ([\w-]+)/.exec(aOut)![1];
    expect(tables.projectTodo.rows.find((r: any) => r.id === todoA)).toMatchObject({ status: 'pending', assigneeChatId: W1 });

    const bOut = String(await executePlatformTool(machine, 'todo_create', { goalId, title: 'Polish the thing', dependsOnTodoIds: [todoA] }));
    todoB = /Created todo ([\w-]+)/.exec(bOut)![1];
    expect(bOut).toContain('STARTS BLOCKED');
    const bRow = tables.projectTodo.rows.find((r: any) => r.id === todoB);
    expect(bRow.status).toBe('blocked');
    expect(String(bRow.blockedReason)).toContain('[deps]');

    // CROSS-PROJECT dependency: a goal in P2 depending on the P1 goal.
    const g2Out = String(await executePlatformTool(machine, 'goal_create', { projectId: P2, title: 'Announce v2', dependsOnGoalIds: [goalId] }));
    const g2Id = /Created goal ([\w-]+)/.exec(g2Out)![1];
    const g2Row = tables.projectGoal.rows.find((r: any) => r.id === g2Id);
    expect(g2Row).toMatchObject({ status: 'blocked', projectId: P2 });
    expect(String(g2Row.blockedReason)).toContain('[deps]');

    const h1Out = String(await executePlatformTool(machine, 'hook_subscribe', { sourceChatId: W1, targetChatId: SUP, eventTypes: ['run_completed'], promptTemplate: 'e2e wake {{sourceChatTitle}}: {{summary}}' }));
    expect(h1Out).toContain('Subscribed');
    const h1Id = /hook ([\w-]+)/.exec(h1Out)![1];
    // Pair dedup (ticket c65de47c): re-subscribing the SAME (source,target)
    // pair via the public tool path never creates a second row — the existing
    // hook is updated IN PLACE with the latest eventTypes (the response says
    // ALREADY WIRED and returns the SAME hook id). Before c65de47c this
    // double-wire made TWO pair rows and every event woke SUP twice. Both
    // event types now ride the ONE pair hook.
    const h2Out = String(await executePlatformTool(machine, 'hook_subscribe', { sourceChatId: W1, targetChatId: SUP, eventTypes: ['todo_done', 'run_completed'], promptTemplate: 'e2e wake {{sourceChatTitle}}: {{summary}}' }));
    expect(h2Out).toContain('ALREADY WIRED');
    expect(h2Out).toContain(`hook ${h1Id}`);
    // 2 hooks: the ONE deduped pair hook above PLUS the v1#7 direct-wake SYSTEM
    // self-hook that todo_create's assignee wake enqueued durably (todo_wake).
    expect(tables.eventHook.rows).toHaveLength(2);
    const directWakeHook = tables.eventHook.rows.find((h: any) => h.eventTypes.includes('todo_wake'));
    expect(directWakeHook).toMatchObject({ sourceChatId: W1, targetChatId: W1, promptTemplate: '{{summary}}', debounceSec: 0, enabled: true });
    runHookId = tables.eventHook.rows.find((h: any) => h.eventTypes.includes('run_completed')).id;
    expect(runHookId).toBe(h1Id); // the dedup kept the FIRST row's id
    expect(tables.eventHook.rows.find((h: any) => h.id === runHookId)).toMatchObject({ sourceChatId: W1, targetChatId: SUP, enabled: true, debounceSec: 60, eventTypes: ['todo_done', 'run_completed'] });
  });

  it('stage 3 — worker run completion emits a hook event; the sweep wakes the supervisor (and drains the durable todo wake — v1#7)', async () => {
    // Simulate the worker run-executor finalize emission.
    await emitHookEvent(W1, 'run_completed', 'Run completed: 3 files changed, tests green', { runId: 'run-1' });
    const pending = tables.hookEvent.rows.filter((r: any) => r.status === 'pending');
    expect(pending).toHaveLength(2); // stage 2's durable todo_wake + this run_completed
    const runEvt = pending.find((r: any) => r.eventType === 'run_completed');
    expect(runEvt.payload).toMatchObject({ eventType: 'run_completed', sourceChatId: W1, sourceChatTitle: 'Worker One', depth: 0, runId: 'run-1' });
    const todoWakeEvt = pending.find((r: any) => r.eventType === 'todo_wake');
    expect(todoWakeEvt.payload.summary).toContain('Build the thing');

    await sweepHookEvents();
    // Two deliveries: the alarm-class todo_wake to the assignee (W1) first,
    // then the run_completed to the supervisor.
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(2);
    const deliveries = mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0]);
    const supDelivery = deliveries.find((d: any) => d.sessionId === SUP);
    expect(supDelivery.prompt).toContain('Worker One');
    expect(supDelivery.prompt).toContain('3 files changed');
    const w1Delivery = deliveries.find((d: any) => d.sessionId === W1);
    expect(w1Delivery.prompt).toContain('Build the thing'); // the durable todo wake landed verbatim
    expect(tables.hookEvent.rows.every((r: any) => r.status === 'delivered')).toBe(true);
    expect(tables.eventHook.rows.find((h: any) => h.id === runHookId).lastFiredAt).toBeTruthy();
    // Depth stamp for the woken run: its own emissions will carry depth 1.
    expect(redisStore.get(`fleet:hookdepth:${SUP}`)).toBe('1');
  });

  it('stage 4 — the woken supervisor autonomously nudges another chat; revoke and foreign-chat negatives hold', async () => {
    const machine = makeCtx(); // woken run — machine-triggered, no userTurnAt
    const out = await executePlatformTool(machine, 'send_chat_message', { chatId: W2, content: 'Status on your goal?' });
    expect(String(out)).not.toContain('needsConfirmation');
    expect(svc.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: U, chatId: W2, content: 'Status on your goal?' }));

    // Negative A: revoke → the same autonomous call falls back to needsConfirmation.
    // (9341e862: the SELF-revoke itself is authority-non-widening — an empty
    // array is always ⊆ the current grant — so it AUTO-EXECUTES card-free now;
    // the staging flow below is only exercised by WIDENING requests.)
    svc.sendChatMessage.mockClear();
    const revokeOut = await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'set_chat_autonomy', { chatId: SUP, allowedTools: [] });
    expect(String(revokeOut)).toContain('Autonomy revoked for chat');
    expect(String(revokeOut)).not.toContain('needsConfirmation');
    expect(tables.chatAutonomy.rows.find((r: any) => r.chatId === SUP)).toBeUndefined();
    const denied = await executePlatformTool(machine, 'send_chat_message', { chatId: W2, content: 'Status?' });
    expect(J(denied).needsConfirmation).toBe(true);
    expect(svc.sendChatMessage).not.toHaveBeenCalled();

    // Negative B: re-grant to SUP — a DIFFERENT chat (W2) still cannot autonomously send (grant is per-chat).
    await grantAutonomy(['send_chat_message'], 120);
    const foreign = await executePlatformTool(makeCtx({ sessionId: W2 }), 'send_chat_message', { chatId: SUP, content: 'hi' });
    expect(J(foreign).needsConfirmation).toBe(true);
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
  });

  it('stage 5 — todo completion propagates: dependent unblocks, goal auto-completes, todo_done hook fires only with assignee', async () => {
    const machine = makeCtx();
    // Hardening 2026-09-14 (actor-echo suppression): a close performed BY the
    // hook's target would no longer wake that target — the supervisor already
    // knows what it closed (the spark "self-audit" churn). Stage 5 pins the
    // assignee-only semantics, so the WORKER lane W2 (not SUP, the todo_done
    // hook's target) performs the close here; the actor-echo skip itself is
    // pinned in hooks.service.test.ts / goals.service.test.ts.
    const closer = makeCtx({ sessionId: W2 });
    // P4 v1#10: a MACHINE close must cite evidence (the run's tool-result artifact).
    await executePlatformTool(closer, 'todo_update', { todoId: todoA, status: 'done', evidence: 'verify PASSED — receipt 12345678 cited' });

    // Dependent todo B auto-unblocked by propagation.
    const b = tables.projectTodo.rows.find((t: any) => t.id === todoB);
    expect(b.status).toBe('pending');
    expect(b.blockedReason).toBeNull();

    // todo_done emitted (A has assigneeChatId) → one pending hook event for the todo_done hook.
    const todoDoneEvents = tables.hookEvent.rows.filter((r: any) => r.eventType === 'todo_done');
    expect(todoDoneEvents).toHaveLength(1);
    expect(todoDoneEvents[0].payload.summary).toContain('Build the thing');

    // Complete B (no assignee) → goal auto-done; NO second todo_done event.
    await executePlatformTool(machine, 'todo_update', { todoId: todoB, status: 'done', evidence: 'run_command exit 0 — receipt 9abc1234 cited' });
    expect(tables.hookEvent.rows.filter((r: any) => r.eventType === 'todo_done')).toHaveLength(1);
    expect(tables.projectGoal.rows.find((g: any) => g.id === goalId).status).toBe('done');

    // And the cross-PROJECT dependent goal ("Announce v2" in P2) auto-unblocked.
    const g2 = tables.projectGoal.rows.find((g: any) => g.title === 'Announce v2');
    expect(g2.status).toBe('active');
    expect(g2.blockedReason).toBeNull();
  });

  it('stage 6 — the per-chat schedule cap comes from the grant (120), others default (48→null grant)', async () => {
    await expect(getChatAutonomy(SUP)).resolves.toMatchObject({ scheduleCap: 120 });
    await expect(getChatAutonomy(W2)).resolves.toBeNull(); // schedule.service falls back to 48
  });

  it('stage 7 — loop safety: self-hooks suppressed at emission; depth >= 3 drops before insert', async () => {
    // Self-targeting hook row (subscribe validation aside, emission is the guaranteed choke point).
    tables.eventHook.rows.push({
      id: 'self-1', userId: U, sourceChatId: SUP, targetChatId: SUP, eventTypes: ['run_completed'],
      promptTemplate: '', enabled: true, debounceSec: 0, lastFiredAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const before = tables.hookEvent.rows.length;
    await emitHookEvent(SUP, 'run_completed', 'supervisor finished');
    expect(tables.hookEvent.rows).toHaveLength(before); // self-loop suppressed

    await emitHookEvent(W1, 'run_completed', 'too deep', { depth: 3 });
    expect(tables.hookEvent.rows.filter((r: any) => r.payload.summary === 'too deep')).toHaveLength(0);
  });
});

/**
 * Ticket a8d6e514 (2026-10-06, lane-filed) — REGRESSION: the progressNote tool
 * layer clamped notes to 200 chars (goals.service PROGRESS_NOTE_MAX = 200)
 * although the DB column is unbounded Text, amputating a standing loop's
 * continuation ledger mid-word (todo d14e0d2d ended "…shortfall, my fi").
 *
 * Pinned end-to-end through the REAL tool dispatch + the REAL goals.service
 * (harness: the fleet-supervisor e2e fakes — stateful prisma, in-memory redis):
 * a >200-char note round-trips verbatim through todo_update → todo_get (and
 * goal_update → goal_get / the scoped goal_list); writes stay bounded at 2,000;
 * the todo_list LISTING shows the bounded display form and points at todo_get;
 * PROGRESS_NOTE_LONG_DISABLED=1 stores 200 again; both schema descriptions
 * carry the new cap.
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
import { executePlatformTool, PLATFORM_TOOL_SCHEMA } from './platform-tools';
import type { ToolContext } from '../coding/tools';

const U = 'u1';
const SUP = 'sup-a8d6'; // a plain supervisor chat (no project) — the standing loop's writer
const P1 = 'p-a8d6';

function makeCtx(overrides: any = {}) {
  return {
    worktree: '/wt', sessionId: SUP, userId: U, permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}
const J = (s: unknown) => JSON.parse(String(s));

/** A standing loop's continuation ledger, ~1,500 chars — the class todo d14e0d2d lost past char 200. */
const LEDGER = [
  'FO f15 cycle (2026-10-05 16:00Z): queue 0 open / 2 in_progress.',
  '9cc62eef stale-by-closure — evidence re-read, closure stands.',
  'f8c62820 (hook-retirement shortfall, my finding) filed and dispatched; sibling sweep pending.',
  ...Array.from({ length: 12 }, (_, i) => `f${16 + i}: carry ticket ${(0xa0000000 + i * 977).toString(16)} — re-check its closure evidence, then sweep its class for siblings.`),
  'NEXT FIRING: continue from the last line above; never restart the queue scan.',
].join(' ');

beforeAll(() => {
  tables.crossModelChat.rows.push({ id: SUP, userId: U, title: 'R&D supervisor', projectId: null });
  tables.crossModelProject.rows.push({ id: P1, userId: U, name: 'R&D', path: `/${P1}`, parentId: null, depth: 0 });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  delete process.env.PROGRESS_NOTE_LONG_DISABLED;
});
afterAll(() => { delete process.env.PROGRESS_NOTE_LONG_DISABLED; });

async function seedGoalAndTodo(): Promise<{ goalId: string; todoId: string }> {
  const machine = makeCtx();
  const gOut = String(await executePlatformTool(machine, 'goal_create', { projectId: P1, title: 'Shortfall hunt (standing loop)' }));
  const goalId = /Created goal ([\w-]+)/.exec(gOut)![1];
  const tOut = String(await executePlatformTool(machine, 'todo_create', { goalId, title: 'Each sweep continues the last' }));
  const todoId = /Created todo ([\w-]+)/.exec(tOut)![1];
  return { goalId, todoId };
}

describe('a8d6e514 — progressNote keeps the continuation ledger (stored ≤2,000; displays stay bounded)', () => {
  it('REGRESSION: a >200-char note round-trips VERBATIM through todo_update → todo_get (a machine run, no user turn)', async () => {
    expect(LEDGER.length).toBeGreaterThan(1000);
    expect(LEDGER.length).toBeLessThanOrEqual(2000);
    const { todoId } = await seedGoalAndTodo();
    const upd = J(await executePlatformTool(makeCtx(), 'todo_update', { todoId, progressNote: LEDGER }));
    expect(upd.progressNote).toBe(LEDGER);
    expect(tables.projectTodo.rows.find((r: any) => r.id === todoId).progressNote).toBe(LEDGER);
    const got = J(await executePlatformTool(makeCtx(), 'todo_get', { todoId }));
    expect(got.progressNote).toBe(LEDGER); // the ids the NEXT firing needs survive
    expect(got.progressNote.endsWith('never restart the queue scan.')).toBe(true);
  });

  it('goal_update → goal_get round-trips too, and the project-scoped goal_list returns the full note', async () => {
    const { goalId } = await seedGoalAndTodo();
    await executePlatformTool(makeCtx(), 'goal_update', { goalId, progressNote: LEDGER });
    expect(J(await executePlatformTool(makeCtx(), 'goal_get', { goalId })).progressNote).toBe(LEDGER);
    const listed = J(await executePlatformTool(makeCtx(), 'goal_list', { projectId: P1 }));
    expect(listed.goals.find((g: any) => g.id === goalId).progressNote).toBe(LEDGER);
  });

  it('todo_list (a LISTING) shows the bounded display form, flags it, and points at todo_get; a short note is untouched', async () => {
    const { goalId, todoId } = await seedGoalAndTodo();
    await executePlatformTool(makeCtx(), 'todo_update', { todoId, progressNote: LEDGER });
    const tOut = String(await executePlatformTool(makeCtx(), 'todo_create', { goalId, title: 'Short-note sibling' }));
    const shortId = /Created todo ([\w-]+)/.exec(tOut)![1];
    await executePlatformTool(makeCtx(), 'todo_update', { todoId: shortId, progressNote: '3/5 shards trained, loss 2.1' });
    const list = J(await executePlatformTool(makeCtx(), 'todo_list', { goalId }));
    const long = list.todos.find((t: any) => t.id === todoId);
    expect(long.progressNote.length).toBeLessThanOrEqual(200);
    expect(long.progressNote.endsWith('…')).toBe(true);
    expect(LEDGER.startsWith(long.progressNote.slice(0, -1))).toBe(true);
    expect(long.progressNoteClipped).toBe(true);
    expect(list.notesClipped).toContain('todo_get');
    const short = list.todos.find((t: any) => t.id === shortId);
    expect(short.progressNote).toBe('3/5 shards trained, loss 2.1');
    expect(short.progressNoteClipped).toBeUndefined();
    // the row itself is untouched — the clamp is display-only
    expect(tables.projectTodo.rows.find((r: any) => r.id === todoId).progressNote).toBe(LEDGER);
  });

  it('the write stays bounded: a note past 2,000 chars is stored at exactly 2,000', async () => {
    const { todoId } = await seedGoalAndTodo();
    const huge = `${LEDGER} ${LEDGER} ${LEDGER}`;
    await executePlatformTool(makeCtx(), 'todo_update', { todoId, progressNote: huge });
    expect(tables.projectTodo.rows.find((r: any) => r.id === todoId).progressNote).toBe(huge.slice(0, 2000));
  });

  it('PROGRESS_NOTE_LONG_DISABLED=1 restores the 200-char storage cap (todo + goal)', async () => {
    process.env.PROGRESS_NOTE_LONG_DISABLED = '1';
    const { goalId, todoId } = await seedGoalAndTodo();
    await executePlatformTool(makeCtx(), 'todo_update', { todoId, progressNote: LEDGER });
    await executePlatformTool(makeCtx(), 'goal_update', { goalId, progressNote: LEDGER });
    expect(tables.projectTodo.rows.find((r: any) => r.id === todoId).progressNote).toBe(LEDGER.slice(0, 200));
    expect(tables.projectGoal.rows.find((r: any) => r.id === goalId).progressNote).toBe(LEDGER.slice(0, 200));
  });

  it('both progressNote schema descriptions state the new cap and where the full note comes back', () => {
    const param = (tool: string) => (PLATFORM_TOOL_SCHEMA as any[]).find((t) => t.function?.name === tool).function.parameters.properties.progressNote.description as string;
    expect(param('goal_update')).toContain('≤2000 chars');
    expect(param('goal_update')).toContain('goal_get');
    expect(param('todo_update')).toContain('≤2000 chars');
    expect(param('todo_update')).toContain('todo_get');
    for (const t of ['goal_update', 'todo_update']) expect(param(t)).not.toContain('≤200 chars');
  });
});

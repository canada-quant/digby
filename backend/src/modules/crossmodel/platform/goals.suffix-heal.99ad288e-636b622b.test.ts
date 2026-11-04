/**
 * REPLAY PIN — tickets 99ad288e + 636b622b (mishap, breaker trips 2026-09-28,
 * sessions cbce1e78 "glm53-flash-w4a16-fp8-mtp Supervisor" and 615723ba
 * "canlegal-bench Supervisor").
 *
 * The two incidents (verbatim failure texts, newest first, 3× each):
 *   · Tool todo_update failed: Todo not found: "e6574531-f505-4b77-b315-8bab1536de12". Did you mean: e6574531-c939-4862-81fb-03acc0cd3d8e ("Full benchmarks: throughput + latency sweeps…")?
 *   · Tool todo_update failed: Todo not found: "f02a76cb-a68c-4e76-9f12-3f1c62826863". Did you mean: f02a76cb-2991-483d-8c52-b2e83ba287f7 ("Recipe search on H100s…")?
 *   · Tool todo_update failed: Todo not found: "d796a35e-a258-4620-8b94-810a6041f4ab". Did you mean: d796a35e-39a6-4e46-beaa-776a517bb458 ("Build our own vLLM container image…")?
 *   · Tool todo_update failed: Todo not found: "665b2d57-663d-4003-bb95-a8f348e94cc1". Did you mean: 665b2d57-c268-47de-9948-d1017d5ef47c ("Deploy fix to bench containers…")?
 *   · Tool todo_update failed: Todo not found: "dfd56bfc-457d-4544-b7f0-48f17e261ac1". Did you mean: dfd56bfc-e987-4067-9432-11b42a34e561 ("Fix header/nav dark-mode rendering…")?
 *   · Tool todo_update failed: Todo not found: "efaeb736-4e61-443a-9eb7-bbb3e5224e2f". Did you mean: efaeb736-3b2d-4f82-84f1-bc081e376b57 ("Diagnose header/nav dark-mode styling…")?
 *
 * ADJUDICATION (dispatch lane, 2026-09-28): BOTH a framework seam and model
 * behavior, deterministically fixed at the framework seam. Every incident id
 * carries the REAL todo's 8-char prefix (the [BOARD] digest renders todos as
 * `todo <id8> [status] "title"` — board-digest.service id8) with a fully
 * invented suffix (hamming distance 21–23 vs the real id — no typo tier can
 * reach it; 263859eb's near-match heals only ≤2). The resolver ladder then
 * refused: resolveUniqueTodoPrefix (8579d419) resolves only 8–35 chars, and
 * the 36-char miss fell through to the "Did you mean" hint — which named the
 * unique correct row and was IGNORED twice more (model behavior, the same
 * hint-ignored shape as 263859eb). The framework-owned defect: since 8579d419
 * + 31db672f the 8-char prefix IS the fleet's addressing idiom (boards render
 * it; read AND write paths resolve it), so a full-shape id carrying a unique
 * caller-visible row's 8-char prefix is that row addressed long-form with a
 * corrupted tail — the 36-char length cap alone turned a healable ref into a
 * 3× breaker streak. Fix (this suite's subject): nearMatchFullShapeId gains a
 * tier-2 suffix heal — after the typo tier misses, a unique CALLER-VISIBLE
 * same-prefix candidate resolves; ambiguity keeps the hint error; the same
 * getProjectAccess gate as every resolver (no new disclosure, cross-account
 * impossible by construction); real ids never enter the candidate scan (exact
 * short-circuit — hot-path pin). The read path (getTodo/getGoal) gains the same ladder
 * so a streak cannot just move from todo_update to todo_get.
 *
 * This file replays ALL SIX verbatim id pairs through the fixed resolver:
 * the write path (todo_update — the incident tool), the read path (todo_get),
 * the goal twin, and the guard rails (ambiguity, invisibility, kill switch,
 * fabricated-no-prefix, hot path, telemetry).
 *
 * Mock harness pattern copied from goals.service.test.ts (stateful fake
 * Prisma: reads see earlier writes).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
  projectMember: { findMany: jest.fn() },
  projectGoal: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  goalDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  todoDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  ownerQuestion: { findFirst: jest.fn(), findMany: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: (...a: any[]) => mockRedisSet(...a), del: (...a: any[]) => mockRedisDel(...a) },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async () => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
}));

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

jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

import { updateTodo, getTodo, getGoal, updateGoal } from './goals.service';

// ── Fixtures + stateful fake DB (goals.service.test.ts pattern) ─────────────

const OWNER = 'u-owner';
const VIEWER = 'u-viewer';
const STRANGER = 'u-stranger';
const NOW = new Date('2026-09-28T00:00:00Z');

const PROJECT = {
  id: 'p1', userId: OWNER, name: 'P1', path: '/p1',
  members: [{ userId: VIEWER, role: 'viewer' }],
};

const goalRow = (over: any = {}) => ({
  id: 'g1', userId: OWNER, projectId: 'p1', title: 'Goal 1', description: '',
  status: 'active', blockedReason: null, createdByChatId: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});
const todoRow = (over: any = {}) => ({
  id: 't1', userId: OWNER, goalId: 'g1', projectId: 'p1', title: 'Todo 1',
  status: 'pending', blockedReason: null, assigneeChatId: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});

let db: { projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[]; ownerQuestions: any[] };

function resetDb() {
  db = {
    projects: [{ ...PROJECT, members: PROJECT.members.map((m) => ({ ...m })) }],
    goals: [], todos: [], goalDeps: [], todoDeps: [], ownerQuestions: [],
  };
}

function pick(row: any, select: any) {
  if (!select) return row;
  const out: any = {};
  for (const k of Object.keys(select)) if (select[k] === true) out[k] = row[k];
  return out;
}

function matchRow(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (k === 'goal') return db.goals.some((g) => g.id === row.goalId && g.userId === v.userId);
    if (k === 'todo') return db.todos.some((t) => t.id === row.todoId && t.userId === v.userId);
    if (k === 'OR') return (v as any[]).some((clause) => matchRow(row, clause));
    if (v === null) return row[k] == null;
    if (v && typeof v === 'object' && 'startsWith' in v) return String(row[k] ?? '').startsWith(v.startsWith);
    if (v && typeof v === 'object' && 'endsWith' in v) return String(row[k] ?? '').endsWith(v.endsWith); // audit 2026-10-08 W3-3
    if (v && typeof v === 'object' && 'contains' in v) return String(row[k] ?? '').includes(v.contains);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
}

function wireFake() {
  mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) =>
    db.projects.find((p) => p.id === where.id) ?? null);
  mockPrisma.crossModelProject.findMany.mockImplementation(async (args: any = {}) =>
    db.projects.filter((p) => matchRow(p, args.where)));
  mockPrisma.projectMember.findMany.mockImplementation(async () => []);
  mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ where, select }: any) => {
    const row = db.ownerQuestions.find((q) => matchRow(q, where)) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.ownerQuestion.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.ownerQuestions.filter((q) => matchRow(q, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r: any) => pick(r, args.select));
    return rows;
  });
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
    ({ id: where.id, userId: OWNER }));

  mockPrisma.projectGoal.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.goals.find((g) => g.id === where.id) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.projectGoal.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.goals.filter((g) => matchRow(g, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r) => pick(r, args.select));
    return rows;
  });
  mockPrisma.projectGoal.create.mockImplementation(async ({ data }: any) => {
    const row = { description: '', status: 'active', blockedReason: null, createdByChatId: null, createdAt: NOW, updatedAt: NOW, ...data };
    db.goals.push(row);
    return { ...row };
  });
  mockPrisma.projectGoal.update.mockImplementation(async ({ where, data }: any) => {
    const row = db.goals.find((g) => g.id === where.id);
    if (!row) throw new Error(`goal ${where.id} not found`);
    Object.assign(row, data);
    return { ...row };
  });

  mockPrisma.projectTodo.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.todos.find((t) => t.id === where.id) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.projectTodo.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.todos.filter((t) => matchRow(t, args.where));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r) => pick(r, args.select));
    return rows;
  });
  mockPrisma.projectTodo.create.mockImplementation(async ({ data }: any) => {
    const row = { status: 'pending', blockedReason: null, assigneeChatId: null, createdAt: NOW, updatedAt: NOW, ...data };
    db.todos.push(row);
    return { ...row };
  });
  mockPrisma.projectTodo.update.mockImplementation(async ({ where, data }: any) => {
    const row = db.todos.find((t) => t.id === where.id);
    if (!row) throw new Error(`todo ${where.id} not found`);
    Object.assign(row, data);
    return { ...row };
  });
  mockPrisma.projectTodo.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = db.todos.filter((t) => matchRow(t, where));
    for (const r of rows) Object.assign(r, data);
    return { count: rows.length };
  });
  mockPrisma.projectGoal.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = db.goals.filter((g) => matchRow(g, where));
    for (const r of rows) Object.assign(r, data);
    return { count: rows.length };
  });

  mockPrisma.goalDependency.findMany.mockImplementation(async (args: any = {}) =>
    db.goalDeps.filter((d) => matchRow(d, args.where)));
  mockPrisma.goalDependency.createMany.mockImplementation(async ({ data }: any) => {
    for (const d of data) db.goalDeps.push({ ...d });
    return { count: data.length };
  });
  mockPrisma.goalDependency.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = db.goalDeps.length;
    db.goalDeps = db.goalDeps.filter((d) => !matchRow(d, where));
    return { count: before - db.goalDeps.length };
  });
  mockPrisma.todoDependency.findMany.mockImplementation(async (args: any = {}) =>
    db.todoDeps.filter((d) => matchRow(d, args.where)));
  mockPrisma.todoDependency.createMany.mockImplementation(async ({ data }: any) => {
    for (const d of data) db.todoDeps.push({ ...d });
    return { count: data.length };
  });
  mockPrisma.todoDependency.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = db.todoDeps.length;
    db.todoDeps = db.todoDeps.filter((d) => !matchRow(d, where));
    return { count: before - db.todoDeps.length };
  });
}

// ── The six verbatim incident id pairs (typed → real) ───────────────────────

const INCIDENT_99AD288E = [
  {
    typed: 'e6574531-f505-4b77-b315-8bab1536de12',
    real: 'e6574531-c939-4862-81fb-03acc0cd3d8e',
    title: 'Full benchmarks: throughput + latency sweeps across request rates and prompt/output lengths vs competitor H100 baselines',
  },
  {
    typed: 'f02a76cb-a68c-4e76-9f12-3f1c62826863',
    real: 'f02a76cb-2991-483d-8c52-b2e83ba287f7',
    title: 'Recipe search on H100s: sweep TP layouts, max-num-seqs, chunked prefill, CUDA graph sizes, KV cache dtype, speculative config',
  },
  {
    typed: 'd796a35e-a258-4620-8b94-810a6041f4ab',
    real: 'd796a35e-39a6-4e46-beaa-776a517bb458',
    title: 'Build our own vLLM container image (Dockerfile) for GLM-5.3-Flash W4A16-FP8 + DFlash2/MTP drafter on H100',
  },
] as const;

const INCIDENT_636B622B = [
  {
    typed: '665b2d57-663d-4003-bb95-a8f348e94cc1',
    real: '665b2d57-c268-47de-9948-d1017d5ef47c',
    title: 'Deploy fix to bench containers and verify live on canlegalbench.com + canlegal-bench.example.com in both modes',
  },
  {
    typed: 'dfd56bfc-457d-4544-b7f0-48f17e261ac1',
    real: 'dfd56bfc-e987-4067-9432-11b42a34e561',
    title: 'Fix header/nav dark-mode rendering; verify light mode unaffected; tests green',
  },
  {
    typed: 'efaeb736-4e61-443a-9eb7-bbb3e5224e2f',
    real: 'efaeb736-3b2d-4f82-84f1-bc081e376b57',
    title: 'Diagnose header/nav dark-mode styling (locate component + theme tokens, reproduce both modes)',
  },
] as const;

const ALL_INCIDENTS = [...INCIDENT_99AD288E, ...INCIDENT_636B622B];

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  wireFake();
});

// ── REPLAY: the incident tool (todo_update) — the write path ────────────────

describe('REPLAY 99ad288e + 636b622b — todo_update with the verbatim fabricated ids', () => {
  it.each(ALL_INCIDENTS)('write: fabricated suffix on prefix "$real" → resolves + updates the REAL row on attempt 1 (the 3× streak class dies here)', async ({ typed, real, title }) => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: real, title, status: 'in_progress' }));
    // THE INCIDENT CALL: todo_update(todoId: <typed>, status: 'done') —
    // pre-fix this 404'd three times in a row with a hint naming `real`.
    const out = await updateTodo({ userId: OWNER, todoId: typed, status: 'done' });
    expect(out.id).toBe(real);
    expect(db.todos.find((t) => t.id === real)?.status).toBe('done');
  });

  it.each(ALL_INCIDENTS)('read: todo_get with the verbatim fabricated id resolves the REAL row too (the ladder is uniform read==write)', async ({ typed, real, title }) => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: real, title }));
    const t = await getTodo({ userId: OWNER, todoId: typed });
    expect(t.id).toBe(real);
    expect(t.title).toBe(title);
  });
});

// ── The goal twin (the heal is entity-uniform) ──────────────────────────────

describe('the goal twin — a garbled full goal id resolves on read and write', () => {
  const REAL_GOAL = '0c08e0e2-0c25-4b4e-8193-91ad0fea4088';
  const GARBLED = '0c08e0e2-7777-4b4e-8193-91ad0fea4088';

  it('updateGoal: the garbled id resolves and the write lands on the REAL goal', async () => {
    db.goals.push(goalRow({ id: REAL_GOAL, title: 'Before' }));
    await updateGoal({ userId: OWNER, goalId: GARBLED, title: 'After' });
    expect(db.goals.find((g) => g.id === REAL_GOAL)?.title).toBe('After');
  });

  it('getGoal: the garbled id resolves the REAL goal', async () => {
    db.goals.push(goalRow({ id: REAL_GOAL, title: 'Goal' }));
    const g = await getGoal({ userId: OWNER, goalId: GARBLED });
    expect(g.id).toBe(REAL_GOAL);
  });
});

// ── Guard rails (every door the old doctrine kept shut stays shut) ─────────

describe('guard rails', () => {
  const REAL = 'e6574531-c939-4862-81fb-03acc0cd3d8e';
  const TYPED = 'e6574531-f505-4b77-b315-8bab1536de12';

  it('AMBIGUITY: two visible same-prefix todos → hint error, never a guess, ZERO writes', async () => {
    db.goals.push(goalRow());
    db.todos.push(
      todoRow({ id: REAL, title: 'A' }),
      todoRow({ id: 'e6574531-ffff-4862-81fb-03acc0cd3d8e', title: 'B' }),
    );
    await expect(updateTodo({ userId: OWNER, todoId: TYPED, status: 'done' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Did you mean') });
    expect(db.todos.every((t) => t.status === 'pending')).toBe(true);
  });

  it('INVISIBILITY: the same-prefix row exists but the caller cannot see it → bare 404, no existence leak, no heal', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: REAL, title: 'A' }));
    await expect(updateTodo({ userId: STRANGER, todoId: TYPED, status: 'done' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.not.stringContaining('Did you mean') });
    expect(db.todos.find((t) => t.id === REAL)?.status).toBe('pending');
  });

  it('FABRICATED-NO-PREFIX (14c64064 class): an id whose 8-char prefix matches nothing keeps the bare 404', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: REAL, title: 'A' }));
    await expect(updateTodo({ userId: OWNER, todoId: 'e83f3f00-0000-0000-000000000001', status: 'done' }))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Todo not found') });
  });

  it('VIEWER (read-only member): the heal resolves the row, then the WRITE gate refuses 403 — same contract as a full id', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: REAL, title: 'A' }));
    await expect(updateTodo({ userId: VIEWER, todoId: TYPED, status: 'done' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(db.todos.find((t) => t.id === REAL)?.status).toBe('pending');
  });

  it('the typo tier resolves a hamming-1 id', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: REAL, title: 'A' }));
    const TYPO = 'e6574531-c939-4862-81fb-03acc0cd3d8e'.replace('03acc0cd3d8e', '03acc0cd3d8f');
    const out = await updateTodo({ userId: OWNER, todoId: TYPO, title: 'Typo-healed' });
    expect(out.id).toBe(REAL);
  });

  it('HOT PATH: a REAL full id pays ZERO prefix candidate scans (the firing-24 pin, unchanged)', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: REAL, title: 'A' }));
    await updateTodo({ userId: OWNER, todoId: REAL, title: 'B' });
    const prefixScans = mockPrisma.projectTodo.findMany.mock.calls
      .filter((c: any[]) => c[0]?.where?.id?.startsWith !== undefined);
    expect(prefixScans).toHaveLength(0);
  });
});

// ── Telemetry — the heal is counted, one row per healed call ────────────────

describe('telemetry', () => {
  it('every suffix heal mints ONE goal_todo_suffix_healed row (entity/typed/resolved/userId); real ids mint none', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: 'e6574531-c939-4862-81fb-03acc0cd3d8e', title: 'A' }));
    await updateTodo({ userId: OWNER, todoId: 'e6574531-f505-4b77-b315-8bab1536de12', status: 'done' });
    const heals = mockRecordLoopMetric.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.kind === 'goal_todo_suffix_healed');
    expect(heals).toHaveLength(1);
    expect(heals[0].meta).toMatchObject({
      entity: 'todo',
      typed: 'e6574531',
      resolved: 'e6574531',
      userId: OWNER,
    });
    // A real full id mints NO heal row.
    mockRecordLoopMetric.mockClear();
    await updateTodo({ userId: OWNER, todoId: 'e6574531-c939-4862-81fb-03acc0cd3d8e', title: 'Real' });
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'goal_todo_suffix_healed')).toHaveLength(0);
  });
});

// ── audit 2026-10-08 W3-3: the shared heal tier also takes a SUFFIX / prefix+suffix splice ──
describe('shared id heal tier (audit 2026-10-08 W3-3)', () => {
  const REAL = 'e6574531-c939-4862-81fb-03acc0cd3d8e';
  afterEach(() => { delete process.env.ID_RESOLVER_HEAL_DISABLED; });

  it('todo_update with the rendered suffix "…03acc0cd3d8e" and with a "e6574531-03acc0cd" splice both land on the ONE visible todo', async () => {
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: REAL, title: 'A' }));
    await updateTodo({ userId: OWNER, todoId: '…03acc0cd3d8e', title: 'B' });
    expect(db.todos.find((t) => t.id === REAL)!.title).toBe('B');
    await updateTodo({ userId: OWNER, todoId: 'e6574531-c0cd3d8e', title: 'C' });
    expect(db.todos.find((t) => t.id === REAL)!.title).toBe('C');
    const got = await getTodo({ userId: OWNER, todoId: '…acc0cd3d8e' } as any);
    expect((got as any).id ?? (got as any).todo?.id).toBe(REAL);
  });

  it('kill switch ID_RESOLVER_HEAL_DISABLED=1: a suffix is a 404 again', async () => {
    process.env.ID_RESOLVER_HEAL_DISABLED = '1';
    db.goals.push(goalRow());
    db.todos.push(todoRow({ id: REAL, title: 'A' }));
    await expect(updateTodo({ userId: OWNER, todoId: '…03acc0cd3d8e', title: 'B' })).rejects.toMatchObject({ statusCode: 404 });
  });
});


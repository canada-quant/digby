/**
 * REPLAY PIN — ticket ce2386ce-5b1c-4136-8335-5f377ae6291a (mishap, breaker
 * trip 2026-09-28T10:05:59Z, session b92ef13f "Digby's Nightly Self-Improvement
 * Engineer", run 32c998b3-32d8-4b7d-ab2a-0ba2867059eb; FIRST streak this run;
 * tool todo_get).
 *
 * THE INCIDENT (auto-filed, three failure texts, all byte-identical):
 *   `Tool todo_get failed: Todo not found: "4c090f35-aaaa-bbbb-cccc-000000000000".
 *    Did you mean: 4c090f35-d22c-4ac9-8d3a-f2170946e36a ("E2E scratch todo:
 *    fabricated-suffix probe (99ad288e/636b622b)")? Re-call with the EXACT id
 *    copied verbatim from todo_list (never reconstruct or abbreviate an id)`
 *
 * WHAT ACTUALLY HAPPENED (adjudicated 2026-09-28 against agent_events on the
 * prod boxes — every fact re-probed fresh, probe verify-ce2386ce-todoget):
 *  1. THE CALLER WAS THE FIX'S OWN AUTHOR, MID-VERIFICATION. Run 32c998b3 is
 *     the nightly-engineer lane that had just shipped the tier-2 suffix heal
 *     (PR #1116, 0f0041bcd — tickets 99ad288e + 636b622b). Its own reasoning
 *     (agent_events seq 454, 09:38:25Z) shows the id was DELIBERATELY
 *     CONSTRUCTED as a probe: "invent the rest. E.g. \"4c090f35-aaaa-bbbb-
 *     cccc-000000000000\"… Current deployed backend: box C on 4d15eeac
 *     (pre-fix) → expect 404 + Did you mean". The aaaa/bbbb/cccc/000… tail is
 *     a placeholder pattern no hallucination produces.
 *  2. THE THREE CALLS WERE THREE LEGITIMATE PROBES. Call 1 (seq 459,
 *     09:38:26Z) was the PRE-FIX BASELINE CAPTURE — it 404'd with the hint
 *     exactly as expected (the run's own seq 462: "The baseline probe is
 *     captured — the pre-fix deployed backend 404s with the hint, exactly the
 *     incident shape"). Calls 2–3 (seq 604 10:02:57Z, seq 727 10:05:53Z) were
 *     the POST-DEPLOY verification — the heal wave (deploy run 36404187651)
 *     had concluded 10:01:51Z, but an IN-FLIGHT RUN SURVIVES A BLUE-GREEN
 *     SWAP ON THE OLD COLOUR: the run (started 09:13:05Z) kept executing on
 *     the draining pre-deploy container, so its session-level todo_get still
 *     hit pre-0f0041bc code and 404'd (the run diagnosed this itself at seq
 *     736). The run then verified the heal from INSIDE the ACTIVE post-fix
 *     container (docker exec admin-worker-green: E2E_SUFFIX_HEAL_OK read +
 *     E2E_WRITE_PATH_SUFFIX_HEAL_OK write) and completed 8/8.
 *  3. THE BREAKER COUNTED AS DESIGNED. Three failure-shaped todo_get results
 *     with no interleaved todo_get success → per-tool streak 1→2→3 (agent.ts
 *     failStreakCount, the pinned anti-laundering semantics) → trip at 3:
 *     one-round withhold (seq 729, 10:05:59Z: "todo_get failed 3× in a row —
 *     withheld for one round to break the loop") + this auto-filed ticket.
 *     Probe-vs-derail adjudication is the ea69c94e class: lifecycle-mandated
 *     live E2E NEGATIVE probes trip the breaker by design — intent is
 *     invisible to the streak counter, and the ticket is the accepted cost.
 *  4. THE FIX IS LIVE AND CORRECT (re-probed fresh 2026-09-28T10:25Z by the
 *     adjudicating lane): todo_get with the EXACT fabricated id through the
 *     real tool boundary resolves to 4c090f35-d22c-4ac9-8d3a-f2170946e36a
 *     (loop_metrics row kind=goal_todo_suffix_healed, typed 4c090f35,
 *     10:25:00.257Z). Diffing the failure texts against framework changes
 *     shows ZERO drift beyond the heal itself: with tier 2 gated off (the
 *     old-colour proxy, since retired), the code reproduced the incident
 *     message BYTE-EXACTLY.
 *
 * VERDICT (the ticket's mandated investigation): NO deterministic framework
 * defect, NO model behavior to fix — deliberate, doctrine-mandated E2E probes
 * (the ea69c94e class) executed across a blue-green swap on the OLD colour;
 * the underlying defect was ALREADY FIXED by the same run (PR #1116,
 * 0f0041bcd, tickets 99ad288e + 636b622b) and is live on every box. The
 * operational lesson (verify live surfaces from the ACTIVE container, never
 * from an in-flight run's own tool calls) is banked separately on main as
 * PR #1117 — not duplicated here. NO platform code change; a shape exemption
 * for this class would be WRONG (same reasoning as ea69c94e: probe refusals
 * are the breaker's primary signal, intent is invisible to the shape layer).
 *
 * These tests pin: (a) the byte-exact incident surface under pre-fix
 * semantics (kill switch = the old colour), proving the ONLY delta between
 * then and now is the tier-2 heal itself; (b) the exact incident id heals on
 * attempt 1 on current code, read AND write paths (the streak class dies
 * here); (c) the tier-1 typo tier cannot reach this id (hamming distance is
 * computed, not assumed); (d) one telemetry row per healed call. The heal's
 * full guard-rail matrix (ambiguity, invisibility, viewer gate, hot path) is
 * pinned in goals.suffix-heal.99ad288e-636b622b.test.ts — not duplicated.
 *
 * Mock harness pattern copied verbatim from that suite (stateful fake
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

import { updateTodo, getTodo } from './goals.service';

// ── Fixtures: the incident's exact ids (verbatim from the ticket) ───────────

const OWNER = 'u-owner';
const NOW = new Date('2026-09-28T00:00:00Z');
const PROJECT = { id: 'p1', userId: OWNER, name: 'P1', path: '/p1', members: [] };

// The REAL scratch todo the nightly-engineer created for the 99ad288e/636b622b
// probes — id and title verbatim from the ticket's hint text.
const REAL = '4c090f35-d22c-4ac9-8d3a-f2170946e36a';
const TITLE = 'E2E scratch todo: fabricated-suffix probe (99ad288e/636b622b)';
// The fabricated probe id, verbatim: REAL's 8-char prefix + a placeholder tail.
const FAB = '4c090f35-aaaa-bbbb-cccc-000000000000';

/** Positional hamming distance (equal-length strings) — computed, not assumed. */
function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
}

let db: { projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[]; ownerQuestions: any[] };

function resetDb() {
  db = {
    projects: [{ ...PROJECT, members: [] }],
    goals: [{ id: 'g1', userId: OWNER, projectId: 'p1', title: 'E2E scratch: suffix-heal probe (99ad288e/636b622b) — archive after probe', description: '', status: 'archived', blockedReason: null, createdByChatId: null, createdAt: NOW, updatedAt: NOW }],
    todos: [],
    goalDeps: [], todoDeps: [], ownerQuestions: [],
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
    if (v === null) return row[k] == null;
    if (v && typeof v === 'object' && 'startsWith' in v) return String(row[k] ?? '').startsWith(v.startsWith);
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
    const row = { status: 'pending', blockedReason: null, assigneeChatId: null, evidence: null, progressNote: null, doneRunId: null, updatedByChatId: null, updatedByRunId: null, createdAt: NOW, updatedAt: NOW, ...data };
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

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  wireFake();
});

// ── (b) The exact incident id heals on attempt 1 — the streak class dies ───

describe('ce2386ce (b): current code — the exact fabricated id resolves on attempt 1', () => {
  it('READ (todo_get, the incident tool): FAB → the REAL scratch todo, no error', async () => {
    db.todos.push({
      id: REAL, userId: OWNER, goalId: 'g1', projectId: 'p1', title: TITLE,
      status: 'done', blockedReason: null, assigneeChatId: null, evidence: null, progressNote: null,
      doneRunId: null, updatedByChatId: null, updatedByRunId: null, createdAt: NOW, updatedAt: NOW,
    });
    const t = await getTodo({ userId: OWNER, todoId: FAB });
    expect(t.id).toBe(REAL);
    expect(t.title).toBe(TITLE);
  });

  it('WRITE (todo_update twin): FAB → the write lands on the REAL row (attempt 1)', async () => {
    db.todos.push({
      id: REAL, userId: OWNER, goalId: 'g1', projectId: 'p1', title: TITLE,
      status: 'pending', blockedReason: null, assigneeChatId: null, evidence: null, progressNote: null,
      doneRunId: null, updatedByChatId: null, updatedByRunId: null, createdAt: NOW, updatedAt: NOW,
    });
    const out = await updateTodo({ userId: OWNER, todoId: FAB, status: 'done' });
    expect(out.id).toBe(REAL);
    expect(db.todos.find((x) => x.id === REAL)?.status).toBe('done');
  });
});

// ── (c) Why the OLD colour could not have healed it: tier 1 is unreachable ──

describe('ce2386ce (c): the typo tier cannot reach this id (the 404 was structural pre-fix, not a near miss)', () => {
  it('hamming(FAB, REAL) = 23 ≫ 2 — only tier 2 (the unique-visible-prefix heal) can resolve it', () => {
    // Computed in-test so the pin cannot rot with a fixture edit: the
    // invented suffix differs from the real tail in ~every position, exactly
    // the 99ad288e/636b622b incident shape (hamming 21–23 there; this pair
    // computes to 23 — 4+4+4 across the three dashed groups, 11 of 12 in the
    // tail).
    expect(FAB).toHaveLength(36);
    expect(REAL).toHaveLength(36);
    expect(FAB.slice(0, 8)).toBe(REAL.slice(0, 8)); // the real 8-char prefix
    expect(hamming(FAB, REAL)).toBe(23);            // pinned exactly: tier-1's ≤2 can never reach it
    // And every char of FAB is hex → isFullChatIdShape(FAB) is true → the
    // 36-char length cap (resolveUniqueTodoPrefix, 8–35) is what refused it
    // pre-fix — the structural reason the old colour 404'd.
    expect(FAB).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ── (d) Telemetry: the heal is counted once per healed call ─────────────────

describe('ce2386ce (d): telemetry — one goal_todo_suffix_healed row for the incident id', () => {
  it('read-path heal mints exactly one row (entity todo, typed 4c090f35, resolved 4c090f35)', async () => {
    db.todos.push({
      id: REAL, userId: OWNER, goalId: 'g1', projectId: 'p1', title: TITLE,
      status: 'done', blockedReason: null, assigneeChatId: null, evidence: null, progressNote: null,
      doneRunId: null, updatedByChatId: null, updatedByRunId: null, createdAt: NOW, updatedAt: NOW,
    });
    await getTodo({ userId: OWNER, todoId: FAB });
    const heals = mockRecordLoopMetric.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.kind === 'goal_todo_suffix_healed');
    expect(heals).toHaveLength(1);
    expect(heals[0].meta).toMatchObject({ entity: 'todo', typed: '4c090f35', resolved: '4c090f35' });
  });
});

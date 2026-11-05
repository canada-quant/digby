/**
 * REPLAY PIN — ticket 921013a5 (mishap, breaker trip 2026-11-04T20:10Z,
 * session c0e22e36 "Fleet Supervisor", surface coding, first streak that run).
 *
 * The mishap (verbatim failure texts, newest first — all `todo_get`):
 *   · Todo not found: "7e987035" — no todo with that id is visible to you. …
 *   · Todo not found: "a930d169" — no todo with that id is visible to you. …
 *   · Todo not found: "33a75ed8" — no todo with that id is visible to you. …
 *
 * ADJUDICATION (this lane, 2026-11-05): MODEL BEHAVIOR, framework correct.
 * No deterministic framework/schema/preflight defect produces this streak.
 * The evidence, one criterion at a time — each pinned by a test below:
 *
 *  A. NOT the pre-fix identical-text class. That defect (bfcd01fc / 7ae1f4c4:
 *     the no-hint 404 dropped the received id, so three phantom probes made
 *     three BYTE-IDENTICAL texts the breaker could not attribute) was fixed by
 *     PR #724 (squash cefde5129, 2026-09-13) and is live: every one of these
 *     three texts names its own probed id and the `todo_list` recovery path.
 *     Distinct texts per id is the self-describing contract (251e9329) working.
 *
 *  B. NOT a broken by-id path. The read ladder resolves all FOUR of its tiers
 *     (unique ≥8-char prefix / full-shape typo+invented suffix / unique exact
 *     title / suffix-splice heal), and the SAME call on a real id resolves — so
 *     a 404 here means "no such row", not "todo_get is broken".
 *     NOTE (scope of this file): the adjudicating lane probed the three ids in
 *     PRODUCTION this run (todo_get → 404; resolve_id → no match in any id
 *     family). That probe is NOT re-executed here — this file proves the
 *     BEHAVIOUR (a nonexistent id 404s, a real one resolves); it cannot prove
 *     account-wide absence, and does not claim to.
 *
 *  C. The breaker counting it is a DESIGNED GUARD, not the defect. A fleet lane
 *     that probes three ids that resolve to nothing IS derailed: the failure is
 *     real and actionable, and the framework's own recovery advice (re-copy the
 *     id from a fresh todo_list) is the fix. Same discriminator shape as
 *     b7bf4dcb-c2bcf488 — a real refusal must keep counting. (Honest scope:
 *     `looksLikeToolFailure` is the CLASSIFIER the streak counter in agent.ts
 *     consumes; this file pins the classifier, not the counter.)
 *
 *  D. NOT a preflight miss — and structurally CANNOT be one for `todoId`. The
 *     three ids are 8-hex SHAPED, so the id-grounding pre-flight accepts them
 *     by the citation contract (they look like ids we hand out). Because every
 *     real goal/todo id is hex, `findUngroundedIdArgs` can never refuse a
 *     `todo_get` call: such a streak ALWAYS accumulates to the ordinary
 *     threshold of 3 rather than fast-tripping at 1. A true placeholder
 *     ("noop", "TBD") is still refused at dispatch — pinned here so the shape
 *     rule cannot silently widen.
 *
 * Test-only: no production file is touched. The mock set mirrors
 * goals.service.bfcd01fc.test.ts (same stateful fake DB) plus the two detector
 * leaves; `LOOP_METRIC_KINDS` is loaded from the REAL import-free leaf so a new
 * kind never lands here as `undefined` (a wrong-reason red).
 *
 * ── SECTION E — ticket d8395cca (the LINEAGE meta-case, added 2026-11-05) ─────
 * The adjudicating lane above reproduced this streak BY PROBING ITS THREE IDS,
 * and that reproduction trip filed a SECOND ticket of the same family:
 * d8395cca (filed 2026-11-05T01:20:35Z from run 42cc8fca of session 350827a9).
 * Its three probes were `a930d169`, `7e987035`, and `921013a5` — the last being
 * the TICKET id itself, quoted from the "Call args of those failing calls" list
 * in ticket 921013a5 where it appears as an id, never as a todo.
 *
 * That is NOT a framework defect and NOT an exemption candidate:
 *   · `921013a5` is a REAL id — of a TICKET. `todo_get`'s read ladder searches
 *     projectTodo / projectGoal only, so a ticket id is structurally outside its
 *     resolution universe and 404s exactly like a fabricated one. Nothing in the
 *     framework lies to the lane about that, and the reply names the id and the
 *     `todo_list` recovery path.
 *   · No cross-family hint fires for it, and none would have: `getTodoRow`'s
 *     ONLY hint branch (`… is a GOAL id — use goal_get …`) requires the id to
 *     be a row in projectGoal, and a TICKET id is in neither table — so that
 *     hint could not have helped this probe either. (A ticket-aware resolver
 *     does exist one layer up — `resolve_id` enumerates ticket among its
 *     families, fleet-ops-tools.ts:54 — which is exactly why the recovery
 *     advice is `todo_list`, not a hint from this tool.) This section pins the
 *     tool's CURRENT contract, not a missed branch.
 *   · So the probes still count as failures, correctly — an id read out of a
 *     ticket's prose is a citation the lane should have re-grounded before
 *     spending a tool call on it. The lineage pattern (investigating a streak by
 *     reproducing it files a new streak ticket) is recorded as a FRAMEWORK
 *     BACKLOG observation in d8395cca's adminNote, deliberately NOT implemented:
 *     an exemption for "probe" ids was refuted on ticket d53eed71 by pinned
 *     security invariants around the staging flow — the loopjacking replay pin
 *     (confirmation-loopjacking.cd366b85.test.ts) and the staged-args-execute
 *     case that pin cites ("the swapped args are ignored entirely; only the
 *     staged args execute", platform-tools.test.ts) — and silencing a real
 *     refusal is that same change class.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectMember: { findMany: jest.fn() },
  projectGoal: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  goalDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  todoDependency: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  ownerQuestion: { findUnique: jest.fn(), findMany: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
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

const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

// Metrics: spy on the recorder, but take the KIND REGISTRY from the real
// import-free leaf (platform/loop-metric-kinds.ts) — hand-typing a subset makes
// any future reachable kind `undefined` and reds this suite for the wrong
// reason. The spy is asserted in the ladder tests, so it also proves WHICH
// resolver did the work.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => {
  const actualKinds = jest.requireActual('../platform/loop-metric-kinds');
  return {
    __esModule: true,
    recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
    recordRunSpend: jest.fn(),
    LOOP_METRIC_KINDS: actualKinds.LOOP_METRIC_KINDS,
  };
});
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memSearch: jest.fn(async () => []),
  memReplaceRef: jest.fn(async () => null),
}));

import { getTodo } from './goals.service';
import { LOOP_METRIC_KINDS } from '../platform/loop-metric-kinds';
import { looksLikeToolFailure } from '../coding/learnings-index.service';
import { findUngroundedIdArgs } from '../coding/tool-preflight';

// ── Fixtures + stateful fake DB (same pattern as goals.service.bfcd01fc.test.ts)

const OWNER = 'u-owner';
const OTHER_USER = 'u-other';
const NOW = new Date('2026-11-04T00:00:00Z');

const PROJECT = { id: 'p1', userId: OWNER, name: 'P1', path: '/p1', members: [] as any[] };
/** A project OWNER has no access to — for the non-disclosure contract. */
const FOREIGN_PROJECT = { id: 'p2', userId: OTHER_USER, name: 'P2', path: '/p2', members: [] as any[] };

const goalRow = (over: any = {}) => ({
  id: 'g1', userId: OWNER, projectId: 'p1', title: 'Goal 1', description: '',
  status: 'active', blockedReason: null, createdByChatId: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});

const todoRow = (over: any = {}) => ({
  id: 't1', goalId: 'g1', projectId: 'p1', title: 'Todo 1', status: 'pending',
  blockedReason: null, blockKind: null, gateQuestionId: null, blockedAt: null,
  progressNote: null, startedAt: null, assigneeChatId: null, evidence: null,
  doneRunId: null, updatedByChatId: null, updatedByRunId: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});

let db: { projects: any[]; goals: any[]; todos: any[]; goalDeps: any[]; todoDeps: any[] };

function resetDb() {
  db = { projects: [{ ...PROJECT }, { ...FOREIGN_PROJECT }], goals: [goalRow()], todos: [], goalDeps: [], todoDeps: [] };
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
    // `goal: { userId }` — a relation filter on the parent goal's owner.
    if (k === 'goal') return db.goals.some((g) => g.id === row.goalId && g.userId === v.userId);
    if (k === 'OR') return (v as any[]).some((clause) => matchRow(row, clause));
    if (v === null) return row[k] == null;
    if (v && typeof v === 'object' && 'startsWith' in v) return String(row[k] ?? '').startsWith(v.startsWith);
    if (v && typeof v === 'object' && 'endsWith' in v) return String(row[k] ?? '').endsWith(v.endsWith);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && 'equals' in v) {
      const a = String(row[k] ?? '');
      const b = String(v.equals ?? '');
      return v.mode === 'insensitive' ? a.toLowerCase() === b.toLowerCase() : a === b;
    }
    return row[k] === v;
  });
}

function wireFake() {
  mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) => {
    const p = db.projects.find((x) => x.id === where.id) ?? null;
    // `include: { members: true }` — getProjectAccess reads this.
    return p ? { ...p, members: p.members ?? [] } : null;
  });
  mockPrisma.crossModelProject.findMany.mockImplementation(async (args: any = {}) =>
    db.projects.filter((p) => matchRow(p, args.where)));
  mockPrisma.projectMember.findMany.mockImplementation(async () => []);
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
    ({ id: where.id, userId: OWNER }));
  mockPrisma.projectGoal.findUnique.mockImplementation(async ({ where, select }: any) => {
    const row = db.goals.find((g) => g.id === where.id) ?? null;
    return row ? pick(row, select) : null;
  });
  mockPrisma.projectGoal.findMany.mockImplementation(async (args: any = {}) => {
    let rows = db.goals.filter((g) => matchRow(g, args.where));
    if (args.orderBy?.createdAt) rows = [...rows].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (args.take) rows = rows.slice(0, args.take);
    if (args.select) rows = rows.map((r) => pick(r, args.select));
    return rows;
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
  mockPrisma.goalDependency.findMany.mockImplementation(async (args: any = {}) =>
    db.goalDeps.filter((d) => matchRow(d, args.where)));
  mockPrisma.todoDependency.findMany.mockImplementation(async (args: any = {}) =>
    db.todoDeps.filter((d) => matchRow(d, args.where)));
  mockPrisma.ownerQuestion.findUnique.mockImplementation(async () => null);
  mockPrisma.ownerQuestion.findMany.mockImplementation(async () => []);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  wireFake();
  // Defensive: the heal killer and folder inheritance both change which tier
  // runs; never inherit them from the ambient .env or a sibling suite.
  delete process.env.ID_RESOLVER_HEAL_DISABLED;
  delete process.env.FOLDERS_INHERITANCE;
});

afterEach(() => {
  delete process.env.ID_RESOLVER_HEAL_DISABLED;
  delete process.env.FOLDERS_INHERITANCE;
});

// ── The exact ids ticket 921013a5 recorded, quoted verbatim from its filed
//    "Call args of those failing calls" list (newest first) ───────────────────

const PHANTOM_TODO_IDS = ['7e987035', 'a930d169', '33a75ed8'] as const;

const bareTodo404 = (id: string) =>
  `Todo not found: "${id}" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first`;

const probe = async (id: string): Promise<string> => {
  const err: any = await getTodo({ userId: OWNER, todoId: id }).catch((e: any) => e);
  expect(err.statusCode).toBe(404);
  return `Tool todo_get failed: ${err.message}`;
};

// ── A. The pre-fix identical-text class is gone: each probe names its own id ──

describe('921013a5 — the three probes are SELF-DESCRIBING (the bfcd01fc/7ae1f4c4 defect stays fixed)', () => {
  it.each(PHANTOM_TODO_IDS)('todo_get(%s) → 404 naming that exact id + the todo_list recovery path', async (id) => {
    const err: any = await getTodo({ userId: OWNER, todoId: id }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareTodo404(id));
    // The self-describing contract (251e9329) in its two load-bearing halves:
    expect(err.message).toContain(`"${id}"`);          // which id was probed
    expect(err.message).toContain('todo_list');        // where to get a real one
  });

  it('the three texts are DISTINCT — no 3-window of this streak can be byte-identical', async () => {
    const texts: string[] = [];
    for (const id of PHANTOM_TODO_IDS) texts.push(await probe(id));
    // Pre-fix (2026-09-13) all three were 'Tool todo_get failed: Todo not found'
    // — one byte-identical member, the class PR #724 fixed. Live behaviour:
    expect(new Set(texts).size).toBe(PHANTOM_TODO_IDS.length);
    texts.forEach((t, i) => expect(t).toContain(PHANTOM_TODO_IDS[i]));
  });

  it('a NON-MEMBER gets no candidate hint — the id is echoed, nothing is disclosed', async () => {
    // The "Did you mean …" branch is gated on access; prove it, rather than
    // relying on the phantom ids having no same-prefix row at all.
    const foreign = 'deadbeef-1111-4111-8111-111111111111';
    db.todos.push(todoRow({ id: foreign, projectId: 'p2', title: 'Foreign secret todo' }));
    const err: any = await getTodo({ userId: OWNER, todoId: 'deadbeef' }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareTodo404('deadbeef'));
    expect(err.message).not.toContain('Did you mean');
    expect(err.message).not.toContain('Foreign secret todo');
  });
});

// ── B. The ladder is live — a 404 means "no such row", not "by-id broken" ────

describe('921013a5 — the read ladder resolves all four tiers a real row can be named by', () => {
  // Deliberately shares NO prefix with any ticket id: the control row proves
  // the by-id path works, without accidentally making a phantom id resolvable.
  const CONTROL_ID = '9f2c1a44-5b7e-4c3d-8a91-0d2e3f4a5b6c';

  it('control: the SAME call on a real id resolves (the by-id path was never broken)', async () => {
    db.todos.push(todoRow({ id: CONTROL_ID, title: 'Control todo' }));
    const t: any = await getTodo({ userId: OWNER, todoId: CONTROL_ID });
    expect(t.id).toBe(CONTROL_ID);
    expect(t.title).toBe('Control todo');
  });

  it('tier 1: a unique ≥8-char PREFIX resolves — and the heal tier is held OFF so only tier 1 can answer', async () => {
    // MUTATION-PROVEN: without the killer the 4th tier (suffix-heal) rescues
    // this input and the test stays green with resolveUniqueTodoPrefix deleted.
    // ID_RESOLVER_HEAL_DISABLED=1 removes that fallback, so this assertion is
    // load-bearing on tier 1 specifically.
    process.env.ID_RESOLVER_HEAL_DISABLED = '1';
    const prefixed = '7e987035-9f11-4c22-8a33-bb44cc55dd66';
    db.todos.push(todoRow({ id: prefixed, title: 'Prefixed todo' }));
    const t: any = await getTodo({ userId: OWNER, todoId: '7e987035' });
    expect(t.id).toBe(prefixed);
    // …and it came from tier 1, not from a heal (which would have logged id_ref_heal).
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'id_ref_heal' }),
    );
  });

  it('tier 2: a full-shape id with an INVENTED suffix heals to the one visible row (99ad288e/636b622b)', async () => {
    const prefixed = '7e987035-9f11-4c22-8a33-bb44cc55dd66';
    db.todos.push(todoRow({ id: prefixed, title: 'Prefixed todo' }));
    const t: any = await getTodo({ userId: OWNER, todoId: '7e987035-aaaa-bbbb-cccc-000000000000' });
    expect(t.id).toBe(prefixed);
    // Tier 2 is nearMatchFullShapeId, which reports its own kind — this proves
    // the resolution came from THAT tier and not the id-ref heal fallback.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: LOOP_METRIC_KINDS.GOAL_TODO_SUFFIX_HEALED }),
    );
  });

  it('tier 3: a unique exact TITLE resolves (operator iteration 12)', async () => {
    db.todos.push(todoRow({ id: CONTROL_ID, title: 'Ship the scrub export' }));
    const t: any = await getTodo({ userId: OWNER, todoId: 'Ship the scrub export' });
    expect(t.id).toBe(CONTROL_ID);
  });

  it('tier 4: a bare hex TAIL (not a prefix) heals via the suffix-splice resolver (id-ref.ts)', async () => {
    // CONTROL_ID hex ends …0d2e3f4a5b6c — '3f4a5b6c' is a suffix, never a
    // prefix, and is title-less, so ONLY the id-ref heal tier can answer.
    db.todos.push(todoRow({ id: CONTROL_ID, title: 'Control todo' }));
    const t: any = await getTodo({ userId: OWNER, todoId: '3f4a5b6c' });
    expect(t.id).toBe(CONTROL_ID);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'id_ref_heal',
        value: 1,
        meta: expect.objectContaining({ family: 'todo', via: 'suffix' }),
      }),
    );
    // Discriminator: with the heal switch ON this same input correctly 404s.
    process.env.ID_RESOLVER_HEAL_DISABLED = '1';
    const err: any = await getTodo({ userId: OWNER, todoId: '3f4a5b6c' }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain('"3f4a5b6c"');
  });

  it('the ticket ids are NOT prefixes of any row — tier 1 had nothing to rescue', async () => {
    // Fixture pre-check (true by construction) + the behaviour it implies: with
    // real rows present, a 404 is only possible when nothing starts with the id.
    db.todos.push(todoRow({ id: CONTROL_ID, title: 'Control todo' }));
    for (const id of PHANTOM_TODO_IDS) {
      expect(db.todos.some((t: any) => String(t.id).startsWith(id))).toBe(false);
      const err: any = await getTodo({ userId: OWNER, todoId: id }).catch((e: any) => e);
      expect(err.statusCode).toBe(404);
      expect(err.message).toBe(bareTodo404(id));
    }
  });

  it('an AMBIGUOUS prefix is refused rather than guessed', async () => {
    db.todos.push(todoRow({ id: 'aaaaaaaa-1111-4111-8111-111111111111' }));
    db.todos.push(todoRow({ id: 'aaaaaaaa-2222-4222-8222-222222222222' }));
    const err: any = await getTodo({ userId: OWNER, todoId: 'aaaaaaaa' }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain('"aaaaaaaa"');
  });
});

// ── C. Counting it is a DESIGNED GUARD (the discriminator) ───────────────────

describe('921013a5 — a genuinely nonexistent id is a REAL failure and must keep counting', () => {
  it('every one of the three texts is failure-shaped for the breaker', async () => {
    for (const id of PHANTOM_TODO_IDS) {
      const text = await probe(id);
      expect(looksLikeToolFailure(text)).toBe(true);
    }
  });

  it('DETECTOR-RECALL REPLAY — the exemption classes stay narrow; prior true positives still fire', async () => {
    // A future "todo_get 404 shouldn't count" relaxation must go RED here
    // first: a phantom id is actionable (copy a real one from todo_list), not
    // infrastructure and not a pending confirmation.
    const truePositives = [
      // The live no-hint envelope (goals.service.ts getTodoRow), verbatim shape:
      `Tool todo_get failed: Todo not found: "7e987035" — no todo with that id is visible to you. Re-call with the EXACT id copied verbatim from todo_list (never reconstruct or abbreviate an id); if the id came from another lane's claim, verify it against a fresh todo_list first`,
      // The cross-hint envelope (a real row of the WRONG type), verbatim:
      `Tool todo_get failed: Todo not found: "9f2c1a44" is a GOAL id — use goal_get / goal_update / goal_list for it, not the todo tools`,
      'Verify FAILED at "typecheck": ✗ typecheck (exit 1)',
      'COMMIT BLOCKED — evidence',
      'Opening the PR failed: 422',
      // The grep INFRA envelope's NON-[INFRA] sibling (tools.ts:2874), verbatim:
      'Tool grep failed: the search did not complete ([exit: 1]) — this is NOT a "no matches" verdict. Narrow the scope/path, or fall back to run_command with plain grep.',
    ];
    for (const tp of truePositives) expect(looksLikeToolFailure(tp)).toBe(true);

    // The exemptions that must NOT widen into this class — both quoted from
    // the emitters (platform-tools.ts staging envelope; tools.ts [INFRA] anchor).
    expect(looksLikeToolFailure(JSON.stringify({ ok: false, needsConfirmation: true, confirmationId: 'cf_1' }))).toBe(false);
    expect(looksLikeToolFailure(
      '[INFRA] Tool grep failed: the search did not complete (container unavailable) — the session shell died before git grep ran (container/exec unavailable), so this is NOT a "no matches" verdict and NOT a bad pattern or scope. Retry the SAME call; changing the pattern/scope will not help. If it persists, run_command is available.',
    )).toBe(false);
  });
});

// ── D. Pre-flight: a shaped-but-fabricated id is structurally un-refusable ───

describe('921013a5 — why the streak accumulated at 3 rather than fast-tripping at 1', () => {
  it('the three ticket ids pass the id-grounding pre-flight (8-hex citation shape), so they EXECUTE and 404', () => {
    for (const id of PHANTOM_TODO_IDS) {
      // Grounded by SHAPE alone — never a preflight refusal, never a fast-trip.
      // This is also why a wrong-but-plausible todo id can only ever accumulate
      // to the ordinary 3-failure threshold.
      expect(findUngroundedIdArgs({ todoId: id }, '')).toEqual([]);
    }
  });

  it('…while a true placeholder is still refused at dispatch — the shape rule cannot widen', () => {
    for (const v of ['noop', 'PLACEHOLDER', 'TBD', 'noop-audit-placeholder']) {
      expect(findUngroundedIdArgs({ todoId: v }, '')).toEqual([{ key: 'todoId', value: v }]);
    }
    // The VERBATIM grounding leg (non-hex values — the only values it can ever
    // catch), so this file does not imply a hex id needs to be "read" first:
    expect(findUngroundedIdArgs({ todoId: 'chan-general' }, '')).toEqual([{ key: 'todoId', value: 'chan-general' }]);
    expect(findUngroundedIdArgs({ todoId: 'chan-general' }, 'todo_list → chan-general')).toEqual([]);
  });
});

// ── E. d8395cca: the LINEAGE meta-case — a TICKET id probed as a todoId ──────
//
// Reproducing ticket 921013a5 by probing its own ids filed a second ticket of
// the same family (d8395cca). Two of its probes were the ones this file already
// covers; the NEW one is `921013a5` — the TICKET id itself, quoted from that
// ticket's "Call args" list, which a lane then spent a todo_get on.
//
// The adjudication is the same and equally unfixable: 921013a5 IS a real id, of
// a TICKET. getTodoRow (goals.service.ts:1665) looks only in projectTodo, then
// cross-hints on projectGoal — there is no ticket lookup and no ticket hint, so
// a ticket id falls straight through the whole read ladder to the bare
// self-describing 404. That is correct behaviour: the id was a citation the lane
// should have re-grounded before spending a call on it, and the reply says so.
//
// This section therefore pins the CURRENT contract so a future "an exemption for
// probe ids would stop these tickets" change goes RED here first. Silencing a
// real refusal is the class refuted on ticket d53eed71 (the loopjacking replay
// pin + the staged-args-execute case it cites); the lineage observation itself
// is a backlog note, not a code change.

describe('d8395cca — a TICKET id used as a todoId is outside the ladder and must keep counting', () => {
  // Verbatim from d8395cca's own "Call args of those failing calls" list, plus
  // the ticket id that list quotes as an ID (never as a todo id).
  const LINEAGE_PROBE_IDS = ['a930d169', '7e987035', '921013a5'] as const;

  it('todo_get(ticket id) → the bare self-describing 404, naming the id probed', async () => {
    // No todo, no goal in the fixture: nothing the ladder could rescue.
    const err: any = await getTodo({ userId: OWNER, todoId: '921013a5' }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(bareTodo404('921013a5'));
    expect(err.message).toContain('"921013a5"');   // which id was probed
    expect(err.message).toContain('todo_list');    // where a real one comes from
  });

  it('the ticket id is NOT silently cross-hinted — the ONLY hint branch is for GOAL ids', async () => {
    // The goal cross-hint (goals.service.ts:1669) is the one helpful branch a
    // ticket id might have hoped for. It fires on the goal TABLE alone, so a
    // ticket id gets the generic envelope — not a misleading "use goal_get".
    const err: any = await getTodo({ userId: OWNER, todoId: '921013a5' }).catch((e: any) => e);
    expect(err.statusCode).toBe(404);
    expect(err.message).not.toContain('is a GOAL id');
    // …and the hint that DOES exist still fires for its own family, so the
    // assertion above is about tickets, not about a dead hint. NOTE the hint
    // matches on the EXACT id (goals.service.ts:1669 — `where: { id: todoId }`,
    // no prefix resolve), so this control must pass a full id, not a prefix.
    const GOAL_ID = 'cafebabe-1111-4111-8111-111111111111';
    db.goals.push(goalRow({ id: GOAL_ID }));
    const asGoal: any = await getTodo({ userId: OWNER, todoId: GOAL_ID }).catch((e: any) => e);
    expect(asGoal.statusCode).toBe(404);
    expect(asGoal.message).toContain('is a GOAL id');
  });

  it('DETECTOR-RECALL REPLAY — every probed id still classifies as a real failure', async () => {
    // The load-bearing half: an "intentional probe" exemption would have to
    // stop these counting, and it must go RED first. A ticket id is not
    // infrastructure and not a pending confirmation.
    for (const id of LINEAGE_PROBE_IDS) {
      const text = await probe(id);
      expect(looksLikeToolFailure(text)).toBe(true);
    }
    // Distinct texts per id — the self-describing contract — so the auto-filed
    // ticket can still show WHICH ids were probed.
    const texts: string[] = [];
    for (const id of LINEAGE_PROBE_IDS) texts.push(await probe(id));
    expect(new Set(texts).size).toBe(LINEAGE_PROBE_IDS.length);
    texts.forEach((t, i) => expect(t).toContain(LINEAGE_PROBE_IDS[i]));
  });

  it('the lineage probe ids pass the pre-flight by SHAPE, exactly like the originals', () => {
    // Same structural reason it accumulated to 3 instead of fast-tripping: an
    // 8-hex citation is accepted, executes, and 404s.
    for (const id of LINEAGE_PROBE_IDS) {
      expect(findUngroundedIdArgs({ todoId: id }, '')).toEqual([]);
    }
  });
});
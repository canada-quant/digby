/**
 * Ticket 56284f30 (2026-09-19) — REPLAY: the four F-followups from the
 * independent adversarial review of ticket 973d7f80's fix (PR #881, reviewer
 * sub-session c469f570, verdict MERGE-SAFE — deliberately non-blocking
 * residuals of the cross-tenant owner-question visibility fix):
 *
 *   F1 goals.service gateQuestionVisibilityFor — the prefix fallback used a
 *      bare findFirst (no take:2 / exactly-one guard): a legacy prefix-stored
 *      gate colliding with a cross-tenant id prefix labelled ownership/status
 *      off an ARBITRARY row. Fix: findMany take:2, resolve ONLY on exactly
 *      one candidate (0 = phantom, >1 = ambiguous → both 'unmatched'),
 *      mirroring the probe path's candidates.length !== 1 guard.
 *   F2 owner-questions resolveSharedProjectOwnerQuestion(s) — gate linkage
 *      was exact-match only, so an owner_questions row linked SOLELY via a
 *      pre-guard LEGACY prefix gate (stored gateQuestionId is a ≥8-char
 *      prefix of the row's full id) stayed unmatched. Fix: startsWith scan on
 *      the row id's first 8 chars + an exact-or-prefix JS filter (a longer
 *      divergent id sharing 8 chars is rejected).
 *   F3 second-chance failure degraded silently to "unmatched" via a
 *      logger-only warn. Fix: loop_metrics counter
 *      shared_oq_second_chance_failed rides alongside the warn.
 *   F4 the second chance probed sequentially (~5 round-trips × ≤50 ids).
 *      Fix: ONE cross-tenant candidate query for the whole unmatched set.
 *
 * Plus the cosmetic extras: SharedOwnerQuestionBrief.createdAt typed Date,
 * the probe-shape helper duplication collapsed (oqIdWhereForProbe /
 * oqIdMatchesProbe), and the platform-tools no-match wording unified.
 *
 * Every test below FAILS on the pre-fix code (the F1 mislabel, the F2 missed
 * linkage, the missing metric, and N cross-tenant queries respectively) —
 * the replay property the d76750f5/be94fa64/973d7f80 suites established.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB (same harness as the 973d7f80 suite) ────────────────────
const OWNER = 'u-owner-jacob'; // project owner account
const MEMBER = 'u-member-fleet'; // member account (editor on PROJECT_ID)
const THIRD = 'u-third-party'; // unrelated account — never a member
const PROJECT_ID = 'p-nh';

const db: {
  projects: any[]; goals: any[]; todos: any[]; ownerQuestions: any[];
} = { projects: [], goals: [], todos: [], ownerQuestions: [] };

function matchRow(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (v === null) return row[k] == null;
    if (k === 'OR') return (v as any[]).some((clause) => matchRow(row, clause));
    if (v && typeof v === 'object' && 'startsWith' in v) return String(row[k] ?? '').startsWith(v.startsWith);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
}
function pick(row: any, select: any) {
  if (!select) return row;
  const out: any = {};
  for (const k of Object.keys(select)) if (select[k] === true) out[k] = row[k];
  return out;
}
const table = (getRows: () => any[]) => ({
  findUnique: jest.fn(async ({ where, select }: any) => {
    const row = getRows().find((r) => matchRow(r, where)) ?? null;
    return row ? pick(row, select) : null;
  }),
  findFirst: jest.fn(async ({ where, select }: any = {}) => {
    const row = getRows().find((r) => matchRow(r, where)) ?? null;
    return row ? pick(row, select) : null;
  }),
  findMany: jest.fn(async (args: any = {}) => {
    let out = getRows().filter((r) => matchRow(r, args.where));
    if (args.take) out = out.slice(0, args.take);
    if (args.select) out = out.map((r) => pick(r, args.select));
    return out;
  }),
});

const mockPrisma: any = {
  crossModelProject: {
    findUnique: jest.fn(async ({ where }: any) => db.projects.find((p) => p.id === where.id) ?? null),
    findMany: jest.fn(async (args: any = {}) => db.projects.filter((p) => matchRow(p, args.where))),
  },
  crossModelChat: {
    findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, userId: MEMBER })),
    update: jest.fn(async () => ({})),
  },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  projectMember: { findMany: jest.fn(async () => []) },
  projectGoal: table(() => db.goals),
  projectTodo: table(() => db.todos),
  goalDependency: { findMany: jest.fn(async () => []) },
  todoDependency: { findMany: jest.fn(async () => []) },
  ownerQuestion: table(() => db.ownerQuestions),
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
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
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: jest.fn(async () => ({ ok: true, hookEventId: 'he-1' })),
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: jest.fn(),
}));

import { gateQuestionVisibilityFor, getTodo } from './goals.service';
import { listOwnerQuestionsForUser } from './owner-questions';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';

// ── Ids ──────────────────────────────────────────────────────────────────────
const OWNER_GATE = 'oq_4694abca-4eb3-4983-b244-8ccf043073e3'; // single row, OWNER-owned
const AMB_1 = 'oq_ambig11-1111-4000-8000-111111111111'; // OWNER-owned…
const AMB_2 = 'oq_ambig12-2222-4000-8000-222222222222'; // …MEMBER-owned — a WRONG pick flips the label
const AMB_PREFIX = 'oq_ambig1'; // 9 chars — matches BOTH AMB_1 and AMB_2
const LEGACY_ROW = 'oq_legacy99-9999-4000-8000-999999999999'; // OWNER-owned, no store linkage
const LEGACY_PREFIX_STORED = 'oq_legacy99'; // 11 chars — the pre-guard storage form of LEGACY_ROW
const DIVERGENT_STORED = 'oq_legacyzz'; // shares LEGACY_ROW's first 8 chars, NOT a prefix of it
const PHANTOM = 'oq_00000000-dead-4000-8000-000000000000';

const oqRow = (id: string, over: any = {}) => ({
  id, userId: OWNER, chatId: 'c-owner-chat', status: 'open',
  question: 'PRIVATE TEXT — must never leak cross-tenant',
  goalId: null, todoId: null, createdAt: new Date('2026-09-18T20:00:00Z'),
  resolvedAt: null, ...over,
});

const todoRow = (over: any = {}) => ({
  id: 't-4501c4b0', userId: OWNER, goalId: 'g-2639cbd7', projectId: PROJECT_ID, title: 'Todo',
  status: 'blocked', blockedReason: 'Awaiting owner decision', blockKind: 'owner',
  gateQuestionId: OWNER_GATE, progressNote: null, startedAt: null, assigneeChatId: null,
  evidence: null, doneRunId: null, createdAt: null, updatedAt: null, ...over,
});
const goalRow = (over: any = {}) => ({
  id: 'g-2639cbd7', userId: OWNER, projectId: PROJECT_ID, title: 'Goal', description: '',
  status: 'blocked', blockedReason: 'Awaiting owner decision', blockKind: 'owner',
  gateQuestionId: OWNER_GATE, progressNote: null, createdByChatId: null,
  createdAt: null, updatedAt: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.projects = [{
    id: PROJECT_ID, userId: OWNER, name: 'New Hampshire', path: '/nh', parentId: null,
    members: [{ userId: MEMBER, role: 'editor' }],
  }];
  db.goals = [];
  db.todos = [];
  db.ownerQuestions = [];
});

// ── F1: gateQuestionVisibilityFor ambiguity guard (goals.service.ts) ─────────
describe('F1 — gate annotation prefix fallback gains the probe path ambiguity guard (56284f30)', () => {
  it('an ambiguous cross-tenant prefix resolves to unmatched — never an arbitrary row label', async () => {
    db.ownerQuestions = [oqRow(AMB_1, { userId: OWNER }), oqRow(AMB_2, { userId: MEMBER })];
    const r = await gateQuestionVisibilityFor(AMB_PREFIX, MEMBER);
    expect(r.gateQuestionVisibility).toBe('unmatched');
    expect(r.gateQuestionStatus).toBeNull();
    // The guard shape itself: a take: 2 findMany, not a bare findFirst.
    expect(
      (mockPrisma.ownerQuestion.findMany as jest.Mock).mock.calls
        .some(([a]: any[]) => a?.take === 2 && a?.where?.id?.startsWith === AMB_PREFIX),
    ).toBe(true);
  });

  it('the same ambiguity surfaces through getTodo as unmatched (no mislabeled ownership)', async () => {
    db.goals = [goalRow()];
    db.todos = [todoRow({ gateQuestionId: AMB_PREFIX })];
    db.ownerQuestions = [oqRow(AMB_1, { userId: OWNER }), oqRow(AMB_2, { userId: MEMBER })];
    const t = await getTodo({ userId: MEMBER, todoId: 't-4501c4b0' });
    expect(t.gateQuestionVisibility).toBe('unmatched');
    expect(t.gateQuestionStatus).toBeNull();
  });

  it('an unambiguous ≥8-char prefix still resolves to the single matching row (fallback intact)', async () => {
    db.ownerQuestions = [oqRow(OWNER_GATE)];
    const member = await gateQuestionVisibilityFor('oq_4694abca', MEMBER);
    expect(member).toEqual({ gateQuestionVisibility: 'other-member-owned', gateQuestionStatus: 'open' });
    const owner = await gateQuestionVisibilityFor('oq_4694abca', OWNER);
    expect(owner).toEqual({ gateQuestionVisibility: 'resolvable', gateQuestionStatus: 'open' });
  });

  it('a full id resolves exactly (the primary path is untouched)', async () => {
    db.ownerQuestions = [oqRow(OWNER_GATE, { status: 'answered' })];
    const r = await gateQuestionVisibilityFor(OWNER_GATE, MEMBER);
    expect(r).toEqual({ gateQuestionVisibility: 'other-member-owned', gateQuestionStatus: 'answered' });
  });

  it('a prefix matching nothing stays unmatched (true phantom)', async () => {
    db.ownerQuestions = [oqRow(OWNER_GATE)];
    const r = await gateQuestionVisibilityFor('oq_nope99', MEMBER);
    expect(r).toEqual({ gateQuestionVisibility: 'unmatched', gateQuestionStatus: null });
  });
});

// ── F2: legacy prefix-gate linkage in the shared-project second chance ───────
describe('F2 — rows linked SOLELY via a legacy prefix gate resolve in the second chance (56284f30)', () => {
  it('a todo storing a ≥8-char PREFIX of the row id links it (pre-fix: unmatched)', async () => {
    db.ownerQuestions = [oqRow(LEGACY_ROW)]; // no goalId/todoId store linkage
    db.todos = [{ id: 't-legacy-todo', projectId: PROJECT_ID, gateQuestionId: LEGACY_PREFIX_STORED }];
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: [LEGACY_ROW] });
    expect(r.unmatchedIds).toEqual([]);
    expect(r.sharedRows).toHaveLength(1);
    expect(r.sharedRows[0]).toMatchObject({
      id: LEGACY_ROW, status: 'open', ownedByOtherMember: true, goalId: null, todoId: null,
    });
    expect(r.sharedRows[0]).not.toHaveProperty('question');
  });

  it('a goal storing a prefix of the row id links it too', async () => {
    db.ownerQuestions = [oqRow(LEGACY_ROW)];
    db.goals = [{ id: 'g-legacy-goal', projectId: PROJECT_ID, gateQuestionId: LEGACY_PREFIX_STORED }];
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: [LEGACY_ROW] });
    expect(r.sharedRows.map((q) => q.id)).toEqual([LEGACY_ROW]);
  });

  it('a stored gate id that only shares the first 8 chars (divergent tail) does NOT link — stays unmatched', async () => {
    db.ownerQuestions = [oqRow(LEGACY_ROW)];
    db.todos = [{ id: 't-divergent', projectId: PROJECT_ID, gateQuestionId: DIVERGENT_STORED }];
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: [LEGACY_ROW] });
    expect(r.sharedRows).toEqual([]);
    expect(r.unmatchedIds).toEqual([LEGACY_ROW]);
  });

  it('legacy linkage still requires caller-readable access (THIRD never sees the hint)', async () => {
    db.ownerQuestions = [oqRow(LEGACY_ROW)];
    db.todos = [{ id: 't-legacy-todo', projectId: PROJECT_ID, gateQuestionId: LEGACY_PREFIX_STORED }];
    const r = await listOwnerQuestionsForUser(THIRD, { ids: [LEGACY_ROW] });
    expect(r.sharedRows).toEqual([]);
    expect(r.unmatchedIds).toEqual([LEGACY_ROW]);
  });
});

// ── F3: second-chance failure telemetry ──────────────────────────────────────
describe('F3 — a second-chance failure emits loop_metrics, not just a logger warn (56284f30)', () => {
  it('a throwing cross-tenant query degrades to unmatched AND records shared_oq_second_chance_failed', async () => {
    const base = (mockPrisma.ownerQuestion.findMany as jest.Mock).getMockImplementation();
    (mockPrisma.ownerQuestion.findMany as jest.Mock)
      .mockImplementationOnce(base!) // the caller-scoped query behaves…
      .mockImplementationOnce(async () => { throw new Error('boom-56284f30'); }); // …the second chance throws
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: ['oq_probe00'] });
    expect(r.sharedRows).toEqual([]);
    expect(r.unmatchedIds).toEqual(['oq_probe00']);
    expect(
      (recordLoopMetric as jest.Mock).mock.calls.some(([arg]: any[]) =>
        arg?.kind === LOOP_METRIC_KINDS.SHARED_OQ_SECOND_CHANCE_FAILED
        && arg?.meta?.probes === 1
        && String(arg?.meta?.error ?? '').includes('boom-56284f30')),
    ).toBe(true);
  });
});

// ── F4: the second chance is batched ─────────────────────────────────────────
describe('F4 — ONE cross-tenant candidate query covers the whole unmatched set (56284f30)', () => {
  it('three resolvable probes + one phantom cost exactly one second-chance query (pre-fix: three)', async () => {
    db.ownerQuestions = [
      oqRow('oq_batch111-1111-4000-8000-111111111111', { todoId: 'tb1' }),
      oqRow('oq_batch222-2222-4000-8000-222222222222', { todoId: 'tb2' }),
      oqRow('oq_batch333-3333-4000-8000-333333333333', { todoId: 'tb3' }),
    ];
    db.todos = [
      { id: 'tb1', projectId: PROJECT_ID, gateQuestionId: null },
      { id: 'tb2', projectId: PROJECT_ID, gateQuestionId: null },
      { id: 'tb3', projectId: PROJECT_ID, gateQuestionId: null },
    ];
    const r = await listOwnerQuestionsForUser(MEMBER, {
      ids: [
        'oq_batch111-1111-4000-8000-111111111111',
        'oq_batch222-2222-4000-8000-222222222222',
        'oq_batch333-3333-4000-8000-333333333333',
        PHANTOM,
      ],
    });
    expect(r.sharedRows).toHaveLength(3);
    expect(r.unmatchedIds).toEqual([PHANTOM]);
    const secondChanceCalls = (mockPrisma.ownerQuestion.findMany as jest.Mock).mock.calls
      .filter(([a]: any[]) => a?.where?.OR && a?.where?.userId === undefined);
    expect(secondChanceCalls).toHaveLength(1);
  });
});

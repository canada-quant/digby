/**
 * Ticket 973d7f80 (2026-09-19) — REPLAY: cross-tenant owner-question
 * visibility in SHARED projects. The New Hampshire gate flip-flop saga
 * (d76750f5 → be94fa64 → c286ba91) was powered by a VISIBILITY defect, not by
 * phantom writes:
 *
 *   - owner_questions row oq_4694abca-… was REAL (open, store-linked to the
 *     shared todo) but owned by the PROJECT OWNER's account — flagged from the
 *     owner's chat. A duplicate card oq_1fc19541-… (same ask) was flagged
 *     40 min later from the MEMBER fleet-supervisor account's chat.
 *   - list_owner_questions was scoped to the CALLING account only, so the
 *     MEMBER lane saw the owner's card as UNMATCHED ("phantom") and the OWNER
 *     supervisor saw the member's card as UNMATCHED — each side then
 *     "repaired" the shared todo's gate to the card its own tenant could
 *     resolve. Verified tug-of-war flips: 9/18 14:21Z, 9/18 20:31Z,
 *     9/19 02:28Z (owner lane), repair 9/19 08:12Z (member lane).
 *   - todo_get/goal_get rendered the bare gateQuestionId with no ownership
 *     annotation, so a lane could not tell "phantom" from "owned by another
 *     project member".
 *
 * Fix under test (both halves):
 *   A. listOwnerQuestionsForUser gives every caller-unmatched id a
 *      SHARED-PROJECT SECOND CHANCE: a row owned by another account that is
 *      linked to a project the caller can read (store linkage goalId/todoId,
 *      or gating a goal/todo there) comes back in sharedRows as METADATA
 *      (id/status/linkage — never the question text) instead of feeding a
 *      phantom misdiagnosis. No caller-readable linkage → stays unmatched
 *      (no cross-tenant existence oracle).
 *   B. getTodo/getGoal annotate the gate: gateQuestionVisibility
 *      'resolvable' (own card) | 'other-member-owned' (another account's REAL
 *      card — never re-point) | 'unmatched' (true phantom), plus
 *      gateQuestionStatus when a row exists.
 *
 * Ids below are the incident's verbatim ids (same convention as the
 * d76750f5/be94fa64 replay suites).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB (superset of the be94fa64 harness: the second chance ────
// ── reads projectTodo/projectGoal and reuses goals.service.getProjectAccess) ──
const OWNER = 'u-owner-jacob'; // project owner account (295b0680… analog)
const MEMBER = 'u-member-fleet'; // member fleet-supervisor account (076d2832… analog, EDITOR)
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

import { getGoal, getTodo } from './goals.service';
import { listOwnerQuestionsForUser } from './owner-questions';

// The incident's verbatim ids.
const OWNER_GATE = 'oq_4694abca-4eb3-4983-b244-8ccf043073e3'; // the OWNER account's REAL open card
const MEMBER_GATE = 'oq_1fc19541-1487-441a-a9c2-b7321873061a'; // the MEMBER account's duplicate card
const PHANTOM = 'oq_00000000-dead-4000-8000-000000000000'; // matches nothing anywhere

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
  db.projects = [{
    id: PROJECT_ID, userId: OWNER, name: 'New Hampshire', path: '/nh', parentId: null,
    members: [{ userId: MEMBER, role: 'editor' }], // the member lane's direct membership
  }];
  db.goals = [];
  db.todos = [];
  db.ownerQuestions = [
    // The owner's card: store-linked to the shared todo (goalId + todoId).
    {
      id: OWNER_GATE, userId: OWNER, chatId: 'c-owner-chat', status: 'open',
      question: 'PRIVATE OWNER QUESTION TEXT — must never leak cross-tenant',
      answer: null, goalId: 'g-2639cbd7', todoId: 't-4501c4b0', createdAt: new Date(Date.now() - 2000),
    },
    // The member's duplicate card: NO store linkage — it is linked to the
    // shared project ONLY by being the todo's gate (the 08:12Z flip state).
    {
      id: MEMBER_GATE, userId: MEMBER, chatId: 'c-member-chat', status: 'open',
      question: 'PRIVATE MEMBER QUESTION TEXT', answer: null, goalId: null, todoId: null,
      createdAt: new Date(Date.now() - 1000),
    },
  ];
  jest.clearAllMocks(); // clears call data only — implementations survive
});

describe('973d7f80 — listOwnerQuestionsForUser shared-project second chance', () => {
  it('REPLAY (member side): the member lane probing the OWNER card gets a metadata hit, never "unmatched"', async () => {
    db.todos.push(todoRow());
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: [OWNER_GATE] });
    expect(r.rows).toEqual([]);
    expect(r.unmatchedIds).toEqual([]);
    expect(r.sharedRows).toHaveLength(1);
    expect(r.sharedRows[0]).toMatchObject({
      id: OWNER_GATE, status: 'open', ownedByOtherMember: true,
      goalId: 'g-2639cbd7', todoId: 't-4501c4b0',
    });
    // METADATA ONLY — the question/answer text stays with the owning account.
    expect(r.sharedRows[0]).not.toHaveProperty('question');
    expect(r.sharedRows[0]).not.toHaveProperty('answer');
  });

  it('REPLAY (owner side): the owner supervisor probing the MEMBER card — linked ONLY via the todo gate — also resolves', async () => {
    // The 08:12Z flip state: the shared todo's gate points at the member card.
    db.todos.push(todoRow({ gateQuestionId: MEMBER_GATE }));
    const r = await listOwnerQuestionsForUser(OWNER, { ids: [MEMBER_GATE] });
    expect(r.rows).toEqual([]);
    expect(r.unmatchedIds).toEqual([]);
    expect(r.sharedRows).toHaveLength(1);
    expect(r.sharedRows[0]).toMatchObject({ id: MEMBER_GATE, status: 'open', ownedByOtherMember: true, todoId: null, goalId: null });
    expect(r.sharedRows[0]).not.toHaveProperty('question');
  });

  it('the ≥8-char oq_ prefix form (how lanes cite ids) resolves the shared card too', async () => {
    db.todos.push(todoRow());
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: ['oq_4694abca'] });
    expect(r.unmatchedIds).toEqual([]);
    expect(r.sharedRows.map((q) => q.id)).toEqual([OWNER_GATE]);
  });

  it('CROSS-TENANT ISOLATION: a non-member account probing the owner card still gets unmatched — no existence oracle', async () => {
    db.todos.push(todoRow());
    const r = await listOwnerQuestionsForUser(THIRD, { ids: [OWNER_GATE] });
    expect(r.rows).toEqual([]);
    expect(r.sharedRows).toEqual([]);
    expect(r.unmatchedIds).toEqual([OWNER_GATE]);
  });

  it('another account\'s card with NO caller-readable linkage (different project) stays unmatched', async () => {
    // The card is linked to a todo in a project the caller cannot read.
    db.ownerQuestions.push({
      id: 'oq_f00df00d-0000-4000-8000-foreignforeig', userId: THIRD, chatId: 'c-x', status: 'open',
      question: 'secret', answer: null, goalId: null, todoId: 't-foreign', createdAt: new Date(),
    });
    db.todos.push({ ...todoRow({ id: 't-foreign', projectId: 'p-foreign', gateQuestionId: null }) });
    // p-foreign is NOT in db.projects → getProjectAccess returns null.
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: ['oq_f00df00d-0000-4000-8000-foreignforeig'] });
    expect(r.sharedRows).toEqual([]);
    expect(r.unmatchedIds).toEqual(['oq_f00df00d-0000-4000-8000-foreignforeig']);
  });

  it('a TRUE phantom (no row for ANY account) stays unmatched — the d76750f5 class is unchanged', async () => {
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: [PHANTOM] });
    expect(r.rows).toEqual([]);
    expect(r.sharedRows).toEqual([]);
    expect(r.unmatchedIds).toEqual([PHANTOM]);
  });

  it('an ambiguous cross-tenant prefix (two different accounts share it) resolves NEITHER — no leak by collision', async () => {
    db.ownerQuestions.push({
      id: 'oq_4694abca-ffff-4000-8000-collisio000', userId: THIRD, chatId: 'c-x', status: 'open',
      question: 'collision row', answer: null, goalId: null, todoId: 't-4501c4b0', createdAt: new Date(),
    });
    db.todos.push(todoRow());
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: ['oq_4694abca'] });
    expect(r.sharedRows).toEqual([]);
    expect(r.unmatchedIds).toEqual(['oq_4694abca']);
  });

  it('the caller\'s OWN card still resolves in rows (the second chance never engages)', async () => {
    db.todos.push(todoRow({ gateQuestionId: MEMBER_GATE }));
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: [MEMBER_GATE] });
    expect(r.rows.map((q: any) => q.id)).toEqual([MEMBER_GATE]);
    expect(r.unmatchedIds).toEqual([]);
    expect(r.sharedRows).toEqual([]);
  });

  it('an answered cross-member gate shows its status — the lane sees the gate is CLEARED without touching the text', async () => {
    db.todos.push(todoRow());
    db.ownerQuestions.find((q) => q.id === OWNER_GATE)!.status = 'answered';
    const r = await listOwnerQuestionsForUser(MEMBER, { ids: [OWNER_GATE] });
    expect(r.sharedRows).toHaveLength(1);
    expect(r.sharedRows[0].status).toBe('answered');
  });
});

describe('973d7f80 — getTodo/getGoal gate visibility annotation', () => {
  it('todo_get as the MEMBER on a todo gated at the OWNER card: other-member-owned + open', async () => {
    db.todos.push(todoRow());
    const t = await getTodo({ userId: MEMBER, todoId: 't-4501c4b0' });
    expect(t.gateQuestionId).toBe(OWNER_GATE);
    expect(t.gateQuestionVisibility).toBe('other-member-owned');
    expect(t.gateQuestionStatus).toBe('open');
  });

  it('todo_get as the MEMBER on a todo gated at the MEMBER\'s OWN card: resolvable', async () => {
    db.todos.push(todoRow({ gateQuestionId: MEMBER_GATE }));
    const t = await getTodo({ userId: MEMBER, todoId: 't-4501c4b0' });
    expect(t.gateQuestionVisibility).toBe('resolvable');
    expect(t.gateQuestionStatus).toBe('open');
  });

  it('todo_get on a todo gated at a TRUE phantom: unmatched — the repair class is unchanged', async () => {
    db.todos.push(todoRow({ gateQuestionId: PHANTOM }));
    const t = await getTodo({ userId: MEMBER, todoId: 't-4501c4b0' });
    expect(t.gateQuestionVisibility).toBe('unmatched');
    expect(t.gateQuestionStatus).toBeNull();
  });

  it('todo_get on an ungated todo: both fields null', async () => {
    db.todos.push(todoRow({ gateQuestionId: null }));
    const t = await getTodo({ userId: MEMBER, todoId: 't-4501c4b0' });
    expect(t.gateQuestionVisibility).toBeNull();
    expect(t.gateQuestionStatus).toBeNull();
  });

  it('goal_get as the OWNER on a goal gated at the MEMBER card: other-member-owned', async () => {
    db.goals.push(goalRow({ gateQuestionId: MEMBER_GATE }));
    const g = await getGoal({ userId: OWNER, goalId: 'g-2639cbd7' });
    expect(g.gateQuestionVisibility).toBe('other-member-owned');
    expect(g.gateQuestionStatus).toBe('open');
  });

  it('goal_get as the MEMBER on a goal gated at the OWNER card: other-member-owned (the flip-stopper)', async () => {
    db.goals.push(goalRow());
    const g = await getGoal({ userId: MEMBER, goalId: 'g-2639cbd7' });
    expect(g.gateQuestionVisibility).toBe('other-member-owned');
    expect(g.gateQuestionStatus).toBe('open');
  });

  it('goal_get as the OWNER on a goal gated at the OWNER\'s own card: resolvable', async () => {
    db.goals.push(goalRow());
    const g = await getGoal({ userId: OWNER, goalId: 'g-2639cbd7' });
    expect(g.gateQuestionVisibility).toBe('resolvable');
    expect(g.gateQuestionStatus).toBe('open');
  });
});

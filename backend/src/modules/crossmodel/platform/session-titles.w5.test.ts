/**
 * audit 2026-10-08 W5-5 — ticket / reviewer lane titles keep their SUBJECT, and
 * a stale charter rebinds.
 *
 * REPLAY (goals.md P3): 27 of 34 ticket / reviewer lanes in 3 days ended as
 * "ticket 7cabb0cc · archived", "ticket 954b7910 · archived", "Adversarial
 * review · archived". The lane's spawn title ("ticket <id8>: <6 words of the
 * ticket title>") is its only goal half (no charter), re-read from the CURRENT
 * title on every render — and an over-budget render trimmed the GOAL half to
 * fit a long step, so every long step shaved it and "archived" never grew it
 * back. The steps below are the real prod step halves of lanes f44a89b8 /
 * bcc7d418 / 1c3b0258.
 */
const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), update: jest.fn() },
  chatCodingState: { findUnique: jest.fn(async () => ({ titleSource: 'spawn-param' })), update: jest.fn(async () => ({})) },
  projectGoal: { findUnique: jest.fn(async () => null) },
  projectTodo: { findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null) },
  agentRun: { findFirst: jest.fn(async () => null) },
};
const mockRecordLoopMetric = jest.fn();
const mockGetPlan = jest.fn((..._a: any[]): Promise<any> => Promise.resolve(null));
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { TITLE_RENDER: 'title_render' } }));
jest.mock('../coding/plan.service', () => ({ __esModule: true, getPlan: (...a: any[]) => mockGetPlan(...a) }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import {
  refreshSessionTitle, bindCharter, clipGoalWords, renderSessionTitle, splitSessionTitle, _resetTitleRateLimitForTests, TITLE_MAX_CHARS,
} from './session-titles';

let row: any;
beforeEach(() => {
  jest.clearAllMocks();
  _resetTitleRateLimitForTests();
  for (const k of ['HARNESS_TITLE_STICKY_GOAL_DISABLED', 'HARNESS_CHARTER_REBIND_DISABLED']) delete process.env[k];
  row = { id: 'lane-1', title: '', titlePinned: false, titleStep: null, charterGoalId: null, charterTodoId: null, isSupervisor: false, isProjectSupervisor: false, archivedAt: null, projectId: 'p' };
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ ...row }));
  mockPrisma.crossModelChat.update.mockImplementation(async ({ data }: any) => { Object.assign(row, data); return { ...row }; });
  mockPrisma.projectTodo.findUnique.mockResolvedValue(null);
  mockPrisma.projectGoal.findUnique.mockResolvedValue(null);
});

/** The prod step halves of three ticket lanes, then the archive render. */
const LIFE = [
  'Independent adversarial review of the diff before merge',
  'Push branch, open PR (citing finding→fix pairs in the body)',
  'PR → independent adversarial review → merge → deploy verify',
];
async function liveTheLane(spawnTitle: string): Promise<string> {
  row.title = spawnTitle;
  for (const text of LIFE) {
    mockGetPlan.mockResolvedValue({ steps: [{ id: 1, text, status: 'in_progress' }] });
    _resetTitleRateLimitForTests();
    await refreshSessionTitle('lane-1', 'plan');
  }
  _resetTitleRateLimitForTests();
  row.archivedAt = new Date();
  await refreshSessionTitle('lane-1', 'archive');
  return row.title;
}

const SPAWN = 'ticket 7cabb0cc: Phantom action claim: chat asserted action(s)'; // batchSessionTitle of the 7cabb0cc ticket

describe('REPLAY — the ratchet that ate the subject', () => {
  it('pre-fix (HARNESS_TITLE_STICKY_GOAL_DISABLED=1): long steps shave the goal half; the lane ends without its subject', async () => {
    process.env.HARNESS_TITLE_STICKY_GOAL_DISABLED = '1';
    const t = await liveTheLane(SPAWN);
    expect(splitSessionTitle(t).goal.length).toBeLessThan('ticket 7cabb0cc: Phantom action claim: chat'.length);
    expect(t.endsWith(' · archived')).toBe(true);
  });

  it('FIX: a sticky goal half is never trimmed — the STEP is cut instead, and the archived title keeps the subject', async () => {
    const t = await liveTheLane(SPAWN);
    expect(t).toBe('ticket 7cabb0cc: Phantom action claim: chat asserted action(s) · archived');
  });

  it('every intermediate title stays ≤ 80 chars with the full goal half', async () => {
    row.title = SPAWN;
    mockGetPlan.mockResolvedValue({ steps: [{ id: 1, text: LIFE[0], status: 'in_progress' }] });
    await refreshSessionTitle('lane-1', 'plan');
    expect(row.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(row.title.startsWith('ticket 7cabb0cc: Phantom action claim: chat asserted action(s) · Independent')).toBe(true);
  });
});

describe('the id label rides free of the 6-word goal budget', () => {
  it('"ticket <id8>:" / "ticket <id8> +N:" / "Review <id8>" do not count toward the 6 words', () => {
    expect(clipGoalWords('ticket 954b7910: web pipe returns the search provider own docs instead')).toBe('ticket 954b7910: web pipe returns the search provider');
    expect(clipGoalWords('ticket 954b7910 +2: Sidebar chat list jumps when a new chat lands')).toBe('ticket 954b7910 +2: Sidebar chat list jumps when'); // the dangling "a" is tidied (T8-13)
    expect(clipGoalWords('Review 59a4407b SERP provider error docs as source')).toBe('Review 59a4407b SERP provider error docs as source');
    // no id label → the plain 6-word clip
    expect(clipGoalWords('Adversarial review: miscopy tier of the verifier for ticket')).toBe('Adversarial review: miscopy tier'); // dangling "of the" tidied (T8-13)
  });
  it('kill switch restores the plain clip', () => {
    process.env.HARNESS_TITLE_STICKY_GOAL_DISABLED = '1';
    expect(clipGoalWords('ticket 954b7910: web pipe returns the search provider own docs')).toBe('ticket 954b7910: web pipe returns'); // 6 words incl. the label
  });
  it('a goal half too long for a readable step renders the goal alone (cut on a word boundary)', () => {
    const goal = 'ticket 954b7910: ' + 'Supercalifragilistic '.repeat(6).trim();
    const t = renderSessionTitle({ goal, step: 'archived', keepGoal: true });
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(t.includes(' · ')).toBe(false);
  });
});

describe('a STALE charter rebinds on the next assignment (known since 10-06)', () => {
  it('REPLAY 0037460b: charter todo 576ebb05 done 10-05 — the next assignment rebinds todo AND (closed) goal', async () => {
    row.charterTodoId = '576ebb05-0000-4000-8000-000000000000';
    row.charterGoalId = 'goal-old';
    mockPrisma.projectTodo.findUnique.mockImplementation(async ({ where }: any) => (where.id === '576ebb05-0000-4000-8000-000000000000' ? { status: 'done', goalId: 'goal-old' } : { status: 'pending', goalId: 'goal-new' }));
    mockPrisma.projectGoal.findUnique.mockImplementation(async ({ where }: any) => (where.id === 'goal-old' ? { status: 'done', title: 'Old goal' } : { status: 'active', title: 'New goal' }));
    const r = await bindCharter('lane-1', { goalId: null, todoId: 'a62eb6ce-0000-4000-8000-000000000000' });
    expect(r.bound).toBe(true);
    expect(row).toMatchObject({ charterTodoId: 'a62eb6ce-0000-4000-8000-000000000000', charterGoalId: 'goal-new' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'charter_rebind', meta: expect.objectContaining({ fromStatus: 'done', goalRebound: true }) }));
  });

  it('a LIVE charter todo keeps first-bind-wins; the kill switch keeps it even when stale', async () => {
    row.charterTodoId = 'live0001-0000-4000-8000-000000000000';
    row.charterGoalId = 'g';
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'in_progress', goalId: 'g' });
    expect((await bindCharter('lane-1', { todoId: 'other001-0000-4000-8000-000000000000' })).bound).toBe(false);
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ status: 'done', goalId: 'g' });
    process.env.HARNESS_CHARTER_REBIND_DISABLED = '1';
    expect((await bindCharter('lane-1', { todoId: 'other001-0000-4000-8000-000000000000' })).bound).toBe(false);
    expect(row.charterTodoId).toBe('live0001-0000-4000-8000-000000000000');
  });

  it('an ACTIVE charter goal is kept when only the todo rebinds', async () => {
    row.charterTodoId = 'old00001-0000-4000-8000-000000000000';
    row.charterGoalId = 'goal-live';
    mockPrisma.projectTodo.findUnique.mockImplementation(async ({ where }: any) => (where.id.startsWith('old') ? { status: 'dropped' } : { goalId: 'goal-other' }));
    mockPrisma.projectGoal.findUnique.mockResolvedValue({ status: 'active', title: 'Live goal' });
    await bindCharter('lane-1', { todoId: 'new00001-0000-4000-8000-000000000000' });
    expect(row).toMatchObject({ charterTodoId: 'new00001-0000-4000-8000-000000000000', charterGoalId: 'goal-live' });
  });
});

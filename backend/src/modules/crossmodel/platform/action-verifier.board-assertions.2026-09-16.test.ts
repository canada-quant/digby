/**
 * BOARD ASSERTION lane pins (owner 2026-09-16, "inject the board, don't let
 * the model recall it"). The 48h rollout watch caught the spark-cluster
 * project supervisor reporting owner ruling oq_bd1130d5 "still OPEN" two days
 * after the owner answered it, and "same 4 active goals" against a ledger of
 * 1. No lane audited STATUS claims — the existence lanes only ask whether an
 * id exists. This lane reads the same rows the [BOARD] block renders and
 * strikes a note whose status/open-closed claims contradict them.
 *
 * Pins: the miners (deterministic; history/conditional register skipped;
 * two-status sentences skipped), the matcher (asserted vs ledger; missing
 * rows left to the existence lanes; ids the note already claims as its own
 * action are left to the action lanes), the id-less COUNT shape convicting
 * observed-only for a PROJECT supervisor, and the computePhantomClaims
 * wiring (citation-class tag ⇒ the line strips under enforce).
 *
 * Mock discipline mirrors action-verifier.b216475a.test.ts.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import {
  framedRowStatus, mineBoardAssertions, mineBoardCountAssertions, findPhantomBoardAssertions, ledgerStatusOf, ledgerCountsForChat,
  computePhantomClaims, isCitationClassClaim, BOARD_ASSERTION_TAG, BOARD_COUNT_TAG,
} from './action-verifier';

const CHAT = 'c0e22e36-0000-4000-8000-000000000000';

describe('mineBoardAssertions — deterministic status claims per sentence', () => {
  it('reads an owner-question open claim and todo/goal status claims, one per (kind,id)', () => {
    // One claim per line: a lowercase sentence start is not a boundary for the
    // shared sentence splitter, and a todo+goal on ONE line with two statuses
    // is ambiguous for the goal (both words are goal statuses) — skipped.
    const note = [
      'Owner ruling oq_bd1130d5 is still open, so the dflash2E decision stays parked.',
      'todo 3f1c2a9b is blocked on the vendor firmware.',
      'goal 7a7a7a7a remains active.',
      'todo 3f1c2a9b is blocked (repeated).',
    ].join('\n');
    expect(mineBoardAssertions(note)).toEqual([
      expect.objectContaining({ kind: 'oq', id: 'bd1130d5', asserted: 'open' }),
      expect.objectContaining({ kind: 'todo', id: '3f1c2a9b', asserted: 'blocked' }),
      expect.objectContaining({ kind: 'goal', id: '7a7a7a7a', asserted: 'active' }),
    ]);
  });

  it('reads an answered claim and accepts full oq ids', () => {
    expect(mineBoardAssertions('oq_bd1130d5-aaaa-4000-8000-000000000000 was answered by the owner on 09-14; we proceed.')).toEqual([]); // "was" = history register, skipped
    expect(mineBoardAssertions('The owner answered oq_bd1130d5: keep dflash2E.')).toEqual([expect.objectContaining({ kind: 'oq', id: 'bd1130d5', asserted: 'answered' })]);
  });

  it('skips history, retraction and conditional registers, and sentences asserting two statuses for one row', () => {
    expect(mineBoardAssertions('oq_bd1130d5 was open last wake; it is now answered.')).toEqual([]);
    expect(mineBoardAssertions('If oq_bd1130d5 is still open tomorrow, escalate.')).toEqual([]);
    expect(mineBoardAssertions('todo 3f1c2a9b moved from blocked to in_progress.')).toEqual([]);
    expect(mineBoardAssertions('todo 3f1c2a9b: blocked, pending review of the done criteria.')).toEqual([expect.objectContaining({ asserted: 'blocked' })]); // ': blocked' is the frame; 'pending review' / 'done criteria' are prose
    expect(mineBoardAssertions('todo 3f1c2a9b: blocked → in_progress after the firmware landed.')).toEqual([]); // a transition, not a status
    expect(mineBoardAssertions('todo 3f1c2a9b is blocked on firmware; goal 7a7a7a7a remains active.')).toEqual([expect.objectContaining({ kind: 'todo', id: '3f1c2a9b', asserted: 'blocked' }), expect.objectContaining({ kind: 'goal', id: '7a7a7a7a', asserted: 'active' })]); // each row reads ITS OWN frame
    expect(mineBoardAssertions('> quoted: oq_bd1130d5 is still open')).toEqual([]);
  });

  it('a status word needs a FRAME: prepositional "pending X" / adjectival "active watch" / "done with" never assert (the tt-rd 02:54Z live strike shape)', () => {
    // the first live strike after rollout: "restamp pending <noun>" is a preposition, not the todo's status
    expect(mineBoardAssertions('todo 95f2fcf0 — S4.5 restamp pending QSA-R1 build close (next run_completed wake).')).toEqual([]);
    expect(mineBoardAssertions('todo 3f1c2a9b done with the shard-3 retrain; moving on.')).toEqual([]);
    expect(mineBoardAssertions('goal 7a7a7a7a active watch continues on the bounty thread.')).toEqual([]);
    expect(mineBoardAssertions('todo 3f1c2a9b pending review of the dataset.')).toEqual([]);
    // framed forms DO assert
    expect(mineBoardAssertions('- todo 3f1c2a9b [pending] "Write the postmortem" → unassigned')).toEqual([expect.objectContaining({ kind: 'todo', id: '3f1c2a9b', asserted: 'pending' })]);
    expect(mineBoardAssertions('todo 3f1c2a9b is pending.')).toEqual([expect.objectContaining({ asserted: 'pending' })]);
    expect(mineBoardAssertions('todo 3f1c2a9b "S4.5 SPEED" remains in_progress per todo_get this run.')).toEqual([expect.objectContaining({ asserted: 'in_progress' })]);
    expect(mineBoardAssertions('goal 7a7a7a7a is active, nothing blocked.')).toEqual([expect.objectContaining({ kind: 'goal', asserted: 'active' })]);
    expect(mineBoardAssertions('The blocked todo 3f1c2a9b still waits on firmware.')).toEqual([expect.objectContaining({ asserted: 'blocked' })]);
    expect(mineBoardAssertions('todo 3f1c2a9b is blocked on the vendor firmware drop.')).toEqual([expect.objectContaining({ asserted: 'blocked' })]);
    expect(mineBoardAssertions('todo 3f1c2a9b (done) — closed with PR #12.')).toEqual([expect.objectContaining({ asserted: 'done' })]);
    // oq: the "open question" idiom and a far-away status word are not claims about the id
    expect(mineBoardAssertions('oq_bd1130d5 raised an open question about the fallback that the lanes still debate.')).toEqual([]);
    expect(mineBoardAssertions('oq_bd1130d5 is still open.')).toEqual([expect.objectContaining({ kind: 'oq', asserted: 'open' })]);
  });

  it('framedRowStatus reads the frame relative to the row reference', () => {
    const s = 'todo 3f1c2a9b [blocked] "x" and goal 7a7a7a7a is done.';
    expect(framedRowStatus(s, 0, 13)).toBe('blocked');
    expect(framedRowStatus(s, s.indexOf('goal'), s.indexOf('7a7a7a7a') + 8)).toBe('done');
    expect(framedRowStatus('todo 3f1c2a9b pending the owner ruling', 0, 13)).toBeNull();
  });

  it('a goal sentence carrying only todo-family statuses (or vice versa) is not an assertion', () => {
    expect(mineBoardAssertions('goal 7a7a7a7a is pending an owner read.')).toEqual([]); // pending is not a goal status
    expect(mineBoardAssertions('todo 3f1c2a9b is archived in the ledger.')).toEqual([]); // archived is not a todo status
  });
});

describe('mineBoardAssertions — suspect-close cue (review fix 2026-09-27, finding 5)', () => {
  it('a sentence quoting the board\'s "⚠ suspect" badge or writing "suspect close" is the doctrine\'s prescribed phrasing and is never an assertion', () => {
    expect(mineBoardAssertions('goal a57fb2e2 [done ⚠ suspect: premise_target_unmet (target_tok_per_s ≥20tok/s, observed 5.33tok/s)] "vLLM serving ≥20 tok/s" — closed 09-16 10:00Z.')).toEqual([]);
    expect(mineBoardAssertions('goal a57fb2e2 is done ⚠ suspect — asked spark-cluster to record the measured value.')).toEqual([]);
    expect(mineBoardAssertions('goal a57fb2e2 is a suspect close: the 20 tok/s bar is not observed yet.')).toEqual([]);
    expect(mineBoardAssertions('Suspect closes this wake: goal a57fb2e2 [done] and goal f6b31f1b [done].')).toEqual([]);
  });
  it('the cue is sentence-local — the next sentence still asserts', () => {
    expect(mineBoardAssertions('goal a57fb2e2 is a suspect close.\ngoal 7a7a7a7a remains active.')).toEqual([
      expect.objectContaining({ kind: 'goal', id: '7a7a7a7a', asserted: 'active' }),
    ]);
  });
});

describe('mineBoardCountAssertions', () => {
  it('reads "N active goals", "N open todos", "N of M goals active" (one per family+qualifier)', () => {
    expect(mineBoardCountAssertions('Same 4 active goals as last sweep; 9 open todos; 2 of 9 todos blocked.')).toEqual([
      expect.objectContaining({ family: 'goal', qualifier: 'active', count: 4 }),
      expect.objectContaining({ family: 'todo', qualifier: 'open', count: 9 }),
      expect.objectContaining({ family: 'todo', qualifier: 'blocked', count: 2 }),
    ]);
    expect(mineBoardCountAssertions('3 of 4 goals active this week.')).toEqual([expect.objectContaining({ family: 'goal', qualifier: 'active', count: 3 })]);
  });
  it('skips history register', () => {
    expect(mineBoardCountAssertions('There were 4 active goals yesterday.')).toEqual([]);
  });
});

describe('findPhantomBoardAssertions — asserted vs ledger', () => {
  const statusLookup = jest.fn(async (kind: string, id: string) => {
    if (kind === 'oq' && id === 'bd1130d5') return 'answered';
    if (kind === 'todo' && id === '3f1c2a9b') return 'in_progress';
    if (kind === 'goal' && id === '7a7a7a7a') return 'active';
    return null;
  });
  const countsLookup = jest.fn(async () => ({ goals: { active: 1, done: 3 }, todos: { pending: 2, in_progress: 1, blocked: 1, done: 5 } }));
  beforeEach(() => { statusLookup.mockClear(); countsLookup.mockClear(); });

  it('convicts the oq_bd1130d5 incident shape: "still open" vs ledger answered, citation-class tagged with both statuses', async () => {
    const out = await findPhantomBoardAssertions('Owner ruling oq_bd1130d5 is still open, so the decision stays parked.', [], { chatId: CHAT, supervisorScope: 'project' }, statusLookup as any, countsLookup as any);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'oq', id: 'bd1130d5', asserted: 'open', ledger: 'answered' });
    expect(out[0].detail.startsWith(BOARD_ASSERTION_TAG)).toBe(true);
    expect(out[0].detail).toContain('asserted oq_bd1130d5 is "open"; the ledger says "answered"');
    expect(isCitationClassClaim(out[0])).toBe(true);
  });

  it('a status that MATCHES the ledger, a row that does not exist, and an id the note already claims as its own action all pass', async () => {
    const note = 'goal 7a7a7a7a remains active. todo deadbeef is blocked. todo 3f1c2a9b is blocked.';
    const out = await findPhantomBoardAssertions(note, [{ kind: 'todo', id: '3f1c2a9b', detail: 'own action' } as any], { chatId: CHAT, supervisorScope: 'project' }, statusLookup as any, countsLookup as any);
    expect(out).toEqual([]);
    expect(statusLookup).not.toHaveBeenCalledWith('todo', '3f1c2a9b');
  });

  it('convicts a todo status contradiction (blocked vs ledger in_progress)', async () => {
    const out = await findPhantomBoardAssertions('todo 3f1c2a9b is blocked on firmware.', [], { chatId: CHAT, supervisorScope: 'project' }, statusLookup as any, countsLookup as any);
    expect(out).toEqual([expect.objectContaining({ kind: 'todo', id: '3f1c2a9b', asserted: 'blocked', ledger: 'in_progress' })]);
  });

  it('count assertions convict id-less under the observed [board count] tag for a PROJECT supervisor only', async () => {
    const note = 'Same 4 active goals as last sweep; 4 open todos; 1 blocked todo.';
    const project = await findPhantomBoardAssertions(note, [], { chatId: CHAT, supervisorScope: 'project' }, statusLookup as any, countsLookup as any);
    expect(project).toEqual([expect.objectContaining({ kind: 'board', asserted: '4', ledger: '1' })]); // goals 4≠1; todos 4=4; blocked 1=1
    expect(project[0].id).toBeUndefined();
    expect(project[0].detail.startsWith(BOARD_COUNT_TAG)).toBe(true);
    expect(isCitationClassClaim(project[0])).toBe(false);
    const fleet = await findPhantomBoardAssertions(note, [], { chatId: CHAT, supervisorScope: 'fleet' }, statusLookup as any, countsLookup as any);
    expect(fleet).toEqual([]);
    expect(countsLookup).toHaveBeenCalledTimes(1);
  });

  it('a lookup failure fails toward MISS', async () => {
    const out = await findPhantomBoardAssertions('oq_bd1130d5 is still open.', [], { chatId: CHAT, supervisorScope: 'project' }, (async () => { throw new Error('db'); }) as any, countsLookup as any);
    expect(out).toEqual([]);
  });
});

describe('ledger lookups', () => {
  beforeEach(() => { for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) fn.mockClear(); });

  it('ledgerStatusOf folds owner-question statuses to open|answered and prefixes oq_', async () => {
    mockPrisma.ownerQuestion.findFirst.mockResolvedValueOnce({ status: 'dismissed' });
    expect(await ledgerStatusOf('oq', 'bd1130d5')).toBe('answered');
    expect(mockPrisma.ownerQuestion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { startsWith: 'oq_bd1130d5' } } }));
    mockPrisma.ownerQuestion.findFirst.mockResolvedValueOnce(null);
    expect(await ledgerStatusOf('oq', 'bd1130d5')).toBeNull();
    mockPrisma.projectTodo.findFirst.mockResolvedValueOnce({ status: 'in_progress' });
    expect(await ledgerStatusOf('todo', '3f1c2a9b')).toBe('in_progress');
    mockPrisma.projectGoal.findFirst.mockRejectedValueOnce(new Error('db'));
    expect(await ledgerStatusOf('goal', '7a7a7a7a')).toBeNull();
  });

  it('ledgerCountsForChat returns null for a non-project-supervisor chat and folds groupBy rows otherwise', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ projectId: 'p1', isProjectSupervisor: false });
    expect(await ledgerCountsForChat(CHAT)).toBeNull();
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ projectId: 'p1', isProjectSupervisor: true });
    mockPrisma.projectGoal.groupBy.mockResolvedValueOnce([{ status: 'active', _count: { _all: 1 } }, { status: 'done', _count: { _all: 3 } }]);
    mockPrisma.projectTodo.groupBy.mockResolvedValueOnce([{ status: 'pending', _count: { _all: 2 } }]);
    expect(await ledgerCountsForChat(CHAT)).toEqual({ goals: { active: 1, done: 3 }, todos: { pending: 2 } });
  });
});

describe('computePhantomClaims wiring — the board lane rides the main path', () => {
  beforeEach(() => { for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) fn.mockClear(); });

  it('a project-supervisor note asserting an answered ruling is still open convicts under [board assertion]', async () => {
    mockPrisma.ownerQuestion.findFirst.mockResolvedValue({ status: 'answered' });
    const out = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', parts: [], receipts: [],
      finalText: 'Sweep complete. Owner ruling oq_bd1130d5 is still open, so the dflash2E fallback stays parked until the owner rules.',
      supervisor: true, supervisorScope: 'project', machineTriggered: true, runStartedAt: new Date('2026-09-16T07:00:00.000Z'),
    });
    const board = out.phantoms.filter((p) => p.kind === 'oq');
    expect(board).toEqual([expect.objectContaining({ id: 'bd1130d5', asserted: 'open', ledger: 'answered' })]);
    expect(board[0].detail.startsWith(BOARD_ASSERTION_TAG)).toBe(true);
    expect(isCitationClassClaim(board[0])).toBe(true);
  });

  it('the same note passes when the ledger agrees', async () => {
    mockPrisma.ownerQuestion.findFirst.mockResolvedValue({ status: 'open' });
    const out = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', parts: [], receipts: [],
      finalText: 'Owner ruling oq_bd1130d5 is still open; nothing to do until it lands.',
      supervisor: true, supervisorScope: 'project', machineTriggered: true, runStartedAt: new Date('2026-09-16T07:00:00.000Z'),
    });
    expect(out.phantoms.filter((p) => p.kind === 'oq')).toEqual([]);
  });
});

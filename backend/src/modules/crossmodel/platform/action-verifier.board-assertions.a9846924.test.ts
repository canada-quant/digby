/**
 * MISHAP REPLAY — ticket a9846924 (2026-10-07): a project supervisor's
 * machine-wake note asserted oq_4f3d7dde was OPEN ("1 open owner question",
 * "the one manual sign-in … remains the fallback") while the ledger said
 * ANSWERED — but the owner's answer landed MID-RUN: the supervisor run's
 * first tool receipt (list_chats) is 01:43:58.203Z, its own get_chat_status
 * ran 01:44:17.678Z, the [Owner inbox] answer message is timestamped
 * 01:44:19.669Z, and the guard's strike is 01:46:03Z. The [BOARD] block was
 * rendered at run start (row still open). The note was struck (strip+mark)
 * and the auto-filed mishap ticket asserted the lane "mis-stated board STATE
 * from memory" — with zero transition-timing evidence: resolvedAt
 * (01:44:19.669Z) proves the row changed INSIDE the run's own window, after
 * every sanctioned in-run source could have read it.
 *
 * Distinguished from f8fc93be (2026-09-27): that lane NEVER probed (the
 * status rode a 16-minute-old peer relay) and the strike was kept
 * correct-by-design with NO carve-out. THIS incident's transition is proven
 * mid-run by harness-stamped resolvedAt — the race tier below.
 *
 * Pins (mock discipline mirrors action-verifier.board-assertions.2026-09-16.test.ts):
 *   1. THE REPLAY: runStartedAt before resolvedAt ⇒ the open assertion is
 *      EXONERATED (no strike) — the note's status was true when the model
 *      could have read it.
 *   2. The pre-run-answer shape (f8fc93be class): resolvedAt BEFORE
 *      runStartedAt ⇒ still strikes — the lane could have read the answer;
 *      no laundering of a stale assertion through the race tier.
 *   3. Absent runStartedAt (pre-fix callers) ⇒ unchanged: still strikes.
 *   4. oq-only: a todo status contradiction is never race-exonerated (no
 *      transition stamp exists for todo rows).
 *   5. ledgerTransitionAt reads resolvedAt and returns null for open rows /
 *      todo / goal kinds (fail-open to the pre-fix verdict).
 *   6. list_owner_questions (the probe the guard's correction advice names)
 *      is receipt-visible: PLATFORM_OBSERVE_TOOLS carries it, so the probe
 *      mints a run_tool_receipt row an adjudicator can see (the incident's
 *      probe was receipt-invisible — indistinguishable from recall).
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import { findPhantomBoardAssertions, ledgerTransitionAt, ledgerStatusOf, isCitationClassClaim, BOARD_ASSERTION_TAG } from './action-verifier';
import { PLATFORM_OBSERVE_TOOLS } from '../coding/evidence-tools';
import { RECEIPT_TOOLS } from '../coding/run-receipts';

const CHAT = '41bd202a-0000-4000-8000-000000000000';
const OQ = '4f3d7dde';

// The incident's struck sentence, near-verbatim (the ticket's detail quote):
// the Board line with the oq id in the fallback/gated mentions, near "1 open
// owner question" — the sentence the guard actually convicted. The bullet
// carries the claimed fresh probe (reworded without the conditional "if"
// that trips the history guard — the register skips conditionals by design).
const NOTE = [
  '**Board:** 2 active goals (a8c755c8, f543f095) · 2 open todos both blocked — bf3514e9 external (gate oq_4f3d7dde as fallback), 6c43a055 owner-gated on oq_4f3d7dde · 1 open owner question.',
  'Owner question **oq_4f3d7dde**: OPEN (fresh probe — filed 01:11:35Z by chat bb8f1073) — the one manual sign-in on emulator-5554 remains the fallback.',
].join('\n');

// The harness-stamped facts of the race (all quoted from tool results on the
// incident): run start precedes the first receipt 01:43:58.203Z; the owner
// answer message is 01:44:19.669Z; the guard struck at 01:46:03Z.
const RUN_STARTED = new Date('2026-10-07T01:43:50.000Z');
const ANSWERED_AT = new Date('2026-10-07T01:44:19.669Z');
const PRE_RUN_ANSWER = new Date('2026-10-07T00:30:00.000Z');

describe('a9846924 — mid-run owner answer raced the note (replay)', () => {
  beforeEach(() => {
    mockPrisma.ownerQuestion.findFirst.mockReset();
    mockPrisma.projectTodo.findFirst.mockReset();
  });

  it('1. THE REPLAY: run started BEFORE resolvedAt ⇒ the open assertion is EXONERATED, no strike', async () => {
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ select }: any) => {
      if (select?.resolvedAt) return { status: 'answered', resolvedAt: ANSWERED_AT };
      return { status: 'answered' };
    });
    const strikes = await findPhantomBoardAssertions(NOTE, [], { chatId: CHAT, supervisorScope: 'project', runStartedAt: RUN_STARTED });
    expect(strikes).toHaveLength(0);
  });

  it('2. the f8fc93be shape: resolvedAt BEFORE run started ⇒ still strikes (the lane could have read the answer)', async () => {
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ select }: any) => {
      if (select?.resolvedAt) return { status: 'answered', resolvedAt: PRE_RUN_ANSWER };
      return { status: 'answered' };
    });
    const strikes = await findPhantomBoardAssertions(NOTE, [], { chatId: CHAT, supervisorScope: 'project', runStartedAt: RUN_STARTED });
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ kind: 'oq', id: OQ, asserted: 'open', ledger: 'answered' });
    expect(isCitationClassClaim(strikes[0])).toBe(true);
  });

  it('3. absent runStartedAt (pre-fix callers) ⇒ unchanged: still strikes', async () => {
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async () => ({ status: 'answered', resolvedAt: ANSWERED_AT }));
    const strikes = await findPhantomBoardAssertions(NOTE, [], { chatId: CHAT, supervisorScope: 'project' });
    expect(strikes).toHaveLength(1);
    expect(strikes[0].detail.startsWith(BOARD_ASSERTION_TAG)).toBe(true);
  });

  it('4. oq-only: a todo contradiction is NEVER race-exonerated (no transition stamp exists)', async () => {
    mockPrisma.projectTodo.findFirst.mockResolvedValue({ status: 'in_progress' });
    const todoNote = 'todo 3f1c2a9b is blocked on the vendor firmware.';
    const raced = await findPhantomBoardAssertions(todoNote, [], { chatId: CHAT, supervisorScope: 'project', runStartedAt: RUN_STARTED });
    expect(raced).toHaveLength(1);
    expect(raced[0]).toMatchObject({ kind: 'todo', id: '3f1c2a9b', asserted: 'blocked', ledger: 'in_progress' });
  });

  it('5. ledgerTransitionAt: answered rows carry resolvedAt; open rows, todos and goals return null', async () => {
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ select }: any) => {
      if (select?.resolvedAt) return { status: 'answered', resolvedAt: ANSWERED_AT };
      return { status: 'answered' };
    });
    await expect(ledgerTransitionAt('oq', OQ)).resolves.toEqual(ANSWERED_AT);
    mockPrisma.ownerQuestion.findFirst.mockResolvedValue({ status: 'open', resolvedAt: null });
    await expect(ledgerTransitionAt('oq', OQ)).resolves.toBeNull();
    await expect(ledgerTransitionAt('todo', '3f1c2a9b')).resolves.toBeNull();
    await expect(ledgerTransitionAt('goal', '7a7a7a7a')).resolves.toBeNull();
    // ledgerStatusOf keeps its shape (status only)
    mockPrisma.ownerQuestion.findFirst.mockResolvedValue({ status: 'answered' });
    await expect(ledgerStatusOf('oq', OQ)).resolves.toBe('answered');
  });

  it('6. a transition-lookup failure fails open: the strike stands (never launder a phantom through a DB hiccup)', async () => {
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ select }: any) => {
      if (select?.resolvedAt) throw new Error('db');
      return { status: 'answered' };
    });
    const strikes = await findPhantomBoardAssertions(NOTE, [], { chatId: CHAT, supervisorScope: 'project', runStartedAt: RUN_STARTED });
    expect(strikes).toHaveLength(1);
  });

  it('7. list_owner_questions is now receipt-visible: in PLATFORM_OBSERVE_TOOLS and RECEIPT_TOOLS', () => {
    expect(PLATFORM_OBSERVE_TOOLS.has('list_owner_questions')).toBe(true);
    expect(RECEIPT_TOOLS.has('list_owner_questions')).toBe(true);
  });

  it('8. GENERALIZATION — a mixed two-oq note: only the mid-run-resolved id is exonerated, the pre-run-resolved id still strikes', async () => {
    // A shape the incident never had: two owner questions on one board line,
    // one resolved DURING the run (raced) and one resolved an hour BEFORE it
    // (f8fc93be class). Pins that the racedIds set is per-id — the exoneration
    // of one oq never launders the other's conviction.
    const mixedNote = [
      '**Board:** 2 active goals (a8c755c8, f543f095) · 2 open todos both blocked — bf3514e9 external (gate oq_4f3d7dde as fallback), 6c43a055 owner-gated on oq_9c1d2e3f · 2 open owner questions.',
      'Owner question **oq_4f3d7dde**: OPEN (fresh probe — filed 01:11:35Z by chat bb8f1073) — the one manual sign-in on emulator-5554 remains the fallback.',
      'Owner question **oq_9c1d2e3f**: still open, so the scale-out decision stays parked.',
    ].join('\n');
    const EARLIER_ANSWER = new Date('2026-10-07T00:30:00.000Z');
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ where, select }: any) => {
      const id = String(where?.id?.startsWith ?? '').replace('oq_', '');
      if (select?.resolvedAt) {
        if (id.startsWith('4f3d7dde')) return { status: 'answered', resolvedAt: ANSWERED_AT };
        if (id.startsWith('9c1d2e3f')) return { status: 'answered', resolvedAt: EARLIER_ANSWER };
        return null;
      }
      if (id.startsWith('4f3d7dde') || id.startsWith('9c1d2e3f')) return { status: 'answered' };
      return null;
    });
    const strikes = await findPhantomBoardAssertions(mixedNote, [], { chatId: CHAT, supervisorScope: 'project', runStartedAt: RUN_STARTED });
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ kind: 'oq', id: '9c1d2e3f', asserted: 'open', ledger: 'answered' });
    expect(strikes.some((s: any) => s.id === '4f3d7dde')).toBe(false); // the raced id is exonerated
  });
});


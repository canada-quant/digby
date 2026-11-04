/**
 * REPLAY (ticket e4138a3d, 2026-09-26 00:14Z) — the CQL LiteLLM Gateway
 * project supervisor's machine-wake note was strip+mark CONVICTED on an
 * honest, future-intent line:
 *
 *   "**Next:** the 00:25Z sweep (sched 9fd4425a) or the roster lane's
 *    run_completed checks the deploy landing → todos 00110286/88e8e247 close
 *    on receipts → goal 00ec236b done-check → ow"
 *
 * The line asserted NOTHING — "done-check" is a compound NOUN ("run the
 * done-check next"), part of a **Next:** plan chain. Two defects convicted it:
 *
 * 1. framedRowStatus's after-id regex matched the status word `done` inside
 *    `done-check` (\b passes at a hyphen) and STATUS_TAIL_OK's punctuation
 *    class accepted the trailing '-', so the compound noun parsed as an
 *    asserted present-tense status "done" vs the real ledger status "active".
 *    Every cited id was REAL (goal 00ec236b exists, todos 00110286/88e8e247
 *    exist, sched 9fd4425a exists — all verified at fix time), yet the strike
 *    filed as "cited id(s) do not exist … invented from memory".
 * 2. The ticket/correction/notice prose is class-hardcoded: a board-status
 *    strike (row EXISTS, status contradicts) got the existence-fabrication
 *    wording on every surface — misfiling the mishap in triage and teaching
 *    the lane the exact opposite lesson (its ids were fine; only a status
 *    re-read was needed).
 *
 * This file replays BOTH halves: the parser no longer reads hyphen compounds
 * as statuses, and a pure board-status strike files under its own bucket with
 * truthful prose. Mock discipline mirrors action-verifier.board-assertions.2026-09-16.test.ts.
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
const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a) }));
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import {
  framedRowStatus, mineBoardAssertions, findPhantomBoardAssertions,
  computePhantomClaims, guardMachineWakeFinalAnswer,
  isCitationClassClaim, allCitationClassClaims, isBoardStatusClaim, allBoardStatusClaims,
  BOARD_ASSERTION_TAG,
} from './action-verifier';

const CHAT = 'c6941c11-0000-4000-8000-000000000000'; // the convicted supervisor chat's prefix
const GOAL = '00ec236b'; // REAL row: status 'active' (project 2d554c9e, CQL LiteLLM Gateway)
const T1 = '00110286';
const T2 = '88e8e247';
const SCHED = '9fd4425a';

// The convicted line, verbatim shape (arrows, the **Next:** lead, the
// done-check noun, the truncated "→ ow" tail — as the ticket excerpt renders it).
const CONVICTED_LINE = `**Next:** the 00:25Z sweep (sched ${SCHED}) or the roster lane's run_completed checks the deploy landing → todos ${T1}/${T2} close on receipts → goal ${GOAL} done-check → owner close-out note`;

beforeEach(() => {
  jest.clearAllMocks();
  mockUtilityChat.mockResolvedValue('{"claims":[]}');
  mockPrisma.projectGoal.findFirst.mockResolvedValue({ status: 'active' }); // the REAL ledger status
  mockPrisma.projectTodo.findFirst.mockResolvedValue({ status: 'pending' });
  mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: 'sched-row' }); // sched 9fd4425a exists
});

describe('e4138a3d — hyphen compounds are NOUNS, never statuses (the parser half)', () => {
  it('the convicted line itself: "goal 00ec236b done-check" asserts NO status', () => {
    // Pre-fix this returned 'done' — \b passed at the hyphen and STATUS_TAIL_OK
    // accepted '-', so the future-intent compound noun "done-check" read as an
    // asserted present-tense status.
    expect(mineBoardAssertions(CONVICTED_LINE)).toEqual([]);
  });

  it('framedRowStatus: a hyphen compound after the id is never a status frame', () => {
    // idEnd = the end of the row reference ("goal 00ec236b"); nounIdx = the
    // noun's position. Computed, never hand-counted.
    const frame = (s: string) => framedRowStatus(s, s.indexOf('goal') >= 0 ? s.indexOf('goal') : s.indexOf('todo'), s.indexOf(GOAL) >= 0 ? s.indexOf(GOAL) + GOAL.length : s.indexOf(T1) + T1.length);
    expect(frame(`goal ${GOAL} done-check → owner close-out`)).toBeNull();
    expect(frame(`todo ${T1} pending-review note landed`)).toBeNull();
    expect(frame(`goal ${GOAL} active-watch continues`)).toBeNull();
    expect(frame(`goal ${GOAL} blocked-on-firmware, no change`)).toBeNull();
  });

  it('plain status frames still convict — the fix is narrow', () => {
    const frame = (s: string) => framedRowStatus(s, s.indexOf('goal'), s.indexOf(GOAL) + GOAL.length);
    // A real status word at a real frame still parses (regression guard).
    expect(frame(`goal ${GOAL} is done.`)).toBe('done');
    expect(frame(`goal ${GOAL} remains active.`)).toBe('active');
    // An em-dash tail after a status word is still a status (only '-word'
    // compounds are rejected).
    expect(frame(`goal ${GOAL} done — the deploy landed`)).toBe('done');
  });

  it('the full matcher exonerates the convicted line end-to-end (goal row real, status active)', async () => {
    // The real board lane: no assertion mined → no ledger probe → no conviction.
    const out = await findPhantomBoardAssertions(CONVICTED_LINE, [], { chatId: CHAT, supervisorScope: 'project' });
    expect(out).toEqual([]);
  });

  it('a TRUE contradiction still convicts under [board assertion] (control)', async () => {
    // Control: the same real goal id with a GENUINE status contradiction
    // ("done" at a plain frame vs ledger "active") still convicts — the fix
    // does not blind the lane.
    const out = await findPhantomBoardAssertions(`Board state: goal ${GOAL} is done, all three todos landed.`, [], { chatId: CHAT, supervisorScope: 'project' });
    expect(out).toEqual([expect.objectContaining({ kind: 'goal', id: GOAL, asserted: 'done', ledger: 'active' })]);
    expect(out[0].detail.startsWith(BOARD_ASSERTION_TAG)).toBe(true);
  });
});

describe('e4138a3d — board-status-only strikes get truthful prose (the class-prose half)', () => {
  const boardOnly = { kind: 'goal' as const, id: GOAL, asserted: 'done', ledger: 'active', detail: `${BOARD_ASSERTION_TAG} Board state: goal ${GOAL} is done — asserted goal ${GOAL} is "done"; the ledger says "active"` };
  const existenceClaim = { kind: 'message' as const, detail: '[evidence citation] paused per owner (msg ffffffffffff)', id: 'ffffffff' };

  it('isBoardStatusClaim / allBoardStatusClaims classify the two strike classes apart', () => {
    expect(isBoardStatusClaim(boardOnly)).toBe(true);
    expect(isCitationClassClaim(boardOnly)).toBe(true); // board assertions stay enforcement-eligible
    expect(allBoardStatusClaims([boardOnly])).toBe(true);
    expect(allBoardStatusClaims([boardOnly, existenceClaim])).toBe(false); // mixed with existence
    expect(isBoardStatusClaim(existenceClaim)).toBe(false);
    expect(allBoardStatusClaims([])).toBe(false);
  });

  it('the pre-delivery guard exonerates the convicted note wholesale (replay of the 00:14Z strike)', async () => {
    // Replay: the supervisor note whose line was strip+mark convicted. With the
    // parser fix, the whole note audits CLEAN — no strip, no ticket, no
    // correction — the honest line reaches the thread verbatim.
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: CONVICTED_LINE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, supervisorScope: 'project', runStartedAt: new Date('2026-09-26T00:14:00Z'),
    });
    expect(res.struck).toBe(false);
    expect(res.finalText).toBe(CONVICTED_LINE); // delivered unmodified
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('a true board-status strike files under the board bucket with truthful prose (previously misfiled as id fabrication)', async () => {
    // Replay the MISFILING half: a real-goal status contradiction files under
    // its own title, and no surface says the id "does not exist".
    mockPrisma.projectGoal.findFirst.mockResolvedValue({ status: 'active' });
    const note = `Board state: goal ${GOAL} is done, all three todos landed.`;
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, supervisorScope: 'project', runStartedAt: new Date('2026-09-26T00:14:00Z'),
    });
    expect(res.struck).toBe(true);
    expect(res.phantoms).toHaveLength(1);
    expect(allBoardStatusClaims(res.phantoms as any)).toBe(true);
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    // OWN bucket — NOT the "cited id(s) do not exist" fabrication title.
    expect(ticket.title).toBe(`Supervisor board-status assertion contradicts the ledger (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.description).toContain('asserted board status(es) that CONTRADICT the ledger');
    expect(ticket.description).not.toContain('DO NOT EXIST');
    expect(ticket.description).not.toContain('exist nowhere');
    expect(ticket.description).not.toContain('invented from memory');
    // The correction teaches the board lesson, not the id-fabrication lesson.
    expect(res.correction).toContain('CONTRADICT the ledger');
    expect(res.correction).not.toContain('DO NOT EXIST');
    expect(res.correction).toContain('BOARD-STATUS errors');
    // The owner-facing notice stays truthful too.
    expect(res.notice).toContain('every cited id is REAL');
    expect(res.notice).not.toContain('DO NOT EXIST');
  });

  it('a true existence fabrication still gets the fabrication prose (control)', async () => {
    // Control: an id that exists NOWWHERE still files as id fabrication —
    // the new bucket must not swallow the true-fabrication class.
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null); // the cited msg row does not exist
    const note = `Reinstall paused per owner ([msg:ffff8888-0000-4000-8000-000000000000]), toggle pending.`;
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, supervisorScope: 'project', runStartedAt: new Date('2026-09-26T00:14:00Z'),
    });
    expect(res.struck).toBe(true);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.title).toBe(`Supervisor fabricated evidence citation: cited id(s) do not exist (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.description).toContain('DO NOT EXIST');
  });

  it('a mixed strike (board status + fabricated id) keeps the fabrication prose for the whole strike', async () => {
    // A board assertion co-riding a fabricated id is NOT board-status-only —
    // the existence conviction's prose governs the strike (the pre-existing
    // any-action-class-keeps-the-framing doctrine, mirrored here).
    mockPrisma.projectGoal.findFirst.mockResolvedValue({ status: 'active' });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    const note = [
      `Board state: goal ${GOAL} is done, all three todos landed.`,
      `Also paused per owner ([msg:ffff8888-0000-4000-8000-000000000000]), toggle pending.`,
    ].join('\n');
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, supervisorScope: 'project', runStartedAt: new Date('2026-09-26T00:14:00Z'),
    });
    expect(res.struck).toBe(true);
    expect(allBoardStatusClaims(res.phantoms as any)).toBe(false); // mixed
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.title).toBe(`Supervisor fabricated evidence citation: cited id(s) do not exist (chat ${CHAT.slice(0, 8)})`);
  });
});


// audit 2026-10-08 W1-4: this suite pins the strip+mark / full-replacement delivery — now the
// OWNER_NOTE_NO_EDIT_DISABLED=1 kill-switch path (the default delivers the note as written + an
// observe-only annotation; action-verifier.owner-note-no-edit.test.ts pins that).
beforeAll(() => { process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1'; });
afterAll(() => { delete process.env.OWNER_NOTE_NO_EDIT_DISABLED; });

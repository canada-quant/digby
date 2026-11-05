/**
 * MISHAP REPLAY — ticket 35c3ecb0 (2026-10-18): a project supervisor's
 * machine-wake note asserted owner card oq_d201955d "is answered and folded
 * onto the card, receipt-backed" — while the ledger said OPEN. The receipt
 * the note leaned on was its OWN send_chat_message receipt, which read
 * "queued pos 1" (the Fleet Supervisor had not processed the reconciliation
 * yet); the Fleet actually folded/superseded the card 78 seconds AFTER the
 * note (18:59:26Z vs note 18:58:08Z), and the delivery run made NO
 * list_owner_questions pull. The action-verifier board-assertion lane struck
 * the line citation-class (asserted answered, ledger open) — CORRECT by
 * design, with NO carve-out: the a9846924 race tier is one-directional
 * (ledgerTransitionAt returns null for an open row, so an asserted-answered
 * conviction can never ride it).
 *
 * Distinguished from f8fc93be (stale status from an earlier wake / peer
 * relay) and a9846924 (truthful open assertion raced by a mid-run owner
 * answer): THIS lane's error is asserting the RECIPIENT's downstream fold of
 * its own just-queued send as a completed board fact. Fix = doctrine rule
 * board.sent-not-landed (a send receipt proves the send, never the fold),
 * landed via recordLesson — pinned below.
 *
 * Pins (mock discipline mirrors action-verifier.board-assertions.f8fc93be.test.ts):
 *   1. THE REPLAY: the incident head sentence asserts answered against an
 *      OPEN ledger ⇒ citation-class strike (strips under enforce) — the
 *      strike was correct, no exoneration applies.
 *   2. Race-tier one-directionality on THIS specimen: even with
 *      runStartedAt set (the tier armed), an asserted-answered vs open row
 *      has no transition stamp ⇒ STILL strikes — the a9846924 tier can never
 *      launder an asserted-answered conviction.
 *   3. The honest head the note SHOULD have led with — "sent … (receipt …,
 *      queued pos 1)" — mines NO status assertion at all: reporting your own
 *      send + its queued state is not a board-status claim and never strikes.
 *   4. The note's own honest tail line ("stays open until the owner picks A
 *      or B") asserts open against an open ledger ⇒ no strike — the same
 *      note already carried the correct status one paragraph later.
 *   5. The doctrine rule landed and renders in the project-tier core
 *      doctrine (the layer the project supervisor's composed prompt carries).
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

import { readFileSync } from 'fs';
import { join } from 'path';
import { findPhantomBoardAssertions, ledgerTransitionAt, isCitationClassClaim } from './action-verifier';
import { coreDoctrine } from './core-doctrine';

const CHAT = '590d604e-0000-4000-8000-000000000000';
const OQ = 'd201955d';

// The incident's struck head line, near-verbatim (the ticket's detail quote;
// the note's own ACTIONS section recorded the send as "queued pos 1").
const INCIDENT_HEAD = "**spark-cluster** 11:57 AM PDT (18:57Z) — Fleet's reconciliation ask on owner card oq_d201955d is answered and folded onto the card, receipt-backed from the archived lane's own records";

// The honest head the note should have led with (its own ACTIONS line shape):
// own send + receipt + the queue position — no board-status assertion at all.
const HONEST_SEND_HEAD = 'Reconciliation sent to Fleet Supervisor for folding onto owner card oq_d201955d (receipt 2b2dc246, queued pos 1)';

// The note's own tail line, near-verbatim: the correct status, one paragraph later.
const HONEST_TAIL = "(the open fork card oq_d201955d is Fleet's, stays open until the owner picks A or B)";

// The harness-stamped facts: the delivery run started before the note
// (the Fleet's reconciliation ask arrived 18:47:25Z; the note is 18:58:08Z).
const RUN_STARTED = new Date('2026-10-18T18:47:30.000Z');

describe('35c3ecb0 — own queued send asserted as the recipient\'s landed fold (replay)', () => {
  beforeEach(() => {
    mockPrisma.ownerQuestion.findFirst.mockReset();
  });

  it('1. THE REPLAY: the incident head asserts answered against an OPEN ledger ⇒ citation-class strike', async () => {
    const strikes = await findPhantomBoardAssertions(INCIDENT_HEAD, [], {}, async () => 'open');
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ kind: 'oq', id: OQ, asserted: 'answered', ledger: 'open' });
    expect(strikes[0].detail).toContain('asserted oq_d201955d is "answered"');
    expect(strikes[0].detail).toContain('the ledger says "open"');
    expect(isCitationClassClaim(strikes[0])).toBe(true);
  });

  it('2. race-tier one-directionality: runStartedAt set, ledger still open ⇒ STILL strikes (no transition stamp exists to ride)', async () => {
    // The real ledgerTransitionAt, served by the mocked row: an OPEN row has
    // no resolvedAt ⇒ null ⇒ no mid-run-transition exoneration is possible.
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async ({ select }: any) => {
      if (select?.resolvedAt) return { status: 'open', resolvedAt: null };
      return { status: 'open' };
    });
    const strikes = await findPhantomBoardAssertions(
      INCIDENT_HEAD, [],
      { chatId: CHAT, supervisorScope: 'project', runStartedAt: RUN_STARTED },
    );
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ kind: 'oq', id: OQ, asserted: 'answered', ledger: 'open' });
    // the oq-transition probe really ran (the tier was armed, not skipped)
    expect(await ledgerTransitionAt('oq', OQ)).toBeNull();
  });

  it('3. the honest head — own send + receipt + queued position — mines NO board assertion and never strikes', async () => {
    const strikes = await findPhantomBoardAssertions(HONEST_SEND_HEAD, [], {}, async () => 'open');
    expect(strikes).toHaveLength(0);
  });

  it('4. the note\'s own honest tail ("stays open until the owner picks") asserts open against an open ledger ⇒ no strike', async () => {
    const strikes = await findPhantomBoardAssertions(HONEST_TAIL, [], {}, async () => 'open');
    expect(strikes).toHaveLength(0);
  });

  it('5. the doctrine rule landed: board.sent-not-landed is in the evidence section and renders in the project-tier core doctrine', () => {
    const core = readFileSync(join(__dirname, 'core-doctrine.ts'), 'utf8');
    expect(core).toContain('(rule board.sent-not-landed)');
    // Section scoping is asserted against the RENDERED doctrine (the raw file's
    // first '## Evidence rules' hit is the CORE_SECTION_ANCHORS map, not the
    // literal — a file-text indexOf guard would pass with the rule misplaced).
    // In the rendered core the sections appear in order: standing → scope →
    // gate → evidence → task lifecycle, each exactly once.
    const rendered = coreDoctrine('project');
    const evidenceAt = rendered.indexOf('## Evidence rules');
    const ruleAt = rendered.indexOf('(rule board.sent-not-landed)');
    const lifecycleAt = rendered.indexOf('## Task lifecycle');
    expect(evidenceAt).toBeGreaterThan(-1);
    expect(lifecycleAt).toBeGreaterThan(evidenceAt);
    expect(ruleAt).toBeGreaterThan(evidenceAt);
    expect(ruleAt).toBeLessThan(lifecycleAt);
    // and the project supervisor's composed prompt renders the rule
    expect(rendered).toContain('A receipt for your own send proves only that YOU sent');
  });
});

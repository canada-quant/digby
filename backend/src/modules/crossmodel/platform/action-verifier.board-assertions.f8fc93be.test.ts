/**
 * MISHAP REPLAY — ticket f8fc93be (2026-09-27): a project supervisor's wake
 * asserted oq_3458f265 was OPEN ("per this-wake list_owner_questions… both
 * lanes are correctly gated on the owner") when the owner had ANSWERED it
 * 23 seconds before delivery (resolvedAt 20:57:07.221Z vs note 20:57:30.650Z);
 * the status rode a Fleet Supervisor relay pulled at 20:41Z — the delivery
 * run's receipts show NO fresh owner-question status pull between 20:42 and
 * 21:07. The action verifier struck + stripped the line pre-delivery.
 *
 * Pins (mock discipline mirrors action-verifier.board-assertions.2026-09-16.test.ts):
 *   1. THAT EXACT SENTENCE SHAPE strikes citation-class when the ledger says
 *      answered — the strike was correct-by-design (NO carve-out added).
 *   2. The same sentence against a still-open ledger ⇒ no strike (a lane that
 *      pulled fresh was right when it pulled).
 *   3. The doctrine rule landed: core-doctrine.ts evidence section carries
 *      board.fresh-status-at-compose (re-read load-bearing status at compose
 *      time — never carry it across wakes or from a peer relay).
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

import { readFileSync } from 'fs';
import { join } from 'path';
import { findPhantomBoardAssertions, isCitationClassClaim } from './action-verifier';

const INCIDENT_SENTENCE = '20:57Z — Fresh probes this rewrite: oq_3458f265 (fleet-filed 20:07Z, Command A+ re-provision fork) is OPEN per this-wake list_owner_questions; the Option A lane (chat cba0dfe9) is RUNNING with generation complete at 1395/1395 rows, and both lanes are correctly gated on the owner while it stands open.';

describe('f8fc93be — stale board status struck at delivery (replay)', () => {
  it('the incident sentence asserts open against an answered ledger ⇒ citation-class strike', async () => {
    const strikes = await findPhantomBoardAssertions(INCIDENT_SENTENCE, [], {}, async () => 'answered');
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ kind: 'oq', id: '3458f265', asserted: 'open', ledger: 'answered' });
    expect(strikes[0].detail).toContain('asserted oq_3458f265 is "open"');
    expect(isCitationClassClaim(strikes[0])).toBe(true);
  });
  it('the same sentence with the ledger still open ⇒ NO strike (the lane was right when it pulled fresh)', async () => {
    const strikes = await findPhantomBoardAssertions(INCIDENT_SENTENCE, [], {}, async () => 'open');
    expect(strikes).toHaveLength(0);
  });
  it('the doctrine rule landed: core-doctrine evidence section carries board.fresh-status-at-compose', () => {
    const core = readFileSync(join(__dirname, 'core-doctrine.ts'), 'utf8');
    expect(core).toContain('board.fresh-status-at-compose');
    expect(core).toContain('same run that delivers the note');
  });
});

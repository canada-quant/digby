/**
 * audit 2026-10-08 W5-1b — the action verifier's mishap ticket carries a
 * SHAPE-ONLY line (claim kinds + cited ids + the harness head, never chat
 * text), which feedback.service stores instead of the description when the
 * chat's account is not an admin (feedback/harness-ticket.ts).
 *
 * DETECTOR-RECALL REPLAY (audit 2026-10-08 W5-3): this PR touches
 * platform/action-verifier.ts (the ticket's shape line only — no detection
 * logic), so it replays the verifier's PRIOR true positives below — the
 * convicting cases of action-verifier.7cabb0cc.test.ts (the laundering /
 * anchor / platform-dispatch / F1 guards) — and asserts they STILL convict.
 *
 * All text is SYNTHETIC (W5-1c).
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a) }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { verifyRunActionClaimsAsync, computePhantomClaims } from './action-verifier';

const CHAT = '0c0ffee0-5a5a-4b4b-8c8c-000000000005';
const PRIVATE = 'the historical-dating claims and the battery-chemistry research';
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => { jest.clearAllMocks(); });

describe('the mishap ticket carries a shape-only line (W5-1b)', () => {
  it('a convicted claim files with shapeDescription = harness head + claim kinds + cited ids — no note text', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: `I dispatched both council colleagues on ${PRIVATE}`, id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' }] }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: `Update: I dispatched both council colleagues on ${PRIVATE} (session a1b2c3d4).`, parts: [], receipts: [], machineTriggered: false, councilDispatched: true });
    for (let i = 0; i < 6; i++) await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const arg: any = mockFileFeedbackTicket.mock.calls[0][0];
    expect(arg.description).toContain(PRIVATE); // the full description is unchanged (an admin's chat keeps it)
    expect(arg.shapeDescription).not.toContain(PRIVATE);
    expect(arg.shapeDescription).toContain('claimed actions its tool log never executed');
    expect(arg.shapeDescription).toContain('Claim shape: [dispatch] cites a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    expect(arg.shapeDescription).toContain('executed consequential actions this run: NONE');
    expect(arg.context).toMatchObject({ verifier: 'action-verifier', sessionId: CHAT });
  });
});

// DETECTOR-RECALL REPLAY: the verifier's prior true positives still convict.
describe('DETECTOR-RECALL REPLAY — prior true positives of the action verifier still fire', () => {
  const convicts = async (claim: { kind: string; detail: string; id?: string }, text: string, councilDispatched = false) => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [claim] }) as never);
    const comp = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: text, parts: [], receipts: [], machineTriggered: false, councilDispatched });
    return comp.phantoms.length;
  };
  it.each([
    ['laundering guard: a council claim citing an id', { kind: 'dispatch', detail: 'I dispatched both council colleagues', id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' }, 'I dispatched both council colleagues (session a1b2c3d4).', true],
    ['platform dispatch with no execution', { kind: 'dispatch', detail: 'I dispatched two workers to investigate the spike' }, 'I dispatched two workers to investigate the spike.', true],
    ['a filed ticket with an exhaustion excuse', { kind: 'ticket', detail: 'I filed the ticket and ran out of time before recording its id' }, 'I filed the ticket and ran out of time before recording its id.', false],
    ['a phantom schedule riding a council noun', { kind: 'schedule', detail: 'I scheduled the council review for 6pm' }, 'I scheduled the council review for 6pm tonight.', true],
  ])('%s', async (_name, claim, text, council) => {
    expect(await convicts(claim as any, text as string, council as boolean)).toBe(1);
  });
});

/**
 * REPLAY PIN — ticket d78f477b-34a6-44ad-b32e-15c7a91a98fa (mishap, 2026-09-09):
 * "Phantom action claim: chat asserted action(s) never executed (chat 089fb613)".
 *
 * The mishap: a USER-ANCHORED plain-chat turn in chat
 * 089fb613-7ac6-4c04-b108-9f9acfcec727 answered "ok i want you to go to
 * optcgsim.com on the browser and download the newest macos version" with a
 * note asserting "the browser task did dispatch to your Mac's local browser
 * with instructions to go to optcgsim.com, find the newest macOS build, and
 * download it" — while the run's tool log held NO browser_task (or any other
 * consequential) call. The post-delivery verifier convicted the phantom and
 * filed the ticket, but the pre-delivery guard is machine-wake-only
 * (chat-agent.service.ts) and the in-thread correction lane was gated on
 * machineTriggered (action-verifier.ts) — so the human was left believing a
 * download might be sitting in ~/Downloads, and NOTHING in the thread ever
 * corrected the false claim.
 *
 * The fix: verifyRunActionClaimsAsync's user-facing lane now posts an
 * ASSISTANT-role retraction naming the convicted claim(s) — never a
 * machine-authored 'user' row (the ae085617 objection: a bubble the human
 * never typed), so it renders as Digby correcting itself and lands in the
 * next turn's conversation history as the model's own retraction.
 *
 * Mock discipline mirrors action-verifier.test.ts: config/database and every
 * transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a),
}));

const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import { verifyRunActionClaimsAsync, USER_FACING_CORRECTION_BANNER } from './action-verifier';

// 2026-10-04 (owner): the post-delivery lane is OBSERVE-ONLY on human chats by default — no user-visible
// correction row. These pins assert the posted retraction, i.e. the ACTION_VERIFIER_ENFORCE=1 path.
const __prevEnforce = process.env.ACTION_VERIFIER_ENFORCE;
beforeAll(() => { process.env.ACTION_VERIFIER_ENFORCE = '1'; });
afterAll(() => { if (__prevEnforce === undefined) delete process.env.ACTION_VERIFIER_ENFORCE; else process.env.ACTION_VERIFIER_ENFORCE = __prevEnforce; });


const flush = () => new Promise((r) => setImmediate(r));
// The mishap's real chat id — the filed ticket title must read true against it.
const CHAT = '089fb613-7ac6-4c04-b108-9f9acfcec727';

// Verbatim phantom claim from the ticket (the action-verifier's own extraction).
const PHANTOM_DETAIL = "the browser task did dispatch to your Mac's local browser with instructions to go to optcgsim.com, find the newest macOS build, and download it";
// Verbatim opening of the delivered note (chat 089fb613, msg 2026-09-09T11:31:12Z).
const MISHAP_NOTE = `Straight status: ${PHANTOM_DETAIL} — but the task **timed out (~150s) before reporting back**, so I have no confirmation of what happened on screen. I can't claim a version, file name, or completed download because I never received the result.`;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('ticket d78f477b replay — user-facing phantom claims are retracted IN-THREAD', () => {
  it('REPLAYS the mishap: the 089fb613 dispatch phantom now files the ticket AND posts an assistant-role retraction naming the claim', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: PHANTOM_DETAIL }],
    }) as never);
    // No browser_task (or any other) tool call in the run — exactly as the
    // verifier found the real turn ("Executed consequential actions: NONE").
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: [], receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush();

    // (a) The deduped mishap ticket still files, reading true against the real one.
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe('Phantom action claim: chat asserted action(s) never executed (chat 089fb613)');
    expect(ticket.area).toBe('fleet-integrity');
    expect(ticket.description).toContain('[dispatch]');
    expect(ticket.description).toContain('NONE');

    // (b) THE FIX: an ASSISTANT-role retraction lands in the human's visible
    // thread, naming the convicted claim — pre-fix this create never happened
    // and the user was left believing the phantom (the mishap's core harm).
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const correction = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(correction.chatId).toBe(CHAT);
    expect(correction.role).toBe('assistant');
    expect(correction.content).toContain(USER_FACING_CORRECTION_BANNER);
    expect(correction.content).toContain('did NOT actually run');
    expect(correction.content).toContain('optcgsim.com'); // the phantom claim is NAMED
    expect(correction.content).toContain('NOT done');
    expect(correction.metadata).toMatchObject({ origin: 'machine', verifier: 'action-verifier' });
  });

  it('the user-facing correction is NEVER a machine-authored user row (the ae085617 objection — a bubble the human never typed)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: PHANTOM_DETAIL }],
    }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: [], receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush();

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    for (const call of mockPrisma.crossModelMessage.create.mock.calls) {
      expect(call[0].data.role).not.toBe('user');
    }
  });

  it('a citation-class user-facing phantom retracts with the fabricated-EVIDENCE wording (not the action wording)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'message', detail: '[evidence citation] msg deadbeef-0000-1111-2222-333344445555 cited as proof the dispatch landed' }],
    }) as never);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null); // cited id exists nowhere
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1',
      finalText: 'It dispatched — msg deadbeef-0000-1111-2222-333344445555 proves it.',
      parts: [], receipts: [], machineTriggered: false,
    });
    await flush(); await flush(); await flush();

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const correction = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(correction.role).toBe('assistant');
    expect(correction.content).toContain('cited reference id(s) that DO NOT EXIST');
    expect(correction.content).toContain('fabricated, not observed');
    expect(correction.content).not.toContain('did NOT actually run');
  });

  it('the machine-triggered lane is UNCHANGED: a user-role row with orchestration advice for the next wake', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: PHANTOM_DETAIL }],
    }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: [], receipts: [], machineTriggered: true });
    await flush(); await flush(); await flush();

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const correction = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(correction.role).toBe('user');
    expect(correction.content).toContain('Your last status note claimed action(s) that did NOT execute');
    expect(correction.content).not.toContain(USER_FACING_CORRECTION_BANNER);
    expect(correction.metadata).toMatchObject({ origin: 'machine', verifier: 'action-verifier' });
  });

  it('a clean user-facing turn (no action claims) stays silent — no ticket, no correction', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: 'Happy to help — let me know how the download hunt goes.', parts: [], receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockGetSupervisorState).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });
});

describe('2026-10-04 — observe-only on human chats (owner)', () => {
  it('by default a human-chat phantom files the ticket but posts NO user-visible correction row', async () => {
    const prev = process.env.ACTION_VERIFIER_ENFORCE;
    delete process.env.ACTION_VERIFIER_ENFORCE;
    try {
      mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'I started a coding session to fix it' }] }) as never);
      verifyRunActionClaimsAsync({ chatId: 'chat-obs', userId: 'u-1', finalText: 'Done — I started a coding session to fix it.', parts: [], receipts: [], machineTriggered: false });
      for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
      expect(mockFileFeedbackTicket).toHaveBeenCalled();
      expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ACTION_VERIFIER_ENFORCE; else process.env.ACTION_VERIFIER_ENFORCE = prev;
    }
  });
});

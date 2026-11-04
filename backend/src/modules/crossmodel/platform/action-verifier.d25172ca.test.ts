/**
 * REPLAY PIN — ticket d25172ca-bbbc-45e8-9cd7-23758e205e1e (mishap,
 * 2026-09-16T22:47:28Z): "Phantom action claim: chat asserted action(s) never
 * executed (chat 66311e6d)".
 *
 * The mishap was a FALSE POSITIVE. Chat 66311e6d-719e-4cce-b758-899aa12fa973's
 * re-queued run (msg bfdd537b, 2026-09-16T22:47:26Z) opened its answer with
 * "Telegram notification delivered to @codoublez." — and the action verifier
 * convicted it ("Executed consequential actions this run: NONE"), posted the
 * in-thread correction "…nothing was dispatched, sent, filed, downloaded, or
 * executed", and filed the mishap ticket. The prod parts log (queried via SSM
 * the same evening) tells the opposite story: the run DID call notify_user and
 * Telegram ACCEPTED the delivery —
 *   { "ok": true, "tool": "notify_user", "channel": "telegram",
 *     "deliveredTo": "@codoublez", "chars": 402 }
 * The claim was TRUE; the correction was the only false statement in the
 * thread (the user's notification really had landed two seconds earlier).
 *
 * Root cause — THREE stacked blindnesses, all deterministic:
 *   1. notify_user was absent from TRACKED_CONSEQUENTIAL_TOOLS
 *      (executed-actions.ts), so extractExecutedActions(parts) never surfaced
 *      its execution — and notify_user mints NO run-receipt (RECEIPT_TOOLS is
 *      the consequential-platform allowlist), so parts were its only evidence.
 *   2. The executed-pool ternary picked its lane on `input.receipts`
 *      truthiness — and an EMPTY receipts array is truthy, so the parts lane
 *      was skipped for every run with zero receipted executions (the chat
 *      lane passes `receipts ?? []`).
 *   3. KIND_TOOLS.message = ['send_chat_message'] — a "Telegram notification
 *      delivered" claim (extracted as message-kind on the 'delivered' cue)
 *      had no tool that could ever vouch for it.
 *
 * The fix: notify_user joins TRACKED_CONSEQUENTIAL_TOOLS and
 * KIND_TOOLS.message, and buildExecutedPool UNIONS receipts with parts-parsed
 * executions (receipts stay authoritative per-tool; the tool-name filter
 * keeps the lanes disjoint — no double count).
 *
 * Mock discipline mirrors action-verifier.d78f477b.test.ts: config/database
 * and every transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import { verifyRunActionClaimsAsync, computePhantomClaims, USER_FACING_CORRECTION_BANNER } from './action-verifier';
import { extractExecutedActions } from './executed-actions';

// 2026-10-04 (owner): the post-delivery lane is OBSERVE-ONLY on human chats by default — no user-visible
// correction row. These pins assert the posted retraction, i.e. the ACTION_VERIFIER_ENFORCE=1 path.
const __prevEnforce = process.env.ACTION_VERIFIER_ENFORCE;
beforeAll(() => { process.env.ACTION_VERIFIER_ENFORCE = '1'; });
afterAll(() => { if (__prevEnforce === undefined) delete process.env.ACTION_VERIFIER_ENFORCE; else process.env.ACTION_VERIFIER_ENFORCE = __prevEnforce; });


const flush = () => new Promise((r) => setImmediate(r));
// The mishap's real chat id — the filed ticket title must read true against it.
const CHAT = '66311e6d-719e-4cce-b758-899aa12fa973';

// Verbatim claim line + note from the incident message (msg bfdd537b,
// 2026-09-16T22:47:26Z — as quoted in the filed ticket).
const CLAIM_DETAIL = 'Telegram notification delivered to @codoublez.';
const MISHAP_NOTE = `${CLAIM_DETAIL}\n\n**Summary of this re-queued run:** The original answer was lost to the platform deploy at 21:43Z; this fresh run recovered the council's gathered data from session memory, pulled the live Rate 1500 tariff figures ($6.07/kW demand, 10.86¢/kWh energy), confirmed fresh B300 rental rates, and delivered the complete financial model above: **~250 DGX B300s (2,000 GPUs) in a 4.9 MW facility, ~$182-216M CAD all-in, base-case $92M EBITDA with ~2-year payback, and break-even at ~25-30% utilization** — with a recommended $22-25M phased pilot instead of a full commitment.`;

// The run's REAL notify_user execution, verbatim from the prod parts log
// (crossmodel_messages.parts of msg bfdd537b, read via SSM 2026-09-16T22:5xZ).
const NOTIFY_RESULT_OK = JSON.stringify({ ok: true, tool: 'notify_user', channel: 'telegram', deliveredTo: '@codoublez', chars: 402 }, null, 1);
const NOTIFY_CALL_ARGS = { message: 'Your 5 MW buildout estimate is ready — full model, returns and break-even in chat.' };
const PARTS_WITH_NOTIFY: any[] = [
  { type: 'tool_call', name: 'search_memory', args: { query: 'council data' } },
  { type: 'tool_result', name: 'search_memory', result: 'results' },
  { type: 'tool_call', name: 'notify_user', args: NOTIFY_CALL_ARGS },
  { type: 'tool_result', name: 'notify_user', result: NOTIFY_RESULT_OK },
];
const PARTS_WITHOUT_NOTIFY: any[] = [
  { type: 'tool_call', name: 'search_memory', args: { query: 'council data' } },
  { type: 'tool_result', name: 'search_memory', result: 'results' },
];
const PARTS_WITH_NOTIFY_REFUSAL: any[] = [
  { type: 'tool_call', name: 'notify_user', args: NOTIFY_CALL_ARGS },
  { type: 'tool_result', name: 'notify_user', result: JSON.stringify({ ok: false, tool: 'notify_user', reason: 'telegram_not_linked', guidance: 'The user has no linked Telegram… Do NOT claim a notification was sent.' }, null, 1) },
];

const extractMessageClaim = () =>
  JSON.stringify({ claims: [{ kind: 'message', detail: CLAIM_DETAIL }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('ticket d25172ca replay — a REAL notify_user delivery must never be struck phantom', () => {
  it('REPLAYS the mishap inputs: truthful "Telegram notification delivered" + own-run notify_user ok → NO ticket, NO correction (pre-fix: both fired)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractMessageClaim() as never);
    // receipts: [] — the truthy-empty-array shape the chat lane always passes
    // (chat-agent.service.ts `receipts: result.receipts ?? []`). The incident
    // run took the USER-facing lane (machineTriggered falsy — an agent-sent
    // re-queue drain, per the assistant-role correction in the transcript).
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: PARTS_WITH_NOTIFY, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    // THE FIX: the claim was TRUE — the verifier stays silent. Pre-fix this
    // pair fired: the deduped mishap ticket + the in-thread "nothing was
    // executed" correction (the only false statement in the incident thread).
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('phantom direction still convicts: the SAME claim with NO notify_user in the run files the ticket + posts the correction (the incident behavior, preserved)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractMessageClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: PARTS_WITHOUT_NOTIFY, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe('Phantom action claim: chat asserted action(s) never executed (chat 66311e6d)');
    expect(ticket.area).toBe('fleet-integrity');
    expect(ticket.description).toContain('[message]');
    expect(ticket.description).toContain(CLAIM_DETAIL);

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const correction = mockPrisma.crossModelMessage.create.mock.calls[0][0] as any;
    expect(correction.data.role).toBe('assistant');
    expect(correction.data.content).toContain(USER_FACING_CORRECTION_BANNER);
    expect(correction.data.content).toContain(CLAIM_DETAIL);
  });

  it('a REFUSED notify_user (telegram_not_linked, ok:false) is not a delivery — the claim still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractMessageClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: PARTS_WITH_NOTIFY_REFUSAL, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });
});

describe('ticket d25172ca — executed-pool UNION semantics (buildExecutedPool)', () => {
  it('unions receipts with parts-only executions without double-counting a receipt-covered tool', async () => {
    // One REAL send_chat_message (receipt + its parts pair — the same
    // execution visible in both channels) plus one notify_user ok (parts
    // only). Three id-less message claims compete for exactly TWO slots.
    const SEND_RESULT = JSON.stringify({ ok: true, tool: 'send_chat_message', ids: { chatId: 'c0e22e36-0000-0000-0000-000000000000' } }, null, 1);
    const parts: any[] = [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'c0e22e36', content: 'update' } },
      { type: 'tool_result', name: 'send_chat_message', result: SEND_RESULT },
      { type: 'tool_call', name: 'notify_user', args: NOTIFY_CALL_ARGS },
      { type: 'tool_result', name: 'notify_user', result: NOTIFY_RESULT_OK },
    ];
    const receipts: any[] = [{
      id: 'rcpt-1', chatId: CHAT, runId: 'run-1', tool: 'send_chat_message', ok: true,
      ids: { chatId: 'c0e22e36-0000-0000-0000-000000000000' }, inputHash: null, outputHash: null, createdAt: new Date(),
    }];
    const note = 'Telegram notification delivered to @codoublez. Messaged the fleet supervisor with the update. Pinged the project lane with the weekly summary.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [
        { kind: 'message', detail: 'Telegram notification delivered to @codoublez.' },
        { kind: 'message', detail: 'Messaged the fleet supervisor with the update.' },
        { kind: 'message', detail: 'Pinged the project lane with the weekly summary.' },
      ],
    }) as never);

    const out = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: note, parts, receipts });

    // The pool holds each real execution EXACTLY once: the receipt covers
    // send_chat_message (its parts twin is filtered out), notify_user rides
    // in from parts — 2 entries, not 3.
    expect(out.executed.map((a) => a.tool).sort()).toEqual(['notify_user', 'send_chat_message']);
    expect(out.executed.every((a) => a.ok)).toBe(true);
    // Two slots vouch two claims; the third convicts — slot accounting intact.
    expect(out.phantoms).toHaveLength(1);
    expect(out.phantoms[0].detail).toBe('Pinged the project lane with the weekly summary.');
  });
});

describe('ticket d25172ca — extractExecutedActions now surfaces notify_user', () => {
  it('pairs a notify_user call with its ok envelope (executed)', () => {
    const out = extractExecutedActions(PARTS_WITH_NOTIFY);
    const notify = out.filter((a) => a.tool === 'notify_user');
    expect(notify).toHaveLength(1);
    expect(notify[0].ok).toBe(true);
    expect(notify[0].staged).toBe(false);
  });

  it('a refusal envelope is NOT an execution', () => {
    const out = extractExecutedActions(PARTS_WITH_NOTIFY_REFUSAL);
    const notify = out.filter((a) => a.tool === 'notify_user');
    expect(notify).toHaveLength(1);
    expect(notify[0].ok).toBe(false);
  });
});

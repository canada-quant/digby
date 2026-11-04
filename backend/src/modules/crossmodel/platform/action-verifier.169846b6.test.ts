/**
 * REPLAY PIN — ticket 169846b6-d0b4-4b09-912f-a018d682c2d7 (mishap, filed
 * 2026-09-27T18:56:15Z): "Phantom action claim: chat asserted action(s) never
 * executed (chat b9cd2f21)".
 *
 * The mishap was a FALSE POSITIVE — the d25172ca class (an untracked
 * consequential tool whose ONLY execution evidence is the MessagePart log).
 * Chat b9cd2f21-0c9e-44dd-984f-b1f73afbf73a (assistant msg e87286da,
 * 2026-09-27T18:56:14Z) told the user "Sent ✅ — the test email just went out
 * from your CQL Gmail (paul@example.com) to paul@example.com" — and the claim was TRUE.
 * The run's own parts (crossmodel_messages.parts, read from prod via SSM the
 * same evening) show THREE email attempts in order:
 *   1. send_email_as_digby  → {ok:false, reason:'not_configured'}
 *   2. gmail_send_email (label 'paul@example.com') → {ok:false, reason:'label_not_found'}
 *   3. gmail_send_email (label 'CQL') → {ok:true, account:'CQL',
 *      message:'1a0e43973e3cca6c'} — the real Gmail send (gmail_search
 *      confirms message 1a0e43973e3cca6c landed 18:56:05Z, nine seconds
 *      BEFORE the claim).
 * The action verifier convicted anyway ("Executed consequential actions this
 * run: NONE"), filed THIS ticket, and posted the user-facing correction
 * "nothing was dispatched, sent, filed, downloaded, or executed" — the
 * correction was the only false statement in the thread, and it is what
 * prompted the owner to re-request the send (with SMTP credentials) one turn
 * later.
 *
 * Root cause — deterministic, the d25172ca stack again:
 *   1. gmail_send_email / send_email_as_digby were absent from
 *      TRACKED_CONSEQUENTIAL_TOOLS (executed-actions.ts), so the parts lane
 *      never surfaced the real send — and neither tool mints a run-receipt
 *      (RECEIPT_TOOLS is the consequential-platform allowlist), so parts were
 *      their ONLY execution evidence.
 *   2. KIND_TOOLS.message = ['send_chat_message', 'notify_user'] — an
 *      email-send claim had no tool that could ever vouch for it.
 *   3. The extractor prompt had no email category.
 *
 * The fix (the d25172ca pattern — vocabulary and pool move in lockstep):
 * both email tools join TRACKED_CONSEQUENTIAL_TOOLS and KIND_TOOLS.message,
 * and the extractor prompt names the email category. Their envelopes parse
 * via the existing parseResult JSON path: googleWriteEnvelope
 * ({ok, tool, account, ids, message}) for gmail_send_email; account-tools
 * j()/refuse() ({ok, tool, to, from, messageId, …}) for send_email_as_digby.
 * Refusals carry ok:false and stay non-executions; gmail_create_draft is
 * deliberately NOT tracked (a draft is not a send — the machine-run fallback
 * path must never vouch a "sent" claim).
 *
 * Mock discipline mirrors action-verifier.d25172ca.test.ts: config/database
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

import { verifyRunActionClaimsAsync, USER_FACING_CORRECTION_BANNER } from './action-verifier';
import { extractExecutedActions } from './executed-actions';

// 2026-10-04 (owner): the post-delivery lane is OBSERVE-ONLY on human chats by default — no user-visible
// correction row. These pins assert the posted retraction, i.e. the ACTION_VERIFIER_ENFORCE=1 path.
const __prevEnforce = process.env.ACTION_VERIFIER_ENFORCE;
beforeAll(() => { process.env.ACTION_VERIFIER_ENFORCE = '1'; });
afterAll(() => { if (__prevEnforce === undefined) delete process.env.ACTION_VERIFIER_ENFORCE; else process.env.ACTION_VERIFIER_ENFORCE = __prevEnforce; });


const flush = () => new Promise((r) => setImmediate(r));
// The mishap's real chat id — the filed ticket title must read true against it.
const CHAT = 'b9cd2f21-0c9e-44dd-984f-b1f73afbf73a';

// Verbatim claim line + note from the incident message (msg e87286da,
// 2026-09-27T18:56:14Z — as quoted in the filed ticket).
const CLAIM_DETAIL = 'the test email just went out from your **CQL Gmail** (paul@example.com) to paul@example.com';
const MISHAP_NOTE = `Sent ✅ — ${CLAIM_DETAIL}, subject "Digby email test — checking the send pipeline". Check your inbox.\n\nOne catch I hit: Digby's own sender address (digby@digby.example.com) isn't configured on your instance — it needs SMTP credentials (\`DIGBY_SMTP_USER\`/\`DIGBY_SMTP_PASS\`) set by the instance owner. So for now I email you via your Gmail accounts, which works fine.`;

// The run's REAL email executions, verbatim from the prod parts log
// (crossmodel_messages.parts of msg e87286da, read via SSM 2026-09-27).
const DIGBY_REFUSED = JSON.stringify({ ok: false, tool: 'send_email_as_digby', reason: 'not_configured', message: 'Digby email is not configured on this instance: set DIGBY_SMTP_USER and DIGBY_SMTP_PASS (Gmail workspace SMTP — see docs/EMAIL_AS_DIGBY.md). Nothing was sent; do not claim an email went out. Nothing was sent — do not claim an email went out.' });
const GMAIL_LABEL_REFUSED = JSON.stringify({ ok: false, tool: 'gmail_send_email', reason: 'label_not_found', ids: {}, message: 'No connected Google account matches \\"paul@example.com\\". Connected accounts: Personal, Work, Recovery Institute of Ohio, CQL. Pass the bare label or the email address.' });
const GMAIL_CQL_OK = JSON.stringify({ ok: true, tool: 'gmail_send_email', account: 'CQL', ids: {}, message: '1a0e43973e3cca6c' });
const DIGBY_ARGS = { to: 'paul@example.com', text: "Hi Paul,\n\nTesting the email pipeline — if you're reading this, it works end to end.\n\nI send from digby@digby.example.com. I can use this for anything you ask me to email you: digests, alerts, monitor results, or scheduled reports.\n\n— Digby", subject: 'Digby email test — yes, I can send these' };
const GMAIL_ARGS_1 = { to: 'paul@example.com', body: "Hi Paul,\n\nTesting that Digby can send you email — if this lands in your inbox, it works.\n\nThis one came from your Gmail (paul@example.com). Note: Digby's own sender (digby@digby.example.com) isn't configured on your instance yet — it needs SMTP credentials set. Your Gmail route works fine for now.\n\n— Digby", label: 'paul@example.com', subject: 'Digby email test — checking the send pipeline' };
const GMAIL_ARGS_2 = { to: 'paul@example.com', body: "Hi Paul,\n\nTesting that Digby can send you email — if this lands in your inbox, it works.\n\nThis one came from your CQL Gmail. Note: Digby's own sender (digby@digby.example.com) isn't configured on your instance yet — it needs SMTP credentials set. Your Gmail route works.\n\n— Digby", label: 'CQL', subject: 'Digby email test — checking the send pipeline' };
const PARTS_INCIDENT: any[] = [
  { type: 'tool_call', name: 'send_email_as_digby', args: DIGBY_ARGS },
  { type: 'tool_result', name: 'send_email_as_digby', result: DIGBY_REFUSED },
  { type: 'tool_call', name: 'gmail_send_email', args: GMAIL_ARGS_1 },
  { type: 'tool_result', name: 'gmail_send_email', result: GMAIL_LABEL_REFUSED },
  { type: 'tool_call', name: 'gmail_send_email', args: GMAIL_ARGS_2 },
  { type: 'tool_result', name: 'gmail_send_email', result: GMAIL_CQL_OK },
];
const PARTS_WITHOUT_EMAIL: any[] = [
  { type: 'tool_call', name: 'gmail_search', args: { query: 'test' } },
  { type: 'tool_result', name: 'gmail_search', result: 'No Gmail messages matched that query in any connected account.' },
];
const PARTS_ALL_REFUSED: any[] = [
  { type: 'tool_call', name: 'send_email_as_digby', args: DIGBY_ARGS },
  { type: 'tool_result', name: 'send_email_as_digby', result: DIGBY_REFUSED },
  { type: 'tool_call', name: 'gmail_send_email', args: GMAIL_ARGS_1 },
  { type: 'tool_result', name: 'gmail_send_email', result: GMAIL_LABEL_REFUSED },
];
const PARTS_DRAFT_ONLY: any[] = [
  { type: 'tool_call', name: 'gmail_create_draft', args: { to: 'paul@example.com', subject: 'Digby email test — checking the send pipeline', body: 'draft body' } },
  { type: 'tool_result', name: 'gmail_create_draft', result: JSON.stringify({ ok: true, tool: 'gmail_create_draft', account: 'CQL (paul@example.com)', ids: { draftId: 'r-8123456789012345' }, message: 'Draft created: r-8123456789012345' }) },
];

const extractEmailClaim = () =>
  JSON.stringify({ claims: [{ kind: 'message', detail: CLAIM_DETAIL }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('ticket 169846b6 replay — a REAL email send must never be struck phantom', () => {
  it('REPLAYS the mishap inputs: truthful email-send claim + own-run gmail_send_email ok → NO ticket, NO correction (pre-fix: both fired)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractEmailClaim() as never);
    // receipts: [] — the chat lane's `receipts ?? []` shape; a plain
    // user-attended turn (the incident: machineTriggered falsy).
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: PARTS_INCIDENT, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    // THE FIX: the claim was TRUE — the CQL send (message 1a0e43973e3cca6c)
    // is in the run's own parts, so the verifier stays silent. Pre-fix this
    // exact pair fired the mishap ticket + the in-thread "nothing was sent"
    // correction (the only false statement in the incident thread).
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('phantom direction still convicts: the SAME claim with NO email tool execution files the ticket + posts the correction (the incident behavior, preserved)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractEmailClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: PARTS_WITHOUT_EMAIL, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe('Phantom action claim: chat asserted action(s) never executed (chat b9cd2f21)');
    expect(ticket.area).toBe('fleet-integrity');
    expect(ticket.description).toContain('[message]');
    expect(ticket.description).toContain('went out');

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const correction = mockPrisma.crossModelMessage.create.mock.calls[0][0] as any;
    expect(correction.data.role).toBe('assistant');
    expect(correction.data.content).toContain(USER_FACING_CORRECTION_BANNER);
    expect(correction.data.content).toContain(CLAIM_DETAIL);
  });

  it('a REFUSED send (not_configured digby + label_not_found gmail, zero ok) is not a delivery — the claim still convicts (the REAL phantom shape for email)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractEmailClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: PARTS_ALL_REFUSED, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    // Both envelopes say ok:false — claiming success over them is a genuine
    // phantom, and the widened pool must not launder it.
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });

  it('a DRAFT is not a send: gmail_create_draft ok does NOT vouch the email-send claim (drafts stay untracked)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractEmailClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: PARTS_DRAFT_ONLY, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });
});

describe('ticket 169846b6 — extractExecutedActions now surfaces the email tools', () => {
  it('pairs the three incident email calls exactly: two refusals ok:false, the CQL send ok:true', () => {
    const out = extractExecutedActions(PARTS_INCIDENT);
    const gmail = out.filter((a) => a.tool === 'gmail_send_email');
    const digby = out.filter((a) => a.tool === 'send_email_as_digby');
    // FIFO per-tool pairing: the first gmail call (label 'paul@example.com') pairs
    // the label_not_found refusal; the second (label 'CQL') pairs the ok.
    expect(gmail).toHaveLength(2);
    expect(gmail[0].ok).toBe(false);
    expect(gmail[0].staged).toBe(false);
    expect(gmail[1].ok).toBe(true);
    expect(digby).toHaveLength(1);
    expect(digby[0].ok).toBe(false);
  });

  it('a successful send_email_as_digby (account-tools j() envelope) parses ok', () => {
    const parts: any[] = [
      { type: 'tool_call', name: 'send_email_as_digby', args: { to: 'owner@example.com', subject: 'Nightly report', text: 'All green.' } },
      { type: 'tool_result', name: 'send_email_as_digby', result: JSON.stringify({ ok: true, tool: 'send_email_as_digby', to: 'owner@example.com', from: 'digby@digby.example.com', messageId: '<m-1@digby.example.com>', note: 'delivered to the SMTP relay' }, null, 1) },
    ];
    const out = extractExecutedActions(parts);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);
    expect(out[0].staged).toBe(false);
  });

  it('a STAGED (needsConfirmation) envelope is NOT an execution — the claim convicts (review A residual, ticket 169846b6)', async () => {
    // Neither email tool is consequential-gated today, but parseResult's
    // shared JSON path returns staged:true for a needsConfirmation envelope
    // and the matcher must not count it as a delivery. Pins the semantics
    // if either tool ever joins the staged-capable set.
    mockUtilityChat.mockResolvedValueOnce(extractEmailClaim() as never);
    const parts: any[] = [
      { type: 'tool_call', name: 'gmail_send_email', args: GMAIL_ARGS_2 },
      { type: 'tool_result', name: 'gmail_send_email', result: JSON.stringify({ needsConfirmation: true, tool: 'gmail_send_email', confirmationId: 'cf-123' }) },
    ];
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const staged = extractExecutedActions(parts).filter((a) => a.tool === 'gmail_send_email');
    expect(staged).toHaveLength(1);
    expect(staged[0].ok).toBe(false);
    expect(staged[0].staged).toBe(true);
  });

  it('slot accounting intact: THREE send claims against ONE real send → the excess two convict (review C residual, ticket 169846b6)', async () => {
    // The widened pool must not let an over-claiming note launder through a
    // single real execution — one ok email slot vouches one claim.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [
        { kind: 'message', detail: CLAIM_DETAIL },
        { kind: 'message', detail: 'the follow-up email went out to paul@example.com' },
        { kind: 'message', detail: 'the third reminder email was delivered to paul@example.com' },
      ],
    }) as never);
    // One real send only (the CQL ok); the two extra claims cite no execution.
    const parts: any[] = [
      { type: 'tool_call', name: 'gmail_send_email', args: GMAIL_ARGS_2 },
      { type: 'tool_result', name: 'gmail_send_email', result: GMAIL_CQL_OK },
    ];
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: `${CLAIM_DETAIL}. The follow-up email went out to paul@example.com. The third reminder email was delivered to paul@example.com.`, parts, receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.description).toContain('follow-up email went out');
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });
});

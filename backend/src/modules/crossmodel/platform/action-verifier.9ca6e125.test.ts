/**
 * REPLAY PIN — ticket 9ca6e125-fc7d-4d92-a048-6e679e2b043d (mishap, filed
 * 2026-10-28T14:38:31Z): "Phantom action claim: chat asserted action(s) never
 * executed (chat 35cbb923)" — 3 sightings over 2 subject chats (35cbb923,
 * 79d01368), claim shapes:
 *
 *   "[dispatch] (no id); executed consequential actions this run: NONE"
 *   "[message]  (no id); executed consequential actions this run: NONE"
 *
 * Shape-only ticket: the subject chats belong to another account, so no
 * verbatim note survived the filing (audit 2026-10-08 W5-1b). The adjudication
 * is therefore from the DETECTOR — and the detector had two structural holes,
 * one per claim shape, both of the d25172ca class (an unvouchable consequential
 * tool):
 *
 *   [message] — the outbound-connector + edge-instance send class
 *     (imessage_send, slack_post_message, discord_send_message,
 *     discord_send_dm, x_post, send_to_instance) is offered to a chat run
 *     (integration-tool-schema.ts INTEGRATION_TOOL_NAMES / platform-tool-names
 *     .ts) and answers a proper {ok:true, tool, ids} JSON envelope
 *     (connectorWriteEnvelope; toolResultEnvelope for send_to_instance), but
 *     was in NEITHER pool lane: absent from TRACKED_CONSEQUENTIAL_TOOLS and
 *     from KIND_TOOLS.message. The sibling detector already carried the
 *     vocabulary (unbacked-claim.ts SEND_CLAIM_TOOLS) and claim-verb-classes.ts
 *     maps `sent`/`messaged` onto exactly these tools, so a truthful "posted it
 *     in #eng" narration was unvouchable and convicted id-less.
 *
 *   [dispatch] — the WORKER-delegation class (delegate / delegate_parallel) is
 *     offered to a chat run (runToolSchemasForProbe kind:'chat' with
 *     allowSubagents; agent-profiles maxDelegations 2 for chat), and the claim
 *     extractor's own vocabulary defines a dispatch claim as "started/
 *     dispatched a coding session, WORKER, or platform task". But delegation
 *     mints no receipt, answers PROSE (a "### title (role)" summary — never
 *     ok:true), and sits outside KIND_TOOLS.dispatch by the 61b9200a
 *     anti-laundering rule. So a truthful "I dispatched a reviewer worker"
 *     claim could not be vouched by anything.
 *
 * The fix (the d25172ca lockstep rule, applied per class):
 *   1. TRACKED_CONSEQUENTIAL_TOOLS gains the connector-write + send_to_instance
 *      class AND KIND_TOOLS.message gains the same names — vocabulary and pool
 *      move together, so neither an honest-send conviction nor an args-surface
 *      divergence is introduced;
 *   2. delegate/delegate_parallel get their OWN lane (extractDelegationExecutions
 *      into buildExecutedPool) and their OWN id-less tier in findPhantomClaims,
 *      deliberately NOT KIND_TOOLS.dispatch, so a real worker run can never
 *      launder a platform-session phantom.
 *
 * Mock discipline mirrors action-verifier.169846b6.test.ts: config/database and
 * every transitively-heavy boundary is mocked at the top, above imports.
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
import { extractDelegationExecutions, extractExecutedActions, isDelegationClaimDetail } from './executed-actions';

// 2026-10-04 (owner): the post-delivery lane is OBSERVE-ONLY on human chats by
// default — no user-visible correction row. These pins assert the posted
// retraction, i.e. the ACTION_VERIFIER_ENFORCE=1 path.
const __prevEnforce = process.env.ACTION_VERIFIER_ENFORCE;
beforeAll(() => { process.env.ACTION_VERIFIER_ENFORCE = '1'; });
afterAll(() => { if (__prevEnforce === undefined) delete process.env.ACTION_VERIFIER_ENFORCE; else process.env.ACTION_VERIFIER_ENFORCE = __prevEnforce; });

const flush = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await flush(); };

// The mishap's lead chat id — the filed ticket title must read true against it.
const CHAT = '35cbb923-53ad-49f2-b4a3-07afbd262481';

// ── Shape [message]: outbound connector writes ────────────────────────────
const SLACK_CLAIM_DETAIL = 'I posted the release note in #eng for you';
const SLACK_NOTE = `Posted ✅ — ${SLACK_CLAIM_DETAIL}. The thread has the full changelist, and I kept the wording short so it reads straight through.`;

// The run's REAL outbound sends, in the shapes the tools actually answer.
const SLACK_OK = JSON.stringify({ ok: true, tool: 'slack_post_message', ids: { ts: '1729291200.123456', link: 'https://cql.slack.com/archives/C0123/p1729291200123456' }, message: 'Posted to #eng' });
const IMESSAGE_OK = JSON.stringify({ ok: true, tool: 'imessage_send', ids: { messageId: 'guid-77aa01' }, message: 'Sent to +15550100' });
const DISCORD_OK = JSON.stringify({ ok: true, tool: 'discord_send_message', ids: { messageId: '1180000000000000001' }, message: 'Posted to #general' });
const X_OK = JSON.stringify({ ok: true, tool: 'x_post', ids: { tweetId: '1718000000000000000' }, message: 'Posted' });
const EDGE_OK = JSON.stringify({ ok: true, tool: 'send_to_instance', ids: { instanceId: 'inst-1', chatId: 'chat-9' }, message: 'Message delivered to chat chat-9 on paired instance "home-lab" (queued)' });
// A REFUSAL: these tools are human-turn-only, and a machine turn answers this.
const SLACK_MACHINE_REFUSED = JSON.stringify({ ok: false, tool: 'slack_post_message', reason: 'machine_run', ids: {}, message: 'slack_post_message only runs on a human-attended turn — nothing was posted.' });

const PARTS_SLACK_OK: any[] = [
  { type: 'tool_call', name: 'slack_post_message', args: { channel: '#eng', text: 'Release note: …' } },
  { type: 'tool_result', name: 'slack_post_message', result: SLACK_OK },
];
const PARTS_SLACK_REFUSED: any[] = [
  { type: 'tool_call', name: 'slack_post_message', args: { channel: '#eng', text: 'Release note: …' } },
  { type: 'tool_result', name: 'slack_post_message', result: SLACK_MACHINE_REFUSED },
];
const PARTS_NO_SEND: any[] = [
  { type: 'tool_call', name: 'slack_list_channels', args: {} },
  { type: 'tool_result', name: 'slack_list_channels', result: '#eng\n#general' },
];
// A DRAFT is not a send: gmail_create_draft stays untracked (the 169846b6 rule).
const PARTS_DRAFT_ONLY: any[] = [
  { type: 'tool_call', name: 'gmail_create_draft', args: { to: 'owner@example.com', subject: 'Release note', body: 'draft body' } },
  { type: 'tool_result', name: 'gmail_create_draft', result: JSON.stringify({ ok: true, tool: 'gmail_create_draft', ids: { draftId: 'r-8123456789012345' }, message: 'Draft created: r-8123456789012345' }) },
];

const extractMessageClaim = () => JSON.stringify({ claims: [{ kind: 'message', detail: SLACK_CLAIM_DETAIL }] });

// ── Shape [dispatch]: worker delegations ──────────────────────────────────
const DELEGATION_CLAIM_DETAIL = 'dispatched a reviewer worker to check the detector diff';
const DELEGATION_NOTE = `Done — I ${DELEGATION_CLAIM_DETAIL}, and its findings are folded into the summary above.`;

// The real result shape: a prose summary per task (agent.ts), NEVER ok:true.
const DELEGATION_OK_RESULT = '### Detector review (reviewer)\nThe diff is correct; two nits, both non-blocking.\n\n[HARNESS: this worker stored 12 finding chunks]';
const DELEGATION_REFUSED_RESULT = 'Delegation is not available here (workers cannot delegate further).';

const PARTS_DELEGATION_OK: any[] = [
  { type: 'tool_call', name: 'delegate', args: { role: 'reviewer', task: 'review the detector diff' } },
  { type: 'tool_result', name: 'delegate', result: DELEGATION_OK_RESULT },
];
const PARTS_DELEGATION_REFUSED: any[] = [
  { type: 'tool_call', name: 'delegate', args: { role: 'reviewer', task: 'review the detector diff' } },
  { type: 'tool_result', name: 'delegate', result: DELEGATION_REFUSED_RESULT },
];
const PARTS_NO_DELEGATION: any[] = [
  { type: 'tool_call', name: 'search_memory', args: { query: 'detector' } },
  { type: 'tool_result', name: 'search_memory', result: 'no hits' },
];
// A REAL worker run that says nothing about a platform session — the
// anti-laundering control for the phantom [dispatch] case below.
const PARTS_DELEGATION_PARALLEL_OK: any[] = [
  { type: 'tool_call', name: 'delegate_parallel', args: { tasks: [{ role: 'explorer', task: 'map the pool' }] } },
  { type: 'tool_result', name: 'delegate_parallel', result: '### Pool map (explorer)\nTwo lanes: receipts and parts.' },
];

const extractDispatchClaim = () => JSON.stringify({ claims: [{ kind: 'dispatch', detail: DELEGATION_CLAIM_DETAIL }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
});

describe('ticket 9ca6e125 shape [message] — a REAL connector send must never be struck phantom', () => {
  it('REPLAYS the mishap: truthful "posted it in #eng" claim + own-run slack_post_message ok → NO ticket, NO correction (pre-fix: both fired)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractMessageClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: SLACK_NOTE, parts: PARTS_SLACK_OK, receipts: [], machineTriggered: false });
    await settle();

    // THE FIX: the claim was TRUE — the run's own parts hold
    // {ok:true, tool:'slack_post_message', ids:{ts}} — so the verifier stays silent.
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('each outbound send tool in the class is vouchable (iMessage / Discord / X / edge instance)', async () => {
    for (const [tool, envelope] of [
      ['imessage_send', IMESSAGE_OK],
      ['discord_send_message', DISCORD_OK],
      ['discord_send_dm', DISCORD_OK],
      ['x_post', X_OK],
      ['send_to_instance', EDGE_OK],
    ] as const) {
      jest.clearAllMocks();
      mockGetRecentChatReceipts.mockResolvedValue([]);
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
      mockUtilityChat.mockResolvedValueOnce(extractMessageClaim() as never);
      verifyRunActionClaimsAsync({
        chatId: CHAT, userId: 'u-1', finalText: SLACK_NOTE,
        parts: [{ type: 'tool_call', name: tool, args: {} }, { type: 'tool_result', name: tool, result: envelope }],
        receipts: [], machineTriggered: false,
      });
      await settle();
      expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
      expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    }
  });

  it('phantom direction still convicts: the SAME claim with NO send execution files the ticket + posts the correction', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractMessageClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: SLACK_NOTE, parts: PARTS_NO_SEND, receipts: [], machineTriggered: false });
    await settle();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe('Phantom action claim: chat asserted action(s) never executed (chat 35cbb923)');
    expect(ticket.area).toBe('fleet-integrity');
    expect(ticket.description).toContain('[message]');
    // The exact shape the mishap ticket recorded.
    expect(ticket.description).toContain('Executed consequential actions this run: NONE');

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const correction = mockPrisma.crossModelMessage.create.mock.calls[0][0] as any;
    expect(correction.data.role).toBe('assistant');
    expect(correction.data.content).toContain(USER_FACING_CORRECTION_BANNER);
  });

  it('a REFUSED send (human-turn-only → ok:false machine_run) is not a delivery — the claim still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractMessageClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: SLACK_NOTE, parts: PARTS_SLACK_REFUSED, receipts: [], machineTriggered: false });
    await settle();

    // ok:false — claiming success over it is a genuine phantom, and the
    // widened pool must not launder it.
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });

  it('a DRAFT is not a send: gmail_create_draft stays untracked', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractMessageClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: SLACK_NOTE, parts: PARTS_DRAFT_ONLY, receipts: [], machineTriggered: false });
    await settle();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });
});

describe('ticket 9ca6e125 shape [dispatch] — a REAL worker delegation must never be struck phantom', () => {
  it('REPLAYS the mishap: truthful "dispatched a reviewer worker" + own-run delegate summary → NO ticket, NO correction', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractDispatchClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: DELEGATION_NOTE, parts: PARTS_DELEGATION_OK, receipts: [], machineTriggered: false });
    await settle();

    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('delegate_parallel vouches the same claim', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractDispatchClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: DELEGATION_NOTE, parts: PARTS_DELEGATION_PARALLEL_OK, receipts: [], machineTriggered: false });
    await settle();

    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('phantom direction still convicts: the SAME claim with NO delegation on record', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractDispatchClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: DELEGATION_NOTE, parts: PARTS_NO_DELEGATION, receipts: [], machineTriggered: false });
    await settle();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.description).toContain('[dispatch]');
    expect(ticket.description).toContain('Executed consequential actions this run: NONE');
  });

  it('a REFUSED delegation ("Delegation is not available here") is not a dispatch — the claim still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractDispatchClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: DELEGATION_NOTE, parts: PARTS_DELEGATION_REFUSED, receipts: [], machineTriggered: false });
    await settle();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('ANTI-LAUNDERING: a platform-session dispatch claim is NOT acquitted by an unrelated real worker run', async () => {
    // "I dispatched a coding session" is KIND_TOOLS.dispatch — a real worker
    // delegation must not fill that slot (the 61b9200a rule, extended to the
    // new delegation lane). Only a real start_coding_session can vouch it.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'dispatched a coding session for the fix' }] }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: 'Done — I dispatched a coding session for the fix.', parts: PARTS_DELEGATION_OK, receipts: [], machineTriggered: false });
    await settle();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.description).toContain('[dispatch]');
    // The claim (platform session) is still a phantom even though a REAL
    // delegation ran that turn — the delegation lane must not fill the
    // KIND_TOOLS.dispatch slot.
    expect(ticket.description).toContain('dispatched a coding session for the fix');
  });
});

describe('ticket 9ca6e125 — the extractors and idiom gates', () => {
  it('extractExecutedActions now surfaces the outbound send class with ok:true', () => {
    for (const [tool, envelope] of [
      ['slack_post_message', SLACK_OK],
      ['imessage_send', IMESSAGE_OK],
      ['x_post', X_OK],
      ['send_to_instance', EDGE_OK],
    ] as const) {
      const out = extractExecutedActions([{ type: 'tool_call', name: tool, args: {} } as any, { type: 'tool_result', name: tool, result: envelope } as any]);
      expect(out).toHaveLength(1);
      expect(out[0].tool).toBe(tool);
      expect(out[0].ok).toBe(true);
    }
    // A refusal carries ok:false and correctly stays a non-execution.
    const refused = extractExecutedActions(PARTS_SLACK_REFUSED);
    expect(refused).toHaveLength(1);
    expect(refused[0].ok).toBe(false);
  });

  it('extractDelegationExecutions pairs FIFO and treats a prose summary as a real run', () => {
    const ok = extractDelegationExecutions(PARTS_DELEGATION_OK);
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ tool: 'delegate', ok: true, staged: false });

    const refused = extractDelegationExecutions(PARTS_DELEGATION_REFUSED);
    expect(refused).toHaveLength(1);
    expect(refused[0].ok).toBe(false);

    // No result part ⇒ never executed (same discipline as extractExecutedActions).
    expect(extractDelegationExecutions([{ type: 'tool_call', name: 'delegate', args: {} } as any])[0].ok).toBe(false);
    // Non-delegation parts are ignored entirely.
    expect(extractDelegationExecutions(PARTS_NO_DELEGATION)).toEqual([]);
  });

  it('a REAL summary that merely QUOTES a refusal phrase is still an execution (anchored refusal)', () => {
    // A reviewer worker reviewing agent.ts echoes the refusal vocabulary in its
    // report. An UNANCHORED refusal match would flip this genuine run to
    // non-executed and re-convict the honest claim — the exact regression this
    // lane exists to prevent.
    const quoting: any[] = [
      { type: 'tool_call', name: 'delegate', args: { role: 'reviewer', task: 'review the delegation refusals' } },
      { type: 'tool_result', name: 'delegate', result: '### Delegation refusals (reviewer)\nagent.ts returns "Unknown role \\"x\\"." and "Delegation is not available here." — both are whole-string returns, never a real run.' },
    ];
    const out = extractDelegationExecutions(quoting);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);

    // …while each REAL refusal (a whole-string return) stays a non-execution.
    for (const refusal of [
      'Delegation is not available here (workers cannot delegate further).',
      'Delegation is not available here.',
      'Unknown role "coder". Valid roles: reviewer, explorer, architect.',
      'No tasks provided.',
      'Role "coder" writes to the worktree — it cannot run in parallel. Use delegate() for coder/editor one at a time.',
    ]) {
      const refusalParts: any[] = [
        { type: 'tool_call', name: 'delegate', args: {} },
        { type: 'tool_result', name: 'delegate', result: refusal },
      ];
      expect(extractDelegationExecutions(refusalParts)[0].ok).toBe(false);
    }
  });

  it('isDelegationClaimDetail gates on a delegated-worker noun (the laundering guard)', () => {
    for (const d of [
      'dispatched a reviewer worker to check the detector diff',
      'delegated the exploration to an explorer subagent',
      'ran the architect worker in parallel',
      'spun up a cross-checker worker',
      'sent the researcher sub-agent after the docs',
    ]) expect(isDelegationClaimDetail(d)).toBe(true);

    for (const d of [
      'dispatched a coding session for the fix',
      'dispatched the platform task — staged for owner confirmation',
      'started a coding session 9e39ec5c',
      'filed a ticket for the flake',
      'posted the release note in #eng',
    ]) expect(isDelegationClaimDetail(d)).toBe(false);
  });
});

/**
 * DETECTOR-RECALL REPLAY — this change widens the action verifier's
 * exoneration pool and vocabulary, so its PRIOR true positives must STILL
 * convict. Each case below replays a historical convicting specimen (the
 * detector's existing convicting replay cases, referenced by ticket) and
 * asserts the phantom is still filed. Without this, a pool widening could
 * silently turn the fabrication guard off.
 */
describe('DETECTOR-RECALL REPLAY — prior true positives still fire after the pool widening', () => {
  it('DETECTOR-RECALL REPLAY (169846b6): an email-send claim over two REFUSED sends still convicts', async () => {
    // The 169846b6 phantom direction: both envelopes ok:false → no delivery.
    const parts: any[] = [
      { type: 'tool_call', name: 'send_email_as_digby', args: { to: 'owner@example.com', text: 'x' } },
      { type: 'tool_result', name: 'send_email_as_digby', result: JSON.stringify({ ok: false, tool: 'send_email_as_digby', reason: 'not_configured', message: 'Digby email is not configured on this instance. Nothing was sent.' }) },
      { type: 'tool_call', name: 'gmail_send_email', args: { to: 'owner@example.com', body: 'x', label: 'nope' } },
      { type: 'tool_result', name: 'gmail_send_email', result: JSON.stringify({ ok: false, tool: 'gmail_send_email', reason: 'label_not_found', ids: {}, message: 'No connected Google account matches "nope".' }) },
    ];
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'message', detail: 'the test email just went out from your Gmail' }] }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: 'Sent ✅ — the test email just went out from your Gmail to you.', parts, receipts: [], machineTriggered: false });
    await settle();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });

  it('DETECTOR-RECALL REPLAY (ae085617): "I filed a ticket <invented id>" with zero file_feedback still convicts', async () => {
    const invented = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'ticket', detail: `I filed a ticket for the flake: ticket ${invented}`, id: invented }] }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: `I've filed a ticket for the flake: ticket ${invented} — tracked it against the sweep.`, parts: PARTS_NO_SEND, receipts: [], machineTriggered: false });
    await settle();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('DETECTOR-RECALL REPLAY (61b9200a): a platform "dispatched a worker" phantom is not laundered by an unrelated real task run', async () => {
    // A REAL computer_task ran that turn — but it is a TASK slot, and the
    // claim is a PLATFORM dispatch. The task budget must not acquit it.
    const parts: any[] = [
      { type: 'tool_call', name: 'computer_task', args: { task: 'open Discord' } },
      { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 3] opened it' },
    ];
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'dispatched a coding session 9e39ec5c for the fix' }] }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: 'Done — I dispatched a coding session 9e39ec5c for the fix.', parts, receipts: [], machineTriggered: false });
    await settle();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('DETECTOR-RECALL REPLAY (a235fbd6): a "sent a message" phantom is not laundered by a real stage_upload', async () => {
    const parts: any[] = [
      { type: 'tool_call', name: 'stage_upload', args: { name: 'a.csv' } },
      { type: 'tool_result', name: 'stage_upload', result: JSON.stringify({ ok: true, tool: 'stage_upload', ids: { uploadId: 'u-99' }, message: 'staged' }) },
    ];
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'message', detail: 'sent the summary message to the deck session' }] }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: 'Done — I sent the summary message to the deck session, it should be there now.', parts, receipts: [], machineTriggered: false });
    await settle();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });
});
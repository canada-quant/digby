/**
 * Pins the phantom-claim verifier (action-verifier.ts, PR #295 port): claim
 * extraction parsing, the claim-vs-executed matching rules (count budget per
 * kind + cited-id exoneration via the durable dispatch ledger / DB artifact
 * check), and the full verifySupervisorRunAsync consequence chain (deduped
 * mishap ticket + in-thread [ACTION VERIFIER] correction + durable state-doc
 * refutation via appendVerifierRefutation).
 *
 * Mock discipline mirrors platform-tools.autonomy.test.ts: config/database and
 * every transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) }, // coding_sessions (ticket f1cb73ff lane)
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) }, // user_feature_requests (ticket 0beea9f1 args-citation lane)
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

// Main's state-doc service (#296): getSupervisorState (never null — degrades
// to an empty doc) + appendVerifierRefutation (the ONLY refutations writer).
const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

// Cross-wake exoneration (run-receipts follow-up): the durable receipt read is
// mocked at the module boundary (the real module reaches prisma).
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import { extractActionClaims, findPhantomClaims, verifySupervisorRunAsync, verifyRunActionClaimsAsync, computePhantomClaims, guardMachineWakeFinalAnswer, findFutureObservedTimestamps, scanToolCallArgs, mineReceiptIdiomClaims, mineEvidenceCitations, findPhantomEvidenceCitations, citedMessageRowExists, mineScheduleCitations, findPhantomScheduleCitations, citedScheduleRowExists, mineSessionChatReferences, findPhantomSessionRefs, citedChatOrSessionExists, citedTicketRowExists, hasSessionChatRefIdiom, hasScheduleCitationIdiom, samePrefixRealIds, claimDetailLines, refutationDetail, isCitationClassClaim, allCitationClassClaims, tryRedactNoteLines, toolResultTextsFromParts, REDACTED_CLAIM_LINE, ACTION_GUARD_REDACT_BANNER, ACTION_GUARD_BANNER, ExtractedClaim } from './action-verifier';
import { machineWakePreamble } from '../chat-agent/machine-wake';
import { ExecutedAction } from './executed-actions';
import type { ToolReceipt } from '../coding/run-receipts';
import logger from '../../../utils/logger';

// 2026-10-04 (owner): the post-delivery lane is OBSERVE-ONLY on human chats by default — no user-visible
// correction row. These pins assert the posted retraction, i.e. the ACTION_VERIFIER_ENFORCE=1 path.
const __prevEnforce = process.env.ACTION_VERIFIER_ENFORCE;
beforeAll(() => { process.env.ACTION_VERIFIER_ENFORCE = '1'; });
afterAll(() => { if (__prevEnforce === undefined) delete process.env.ACTION_VERIFIER_ENFORCE; else process.env.ACTION_VERIFIER_ENFORCE = __prevEnforce; });


const flush = () => new Promise((r) => setImmediate(r));
const CHAT = '11111111-2222-3333-4444-555566667777';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('extractActionClaims', () => {
  it('parses the JSON claim list and drops unknown kinds', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [
        { kind: 'dispatch', detail: 'dispatched worker A', id: 'abc-1' },
        { kind: 'message', detail: 'nudged chat B' },
        { kind: 'observation', detail: 'noticed X' },
      ],
    }) as never);
    const claims = await extractActionClaims('note');
    expect(claims).toEqual([
      { kind: 'dispatch', detail: 'dispatched worker A', id: 'abc-1' },
      { kind: 'message', detail: 'nudged chat B' },
    ]);
  });

  it('returns [] on malformed LLM output', async () => {
    mockUtilityChat.mockResolvedValueOnce('nope' as never);
    expect(await extractActionClaims('note')).toEqual([]);
  });
});

describe('findPhantomClaims', () => {
  const exec = (tool: string): ExecutedAction => ({ tool, ok: true, staged: false, ids: {} });
  const never = async () => false;

  it('a claim backed by a successful execution of its kind is not phantom', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'started session' }];
    expect(await findPhantomClaims(claims, [exec('start_coding_session')], never)).toEqual([]);
  });

  it('staged-only and failed executions do NOT back a claim', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'message', detail: 'sent nudge' }];
    const staged: ExecutedAction = { tool: 'send_chat_message', ok: false, staged: true, ids: {} };
    expect(await findPhantomClaims(claims, [staged], never)).toEqual(claims);
  });

  it('N claims need N executions (count budget per kind)', async () => {
    const claims: ExtractedClaim[] = [
      { kind: 'dispatch', detail: 'worker 1' },
      { kind: 'dispatch', detail: 'worker 2' },
      { kind: 'dispatch', detail: 'worker 3' },
    ];
    const phantoms = await findPhantomClaims(claims, [exec('start_coding_session')], never);
    expect(phantoms).toHaveLength(2);
  });

  it('an unmatched claim with a cited id survives when the artifact check passes', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'session x', id: 'aaaaaaaa-1' }];
    expect(await findPhantomClaims(claims, [], async () => true)).toEqual([]);
    expect(await findPhantomClaims(claims, [], async () => false)).toEqual(claims);
  });

  it('a non-id-shaped citation is not checked and stays phantom', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'session', id: 'PR #243' }];
    const check = jest.fn(async () => true);
    expect(await findPhantomClaims(claims, [], check)).toEqual(claims);
    expect(check).not.toHaveBeenCalled();
  });

  it('an id-bearing claim whose cited id matches an execution envelope id consumes THAT execution (prefix-tolerant)', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'started session 9f8e7d6c', id: '9f8e7d6c' }];
    const withIds: ExecutedAction = { tool: 'start_coding_session', ok: true, staged: false, ids: { sessionId: '9f8e7d6c-1111-2222-3333-444455556666' } };
    expect(await findPhantomClaims(claims, [withIds], never)).toEqual([]);
  });

  it('a claim citing an id that matches NO execution rides no count slot — it is phantom even when a same-kind execution exists', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'started session ffff0000', id: 'ffff0000' }];
    const other: ExecutedAction = { tool: 'start_coding_session', ok: true, staged: false, ids: { sessionId: '9f8e7d6c-1111' } };
    expect(await findPhantomClaims(claims, [other], never)).toEqual(claims);
  });

  it('ticket fc337153: a mis-TYPED claim citing another kind\'s own-run receipt id is exonerated (no artifactCheck hit)', async () => {
    // The TT supervisor narrated "lane unblocked" and the extraction typed it
    // [dispatch], but the cited id was the run's OWN send_chat_message
    // receiptId — a true action under the wrong kind label, not a phantom.
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'unblocked the lane (receipt 7f0da5b9)', id: '7f0da5b9' }];
    const send: ExecutedAction = { tool: 'send_chat_message', ok: true, staged: false, ids: { receiptId: '7f0da5b9-1111-2222-3333-444455556666' } };
    const check = jest.fn(async () => false);
    expect(await findPhantomClaims(claims, [send], check)).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });

  it('cross-kind exoneration also matches a full-uuid citation', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'lane unblocked', id: '7f0da5b9-1111-2222-3333-444455556666' }];
    const send: ExecutedAction = { tool: 'send_chat_message', ok: true, staged: false, ids: { receiptId: '7f0da5b9-1111-2222-3333-444455556666' } };
    expect(await findPhantomClaims(claims, [send], never)).toEqual([]);
  });

  it('cross-kind exoneration does NOT consume the execution — its own-kind id-less narration still count-matches', async () => {
    const claims: ExtractedClaim[] = [
      { kind: 'dispatch', detail: 'unblocked the lane (receipt 7f0da5b9)', id: '7f0da5b9' },
      { kind: 'message', detail: 'sent the steer nudge' },
    ];
    const send: ExecutedAction = { tool: 'send_chat_message', ok: true, staged: false, ids: { receiptId: '7f0da5b9-1111-2222-3333-444455556666' } };
    expect(await findPhantomClaims(claims, [send], never)).toEqual([]);
  });

  it('an id absent from EVERY kind\'s envelopes still convicts (cross-kind tier cannot launder a fabricated id)', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'started session ffff0000', id: 'ffff0000' }];
    const send: ExecutedAction = { tool: 'send_chat_message', ok: true, staged: false, ids: { receiptId: '7f0da5b9-1111' } };
    expect(await findPhantomClaims(claims, [send], never)).toEqual(claims);
  });

  it('review P1: tier 1a ignores NON-claim-kind envelopes — a claim splicing the run\'s own git sha still convicts', async () => {
    // receiptsToActions maps the receipt set unfiltered, so the pool carries
    // git_commit/git_push/open_pull_request envelopes. Without the
    // claim-kind scope, "dispatched session <own commit sha>" would be
    // exonerated — the exact id-splice laundering path pre-PR tiers closed.
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'dispatched session 386b6a6b', id: '386b6a6b' }];
    const commit: ExecutedAction = { tool: 'git_commit', ok: true, staged: false, ids: { sha: '386b6a6b88866547c66bac50e696b786c48085cb' } };
    expect(await findPhantomClaims(claims, [commit], never)).toEqual(claims);
  });

  it('a claim restating an id from the durable DISPATCH LEDGER is exonerated (prior verified run)', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'worker from the earlier wake', id: '23a1e15e' }];
    expect(await findPhantomClaims(claims, [], never, ['23a1e15e-aaaa-bbbb-cccc-dddddddddddd'])).toEqual([]);
  });

  it('ticket 6f01288e: a message claim citing the harness RECEIPT id prefix is exonerated by that execution', async () => {
    // The supervisor re-sent the owner's request and cited the envelope's
    // receiptId prefix ("receipt d7553cbe") — truthful, but convicted phantom
    // before receiptId was threaded into the execution pool (message claims
    // are hard-blocked from the DB existence tier, review C5).
    const claims: ExtractedClaim[] = [{ kind: 'message', detail: "re-sent the owner's request verbatim (receipt d7553cbe)", id: 'd7553cbe' }];
    const send: ExecutedAction = {
      tool: 'send_chat_message', ok: true, staged: false,
      ids: { chatId: '6f26a274-26f3-485b-971b-8ca357ad7edc', receiptId: 'd7553cbe-aaaa-bbbb-cccc-dddddddddddd' },
    };
    expect(await findPhantomClaims(claims, [send], never)).toEqual([]);
  });

  it('ticket 6f01288e (negative): a message claim citing an UNKNOWN receipt id is still phantom', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'message', detail: 'sent it (receipt ffff0000)', id: 'ffff0000' }];
    const send: ExecutedAction = {
      tool: 'send_chat_message', ok: true, staged: false,
      ids: { chatId: '6f26a274-26f3-485b-971b-8ca357ad7edc', receiptId: 'd7553cbe-aaaa-bbbb-cccc-dddddddddddd' },
    };
    expect(await findPhantomClaims(claims, [send], never)).toEqual(claims);
  });

  it('ticket 55b18ba3: the supervisor waiver-chat phantom shape stays convicted — fabricated receipt ids, empty execution pool', async () => {
    // Sighting 1: "I posted a single gentle Tuesday-morning check-in to the
    // waiver chat (receipt bdb1c556)" — the run's tool log held NO
    // consequential action and the cited id existed nowhere. Sighting 2
    // repeated the class with receipt 2b3bc8cc. The matcher must convict an
    // id-citing action claim when the pool is empty and the artifact check
    // misses; an existing row is the only exoneration.
    const s1: ExtractedClaim[] = [
      { kind: 'message', detail: 'I posted a single gentle Tuesday-morning check-in to the waiver chat (receipt bdb1c556)', id: 'bdb1c556' },
    ];
    expect(await findPhantomClaims(s1, [], never)).toEqual(s1);
    const s2: ExtractedClaim[] = [
      { kind: 'message', detail: 'I sent one reminder this sweep to the waiver chat (receipt 2b3bc8cc)', id: '2b3bc8cc' },
    ];
    expect(await findPhantomClaims(s2, [], never)).toEqual(s2);
    // Honest counterpart: the same narration with an existing artifact row is exonerated.
    expect(await findPhantomClaims(s1, [], async () => true)).toEqual([]);
  });

  it('review M1: a fabricated id is NOT exonerated by a short non-id envelope value (queue position "3")', async () => {
    // The queued-send envelope carries ids.position (a small int). Without the
    // ≥8-char guard, any fabricated id starting with "3" would prefix-match it.
    const claims: ExtractedClaim[] = [{ kind: 'message', detail: 'nudged chat 3f09a1bc', id: '3f09a1bc-aaaa-bbbb' }];
    const queuedSend: ExecutedAction = { tool: 'send_chat_message', ok: true, staged: false, ids: { chatId: '9c8b7a6d-1111-2222-3333-444455556666', position: '3' } };
    expect(await findPhantomClaims(claims, [queuedSend], never)).toEqual(claims);
  });

  it('review M1: a fabricated id is NOT exonerated by a title beginning with hex', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'dispatched "cafe1234 fix"', id: 'cafe1234-9999' }];
    const task: ExecutedAction = { tool: 'dispatch_platform_task', ok: true, staged: false, ids: { laneChatId: 'b92ef13f-c3f8-487e-8267-767e56543150', title: 'cafe1234 fix the thing' } };
    expect(await findPhantomClaims(claims, [task], never)).toEqual(claims);
  });

  it('review M2: the default DB artifact check prefix-matches 8-char citations (the style the prompt teaches)', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ createdAt: new Date() });
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'started session abcdef12…', id: 'abcdef12' }];
    // 3rd arg undefined → the REAL citedArtifactExists against mocked prisma.
    expect(await findPhantomClaims(claims, [], undefined)).toEqual([]);
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({
      where: { id: { startsWith: 'abcdef12' } },
      select: { createdAt: true },
    });
  });

  it('review M2: a day-old schedule restatement is exonerated by liveness signals (lastFiredAt / future nextRunAt), not creation recency', async () => {
    const dayAgo = new Date(Date.now() - 26 * 3600 * 1000);
    const soon = new Date(Date.now() + 3600 * 1000);
    mockPrisma.codingSchedule.findFirst.mockResolvedValueOnce({ createdAt: dayAgo, lastFiredAt: new Date(), nextRunAt: soon, enabled: true });
    const claims: ExtractedClaim[] = [{ kind: 'schedule', detail: 'updated the nightly schedule', id: 'c0ffee12' }];
    expect(await findPhantomClaims(claims, [], undefined)).toEqual([]);
    // A stale, disabled, never-fired schedule is NOT exonerating.
    mockPrisma.codingSchedule.findFirst.mockResolvedValueOnce({ createdAt: dayAgo, lastFiredAt: dayAgo, nextRunAt: dayAgo, enabled: false });
    expect(await findPhantomClaims(claims, [], undefined)).toEqual(claims);
  });

  it('ticket ae7db80b: prose carrying the cited id does NOT exonerate (raw state-JSON catch-all removed — self-report is not evidence)', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'worker from an earlier wake', id: 'beef1234' }];
    // No ledger entry, no execution, no artifact row — a notes/evidence-prose
    // mention used to acquit via the stateText catch-all; now it convicts.
    expect(await findPhantomClaims(claims, [], never, [])).toEqual(claims);
  });
});

describe('verifySupervisorRunAsync', () => {
  const note = 'Status: I dispatched three burn-down workers (sessions 23a1e15e, 52ec57b9, f762dc33) and they are working the queue now. Nothing needs the owner.';

  it('phantom path: files a mishap ticket, injects a correction, records the refutation', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched three burn-down workers' }],
    }) as never);
    verifySupervisorRunAsync({ chatId: CHAT, userId: 'u-1', finalText: note, parts: [] });
    await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toContain('phantom');
    expect(ticket.context).toMatchObject({ sessionId: CHAT, verifier: 'action-verifier' });

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const row = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(row.chatId).toBe(CHAT);
    expect(row.role).toBe('user');
    expect(row.content).toContain('[ACTION VERIFIER');
    expect(row.metadata).toMatchObject({ origin: 'machine' });

    expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('dispatched three burn-down workers'));
  });

  it('clean path: a claim backed by a real execution triggers nothing', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      // (ticket 587e9d64) detail verbatim-grounded in the fixture note —
      // "workers" is the note's own plural; the grounding lane drops
      // ungroundable paraphrases like the pre-fix 'dispatched a worker'.
      claims: [{ kind: 'dispatch', detail: 'dispatched three burn-down workers' }],
    }) as never);
    verifySupervisorRunAsync({
      chatId: CHAT, userId: 'u-1', finalText: note,
      parts: [
        { type: 'tool_call', name: 'start_coding_session' },
        { type: 'tool_result', name: 'start_coding_session', result: JSON.stringify({ ok: true, tool: 'start_coding_session', ids: { sessionId: 's-1' }, message: 'x' }) },
      ],
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a claim restating a PRIOR wake\'s ledgered dispatch is exonerated, not refuted', async () => {
    mockGetSupervisorState.mockResolvedValueOnce({
      directives: [], projects: [], notes: '', refutations: [],
      dispatches: [{ at: '2026-08-22T00:00:00.000Z', kind: 'start_coding_session', id: '23a1e15e-aaaa-bbbb-cccc-dddddddddddd' }],
    });
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      // (ticket 587e9d64) detail verbatim-grounded in the fixture note (the
      // id rides the claim's id field — the ledger tier validates it, not the
      // grounding lane).
      claims: [{ kind: 'dispatch', detail: 'dispatched three burn-down workers', id: '23a1e15e' }],
    }) as never);
    verifySupervisorRunAsync({ chatId: CHAT, userId: 'u-1', finalText: note, parts: [] });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  // ── Ticket ae7db80b (2026-08-25): ledger self-laundering regression pins ──
  // The state doc is read at FINALIZE — after the audited run's own
  // update_supervisor_state writes merged. Observed incident: two supervisor
  // wakes wrote their fabricated ticket ids into the state doc ("State
  // updated.") and the unfiltered ledger/state-JSON check acquitted both
  // phantom claims; a third identical claim (no state write) was convicted.

  it('ae7db80b regression: a dispatch ledgered DURING the audited run (at >= runStartedAt) does NOT exonerate — self-laundering is convicted', async () => {
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) }; // no real ticket row
    mockGetSupervisorState.mockResolvedValueOnce({
      directives: [], projects: [], refutations: [],
      // The run's OWN same-run state write: phantom id in BOTH a fresh
      // dispatch entry AND the notes prose — pre-fix, either surface acquitted.
      notes: 'Filed file_feedback ticket 8f3a5d2b (bug, p0) — nightly lane rogue.',
      dispatches: [{ at: '2026-08-25T15:48:47.000Z', kind: 'file_feedback', id: '8f3a5d2b-aaaa-bbbb-cccc-dddddddddddd' }],
    });
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'Filed file_feedback ticket 8f3a5d2b (bug, p0)', id: '8f3a5d2b' }],
    }) as never);
    // The run STARTED before the state write merged (15:48:24 < 15:48:47).
    // (ticket 587e9d64) The note itself must CARRY the ticket claim — the
    // verbatim-grounding lane drops extraction details with no support in the
    // audited note, so the mocked claim's detail is now grounded verbatim here.
    verifySupervisorRunAsync({
      chatId: CHAT, userId: 'u-1', finalText: `${note} Also: I filed file_feedback ticket 8f3a5d2b (bug, p0) — nightly lane rogue.`, parts: [], receipts: [],
      runStartedAt: new Date('2026-08-25T15:48:24.000Z'),
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('8f3a5d2b'));
  });

  it('a PRIOR-wake ledger entry (at < runStartedAt) still exonerates a truthful restatement', async () => {
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
    mockGetSupervisorState.mockResolvedValueOnce({
      directives: [], projects: [], notes: '', refutations: [],
      dispatches: [{ at: '2026-08-25T15:48:47.000Z', kind: 'file_feedback', id: '8f3a5d2b-aaaa-bbbb-cccc-dddddddddddd' }],
    });
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'ticket from the earlier wake stands', id: '8f3a5d2b' }],
    }) as never);
    // (ticket 587e9d64) The note must CARRY the claim for the grounding lane —
    // appended verbatim, and WITHOUT "ticket <hex>" adjacency so the
    // b216475a ticket-citation lane stays silent (the claim's id field alone
    // rides the ledger-exoneration tier under test).
    // This run started AFTER the ledger entry was stamped (15:55:30 > 15:48:47).
    verifySupervisorRunAsync({
      chatId: CHAT, userId: 'u-1', finalText: `${note} The ticket from the earlier wake stands.`, parts: [], receipts: [],
      runStartedAt: new Date('2026-08-25T15:55:30.000Z'),
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('a legacy ledger entry with an unparseable at still exonerates (fail-open against false convictions)', async () => {
    mockGetSupervisorState.mockResolvedValueOnce({
      directives: [], projects: [], notes: '', refutations: [],
      dispatches: [{ at: '', kind: 'start_coding_session', id: '23a1e15e-aaaa-bbbb-cccc-dddddddddddd' }],
    });
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      // (ticket 587e9d64) detail verbatim-grounded in the fixture note — the
      // pre-fix 'burn-down worker 23a1e15e still running' survives nowhere in
      // it and would be dropped before the fail-open tier under test runs.
      claims: [{ kind: 'dispatch', detail: 'dispatched three burn-down workers', id: '23a1e15e' }],
    }) as never);
    verifySupervisorRunAsync({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date('2026-08-25T15:55:30.000Z'),
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('skips trivial notes and no-claim notes without side effects', async () => {
    verifySupervisorRunAsync({ chatId: CHAT, userId: 'u-1', finalText: 'ok.', parts: [] });
    await flush();
    expect(mockUtilityChat).not.toHaveBeenCalled();

    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never);
    verifySupervisorRunAsync({ chatId: CHAT, userId: 'u-1', finalText: note, parts: [] });
    await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('a verifier-internal failure is a warn log, never a throw (fire-and-forget contract)', async () => {
    mockUtilityChat.mockRejectedValueOnce(new Error('llm down') as never);
    verifySupervisorRunAsync({ chatId: CHAT, userId: 'u-1', finalText: note, parts: [] });
    await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });
});

describe('verifyRunActionClaimsAsync — the general (non-supervisor) entry, ticket ae085617', () => {
  const chatNote = 'Done — I have filed a ticket for this pattern (ticket id ab12cd34-9999-8888-7777-666655554444) so the triage loop picks it up.';

  it('user-watched chat phantom: ticket + ASSISTANT-role in-thread correction (ticket d78f477b — the human must see the retraction), no supervisor state touched', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'filed a ticket for this pattern', id: 'ab12cd34-9999-8888-7777-666655554444' }],
    }) as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) }; // fabricated id — no row
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: chatNote, parts: [], machineTriggered: false });
    await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe(`Phantom action claim: chat asserted action(s) never executed (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.area).toBe('fleet-integrity');
    expect(ticket.description).toContain('[ticket]');
    // Ticket d78f477b: a human's visible thread gets an ASSISTANT-role
    // retraction (Digby correcting itself) — NEVER a machine-authored 'user'
    // row, which would render as a bubble they never typed (the ae085617
    // objection the pre-fix lane over-generalized into silence).
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const correction = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(correction.role).toBe('assistant');
    expect(correction.content).toContain('[ACTION VERIFIER');
    expect(correction.content).toContain('did NOT actually run');
    expect(correction.metadata).toMatchObject({ origin: 'machine', verifier: 'action-verifier' });
    // …and non-supervisor chats have no state doc to read or refute into.
    expect(mockGetSupervisorState).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('machine-triggered non-supervisor phantom: ticket + in-thread correction, still no state doc', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'message', detail: 'sent the digest to the overseer chat' }],
    }) as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: 'Wake done: sent the digest to the overseer chat.', parts: [], machineTriggered: true });
    await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const row = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(row.content).toContain('[ACTION VERIFIER');
    expect(row.metadata).toMatchObject({ origin: 'machine' });
    expect(mockGetSupervisorState).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('a REAL file_feedback execution (prose result) exonerates the ticket claim', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'filed a ticket', id: 'ab12cd34' }],
    }) as never);
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote,
      parts: [
        { type: 'tool_call', name: 'file_feedback' },
        { type: 'tool_result', name: 'file_feedback', result: 'Filed feedback ticket ab12cd34-9999-8888-7777-666655554444 (mishap, priority 3): "T". The triage queue handles it from here — do not follow up on it in this run.' },
      ],
      machineTriggered: false,
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a cited ticket id whose row exists with a fresh updatedAt is exonerated by the DB artifact check', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      // (ticket 587e9d64) detail verbatim-grounded in chatNote — ungroundable
      // paraphrases are dropped at extraction by the grounding lane.
      claims: [{ kind: 'ticket', detail: 'filed a ticket for this pattern', id: 'ab12cd34' }],
    }) as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => ({ updatedAt: new Date() })) };
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: chatNote, parts: [], machineTriggered: false });
    await flush(); await flush(); await flush();
    expect(mockPrisma.userFeatureRequest.findFirst).toHaveBeenCalledWith({
      where: { id: { startsWith: 'ab12cd34' } },
      // (ticket c5629165) the gate now reads the row's filer context too —
      // a fresh row filed by ANOTHER session no longer vouches this chat's
      // filing claim (this mock row carries no context → unstamped filer →
      // fail toward miss → still exonerated, as before).
      select: { updatedAt: true, context: true },
    });
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('the supervisor wrapper still runs the FULL chain through the general entry', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched a worker' }],
    }) as never);
    verifySupervisorRunAsync({ chatId: CHAT, userId: 'u-1', finalText: 'Status: dispatched a worker for the backlog and it is running now.', parts: [] });
    await flush(); await flush(); await flush();
    expect(mockGetSupervisorState).toHaveBeenCalled();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect((mockFileFeedbackTicket.mock.calls[0][0] as any).area).toBe('fleet-supervisor');
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockAppendVerifierRefutation).toHaveBeenCalled();
  });
});

describe('verifyRunActionClaimsAsync — receipts provided (execution pool from run receipts)', () => {
  const chatNote = 'Done — I have filed a ticket for this pattern (ticket id ab12cd34-9999-8888-7777-666655554444) so the triage loop picks it up.';
  const ticketClaim = () => JSON.stringify({
    claims: [{ kind: 'ticket', detail: 'filed a ticket for this pattern', id: 'ab12cd34-9999-8888-7777-666655554444' }],
  });
  const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}): ToolReceipt => ({
    id: 'r1', chatId: CHAT, runId: null, tool, ok, ids,
    inputHash: null, outputHash: null, createdAt: new Date('2026-08-24T12:00:00Z'),
  });
  // Parts carrying a SUCCESSFUL file_feedback. The per-tool union
  // (buildExecutedPool, ticket d25172ca) IGNORES this twin ONLY when a receipt
  // row covers file_feedback — an EMPTY receipts array no longer blanks the
  // parts lane (the old either/or doctrine false-struck a REAL notify_user
  // delivery on chat 66311e6d).
  const exoneratingParts = [
    { type: 'tool_call', name: 'file_feedback' },
    { type: 'tool_result', name: 'file_feedback', result: 'Filed feedback ticket ab12cd34-9999-8888-7777-666655554444 (mishap, priority 3): "T". The triage queue handles it from here — do not follow up on it in this run.' },
  ];

  it('a claim citing a receipt-carried id is EXONERATED — parts never parsed', async () => {
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, parts: [], machineTriggered: false,
      receipts: [receipt('file_feedback', true, { ticketId: 'ab12cd34-9999-8888-7777-666655554444' })],
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('an EMPTY receipt set no longer blanks the parts lane — a parts-only execution exonerates (ticket d25172ca doctrine)', async () => {
    // The pre-fix either/or doctrine ("receipts win") convicted THIS shape on
    // chat 66311e6d: a real notify_user Telegram delivery (receipt-less by
    // design) struck phantom on the truthy empty array. The pool is now a
    // per-tool UNION — receipts authoritative for the tools they cover, parts
    // covering the rest — so the parts-only file_feedback execution exonerates.
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, machineTriggered: false,
      parts: exoneratingParts,
      receipts: [],
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('a FAILED/STAGED receipt still beats its parts twin — receipts stay authoritative for the tool they cover', async () => {
    // The authority direction that pin used to over-generalize: with a REAL
    // receipt row for file_feedback whose ok:false (the send failed / the call
    // only staged), the parts twin must NOT resurrect the execution — the
    // claim convicts even though the parts pair reads successful.
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) }; // no artifact row either
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, machineTriggered: false,
      parts: exoneratingParts,
      receipts: [receipt('file_feedback', false)],
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('an ok:false receipt (staged confirmation / failed call) counts as NOT executed', async () => {
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, machineTriggered: false,
      parts: [],
      receipts: [receipt('file_feedback', false, { ticketId: 'ab12cd34-9999-8888-7777-666655554444' })],
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('ticket 6f01288e: a message claim citing the RECEIPT ROW id prefix is exonerated via the receipts pool', async () => {
    // The receipts path (receiptsToActions) must carry the receipt row's own
    // id — the envelope showed the model exactly that id as `receiptId`.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'message', detail: "re-sent the owner's request verbatim (receipt d7553cbe)", id: 'd7553cbe' }],
    }) as never);
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1',
      finalText: "Re-sent the owner's request into the chat verbatim (receipt d7553cbe). A deep_research run is answering it now.",
      parts: [], machineTriggered: false,
      receipts: [{
        id: 'd7553cbe-aaaa-bbbb-cccc-dddddddddddd', chatId: CHAT, runId: null,
        tool: 'send_chat_message', ok: true,
        ids: { chatId: '6f26a274-26f3-485b-971b-8ca357ad7edc' },
        inputHash: null, outputHash: null, createdAt: new Date('2026-08-28T08:40:00Z'),
      }],
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('receipts ABSENT → the parts fallback parses the tool log (unchanged)', async () => {
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, parts: exoneratingParts, machineTriggered: false,
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('verifyRunActionClaimsAsync — cross-wake exoneration from run_tool_receipts', () => {
  const chatNote = 'Done — I have filed a ticket for this pattern (ticket id ab12cd34-9999-8888-7777-666655554444) so the triage loop picks it up.';
  const RUN_STARTED = new Date('2026-08-24T12:00:00Z');
  const ticketClaim = (id = 'ab12cd34-9999-8888-7777-666655554444', detail = 'filed a ticket for this pattern') =>
    JSON.stringify({ claims: [{ kind: 'ticket', detail, id }] });
  const priorReceipt = (createdAt: Date, ids: Record<string, unknown> = { ticketId: 'ab12cd34-9999-8888-7777-666655554444' }): ToolReceipt => ({
    id: 'r-prior', chatId: CHAT, runId: 'run-old', tool: 'file_feedback', ok: true, ids,
    inputHash: null, outputHash: null, createdAt,
  });

  it('no in-run evidence + a matching PRIOR receipt (created before run start) → exonerated, with a log note', async () => {
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) }; // no artifact row — pass 1 must convict so the cross-wake tier is what exonerates
    mockGetRecentChatReceipts.mockResolvedValue([priorReceipt(new Date('2026-08-24T10:00:00Z'))]);
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, parts: [], machineTriggered: true,
      receipts: [], runStartedAt: RUN_STARTED,
    });
    await flush(); await flush(); await flush();

    expect(mockGetRecentChatReceipts).toHaveBeenCalledWith(CHAT, 24 * 60 * 60 * 1000);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('cross-wake'));
  });

  it('a receipt created AFTER the run started does NOT exonerate (the claim causing its own evidence)', async () => {
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
    mockGetRecentChatReceipts.mockResolvedValue([priorReceipt(new Date('2026-08-24T13:00:00Z'))]); // 1h AFTER run start
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, parts: [], machineTriggered: false,
      receipts: [], runStartedAt: RUN_STARTED,
    });
    await flush(); await flush(); await flush();

    expect(mockGetRecentChatReceipts).toHaveBeenCalled(); // consulted, but filtered out by the anchor
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1); // still a phantom
  });

  it('a cross-wake READ FAILURE behaves like today: convict from the in-run pool only', async () => {
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
    mockGetRecentChatReceipts.mockRejectedValue(new Error('db down'));
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, parts: [], machineTriggered: false,
      receipts: [], runStartedAt: RUN_STARTED,
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('no runStartedAt → the cross-wake tier is never consulted', async () => {
    mockUtilityChat.mockResolvedValueOnce(ticketClaim() as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: chatNote, parts: [], machineTriggered: false,
      receipts: [],
    });
    await flush(); await flush(); await flush();
    expect(mockGetRecentChatReceipts).not.toHaveBeenCalled();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('a PARTIAL exoneration still convicts the rest — the ticket names the cross-wake count', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [
        { kind: 'ticket', detail: 'filed a ticket for this pattern', id: 'ab12cd34-9999-8888-7777-666655554444' },
        // (ticket 587e9d64) second detail verbatim-grounded in the note text —
        // the pre-fix mock's "for the follow-up" tail survived nowhere in the
        // note and is now (correctly) dropped by the grounding lane.
        { kind: 'ticket', detail: 'filed a second ticket', id: 'ffff0000-1111-2222-3333-444455556666' },
      ],
    }) as never);
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
    mockGetRecentChatReceipts.mockResolvedValue([priorReceipt(new Date('2026-08-24T10:00:00Z'))]); // matches ONLY the first claim
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: `${chatNote} Also filed a second ticket (id ffff0000-1111-2222-3333-444455556666).`,
      parts: [], machineTriggered: false, receipts: [], runStartedAt: RUN_STARTED,
    });
    await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    // The PHANTOM CLAIMS section names only the survivor (the exonerated id
    // still appears in the quoted note excerpt below it — by design).
    const phantomSection = String(ticket.description).split('Phantom claims:\n')[1].split('\n\n')[0];
    expect(phantomSection).toContain('ffff0000-1111-2222-3333-444455556666'); // the surviving phantom
    expect(phantomSection).not.toContain('ab12cd34-9999-8888-7777-666655554444'); // the exonerated one
    expect(ticket.description).toContain('Cross-wake exonerations');
  });
});

describe('computePhantomClaims — the SHARED matcher behind both lanes (ticket fcc4dbb4)', () => {
  const note = 'Status: I dispatched the cleanup worker (session cafebabe-1234-5678-9abc-def012345678) and it is working the backlog now.';

  it('returns the conviction set plus the metadata the consequence shells need', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched the cleanup worker', id: 'cafebabe-1234-5678-9abc-def012345678' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([{ kind: 'dispatch', detail: 'dispatched the cleanup worker', id: 'cafebabe-1234-5678-9abc-def012345678' }]);
    expect(comp.executed).toEqual([]); // empty receipts → empty pool; parts never parsed
    expect(comp.note).toBe(note.trim());
    expect(comp.supervisor).toBe(false);
    expect(comp.machineTriggered).toBe(true);
    expect(comp.appendRefutation).toBeNull();
  });

  it('notes under MIN_NOTE_CHARS never reach the LLM extraction', async () => {
    const comp = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: 'ok.', parts: [] });
    expect(comp.phantoms).toEqual([]);
    expect(comp.claims).toEqual([]);
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('supervisor normalization: supervisor implies machineTriggered and arms the refutation writer', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched the cleanup worker', id: 'cafebabe-1234-5678-9abc-def012345678' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      supervisor: true, runStartedAt: new Date(), // machineTriggered omitted
    });
    expect(comp.machineTriggered).toBe(true);
    expect(typeof comp.appendRefutation).toBe('function');
    expect(comp.phantoms).toHaveLength(1);
  });
});

describe('args scan — consequential-tool ARGS as a second claim surface (ticket e65061e1)', () => {
  const PHANTOM_SESSION = 'd28897c1-0000-4000-8000-000000000000';
  // The 2026-08-27 incident shape: a phantom dispatch story inside file_feedback args.
  const phantomFfPart = {
    type: 'tool_call', name: 'file_feedback',
    args: { title: 'Phantom', description: `I dispatched start_coding_session and it returned ok:true, session ${PHANTOM_SESSION}; a later re-check found them gone.`, priority: 2 },
  };
  const ffReceipt: ToolReceipt = {
    id: 'r-ff', chatId: CHAT, runId: null, tool: 'file_feedback', ok: true,
    ids: { ticketId: 'ab12cd34-9999-8888-7777-666655554444' },
    inputHash: null, outputHash: null, createdAt: new Date(),
  };
  const cleanNote = 'Wake done. Parked the digest follow-up for the next scheduled run and left the queue as found.';

  it('convicts a phantom dispatch claim embedded in file_feedback ARGS (the incident shape)', async () => {
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never) // note extraction
      .mockResolvedValueOnce(JSON.stringify({ // args extraction
        claims: [{ kind: 'dispatch', detail: 'dispatched start_coding_session, ok:true', id: 'd28897c1' }],
      }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: cleanNote, parts: [phantomFfPart],
      receipts: [ffReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(mockUtilityChat).toHaveBeenCalledTimes(2); // note + args blob
    expect(comp.phantoms).toEqual([{ kind: 'dispatch', detail: '[in file_feedback args] dispatched start_coding_session, ok:true', id: 'd28897c1' }]);
  });

  it('exonerates args narration whose cited id IS in the run receipts', async () => {
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never)
      .mockResolvedValueOnce(JSON.stringify({
        claims: [{ kind: 'dispatch', detail: 'dispatched start_coding_session, ok:true', id: 'd28897c1' }],
      }) as never);
    const dispatchReceipt: ToolReceipt = {
      id: 'r-disp', chatId: CHAT, runId: null, tool: 'start_coding_session', ok: true,
      ids: { sessionId: PHANTOM_SESSION }, inputHash: null, outputHash: null, createdAt: new Date(),
    };
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: cleanNote, parts: [phantomFfPart],
      receipts: [dispatchReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([]);
  });

  it('keyword pre-gate: claim-free args never cost an LLM extraction', async () => {
    const quietPart = {
      type: 'tool_call', name: 'send_chat_message',
      args: { content: 'Everything is quiet this window; the digest and the probes are all holding steady.' },
    };
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never); // note only
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: cleanNote, parts: [quietPart], receipts: [], runStartedAt: new Date(),
    });
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(comp.phantoms).toEqual([]);
  });

  it('a sub-floor note does not suppress the args scan', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ // args extraction (note skipped)
      claims: [{ kind: 'dispatch', detail: 'dispatched start_coding_session, ok:true', id: 'd28897c1' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'ok.', parts: [phantomFfPart],
      receipts: [ffReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(mockUtilityChat).toHaveBeenCalledTimes(1); // args blob only
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toContain('[in file_feedback args]');
  });

  it('dedupes the same (kind, cited id) claimed in BOTH the note and the args', async () => {
    const noteClaim = { kind: 'dispatch', detail: 'dispatched the cleanup worker', id: 'd28897c1' };
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [noteClaim] }) as never) // note
      .mockResolvedValueOnce(JSON.stringify({ // args — same kind+id
        claims: [{ kind: 'dispatch', detail: 'dispatched start_coding_session, ok:true', id: 'd28897c1' }],
      }) as never);
    const note = 'Wake done. I dispatched the cleanup worker (session d28897c1) and parked the rest of the queue for later.';
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [phantomFfPart],
      receipts: [ffReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.claims).toHaveLength(2); // raw audit trail — one per surface
    expect(comp.phantoms).toHaveLength(1); // convictions deduped per (kind, id)
    expect(comp.phantoms[0].detail).toBe('dispatched the cleanup worker'); // the note's copy survived
  });

  it('B1-A: a truthful id-bearing ARGS restatement must NOT convict the note\'s truthful id-less restatement (review finding)', async () => {
    const REAL_SESSION = 'e3115ca1-0000-4000-8000-000000000000';
    const msgPart = {
      type: 'tool_call', name: 'send_chat_message',
      args: { content: `Heads up: I dispatched the cleanup worker, session ${REAL_SESSION} — it is chewing the backlog now.` },
    };
    const dispatchReceipt: ToolReceipt = {
      id: 'r-disp', chatId: CHAT, runId: null, tool: 'start_coding_session', ok: true,
      ids: { sessionId: REAL_SESSION }, inputHash: null, outputHash: null, createdAt: new Date(),
    };
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'dispatched the cleanup worker' }] }) as never) // note — id-less
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'dispatched the cleanup worker', id: 'e3115ca1' }] }) as never); // args — id-bearing
    const note = 'Wake done. I dispatched the cleanup worker and it is chewing through the cleanup backlog right now.';
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [msgPart],
      receipts: [dispatchReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([]); // ONE real dispatch exonerates BOTH restatements
  });

  it('B1-B: the note\'s truthful id-bearing claim must NOT convict a truthful id-less ARGS restatement (mirror direction)', async () => {
    const REAL_SESSION = 'e3115ca1-0000-4000-8000-000000000000';
    const ffPart = {
      type: 'tool_call', name: 'file_feedback',
      args: { title: 't', description: 'For the record: I dispatched a worker for the cleanup backlog earlier this run and it is still going.' },
    };
    const dispatchReceipt: ToolReceipt = {
      id: 'r-disp', chatId: CHAT, runId: null, tool: 'start_coding_session', ok: true,
      ids: { sessionId: REAL_SESSION }, inputHash: null, outputHash: null, createdAt: new Date(),
    };
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'dispatched the cleanup worker', id: 'e3115ca1' }] }) as never) // note — id-bearing
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'dispatched a worker for the cleanup backlog' }] }) as never); // args — id-less
    const note = 'Wake done. I dispatched the cleanup worker (session e3115ca1) and it is chewing through the backlog now.';
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [ffPart],
      receipts: [dispatchReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([]);
  });

  it('scanToolCallArgs: skips untracked tools, short blobs, and keyword-free args', () => {
    const longKeywordText = 'I dispatched a worker and it is chewing through the backlog right now.';
    expect(scanToolCallArgs([
      { type: 'tool_call', name: 'web_pipe', args: { query: longKeywordText } }, // untracked
      { type: 'tool_call', name: 'file_feedback', args: { title: 'short' } }, // under the floor
      { type: 'tool_call', name: 'send_chat_message', args: { content: 'Plain status with no action words in it at all, nothing to see.' } }, // keyword-free
      { type: 'tool_result', name: 'file_feedback', result: 'Filed feedback ticket ab12cd34' }, // not a call
      { type: 'tool_call', name: 'file_feedback', args: { description: longKeywordText } }, // THE hit
    ])).toEqual([{ tool: 'file_feedback', text: JSON.stringify({ description: longKeywordText }) }]);
    expect(scanToolCallArgs(undefined)).toEqual([]);
    expect(scanToolCallArgs(null)).toEqual([]);
  });
});

describe('args ticket-citation exoneration — historical cross-references in file_feedback args (ticket 0beea9f1)', () => {
  // THE MISHAP REPLAY (2026-09-07, chat b93df15e, sighting 1): a file_feedback
  // description cross-referenced a REAL ticket the SAME chat had filed six
  // days earlier ("two earlier runs returned truncated reports — ticket
  // fcc28eba"); the recency-gated artifact check (≤1h) convicted the truthful
  // historical reference as a phantom because the cited row's updatedAt was
  // 6.5 days old. fcc28eba-8644-4453-9636-20312b553dab exists, is done, and
  // was filed by this very chat — the citation was disciplined, not fabricated.
  const REAL_TICKET = 'fcc28eba-8644-4453-9636-20312b553dab';
  const CLAIM_DETAIL = 'This is the third agent-run failure mode seen in one session (two earlier runs returned truncated reports — ticket fcc28eba)';
  const ffRefPart = {
    type: 'tool_call', name: 'file_feedback',
    args: {
      title: 'Local browser agent degenerated into an uncontrollable token loop after hitting a CAPTCHA',
      description: `browser_task collapsed into a degenerate repetition loop after a CAPTCHA and never produced a report. ${CLAIM_DETAIL}`,
      priority: 3,
    },
  };
  const ffReceipt: ToolReceipt = {
    id: 'r-ff', chatId: CHAT, runId: null, tool: 'file_feedback', ok: true,
    ids: { ticketId: '58cad87c-dba2-4dac-98b5-2b8d4084d57d' }, // THIS run's real filing — NOT the cited historical id
    inputHash: null, outputHash: null, createdAt: new Date(),
  };
  const cleanNote = 'Filed the CAPTCHA-loop meltdown as a platform bug and left the queue as found.';
  const argsTicketClaim = JSON.stringify({ claims: [{ kind: 'ticket', detail: CLAIM_DETAIL, id: 'fcc28eba' }] });

  beforeEach(() => {
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  });

  it('REPLAY (sighting 1): exonerates an args citation of a REAL same-tenant ticket of any age', async () => {
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValueOnce({ id: REAL_TICKET });
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never) // note extraction
      .mockResolvedValueOnce(argsTicketClaim as never); // args extraction
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: cleanNote, parts: [ffRefPart],
      receipts: [ffReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([]);
    // Same-tenant scoped (null-userId system-filed rows included, ticket cdf7332b), prefix-matched existence probe (the fleet's 8-char citation idiom).
    expect(mockPrisma.userFeatureRequest.findFirst).toHaveBeenCalledWith({
      where: { id: { startsWith: 'fcc28eba' }, OR: [{ userId: 'u-1' }, { userId: null }] },
      select: { id: true },
    });
  });

  it('still convicts a FABRICATED ticket id in args (no row — the 2026-08-27 args incident shape stays caught)', async () => {
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never)
      .mockResolvedValueOnce(argsTicketClaim as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: cleanNote, parts: [ffRefPart],
      receipts: [ffReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([
      { kind: 'ticket', detail: `[in file_feedback args] ${CLAIM_DETAIL}`, id: 'fcc28eba' },
    ]);
  });

  it('PRESERVES sighting 2: an id-less "Now I\'m filing…" claim with zero executions still convicts', async () => {
    // The mishap's second sighting (a TRUE phantom — model recidivism): the
    // note narrated a filing that never happened. The exoneration lane is
    // id-bearing-only, so the count-slot accounting must still convict.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: "Now I'm filing the session-inheritance question" }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1',
      finalText: "You're right to challenge me. Now I'm filing the session-inheritance question as its own ticket.",
      parts: [], receipts: [], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([{ kind: 'ticket', detail: "Now I'm filing the session-inheritance question" }]);
  });

  it('citedTicketRowExists: prefix-matches short ids, exact-matches uuids, omits tenant scope without userId, fails OPEN on a DB error', async () => {
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValueOnce({ id: REAL_TICKET });
    expect(await citedTicketRowExists('fcc28eba', 'u-1')).toBe(true);
    expect(mockPrisma.userFeatureRequest.findFirst).toHaveBeenLastCalledWith({
      where: { id: { startsWith: 'fcc28eba' }, OR: [{ userId: 'u-1' }, { userId: null }] }, select: { id: true },
    });
    expect(await citedTicketRowExists(REAL_TICKET)).toBe(false); // exact-uuid lookup, no tenant scope, mock default null
    expect(mockPrisma.userFeatureRequest.findFirst).toHaveBeenLastCalledWith({
      where: { id: REAL_TICKET }, select: { id: true },
    });
    mockPrisma.userFeatureRequest.findFirst.mockRejectedValueOnce(new Error('db down'));
    expect(await citedTicketRowExists('fcc28eba', 'u-1')).toBe(true); // fail toward MISS — an unverifiable citation is never a conviction
  });
});

describe('mineReceiptIdiomClaims — the deterministic LLM-miss fallback (ticket e413c084)', () => {
  it('mines the exact 2026-08-29 incident idiom and prefers the receipt id over the target chat id', () => {
    const note = [
      '**Supervisor wake — 10:47 PM PDT (05:47Z): Burn-down lane reports 5 tickets closed — spot-check reveals 1 FALSE claim, 4 confirmed**',
      '`4550ee11` (QB2 route removed) ❌ FALSE — status still in_progress despite the lane claiming closure.',
      '**Action:** I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) directing it to close `4550ee11` with the actual PR/commit evidence — since the lane explicitly claimed to have merged and deployed the removal, it should have the artifacts on hand.',
    ].join('\n');
    const claims = mineReceiptIdiomClaims(note);
    expect(claims).toEqual([
      { kind: 'message', detail: expect.stringContaining('I sent a steer'), id: '6fbb2f9d' },
    ]);
  });

  it('falls back to the kind anchor (target chat) when no receipt is cited', () => {
    expect(mineReceiptIdiomClaims('Update: I sent a steer to `3bd727f6` telling it to re-run the audit with fresh pulls only.')).toEqual([
      { kind: 'message', detail: expect.stringContaining('I sent a steer'), id: '3bd727f6' },
    ]);
  });

  it('mines dispatch / schedule / ticket kinds with their own anchors (incl. "ticket id" phrasing and full uuids)', () => {
    const note = [
      'I dispatched a cleanup worker for the backlog, session `cafebabe-1234-5678-9abc-def012345678` is chewing now.',
      'I cancelled the stale monitor schedule `aaaa0000-1111-2222-3333-444455556666` after the flap ended.',
      'I filed a ticket for the digest regression (ticket id ab12cd34-9999-8888-7777-666655554444) so triage picks it up.',
    ].join('\n');
    expect(mineReceiptIdiomClaims(note)).toEqual([
      { kind: 'dispatch', detail: expect.stringContaining('I dispatched'), id: 'cafebabe-1234-5678-9abc-def012345678' },
      { kind: 'schedule', detail: expect.stringContaining('I cancelled'), id: 'aaaa0000-1111-2222-3333-444455556666' },
      { kind: 'ticket', detail: expect.stringContaining('I filed'), id: 'ab12cd34-9999-8888-7777-666655554444' },
    ]);
  });

  it('skips intentions, honesty markers, refutations, third-party receipts, blockquotes, and plain observations', () => {
    const note = [
      'I will send the steer to `3bd727f6` once the run completes.',
      'I sent the steer to `3bd727f6` — PLANNED, NOT EXECUTED yet (bad arg passed).',
      'The verifier said my steer (receipt `6fbb2f9d`) never executed — I corrected it.',
      'The gateway lane escalated to `28de72e5` (its receipt `0c888f29`), not independently verified.',
      '> I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) directing it to close the ticket.',
      'Ticket `e413c084` stays open for triage; the queue shows 7 in_progress rows.',
      'Queue state: 7 in_progress / 0 open — no dispatches needed this wake at all.',
    ].join('\n');
    expect(mineReceiptIdiomClaims(note)).toEqual([]);
  });

  it('never mines an unanchored id (a ticket id mentioned mid-sentence is not a receipt)', () => {
    // The steer target is not cited and the only hex id is an unanchored ticket
    // reference — no semantically-anchored id, no claim (safe miss).
    expect(mineReceiptIdiomClaims('I sent a steer directing the lane to close `4550ee11` with its merge evidence on hand.')).toEqual([]);
  });

  it('dedupes repeated citations of the same kind+id', () => {
    const note = [
      'I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) directing the redo.',
      'Follow-up: I sent the steer to `3bd727f6` (receipt `6fbb2f9d`) again for emphasis.',
    ].join('\n');
    expect(mineReceiptIdiomClaims(note)).toHaveLength(1);
  });

  it('handles empty and garbage input', () => {
    expect(mineReceiptIdiomClaims('')).toEqual([]);
    expect(mineReceiptIdiomClaims(undefined as any)).toEqual([]);
  });
});

describe('computePhantomClaims — deterministic miner fallback (ticket e413c084)', () => {
  it('LLM extraction returns ZERO claims → the miner still convicts the incident phantom', async () => {
    mockUtilityChat.mockResolvedValueOnce('' as never); // LLM found nothing (the pre-delivery miss)
    const note = '**Supervisor wake:** spot-check complete, 4 confirmed 1 FALSE.\n**Action:** I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) directing it to close `4550ee11` with the actual PR/commit evidence.';
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });
    expect(comp.claims).toEqual([{ kind: 'message', detail: expect.stringContaining('I sent a steer'), id: '6fbb2f9d' }]);
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].kind).toBe('message');
    expect(comp.phantoms[0].id).toBe('6fbb2f9d');
  });

  it('a mined claim citing an id present in the run\'s receipts is exonerated (truthful send, LLM-empty)', async () => {
    mockUtilityChat.mockResolvedValueOnce('' as never);
    const note = 'Wake complete: I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) directing the redo with fresh artifacts only.';
    const receipt: ToolReceipt = {
      id: '6fbb2f9d-aaaa-bbbb-cccc-dddddddddddd', chatId: CHAT, runId: null, tool: 'send_chat_message', ok: true,
      ids: { chatId: '3bd727f6-0000-0000-0000-000000000000' },
      inputHash: null, outputHash: null, createdAt: new Date(),
    };
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [receipt],
      runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });
    expect(comp.claims).toHaveLength(1); // mined, then tier-1-exonerated
    expect(comp.phantoms).toEqual([]);
  });

  it('the miner is NOT consulted when the LLM extraction found claims (no union → no double-count)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'schedule', detail: 'cancelled the stale poller', id: 'aaaa0000' }],
    }) as never);
    const note = 'Housekeeping done. I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) about the redo.\nI cancelled the stale poller schedule `bbbb1111` too.';
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });
    // Exactly the LLM's claim list — the receipt-idiom line is left alone.
    expect(comp.claims).toEqual([{ kind: 'schedule', detail: 'cancelled the stale poller', id: 'aaaa0000' }]);
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].kind).toBe('schedule');
  });

  it('an LLM extraction ERROR degrades to the miner instead of blanking the audit', async () => {
    mockUtilityChat.mockRejectedValueOnce(new Error('utility llm down') as never);
    const note = '**Wake:** I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) directing it to close `4550ee11` with evidence.';
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'message', id: '6fbb2f9d' });
  });

  it('guard-level regression: the incident note is STRUCK pre-delivery even when the LLM pass misses it', async () => {
    mockUtilityChat.mockResolvedValueOnce('' as never); // the 05:47Z pre-delivery miss
    const note = '**Supervisor wake — 10:47 PM PDT (05:47Z): Burn-down lane reports 5 tickets closed — spot-check reveals 1 FALSE claim, 4 confirmed** `4550ee11` ❌ FALSE — status still in_progress.\n**Action:** I sent a steer to `3bd727f6` (receipt `6fbb2f9d`) directing it to close `4550ee11` with the actual PR/commit evidence — since the lane explicitly claimed to have merged and deployed the removal, it should have the artifacts on hand.';
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, machineTriggered: true,
      // Deterministic clock (flake fix): without `now`, real wall clocks past
      // ~17:47Z resolve the note's "10:47 PM PDT" to TOMORROW 05:47Z and the
      // future-clock lane strikes FIRST (wrong lane, and its queued LLM Once
      // then leaks into the next test). Anchor just after the note's stamp so
      // the ACTION lane is what strikes — the regression this test pins.
      now: new Date('2026-08-28T05:50:00Z'),
    });
    expect(res.struck).toBe(true);
    // Strip+mark lane (tickets 5e1ca207/e66950c1): the conviction is id-bearing
    // and locates to line 2 of this 2-line note (exactly 50% — allowed), so
    // the note is DELIVERED with line 2 elided 1:1 instead of wholesale-
    // replaced. The regression this test pins is unchanged: the deterministic
    // miner fallback still convicts at guard level when the LLM pass misses.
    expect(res.finalText).toContain(ACTION_GUARD_REDACT_BANNER);
    expect(res.finalText).not.toContain(ACTION_GUARD_BANNER);
    expect(res.finalText).not.toContain('--- BEGIN STRUCK NOTE');
    expect(res.finalText).toContain(REDACTED_CLAIM_LINE);
    // Line 1 (no convicted id) survives byte-identical; line 2 is the marker:
    const body959 = res.finalText.slice(res.notice.length);
    expect(body959).toContain('Burn-down lane reports 5 tickets closed');
    expect(body959).not.toContain('I sent a steer to `3bd727f6`');
    expect(res.notice).toContain('[message]');
    expect(res.notice).toContain('6fbb2f9d');
    expect(res.correction).toContain('[message]');
    expect(res.correction).toContain('6fbb2f9d');
    expect(res.correction).toContain('DELIVERED with its unproven claim line(s) REMOVED');
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.title).toBe(`Supervisor phantom claim: narrated action(s) never executed (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.description).toContain('Pre-delivery strike');
    expect(ticket.description).toContain('strip+mark');
    expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('I sent a steer'));
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });
});

describe('guardMachineWakeFinalAnswer — the PRE-DELIVERY lane (ticket fcc4dbb4)', () => {
  it('(a) supervisor machine wake, phantom ticket filing → replacement wrapper, ONE deduped ticket, refutation, NO in-thread correction', async () => {
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) }; // fabricated id — no row
    const note = 'Wake complete. I filed a feedback ticket for the digest regression (ticket id ab12cd34-9999-8888-7777-666655554444) so triage picks it up.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'filed a feedback ticket for the digest regression', id: 'ab12cd34-9999-8888-7777-666655554444' }],
    }) as never);
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });

    // The replacement wrapper: harness notice on top, original blockquoted below.
    expect(res.struck).toBe(true);
    expect(res.phantoms).toHaveLength(1);
    expect(res.finalText).toContain(ACTION_GUARD_BANNER);
    expect(res.notice).toContain('[ticket]');
    expect(res.notice).toContain('ab12cd34-9999-8888-7777-666655554444');
    expect(res.notice).toContain('AUDIT ONLY');
    expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
    expect(res.finalText).toContain('--- END STRUCK NOTE ---');
    expect(res.finalText).toContain(`> ${note}`);
    expect(res.finalText.indexOf(ACTION_GUARD_BANNER)).toBeLessThan(res.finalText.indexOf(`> ${note}`));
    // DISTINCT chrome — the coding lane's markers must not leak into this lane.
    expect(res.finalText).not.toContain('[HARNESS EVIDENCE GUARD');
    expect(res.finalText).not.toContain('--- BEGIN UNVERIFIED RUN OUTPUT');
    expect(res.finalText).not.toContain('🔍 Harness claim verification');

    // The post lane's shared consequences: the deduped ticket + (supervisor)
    // the state-doc refutation.
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe(`Supervisor phantom claim: narrated action(s) never executed (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.area).toBe('fleet-supervisor');
    expect(ticket.description).toContain('Pre-delivery strike');
    expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('filed a feedback ticket for the digest regression'));
    // The guard itself writes NO message row — the seam injects the returned
    // correction AFTER it persists the replacement (ticket 51ed3a65).
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    // ...and the correction text rides back on the result: the specific struck
    // claims + the withheld-before-delivery framing, so the next wake sees
    // exactly what failed (the redacted placeholder alone taught it nothing).
    expect(res.correction).toBeDefined();
    expect(res.correction).toContain('[ACTION VERIFIER — automated integrity check]');
    expect(res.correction).toContain('WITHHELD before delivery');
    expect(res.correction).toContain('- [ticket] "filed a feedback ticket for the digest regression" (cited id ab12cd34-9999-8888-7777-666655554444)');
    expect(res.correction).toContain('{ok:true, ids:{...}}');
  });

  // Hardening review 2026-09-14: a PROJECT supervisor's strike filed as "The
  // fleet supervisor's machine-wake note" under area 'fleet-supervisor' — the
  // prose predates project supervisors (2026-08-22) and folded three project
  // lanes into the fleet seat's ticket queue. supervisorScope is LABEL-ONLY:
  // prose, area and a structured context field name the seat; the title (the
  // dedupe identity) and every verdict/consequence are byte-identical.
  describe('supervisorScope — seat attribution on the phantom ticket (hardening review 2026-09-14)', () => {
    const note = 'Wake complete. I filed a feedback ticket for the digest regression (ticket id ab12cd34-9999-8888-7777-666655554444) so triage picks it up.';
    const claimsJson = () => JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'filed a feedback ticket for the digest regression', id: 'ab12cd34-9999-8888-7777-666655554444' }],
    }) as never;

    it("pre-delivery lane, supervisorScope 'project': prose opens \"A project supervisor's machine-wake note\", area 'project-supervisor', context.supervisorScope 'project' — title unchanged", async () => {
      mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
      mockUtilityChat.mockResolvedValueOnce(claimsJson());
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        runStartedAt: new Date(), supervisor: true, supervisorScope: 'project', machineTriggered: true,
      });
      expect(res.struck).toBe(true); // the verdict is untouched by the label
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
      expect(ticket.title).toBe(`Supervisor phantom claim: narrated action(s) never executed (chat ${CHAT.slice(0, 8)})`); // dedupe identity — unchanged
      expect(ticket.description.startsWith("A project supervisor's machine-wake note")).toBe(true);
      expect(ticket.description).not.toContain('fleet supervisor');
      expect(ticket.area).toBe('project-supervisor');
      expect(ticket.context).toMatchObject({ sessionId: CHAT, verifier: 'action-verifier', supervisorScope: 'project', containedPreDelivery: true });
      // Consequences identical to the fleet seat: refutation fires, no message row from the guard.
      expect(mockAppendVerifierRefutation).toHaveBeenCalledTimes(1);
      expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    });

    it("pre-delivery lane, supervisor:true with NO scope: the pre-2026-09-14 default — fleet prose, area 'fleet-supervisor', context.supervisorScope 'fleet'", async () => {
      mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
      mockUtilityChat.mockResolvedValueOnce(claimsJson());
      await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        runStartedAt: new Date(), supervisor: true, machineTriggered: true,
      });
      const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
      expect(ticket.description.startsWith("The fleet supervisor's machine-wake note")).toBe(true);
      expect(ticket.area).toBe('fleet-supervisor');
      expect(ticket.context).toMatchObject({ supervisorScope: 'fleet' });
    });

    it("post-delivery backstop (verifySupervisorRunAsync) forwards supervisorScope 'project' through the spread", async () => {
      mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
      mockUtilityChat.mockResolvedValueOnce(claimsJson());
      verifySupervisorRunAsync({ chatId: CHAT, userId: 'u-1', finalText: note, parts: [], supervisorScope: 'project' });
      await flush(); await flush(); await flush();
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
      expect(ticket.description.startsWith("A project supervisor's machine-wake note")).toBe(true);
      expect(ticket.area).toBe('project-supervisor');
      expect(ticket.context).toMatchObject({ supervisorScope: 'project' });
      expect(ticket.context.containedPreDelivery).toBeUndefined(); // post-delivery catch keeps the legacy reopen behavior
      // The in-thread correction row is the machine-run shape regardless of seat.
      expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.metadata).toMatchObject({ origin: 'machine', verifier: 'action-verifier' });
    });

    it('a NON-supervisor turn carries no supervisorScope in its ticket context (label is supervisor-only)', async () => {
      mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) };
      mockUtilityChat.mockResolvedValueOnce(claimsJson());
      verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: note, parts: [], machineTriggered: true });
      await flush(); await flush(); await flush();
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
      expect(ticket.area).toBe('fleet-integrity');
      expect(ticket.context.supervisorScope).toBeUndefined();
    });

    it('computePhantomClaims normalizes the label: supervisor → input scope or fleet; non-supervisor → undefined', async () => {
      mockUtilityChat.mockResolvedValue('' as never); // no claims — pure normalization check
      const a = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: 'ok.', parts: [], supervisor: true, supervisorScope: 'project' });
      const b = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: 'ok.', parts: [], supervisor: true });
      const c = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: 'ok.', parts: [], supervisorScope: 'project' });
      expect(a.supervisorScope).toBe('project');
      expect(b.supervisorScope).toBe('fleet');
      expect(c.supervisor).toBe(false);
      expect(c.supervisorScope).toBeUndefined();
    });
  });

  it('(b) a claim citing an id present in the run\'s receipts passes through untouched', async () => {
    const note = 'Done — I have filed a ticket for this pattern (ticket id ab12cd34-9999-8888-7777-666655554444) so the triage loop picks it up.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'filed a ticket for this pattern', id: 'ab12cd34' }],
    }) as never);
    const receipt: ToolReceipt = {
      id: 'r1', chatId: CHAT, runId: null, tool: 'file_feedback', ok: true,
      ids: { ticketId: 'ab12cd34-9999-8888-7777-666655554444' },
      inputHash: null, outputHash: null, createdAt: new Date('2026-08-26T03:00:00Z'),
    };
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [receipt],
      runStartedAt: new Date('2026-08-26T04:00:00Z'), supervisor: true, machineTriggered: true,
    });
    expect(res.struck).toBe(false);
    expect(res.finalText).toBe(note);
    expect(res.notice).toBe('');
    expect(res.phantoms).toEqual([]);
    expect(res.correction).toBeUndefined(); // no strike → no correction text
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('(c) wholesale phantom (zero executions, id-citing claim) on a non-supervisor machine wake → replaced; ticket only, no refutation', async () => {
    const note = 'Status: I dispatched the cleanup worker (session cafebabe-1234-5678-9abc-def012345678) and it is working the backlog now.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched the cleanup worker', id: 'cafebabe-1234-5678-9abc-def012345678' }],
    }) as never);
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), machineTriggered: true, // non-supervisor
    });
    expect(res.struck).toBe(true);
    expect(res.finalText).toContain(ACTION_GUARD_BANNER);
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.title).toBe(`Phantom action claim: chat asserted action(s) never executed (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.area).toBe('fleet-integrity');
    expect(ticket.description).toContain('A machine-triggered chat turn');
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled(); // no state doc off-supervisor
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    // Ticket 51ed3a65: the correction text rides back for the seam to inject —
    // a NON-supervisor machine wake has no state-doc refutation, so this
    // in-window bubble is its ONLY specific strike feedback.
    expect(res.correction).toContain('WITHHELD before delivery');
    expect(res.correction).toContain('- [dispatch] "dispatched the cleanup worker" (cited id cafebabe-1234-5678-9abc-def012345678)');
  });

  it('(d) cross-wake exoneration preserved: an id matching a PRIOR wake\'s receipt (createdAt < runStartedAt, ≤24h) is NOT struck', async () => {
    mockPrisma.userFeatureRequest = { findFirst: jest.fn(async () => null) }; // no artifact row — pass 1 convicts so the cross-wake tier is what exonerates
    const note = 'Status: the ticket from the earlier wake (id ab12cd34-9999-8888-7777-666655554444) still covers the digest regression.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'the ticket from the earlier wake still covers the digest regression', id: 'ab12cd34-9999-8888-7777-666655554444' }],
    }) as never);
    const prior: ToolReceipt = {
      id: 'r-prior', chatId: CHAT, runId: 'run-old', tool: 'file_feedback', ok: true,
      ids: { ticketId: 'ab12cd34-9999-8888-7777-666655554444' },
      inputHash: null, outputHash: null, createdAt: new Date('2026-08-26T01:00:00Z'),
    };
    mockGetRecentChatReceipts.mockResolvedValue([prior]);
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date('2026-08-26T04:00:00Z'), supervisor: true, machineTriggered: true,
    });
    expect(mockGetRecentChatReceipts).toHaveBeenCalledWith(CHAT, 24 * 60 * 60 * 1000);
    expect(res.struck).toBe(false);
    expect(res.finalText).toBe(note);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('(e) machineTriggered === false → pass-through with ZERO audit work (user-triggered runs keep the post-delivery lane only)', async () => {
    const note = 'Done — I have filed a ticket for this pattern (ticket id ab12cd34-9999-8888-7777-666655554444) so the triage loop picks it up.';
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      machineTriggered: false, supervisor: true, // even a supervisor chat: user turns are untouched
    });
    expect(res.struck).toBe(false);
    expect(res.finalText).toBe(note);
    expect(mockUtilityChat).not.toHaveBeenCalled(); // the matcher never ran
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('(f) non-supervisor machine wake with NO action-claim keywords → the matcher (and its LLM extraction) never runs', async () => {
    const note = 'All lanes are quiet this cycle. Nothing needs the owner right now; the backlog is unchanged from the last wake.';
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      machineTriggered: true, supervisor: false, runStartedAt: new Date(),
    });
    expect(res.struck).toBe(false);
    expect(res.finalText).toBe(note);
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('(g) fail-open: an internal matcher failure → warn log, the ORIGINAL text, struck:false', async () => {
    // LLM-down is NO LONGER an internal failure (ticket e413c084 degrades it to
    // the deterministic miner) — the note below even carries a mineable claim.
    // The surviving internal-failure surface is a component that throws PAST
    // the degradation catches: simulate the state-doc read exploding
    // SYNCHRONOUSLY (a rejected promise would be neutralized by its own
    // .catch(() => null)).
    mockUtilityChat.mockRejectedValueOnce(new Error('llm down') as never);
    mockGetSupervisorState.mockImplementationOnce(() => { throw new Error('state-doc read exploded'); });
    const note = 'Status: I dispatched the cleanup worker (session cafebabe-1234-5678-9abc-def012345678) and it is working the backlog now.';
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      supervisor: true, machineTriggered: true, runStartedAt: new Date(),
    });
    expect(res.struck).toBe(false);
    expect(res.finalText).toBe(note);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pre-delivery guard failed'), expect.anything());
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('future-observation-clock rejection (ticket 375c8618)', () => {
  // build 2026-10-08 Q-3: these pins cover the LEGACY replace lane (every hit convicts, the note is
  // replaced, the reject-back runs) — the FUTURE_CLOCK_REPLACE_ENABLED=1 restore path. The default
  // clock policy (observation-only conviction, annotate-only, no clock-only reject-back) is pinned in
  // action-verifier.future-clock-policy.q3.test.ts. The detector-level checks below are unaffected.
  beforeAll(() => { process.env.FUTURE_CLOCK_REPLACE_ENABLED = '1'; });
  afterAll(() => { delete process.env.FUTURE_CLOCK_REPLACE_ENABLED; });
  describe('findFutureObservedTimestamps — deterministic unit checks', () => {
    const NOW = new Date('2026-08-27T14:24:28Z');

    it('a clock token LATER than now is flagged (the Re-Send lane case: claimed 15:03:42Z at a real 14:24:28Z)', () => {
      const hits = findFutureObservedTimestamps('Audit complete — verified through 15:03:42Z, all green.', NOW);
      expect(hits).toHaveLength(1);
      expect(hits[0].token).toContain('15:03:42Z');
      expect(hits[0].minutesAhead).toBe(39);
      expect(hits[0].claimedAt.toISOString()).toBe('2026-08-27T15:03:42.000Z');
    });

    it('a clock token EARLIER than now (a real observation) is NOT flagged', () => {
      expect(findFutureObservedTimestamps('Fresh probe at 14:24:28Z — box clock agrees.', NOW)).toEqual([]);
    });

    // Rollout watch tick 10 (2026-09-15 01:14Z): the crossmodel supervisor's
    // honest wake-line stamp was STRUCK because the clock regex matched the
    // ISO stamp's MM:SSZ tail ("10:53Z" → read as 10:53, 579 min ahead).
    it('an ISO wake stamp in the past is NOT mis-read by its MM:SSZ tail (daee2916 false strike)', () => {
      const now = new Date('2026-09-15T01:14:01.317Z');
      const line = 'Wake 2026-09-15T01:10:53Z (wake-line clock; freshest this-run tool clock 01:12:38Z from get_chat_messages updatedAt).';
      expect(findFutureObservedTimestamps(line, now)).toEqual([]);
      // …and a bare tail-shaped token still evaluates on its own when it stands alone.
      expect(findFutureObservedTimestamps('verified through 10:53Z', now)).toHaveLength(1);
    });

    it('a FUTURE ISO stamp asserted as an observation IS flagged, date-pinned (never by its tail)', () => {
      const now = new Date('2026-09-15T01:14:01Z');
      const hits = findFutureObservedTimestamps('Observed the shard flip at 2026-09-15T05:00:00Z — landed.', now);
      expect(hits).toHaveLength(1);
      expect(hits[0].token).toBe('2026-09-15T05:00:00Z');
      expect(hits[0].minutesAhead).toBe(226);
      expect(hits[0].claimedAt.toISOString()).toBe('2026-09-15T05:00:00.000Z');
      // Yesterday's ISO stamp with a "later" wall clock is a past observation.
      expect(findFutureObservedTimestamps('Observed at 2026-09-14T05:00:00Z.', now)).toEqual([]);
      // Future-intent wording still exempts the line.
      expect(findFutureObservedTimestamps('Next fire 2026-09-15T05:00:00Z.', now)).toEqual([]);
    });

    it('future-intent lines (next fire / schedule / ETA) are NOT flagged', () => {
      const text = 'Next fire 22:30Z.\nThe monitor schedule resumes at 16:00Z tomorrow.';
      expect(findFutureObservedTimestamps(text, NOW)).toEqual([]);
    });

    it('tz-suffixed am/pm tokens resolve through the offset map (2:26:59 PM PDT at 21:00Z is ~27 min ahead)', () => {
      const hits = findFutureObservedTimestamps('Observed box probes at 2:26:59 PM PDT — all alive.', new Date('2026-08-27T21:00:00Z'));
      expect(hits).toHaveLength(1);
      expect(hits[0].minutesAhead).toBe(27);
    });

    it('midnight boundary: 23:45Z cited at 00:30Z reads as YESTERDAY (past), not 23h ahead', () => {
      expect(findFutureObservedTimestamps('Probe 23:45Z showed the queue draining.', new Date('2026-08-28T00:30:00Z'))).toEqual([]);
    });

    it('ticket 1c536f51 replay: an ISO-glued H:MM:SS stamp ("2026-09-15T01:10:53Z") must NOT re-read its MM:SS tail as a bare "10:53Z" clock (the chat daee2916 false strike — +579 min phantom on a stamp 3 min PAST)', () => {
      // The exact struck line: the run's real clock was 2026-09-15T01:14:01.317Z
      // and the note cited the wake-line ISO stamp 01:10:53Z (3 min PAST). The
      // pre-fix boundary matched "10:53Z" after the "01:" colon and convicted
      // hour-10 as 579 min ahead; the (?<![0-9]:) lookbehind rejects tail
      // starts, so the glued stamp matches whole or not at all.
      const NOW_1C = new Date('2026-09-15T01:14:01.317Z');
      expect(findFutureObservedTimestamps(
        'Wake 2026-09-15T01:10:53Z (wake-line clock; freshest this-run tool clock 01:12:38Z from get_chat_messages updatedAt).',
        NOW_1C,
      )).toEqual([]);
    });

    it('ticket 1c536f51: the tail rejection holds when the MM:SS tail would be HOURS future ("2026-08-27T01:22:59Z" at a 14:24Z clock — tail "22:59Z" is +8h35m)', () => {
      expect(findFutureObservedTimestamps('Probe logged at 2026-08-27T01:22:59Z, clean.', NOW)).toEqual([]);
    });

    it('ticket 1c536f51 controls: a BARE future clock still convicts, and a bare H:MM:SS future clock still convicts WHOLE (the Re-Send class is not gutted)', () => {
      const NOW_1C = new Date('2026-09-15T01:14:01.317Z');
      const bare = findFutureObservedTimestamps('Checked the queue at 10:53Z — draining.', NOW_1C);
      expect(bare).toHaveLength(1);
      expect(bare[0].token).toContain('10:53Z');
      const whole = findFutureObservedTimestamps('Verified through 10:53:00Z, all green.', NOW_1C);
      expect(whole).toHaveLength(1);
      expect(whole[0].token).toContain('10:53:00Z');
    });

    it('ticket 1c536f51 control: a SPACE-separated bare H:MM:SS token still matches whole (hour 01 → past, clean) — the lookbehind only rejects digit-colon tails', () => {
      const NOW_1C = new Date('2026-09-15T01:14:01.317Z');
      expect(findFutureObservedTimestamps('Fresh probe at 01:10:53Z — box clock agrees.', NOW_1C)).toEqual([]);
    });

    it('clock-skew tolerance: ≤90s ahead is NOT flagged', () => {
      expect(findFutureObservedTimestamps('Checked at 14:25:30Z.', NOW)).toEqual([]); // 62s ahead
    });

    it('small-ahead future clocks STILL flag — ticket 80dd882d\'s ±15 min suggestion was deliberately narrowed: the incident replay gate pins +6m/+13m phantoms (a8976e11, #307) as real evasion classes, so over-fire relief comes from warn-inline delivery + the quoted-void exemption, not blanket tolerance', () => {
      expect(findFutureObservedTimestamps('Checked at 14:31:28Z.', NOW)).toHaveLength(1); // +7m — the ticket's own incident class
      expect(findFutureObservedTimestamps('Checked at 14:42:28Z.', NOW)).toHaveLength(1); // +18m
    });

    it('quoted-void exemption (ticket 80dd882d, supervisor steer): a blockquoted stamp inside a VOID/audit note is a citation, not a claim', () => {
      // The 14:42Z incident shape: a recovery audit voiding the prior tick's
      // fabricated reply and quoting it for the record — its own fresh audit
      // lines are all ≤ the real clock.
      const voidNote = [
        "The prior tick's reply is VOID — it claimed audits it never ran. Quoting it for the record:",
        '> Audit complete — observations through 15:03:42Z, all green.',
        'My own fresh audit window 13:24:28Z–14:24:28Z shows nothing new.',
      ].join('\n');
      expect(findFutureObservedTimestamps(voidNote, NOW)).toEqual([]);
    });

    it('quoted-void exemption covers quotes of the guard\'s own struck blocks (fence markers establish the context)', () => {
      const quote = [
        '> --- BEGIN STRUCK NOTE (quoted for audit — UNVERIFIED; struck claims are NOT DONE) ---',
        '> Observations through 15:03:42Z showed nothing new.',
        '> --- END STRUCK NOTE ---',
      ].join('\n');
      expect(findFutureObservedTimestamps(quote, NOW)).toEqual([]);
    });

    it('quoted-void exemption control: the SAME blockquoted stamp in an ordinary note still flags (bare decoration never launders — the review-A1 pin)', () => {
      expect(findFutureObservedTimestamps('> Observations through 15:03:42Z, all green.', NOW)).toHaveLength(1);
    });

    it('quoted-void exemption is BLOCK-LOCAL (2026-09-08, mirrors the coding lane): a void cue paragraphs away does not launder an unrelated blockquoted future clock', () => {
      const redo = [
        'The prior note was struck as fabricated — NOT DONE. Redoing:',
        'Checked list_chats: 12 lanes.',
        'Checked list_schedules: 3 active.',
        'Checked goals: none blocked.',
        'Fold below.',
        '> lane probe at 15:03:42Z showed all green',
      ].join('\n');
      expect(findFutureObservedTimestamps(redo, NOW)).toHaveLength(1);
      // …while the cue within the ≤3-line lead-in still exempts.
      const near = [
        'The prior note was struck as fabricated — quoting for the record:',
        '(context)',
        '> lane probe at 15:03:42Z showed all green',
      ].join('\n');
      expect(findFutureObservedTimestamps(near, NOW)).toEqual([]);
    });

    it('bare times with no tz suffix are NEVER flagged (could be durations/versions)', () => {
      expect(findFutureObservedTimestamps('Runtime 15:03:42 for the batch; version 22:04 pinned.', NOW)).toEqual([]);
    });

    it('past-reference lines are exempt (review F2): "last night\'s 22:00Z probe" cited at 14:24Z is an EARLIER observation', () => {
      expect(findFutureObservedTimestamps("Last night's 22:00Z probe found nothing new on the box.", NOW)).toEqual([]);
      expect(findFutureObservedTimestamps("Yesterday's 15:00Z check came back clean.", NOW)).toEqual([]);
    });

    it('conditional-clause exemption (ticket b84db359, chat-lane port of coding c0f5a799): the verbatim struck supervisor line is a THRESHOLD, not an observation', () => {
      // The ticket's real run clock (2026-08-29T07:23:06.850Z) and the verbatim
      // struck line: "If silent past ~08:00Z I'll treat it as wedged and pull"
      // sets a self-imposed future deadline inside an if-clause — the stamp is
      // +37m ahead but definitionally hypothetical, never a conviction.
      const runClock = new Date('2026-08-29T07:23:06.850Z');
      const struckLine = '- Spark lane `28de72e5` hasn\'t printed since 07:07Z despite "running" — sent a steer demanding the exact `run.sh` Step-5 output and a 4-option MTP-5 decision tree (upgrade 2.9.0.post1 → keep 2.8.0.post1 → rollback → narrow to missing gencode). If silent past ~08:00Z I\'ll treat it as wedged and pull.';
      expect(findFutureObservedTimestamps(struckLine, runClock)).toEqual([]);
    });

    it('watch-for exemption (ticket 188e0993): the verbatim struck supervisor line — "Watch for … 13:12Z probe; watch for … 14:08Z tick" — is a FORWARD monitoring reference, not an observation', () => {
      // The ticket's real run clock (2026-08-29T12:50:55.959Z) and the verbatim
      // struck line from the supervisor's ## Next section: both tokens (+21m,
      // +77m) name FUTURE scheduled lane events the note is watching for —
      // intrinsically prospective, never an impossible observation.
      const runClock = new Date('2026-08-29T12:50:55.959Z');
      const struckLine = 'Watch for `28de72e5` bench JSONL completion, then `b95e9df6` MTP-5 GEMM kickoff; watch for Path C\'s 13:12Z R42 probe; watch for Nightly\'s 14:08Z tick.';
      expect(findFutureObservedTimestamps(struckLine, runClock)).toEqual([]);
    });

    it('watch-for semantics: present/continuous phrasal forms exempt — but past-tense "watched" or bare "watch" with a future stamp still convict (observation register)', () => {
      expect(findFutureObservedTimestamps('Watching for the 22:30Z tick before steering.', NOW)).toEqual([]);
      expect(findFutureObservedTimestamps('The lane watches for the 22:30Z probe window.', NOW)).toEqual([]);
      // "watched" reports an OBSERVATION — a future stamp there is the phantom class.
      expect(findFutureObservedTimestamps('Watched the 15:03:42Z probe — all green, 5/5 confirmed.', NOW)).toHaveLength(1);
      // Bare "watch" with no "for" is NOT exempted (one-token drift shield).
      expect(findFutureObservedTimestamps('Watch 15:03:42Z — verified, all green.', NOW)).toHaveLength(1);
    });

    it('schedule-artifact citation exemption (ticket 65239c9a): the verbatim struck ledger line — "[sched:…] one-time Monday 13:33Z (9:30 AM ET) owner checklist" — cites a FIRE TIME, not an observation', () => {
      // The ticket's real run clock (2026-08-31T02:01:43.686Z) and the verbatim
      // struck supervisor dispatch-ledger line: 13:33Z is the one-time
      // schedule's Monday fire time (+691m — forward-looking by construction),
      // cited with the tool-returned [sched:<id>] artifact the wake preamble's
      // evidence-list rule teaches. The id is separately existence-audited by
      // the schedule-citation lane (ticket 5448a836).
      const runClock = new Date('2026-08-31T02:01:43.686Z');
      const struckLine = '- [sched:24576714-1ecd-4ece-a0b2-5d7481261795] — **new this wake**: one-time Monday 13:33Z (9:30 AM ET) owner checklist into d1062348';
      expect(findFutureObservedTimestamps(struckLine, runClock)).toEqual([]);
    });

    it('day-name pin (ticket 65239c9a sighting 2): the verbatim struck table line — "delivered 19:25Z Tuesday" run Wed 14:10Z — names the PREVIOUS day; the pin exonerates it', () => {
      // The ticket's real run clock (2026-09-02T14:10:42.993Z, a Wednesday) and
      // the verbatim struck line: "19:25Z Tuesday" = Tuesday 2026-09-01 19:25Z,
      // ~19h in the PAST — but with no day-name pin the proximity rule resolved
      // the bare token to TODAY 19:25Z (+314 min) and the truthful note was
      // REPLACED wholesale. The lane had rewritten it to carry dates per the
      // first correction and was struck anyway — the replay of that mishap.
      const runClock = new Date('2026-09-02T14:10:42.993Z');
      const struckLine = '| Waiver reply → DHHS | Polished draft delivered 19:25Z Tuesday (msg fee3342b); owner sends. Todo 681cd48f pending | Follow-up nudged — receipt 68428846 |';
      expect(findFutureObservedTimestamps(struckLine, runClock)).toEqual([]);
    });

    it('day-name pin forms: leading ("Tuesday 19:25Z"), trailing "on"-connector, and cross-week ("Friday" → 5 days back) all exonerate', () => {
      const runClock = new Date('2026-09-02T14:10:42.993Z'); // Wednesday
      expect(findFutureObservedTimestamps('Waiver draft came back clean Tuesday 19:25Z.', runClock)).toEqual([]);
      expect(findFutureObservedTimestamps('The waiver draft landed 19:25Z on Tuesday.', runClock)).toEqual([]);
      expect(findFutureObservedTimestamps('Probe ran 19:25Z Friday — queue draining.', runClock)).toEqual([]);
    });

    it('day-name pin never shields a same-day future clock: "19:25Z Wednesday" run Wednesday 14:10Z pins to TODAY (the proximity candidate) and still convicts +314m', () => {
      const runClock = new Date('2026-09-02T14:10:42.993Z');
      const hits = findFutureObservedTimestamps('Audit complete 19:25Z Wednesday — all green.', runClock);
      expect(hits).toHaveLength(1);
      expect(hits[0].minutesAhead).toBe(314);
    });

    it('day-name pin is adjacency-bounded: a day name modifying ANOTHER noun does not launder a co-line future clock', () => {
      const runClock = new Date('2026-09-02T14:10:42.993Z'); // Wednesday
      // "Tuesday" governs the deploy noun, not the tally's clock — the
      // connector-gap test fails across " deploy shipped; final tally logged ",
      // so 22:45Z falls back to the proximity rule and convicts.
      expect(findFutureObservedTimestamps('The Tuesday deploy shipped; final tally logged 22:45Z.', runClock)).toHaveLength(1);
    });

    it('day-name pin is capitalized-only (month-name parity): a lowercase "tuesday" never pins — under-pinning is the fail-safe direction', () => {
      const runClock = new Date('2026-09-02T14:10:42.993Z');
      expect(findFutureObservedTimestamps('Verified the waiver numbers 19:25Z tuesday — all green.', runClock)).toHaveLength(1);
    });

    it('schedule-artifact citation semantics: the abbreviated ledger idioms exempt — but a bare "sched" with NO id does not (citation shape, not the word)', () => {
      // The fleet's ledger idioms (wake-preamble rule 6 register) — the clock
      // is a fire time. (NOW = 14:24:28Z; every stamp below is a +39m phantom
      // absent the exemption.)
      expect(findFutureObservedTimestamps('- [sched:08ae015c] — one-time continuation at 15:03:42Z into the ops lane.', NOW)).toEqual([]);
      expect(findFutureObservedTimestamps('- sched `2ffa817e` — recurring nudge, 15:03:42Z Mondays.', NOW)).toEqual([]);
      // Post-id label form (review N2) — "`id` (sched)" is the same ledger register.
      expect(findFutureObservedTimestamps('- `24576714-1ecd-4ece-a0b2-5d7481261795` (sched) — one-time continuation at 15:03:42Z.', NOW)).toEqual([]);
      // NO id after the label → not a ledger citation; nothing else on the
      // line exempts ("sched" alone is no intent keyword) → convicts.
      expect(findFutureObservedTimestamps('- sched review done — probe verified the merge at 15:03:42Z, all green.', NOW)).toHaveLength(1);
    });

    it('conditional-clause semantics: if/when/unless thresholds exempt — but the conditional NEVER crosses a clause boundary (M2 anti-smuggle)', () => {
      // Thresholds in the stamp's own clause → exempt.
      expect(findFutureObservedTimestamps('If the queue is still red at 15:03:42Z the lane stands down.', NOW)).toEqual([]);
      expect(findFutureObservedTimestamps('Stand it down when the count hits zero by 15:03:42Z.', NOW)).toEqual([]);
      expect(findFutureObservedTimestamps('Unless the probe recovers before 15:03:42Z, page the owner.', NOW)).toEqual([]);
      // ANTI-SMUGGLE: a fabrication in the stamp's OWN clause never inherits an
      // "if" from the NEXT clause — "verified at <future>; if …" still convicts.
      expect(findFutureObservedTimestamps('Probe verified the merge at 15:03:42Z; if the deploy goes green I flip DNS.', NOW)).toHaveLength(1);
      // REACH: a conditional >96 chars back (and across a boundary) cannot govern.
      // (Fixture must avoid line-level intent words like "next" — those exempt
      // the whole line before the per-stamp check runs.)
      expect(findFutureObservedTimestamps('If the queue is still red after the coming polling cycle completes and the retries exhaust, the watcher page at 15:03:42Z stands.', NOW)).toHaveLength(1);
    });

    it('DST-mislabeled observations are exempt (review F2 — both offsets tried): "6:30 AM PST" in August resolves under PDT as past', () => {
      // now = 14:00Z August (PDT season). PST label → 14:30Z (+30m, would flag);
      // the pair's PDT member → 13:30Z (past). Most-favorable wins → no flag.
      expect(findFutureObservedTimestamps('Observed 6:30 AM PST on the box — all quiet.', new Date('2026-08-27T14:00:00Z'))).toEqual([]);
    });

    it('widened future-intent wordings are exempt (review F2): cron schedules / expires / maintenance window', () => {
      expect(findFutureObservedTimestamps('Cron schedules 22:00Z daily for the sweep.', NOW)).toEqual([]);
      expect(findFutureObservedTimestamps('The cert expires 18:00Z this week.', NOW)).toEqual([]);
      expect(findFutureObservedTimestamps('Maintenance window 14:00-15:30Z tonight.', NOW)).toEqual([]);
    });

    it('ETA/forecast wordings are exempt (ticket 6cd44575): the exact struck line is a PREDICTION, not an observation', () => {
      // The ticket's real run clock (2026-08-27T23:37:02.679Z = 4:37 PM PDT) and
      // the verbatim struck line: "8:30 PM PDT" is 233 min ahead, but the line
      // FORECASTS a future event ("finishes ~… tonight") attributed to an
      // already-observed 23:22Z message — a legitimate ETA, never a conviction.
      const runClock = new Date('2026-08-27T23:37:02.679Z');
      const struckLine = "- **CanLaw project — judge API key.** The canlaw-1f-r35 baseline finishes ~6:30–8:30 PM PDT tonight (eval lane's 23:22Z message). The 3 sonnet-5 judge cells need the key before then.";
      expect(findFutureObservedTimestamps(struckLine, runClock)).toEqual([]);
    });

    it('ETA/forecast vocabulary coverage (ticket 6cd44575): finishes / lands / projected / estimated / forecast / predicts / expects / eod', () => {
      const NOW2 = new Date('2026-08-27T23:37:02Z');
      expect(findFutureObservedTimestamps('The batch finishes at 03:30Z, judging starts after.', NOW2)).toEqual([]);
      expect(findFutureObservedTimestamps('PR #430 lands ~8:30 PM PDT.', NOW2)).toEqual([]);
      expect(findFutureObservedTimestamps('Projected completion 03:30Z; the projection holds.', NOW2)).toEqual([]); // exempt via projected/projection
      expect(findFutureObservedTimestamps('Estimated merge 8:30 PM PDT; another estimate 9:00 PM PDT.', NOW2)).toEqual([]);
      expect(findFutureObservedTimestamps('Forecast: queue drains 03:30Z; predicts backlog cleared 04:00Z.', NOW2)).toEqual([]);
      expect(findFutureObservedTimestamps('Owner expects the scorecard 8:30 PM PDT.', NOW2)).toEqual([]);
      expect(findFutureObservedTimestamps('Eval wrap-up lands EOD, roughly 8:30 PM PDT.', NOW2)).toEqual([]);
    });

    it('ticket c7c90f40: the verbatim struck line — "unsent since Aug-27 17:01Z" at 08:43Z next morning is PAST, not 498 min ahead', () => {
      const runClock = new Date('2026-08-28T08:43:23.033Z'); // the ticket's real run clock
      const struckLine = "- **91c11023 'Confirming Availability for the Call' (ALL IN project):** the Sept 1/3 date-correction draft to Ameneh & Hamid still sits unsent since Aug-27 17:01Z";
      expect(findFutureObservedTimestamps(struckLine, runClock)).toEqual([]);
    });

    it('date pinning alone (no "since"): a month-name date prefix pins the token\'s day', () => {
      const NOW2 = new Date('2026-08-28T08:43:23Z');
      expect(findFutureObservedTimestamps('The correction draft written Aug-27 17:01Z remains unsent.', NOW2)).toEqual([]);
    });

    it('date pinning: an ISO date + bare time from YESTERDAY afternoon cited the next morning is PAST (was a false conviction under nearest-candidate; ticket 958311f1 — a bare MM-DD date prefix like "09-29 02:22Z" pins against its stated date, not the run date)', () => {
      const NOW2 = new Date('2026-08-28T08:43:23Z');
      // Space-separated: CLOCK_TOKEN_RE deliberately excludes T-glued ISO
      // times (no \b after "T" — also keeps ISO 8601 DURATIONS like PT15:03
      // out of the scanner); the date pin still governs the bare token.
      expect(findFutureObservedTimestamps('The probe at 2026-08-27 17:01:00Z came back clean.', NOW2)).toEqual([]);
    });

    it('date pinning: an explicit FUTURE date in an observation line still convicts (the phantom class)', () => {
      const NOW2 = new Date('2026-08-28T08:43:23Z');
      const hits = findFutureObservedTimestamps('Audit complete — verified through 2026-08-28 15:03:42Z, all green.', NOW2);
      expect(hits).toHaveLength(1);
      expect(hits[0].minutesAhead).toBe(380);
      expect(hits[0].claimedAt.toISOString()).toBe('2026-08-28T15:03:42.000Z');
    });

    it('month-name year resolution: "Dec-30 22:00Z" said in January pins to LAST December (past), not 11 months ahead', () => {
      expect(findFutureObservedTimestamps('The Dec-30 22:00Z sweep found nothing.', new Date('2026-01-15T10:00:00Z'))).toEqual([]);
    });

    it('month-name year resolution: "Aug-29 10:00Z" said on Aug-28 convicts (pin = tomorrow; proximity = +2h — most-favorable still ahead)', () => {
      const hits = findFutureObservedTimestamps('Verified at Aug-29 10:00Z — queue drained.', new Date('2026-08-28T08:00:00Z'));
      expect(hits).toHaveLength(1);
      expect(hits[0].minutesAhead).toBe(120);
    });

    it('round-2 review: a future-dated FORWARD reference with a late-evening token stays as clean as base (exoneration-only pins)', () => {
      // Base resolves 22:00Z at 08:43Z to YESTERDAY (past); the Sept-1 pin
      // resolves +4d. Most-favorable wins → no conviction, exactly base's set.
      expect(findFutureObservedTimestamps('Owner call Sept 1 22:00Z — agenda sent.', new Date('2026-08-28T08:43:23Z'))).toEqual([]);
      // Accepted residual (identical to base): a future-dated phantom whose
      // time-of-day resolves past under proximity slips BOTH revisions.
      expect(findFutureObservedTimestamps('Verified at Aug-29 22:00Z — queue drained.', new Date('2026-08-28T08:00:00Z'))).toEqual([]);
    });

    it('"since" is a past-pointing reference (ticket c7c90f40): undated "since 17:01Z" at 08:43Z is exempt', () => {
      expect(findFutureObservedTimestamps('The email chat has been silent since 17:01Z.', new Date('2026-08-28T08:43:23Z'))).toEqual([]);
    });

    it('day-first dates pin too ("27 Aug"), and a LATER date on the line supersedes an earlier one', () => {
      const NOW2 = new Date('2026-08-28T08:43:23Z');
      expect(findFutureObservedTimestamps('Draft 27 Aug 17:01Z came back clean.', NOW2)).toEqual([]);
      // "Aug-27 23:50Z" pins to Aug-27 (past); "Aug-28 15:00Z" re-pins to a FUTURE instant → convicts.
      const hits = findFutureObservedTimestamps('Probes Aug-27 23:50Z and Aug-28 15:00Z both green.', NOW2);
      expect(hits).toHaveLength(1);
      expect(hits[0].token).toContain('15:00Z');
    });

    it('ticket 9ed1bf8e: a TRAILING (postposed) date pin governs too — "10:23:17Z Aug-29" cited at 10:17:40Z the next day is PAST, not 6 min ahead', () => {
      // The verbatim prod strike (2026-08-30, chat aa78e314): the clock carries
      // its date AFTER it; the pre-fix matcher only honored LEADING pins, so
      // proximity mis-resolved the token to today (+6m) and convicted a
      // truthful 24h-old citation.
      const runClock = new Date('2026-08-30T10:17:40.990Z'); // the ticket's real run clock
      const struckLine = '| Top Startups (283a8a3a) | ✅ Owner took over | Fresh pull: batch-5 prompt (`6d2c45a4`, 10:23:17Z Aug-29) never answered — **24h silent death confirmed**.';
      expect(findFutureObservedTimestamps(struckLine, runClock)).toEqual([]);
    });

    it('trailing pin with an "on" connector: "17:01Z on Aug-27" the next morning is PAST (closes the documented postposed-dates residual)', () => {
      const NOW2 = new Date('2026-08-28T08:43:23Z');
      expect(findFutureObservedTimestamps('The probe ran 17:01Z on Aug-27, clean.', NOW2)).toEqual([]);
      // ISO dates trail-pin too.
      expect(findFutureObservedTimestamps('The probe at 17:01:00Z 2026-08-27 came back clean.', NOW2)).toEqual([]);
    });

    it('trailing pins are exoneration-only: a FUTURE trailing date cannot dodge a proximity conviction', () => {
      // Proximity resolves 23:00Z at 22:30Z to TODAY (+30m — convicting); the
      // Sept-1 trailing pin resolves +2d. Most-favorable (smallest ahead-ms)
      // wins → the conviction stands exactly as base.
      const hits = findFutureObservedTimestamps('Audit complete — verified at 23:00Z Sept 1, all green.', new Date('2026-08-30T22:30:00Z'));
      expect(hits).toHaveLength(1);
      expect(hits[0].minutesAhead).toBe(30);
    });

    it('a date modifying a LATER noun does not trail-govern across words — non-adjacent falls back to the proximity rule', () => {
      // "Aug-29" belongs to the LOG, not the probe — the gap (" clean; the ")
      // is not a connector, so the token falls back to proximity (+6m → convicts),
      // the same accepted residual as non-adjacent LEADING phrasings.
      const hits = findFutureObservedTimestamps('Probe ran 10:23:17Z clean; the Aug-29 log is archived.', new Date('2026-08-30T10:17:40Z'));
      expect(hits).toHaveLength(1);
      expect(hits[0].token).toContain('10:23:17Z');
    });

    it('review F1: month-PREFIXED WORDS are not dates — "separate 3", "augment 30", "mayor 3" never pin', () => {
      const N = new Date('2026-08-24T08:00:00Z');
      expect(findFutureObservedTimestamps('Separate 3 probes ran 22:00Z clean.', N)).toEqual([]);
      expect(findFutureObservedTimestamps('Augment 30 replicas ran 22:00Z clean.', N)).toEqual([]);
      expect(findFutureObservedTimestamps('Marathon 3-hour sync wrapped 22:00Z.', N)).toEqual([]);
      expect(findFutureObservedTimestamps('Mayor 3rd district tally posted 22:00Z.', N)).toEqual([]);
      // The modal "may" (lowercase) is not a date either — even in the
      // future-resolving phrasing the round-2 review struck pre-fix.
      expect(findFutureObservedTimestamps('We may 30 at 22:00Z; retries green.', new Date('2026-03-15T08:00:00Z'))).toEqual([]);
    });

    it('review F2: a date modifying ANOTHER noun does not govern a non-adjacent clock token', () => {
      // The incident sentence minus "since": Sep-1 belongs to the DRAFT, not
      // the probe — non-adjacent, so 22:00Z falls back to the proximity rule
      // (yesterday, past) exactly as pre-fix.
      const N = new Date('2026-08-24T08:00:00Z');
      expect(findFutureObservedTimestamps('The Sept 1/3 date-correction draft remains unsent; probe ran 22:00Z clean.', N)).toEqual([]);
    });

    it('review F3: a rolled invalid day (2026-02-31) is not a pin — the token falls back to the proximity rule', () => {
      const N = new Date('2026-02-20T08:00:00Z');
      expect(findFutureObservedTimestamps('Probe 2026-02-31 22:00Z came back clean.', N)).toEqual([]);
    });

    it('review F4: "since" shields only the token it DIRECTLY governs — a co-line fabrication still convicts', () => {
      const N = new Date('2026-08-27T14:24:28Z');
      const hits = findFutureObservedTimestamps('Silent since 17:01Z; audit complete — verified at 15:03:42Z, all green.', N);
      expect(hits).toHaveLength(1);
      expect(hits[0].token).toContain('15:03:42Z');
      expect(hits[0].minutesAhead).toBe(39);
    });

    it('anti-gut pins (ticket 6cd44575): bare noun "project" and PAST-TENSE completion claims about future stamps still convict', () => {
      const NOW2 = new Date('2026-08-27T23:37:02Z');
      // "project" as a NOUN is on every fleet line — it must NOT exempt.
      const nounHits = findFutureObservedTimestamps('CanLaw project — probe observed 8:30 PM PDT, all green.', NOW2);
      expect(nounHits).toHaveLength(1);
      expect(nounHits[0].token).toContain('8:30 PM PDT');
      // "finished"/"completed" are completion CLAIMS about a future stamp — the
      // phantom-publish phrasing — and must stay convictable. (#428's
      // `finish\w*` exempted "finished"; narrowed to finish(?:es|ing) here.)
      expect(findFutureObservedTimestamps('Baseline finished at 8:30 PM PDT — tallies in.', NOW2)).toHaveLength(1);
      expect(findFutureObservedTimestamps('Publish completed 8:30 PM PDT, blob-verified.', NOW2)).toHaveLength(1);
      // Bare "complete"/"finish" (the phantom corpus's "Audit complete —
      // verified through 15:03:42Z" shape) must stay convictable too.
      expect(findFutureObservedTimestamps('Audit complete — verified through 8:30 PM PDT, all green.', NOW2)).toHaveLength(1);
      // Adversarial review E1 (ticket 6cd44575 fix): one-token NOUN/VERB
      // drifts of the nemesis phrasing — "completion", "ready", "completes" —
      // were briefly exempted and must convict forever after.
      expect(findFutureObservedTimestamps('Audit completion — verified through 8:30 PM PDT, all green.', NOW2)).toHaveLength(1);
      expect(findFutureObservedTimestamps('Audit ready — verified through 8:30 PM PDT, all green.', NOW2)).toHaveLength(1);
      expect(findFutureObservedTimestamps('Audit completes — verified through 8:30 PM PDT, all green.', NOW2)).toHaveLength(1);
      expect(findFutureObservedTimestamps('Merge completion 8:30 PM PDT, blob-verified.', NOW2)).toHaveLength(1);
    });

    it('the PROD false positive stays fixed (first live strike, 2026-08-27 23:37Z): an ETA line "finishes ~6:30–8:30 PM PDT tonight" is forward-looking, not an observation', () => {
      const line = '- **CanLaw project — judge API key.** The canlaw-1f-r35 baseline finishes ~6:30–8:30 PM PDT tonight (eval lane\'s 23:22Z message). The 3 sonnet-5 judge cells need ANTHROPIC_API_KEY.';
      expect(findFutureObservedTimestamps(line, new Date('2026-08-27T23:37:02Z'))).toEqual([]);
      expect(findFutureObservedTimestamps('The run finishes 18:00Z; the report lands 19:30Z.', NOW)).toEqual([]);
      // "complet\w*"/"ready" are deliberately NOT intent words — "Audit complete —
      // verified through <future clock>" is the Re-Send fabrication shape itself.
      expect(findFutureObservedTimestamps('Audit complete — verified through 15:03:42Z, all green.', NOW)).toHaveLength(1);
    });

    it('2026-08-31 regression (chat c0e22e36): the verbatim struck line — "queued behind its hourly tick 17:29:37Z future" — FOLLOWED machine-wake rule 8\'s label-a-future-event contract; the literal label word "future" and the fleet\'s schedule noun "tick" exempt it', () => {
      // The exact line the pre-delivery guard struck +12m at a real clock of
      // 2026-08-31T17:17:56.026Z — the model labeled the schedule's next-fire
      // time as future and was struck anyway because the intent whitelist knew
      // neither "future" (the label rule 8 itself names) nor "tick".
      const struckLine = 'Delivered verbatim to Path C [chat cec340f2-f605-4370-b87a-d85b59cb243f] as the design-reference relay it requested ([receipt a82d0e44], queued behind its hourly tick 17:29:37Z future) — per [goal 0f5e0a61-541e-4a8c-b4aa-f206e88e6b9542] (active, pulled this run) Design Reference lane spec, Path C holds benchmark knowledge, CanLaw stack ownership stays with the Post-CPT lane';
      expect(findFutureObservedTimestamps(struckLine, new Date('2026-08-31T17:17:56.026Z'))).toEqual([]);
      // Each new vocabulary word independently exempts:
      expect(findFutureObservedTimestamps('Relay queued behind its hourly tick 17:29:37Z.', new Date('2026-08-31T17:17:56.026Z'))).toEqual([]); // tick
      expect(findFutureObservedTimestamps('Relay handoff 17:29:37Z future, not observed yet.', new Date('2026-08-31T17:17:56.026Z'))).toEqual([]); // future
      // Anti-smuggle: a bare future OBSERVATION clock with no label wording
      // still convicts — the new words cannot gut the incident class.
      expect(findFutureObservedTimestamps('Observed the relay at 17:29:37Z — receipt verified, all green.', new Date('2026-08-31T17:17:56.026Z'))).toHaveLength(1);
    });
  });

  describe('preamble ↔ detector drift guard (2026-08-31 — the whack-a-mole breaker)', () => {
    it('machineWakePreamble\'s OWN taught clock examples never convict — the label vocabulary the preamble teaches and the vocabulary this detector exempts cannot diverge silently again', () => {
      // Every future-clock false strike this week (6cd44575 → 188e0993 →
      // 65239c9a → 9ed1bf8e → b84db359 → the c0e22e36 "tick … future" strike)
      // was the SAME structural bug: two separately-maintained vocabularies.
      // Running the full preamble through the detector turns the next
      // divergence into a CI failure instead of a replaced honest note.
      const now = new Date('2026-08-31T17:17:56.026Z');
      expect(findFutureObservedTimestamps(machineWakePreamble(now), now)).toEqual([]);
    });

    it('the taught "(id not captured)" escape hatch never mines a citation candidate in ANY lane (owner doctrine 2026-09-04 ↔ miner drift guard)', () => {
      // F3 teaches the wake preamble + supervisor prompt that "(id not
      // captured)" is ALWAYS acceptable. This pin makes that promise
      // structural: notes written in exactly the taught phrasing must reach
      // zero citation-lane candidates — a taught escape hatch that convicts
      // is the 2026-08-31 preamble↔detector drift class all over again.
      const taughtLines = [
        'Path B monitor fired at its tick and the tally landed (id not captured) — verified fresh via list_schedules this run.',
        'dispatched the cleanup session (id not captured) — running under Path C, tracked via get_chat_status this run.',
        'reply expected in chat (id not captured) — owner ping outstanding since the morning sweep.',
        'sched (id not captured) re-armed the hourly monitor; next fire on schedule.',
        'final verdict msg (id not captured) — tally recorded for the owner digest this run.',
      ];
      for (const line of taughtLines) {
        expect(mineEvidenceCitations(line)).toEqual([]);
        expect(mineScheduleCitations(line)).toEqual([]);
        expect(mineSessionChatReferences(line)).toEqual([]);
      }
    });

    it('machineWakePreamble itself (which quotes real example ids) never mines a citation candidate — the taught examples cannot convict a note quoting them', () => {
      const p = machineWakePreamble(new Date('2026-09-04T03:00:00Z'));
      expect(mineEvidenceCitations(p)).toEqual([]);
      expect(mineScheduleCitations(p)).toEqual([]);
      expect(mineSessionChatReferences(p)).toEqual([]);
    });
  });

  describe('tryRedactNoteLines — pure strip+mark mapping (tickets 5e1ca207 / e66950c1)', () => {
    const claim = (id?: string): ExtractedClaim => ({ kind: 'message', detail: 'claim detail', id });
    const ID_A = 'deadbeef-1234-5678-9abc-def012345678';
    const ID_B = 'cafebabe-0000-1111-2222-333344445555';

    it('elides every line carrying a convicted id 1:1 with the marker; survivors byte-identical', () => {
      const note = [
        'alpha line',
        `bravo [msg:${ID_A}] claim`,
        'charlie line',
        `delta ${ID_A} repeated`,
        'echo line',
      ].join('\n');
      expect(tryRedactNoteLines(note, [claim(ID_A)])).toBe(
        ['alpha line', REDACTED_CLAIM_LINE, 'charlie line', REDACTED_CLAIM_LINE, 'echo line'].join('\n'),
      );
    });

    it('dedupes multiple convicted ids and elides a shared line once', () => {
      const note = `alpha\nbravo ${ID_A} + ${ID_B}\ncharlie`;
      expect(tryRedactNoteLines(note, [claim(ID_A), claim(ID_B)])).toBe(
        ['alpha', REDACTED_CLAIM_LINE, 'charlie'].join('\n'),
      );
    });

    it('fails closed (null) for an id-less conviction', () => {
      expect(tryRedactNoteLines('alpha\nbravo\ncharlie', [claim(undefined)])).toBeNull();
    });

    it('fails closed (null) when a convicted id appears nowhere in the note (LLM-paraphrase guard)', () => {
      expect(tryRedactNoteLines('alpha\nbravo\ncharlie', [claim(ID_A)])).toBeNull();
    });

    it('fails closed (null) when elision guts >50% of non-empty lines', () => {
      const note = `alpha ${ID_A}\nbravo ${ID_B}\ncharlie`;
      expect(tryRedactNoteLines(note, [claim(ID_A), claim(ID_B)])).toBeNull();
    });

    it('fails closed (null) on zero survivors', () => {
      expect(tryRedactNoteLines(`only line ${ID_A}`, [claim(ID_A)])).toBeNull();
    });

    it('returns null for an empty conviction list', () => {
      expect(tryRedactNoteLines('alpha', [])).toBeNull();
    });

    it('REDACTED_CLAIM_LINE is audit-inert — every deterministic miner + the clock detector extract nothing from it', () => {
      expect(mineReceiptIdiomClaims(REDACTED_CLAIM_LINE)).toEqual([]);
      expect(mineEvidenceCitations(REDACTED_CLAIM_LINE)).toEqual([]);
      expect(mineScheduleCitations(REDACTED_CLAIM_LINE)).toEqual([]);
      expect(mineSessionChatReferences(REDACTED_CLAIM_LINE)).toEqual([]);
      expect(findFutureObservedTimestamps(REDACTED_CLAIM_LINE, new Date('2026-09-01T08:00:00Z'))).toEqual([]);
    });
  });

  describe('guardMachineWakeFinalAnswer — strip+mark delivery (tickets 5e1ca207 / e66950c1)', () => {
    const PHANTOM_MSG = 'd5bf67be-56b7-4912-ab1e-e0cf97162ff7';
    const PHANTOM_MSG2 = '5ee40e7c-d6c1-4022-a4aa-167f2ee4121b';
    const SURVIVOR_1 = '- Spark cluster: epoch queued behind the gate; gateway task additive-only.';
    const SURVIVOR_2 = 'No owner action needed beyond the Reinstall toggle.';
    const STRUCK_LINE = `- Reinstall lane paused per owner ([msg:${PHANTOM_MSG}]): Screen Recording toggle is the only open item.`;
    const REDACT_NOTE = [
      'Fleet sweep — all lanes checked fresh this run.',
      '- Path C lane: hourly tick healthy, 399/500 runs, no stalls.',
      STRUCK_LINE,
      SURVIVOR_1,
      SURVIVOR_2,
    ].join('\n');

    beforeEach(() => {
      mockUtilityChat.mockResolvedValue('{"claims":[]}' as never); // note-level LLM extraction finds nothing — the deterministic citation lane convicts
    });

    it('DELIVERS a supervisor note with the phantom-citation line elided 1:1 — surviving content byte-identical (the 5e1ca207 class)', async () => {
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null); // the cited msg row does not exist
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: REDACT_NOTE, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
        now: new Date('2026-09-01T07:45:00Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(1);
      expect(res.phantoms[0]).toMatchObject({ kind: 'message', id: PHANTOM_MSG });
      // Strip+mark delivery, NOT full replacement:
      expect(res.finalText).toContain(ACTION_GUARD_REDACT_BANNER);
      expect(res.finalText).not.toContain(ACTION_GUARD_BANNER);
      expect(res.finalText).not.toContain('--- BEGIN STRUCK NOTE');
      expect(res.finalText).toContain(REDACTED_CLAIM_LINE);
      expect(res.finalText).toContain(SURVIVOR_1);
      expect(res.finalText).toContain(SURVIVOR_2);
      // The struck line survives ONLY inside the notice's claim list (the
      // accountability detail) — the delivered note BODY is redacted:
      const body = res.finalText.slice(res.notice.length);
      expect(body).not.toContain(STRUCK_LINE);
      expect(body).toContain(REDACTED_CLAIM_LINE);
      // Accountability unchanged: ticket (redacted provenance), refutation, correction.
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
      expect(ticket.description).toContain('strip+mark');
      expect(ticket.description).not.toContain('quoted audit block');
      expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('d5bf67be'));
      expect(res.correction).toContain('DELIVERED with its unproven claim line(s) REMOVED');
      expect(res.correction).not.toContain('WITHHELD');
    });

    it('fails closed to FULL replacement for an id-less conviction (count-budget phantom)', async () => {
      mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
        claims: [{ kind: 'message', detail: 'I posted the Tuesday-morning check-in to the waiver chat' }],
      }) as never);
      const note = 'Fleet sweep done. I posted the Tuesday-morning check-in to the waiver chat — the staged board is one scroll up. All other lanes idle.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:40:00Z'),
        now: new Date('2026-09-01T07:41:00Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(1);
      expect(res.finalText).toContain(ACTION_GUARD_BANNER);
      expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
      expect(res.finalText).not.toContain(ACTION_GUARD_REDACT_BANNER);
      expect(res.correction).toContain('WITHHELD');
    });

    it('fails closed to FULL replacement when the convicted id appears nowhere in the note verbatim', async () => {
      const GHOST = 'cafebabe-0000-1111-2222-333344445555';
      mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
        claims: [{ kind: 'message', detail: `steered the waiver lane (receipt ${GHOST})`, id: GHOST }],
      }) as never);
      const note = 'Fleet sweep done. I steered the waiver lane this morning — receipt cited from memory. All other lanes idle, nothing else new to report here.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:40:00Z'),
        now: new Date('2026-09-01T07:41:00Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(1);
      expect(res.finalText).toContain(ACTION_GUARD_BANNER);
      expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
      expect(res.finalText).not.toContain(ACTION_GUARD_REDACT_BANNER);
    });

    it('fails closed to FULL replacement when elision would gut >50% of the note', async () => {
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
      const note = [
        `- Reinstall paused per owner ([msg:${PHANTOM_MSG}]).`,
        '- Waiver lane nudged with the Tuesday check-in; the staged board is one scroll up.',
        `- Spark gateway task detail ([msg:${PHANTOM_MSG2}]).`,
      ].join('\n');
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:40:00Z'),
        now: new Date('2026-09-01T07:41:00Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(2);
      expect(res.finalText).toContain(ACTION_GUARD_BANNER);
      expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
      expect(res.finalText).not.toContain(ACTION_GUARD_REDACT_BANNER);
    });
  });

  describe('guardMachineWakeFinalAnswer — the future-clock strike', () => {
    it('REPLACES (fail-closed, ticket cdd3fbfe — supersedes the 80dd882d warn lane) a keyword-FREE non-supervisor machine note whose only violation is a future clock', async () => {
      // The literal Re-Send lane values: claimed observation 15:03:42Z at a real 14:24:28Z.
      const note = 'All quiet this cycle. Observations through 15:03:42Z show nothing new; the backlog is unchanged.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-27T14:20:00Z'),
        now: new Date('2026-08-27T14:24:28Z'),
      });
      expect(res.struck).toBe(true); // the guard intervened pre-delivery (caller applies finalText + notice)
      expect(res.phantoms).toEqual([]);
      // Full replacement, NOT a warn banner: the unproven observation never
      // reaches the committed note (owner directive 2026-08-30).
      expect(res.finalText).toContain(ACTION_GUARD_BANNER);
      expect(res.finalText).not.toContain('DELIVERED WITH WARNING');
      expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
      // The original survives ONLY as a blockquoted audit block.
      expect(res.finalText).toContain(`> ${note}`);
      expect(res.finalText).not.toContain(`\n\n${note}`);
      expect(res.finalText.indexOf(ACTION_GUARD_BANNER)).toBeLessThan(res.finalText.indexOf('--- BEGIN STRUCK NOTE'));
      expect(res.notice).toContain('15:03:42Z');
      expect(res.notice).toContain('FUTURE');
      expect(mockUtilityChat).not.toHaveBeenCalled(); // deterministic — no LLM extraction
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
      expect(ticket.type).toBe('mishap');
      // Identical title to the pre-fix strike path — the dedup bucket is shared.
      expect(ticket.title).toBe(`Phantom observation clock: machine note cites future timestamp(s) (chat ${CHAT.slice(0, 8)})`);
      expect(ticket.area).toBe('fleet-integrity');
      expect(ticket.description).toContain('Pre-delivery strike');
      expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
      // Clock-class strike — the correction bubble (ticket a688ba29, the clock
      // lane's 51ed3a65 recurrence hole): names the struck clock(s) and the
      // rule-8 contract so the next wake sees specifics (the redacted generic
      // placeholder gave none — 5 sightings / 2 auto-reopens on chat c0e22e36).
      expect(res.correction).toBeDefined();
      expect(res.correction).toContain('[ACTION VERIFIER — automated integrity check]');
      expect(res.correction).toContain('WITHHELD before delivery');
      expect(res.correction).toContain('15:03:42Z'); // the struck clock named
    });

    it('returns the rule-8 education correction (ticket a688ba29): struck clock(s) named + label/date contracts, no guard chrome', async () => {
      // The literal sighting-3 values (chat c0e22e36, 2026-09-01T00:46:37Z): a
      // projected headline "now" clock ~5 min ahead of the run's real clock.
      const note = '**Fleet wake — 5:52 PM PDT (00:52Z Sep 1) — all lanes healthy, nightly escalated to harness fix**\n\nBody content.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T00:40:00Z'),
        now: new Date('2026-09-01T00:46:37Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toEqual([]);
      const c = res.correction!;
      expect(c).toContain('[ACTION VERIFIER — automated integrity check]');
      expect(c).toContain('WITHHELD before delivery');
      expect(c).toContain('00:52Z'); // the struck token named for the next wake
      expect(c).toContain('rule 8');
      expect(c).toContain('next fire');
      expect(c).toContain('hourly tick');
      expect(c).toContain('watch for');
      expect(c).toContain('… future');
      expect(c).toContain('merged_at 2026-08-30T20:38Z'); // the date-carrying contract (sighting 2 class)
      // No guard chrome in the bubble — it rides model context as a user-role
      // harness message (survives redaction by role gate), never a chrome block.
      expect(c).not.toContain('--- BEGIN STRUCK NOTE');
      expect(c).not.toContain(ACTION_GUARD_BANNER);
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    });

    it('the correction bubble is self-exempting when quoted back verbatim (adversarial review F1): zero future-clock hits at the convicting probe clocks', async () => {
      // F1: a next wake that quotes the correction VERBATIM as plain lines
      // re-struck its struck-clock lines 6× at +5m within minutes of the
      // strike (and again next-day) — the hit lines carried no exemption
      // (no intent/past word, no '>' void-citation prefix, no date pin). The
      // correction's struck lines are now shaped self-exempting on two
      // independent lanes ('> ' + the past-reference word "earlier").
      const note = '**Fleet wake — 5:52 PM PDT (00:52Z Sep 1) — all lanes healthy, nightly escalated to harness fix**\n\nBody content.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T00:40:00Z'),
        now: new Date('2026-09-01T00:46:37Z'),
      });
      expect(res.struck).toBe(true);
      const c = res.correction!;
      for (const l of c.split('\n').filter((l) => l.includes('"00:52Z"') || l.includes('"5:52 PM PDT"'))) {
        expect(l.startsWith('> ')).toBe(true);
        expect(l).toContain('earlier');
      }
      // The reviewer's probe clocks: same-day +5m window (00:47Z), the 90s
      // tolerance edge (00:51Z), hours later, and next-day same clock-of-day.
      for (const probeNow of ['2026-09-01T00:47:00Z', '2026-09-01T00:51:00Z', '2026-09-01T11:15:00Z', '2026-09-02T00:47:00Z']) {
        expect(findFutureObservedTimestamps(c, new Date(probeNow))).toEqual([]);
      }
    });

    it('tool-output PROVENANCE (ticket a688ba29 replay, sighting 6): a forward stamp quoting this run\'s OWN tool output is NOT a fabricated observation', async () => {
      // The recurrence class end-to-end. Sighting 6 verbatim (chat c0e22e36,
      // real clock 2026-09-03T04:12:29Z): the struck "04:40Z" was the bench
      // monitor's nextRunAt, pulled fresh via list_schedules THIS run —
      // quoted forward data, not an invented clock. Pre-fix this struck +28m
      // and replaced the note (the chat-lane materialization of the coding
      // lane's e409e51e "re-armed for collection at 20:05Z" incident).
      const NOW6 = new Date('2026-09-03T04:12:29Z');
      const SCHED_RESULT = '{"schedules":[{"id":"bc7895e4-1111-2222-3333-444444444444","intervalMinutes":30,"nextRunAt":"2026-09-03T04:40:06.386Z","runs":84,"status":"active"}],"count":3}';
      const line = '- **W4A16 vs EXL3 head-to-head** — not stalled, genuinely gated: LEG3X banked on-origin, EXL3 boot #4 still in flight on the dual Sparks; monitor re-armed for 04:40Z';
      // Detector level: exonerated WITH the haystack, convicting without it.
      expect(findFutureObservedTimestamps(line, NOW6, { evidenceHaystacks: [SCHED_RESULT] })).toEqual([]);
      const noProof = findFutureObservedTimestamps(line, NOW6, { evidenceHaystacks: ['unrelated tool output'] });
      expect(noProof).toHaveLength(1);
      expect(noProof[0].token).toBe('04:40Z');
      expect(findFutureObservedTimestamps(line, NOW6)).toHaveLength(1); // pre-fix behavior preserved
      // Guard level: parts carrying the tool_result pass the note through —
      // no strike, no ticket churn (the recurrence class is dead).
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: line, receipts: [],
        parts: [{ type: 'tool_result', name: 'list_schedules', result: SCHED_RESULT }],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-03T04:04:00Z'),
        now: NOW6,
      });
      expect(res.struck).toBe(false);
      expect(res.finalText).toBe(line);
      expect(res.notice).toBe('');
      expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    });

    it('provenance is STAMP-SPECIFIC (a688ba29 anti-smuggle): a co-line phantom clock with no provenance still convicts', () => {
      // The coding lane's "stamp-specific, not haystack-presence" pin, ported:
      // haystacks vouch ONLY for the stamp they carry — an invented clock on
      // the same line still faces conviction.
      const NOW6 = new Date('2026-09-03T04:12:29Z');
      const hits = findFutureObservedTimestamps('monitor re-armed for 04:40Z; observations through 15:03:42Z hold', NOW6, {
        evidenceHaystacks: ['{"nextRunAt":"2026-09-03T04:40:06.386Z"}'],
      });
      expect(hits).toHaveLength(1);
      expect(hits[0].token).toBe('15:03:42Z');
    });

    it('cross-format instant match (9ed46ffe parity): a 12-hour stamp citing the tool output\'s 24h instant exonerates; a different minute convicts', () => {
      const NOW6 = new Date('2026-09-03T04:12:29Z');
      const SCHED_RESULT = '{"nextRunAt":"2026-09-03T04:40:06.386Z"}';
      // 04:40:06Z == 12:40 AM EDT — the verbatim timeKey "12:40" never appears
      // in the result's "04:40"; only the minute-floored INSTANT matches.
      expect(findFutureObservedTimestamps('monitor re-armed for 12:40 AM EDT', NOW6, { evidenceHaystacks: [SCHED_RESULT] })).toEqual([]);
      const miss = findFutureObservedTimestamps('monitor re-armed for 12:41 AM EDT', NOW6, { evidenceHaystacks: [SCHED_RESULT] });
      expect(miss).toHaveLength(1);
      expect(miss[0].token).toBe('12:41 AM EDT');
    });

    it('a bare "HH:MM" in tool output never vouches (P3/P6b parity): only a real CLOCK READING counts as provenance', () => {
      const NOW6 = new Date('2026-09-03T04:12:29Z');
      const hits = findFutureObservedTimestamps('monitor re-armed for 04:40Z', NOW6, {
        evidenceHaystacks: ['step duration 04:40 total'],
      });
      expect(hits).toHaveLength(1);
      expect(hits[0].token).toBe('04:40Z');
    });

    it('the phantom corpus keeps convicting (a8976e11 class): an invented clock carries no provenance — haystacks present, stamp absent', () => {
      // The Re-Send lane's fabricated-audit values with tool outputs that do
      // NOT carry the stamp: phantoms invent clocks; they cannot mint them
      // into real receipts, so the conviction stands.
      const hits = findFutureObservedTimestamps('Audit complete — verified through 15:03:42Z, all green.', new Date('2026-08-27T14:24:28Z'), {
        evidenceHaystacks: ['{"nextRunAt":"2026-08-27T16:40:00Z"}', 'probe output: all queues drained'],
      });
      expect(hits).toHaveLength(1);
      expect(hits[0].token).toBe('15:03:42Z');
    });

    it('cross-attempt provenance (a688ba29 reject-back seam): extraEvidenceHaystacks exonerate a stamp the retry re-cites from the FIRST attempt\'s tool output', async () => {
      // The seam contract: a struck first attempt's tool results ride pass 2,
      // so an honest forward stamp the retry re-cites (the reject-back notice
      // names it) keeps its provenance instead of re-striking.
      const NOW6 = new Date('2026-09-03T04:12:29Z');
      const SCHED_RESULT = '{"nextRunAt":"2026-09-03T04:40:06.386Z"}';
      const line = 'monitor re-armed for 04:40Z';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: line, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-03T04:04:00Z'),
        now: NOW6,
        extraEvidenceHaystacks: [SCHED_RESULT],
      });
      expect(res.struck).toBe(false);
      expect(res.finalText).toBe(line);
      expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
      // Control: same note, no cross-attempt haystack → the strike fires.
      const control = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: line, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-03T04:04:00Z'),
        now: NOW6,
      });
      expect(control.struck).toBe(true);
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    });

    it('toolResultTextsFromParts: ONLY tool_result string results feed the haystack (anti-laundering — model text never vouches)', () => {
      expect(
        toolResultTextsFromParts([
          { type: 'tool_result', name: 'list_schedules', result: '{"nextRunAt":"2026-09-03T04:40:06Z"}' },
          { type: 'text', text: 'model prose mentioning 04:40Z' },
          { type: 'tool_call', name: 'list_schedules', args: '{}' },
          { type: 'tool_result', name: 'x' }, // no result string
        ] as any),
      ).toEqual(['{"nextRunAt":"2026-09-03T04:40:06Z"}']);
      expect(toolResultTextsFromParts(undefined)).toEqual([]);
      expect(toolResultTextsFromParts(null)).toEqual([]);
    });

    it('REPLACES a machine note whose ACTION CLAIMS premise a future clock (the Re-Send fabricated-audit class — replace protection preserved)', async () => {
      // "dispatched" is an action-claim keyword (ACTION_CLAIM_KEYWORD_RE): the
      // action claim rests on the impossible clock, so this is a fabricated
      // audit. Since ticket cdd3fbfe the keyword-free case takes the SAME
      // replacement path (the test above) — this pin guards against a
      // regression of EITHER branch back to delivery.
      const note = 'Verification sweep dispatched — results verified through 15:03:42Z, all green.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-27T14:20:00Z'),
        now: new Date('2026-08-27T14:24:28Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toEqual([]);
      expect(res.finalText).toContain(ACTION_GUARD_BANNER);
      expect(res.finalText).not.toContain('DELIVERED WITH WARNING');
      // Clock-class strike (phantoms: []) — the correction bubble rides too
      // (ticket a688ba29): the seam is not phantom-gated.
      expect(res.correction).toBeDefined();
      expect(res.correction).toContain('15:03:42Z');
      expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
      expect(res.finalText).toContain(`> ${note}`); // original survives as audit-only quote
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      expect((mockFileFeedbackTicket.mock.calls[0][0] as any).description).toContain('Pre-delivery strike');
    });

    it('passes a machine note citing only PAST clocks (real observations)', async () => {
      const note = 'Quiet cycle. Last box probe at 13:24:28Z showed nothing new; the backlog is unchanged from the last wake.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-27T14:20:00Z'),
        now: new Date('2026-08-27T14:24:28Z'),
      });
      expect(res.struck).toBe(false);
      expect(res.finalText).toBe(note);
      expect(res.notice).toBe('');
      expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    });

    it('machineTriggered !== true → pass-through even with a future clock (user turns untouched)', async () => {
      const note = 'I checked everything at 15:03:42Z and it was fine.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: false, supervisor: true, now: new Date('2026-08-27T14:24:28Z'),
      });
      expect(res.struck).toBe(false);
      expect(res.finalText).toBe(note);
      expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    });

    it('a future-intent schedule line is NOT struck (next-fire citations are legitimate)', async () => {
      const note = 'Quiet wake. Next fire 22:30Z; nothing needs the owner right now.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-27T14:20:00Z'),
        now: new Date('2026-08-27T14:24:28Z'),
      });
      expect(res.struck).toBe(false);
      expect(res.finalText).toBe(note);
    });

    it('does NOT strike an ETA/forecast note (ticket 6cd44575): "baseline finishes ~6:30–8:30 PM PDT tonight" is a prediction — the note is delivered and no ticket is filed', async () => {
      // The ticket's scenario end-to-end: supervisor machine wake whose note
      // carries the verbatim struck line; run clock 2026-08-27T23:37:02Z.
      const note = 'Fleet status — 4:34 PM PDT (23:34Z Aug 27)\n\n**Needs the owner:**\n\n- **CanLaw project — judge API key.** The canlaw-1f-r35 baseline finishes ~6:30–8:30 PM PDT tonight (eval lane\'s 23:22Z message). The 3 sonnet-5 judge cells need the key before then.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-08-27T23:34:00Z'),
        now: new Date('2026-08-27T23:37:02.679Z'),
      });
      expect(res.struck).toBe(false);
      expect(res.finalText).toBe(note);
      expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    });
  });

describe('evidence-citation lane — fabricated msg-row receipts in observation prose (ticket c1cbe6a2)', () => {
  // The 12:43Z supervisor incident shape: a VERIFICATION/observation note
  // (zero first-person action verbs — the LLM extractor ignores it by design,
  // the receipt-idiom miner requires first person) citing a message-row
  // receipt that never existed.
  const INCIDENT = 'Verified the Nightly claim-discipline run fired and closed clean: b92ef13f 12:08Z run ran 4/4 verdicts ALL PASS — digest, closure, and queue checks all green; schedule re-armed for 14:08Z (msg e6bf2fda).';

  describe('mineEvidenceCitations — deterministic unit checks', () => {
    it('mines a msg-receipt citation from verification prose with no first-person action verb', () => {
      const mined = mineEvidenceCitations(INCIDENT);
      expect(mined).toHaveLength(1);
      expect(mined[0]).toMatchObject({ kind: 'message', id: 'e6bf2fda' });
      expect(mined[0].detail).toContain('[evidence citation]');
    });

    it('mines parenthesized/backticked/colon-shaped citations and dedupes per id (case-insensitive)', () => {
      const mined = mineEvidenceCitations('Digest sent (msg `2af87ea7`) to the supervisor chat.\nFollow-up msg: 2AF87EA7 confirmed green.');
      expect(mined.map((c) => c.id)).toEqual(['2af87ea7']);
    });

    it('skips absence/refutation prose quoting the id — discussing a phantom must not re-convict', () => {
      expect(mineEvidenceCitations('msg-id prefix e6bf2fda is ABSENT from the transcript window.')).toEqual([]);
      expect(mineEvidenceCitations('There is no such msg e6bf2fda in the Nightly chat.')).toEqual([]);
      expect(mineEvidenceCitations('The msg e6bf2fda receipt never existed — fabricated.')).toEqual([]);
      expect(mineEvidenceCitations('msg e6bf2fda not found in the messages table.')).toEqual([]);
      expect(mineEvidenceCitations('The msg e6bf2fda row is missing from the database.')).toEqual([]);
    });

    it('skips the SEARCH-FAILURE register (review F1 — the 7 honest refutation lines that mined pre-fix)', () => {
      expect(mineEvidenceCitations('Pulls did not find the cited msg e6bf2fda row in the messages table.')).toEqual([]);
      expect(mineEvidenceCitations('Follow-up on the re-arm receipt (msg e6bf2fda): still no row in the messages table.')).toEqual([]);
      expect(mineEvidenceCitations('Re-checked the cited receipt msg e6bf2fda against crossModelMessage — zero rows.')).toEqual([]);
      expect(mineEvidenceCitations('Transcript pulls show nothing matching the msg e6bf2fda prefix.')).toEqual([]);
      expect(mineEvidenceCitations('We could not locate msg e6bf2fda anywhere in the Nightly chat history.')).toEqual([]);
      expect(mineEvidenceCitations('Ticket b84db359 closed as a false positive — the (msg e6bf2fda) citation pointed at nothing.')).toEqual([]);
      expect(mineEvidenceCitations('No evidence of msg e6bf2fda in the transcript window; treating the claim as void.')).toEqual([]);
    });

    it('skips message-native absence verbs (review N1 — the canonical register for refuting a MESSAGE receipt)', () => {
      expect(mineEvidenceCitations('The message citing msg e6bf2fda was never sent, per fresh transcript pulls.')).toEqual([]);
      expect(mineEvidenceCitations('The re-arm notice msg e6bf2fda was not delivered to the Nightly chat.')).toEqual([]);
      expect(mineEvidenceCitations('The steer receipted as msg e6bf2fda never landed in the Nightly chat.')).toEqual([]);
      expect(mineEvidenceCitations('Transcript searches for msg e6bf2fda turned up empty across the whole window.')).toEqual([]);
      expect(mineEvidenceCitations('The database lookup for msg e6bf2fda came back negative.')).toEqual([]);
      expect(mineEvidenceCitations('msg e6bf2fda looks like a ghost entry from an interrupted run.')).toEqual([]);
      expect(mineEvidenceCitations('A stale receipt msg e6bf2fda carried over from a prior wake.')).toEqual([]);
      expect(mineEvidenceCitations('Avoid citing msg e6bf2fda until pulls re-confirm it.')).toEqual([]);
    });

    it('spares the round-3 contraction/judgment/citation-instruction registers (review M1–M4)', () => {
      // M1 — contraction forms of the N1 register + \s+ whitespace robustness
      expect(mineEvidenceCitations("The re-arm msg e6bf2fda wasn't sent after all.")).toEqual([]);
      expect(mineEvidenceCitations("The receipt msg e6bf2fda didn't arrive in the window.")).toEqual([]);
      expect(mineEvidenceCitations('The notice msg e6bf2fda failed to arrive.')).toEqual([]);
      expect(mineEvidenceCitations('The steer msg e6bf2fda never showed up in transcript.')).toEqual([]);
      expect(mineEvidenceCitations('The re-arm  msg  e6bf2fda was never  sent.')).toEqual([]);
      // M2 — unconfirmed beside the covered unverified
      expect(mineEvidenceCitations('msg e6bf2fda unconfirmed after three transcript pulls.')).toEqual([]);
      // M3 — citation-instruction bigram (an innocent bare "avoid" no longer excludes)
      expect(mineEvidenceCitations('Skipped citing msg e6bf2fda in the closure note.')).toEqual([]);
      expect(mineEvidenceCitations('Refrain from citing msg e6bf2fda until it is re-verified.')).toEqual([]);
      expect(mineEvidenceCitations('Avoidance of citing msg e6bf2fda is recommended pending pulls.')).toEqual([]);
      // M4 — judgment nouns / check-out / materializing
      expect(mineEvidenceCitations('That bogus msg e6bf2fda receipt had no row behind it.')).toEqual([]);
      expect(mineEvidenceCitations('A fake msg e6bf2fda citation carried over from the prior wake.')).toEqual([]);
      expect(mineEvidenceCitations("msg e6bf2fda doesn't check out against the transcript.")).toEqual([]);
      expect(mineEvidenceCitations('The schedule line cited msg e6bf2fda without the row ever materializing.')).toEqual([]);
    });

    it('spares determiner/object instruction forms yet still mines claim lines (review M5 — bounded noun gap)', () => {
      expect(mineEvidenceCitations('Avoid msg e6bf2fda citations in closure notes.')).toEqual([]);
      expect(mineEvidenceCitations('Avoid the msg e6bf2fda citation until the pulls land.')).toEqual([]);
      expect(mineEvidenceCitations('Closure notes should avoid the msg e6bf2fda citation this week.')).toEqual([]);
      // A CLAIM line quoting the citation stays mined — >3 words intervene or
      // no cit-word follows "avoid", so the instruction bigram cannot reach it.
      const claim = mineEvidenceCitations('To avoid confusion the closure note quoted msg e6bf2fda verbatim.');
      expect(claim).toHaveLength(1);
      expect(claim[0].id).toBe('e6bf2fda');
    });

    it('skips blockquoted audit lines and honesty-marker lines', () => {
      expect(mineEvidenceCitations('> schedule re-armed for 14:08Z (msg e6bf2fda)')).toEqual([]);
      expect(mineEvidenceCitations('The phantom msg e6bf2fda was struck by the verifier.')).toEqual([]);
      expect(mineEvidenceCitations('msg e6bf2fda UNVERIFIED — no receipt held.')).toEqual([]);
    });

    it('ignores short lines and non-hex tokens after "msg"', () => {
      expect(mineEvidenceCitations('msg ok')).toEqual([]);
      expect(mineEvidenceCitations('The msg queue is empty; nothing to report here at all.')).toEqual([]);
    });
  });

  describe('findPhantomEvidenceCitations — existence exoneration', () => {
    it('convicts a citation whose message row does not exist', async () => {
      const phantoms = await findPhantomEvidenceCitations(INCIDENT, [], async () => false);
      expect(phantoms).toHaveLength(1);
      expect(phantoms[0]).toMatchObject({ kind: 'message', id: 'e6bf2fda' });
    });

    it('exonerates a citation whose message row exists', async () => {
      expect(await findPhantomEvidenceCitations(INCIDENT, [], async () => true)).toEqual([]);
    });

    it('skips ids already carried by an action claim — the tier chain judged them (no double-processing)', async () => {
      const check = jest.fn(async () => false);
      const withClaim = [{ kind: 'message', detail: 'I sent it', id: 'e6bf2fda' } as ExtractedClaim];
      expect(await findPhantomEvidenceCitations(INCIDENT, withClaim, check)).toEqual([]);
      expect(check).not.toHaveBeenCalled();
    });

    it('checks every distinct cited id (review F4) and convicts only the missing rows', async () => {
      const checked: string[] = [];
      const note = 'Digest receipt (msg aaa11111) landed.\nSteer receipt (msg bbb22222) also cited here.\nThird line cites msg aaa11111 once more.';
      const phantoms = await findPhantomEvidenceCitations(note, [], async (id) => { checked.push(id); return id !== 'bbb22222'; });
      expect(checked.sort()).toEqual(['aaa11111', 'bbb22222']);
      expect(phantoms.map((p) => p.id)).toEqual(['bbb22222']);
    });
  });

  describe('citedMessageRowExists — the prisma boundary (mocked)', () => {
    it('prefix-matches short citations and exonerates an existing row', async () => {
      mockPrisma.crossModelMessage.findFirst.mockResolvedValueOnce({ id: 'e6bf2fda-1234-5678-9abc-def012345678' });
      await expect(citedMessageRowExists('e6bf2fda')).resolves.toBe(true);
      expect(mockPrisma.crossModelMessage.findFirst).toHaveBeenCalledWith({ where: { id: { startsWith: 'e6bf2fda' } }, select: { id: true } });
    });

    it('exact-matches full uuids', async () => {
      const full = 'e6bf2fda-1234-5678-9abc-def012345678';
      mockPrisma.crossModelMessage.findFirst.mockResolvedValueOnce({ id: full });
      await expect(citedMessageRowExists(full)).resolves.toBe(true);
      expect(mockPrisma.crossModelMessage.findFirst).toHaveBeenCalledWith({ where: { id: full }, select: { id: true } });
    });

    it('a missing row convicts (returns false)', async () => {
      mockPrisma.crossModelMessage.findFirst.mockResolvedValueOnce(null);
      await expect(citedMessageRowExists('e6bf2fda')).resolves.toBe(false);
    });

    it('fails toward MISS on DB error — an unverifiable citation is never a conviction', async () => {
      mockPrisma.crossModelMessage.findFirst.mockRejectedValueOnce(new Error('db down'));
      await expect(citedMessageRowExists('e6bf2fda')).resolves.toBe(true);
    });
  });

  describe('computePhantomClaims integration — the incident end-to-end', () => {
    beforeEach(() => {
      // The LLM lane contributes nothing (observation prose) — pin it so no
      // leaked implementation from an earlier suite leaks claims in.
      mockUtilityChat.mockResolvedValue('{"claims":[]}');
    });

    it('convicts a fabricated msg citation in a note with ZERO action claims (the early-return gap)', async () => {
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: INCIDENT, parts: [],
        now: new Date('2026-08-29T15:00:00Z'),
      });
      expect(comp.claims).toEqual([]);
      expect(comp.phantoms).toHaveLength(1);
      expect(comp.phantoms[0]).toMatchObject({ kind: 'message', id: 'e6bf2fda' });
      expect(comp.phantoms[0].detail).toContain('[evidence citation]');
    });

    it('audits a SUB-FLOOR note too (review F3): <MIN_NOTE_CHARS still convicts a fabricated citation, zero LLM calls', async () => {
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: 'Re-armed per msg e6bf2fda.', parts: [],
        now: new Date('2026-08-29T15:00:00Z'),
      });
      expect(comp.claims).toEqual([]);
      expect(comp.phantoms).toHaveLength(1);
      expect(comp.phantoms[0]).toMatchObject({ kind: 'message', id: 'e6bf2fda' });
      expect(mockUtilityChat).not.toHaveBeenCalled(); // the deterministic lane runs below the extraction floor
    });

    it('exonerates a citation whose message row exists — observation notes stay delivered', async () => {
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'e6bf2fda-1234-5678-9abc-def012345678' });
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: INCIDENT, parts: [],
        now: new Date('2026-08-29T15:00:00Z'),
      });
      expect(comp.phantoms).toEqual([]);
    });

    it('merges with the action-claim path: an honest receipt-backed claim passes while the fabricated citation convicts', async () => {
      mockUtilityChat.mockResolvedValue(JSON.stringify({
        claims: [{ kind: 'ticket', detail: 'filed a ticket for this pattern', id: 'ab12cd34-9999-8888-7777-666655554444' }],
      }));
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
      const receipt: ToolReceipt = {
        id: 'r1', chatId: CHAT, runId: null, tool: 'file_feedback', ok: true,
        ids: { ticketId: 'ab12cd34-9999-8888-7777-666655554444' },
        inputHash: null, outputHash: null, createdAt: new Date('2026-08-29T11:00:00Z'),
      };
      const note = `${INCIDENT}\nI have filed a ticket for this pattern (ticket id ab12cd34-9999-8888-7777-666655554444) so triage picks it up.`;
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [receipt],
        now: new Date('2026-08-29T15:00:00Z'),
      });
      expect(comp.phantoms).toHaveLength(1);
      expect(comp.phantoms[0]).toMatchObject({ kind: 'message', id: 'e6bf2fda' });
    });

    it('no double-conviction: an id judged by the action tier chain is not re-convicted by the evidence lane', async () => {
      mockUtilityChat.mockResolvedValue(JSON.stringify({
        // (ticket 587e9d64) detail verbatim-grounded in the finalText below —
        // the pre-fix detail 'sent the steer (msg e6bf2fda)' survived nowhere
        // in INCIDENT and was dropped, leaving this test VACUOUS (the length-1
        // assertion held from the citation lane alone).
        claims: [{ kind: 'message', detail: 'sent the steer to the nightly lane', id: 'e6bf2fda' }],
      }));
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
      const comp = await computePhantomClaims({
        // The note carries BOTH the first-person claim and the msg citation
        // for the SAME id: the action tier chain convicts it; the evidence
        // lane must not re-convict (the dedupe under test).
        chatId: CHAT, userId: 'u-1', finalText: `${INCIDENT} Update: I sent the steer to the nightly lane (msg e6bf2fda).`, parts: [],
        now: new Date('2026-08-29T15:00:00Z'),
      });
      expect(comp.phantoms).toHaveLength(1);
    });

    it('the PRE-DELIVERY guard strikes the incident note before it persists', async () => {
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: INCIDENT, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-08-29T12:00:00Z'),
        now: new Date('2026-08-29T15:00:00Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(1);
      expect(res.finalText).toContain(ACTION_GUARD_BANNER);
      expect(res.notice).toContain('[message]');
      expect(res.notice).toContain('e6bf2fda');
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('evidence citation'));
      // The guard writes NO row — the seam injects the returned correction
      // after persisting the replacement (ticket 51ed3a65).
      expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
      expect(res.correction).toContain('WITHHELD before delivery');
      expect(res.correction).toContain('e6bf2fda');
    });
  });
});

describe('citation-class framing — fabricated evidence citations get their own ticket bucket + correction (ticket 5e1ca207 recurrence fix)', () => {
  const PHANTOM_MSG = 'd5bf67be-56b7-4912-ab1e-e0cf97162ff7'; // the ticket's own cited id
  const SURVIVOR = '- Spark cluster: epoch queued behind the gate; gateway task additive-only.';
  const CITE_NOTE = [
    'Fleet sweep — all lanes checked fresh this run.',
    '- Path C lane: hourly tick healthy, 399/500 runs, no stalls.',
    `- Reinstall lane paused per owner ([msg:${PHANTOM_MSG}]): Screen Recording toggle is the only open item.`,
    SURVIVOR,
    'No owner action needed beyond the Reinstall toggle.',
  ].join('\n');

  beforeEach(() => {
    mockUtilityChat.mockResolvedValue('{"claims":[]}' as never); // the deterministic citation lane convicts
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null); // the cited msg row does not exist
  });

  it('classifies deterministic evidence-lane claims as citation-class; action-lane claims are not', () => {
    expect(isCitationClassClaim({ kind: 'message', detail: '[evidence citation] - foo (msg d5bf67be)', id: PHANTOM_MSG })).toBe(true);
    expect(isCitationClassClaim({ kind: 'schedule', detail: '[evidence citation] [sched:08ae015c]', id: '08ae015c' })).toBe(true);
    expect(isCitationClassClaim({ kind: 'message', detail: '[owner chat ref] reply in chat 2d4ff22f', id: '2d4ff22f' })).toBe(true);
    expect(isCitationClassClaim({ kind: 'dispatch', detail: '[dispatch receipt] dispatched session 79464b3d', id: '79464b3d' })).toBe(false);
    expect(isCitationClassClaim({ kind: 'message', detail: 'I sent the steer (receipt 6fbb2f9d)', id: '6fbb2f9d' })).toBe(false);
    expect(allCitationClassClaims([])).toBe(false);
    expect(allCitationClassClaims([
      { kind: 'message', detail: '[evidence citation] x', id: 'aaaaaaaa' },
      { kind: 'schedule', detail: '[evidence citation] y', id: 'bbbbbbbb' },
    ])).toBe(true);
    expect(allCitationClassClaims([
      { kind: 'message', detail: '[evidence citation] x', id: 'aaaaaaaa' },
      { kind: 'message', detail: 'I sent it', id: 'bbbbbbbb' },
    ])).toBe(false);
  });

  it('citation-ONLY strike (pre-delivery, strip+mark): new ticket bucket + citation-class notice/correction', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: CITE_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
    });
    expect(res.struck).toBe(true);
    expect(res.phantoms).toHaveLength(1);
    expect(allCitationClassClaims(res.phantoms)).toBe(true);
    // Strip+mark delivery preserved — survivors reach the thread:
    expect(res.finalText).toContain(ACTION_GUARD_REDACT_BANNER);
    expect(res.finalText).toContain(SURVIVOR);
    // The owner-facing notice names the true failure class:
    expect(res.notice).toContain('cited evidence id(s) that DO NOT EXIST');
    expect(res.notice).not.toContain('claimed action(s) that did NOT execute');
    // The ticket dedups under the citation bucket, NOT the action bucket:
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.title).toBe(`Supervisor fabricated evidence citation: cited id(s) do not exist (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.description).toContain('Fabricated citation(s)');
    expect(ticket.description).not.toContain('Phantom claims:');
    expect(ticket.description).toContain('strip+mark'); // delivery provenance kept
    // The correction teaches the citation lesson, not the action lesson:
    expect(res.correction).toContain('DELIVERED with its unproven claim line(s) REMOVED');
    expect(res.correction).toContain('DO NOT EXIST');
    expect(res.correction).toContain('DROP the citation');
    expect(res.correction).not.toContain('{ok:true, ids:{...}}');
    expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('d5bf67be'));
  });

  it('citation-ONLY strike (full-replacement fallback): WITHHELD correction switches to citation wording', async () => {
    // One line carrying the phantom id → zero survivors → full replacement.
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: `Reinstall paused per owner ([msg:${PHANTOM_MSG}]), toggle pending.`, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
    });
    expect(res.struck).toBe(true);
    expect(res.finalText).toContain(ACTION_GUARD_BANNER);
    expect(res.notice).toContain('cited evidence id(s) that DO NOT EXIST');
    expect(res.correction).toContain('WITHHELD before delivery');
    expect(res.correction).toContain('DO NOT EXIST');
    expect(res.correction).not.toContain('{ok:true, ids:{...}}');
  });

  it('MIXED strike (citation + action claim): the action framing governs the whole strike', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched the cleanup worker', id: 'cafebabe-1234-5678-9abc-def012345678' }],
    }) as never);
    const note = `${CITE_NOTE}\n- I dispatched the cleanup worker (session cafebabe-1234-5678-9abc-def012345678), verdicts pending.`;
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
    });
    expect(res.struck).toBe(true);
    expect(res.phantoms.length).toBeGreaterThanOrEqual(2);
    expect(allCitationClassClaims(res.phantoms)).toBe(false);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.title).toBe(`Supervisor phantom claim: narrated action(s) never executed (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.description).toContain('Phantom claims:');
    expect(res.correction).toContain('{ok:true, ids:{...}}');
  });

  it('citation-ONLY strike (post-delivery lane): ticket bucket + in-thread correction switch wording too', async () => {
    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: CITE_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
    });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect((mockFileFeedbackTicket.mock.calls[0][0] as any).title).toBe(`Supervisor fabricated evidence citation: cited id(s) do not exist (chat ${CHAT.slice(0, 8)})`);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const row = mockPrisma.crossModelMessage.create.mock.calls[0][0] as any;
    expect(row.data.content).toContain('DO NOT EXIST');
    expect(row.data.content).toContain('DROP the citation');
    expect(row.data.content).not.toContain('{ok:true, ids:{...}}');
  });
});

describe('reject-back pre-pass (deferConsequences) — fleet-integrity cluster ba65163d / aac649ba', () => {
  // The machine-wake counterpart of the coding lane's dc04deea gate: the
  // seam's FIRST guard pass defers every side effect (ticket + durable
  // refutation) and rides back a model-context rejectBackNotice, so a struck
  // note gets ONE bounded re-orchestration BEFORE the strike lands on the
  // record. A self-corrected retry produces zero ticket churn; a still-
  // convicted retry is re-guarded with the flag OFF (consequences fire once,
  // on the final answer — the pre-existing tests above pin that path).
  const RB_PHANTOM_MSG = 'd5bf67be-56b7-4912-ab1e-e0cf97162ff7';
  const RB_CITE_NOTE = [
    'Fleet sweep — all lanes checked fresh this run.',
    `- Reinstall lane paused per owner ([msg:${RB_PHANTOM_MSG}]): Screen Recording toggle is the only open item.`,
    '- Spark cluster: epoch queued behind the gate; gateway task additive-only.',
  ].join('\n');

  beforeEach(() => {
    mockUtilityChat.mockResolvedValue('{"claims":[]}' as never); // the deterministic citation lane convicts
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null); // every cited msg id fails the existence check
    mockFileFeedbackTicket.mockClear();
    mockAppendVerifierRefutation.mockClear();
  });

  it('citation strike + deferConsequences:true — full verdict + rejectBackNotice, ZERO side effects', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: RB_CITE_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
      deferConsequences: true,
    });
    // The verdict is complete — the seam needs everything to decide.
    expect(res.struck).toBe(true);
    expect(res.phantoms).toHaveLength(1);
    expect(allCitationClassClaims(res.phantoms)).toBe(true);
    expect(res.correction).toContain('DO NOT EXIST');
    // The notice names the struck id and restates the citation contract.
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).toContain(RB_PHANTOM_MSG);
    expect(res.rejectBackNotice).toContain('VERBATIM in a tool result from THIS run');
    expect(res.rejectBackNotice).toContain('attempted, unverified');
    // …but NOTHING landed on the record: no ticket, no durable refutation.
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
    // The guard still writes NO row — the seam owns all persistence.
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('retry v2 (owner 2026-09-06): the notice lists id prefixes ACTUALLY visible in tool outputs — lookup, not recall', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: RB_CITE_NOTE,
      parts: [
        { type: 'tool_result', result: 'rows: chat a1b2c3d4-0000-0000-0000-000000000000 "Lane A" | sched 99887766 next fire 12:00Z' } as any,
        { type: 'tool_call', name: 'list_chats', args: { note: 'args ids never hint: deadbeef11112222' } } as any,
      ],
      receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
      deferConsequences: true,
    });
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).toContain('ACTUALLY visible');
    expect(res.rejectBackNotice).toContain('a1b2c3d4');
    expect(res.rejectBackNotice).toContain('99887766');
    // tool-CALL args never feed the hint list (laundering rule, outputs only).
    expect(res.rejectBackNotice).not.toContain('deadbeef');
  });

  it('retry v2: no visible ids → no reference line (never an empty list)', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: RB_CITE_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
      deferConsequences: true,
    });
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).not.toContain('ACTUALLY visible');
  });

  it('citation strike + deferConsequences:false (explicit) — consequences fire normally', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: RB_CITE_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
      deferConsequences: false,
    });
    expect(res.struck).toBe(true);
    expect(res.rejectBackNotice).toBeUndefined();
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('d5bf67be'));
  });

  it('citation-strike filing carries containedPreDelivery:true — the aac649ba churn fix: a pre-delivery strike is contained, so its sightings counter-bump a closed ticket instead of reopening it', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: RB_CITE_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
      deferConsequences: false,
    });
    expect(res.struck).toBe(true);
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const filing = mockFileFeedbackTicket.mock.calls[0][0] as any;
    // Whether strip+mark ('redacted') or full replacement ('replaced'), a
    // guardMachineWakeFinalAnswer strike is pre-delivery containment — the
    // marker must ride every filing so feedback.service never reopens on it.
    expect(filing.context.containedPreDelivery).toBe(true);
  });

  it('future-clock strike + deferConsequences:true — verdict + notice, no ticket', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: 'Verification sweep dispatched — results verified through 15:03:42Z, all green.',
      parts: [], receipts: [],
      machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-27T14:20:00Z'),
      now: new Date('2026-08-27T14:24:28Z'),
      deferConsequences: true,
    });
    expect(res.struck).toBe(true);
    expect(res.phantoms).toEqual([]);
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).toContain('15:03:42Z');
    expect(res.rejectBackNotice).toContain('VERBATIM from a clock printed THIS run');
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('CHROME RULE: the rejectBackNotice never carries the harness-only conviction chrome (dc04deea / ac835c00)', async () => {
    const cite = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: RB_CITE_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-01T07:44:00Z'),
      now: new Date('2026-09-01T07:45:00Z'),
      deferConsequences: true,
    });
    const clock = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: 'Verification sweep dispatched — results verified through 15:03:42Z, all green.',
      parts: [], receipts: [],
      machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-27T14:20:00Z'),
      now: new Date('2026-08-27T14:24:28Z'),
      deferConsequences: true,
    });
    for (const notice of [cite.rejectBackNotice, clock.rejectBackNotice]) {
      expect(notice).toBeDefined();
      expect(notice).not.toContain(ACTION_GUARD_BANNER);
      expect(notice).not.toContain(ACTION_GUARD_REDACT_BANNER);
      expect(notice).not.toContain('[ACTION VERIFIER');
      expect(notice).not.toContain('BEGIN STRUCK NOTE');
    }
  });
});

describe('schedule-citation lane — fabricated schedule-row citations in observation prose (ticket 5448a836)', () => {
  // The 2026-08-30 18:34Z supervisor incident shape (4th same-day phantom
  // strike): a fleet-sweep observation note reported the Mac-installer
  // monitor's firing #2 — a fact visible in list_schedules (real row
  // 08ae015c, runs 2/32) — and minted [msg:fa6942ce] for it PLUS an invented
  // schedule id 1fd6a55f. The msg lane struck the first; the invented
  // schedule id rode a coverage gap — no lane audited schedule citations.
  const SCHED_INCIDENT = 'Mac-installer monitor healthy: firing #2 still <0.3.0 (Mac on v0.1.0), probe condition unmet, correctly no-op (schedule 1fd6a55f).';

  describe('mineScheduleCitations — deterministic unit checks', () => {
    it('mines the post-id label form "`id` (sched)" — the fleet contract idiom the session-ref lane now skips (ticket ca153ef8)', () => {
      expect(mineScheduleCitations('TT lane `1fbe4800-3f1b-4b60-a154-b7118bae3854` (sched) active, next fire 22:58:37Z.').map((c) => c.id)).toEqual(['1fbe4800-3f1b-4b60-a154-b7118bae3854']);
      expect(mineScheduleCitations('Monitor 08ae015c (schedule) firing on cadence this wake.').map((c) => c.id)).toEqual(['08ae015c']);
      // The label is REQUIRED — a bare id after a session noun is NOT a schedule
      // citation (the session/chat-ref lane owns that form).
      expect(mineScheduleCitations('TT lane 1fbe4800 active, next fire 22:58:37Z.')).toEqual([]);
    });
    it('mines a schedule citation from observation prose with no first-person action verb', () => {
      const mined = mineScheduleCitations(SCHED_INCIDENT);
      expect(mined).toHaveLength(1);
      expect(mined[0]).toMatchObject({ kind: 'schedule', id: '1fd6a55f' });
      expect(mined[0].detail).toContain('[evidence citation]');
    });

    it('mines the fleet\'s real citation shapes (colon idiom, backticked noun, hyphenated once-schedule) and dedupes per id', () => {
      const note = [
        'Harness continuation intact [sched:2ffa817e] — fires 18:42Z on the ops lane chat.',
        'The once-schedule `104d0f81` auto-retired after 0 runs — platform cleanup.',
        'Bench monitor schedule `bc7895e4` fires 19:04Z; re-checking SCHED: 2FFA817E below.',
        'Follow-up: sched 2ffa817e again — dedupe keeps the first only.',
      ].join('\n');
      expect(mineScheduleCitations(note).map((c) => c.id)).toEqual(['2ffa817e', '104d0f81', 'bc7895e4']);
    });

    it('does NOT mine the plural/participle shapes that never carry an id ("scheduled firing", "Schedules")', () => {
      expect(mineScheduleCitations('The scheduled firing landed at 18:33Z per the sweeper, all green.')).toEqual([]);
      expect(mineScheduleCitations('Schedules auto-disabled: two stale once-schedules retired by the platform.')).toEqual([]);
      expect(mineScheduleCitations('Reschedule the cadence next wake if the lane stays busy.')).toEqual([]);
    });

    it('skips absence/refutation prose quoting the id — discussing a phantom must not re-convict', () => {
      expect(mineScheduleCitations('There is no such schedule 1fd6a55f in the schedules table.')).toEqual([]);
      expect(mineScheduleCitations('The schedule id 1fd6a55f never existed — fabricated.')).toEqual([]);
      expect(mineScheduleCitations('Cited schedule 1fd6a55f not found in coding_schedules.')).toEqual([]);
      expect(mineScheduleCitations('schedule 1fd6a55f unverified — pulled list_schedules twice this run.')).toEqual([]);
    });

    it('skips the preamble\'s own incident-example register (adversarial-review follow-up: rule 6 quotes the 18:34Z incident with the verb "minted")', () => {
      // machine-wake.ts rule 6 names [msg:fa6942ce] + schedule id 1fd6a55f as
      // the worked example; a note paraphrasing it must not false-mine the
      // example ids. The 'mint\w*' register sits beside 'invented' in the
      // shared EVIDENCE_EXCLUSION — both pins FAIL without it.
      expect(mineScheduleCitations('The incident example cites schedule 1fd6a55f, minted rather than pulled this run.')).toEqual([]);
      expect(mineEvidenceCitations('As rule 6 records, the 18:34Z wake minted [msg:fa6942ce] for a list_schedules observation.')).toEqual([]);
      // The verbatim rule-6 tail never mines in either lane (regression pin).
      expect(mineScheduleCitations('the 18:34Z wake instead minted [msg:fa6942ce] for exactly that list_schedules observation and an invented schedule id 1fd6a55f (the real row was 08ae015c) — both struck as phantoms.')).toEqual([]);
    });

    it('skips blockquoted audit lines (struck-note quotes)', () => {
      expect(mineScheduleCitations('> Mac-installer monitor correctly no-op (schedule 1fd6a55f) — quoted from the struck note.')).toEqual([]);
    });
  });

  describe('findPhantomScheduleCitations — existence exoneration', () => {
    it('convicts a citation whose schedule row does not exist', async () => {
      const phantoms = await findPhantomScheduleCitations(SCHED_INCIDENT, [], async () => false);
      expect(phantoms).toHaveLength(1);
      expect(phantoms[0]).toMatchObject({ kind: 'schedule', id: '1fd6a55f' });
    });

    it('exonerates a citation whose schedule row exists', async () => {
      expect(await findPhantomScheduleCitations(SCHED_INCIDENT, [], async () => true)).toEqual([]);
    });

    it('skips ids already carried by an action claim — the tier chain judged them (no double-processing)', async () => {
      const check = jest.fn(async () => false);
      const withClaim = [{ kind: 'schedule', detail: 'I updated it', id: '1fd6a55f' } as ExtractedClaim];
      expect(await findPhantomScheduleCitations(SCHED_INCIDENT, withClaim, check)).toEqual([]);
      expect(check).not.toHaveBeenCalled();
    });

    it('checks every distinct cited id and convicts only the missing rows', async () => {
      const checked: string[] = [];
      const note = 'Monitor schedule aaa11111 fired twice.\nContinuation schedule bbb22222 also cited here.\nThird line cites schedule aaa11111 once more.';
      const phantoms = await findPhantomScheduleCitations(note, [], async (id) => { checked.push(id); return id !== 'bbb22222'; });
      expect(checked.sort()).toEqual(['aaa11111', 'bbb22222']);
      expect(phantoms.map((p) => p.id)).toEqual(['bbb22222']);
    });

    it('routes the post-id label form through existence — fabricated "(sched)" ids convict, real rows exonerate (ticket ca153ef8)', async () => {
      const note = 'TT lane `1fbe4800-3f1b-4b60-a154-b7118bae3854` (sched) active, next fire 22:58:37Z — Window H execution re-runs there.';
      // Fabricated schedule id → phantom (the escape class the session-ref
      // skip would have created without this routing, review F2).
      const phantoms = await findPhantomScheduleCitations(note, [], async () => false);
      expect(phantoms).toHaveLength(1);
      expect(phantoms[0]).toMatchObject({ kind: 'schedule', id: '1fbe4800-3f1b-4b60-a154-b7118bae3854' });
      // Real schedule row → exonerated (the incident line's actual state).
      expect(await findPhantomScheduleCitations(note, [], async () => true)).toEqual([]);
    });

    it('fails toward MISS when the injected check rejects — an unverifiable citation is never a conviction', async () => {
      expect(await findPhantomScheduleCitations(SCHED_INCIDENT, [], async () => { throw new Error('db down'); })).toEqual([]);
    });
  });

  describe('citedScheduleRowExists — the prisma boundary (mocked)', () => {
    it('prefix-matches short citations and exonerates an existing row', async () => {
      mockPrisma.codingSchedule.findFirst.mockResolvedValueOnce({ id: '1fd6a55f-1234-5678-9abc-def012345678' });
      await expect(citedScheduleRowExists('1fd6a55f')).resolves.toBe(true);
      expect(mockPrisma.codingSchedule.findFirst).toHaveBeenCalledWith({ where: { id: { startsWith: '1fd6a55f' } }, select: { id: true } });
    });

    it('exact-matches full uuids', async () => {
      const full = '1fd6a55f-1234-5678-9abc-def012345678';
      mockPrisma.codingSchedule.findFirst.mockResolvedValueOnce({ id: full });
      await expect(citedScheduleRowExists(full)).resolves.toBe(true);
      expect(mockPrisma.codingSchedule.findFirst).toHaveBeenCalledWith({ where: { id: full }, select: { id: true } });
    });

    it('a missing row convicts (returns false)', async () => {
      mockPrisma.codingSchedule.findFirst.mockResolvedValueOnce(null);
      await expect(citedScheduleRowExists('1fd6a55f')).resolves.toBe(false);
    });

    it('fails toward MISS on DB error — an unverifiable citation is never a conviction', async () => {
      mockPrisma.codingSchedule.findFirst.mockRejectedValueOnce(new Error('db down'));
      await expect(citedScheduleRowExists('1fd6a55f')).resolves.toBe(true);
    });
  });

  describe('computePhantomClaims + guard integration — the incident end-to-end', () => {
    beforeEach(() => {
      // The LLM lane contributes nothing (observation prose) — pin it so no
      // leaked implementation from an earlier suite leaks claims in.
      mockUtilityChat.mockResolvedValue('{"claims":[]}');
    });

    it('convicts the incident note\'s invented schedule id in a note with ZERO action claims', async () => {
      mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: SCHED_INCIDENT, parts: [],
        now: new Date('2026-08-30T18:35:00Z'),
      });
      expect(comp.claims).toEqual([]);
      expect(comp.phantoms).toHaveLength(1);
      expect(comp.phantoms[0]).toMatchObject({ kind: 'schedule', id: '1fd6a55f' });
      expect(comp.phantoms[0].detail).toContain('[evidence citation]');
    });

    it('audits a SUB-FLOOR note too: <MIN_NOTE_CHARS still convicts a fabricated schedule citation, zero LLM calls', async () => {
      mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: 'Per schedule 1fd6a55f.', parts: [],
        now: new Date('2026-08-30T18:35:00Z'),
      });
      expect(comp.claims).toEqual([]);
      expect(comp.phantoms).toHaveLength(1);
      expect(comp.phantoms[0]).toMatchObject({ kind: 'schedule', id: '1fd6a55f' });
      expect(mockUtilityChat).not.toHaveBeenCalled(); // the deterministic lane runs below the extraction floor
    });

    it('exonerates a citation whose schedule row exists — honest observation notes stay delivered', async () => {
      mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: '08ae015c-be88-432e-8816-9ce6a7ec803e' });
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1',
        finalText: 'Mac-installer monitor firing #2, still <0.3.0, correctly no-op [sched:08ae015c].',
        parts: [], now: new Date('2026-08-30T18:35:00Z'),
      });
      expect(comp.phantoms).toEqual([]);
    });

    it('merges with the msg lane: the incident\'s invented msg id convicts while a REAL schedule citation exonerates', async () => {
      // The exact 18:34Z incident pairing, with the schedule id corrected to
      // the real row: msg probe misses (phantom), schedule probe hits.
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
      mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: '08ae015c-be88-432e-8816-9ce6a7ec803e' });
      const note = 'Mac-installer monitor firing #2, still <0.3.0, correctly no-op [msg:fa6942ce] — monitor schedule 08ae015c healthy per list_schedules runs 2/32.';
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [],
        now: new Date('2026-08-30T18:35:00Z'),
      });
      expect(comp.phantoms).toHaveLength(1);
      expect(comp.phantoms[0]).toMatchObject({ kind: 'message', id: 'fa6942ce' });
    });

    it('the PRE-DELIVERY guard strikes the incident note before it persists, rendering the [schedule] claim', async () => {
      mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: SCHED_INCIDENT, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-08-30T18:34:00Z'),
        now: new Date('2026-08-30T18:35:00Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(1);
      expect(res.finalText).toContain(ACTION_GUARD_BANNER);
      expect(res.notice).toContain('[schedule]');
      expect(res.notice).toContain('1fd6a55f');
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('evidence citation'));
    });

    it('review B1 (ticket 65239c9a): a keyword-free NON-supervisor wake citing an INVENTED sched id beside a future fire-time clock still convicts — the citation-idiom disjunct reaches the existence lane', async () => {
      // Pre-B1 the guard's non-supervisor gate (keywords + chat-ref idiom only)
      // returned pass BEFORE computePhantomClaims: the (a2) clock lane exempts
      // the ledger line (SCHED_ARTIFACT_LINE_RE) and "sched <id>" is no action
      // keyword, so the invented id escaped every audit and the note delivered.
      // The fixture is keyword-free by construction (checked against
      // ACTION_CLAIM_KEYWORD_RE) — only the new disjunct lets it through.
      mockPrisma.codingSchedule.findFirst.mockResolvedValue(null); // invented id — no row
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1',
        finalText: '- [sched:1fd6a55f] — lane audit: the 15:03:42Z probe showed all green, tally 5/5.',
        parts: [], receipts: [],
        machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-30T14:20:00Z'),
        now: new Date('2026-08-30T14:24:28Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(1);
      expect(res.phantoms[0]).toMatchObject({ kind: 'schedule', id: '1fd6a55f' });
      expect(res.notice).toContain('1fd6a55f');
    });

    it('review B1 counterpart: the same ledger line citing a REAL schedule row passes unstruck — honest fire-time notes stay delivered', async () => {
      mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: '08ae015c-be88-432e-8816-9ce6a7ec803e' });
      const finalText = '- [sched:08ae015c] — lane audit: the 15:03:42Z probe showed all green, tally 5/5.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText,
        parts: [], receipts: [],
        machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-30T14:20:00Z'),
        now: new Date('2026-08-30T14:24:28Z'),
      });
      expect(res.struck).toBe(false);
      expect(res.finalText).toBe(finalText);
    });
  });

  describe('hasScheduleCitationIdiom — the B1 gate disjunct (ticket 65239c9a review)', () => {
    it('detects both taught citation idioms and ignores id-free prose', () => {
      expect(hasScheduleCitationIdiom('Lane healthy [sched:08ae015c].')).toBe(true);
      expect(hasScheduleCitationIdiom('Recurring nudge — sched `2ffa817e` on the ops lane.')).toBe(true);
      expect(hasScheduleCitationIdiom('Monitor `1fbe4800` (sched) still active.')).toBe(true);
      expect(hasScheduleCitationIdiom('Schedule review done — no citation id anywhere.')).toBe(false);
      expect(hasScheduleCitationIdiom('')).toBe(false);
      expect(hasScheduleCitationIdiom(null)).toBe(false);
    });
  });
});

describe('session/chat-reference lane — phantom dispatch receipts + owner-item chat refs (ticket f1cb73ff)', () => {
  // The confirmed 2026-08-29 incident shape (DB-verified): the fleet
  // supervisor's machine-wake notes claimed a dispatch, tracked a session with
  // elapsed-time updates, and nagged the owner to reply in a chat — none of
  // the three ids exists in crossmodel_chats or coding_sessions. All are
  // observation/status prose: the LLM extractor ignores them by design, the
  // receipt-idiom miner requires a first-person verb, and the evidence lane
  // only mines `msg <id>`.
  const INCIDENT_NOTE = [
    'Fleet wake 07:12Z — burn-down status, fresh pull this wake.',
    'Dispatched session 1ca12570-0921-4a94-a857-f0b9b75f8933 for the bench replication lane.',
    'Session 79464b3d RUNNING ~70 min — no verdict lines yet on the latest pull.',
    'Owner action: reply in chat 2d4ff22f — the go/no-go on the disk prune is still open.',
  ].join('\n');

  beforeEach(() => {
    mockUtilityChat.mockResolvedValue('{"claims":[]}');
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  });

  describe('mineSessionChatReferences — deterministic unit checks', () => {
    it('mines the incident: verb-first dispatch receipt, status-tail session tracking, and the owner chat ref', () => {
      const mined = mineSessionChatReferences(INCIDENT_NOTE);
      expect(mined).toHaveLength(3);
      expect(mined[0]).toMatchObject({ kind: 'dispatch', id: '1ca12570-0921-4a94-a857-f0b9b75f8933' });
      expect(mined[0].detail).toContain('[dispatch receipt]');
      expect(mined[1]).toMatchObject({ kind: 'dispatch', id: '79464b3d' });
      expect(mined[2]).toMatchObject({ kind: 'message', id: '2d4ff22f' });
      expect(mined[2].detail).toContain('[owner chat ref]');
    });

    it('mines the elapsed-time tracking idiom without a status verb ("session X ~70 min in")', () => {
      const mined = mineSessionChatReferences('Session 79464b3d ~70 min in, no verdict lines on the latest pull.');
      expect(mined.map((c) => c.id)).toEqual(['79464b3d']);
    });

    it('mines the status-tail owner ref ("chat X waiting …") and dedupes per (kind, id)', () => {
      const mined = mineSessionChatReferences(
        'Chat 2d4ff22f waiting on your go/no-go for the prune.\nReply when you can in chat 2d4ff22f — still pending.',
      );
      expect(mined).toHaveLength(1);
      expect(mined[0]).toMatchObject({ kind: 'message', id: '2d4ff22f' });
    });

    it('skips blockquoted audit lines — quotes of struck notes must not re-convict', () => {
      expect(mineSessionChatReferences('> Session 79464b3d RUNNING ~70 min — quoted from the struck note')).toEqual([]);
      expect(mineSessionChatReferences('> Owner action: reply in chat 2d4ff22f — the go/no-go is open.')).toEqual([]);
    });

    it('skips explicitly NON-SESSION-labeled ids — "`id` (sched) active" is an evidence citation, not a dispatch receipt (ticket ca153ef8)', () => {
      // The 2026-08-30 22:53Z supervisor wake, verbatim incident line: the note followed
      // the evidence contract (fresh pull, verbatim id, (sched) label) and was convicted
      // as a phantom dispatch because the (a2) status-tail pattern matched "lane <id> … active".
      expect(mineSessionChatReferences('- **Schedules** (fresh `list_schedules`): TT lane `1fbe4800-3f1b-4b60-a154-b7118bae3854` (sched) active, next fire 22:58:37Z — Window H execution re-runs there.')).toEqual([]);
      // (schedule) variant + the 8-char prefix citation idiom skip too.
      expect(mineSessionChatReferences('Lane 79464b3d-1234-4321-8abc-555566667777 (schedule) active and healthy this wake.')).toEqual([]);
      expect(mineSessionChatReferences('TT lane `1fbe4800` (sched) active, fires again in 15 min.')).toEqual([]);
      // Every OTHER parenthesized label still mines (review F2): a contradictory
      // label on a session-noun receipt is not an audit escape — the chat/session
      // existence check still decides.
      for (const label of ['ticket', 'goal', 'todo', 'msg', 'run', 'deploy', 'receipt']) {
        expect(mineSessionChatReferences(`Lane 79464b3d-1234-4321-8abc-555566667777 (${label}) active and healthy this wake.`)).toHaveLength(1);
      }
    });

    it('pins the CAPTURED id via d-flag indices — a repeated id in the verb-gap cannot mis-anchor the label test (review F1)', () => {
      // Label after the GAP occurrence; the captured receipt id is unlabeled →
      // still mines (the pre-fix indexOf anchored the gap copy and false-skipped).
      expect(mineSessionChatReferences('Dispatched 79464b3d (sched) cleanup session 79464b3d for the audit lane.')).toHaveLength(1);
      expect(mineSessionChatReferences('Reply re 79464b3d (sched) in chat 79464b3d when free, owner.')).toHaveLength(1);
      // Label after the CAPTURED id → skipped here, owned by the schedule lane
      // (see the schedule-lane post-id tests for the routing end).
      expect(mineSessionChatReferences('Dispatched session 79464b3d (sched) for the audit lane.')).toEqual([]);
    });

    it('still mines session-typed and unlabeled receipts — the label skip cannot gut dispatch detection (ticket ca153ef8 anti-gut)', () => {
      // Unlabeled status-tail + verb-first receipts still mine.
      expect(mineSessionChatReferences('Session 79464b3d RUNNING — verdicts due next wake.')).toHaveLength(1);
      expect(mineSessionChatReferences('Dispatched session 79464b3d for the cleanup lane this wake.')).toHaveLength(1);
      expect(mineSessionChatReferences('Lane 79464b3d active and mid-run on its hourly firing.')).toHaveLength(1);
      // Session-typed labels ((chat)) are NOT skipped — chat/session existence exonerates downstream.
      const mined = mineSessionChatReferences('Path C lane cec340f2-f605-4370-b87a-d85b59cb243f (chat) running on its 22:53:38Z hourly firing.');
      expect(mined).toHaveLength(1);
      expect(mined[0]).toMatchObject({ kind: 'dispatch', id: 'cec340f2-f605-4370-b87a-d85b59cb243f' });
    });

    it('skips HISTORICAL mentions — "was deleted"/"no longer exists" prose about a gone artifact must not be flagged', () => {
      expect(mineSessionChatReferences('Session 79464b3d was deleted after the cleanup; nothing running there now.')).toEqual([]);
      expect(mineSessionChatReferences('Chat 2d4ff22f no longer exists — the owner archived it last week; item needs closing.')).toEqual([]);
      expect(mineSessionChatReferences('The worktree for session 1ca12570 was removed when the lane finished running.')).toEqual([]);
    });

    it('skips refutation/absence prose — a note DISCUSSING a phantom must not re-convict', () => {
      expect(mineSessionChatReferences('The verifier struck session 79464b3d as a phantom dispatch receipt — still running nowhere.')).toEqual([]);
      expect(mineSessionChatReferences('No such session 1ca12570 exists in coding_sessions — the dispatched claim was fabricated.')).toEqual([]);
      expect(mineSessionChatReferences('Never dispatched session 79464b3d — that receipt is unverified pending a fresh pull.')).toEqual([]);
    });

    it('skips FAILURE-register prose — a dispatch that failed never created the artifact; flagging it strikes an honest note', () => {
      // Battery-confirmed false-strike class on the pre-fix register (FW29-B follow-up,
      // 2026-08-29): all five lines MINED before the failure register was added — and
      // the existence check then convicts, because the id genuinely does not exist
      // BECAUSE the dispatch failed. Conviction would replace an honest failure note.
      expect(mineSessionChatReferences('I dispatched session 3bd727f6 for the verify-herd fix, but the dispatch failed with a 409 — nothing was created.')).toEqual([]);
      expect(mineSessionChatReferences('Dispatch failed: session 3bd727f6 was never created.')).toEqual([]);
      expect(mineSessionChatReferences('I dispatched session 3bd727f6; the tool call errored and no session exists.')).toEqual([]);
      expect(mineSessionChatReferences('The dispatch of worker 3bd727f6 never happened — the API returned an error.')).toEqual([]);
      expect(mineSessionChatReferences('Started lane 3bd727f6 for C1 — start failed; no lane exists.')).toEqual([]);
    });

    it('failure-register exclusions do NOT exonerate phantom success claims — the incident class still mines', () => {
      // Companion guard: the extended register must not blunt what the lane exists to
      // catch. Phantom prose claims SUCCESS (running/elapsed/pending) and carries no
      // failure vocabulary, so these keep mining. (INFRA-note canary: "failover" must
      // NOT trip the fail idiom — it is suffix-bounded.)
      expect(mineSessionChatReferences('I dispatched session 1ca12570 and it is running well, ~25 min elapsed.')).toHaveLength(1);
      expect(mineSessionChatReferences('Dispatched session 79464b3d per directive 1174b4c2 — RUNNING ~70 min.')).toHaveLength(1);
      expect(mineSessionChatReferences('Reply in chat 2d4ff22f is still pending — no assistant reply yet.')).toHaveLength(1);
      expect(mineSessionChatReferences('After the failover I dispatched session 79464b3d — it is running fine now.')).toHaveLength(1);
    });

    it('skips ids inside QUOTED user text — someone else\'s words are a citation, not this note\'s claim', () => {
      expect(mineSessionChatReferences('The owner wrote: "please reply in chat 2d4ff22f" and I logged the request.')).toEqual([]);
      expect(mineSessionChatReferences('Their update said "session 79464b3d RUNNING fine" and the queue held steady.')).toEqual([]);
      // Backticked ids are the fleet's OWN citation style — they still mine.
      expect(mineSessionChatReferences('Dispatched session `79464b3d` for the burn-down replication lane.')).toHaveLength(1);
    });

    it('never mines a bare unanchored mention (no verb, no status) — plain truthful references cost nothing', () => {
      expect(mineSessionChatReferences('Reviewed chat 2d4ff22f context and the queue looks healthy this wake.')).toEqual([]);
      expect(mineSessionChatReferences('Session 79464b3d closed clean per the transcript; verdicts all tallied.')).toEqual([]);
    });

    it('intent lines ("will dispatch") do not mine — matches the citation-lane convention', () => {
      expect(mineSessionChatReferences('Next wake I will dispatch session 79464b3d again if the queue backs up.')).toEqual([]);
    });

    it('plural list forms are a documented residual — under-broad is the fail-safe direction', () => {
      expect(mineSessionChatReferences('Dispatched sessions 23a1e15e, 52ec57b9 for the burn-down queue this wake.')).toEqual([]);
    });
  });

  describe('findPhantomSessionRefs — executed-actions cross-check then existence exoneration', () => {
    const statusNote = 'Session 79464b3d RUNNING ~70 min — no verdict lines yet on the latest pull.';

    it('convicts a reference whose chat/session row does not exist', async () => {
      const phantoms = await findPhantomSessionRefs(INCIDENT_NOTE, [], [], async () => false);
      expect(phantoms).toHaveLength(3);
      expect(phantoms.map((p) => p.id)).toEqual(['1ca12570-0921-4a94-a857-f0b9b75f8933', '79464b3d', '2d4ff22f']);
    });

    it('exonerates a reference whose row exists (real existing id passes)', async () => {
      expect(await findPhantomSessionRefs(INCIDENT_NOTE, [], [], async () => true)).toEqual([]);
    });

    it('a dispatch verified by an executed-actions record passes WITHOUT a DB probe — receipts beat existence', async () => {
      const check = jest.fn(async () => false);
      const dispatched: ExecutedAction = {
        tool: 'start_coding_session', ok: true, staged: false,
        ids: { sessionId: '79464b3d-1111-2222-3333-444455556666' },
      };
      expect(await findPhantomSessionRefs(statusNote, [], [dispatched], check)).toEqual([]);
      expect(check).not.toHaveBeenCalled();
    });

    it('a FAILED execution does not exonerate — the row check still decides', async () => {
      const failed: ExecutedAction = {
        tool: 'start_coding_session', ok: false, staged: false,
        ids: { sessionId: '79464b3d-1111-2222-3333-444455556666' },
      };
      const phantoms = await findPhantomSessionRefs(statusNote, [], [failed], async () => false);
      expect(phantoms).toHaveLength(1);
    });

    it('skips ids already carried by an action claim (prefix-tolerant) — the tier chain judged them', async () => {
      const check = jest.fn(async () => false);
      const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'dispatched it', id: '79464B3D-1111-2222-3333-444455556666' }];
      expect(await findPhantomSessionRefs(statusNote, claims, [], check)).toEqual([]);
      expect(check).not.toHaveBeenCalled();
    });
  });

  describe('citedChatOrSessionExists — the prisma boundary (mocked)', () => {
    it('prefix-matches short citations against crossmodel_chats and exonerates an existing row', async () => {
      mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: '79464b3d-1111-2222-3333-444455556666' });
      await expect(citedChatOrSessionExists('79464b3d')).resolves.toBe(true);
      expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({ where: { id: { startsWith: '79464b3d' } }, select: { id: true } });
      expect(mockPrisma.chatCodingState.findFirst).not.toHaveBeenCalled();
    });

    it('falls through to coding_sessions when the chat row is missing', async () => {
      mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce(null);
      mockPrisma.chatCodingState.findFirst.mockResolvedValueOnce({ id: '79464b3d-1111-2222-3333-444455556666' });
      await expect(citedChatOrSessionExists('79464b3d')).resolves.toBe(true);
      expect(mockPrisma.chatCodingState.findFirst).toHaveBeenCalledWith({ where: { id: { startsWith: '79464b3d' } }, select: { id: true } });
    });

    it('exact-matches full uuids and convicts when BOTH tables miss', async () => {
      const full = '1ca12570-0921-4a94-a857-f0b9b75f8933';
      await expect(citedChatOrSessionExists(full)).resolves.toBe(false);
      expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({ where: { id: full }, select: { id: true } });
      expect(mockPrisma.chatCodingState.findFirst).toHaveBeenCalledWith({ where: { id: full }, select: { id: true } });
    });

    it('fails toward MISS on DB error — an unverifiable citation is never a conviction', async () => {
      mockPrisma.crossModelChat.findFirst.mockRejectedValueOnce(new Error('db down'));
      await expect(citedChatOrSessionExists('79464b3d')).resolves.toBe(true);
    });
  });

  describe('computePhantomClaims integration — the incident end-to-end', () => {
    it('convicts all three phantom references in a note with ZERO action claims and arms the supervisor refutation writer', async () => {
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
        supervisor: true, runStartedAt: new Date('2026-08-29T07:00:00Z'),
      });
      expect(comp.claims).toEqual([]); // both action extractors miss BY DESIGN — the lane must not depend on them
      expect(comp.phantoms).toHaveLength(3);
      expect(comp.phantoms.map((p) => p.id)).toEqual(['1ca12570-0921-4a94-a857-f0b9b75f8933', '79464b3d', '2d4ff22f']);
      expect(comp.phantoms[0].detail).toContain('[dispatch receipt]');
      expect(comp.phantoms[2].detail).toContain('[owner chat ref]');
      expect(typeof comp.appendRefutation).toBe('function');
    });

    it('exonerates references whose rows exist — honest cross-wake tracking notes stay delivered', async () => {
      mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'any-row' });
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
        supervisor: true, runStartedAt: new Date('2026-08-29T07:00:00Z'),
      });
      expect(comp.phantoms).toEqual([]);
    });

    it('a dispatch receipted THIS run is exonerated by the executed pool — no DB probe for it', async () => {
      const receipt: ToolReceipt = {
        id: 'r-disp', chatId: CHAT, runId: null, tool: 'start_coding_session', ok: true,
        ids: { sessionId: '79464b3d-1111-2222-3333-444455556666' },
        inputHash: null, outputHash: null, createdAt: new Date('2026-08-29T07:05:00Z'),
      };
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: 'Session 79464b3d RUNNING ~5 min in — dispatch receipted, verdicts pending.', parts: [],
        receipts: [receipt], supervisor: true, runStartedAt: new Date('2026-08-29T07:00:00Z'),
      });
      expect(comp.phantoms).toEqual([]);
      expect(mockPrisma.crossModelChat.findFirst).not.toHaveBeenCalled();
    });

    it('audits a SUB-FLOOR note too: <MIN_NOTE_CHARS still convicts a phantom dispatch receipt, zero LLM calls', async () => {
      const comp = await computePhantomClaims({
        chatId: CHAT, userId: 'u-1', finalText: 'Dispatched session 79464b3d.', parts: [],
      });
      expect(comp.phantoms).toHaveLength(1);
      expect(comp.phantoms[0]).toMatchObject({ kind: 'dispatch', id: '79464b3d' });
      expect(mockUtilityChat).not.toHaveBeenCalled();
    });

    it('the PRE-DELIVERY guard strikes the incident note before it persists (supervisor wake)', async () => {
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
        machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-08-29T07:00:00Z'),
        now: new Date('2026-08-29T07:20:00Z'), // after the note's 07:12Z stamp — the clock lane stays quiet
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(3);
      expect(res.finalText).toContain(ACTION_GUARD_BANNER);
      expect(res.notice).toContain('[dispatch]');
      expect(res.notice).toContain('[message]');
      expect(res.notice).toContain('2d4ff22f');
      expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
      expect((mockFileFeedbackTicket.mock.calls[0][0] as any).title).toContain('Supervisor phantom claim');
      expect(mockAppendVerifierRefutation).toHaveBeenCalledWith(CHAT, 'u-1', expect.stringContaining('dispatch receipt'));
      // The guard writes NO row — the seam injects the returned correction
      // after persisting the replacement (ticket 51ed3a65).
      expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
      expect(res.correction).toContain('WITHHELD before delivery');
      expect(res.correction).toContain('2d4ff22f');
    });

    it('gate extension: a NON-supervisor machine wake with a keyword-free owner chat ref still reaches the matcher and is struck', async () => {
      const note = 'Owner: reply in chat 2d4ff22f — the go/no-go is still open and blocking the prune.';
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
        machineTriggered: true, supervisor: false, runStartedAt: new Date('2026-08-29T07:00:00Z'),
        now: new Date('2026-08-29T07:20:00Z'),
      });
      expect(res.struck).toBe(true);
      expect(res.phantoms).toHaveLength(1);
      expect(res.phantoms[0]).toMatchObject({ kind: 'message', id: '2d4ff22f' });
      expect((mockFileFeedbackTicket.mock.calls[0][0] as any).area).toBe('fleet-integrity');
      expect(mockAppendVerifierRefutation).not.toHaveBeenCalled(); // no state doc off-supervisor
    });

    it('gate precision: an idiom-free, keyword-free machine wake still passes through with zero audit work', async () => {
      expect(hasSessionChatRefIdiom('Owner: the go/no-go in the prune chat is still open; nothing else this wake.')).toBe(false);
      const res = await guardMachineWakeFinalAnswer({
        chatId: CHAT, userId: 'u-1', finalText: 'Owner: the go/no-go in the prune chat is still open; nothing else this wake.',
        parts: [], receipts: [], machineTriggered: true, supervisor: false,
        runStartedAt: new Date('2026-08-29T07:00:00Z'), now: new Date('2026-08-29T07:20:00Z'),
      });
      expect(res.struck).toBe(false);
      expect(mockUtilityChat).not.toHaveBeenCalled();
    });
  });
});
});

describe('tool-output haystack exoneration — CV0904 citation-strike root cause (owner 2026-09-04)', () => {
  // REPLAY PINS from the 2026-09-04 production probe: the supervisor read
  // REAL lane data and fabricated the ids decorating it — 8b547f50 [msg],
  // 8a403fca [sched], 89491603 [chat] exist in NO table (crossmodel_messages,
  // coding_messages, chats, schedules, agent_runs, event_hooks all miss).
  // These are the exact struck evidence-line shapes.
  const MSG_LINE = 'Path B lane: final verdict `msg 8b547f50` (updated 02:26:06Z)';
  const SCHED_LINE = 'Mac-installer monitor: sched 8a403fca lastRun 01:56:07Z, runs 17/48';
  const CHAT_LINE = 'reply in chat `89491603` "Tenstorrent R&D" (list_chats this run) — awaiting your go/no-go';
  const noRow = async () => false;
  const noHints = async () => [] as string[];
  const NOW = new Date('2026-09-04T03:00:00Z'); // both cited clocks are in the past — the clock lane stays silent

  beforeEach(() => {
    // jest.clearAllMocks() clears calls but NOT implementations — earlier
    // suites leave row-returning mocks behind. Every existence check here must
    // find NO row (the prod probe's ground truth: the ids exist in no table).
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
  });

  it('REPLAY PIN: no DB row + NO haystack presence → all three prod lines still CONVICT (F2 must not soften the guard)', async () => {
    const msg = await findPhantomEvidenceCitations(MSG_LINE, [], noRow, noHints, []);
    expect(msg.map((p) => p.id)).toEqual(['8b547f50']);
    const sched = await findPhantomScheduleCitations(SCHED_LINE, [], noRow, noHints, []);
    expect(sched.map((p) => p.id)).toEqual(['8a403fca']);
    const chat = await findPhantomSessionRefs(CHAT_LINE, [], [], noRow, noHints, []);
    expect(chat.map((p) => p.id)).toEqual(['89491603']);
  });

  it('the SAME lines with the cited id VERBATIM in a tool_result haystack are EXONERATED — an id honestly copied from a non-DB tool output (Redis approval id, GH run id, edge id) is not a phantom', async () => {
    const hay = [
      '{"messages":[{"id":"8b547f50-1c2d-4e5f-8a9b-0c1d2e3f4a5b","updatedAt":"2026-09-04T02:26:06.000Z"}]}',
      'schedules: 8a403fca-9d8c-4b7a-a6f5-e4d3c2b1a098 lastRun 2026-09-04T01:56:07Z runs 17/48',
      'chats: [{"id":"89491603-aaaa-bbbb-cccc-dddddddddddd","title":"Tenstorrent R&D"}]',
    ];
    expect(await findPhantomEvidenceCitations(MSG_LINE, [], noRow, noHints, hay)).toEqual([]);
    expect(await findPhantomScheduleCitations(SCHED_LINE, [], noRow, noHints, hay)).toEqual([]);
    expect(await findPhantomSessionRefs(CHAT_LINE, [], [], noRow, noHints, hay)).toEqual([]);
  });

  it('haystack matching is case-insensitive (an upper-cased id echo still grounds the citation)', async () => {
    const hay = ['APPROVAL 8B547F50-1C2D-4E5F-8A9B-0C1D2E3F4A5B PENDING'];
    expect(await findPhantomEvidenceCitations(MSG_LINE, [], noRow, noHints, hay)).toEqual([]);
  });

  it('end-to-end (computePhantomClaims): ids appearing ONLY in tool-call ARGS never exonerate (laundering vector) — tool RESULTS do', async () => {
    const note = [MSG_LINE, SCHED_LINE, CHAT_LINE].join('\n');
    // ARGS ONLY — a model-authored surface must not exonerate (the model could
    // mint an id into any call it makes).
    const argsOnly = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', finalText: note,
      parts: [{ type: 'tool_call', name: 'get_chat_status', args: { ids: '8b547f50 8a403fca 89491603' } } as any],
    });
    expect(argsOnly.phantoms.map((p) => p.id).sort()).toEqual(['89491603', '8a403fca', '8b547f50'].sort());
    // The same ids inside a tool RESULT ground all three lanes.
    const withResults = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', finalText: note,
      parts: [{ type: 'tool_result', name: 'get_chat_status', result: 'approval 8b547f50-1c2d; schedule 8a403fca-9d8c; chat 89491603-aaaa "Tenstorrent R&D"' } as any],
    });
    expect(withResults.phantoms).toEqual([]);
  });

  it('extraEvidenceHaystacks grounds the citation lanes too (the reject-back seam passes attempt 1 tool texts into pass 2)', async () => {
    const res = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', finalText: MSG_LINE, parts: [],
      extraEvidenceHaystacks: ['get_chat_status → approval 8b547f50-1c2d-4e5f-8a9b-0c1d2e3f4a5b'],
    });
    expect(res.phantoms).toEqual([]);
  });

  it('guard end-to-end: the three prod lines strike with the banner absent a haystack, and pass through untouched when a tool result carries the ids', async () => {
    const note = [MSG_LINE, SCHED_LINE, CHAT_LINE].join('\n');
    const struck = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u1', finalText: note, parts: [],
      supervisor: true, machineTriggered: true, now: NOW,
    });
    expect(struck.struck).toBe(true);
    // All 3 of 3 non-empty lines carry convictions — strip+mark fails closed
    // (>50% gutted) to the full replacement banner.
    expect(struck.finalText).toContain(ACTION_GUARD_BANNER);
    for (const id of ['8b547f50', '8a403fca', '89491603']) expect(struck.notice).toContain(id);

    const clean = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u1', finalText: note,
      parts: [{ type: 'tool_result', name: 'get_chat_status', result: 'ids seen this run: 8b547f50-1c2d, 8a403fca-9d8c, 89491603-aaaa' } as any],
      supervisor: true, machineTriggered: true, now: NOW,
    });
    expect(clean.struck).toBe(false);
    expect(clean.finalText).toBe(note);
  });

  it('the reject-back notice teaches the (id not captured) escape hatch at the moment of failure (F1 ↔ F3 symmetry)', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u1', finalText: MSG_LINE, parts: [],
      supervisor: true, machineTriggered: true, deferConsequences: true, now: NOW,
    });
    expect(res.struck).toBe(true);
    expect(res.rejectBackNotice).toContain('(id not captured)');
    expect(res.rejectBackNotice).toContain('never penalized');
    expect(res.rejectBackNotice).toContain('Do not mention this check');
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled(); // deferred — the seam owns the retry
  });
});

describe('samePrefixRealIds — the near-miss hint (ticket ef347cd0)', () => {
  it('message kind: up to 3 same-prefix real rows, newest-first, formatted with chat + timestamp', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([
      { id: '751c12b9-e755-4000-8000-000000000001', chatId: 'a8976e11-77af-4b7c-8ca5-f2f3f31cb903', createdAt: new Date('2026-08-31T01:09:00Z') },
      { id: '751c12b9-aaaa-4000-8000-000000000002', chatId: 'b92ef13f-c3f8-487e-8267-767e56543150', createdAt: new Date('2026-08-30T22:00:00Z') },
    ]);
    const out = await samePrefixRealIds('message', '751c12b9-5350-43f9-9ac9-9d27b22eb0be');
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: '751c12b9' } },
      select: { id: true, chatId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    expect(out).toEqual([
      '751c12b9-e755-4000-8000-000000000001 (chat a8976e11, 2026-08-31T01:09:00.000Z)',
      '751c12b9-aaaa-4000-8000-000000000002 (chat b92ef13f, 2026-08-30T22:00:00.000Z)',
    ]);
  });

  it('schedule kind names the owning session; chat kind names the title', async () => {
    mockPrisma.codingSchedule.findMany.mockResolvedValueOnce([
      { id: '1fbe4800-3f1b-4000-8000-000000000001', sessionId: 'b92ef13f-c3f8-487e-8267-767e56543150', createdAt: new Date('2026-08-30T12:00:00Z') },
    ]);
    expect(await samePrefixRealIds('schedule', '1fbe4800-6927-4000-8000-000000000002')).toEqual([
      '1fbe4800-3f1b-4000-8000-000000000001 (chat b92ef13f, 2026-08-30T12:00:00.000Z)',
    ]);
    expect(mockPrisma.codingSchedule.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: '1fbe4800' } },
      select: { id: true, sessionId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([
      { id: '2d4ff22f-1111-4000-8000-000000000001', title: 'Nightly claim-discipline run', updatedAt: new Date('2026-08-30T18:30:00Z') },
    ]);
    expect(await samePrefixRealIds('chat', '2d4ff22f-9999-4000-8000-000000000002')).toEqual([
      '2d4ff22f-1111-4000-8000-000000000001 ("Nightly claim-discipline run", 2026-08-30T18:30:00.000Z)',
    ]);
    // Pins the chat-kind query shape — the fail-open contract would otherwise
    // mask a schema-field typo as silent [] (review NB#2).
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: '2d4ff22f' } },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 3,
    });
  });

  it('short citations have no prefix bucket; a DB error fails open to []', async () => {
    expect(await samePrefixRealIds('message', 'abc')).toEqual([]);
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
    mockPrisma.crossModelMessage.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await samePrefixRealIds('message', '751c12b9-5350-43f9-9ac9-9d27b22eb0be')).toEqual([]);
  });
});

describe('near-miss wiring — convicted citations carry same-prefix real ids (ticket ef347cd0)', () => {
  const NEAR_MISS = ['751c12b9-e755-4000-8000-000000000001 (chat a8976e11, 2026-08-31T01:09:00.000Z)'];
  // Local fixtures (the e6bf2fda/1fd6a55f incident notes are describe-scoped) —
  // same citation idioms: a `msg <id>` receipt and a `schedule <id>` receipt.
  const MSG_INCIDENT = 'Verified the Nightly claim-discipline run fired and closed clean: b92ef13f 12:08Z run ran 4/4 verdicts ALL PASS — digest, closure, and queue checks all green; schedule re-armed for 14:08Z (msg e6bf2fda).';
  const SCHED_NOTE = 'Mac-installer monitor healthy: firing #2 still <0.3.0 (Mac on v0.1.0), probe condition unmet, correctly no-op (schedule 1fd6a55f).';

  it('findPhantomEvidenceCitations attaches the hint to every convicted claim via the injectable lookup', async () => {
    const phantoms = await findPhantomEvidenceCitations(MSG_INCIDENT, [], async () => false, async () => NEAR_MISS);
    expect(phantoms.length).toBeGreaterThan(0);
    for (const p of phantoms) expect(p.nearMiss).toEqual(NEAR_MISS);
  });

  it('an empty hint leaves the claim untouched; a rejecting lookup never blocks a conviction', async () => {
    const noHint = await findPhantomEvidenceCitations(MSG_INCIDENT, [], async () => false, async () => []);
    expect(noHint.length).toBeGreaterThan(0);
    for (const p of noHint) expect(p.nearMiss).toBeUndefined();
    const rejecting = await findPhantomEvidenceCitations(MSG_INCIDENT, [], async () => false, async () => { throw new Error('db down'); });
    expect(rejecting.length).toBeGreaterThan(0);
    for (const p of rejecting) expect(p.nearMiss).toBeUndefined();
  });

  it('exonerated citations never trigger the lookup', async () => {
    const lookup = jest.fn(async () => NEAR_MISS);
    const phantoms = await findPhantomEvidenceCitations(MSG_INCIDENT, [], async () => true, lookup);
    expect(phantoms).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('findPhantomScheduleCitations + findPhantomSessionRefs attach hints too', async () => {
    const sched = await findPhantomScheduleCitations(SCHED_NOTE, [], async () => false, async () => NEAR_MISS);
    expect(sched.length).toBeGreaterThan(0);
    for (const p of sched) expect(p.nearMiss).toEqual(NEAR_MISS);
    const sessionNote = 'The wake dispatched session 1ca12570-0921-4a94-a857-f0b9b75f8933 and it is still RUNNING.';
    const refs = await findPhantomSessionRefs(sessionNote, [], [], async () => false, async () => NEAR_MISS);
    expect(refs.length).toBeGreaterThan(0);
    for (const p of refs) expect(p.nearMiss).toEqual(NEAR_MISS);
  });

  it('claimDetailLines renders the educational line the ticket proposed; no hint → legacy rendering byte-identical', () => {
    const line = claimDetailLines([{ kind: 'message', detail: 'ran 4/4 verdicts ALL PASS', id: '751c12b9-5350-…', nearMiss: NEAR_MISS }]);
    expect(line).toBe('- [message] "ran 4/4 verdicts ALL PASS" (cited id 751c12b9-5350-… — does not exist; same-prefix real ids: 751c12b9-e755-4000-8000-000000000001 (chat a8976e11, 2026-08-31T01:09:00.000Z))');
    expect(claimDetailLines([{ kind: 'message', detail: 'x', id: 'aaa11111' }])).toBe('- [message] "x" (cited id aaa11111)');
    expect(claimDetailLines([{ kind: 'dispatch', detail: 'dispatched worker A' }])).toBe('- [dispatch] "dispatched worker A"');
  });

  it('rendered strike feedback with hints re-mines to ZERO phantom candidates in all three lanes (review NB#4)', () => {
    // The withheld-note correction carries the hint text into the chat; on the
    // next wake the lane may quote it back. Every id-bearing line matches the
    // miners' exclusion regexes ("does not exist"), so the feedback can never
    // convict itself — and the listed ids are REAL rows anyway (existence
    // exonerates them even if a future miner change lets them through).
    const correction = [
      '[ACTION VERIFIER] Withheld the previous note: it cited ids that do not exist.',
      claimDetailLines([
        { kind: 'message', detail: 'ran 4/4 verdicts ALL PASS (msg e6bf2fda)', id: 'e6bf2fda', nearMiss: ['e6bf2fda-1234-5678-9abc-def012345678 (chat a8976e11, 2026-08-31T01:09:00.000Z)'] },
        { kind: 'schedule', detail: 'schedule re-armed for 14:08Z (schedule 1fd6a55f)', id: '1fd6a55f', nearMiss: ['1fd6a55f-9999-4000-8000-000000000001 (chat b92ef13f, 2026-08-30T12:00:00.000Z)'] },
        { kind: 'dispatch', detail: 'dispatched session 1ca12570-0921-4a94-a857-f0b9b75f8933', id: '1ca12570-0921-4a94-a857-f0b9b75f8933', nearMiss: ['1ca12570-7777-4000-8000-000000000001 ("worker lane", 2026-08-30T18:30:00.000Z)'] },
      ]),
    ].join('\n');
    expect(mineEvidenceCitations(correction)).toEqual([]);
    expect(mineScheduleCitations(correction)).toEqual([]);
    expect(mineSessionChatReferences(correction)).toEqual([]);
  });
});

describe('same-tenant near-miss scoping + refutation education (ticket e3246ad5)', () => {
  const UID = 'u-owner-1';
  // Sub-floor (< MIN_NOTE_CHARS=40) citation note: the deterministic citation
  // lanes still audit it, with zero LLM involvement.
  const SUBFLOOR_MSG_NOTE = 'Closure landed (msg e6bf2fda).';

  it('NB#1: a userId-scoped lookup constrains every kind to the auditing chat tenant', async () => {
    await samePrefixRealIds('message', '751c12b9-5350-43f9-9ac9-9d27b22eb0be', UID);
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: '751c12b9' }, chat: { userId: UID } },
      select: { id: true, chatId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    await samePrefixRealIds('schedule', '1fbe4800-6927-4000-8000-000000000000', UID);
    expect(mockPrisma.codingSchedule.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: '1fbe4800' }, userId: UID },
      select: { id: true, sessionId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    await samePrefixRealIds('chat', '2d4ff22f-9999-4000-8000-000000000002', UID);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: '2d4ff22f' }, userId: UID },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 3,
    });
  });

  it('NB#1: computePhantomClaims threads the tenant scope into the near-miss lookup', async () => {
    const comp = await computePhantomClaims({ chatId: CHAT, userId: UID, finalText: SUBFLOOR_MSG_NOTE, parts: [] });
    expect(comp.phantoms.length).toBeGreaterThan(0); // existence check (findFirst → null) convicts
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { startsWith: 'e6bf2fda' }, chat: { userId: UID } } }),
    );
  });

  it('NB#1: a cross-tenant-only collision yields NO hint (leak closed); a same-tenant row still hints', async () => {
    // Scoped bucket empty (the colliding row belongs to another tenant) → no hint.
    let comp = await computePhantomClaims({ chatId: CHAT, userId: UID, finalText: SUBFLOOR_MSG_NOTE, parts: [] });
    expect(comp.phantoms.length).toBeGreaterThan(0);
    for (const p of comp.phantoms) expect(p.nearMiss).toBeUndefined();
    // Same-tenant row in the bucket → the hint survives scoping.
    mockPrisma.crossModelMessage.findMany.mockResolvedValueOnce([
      { id: 'e6bf2fda-1234-5678-9abc-def012345678', chatId: 'aaaaaaaa-1111-2222-3333-444455556666', createdAt: new Date('2026-08-31T01:09:00Z') },
    ]);
    comp = await computePhantomClaims({ chatId: CHAT, userId: UID, finalText: SUBFLOOR_MSG_NOTE, parts: [] });
    expect(comp.phantoms.find((p) => p.id === 'e6bf2fda')?.nearMiss)
      .toEqual(['e6bf2fda-1234-5678-9abc-def012345678 (chat aaaaaaaa, 2026-08-31T01:09:00.000Z)']);
  });

  it('NB#3: refutationDetail carries the cited id + near-miss hint; legacy shape without them', () => {
    expect(refutationDetail([{ kind: 'message', detail: 'ran 4/4 verdicts ALL PASS', id: '751c12b9-5350-…', nearMiss: ['751c12b9-e755-4000-8000-000000000001 (chat a8976e11, 2026-08-31T01:09:00.000Z)'] }]))
      .toBe('ran 4/4 verdicts ALL PASS (cited id 751c12b9-5350-… — does not exist; same-prefix real ids: 751c12b9-e755-4000-8000-000000000001 (chat a8976e11, 2026-08-31T01:09:00.000Z))');
    expect(refutationDetail([{ kind: 'dispatch', detail: 'dispatched worker A' }])).toBe('dispatched worker A');
    expect(refutationDetail([{ kind: 'message', detail: 'a', id: 'aaa11111' }, { kind: 'schedule', detail: 'b', id: 'bbb22222' }]))
      .toBe('a (cited id aaa11111); b (cited id bbb22222)');
  });

  it('NB#3: the durable refutation append receives the cited id + hint (post-delivery lane)', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { id: 'e6bf2fda-1234-5678-9abc-def012345678', chatId: 'aaaaaaaa-1111-2222-3333-444455556666', createdAt: new Date('2026-08-31T01:09:00Z') },
    ]);
    verifySupervisorRunAsync({ chatId: CHAT, userId: UID, finalText: SUBFLOOR_MSG_NOTE, parts: [], receipts: [], runStartedAt: new Date() });
    for (let i = 0; i < 6; i++) await flush();
    expect(mockAppendVerifierRefutation).toHaveBeenCalledTimes(1);
    const refuteArgs = mockAppendVerifierRefutation.mock.calls[0] as unknown as any[];
    expect(refuteArgs[0]).toBe(CHAT);
    expect(refuteArgs[1]).toBe(UID);
    const detail = String(refuteArgs[2]);
    expect(detail).toContain('cited id e6bf2fda');
    expect(detail).toContain('e6bf2fda-1234-5678-9abc-def012345678');
  });
});

describe('ActionGuardResult.audited — the single-audit contract (ticket fc337153)', () => {
  // The 2026-09-11T02:17Z reopen: the post-delivery lane convicted a
  // supervisor note the pre-delivery guard had ACQUITTED — two independent
  // LLM extraction passes over the same note + evidence can only diverge
  // (worse after a reject-back: the guard's second pass exonerates via
  // extraEvidenceHaystacks the post lane never receives). The guard now
  // reports whether it audited to a verdict; the chat-agent seam stands the
  // post-delivery lane down on audited:true and keeps it as the error
  // backstop on audited:false.
  it('a CLEAN supervisor machine-wake audit returns audited:true (verdict reached — post lane stands down)', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1',
      finalText: 'Wake complete. All four owner items still open; nothing moved since the weekend.',
      parts: [], receipts: [], runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });
    expect(res.struck).toBe(false);
    expect(res.audited).toBe(true);
  });

  it('a STRIKE returns audited:true (consequences fired — post lane stands down)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'filed a feedback ticket for the digest regression', id: 'ab12cd34-9999-8888-7777-666655554444' }],
    }) as never);
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1',
      finalText: 'Wake complete. I filed a feedback ticket for the digest regression (ticket id ab12cd34-9999-8888-7777-666655554444) so triage picks it up.',
      parts: [], receipts: [], runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });
    expect(res.struck).toBe(true);
    expect(res.audited).toBe(true);
  });

  it('the fail-open ERROR path returns audited:false (the post lane stays as backstop)', async () => {
    // A poisoned part forces the guard's outer catch — toolResultTextsFromParts
    // reads .result while building the future-clock haystacks. The fail-open
    // passthrough must NOT claim an audit happened.
    const poisoned: any = { type: 'tool_result' };
    Object.defineProperty(poisoned, 'result', { get: () => { throw new Error('boom'); } });
    const note = 'Wake complete. All four owner items still open; nothing moved since the weekend.';
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note,
      parts: [poisoned], receipts: [], runStartedAt: new Date(), supervisor: true, machineTriggered: true,
    });
    expect(res.struck).toBe(false);
    expect(res.audited).toBe(false);
    expect(res.finalText).toBe(note); // fail-open keeps the original text
  });

  it('the non-machine-triggered passthrough returns audited:false (no audit ran)', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1',
      finalText: 'Wake complete. I sent the digest to the owner chat (receipt deadbeef).',
      parts: [], receipts: [], runStartedAt: new Date(), supervisor: true, machineTriggered: false,
    });
    expect(res.struck).toBe(false);
    expect(res.audited).toBe(false);
  });

  it('a keyword-free NON-supervisor wake passes the cheap pre-gate unaudited (audited:false)', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1',
      finalText: 'Wake complete. All four owner items still open; nothing moved since the weekend.',
      parts: [], receipts: [], runStartedAt: new Date(), supervisor: false, machineTriggered: true,
    });
    expect(res.struck).toBe(false);
    expect(res.audited).toBe(false);
  });
});


// audit 2026-10-08 W1-4: this suite pins the strip+mark / full-replacement delivery — now the
// OWNER_NOTE_NO_EDIT_DISABLED=1 kill-switch path (the default delivers the note as written + an
// observe-only annotation; action-verifier.owner-note-no-edit.test.ts pins that).
beforeAll(() => { process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1'; });
afterAll(() => { delete process.env.OWNER_NOTE_NO_EDIT_DISABLED; });

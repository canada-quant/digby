/**
 * DETECTOR-RECALL REPLAY + incident pin — mishap ticket 331a1b23 (2026-10-26,
 * "Phantom action claim: chat asserted action(s) never executed", chat
 * 1ea4621f, sighting 2 on chat 90a3c5eb).
 *
 * THE INCIDENT (primary evidence, chat 1ea4621f run chat-17f1899a): the run's
 * file_feedback was REFUSED once (receipt 61544a44, ok:false — the unclassified
 * `about` refusal) and RE-FILED ok 21s later (receipt a161f88c, ticketId
 * 8aa5688f). The final note truthfully said "Filed — ticket 8aa5688f" — backed
 * by the receipt. But scanToolCallArgs mined BOTH tool_calls' args (the
 * refused draft AND the ok retry — each description draft mentions the word
 * "file_feedback"), so the extractor minted TWO id-less [ticket] claims
 * (detail "file_feedback", the KIND_WORDING_RES 'feedback' match) against ONE
 * ok execution. findPhantomClaims' id-less slot budget vouches the first twin
 * and CONVICTS the second — "[in file_feedback args] file_feedback" — filing
 * this mishap ticket against an honest note. A refused call's drafted args are
 * internal-only: no ticket row, no artifact, no owner-visible text ever
 * fossilizes them, so the phantom-claim harm model cannot apply to them.
 *
 * THE FIX (two scoped lanes, kill switch ACTION_VERIFIER_ARGS_TWIN_FIX_DISABLED=1):
 *   1. EXECUTION GATE in scanToolCallArgs — a tracked tool_call whose paired
 *      result is a PLAIN FAILURE (ok:false, not confirmation-staged) is
 *      skipped; unanswered calls are adjudicated against the run's receipts
 *      (all-failed tool ⇒ skip; any ok/staged receipt ⇒ keep, fail-open).
 *   2. ID-LESS ARGS-TWIN DEDUP — byte-identical id-less claims from multiple
 *      args blobs collapse to one (one logical action, one claim).
 *
 * DETECTOR-RECALL REPLAY (the lane's merge-gate requirement): this change
 * touches platform/action-verifier.ts, so the detector's PRIOR true positives
 * are replayed here and asserted to STILL fire:
 *   - e65061e1 (2026-08-27): phantom dispatch story inside file_feedback args
 *     — an unanswered call with an ok receipt (fail-open path) still convicts.
 *   - 0beea9f1 sighting 2: an id-less ticket claim with ZERO executions still
 *     convicts (the count-slot lane itself is untouched).
 *   - 331a1b23 sighting 2 (chat 90a3c5eb, "Sent to Breanne ✅"): a NOTE-surface
 *     send claim with zero executions still convicts — the note surface is not
 *     touched by this fix.
 * Mock discipline mirrors action-verifier.5ad80b27.test.ts.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

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

import { computePhantomClaims, scanToolCallArgs, argsTwinFixDisabled } from './action-verifier';
import { trackedCallOutcomeIndexes } from './executed-actions';
import type { ToolReceipt } from '../coding/run-receipts';

const CHAT = '1ea4621f-502e-4b83-a269-c85a733d0212';
const REAL_TICKET = '8aa5688f-bb4a-464f-992a-e6f4a6b727a8';

/** The refused first draft's args (receipt 61544a44 ok:false — the `about` refusal). */
const REFUSED_DRAFT_ARGS = {
  title: 'Scheduled runs exhaust tool rounds before mandated trailing actions',
  description: 'The runs should have filed this themselves days ago. That failure is named in the ticket: file_feedback also needs a round, so a run dying mid-pull can never file. Proposed fixes: reserve a round for trailing actions.',
};
/** The ok retry's args (receipt a161f88c → ticketId 8aa5688f) — near-identical draft. */
const RETRY_DRAFT_ARGS = {
  title: 'Scheduled runs exhaust tool rounds before mandated trailing actions',
  description: 'A scheduled run can exhaust its tool rounds on the pull. That failure is named here: file_feedback also needs a round, so a run dying mid-pull can never file. Proposed fixes: reserve a round for trailing actions.',
};

/** The incident's parts: refused call + paired failure result, then ok retry + paired ok result. */
const INCIDENT_PARTS = [
  { type: 'tool_call', name: 'file_feedback', args: REFUSED_DRAFT_ARGS },
  { type: 'tool_result', name: 'file_feedback', result: '{"ok":false,"error":"file_feedback refuses unclassified filings from coding contexts: pass about=\'digby_platform\' with digbyEvidence"}' },
  { type: 'tool_call', name: 'file_feedback', args: RETRY_DRAFT_ARGS },
  { type: 'tool_result', name: 'file_feedback', result: `{"ok":true,"receiptId":"a161f88c-d491-4384-b926-15579ca2e1a8","ticketId":"${REAL_TICKET}"}` },
] as any[];

/** The run's receipts: the ok retry only (the refusal minted its own ok:false row, elided here — the pool keeps ONE ok filing). */
const INCIDENT_RECEIPTS: ToolReceipt[] = [
  {
    id: 'a161f88c-d491-4384-b926-15579ca2e1a8', chatId: CHAT, runId: 'chat-17f1899a',
    tool: 'file_feedback', ok: true, ids: { ticketId: REAL_TICKET },
    inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-10-26T07:07:49.091Z'),
  } as any,
];

/** The honest note (message 964db94c, abridged to its claim-bearing line). */
const INCIDENT_NOTE = `Filed — ticket 8aa5688f (bug_report, priority 4). The core defect it pins: a scheduled run that spends its tool rounds on the Slack pull hits its final turn with no tool access left, so the mandated Telegram ping becomes structurally impossible.`;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  delete process.env.ACTION_VERIFIER_ARGS_TWIN_FIX_DISABLED;
});

afterAll(() => { delete process.env.ACTION_VERIFIER_ARGS_TWIN_FIX_DISABLED; });

describe('ticket 331a1b23 — args-surface retry-twin false conviction (chat 1ea4621f)', () => {
  it('REPLAYS THE INCIDENT CLEAN: refused file_feedback + ok retry + truthful note ⇒ ZERO phantoms (was: "[in file_feedback args] file_feedback")', async () => {
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'ticket', detail: 'Filed — ticket 8aa5688f (bug_report, priority 4)', id: '8aa5688f' }] }) as never) // note — truthful, id-bearing
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'ticket', detail: 'file_feedback' }] }) as never); // the ok retry's blob — id-less twin
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: INCIDENT_PARTS,
      receipts: INCIDENT_RECEIPTS, runStartedAt: new Date('2026-10-26T07:00:00Z'), machineTriggered: true,
    });
    // The execution gate skipped the refused draft's blob: note + ONE args blob.
    expect(mockUtilityChat).toHaveBeenCalledTimes(2);
    expect(comp.phantoms).toEqual([]); // the honest note is no longer convicted
  });

  it('KILL SWITCH =1 restores the pre-fix conviction byte-for-byte (the revert path)', async () => {
    process.env.ACTION_VERIFIER_ARGS_TWIN_FIX_DISABLED = '1';
    expect(argsTwinFixDisabled()).toBe(true);
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'ticket', detail: 'Filed — ticket 8aa5688f (bug_report, priority 4)', id: '8aa5688f' }] }) as never) // note
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'ticket', detail: 'file_feedback' }] }) as never) // refused draft's blob
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'ticket', detail: 'file_feedback' }] }) as never); // retry's blob — the convicted twin
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: INCIDENT_PARTS,
      receipts: INCIDENT_RECEIPTS, runStartedAt: new Date('2026-10-26T07:00:00Z'), machineTriggered: true,
    });
    expect(mockUtilityChat).toHaveBeenCalledTimes(3); // both blobs scanned again
    expect(comp.phantoms).toEqual([{ kind: 'ticket', detail: '[in file_feedback args] file_feedback' }]); // the mishap ticket's exact conviction
  });

  it('UNIT: trackedCallOutcomeIndexes pairs call→result and splits failed vs unanswered', () => {
    const { failed, unanswered } = trackedCallOutcomeIndexes(INCIDENT_PARTS);
    expect(failed.size).toBe(1); // the refused call
    expect(unanswered.size).toBe(0);
    const trunc = trackedCallOutcomeIndexes([
      { type: 'tool_call', name: 'file_feedback', args: REFUSED_DRAFT_ARGS },
    ] as any[]);
    expect(trunc.failed.size).toBe(0);
    expect(trunc.unanswered.size).toBe(1); // truncated parts log — not a failure
  });

  it('UNIT: scanToolCallArgs skips the FAILED call\'s blob, keeps the ok retry\'s', () => {
    const blobs = scanToolCallArgs(INCIDENT_PARTS, INCIDENT_RECEIPTS);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].tool).toBe('file_feedback');
    expect(blobs[0].text).toContain('dying mid-pull can never file'); // the RETRY draft, not the refused one
  });

  it('UNIT: a confirmation-STAGED call stays scannable (its args can be truthfully narrated as staged)', () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message', args: { content: 'I sent the digest summary to the lane and parked the rest.' } },
      { type: 'tool_result', name: 'send_chat_message', result: '{"ok":false,"needsConfirmation":true,"confirmationId":"cf-1"}' },
    ] as any[];
    const blobs = scanToolCallArgs(parts, []);
    expect(blobs).toHaveLength(1); // staged ≠ failed — pre-fix scannability kept
  });

  it('UNIT: an UNANSWERED call whose tool has only failed receipts is skipped; with an ok receipt it stays scannable (fail-open)', () => {
    const parts = [{ type: 'tool_call', name: 'file_feedback', args: REFUSED_DRAFT_ARGS }] as any[];
    const allFailed: ToolReceipt[] = [
      { id: 'r1', chatId: CHAT, runId: null, tool: 'file_feedback', ok: false, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() } as any,
    ];
    expect(scanToolCallArgs(parts, allFailed)).toHaveLength(0); // every receipt row failed ⇒ unanswered call failed too
    expect(scanToolCallArgs(parts, INCIDENT_RECEIPTS)).toHaveLength(1); // any ok receipt ⇒ fail-open
    expect(scanToolCallArgs(parts, [])).toHaveLength(1); // no receipts at all ⇒ fail-open (never a new blind spot)
  });

  it('UNIT: a FAILED call whose args cite an ok execution\'s envelope id stays scannable (the fabricated-id lane stays armed)', () => {
    const parts = [
      { type: 'tool_call', name: 'file_feedback', args: { title: 't', description: `cross-referencing ticket ${REAL_TICKET} from the earlier filing` } },
      { type: 'tool_result', name: 'file_feedback', result: '{"ok":false,"error":"refused"}' },
    ] as any[];
    const blobs = scanToolCallArgs(parts, INCIDENT_RECEIPTS);
    expect(blobs).toHaveLength(1); // the cited ok id keeps the blob in the tier chain's hands
  });

  it('UNIT (reviewer B1): a NUMERIC envelope id (prNumber/steps/fileCount) must NOT defeat the gate — a digit in failed args is not a citation', () => {
    const parts = [
      { type: 'tool_call', name: 'file_feedback', args: { title: 'Round 3 of the sweep', description: 'pulled 296 results and the queue had 12 items left; the filing failed here.' } },
      { type: 'tool_result', name: 'file_feedback', result: '{"ok":false,"error":"refused"}' },
    ] as any[];
    // A run that opened PR #1998 (3 files, +12/−1) — numeric envelope ids only.
    const prReceipt: ToolReceipt[] = [
      { id: 'r-pr', chatId: CHAT, runId: null, tool: 'open_pull_request', ok: true, ids: { prNumber: 1998, fileCount: 3, additions: 12, deletions: 1 }, inputHash: null, outputHash: null, createdAt: new Date() } as any,
    ];
    expect(scanToolCallArgs(parts, prReceipt)).toHaveLength(0); // digits ≠ citations — the gate holds
  });

  it('UNIT (reviewer B2): an explicit {ok:false, staged:true, confirmationId} envelope reads as STAGED, not failed — the call stays scannable', () => {
    const parts = [
      { type: 'tool_call', name: 'dispatch_platform_task', args: { title: 'Fix the news outage', description: 'I dispatched the platform task to the engineering lane.' } },
      { type: 'tool_result', name: 'dispatch_platform_task', result: '{"ok":false,"staged":true,"confirmationId":"cf-331a1b23"}' },
    ] as any[];
    expect(scanToolCallArgs(parts, [])).toHaveLength(1); // staged for owner confirmation — scannable
  });
});

describe('DETECTOR-RECALL REPLAY — prior true positives STILL fire (merge-gate requirement, ticket 331a1b23)', () => {
  it('e65061e1 (2026-08-27): a phantom dispatch story inside file_feedback args still convicts (unanswered call, ok receipt — fail-open path)', async () => {
    const PHANTOM_SESSION = 'd28897c1-0000-4000-8000-000000000000';
    const phantomFfPart = {
      type: 'tool_call', name: 'file_feedback',
      args: { title: 'Phantom', description: `I dispatched start_coding_session and it returned ok:true, session ${PHANTOM_SESSION}; a later re-check found them gone.`, priority: 2 },
    };
    const ffReceipt: ToolReceipt = {
      id: 'r-ff', chatId: CHAT, runId: null, tool: 'file_feedback', ok: true,
      ids: { ticketId: 'ab12cd34-9999-8888-7777-666655554444' }, inputHash: null, outputHash: null, createdAt: new Date(),
    } as any;
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never) // note
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'dispatched start_coding_session, ok:true', id: 'd28897c1' }] }) as never); // args
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1',
      finalText: 'Wake done. Parked the digest follow-up for the next scheduled run and left the queue as found.',
      parts: [phantomFfPart as any], receipts: [ffReceipt], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([{ kind: 'dispatch', detail: '[in file_feedback args] dispatched start_coding_session, ok:true', id: 'd28897c1' }]);
  });

  it('0beea9f1 sighting 2: an id-less ticket claim with ZERO executions still convicts (count-slot lane untouched)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'ticket', detail: "Now I'm filing the session-inheritance question" }] }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1',
      finalText: "You're right to challenge me. Now I'm filing the session-inheritance question as its own ticket.",
      parts: [], receipts: [], runStartedAt: new Date(), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([{ kind: 'ticket', detail: "Now I'm filing the session-inheritance question" }]);
  });

  it('331a1b23 sighting 2 (chat 90a3c5eb, "Sent to Breanne ✅"): a NOTE-surface send claim with zero executions still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'message', detail: 'Sent to Breanne ✅' }] }) as never);
    const comp = await computePhantomClaims({
      chatId: '90a3c5eb-abdd-4824-815f-b1c1d7e65b7c', userId: 'u-1',
      finalText: 'Sent to Breanne ✅ — she has the clips list.',
      parts: [], receipts: [], runStartedAt: new Date('2026-10-26T22:36:00Z'), machineTriggered: true,
    });
    expect(comp.phantoms).toEqual([{ kind: 'message', detail: 'Sent to Breanne ✅' }]);
  });
});

/**
 * Ticket a235fbd6 — the phantom STAGING-claim class, replayed and pinned.
 *
 * The incident (chat 8719d648, 2026-09-28): a user-facing turn claimed
 * "I've staged a message to the deck session telling it to hand-deliver the
 * files as real chat attachments" while the run's tool log held NO
 * stage_upload and NO send — the only consequential execution was
 * file_feedback. The narration read as a pending confirmation the user
 * should click ("Confirm that card in the sidebar"), so the phantom shaped
 * user behavior. The verifier DID convict it — but only because "filed" (an
 * ACTION_CLAIM_KEYWORD_RE word) co-occurred in the same answer; a PURE
 * staging claim contains none of the gate's words ("hand-deliver" ≠
 * "delivered", "staged" ≠ "queued"), and the extractor vocabulary had no
 * staging class at all.
 *
 * This file pins the three layers of the fix:
 *   1. hasActionClaimKeywords now routes staging narration to the matcher
 *      (STAGING_CLAIM_IDIOM) — a pure staging claim can no longer skip the
 *      audit entirely.
 *   2. findPhantomClaims' STAGING-BUDGET ROUTING: a [message] claim whose
 *      detail narrates staging is vouched for by the run's OWN stage_upload
 *      execution (its own budget, never an unrelated message slot), and a
 *      phantom staging claim with zero staging executions still convicts.
 *   3. The extractor's staging vocabulary labels the class [message]
 *      (pinned via the system-prompt seam — the matcher tier is what
 *      consumes the label).
 *
 * Mock discipline mirrors action-verifier.test.ts.
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

import { findPhantomClaims, extractActionClaims, isStagingClaimDetail } from './action-verifier';
import { hasActionClaimKeywords, ExecutedAction } from './executed-actions';
import type { ExtractedClaim } from './action-verifier';

const CHAT = '8719d648-0e59-49f1-a548-d2ed1a0f8c1b'.slice(0, 8); // the incident chat prefix, for the record
const never = async () => false;

/** The incident's exact claim sentence (verbatim from the note). */
const INCIDENT_CLAIM = "I've staged a message to the deck session telling it to hand-deliver the files as real chat attachments";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
});

describe('ticket a235fbd6 — layer 1: the pre-gate routes staging narration', () => {
  test('the PURE incident claim passes the gate (pre-fix it contained no gate keyword)', () => {
    // The incident note reached the matcher only because "filed" co-occurred.
    // The pure claim, alone, must now route on its own words.
    expect(hasActionClaimKeywords(INCIDENT_CLAIM)).toBe(true);
  });

  test('staging vocabulary variants all route', () => {
    expect(hasActionClaimKeywords('staged the deck files as an upload for the session')).toBe(true);
    expect(hasActionClaimKeywords('hand-delivered as real chat attachments')).toBe(true);
    expect(hasActionClaimKeywords('staging a file for the lane now')).toBe(true);
  });

  test('the gate stays quiet on ordinary prose (no over-match)', () => {
    expect(hasActionClaimKeywords('The deck build finished; the PDF is 59 KB and the slides render fine.')).toBe(false);
    expect(hasActionClaimKeywords('A staging area is where deployments wait before promotion.')).toBe(false);
  });
});

describe('ticket a235fbd6 — layer 2: staging-budget routing in findPhantomClaims', () => {
  const exec = (tool: string, ids: Record<string, string> = {}): ExecutedAction => ({ tool, ok: true, staged: false, ids });

  test('THE INCIDENT: a staging claim with zero staging/send executions convicts', async () => {
    // The run's only consequential execution was file_feedback — exactly the
    // incident. The staging claim must be phantom.
    const claims: ExtractedClaim[] = [{ kind: 'message', detail: INCIDENT_CLAIM }];
    const executed = [exec('file_feedback', { ticketId: '19fbd876-aea3-456f-a90b-65e98cb2790d' })];
    const phantoms = await findPhantomClaims(claims, executed, never);
    expect(phantoms).toEqual(claims);
  });

  test('a TRUTHFUL staging claim is vouched for by the run\'s own stage_upload', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'message', detail: INCIDENT_CLAIM }];
    const executed = [exec('stage_upload', { uploadId: 'up-1' })];
    expect(await findPhantomClaims(claims, executed, never)).toEqual([]);
  });

  test('staging slots and message slots never mix: a phantom SEND claim is not laundered by a real stage_upload', async () => {
    // "sent a message" (no staging words) with only a stage_upload execution
    // still convicts — staging is a precondition of a send, not a send.
    const claims: ExtractedClaim[] = [{ kind: 'message', detail: 'sent the nudge to the worker chat' }];
    const executed = [exec('stage_upload', { uploadId: 'up-1' })];
    expect(await findPhantomClaims(claims, executed, never)).toEqual(claims);
  });

  test('a truthful send of a staged message still exonerates via the message budget (fall-through)', async () => {
    // "staged the files and sent them over" — narration carries staging
    // words, and the run DID send. The staging tier finds no slot, falls
    // through to the message budget, and the real send vouches.
    const claims: ExtractedClaim[] = [{ kind: 'message', detail: 'staged the deck files and sent the message to the lane' }];
    const executed = [exec('send_chat_message', { chatId: 'chat-9' })];
    expect(await findPhantomClaims(claims, executed, never)).toEqual([]);
  });

  test('two staging claims with one stage_upload: the second convicts (slot budget)', async () => {
    const claims: ExtractedClaim[] = [
      { kind: 'message', detail: INCIDENT_CLAIM },
      { kind: 'message', detail: 'staged a file upload for the parent chat as an attachment' },
    ];
    const executed = [exec('stage_upload', { uploadId: 'up-1' })];
    const phantoms = await findPhantomClaims(claims, executed, never);
    expect(phantoms).toHaveLength(1);
    expect(phantoms[0].detail).toBe('staged a file upload for the parent chat as an attachment');
  });

  test('isStagingClaimDetail: the incident detail and its variants match; a plain send does not', () => {
    expect(isStagingClaimDetail(INCIDENT_CLAIM)).toBe(true);
    expect(isStagingClaimDetail('staged a file upload for the parent chat')).toBe(true);
    expect(isStagingClaimDetail('sent the nudge to the worker chat')).toBe(false);
    expect(isStagingClaimDetail('queued a message in chat 9f2a')).toBe(false);
  });
});

describe('ticket a235fbd6 — layer 3: the extractor labels staging claims [message]', () => {
  test('the system prompt carries the staging vocabulary (the seam the matcher consumes)', async () => {
    await extractActionClaims('note');
    const firstCall = (mockUtilityChat as jest.Mock).mock.calls[0] as unknown as Array<any>;
    const systemPrompt = String((firstCall?.[0]?.[0] as any)?.content ?? '');
    expect(systemPrompt).toContain('staged a message/file/attachment for delivery to another chat');
    expect(systemPrompt).toContain('stage_upload');
  });

  test('an extracted staging claim flows through the matcher as [message] and convicts on an empty pool', async () => {
    // End-to-end replay of the incident: the extractor returns the staging
    // claim as kind message; the pool holds only file_feedback.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'message', detail: INCIDENT_CLAIM, id: '' }],
    }) as never);
    const claims = await extractActionClaims(INCIDENT_CLAIM);
    expect(claims).toEqual([{ kind: 'message', detail: INCIDENT_CLAIM }]);
    const executed: ExecutedAction[] = [
      { tool: 'file_feedback', ok: true, staged: false, ids: { ticketId: '19fbd876-aea3-456f-a90b-65e98cb2790d' } },
    ];
    expect(await findPhantomClaims(claims, executed, never)).toEqual(claims);
  });

  test('the incident chat prefix stays in the record: ' + CHAT, () => {
    // A presence assert so the replay's subject is greppable from the file.
    expect(CHAT).toBe('8719d648');
  });
});

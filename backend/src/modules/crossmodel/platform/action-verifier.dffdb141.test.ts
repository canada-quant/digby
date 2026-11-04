/**
 * Ticket dffdb141 replay — a truthful FAILURE REPORT narrated over a FAILED
 * browser_task row must NOT convict as a phantom claim.
 *
 * The mishap (chat 5146aa95, 2026-10-04 ~00:27Z): the lead dispatched a
 * browser_task on a paired-Mac chat, the read-only camera notice came back
 * (app error row 266fe139, 00:23:36Z) and the task then TIMED OUT (app error
 * row e31ede19, 00:27:00Z). The final note told the user exactly that — the
 * browser task timed out, so the page was verified by fetching it directly.
 * The action-verifier's extraction labelled that honest failure report a
 * [dispatch] claim; the timed-out browser_task was ok:false (no step header)
 * and therefore dropped from the ok-only slot pool, and the post-delivery
 * lane posted a user-visible "claimed action(s) that did NOT actually run"
 * correction on a truthful sentence.
 *
 * Fixed by the FAILURE-REPORT tier (action-verifier.ts findPhantomClaims,
 * landed with PR #1236): a claim whose detail REPORTS A FAILURE is vouched by
 * any ATTEMPTED call of its tool family — the task tools for task narration,
 * else KIND_TOOLS[kind] — read from the UNFILTERED executions (failed
 * attempts included, never consumed). This file pins the dffdb141 shape
 * end-to-end so the class can never silently regress:
 *   1. the mishap replay audits CLEAN (no ticket, no correction message);
 *   2. a SUCCESS claim over the same failed row STILL convicts — the tier
 *      launders failure reports, never success claims;
 *   3. a failure report with NO attempt at all still convicts (a made-up
 *      attempt is a phantom);
 *   4. the kill switch ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED=1
 *      restores the conviction (documented escape hatch).
 */

// Boundary mocks FIRST (config/database and every transitively-heavy
// boundary is mocked at the top, above imports) — same scaffolding as
// action-verifier.61b9200a.test.ts.
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

import { verifyRunActionClaimsAsync, computePhantomClaims } from './action-verifier';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));
// The mishap's chat (ticket dffdb141) — 8-char id as held from the incident
// record; the replay must read true against it. (chatId only feeds the mocked
// lookups, which return null — the logic under test is id-independent.)
const CHAT = '5146aa95';

// The honest sentence the lead shipped (the action-verifier's own extraction
// labelled this line a [dispatch] claim — the incident shape recorded on the
// FAILURE-REPORT tier in action-verifier.ts).
const FAILURE_NOTE = 'The exact page heading is **Example Domain** — my browser task timed out, so I verified by fetching the page directly.';
const FAILURE_CLAIM_DETAIL = 'my browser task timed out, so I verified by fetching the page directly';

// The run's REAL parts (chat 5146aa95): the browser_task dispatch and its
// TIMED-OUT result — no step header, so the row lands in the UNFILTERED
// executions as ok:false and the ok-only slot pool never sees it (the exact
// seam that produced the mishap).
const INCIDENT_PARTS = [
  { type: 'tool_call', name: 'browser_task', args: { task: 'Read the page heading at https://example.com and report it verbatim.' } },
  { type: 'tool_result', name: 'browser_task', result: 'Tool call failed: browser agent session timed out (timeout of 120000ms exceeded)' },
] as any[];

// The run's receipts as the chat seam passed them: EMPTY — browser_task mints
// none (RECEIPT_TOOLS excludes it), and the incident run ran no platform tool.
const NO_RECEIPTS: ToolReceipt[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  delete process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED;
});

afterEach(() => {
  delete process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED;
});

describe('ticket dffdb141 replay — a truthful failure report over a FAILED browser_task is NOT a phantom', () => {
  it('REPLAYS the mishap: the failure-report dispatch claim with the timed-out task result audits CLEAN — no ticket, no retraction', async () => {
    // The extraction pass labels the narration a [dispatch] claim, exactly as
    // it did in the incident (the claim detail quotes the note verbatim).
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: FAILURE_CLAIM_DETAIL }],
    }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: FAILURE_NOTE,
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS,
      machineTriggered: false,
    });
    expect(comp.phantoms).toEqual([]); // THE FIX: exonerated by the ATTEMPTED (failed) task row
    // The mishap seam, pinned: the row IS in the unfiltered executions and is
    // ok:false — pre-fix the ok-only pool dropped it and the honest note
    // convicted as a phantom.
    expect(comp.executed.some((a) => a.tool === 'browser_task' && a.ok === false)).toBe(true);

    // End-to-end through the user-facing lane: nothing files, nothing retracts.
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: FAILURE_NOTE, parts: INCIDENT_PARTS, receipts: NO_RECEIPTS, machineTriggered: false });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a SUCCESS claim over the same failed row STILL convicts — the tier launders failure reports, never success claims', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'I ran a browser task to read the page heading' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'I ran a browser task to read the page heading — it is Example Domain.',
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS,
      machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'dispatch' });
  });

  it('a failure report with NO attempt at all still convicts (a made-up attempt is a phantom)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: FAILURE_CLAIM_DETAIL }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: FAILURE_NOTE,
      parts: [], receipts: NO_RECEIPTS,
      machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'dispatch' });
  });

  it('kill switch ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED=1 restores the conviction (documented escape hatch)', async () => {
    process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED = '1';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: FAILURE_CLAIM_DETAIL }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: FAILURE_NOTE,
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS,
      machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'dispatch' });
  });
});

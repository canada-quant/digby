/**
 * REPLAY PIN — ticket 61b9200a-f160-4578-a881-8f4e1cfb4138 (mishap, 2026-09-12):
 * "Phantom action claim: chat asserted action(s) never executed (chat 0945e820)".
 *
 * The mishap: a user-facing chat turn in chat
 * 0945e820-3f19-4f1b-ba44-d55b12cca678 narrated, truthfully, "I ran a computer
 * task to find the PDF (Spotlight and Finder…)" — and the run's parts HELD the
 * computer_task call + its result ("[Computer task result — steps: 12 · mac:
 * connected…]"). But computer_task mints NO run-receipt (RECEIPT_TOOLS is the
 * consequential-platform allowlist) and is not one of the 7 tracked
 * consequential tools, so the verifier's executed pool was empty; the LLM
 * extraction labelled the narration a [dispatch] claim, no pool slot of the
 * dispatch kind could match it, and the truthful claim was CONVICTED as a
 * phantom — filing this mishap ticket and posting the user-facing retraction
 * ("did NOT actually run") that told the user the opposite of what happened.
 * The verifier's own ground-truth line read "Executed consequential actions
 * this run: NONE" while the parts held a 12-step task result.
 *
 * The fix (three seams, one per gap):
 *   1. executed-actions.ts — a task-delegation lane (extractTaskExecutions)
 *      parses computer_task / browser_task tool_results (steps>0 ⇒ executed)
 *      into the ExecutedAction pool shape.
 *   2. computePhantomClaims — the executed pool ALWAYS unions task executions
 *      from parts, in BOTH shapes (receipts-provided and parts-fallback): task
 *      tools have no receipts, so parts are their only evidence.
 *   3. findPhantomClaims — id-less dispatch claims whose detail narrates a
 *      task (isTaskDelegationClaimDetail) draw from a DEDICATED task budget
 *      first, with deliberate fall-through to the platform budget. Task tools
 *      never enter KIND_TOOLS, so the two budgets can never launder each
 *      other: a phantom platform-dispatch claim cannot be exonerated by an
 *      unrelated real task run, and a phantom task claim (no task execution in
 *      the parts) still convicts — the d78f477b conviction shape.
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

import { verifyRunActionClaimsAsync, computePhantomClaims, findPhantomClaims, ExtractedClaim } from './action-verifier';
import { ExecutedAction } from './executed-actions';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));
// The mishap's real chat id — the replay must read true against it.
const CHAT = '0945e820-3f19-4f1b-ba44-d55b12cca678';

// Verbatim claim detail from the ticket (the action-verifier's own extraction
// labelled this line a [dispatch] phantom).
const TASK_CLAIM_DETAIL = 'I ran a computer task to find the PDF (Spotlight and Finder, searching "01187" and "57") so I could open it in Preview and visually screenshot each page';

// Verbatim-ish incident shape: the note narrates the task run (ticket excerpt).
const INCIDENT_NOTE = `**What I actually tried this run:**

1. **Your Mac** — ${TASK_CLAIM_DETAIL}. Result: no copy exists on the Mac — the file lives only in the project knowledge base.`;

// The run's REAL parts (chat 0945e820): the computer_task call + its 12-step
// result. Pre-fix the verifier's pool never saw these.
const INCIDENT_PARTS = [
  { type: 'tool_call', name: 'computer_task', args: { task: 'Find the 01187 PDF on the Mac (Spotlight + Finder), open in Preview, screenshot each page.' } },
  { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 12 · mac: connected (MacBook Pro)]\nI was unable to locate the requested PDF file on the Mac after searching Spotlight and Finder.' },
] as any[];

// The run's receipts as the chat seam passed them: EMPTY — computer_task mints
// none (RECEIPT_TOOLS excludes it), and the incident run ran no platform tool.
const NO_RECEIPTS: ToolReceipt[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('ticket 61b9200a replay — a truthful task narration is NO LONGER a phantom', () => {
  it('REPLAYS the mishap: the 0945e820 dispatch claim with the 12-step task result in parts now audits CLEAN — no ticket, no retraction', async () => {
    // The extraction pass labels the narration a [dispatch] claim, exactly as
    // it did in the incident (the claim detail quotes the note verbatim).
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: TASK_CLAIM_DETAIL }],
    }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS,
      machineTriggered: false,
    });
    expect(comp.phantoms).toEqual([]); // THE FIX: exonerated by the task lane
    expect(comp.executed.some((a) => a.tool === 'computer_task' && a.ok)).toBe(true);

    // End-to-end through the user-facing lane: nothing files, nothing retracts.
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: INCIDENT_PARTS, receipts: NO_RECEIPTS, machineTriggered: false });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('the receipts-provided pool shape is covered too (the supervisor / machine-wake callers)', async () => {
    // The supervisor seam passes receipts (empty here — no platform tool ran)
    // plus parts. Task executions must still ride the pool.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: TASK_CLAIM_DETAIL }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS,
      machineTriggered: true, supervisor: true,
    });
    expect(comp.phantoms).toEqual([]);
    // The refutation WRITER is attached for supervisor audits but never
    // INVOKED — no conviction, no durable refutation row.
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('a task narration with steps: 0 (capability gate — the session NEVER ran) still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: TASK_CLAIM_DETAIL }],
    }) as never);
    const parts = [
      { type: 'tool_call', name: 'computer_task', args: { task: 'find the PDF' } },
      { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 0 · mac: offline]\nNo paired Mac online.' },
    ] as any[];
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts, receipts: NO_RECEIPTS, machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'dispatch' });
  });

  it('a task narration with NO task call in the run at all still convicts (the d78f477b shape is preserved)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: TASK_CLAIM_DETAIL }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'dispatch' });
  });
});

describe('ticket 61b9200a — budget isolation (no laundering in either direction)', () => {
  const never = async () => false;
  const task = (ok: boolean): ExecutedAction => ({ tool: 'computer_task', ok, staged: false, ids: {} });
  const session = (): ExecutedAction => ({ tool: 'start_coding_session', ok: true, staged: false, ids: {} });

  it('a phantom PLATFORM-dispatch claim is NOT exonerated by an unrelated real task run', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'I dispatched a worker to the fleet lane' }];
    expect(await findPhantomClaims(claims, [task(true)], never)).toEqual(claims);
  });

  it('a task-idiom claim IS exonerated by the run\'s own task execution', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'I ran a computer task to find the PDF' }];
    expect(await findPhantomClaims(claims, [task(true)], never)).toEqual([]);
  });

  it('a task-idiom claim falls through to the platform budget when no task ran but a session did (miss over false strike)', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'dispatched a session to run the browser-use check' }];
    expect(await findPhantomClaims(claims, [session()], never)).toEqual([]);
  });

  it('N task narrations need N task executions (count budget holds per budget, not across)', async () => {
    const claims: ExtractedClaim[] = [
      { kind: 'dispatch', detail: 'I ran a computer task to find the PDF' },
      { kind: 'dispatch', detail: 'I ran a browser task to read the page' },
    ];
    // One task execution: the second task narration convicts…
    expect(await findPhantomClaims(claims, [task(true)], never)).toHaveLength(1);
    // …and a platform session execution absorbs at most ONE task narration
    // (the deliberate fall-through — miss over false strike); the second
    // still convicts.
    expect(await findPhantomClaims(claims, [session()], never)).toHaveLength(1);
    expect((await findPhantomClaims(claims, [session()], never))[0].detail).toContain('browser task');
  });
});

// 2026-10-04 (live query suite, scripts/e2e/query-suite.py): an HONEST failure report on a plain
// human chat — "my browser task timed out, so I verified by fetching the page directly" — was
// mined as a [dispatch] claim; the timed-out browser_task is ok:false (no step header), so the
// ok-only pool dropped it and the post-delivery lane posted a false "did NOT actually run"
// correction. The FAILURE-REPORT tier vouches it by the ATTEMPTED call.
describe('failure-report tier — an honest "it timed out" never convicts when the attempt is on record', () => {
  const NOTE = 'The exact page heading is **Example Domain** — my browser task timed out, so I verified by fetching the page directly.';
  const DETAIL = 'my browser task timed out';
  const TIMED_OUT_PARTS = [
    { type: 'tool_call', name: 'browser_task', args: { task: 'open https://example.com and read the heading' } },
    { type: 'tool_result', name: 'browser_task', result: 'Tool call failed: browser agent session timed out after 120000ms. DO NOT retry this tool. Use the information you already have to answer the user\'s question directly.' },
    { type: 'tool_call', name: 'scrape_as_markdown', args: { url: 'https://example.com' } },
    { type: 'tool_result', name: 'scrape_as_markdown', result: '# Example Domain\nThis domain is for use in illustrative examples.' },
  ] as any[];

  afterEach(() => { delete process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED; });

  it('REPLAYS the suite finding: the timed-out browser_task + "my browser task timed out" audits CLEAN — no ticket, no correction row', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [{ kind: 'dispatch', detail: DETAIL }] }) as never);
    const comp = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: NOTE, parts: TIMED_OUT_PARTS, receipts: NO_RECEIPTS, machineTriggered: false });
    expect(comp.executed.some((a) => a.tool === 'browser_task' && !a.ok)).toBe(true); // the attempt is on record, failed
    expect(comp.phantoms).toEqual([]);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: NOTE, parts: TIMED_OUT_PARTS, receipts: NO_RECEIPTS, machineTriggered: false });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a failure report with NO attempt of its family on record still convicts (a made-up attempt is a phantom)', async () => {
    const out = await findPhantomClaims([{ kind: 'dispatch', detail: DETAIL } as ExtractedClaim], [], async () => false);
    expect(out).toHaveLength(1);
  });

  it('a platform failure report is vouched only by its own kind\'s attempt, never by an unrelated task', async () => {
    const failedDispatch: ExecutedAction = { tool: 'start_coding_session', ok: false, staged: false, ids: {} };
    const unrelatedTask: ExecutedAction = { tool: 'browser_task', ok: false, staged: false, ids: {} };
    const claim = { kind: 'dispatch', detail: 'the coding session failed to start' } as ExtractedClaim;
    expect(await findPhantomClaims([claim], [failedDispatch], async () => false)).toEqual([]);
    expect(await findPhantomClaims([claim], [unrelatedTask], async () => false)).toHaveLength(1);
  });

  it('a SUCCESS claim is untouched: a failed attempt never vouches "I ran a browser task"', async () => {
    const failedTask: ExecutedAction = { tool: 'browser_task', ok: false, staged: false, ids: {} };
    const out = await findPhantomClaims([{ kind: 'dispatch', detail: 'I ran a browser task to read the heading' } as ExtractedClaim], [failedTask], async () => false);
    expect(out).toHaveLength(1);
  });

  it('ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED=1 restores the conviction and the old extraction prompt', async () => {
    process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED = '1';
    const failedTask: ExecutedAction = { tool: 'browser_task', ok: false, staged: false, ids: {} };
    expect(await findPhantomClaims([{ kind: 'dispatch', detail: DETAIL } as ExtractedClaim], [failedTask], async () => false)).toHaveLength(1);
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never);
    await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: NOTE, parts: [], receipts: NO_RECEIPTS, machineTriggered: false });
    const sys = (mockUtilityChat.mock.calls.at(-1) as any)?.[0]?.[0]?.content as string;
    expect(sys).not.toMatch(/FAILED, timed out/);
  });

  it('the extraction prompt tells the extractor to ignore failure reports (switch on by default)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never);
    await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: NOTE, parts: [], receipts: NO_RECEIPTS, machineTriggered: false });
    const sys = (mockUtilityChat.mock.calls.at(-1) as any)?.[0]?.[0]?.content as string;
    expect(sys).toMatch(/reports that an action FAILED, timed out, errored or did not complete/);
  });
});

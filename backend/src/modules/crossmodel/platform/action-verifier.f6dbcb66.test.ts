/**
 * Ticket f6dbcb66-84f4-45ed-8939-08ce0bceb127 (mishap, av-mishap family,
 * 2026-11-03T02:11Z): "Phantom action claim: chat asserted action(s) never
 * executed (chat 026682ae)".
 *
 * THE INCIDENT: the note narrated, verbatim, "**The Mac task ran and delivered
 * the link.**" The run's ONLY consequential execution was computer_task →
 * {"taskTool":"computer_task","steps":"7"} — a REAL seven-step desktop task.
 * The claim was therefore TRUE, and the action-verifier struck it as a
 * [dispatch] phantom ~5s after delivery.
 *
 * WHY: TASK_OUTCOME_IDIOM (executed-actions.ts) — the task-budget arm's
 * SECOND surface (ticket 9bd94417) — recognised only two shapes: a copula
 * with open/opened/running/visible/launched/up ("Discord is now open on its
 * screen") and an open/launch/start verb ("I opened Discord on the Mac").
 * "ran" and "delivered" are in NEITHER list, so the claim reached neither
 * task-budget arm (:3964 / :3984), fell to the platform dispatch slot, and
 * KIND_TOOLS.dispatch deliberately excludes task tools (:255-261) — so no
 * pool entry could vouch a task that had genuinely run. Convicted at :4050.
 *
 * THE FIX: a third arm — the DEVICE-QUALIFIED TASK SUBJECT. "The Mac task ran
 * and delivered the link", "the computer task finished", "the browser task
 * completed". Laundering guard identical in spirit to its siblings: the device
 * word must qualify the task (≤2 modifiers between them), so platform claims
 * naming a bare task ("the parity task finished") never route here and a
 * fabricated "The Mac task ran" with NO task slot still convicts.
 *
 * DETECTOR-RECALL REPLAY obligations of this change (the task-budget
 * register's PRIOR true positives and its pinned negatives, replayed below):
 * ticket 9bd94417's own incident detail ("Discord is now open on its screen"),
 * the copula and verb shapes it added, and its five LAUNDERING negatives
 * ("the PR is now open on GitHub", "the ticket is now open on the board", …)
 * — none may stop firing, and none may start vouching a platform claim.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import { computePhantomClaims, verifyRunActionClaimsAsync, ExtractedClaim } from './action-verifier';
import { isTaskOutcomeClaimDetail } from './executed-actions';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));
const CHAT = '026682ae-aa3b-44e6-b568-a0a1b9b3353b'; // the mishap's real chat id

/** The ticket's verbatim phantom claim — a [dispatch] whose subject is the
 * delegated Mac task and whose verb is a completion ("ran"/"delivered"). */
const PHANTOM_DETAIL = 'The Mac task ran and delivered the link';

/** The incident note (the excerpt the ticket quotes, plus the surrounding
 * honesty the model actually wrote: it explicitly said the destination was
 * "not yet verified"). */
const INCIDENT_NOTE = [
  'The link is now open in Firefox on your Mac — but the capture broke before I could see where it landed, so the final destination is **not yet verified**.',
  '',
  'What actually happened this run:',
  '',
  `- **${PHANTOM_DETAIL}.** Input worked (Spotlight opened, 94% pixels changed), Firefox took focus, and it received the full redirect URL.`,
  '- **Screen capture is dead, so I saw nothing.** Every screenshot came back as a flat solid frame.',
].join('\n');

/** The run's REAL parts: one computer_task call + its 7-step result. Task
 * tools mint no receipts (RECEIPT_TOOLS excludes them), so the MessagePart
 * log is the ONLY execution evidence — exactly as in the incident. */
const INCIDENT_PARTS = [
  { type: 'tool_call', name: 'computer_task', args: { task: 'Open the redirect URL in Firefox and report where it lands.' } },
  { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 7 · mac: connected (MacBook Pro)]\nFirefox opened the redirect URL.' },
] as any[];

const NO_RECEIPTS: ToolReceipt[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockUtilityChat.mockReset();
  mockUtilityChat.mockResolvedValue('');
});

describe('ticket f6dbcb66 idiom — a device-qualified TASK SUBJECT reporting completion', () => {
  it('recognizes the incident narration and its siblings', () => {
    expect(isTaskOutcomeClaimDetail(PHANTOM_DETAIL)).toBe(true);
    expect(isTaskOutcomeClaimDetail('the computer task finished in seven steps')).toBe(true);
    expect(isTaskOutcomeClaimDetail('the browser task completed')).toBe(true);
    expect(isTaskOutcomeClaimDetail('the Mac task executed and delivered the page')).toBe(true);
    // a modifier between device and task still reads as the same subject
    expect(isTaskOutcomeClaimDetail('the Mac desktop task ran to completion')).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY (9bd94417 prior true positives): every earlier outcome shape STILL fires', () => {
    // The register's own incident detail and the shapes its fix added. The new
    // arm must not have narrowed, reordered or shadowed any of them.
    expect(isTaskOutcomeClaimDetail('Discord is now open on its screen')).toBe(true);
    expect(isTaskOutcomeClaimDetail('the app was left open on the Mac')).toBe(true);
    expect(isTaskOutcomeClaimDetail('Discord is running on the desktop')).toBe(true);
    expect(isTaskOutcomeClaimDetail('the window is visible on screen')).toBe(true);
    expect(isTaskOutcomeClaimDetail('I opened Discord on the Mac')).toBe(true);
    expect(isTaskOutcomeClaimDetail('launched Chrome on its screen')).toBe(true);
    expect(isTaskOutcomeClaimDetail('started the server on the desktop')).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY (9bd94417 pinned negatives): the device/screen surface is still the laundering guard', () => {
    // Platform outcomes never route to the task budget — with no task slot on
    // record they must keep falling through to their own kind's budget.
    expect(isTaskOutcomeClaimDetail('the PR is now open on GitHub')).toBe(false);
    expect(isTaskOutcomeClaimDetail('the ticket is now open on the board')).toBe(false);
    expect(isTaskOutcomeClaimDetail('I opened a ticket on the board')).toBe(false);
    expect(isTaskOutcomeClaimDetail('opened the report on the wiki')).toBe(false);
    expect(isTaskOutcomeClaimDetail('')).toBe(false);
    // …and the new arm's OWN laundering boundary: a task with no device
    // qualifier is not a desktop-task claim, so it never spends a task slot.
    expect(isTaskOutcomeClaimDetail('the parity task finished')).toBe(false);
    expect(isTaskOutcomeClaimDetail('the task ran to completion')).toBe(false);
  });
});

describe('ticket f6dbcb66 replay — the incident claim after a REAL 7-step task is NO LONGER a phantom', () => {
  it('REPLAYS the mishap: the [dispatch] claim audits CLEAN against the computer_task parts', async () => {
    const claim: ExtractedClaim = { kind: 'dispatch', detail: PHANTOM_DETAIL, id: '' };
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [claim] }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS,
      machineTriggered: false,
    });

    expect(comp.phantoms).toEqual([]); // THE FIX: exonerated by the task-subject arm
    expect(comp.executed.some((a) => a.tool === 'computer_task' && a.ok)).toBe(true);
  });

  it('end-to-end through the user-facing lane: nothing files a mishap, nothing retracts the note', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: PHANTOM_DETAIL, id: '' }],
    }) as never);

    verifyRunActionClaimsAsync({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS, machineTriggered: false,
    });
    await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('WITHOUT a task execution the same claim STILL convicts (a fabricated "Mac task ran" stays a phantom)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: PHANTOM_DETAIL, id: '' }] }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: [] as any[], receipts: NO_RECEIPTS,
      machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(PHANTOM_DETAIL);
  });

  it('a steps:0 task (capability gate, no session started) does NOT vouch the claim', async () => {
    // The new device-task arm must NOT launder a task that never ran. A
    // capability-gate result (`steps: 0`) is parsed to ok:false by
    // parseTaskResult, and the verifier's pool is built as
    // `executed.filter(a => a.ok || a.staged === true)`, so such a task never
    // enters the pool and can never occupy a task slot. The device-qualified
    // subject is a NECESSARY condition for exoneration, never a sufficient one
    // — the claim still needs a real execution behind it.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: PHANTOM_DETAIL, id: '' }] }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: [
        { type: 'tool_call', name: 'computer_task', args: { task: 'Open the URL.' } },
        { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 0]' },
      ] as any[],
      receipts: NO_RECEIPTS,
      machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(PHANTOM_DETAIL);
  });
});
/**
 * REPLAY PIN — ticket 9bd94417-3751-4d73-bd9e-af8d6703a9bd (mishap, 2026-10-27):
 * "Phantom action claim: chat asserted action(s) never executed (chat 18a957cb)".
 *
 * The mishap: a user-facing chat turn in chat 18a957cb narrated, truthfully,
 * "**Discord is now open on its screen**" after a REAL 10-step computer_task
 * against mbp-1 (the run's own verifier record shows computer_task →
 * {"taskTool":"computer_task","steps":"10"}). The 61b9200a task-budget lane
 * exists but its idiom keys on the tool's NAME ("computer task", "computer
 * use", "browser agent") — the outcome narration names neither the tool nor
 * the task, so the claim fell to the platform budget KIND_TOOLS.dispatch
 * deliberately cannot fill and the TRUE claim was CONVICTED as a [dispatch]
 * phantom, filing this ticket.
 *
 * The fix (three seams, mirroring the 61b9200a discipline):
 *   1. executed-actions.ts — isTaskOutcomeClaimDetail: an OUTCOME idiom for a
 *      delegated task's result ("X is now open on its screen", "I opened X on
 *      the Mac"), every arm gated on a device/screen surface so platform
 *      claims never route here.
 *   2. findPhantomClaims — a SIBLING id-less task-budget arm behind the
 *      outcome idiom, spending the SAME dedicated task pool (never a platform
 *      slot first), with the same deliberate fall-through.
 *   3. claimNarratesAnyTrackedAction + failureReportAttempted — the outcome
 *      idiom joins the tracked-action families, so the 7cabb0cc run-self-
 *      incompletion scope guard keeps holding ("...but ran out of time" with
 *      a task slot is still vouched; without one it still convicts) and an
 *      honest "X failed to open on its screen" reports the task attempt.
 *
 * DETECTOR-RECALL REPLAY: every case that replays a PRIOR true positive of
 * the phantom detector (the 61b9200a shapes: tool-name idiom, steps:0
 * capability gate, no-task-call fabrication, platform-laundering guard, count
 * budget, 7cabb0cc guard) is marked inline and asserts it STILL convicts /
 * still exonerates exactly as before — the relaxation must not recall a
 * convicting shape.
 *
 * Mock discipline mirrors action-verifier.61b9200a.test.ts.
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

import { verifyRunActionClaimsAsync, computePhantomClaims, findPhantomClaims, ExtractedClaim } from './action-verifier';
import { ExecutedAction, isTaskOutcomeClaimDetail } from './executed-actions';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));
// The mishap's real chat id — the replay must read true against it.
const CHAT = '18a957cb-641a-43c1-9d5a-89549c457a99';

// Verbatim claim detail from the ticket (the action-verifier's own extraction
// labelled this line a [dispatch] phantom; the cited id "mbp-1" fails the
// idish hex gate, so the claim rode the id-less lane).
const OUTCOME_CLAIM_DETAIL = 'Discord is now open on its screen';

// Verbatim incident shape: the note excerpt from the ticket.
const INCIDENT_NOTE = `Done — mbp-1 (cql-stanne-mbp1) is under control and **${OUTCOME_CLAIM_DETAIL}**. The Mac app (v0.9.10) was connected, capture was clean and readable the whole run.

What it found and did:

- Discord was **not** running — it freshly launched it (Spotlight/Dock didn't cooperate, so it launched via Finder → Discord.app + Cmd+O)
- Signed in as **pastapaul**, status Online — no login needed
- Now showing server **TCG Match Making**, channel **#youtube-videos**
- Open-and-verify only: no channels clicked, no messages sent`;

// The run's REAL parts (chat 18a957cb): the computer_task call + its 10-step
// result. Task tools mint no receipts, so this is the only execution lane.
const INCIDENT_PARTS = [
  { type: 'tool_call', name: 'computer_task', args: { task: 'Open Discord on mbp-1 and verify it is showing.' } },
  { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 10 · mac: connected (MacBook Pro)]\nDiscord is open and showing the TCG Match Making server.' },
] as any[];

// The run's receipts as the chat seam passed them: EMPTY — computer_task mints
// none (RECEIPT_TOOLS excludes it) and the incident run ran no platform tool.
const NO_RECEIPTS: ToolReceipt[] = [];

// task/budget helpers mirroring the 61b9200a suite.
const never = async (): Promise<boolean> => false;
const task = (ok: boolean): ExecutedAction => ({ tool: 'computer_task', ok, staged: false, ids: {} });
const session = (): ExecutedAction => ({ tool: 'start_coding_session', ok: true, staged: false, ids: {} });

describe('ticket 9bd94417 idiom — isTaskOutcomeClaimDetail', () => {
  it('recognizes the outcome narration shapes (the incident verbatim first)', () => {
    expect(isTaskOutcomeClaimDetail(OUTCOME_CLAIM_DETAIL)).toBe(true);
    expect(isTaskOutcomeClaimDetail('the app was left open on the Mac')).toBe(true);
    expect(isTaskOutcomeClaimDetail('Discord is running on the desktop')).toBe(true);
    expect(isTaskOutcomeClaimDetail('the window is visible on screen')).toBe(true);
    expect(isTaskOutcomeClaimDetail('I opened Discord on the Mac')).toBe(true);
    expect(isTaskOutcomeClaimDetail('launched Chrome on its screen')).toBe(true);
  });

  it('does NOT recognize platform outcomes — the device/screen surface is the laundering guard', () => {
    expect(isTaskOutcomeClaimDetail('the PR is now open on GitHub')).toBe(false);
    expect(isTaskOutcomeClaimDetail('the ticket is now open on the board')).toBe(false);
    expect(isTaskOutcomeClaimDetail('I opened a ticket on the board')).toBe(false);
    expect(isTaskOutcomeClaimDetail('opened the report on the wiki')).toBe(false);
    expect(isTaskOutcomeClaimDetail('')).toBe(false);
  });
});

describe('ticket 9bd94417 replay — an outcome narration after a real task is NO LONGER a phantom', () => {
  it('REPLAYS the mishap: the 18a957cb [dispatch] claim with the 10-step task result in parts now audits CLEAN', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: OUTCOME_CLAIM_DETAIL, id: 'mbp-1' }],
    }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS,
      machineTriggered: false,
    });
    expect(comp.phantoms).toEqual([]); // THE FIX: exonerated by the outcome arm of the task budget
    expect(comp.executed.some((a) => a.tool === 'computer_task' && a.ok)).toBe(true);

    // End-to-end through the user-facing lane: nothing files, nothing retracts.
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: INCIDENT_PARTS, receipts: NO_RECEIPTS, machineTriggered: false });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('an outcome claim with NO task execution on record still convicts (a fabricated "Discord is open" stays a phantom)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: OUTCOME_CLAIM_DETAIL }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'dispatch' });
  });
});

describe('ticket 9bd94417 — DETECTOR-RECALL REPLAY: the 61b9200a true positives STILL fire', () => {
  it('RECALL: tool-name idiom claim is still exonerated by the run\'s own task execution', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'I ran a computer task to find the PDF' }];
    expect(await findPhantomClaims(claims, [task(true)], never)).toEqual([]);
  });

  it('RECALL: a task narration with steps: 0 (capability gate — the session NEVER ran) still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: OUTCOME_CLAIM_DETAIL }],
    }) as never);
    const parts = [
      { type: 'tool_call', name: 'computer_task', args: { task: 'open Discord' } },
      { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 0 · mac: offline]\nNo paired Mac online.' },
    ] as any[];
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts, receipts: NO_RECEIPTS, machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0]).toMatchObject({ kind: 'dispatch' });
  });

  it('RECALL (d78f477b): a task-idiom claim with no task call in the run at all still convicts', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'I ran a computer task to find the PDF' }];
    expect(await findPhantomClaims(claims, [], never)).toEqual(claims);
  });

  it('RECALL: a phantom PLATFORM-dispatch claim is NOT exonerated by an unrelated real task run', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'I dispatched a worker to the fleet lane' }];
    expect(await findPhantomClaims(claims, [task(true)], never)).toEqual(claims);
  });

  it('RECALL (laundering guard): platform outcome claims never spend TASK slots — a task run does not acquit them', async () => {
    const claims: ExtractedClaim[] = [
      { kind: 'dispatch', detail: 'the PR is now open on GitHub' },
      { kind: 'dispatch', detail: 'the ticket is now open on the board' },
    ];
    // A real task run does NOT acquit either platform claim (no task-slot route).
    expect(await findPhantomClaims(claims, [task(true)], never)).toEqual(claims);
    // One platform session falls through to the platform budget for at most
    // ONE of them (the 61b9200a miss-over-false-strike fall-through) — the
    // second still convicts, and the TASK slot stays untouched either way.
    expect(await findPhantomClaims(claims, [task(true), session()], never)).toHaveLength(1);
  });

  it('RECALL: N task/outcome narrations need N task executions (count budget holds; platform slots absorb at most one each)', async () => {
    const claims: ExtractedClaim[] = [
      { kind: 'dispatch', detail: 'I ran a computer task to find the PDF' },
      { kind: 'dispatch', detail: 'Discord is now open on its screen' },
    ];
    // One task execution: the second narration convicts…
    expect(await findPhantomClaims(claims, [task(true)], never)).toHaveLength(1);
    // …and a platform session execution absorbs at most ONE task narration
    // (the deliberate fall-through — miss over false strike); the second
    // still convicts.
    expect(await findPhantomClaims(claims, [session()], never)).toHaveLength(1);
    expect((await findPhantomClaims(claims, [session()], never))[0].detail).toBe(claims[1].detail);
    // Two task executions vouch both.
    expect(await findPhantomClaims(claims, [task(true), task(true)], never)).toEqual([]);
  });
});

describe('ticket 9bd94417 — the 7cabb0cc scope guard rides the new idiom', () => {
  it('RECALL (61b9200a steps:0 shape): "I ran a computer task … but ran out of time" with NO task slot still convicts', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'I ran a computer task to find the PDF but ran out of time to verify it' }];
    expect(await findPhantomClaims(claims, [], never)).toEqual(claims);
  });

  it('an outcome claim + "ran out of time" is vouched by a real task slot (tracked-action guard updated for the new idiom)', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'Discord is now open on its screen but I ran out of time to verify the badges' }];
    expect(await findPhantomClaims(claims, [task(true)], never)).toEqual([]);
  });

  it('an outcome claim + "ran out of time" with NO task slot still convicts', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'Discord is now open on its screen but I ran out of time to verify the badges' }];
    expect(await findPhantomClaims(claims, [], never)).toEqual(claims);
  });
});

describe('ticket 9bd94417 — failure-report tier covers the outcome shape', () => {
  it('an honest "Discord failed to open on its screen" is vouched by the ATTEMPTED computer_task (ok:false, non-consuming)', async () => {
    const failedTask: ExecutedAction = { tool: 'computer_task', ok: false, staged: false, ids: {} };
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'Discord failed to open on its screen' }];
    expect(await findPhantomClaims(claims, [failedTask], never)).toEqual([]);
  });

  it('the same failure report with NO task attempt at all still convicts', async () => {
    const claims: ExtractedClaim[] = [{ kind: 'dispatch', detail: 'Discord failed to open on its screen' }];
    expect(await findPhantomClaims(claims, [], never)).toEqual(claims);
  });
});

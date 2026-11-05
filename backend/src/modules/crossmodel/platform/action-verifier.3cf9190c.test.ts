/**
 * Ticket 3cf9190c-9d36-4bc5-a64e-1e5eb9a37a2b (mishap, av-mishap family,
 * 2026-11-03T01:11Z): "Supervisor phantom claim: narrated action(s) never
 * executed (chat 65c98b82)".
 *
 * THE INCIDENT: a project supervisor's machine-wake note reported, of lane
 * f7e14cf8, "**Done this turn:** … is restored from the archive and ready."
 * and then — in its own words — "**NOT done yet:** the diagnostic itself
 * hasn't been dispatched — the lane is restored but untasked. The follow-
 * through below steers it the moment this answer lands." The ONLY
 * consequential tool that ran was archive_chat (unarchive). The note closed
 * with the harness continuation template:
 *
 *   "Still working on this in the background — steer restored lane f7e14cf8
 *    with the Pi diagnosis brief (reachability, dashboard service + today's
 *    logs, LAN IP vs 192.168.1.126); apply minimal fix, verify the dashboard
 *    URL answers, report root cause here and notify owner on Telegram. I will
 *    post the result here."
 *
 * The verifier struck, as a [dispatch] phantom, the FIRST of those items:
 *   "steer restored lane f7e14cf8 with the Pi diagnosis brief (reachability,
 *    dashboard service + today's logs, LAN IP vs 192.168.1.126)"
 * — the note's own promise, struck while the note itself said it had not
 * happened yet.
 *
 * THE ROOT CAUSE: isCompletedActionItems / COMPLETED_ACTION_ITEMS_RE is an
 * UNANCHORED substring test over a whole clause, while the house rule it
 * implements (the § "Verb-bound, house style" comment on that very regex)
 * requires the verb to HEAD a clause and be a completed-action form — never
 * the infinitive/future/gerund intent forms. "steer restored lane …" HEADS
 * with the base-form verb "steer" (an imperative promise); "restored" is an
 * attributive participle modifying "lane" (the LANE was restored; the STEER
 * was not sent). The unanchored test saw "restored", mined the clause, then
 * MINER_KINDS found no dispatch verb ("dispatched|started|spawned|launched")
 * and mineContinuationClaims' `?? 'dispatch'` default classified it; id-less,
 * no dispatch slot existed, so it was convicted.
 *
 * THE FIX: isCompletedActionClause — a clause whose HEAD is a base-form
 * (imperative/infinitive) action verb is the armed round's promise, never a
 * completed-action claim. Used for BOTH the mining decision and the per-clause
 * judgement. Deliberately a DENYLIST, not an allowlist: any clause whose head
 * is neither list keeps the pre-fix verdict byte-for-byte, so only the
 * imperative class changes and no prior true positive loses its conviction.
 *
 * DETECTOR-RECALL REPLAY obligations of this change (replayed below): the
 * continuation register's PRIOR true positives — ticket 5c7727c4's own
 * "pushed the hotfix and confirmed prod green" (which must STILL mine and
 * convict), its truthful twin "dispatched the probe lane on the RED-SNOW
 * goal" (which must still mine and be EXONERATED by its own receipt), and
 * 3cf9190c's own promise-shaped clause (which must stop mining).
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

import {
  computePhantomClaims,
  isCompletedActionClause,
  isCompletedActionItems,
  splitContinuationClauses,
} from './action-verifier';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));
const CHAT = '65c98b82-68b8-493a-bb72-086c28c92867'; // the mishap's real chat id

/** The harness-appended line, VERBATIM from the incident note (msg 64a2befc). */
const INCIDENT_LINE = 'Still working on this in the background — steer restored lane f7e14cf8 with the Pi diagnosis brief (reachability, dashboard service + today\'s logs, LAN IP vs 192.168.1.126); apply minimal fix, verify the dashboard URL answers, report root cause here and notify owner on Telegram. I will post the result here.';

/** The clause the verifier struck — clause 1 of that line's items. */
const STRUCK_DETAIL = 'steer restored lane f7e14cf8 with the Pi diagnosis brief (reachability, dashboard service + today\'s logs, LAN IP vs 192.168.1.126)';

/** The note as delivered (the ticket's excerpt, in the model's own words). */
const INCIDENT_NOTE = [
  '**Most likely the Pi\'s address drifted or the dashboard service went down — a "can\'t open page" on one device after two quiet weeks smells like a stale URL, not Safari.** As of 5:10 PM PDT (01:07Z):',
  '',
  '**Done this turn:** the Pi verification lane (f7e14cf8 — the same lane that fixed the doorbell, with full context on this box) is restored from the archive and ready.',
  '',
  '**NOT done yet:** the diagnostic itself hasn\'t been dispatched — the lane is restored but untasked. The follow-through below steers it the moment this answer lands: read-only probes first (tailnet reachability, dashboard service state + today\'s logs, current LAN IP vs . 126), then the minimal fix and verification.',
  '',
  INCIDENT_LINE,
].join('\n');

/** The run's ONLY consequential execution: archive_chat (unarchive) — it mints
 * a receipt, and it is NOT a dispatch. */
const ARCHIVE_RECEIPT: ToolReceipt = {
  id: '2f2bf9f6', chatId: CHAT, runId: 'chat-1', tool: 'archive_chat', ok: true,
  ids: { receiptId: '2f2bf9f6-f15a-4c91-91e3-c9d92a1a0502', chatId: 'f7e14cf8-2d0f-4e61-b152-81c1376d4b77' },
  inputHash: null, outputHash: null, createdAt: new Date('2026-11-03T01:10:30Z'),
} as any;

const BASE_INPUT = (note: string) => ({
  chatId: CHAT, userId: 'u-1', finalText: note, parts: [] as any[],
  receipts: [ARCHIVE_RECEIPT], runStartedAt: new Date('2026-11-03T01:07:33Z'),
  supervisor: true, supervisorScope: 'project' as const, machineTriggered: true,
  harnessContinuationLine: INCIDENT_LINE,
});

/** The harness template's fixed head/tail (owner-answer-first.ts
 * followThroughContinuationLine) — the model-authored items sit between them.
 * Duplicated here as literals because the verifier's copies are local consts
 * inside computePhantomClaims, not module exports. */
const CONTINUATION_HEAD = 'Still working on this in the background — ';
const CONTINUATION_TAIL = '. I will post the result here.';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockUtilityChat.mockReset();
  mockUtilityChat.mockResolvedValue('');
  // The note cites lane f7e14cf8 — a REAL restored chat in the incident. The
  // session/chat CITATION lane reads the full note and convicts ids that do
  // not exist, so a null-mocked DB would produce a phantom this ticket is NOT
  // about and mask the action lane under test. Return the row (its harmless —
  // the lane really exists).
  mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'f7e14cf8-2d0f-4e61-b152-81c1376d4b77' });
});

describe('ticket 3cf9190c idiom — the completed-action gate is HEAD-anchored', () => {
  it('the incident clause is an intent-shaped PROMISE, not a completed action', () => {
    // The clause the verifier struck, verbatim from the ticket.
    expect(isCompletedActionClause(STRUCK_DETAIL)).toBe(false);
    // …and the unanchored precheck still SEES "restored" — the exact blindness
    // the incident exploited, pinned so the fix cannot silently regress.
    expect(isCompletedActionItems(STRUCK_DETAIL)).toBe(true);
    // The promise clause is one of the line's clauses, and none of them mines.
    const clauses = splitContinuationClauses(INCIDENT_LINE.slice(CONTINUATION_HEAD.length, INCIDENT_LINE.length - CONTINUATION_TAIL.length));
    expect(clauses).toContain(STRUCK_DETAIL);
    expect(clauses.some((c) => isCompletedActionClause(c))).toBe(false);
  });

  it('every imperative/infinitive action head is a promise, never a completed action', () => {
    expect(isCompletedActionClause('apply minimal fix')).toBe(false);
    expect(isCompletedActionClause('verify the dashboard URL answers')).toBe(false);
    expect(isCompletedActionClause('report root cause here and notify owner on Telegram')).toBe(false);
    expect(isCompletedActionClause('probe tailnet reachability')).toBe(false);
    expect(isCompletedActionClause('restart the dashboard service if down')).toBe(false);
  });

  it('DETECTOR-RECALL REPLAY (5c7727c4 prior true positives): completed-action items STILL pass the gate', () => {
    // The register's own pinned phantom, verbatim from action-verifier.5c7727c4.test.ts.
    expect(isCompletedActionClause('pushed the hotfix and confirmed prod green')).toBe(true);
    // Its truthful twin — mined, then exonerated by its own run receipt.
    expect(isCompletedActionClause('dispatched the probe lane on the RED-SNOW goal')).toBe(true);
    // Other heads the register relies on.
    expect(isCompletedActionClause('filed the ticket and posted the summary')).toBe(true);
    expect(isCompletedActionClause('merged the PR and deployed the fix')).toBe(true);
    // A leading adverb never changes the clause's mood.
    expect(isCompletedActionClause('also pushed the hotfix')).toBe(true);
    // A passive clause whose head is not an imperative keeps the OLD verdict.
    expect(isCompletedActionClause('the lane was restored from the archive')).toBe(true);
  });
});

describe('ticket 3cf9190c replay — the incident note no longer convicts its own promise', () => {
  it('REPLAYS the mishap: the note audits CLEAN (the promise is mined as nothing)', async () => {
    // The extractor is a coin flip; let it produce nothing (the honest miss),
    // so the ONLY possible claim source is the continuation-line miner.
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);

    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT_NOTE));
    await flush();

    expect(comp.phantoms).toEqual([]);
    // The promise was never turned into a claim at all.
    expect(comp.claims.some((c) => c.detail.includes('steer restored lane'))).toBe(false);
  });

  it('the archived lane still reads as RESTORED — the note\'s own "Done this turn" is not a dispatch claim', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT_NOTE));
    await flush();
    expect(comp.phantoms).toEqual([]);
  });

  it('DETECTOR-RECALL REPLAY (5c7727c4): a REAL phantom in the same template STILL convicts', async () => {
    // The register's anti-laundering true positive: the model's own completed
    // words, reframed into the harness template, must keep being mined and
    // struck — the fix must not turn into a laundering hole.
    const launderingLine = 'Still working on this in the background — pushed the hotfix and confirmed prod green. I will post the result here.';
    const note = `**Not done:** nothing yet.\n\n${launderingLine}`;
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [] as any[],
      receipts: [] as any[], runStartedAt: new Date('2026-11-03T01:07:33Z'),
      supervisor: true, supervisorScope: 'project' as const, machineTriggered: true,
      harnessContinuationLine: launderingLine,
    });
    await flush();

    expect(comp.claims.some((c) => c.detail === 'pushed the hotfix and confirmed prod green')).toBe(true);
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toContain('pushed the hotfix');
  });

  it('DETECTOR-RECALL REPLAY (5c7727c4): a TRUTHFUL mined item is still exonerated, not auto-convicted', async () => {
    const truthfulLine = 'Still working on this in the background — dispatched the probe lane on the RED-SNOW goal. I will post the result here.';
    const note = `**Not done:** nothing yet.\n\n${truthfulLine}`;
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [] as any[],
      receipts: [{
        id: 'aa11bb22', chatId: CHAT, runId: 'run-1', tool: 'start_coding_session', ok: true,
        ids: { sessionId: 'b6b1e0e1-ea32-4dcc-a604-925fca12bd91' },
        inputHash: null, outputHash: null, createdAt: new Date('2026-11-03T01:07:40Z'),
      }] as any[],
      runStartedAt: new Date('2026-11-03T01:07:33Z'),
      supervisor: true, supervisorScope: 'project' as const, machineTriggered: true,
      harnessContinuationLine: truthfulLine,
    });
    await flush();

    expect(comp.phantoms).toHaveLength(0);
  });

  it('an INTENT line with no completed-action clause at all does not mine', async () => {
    const promiseLine = 'Still working on this in the background — apply the minimal fix, verify the dashboard answers, report the root cause here. I will post the result here.';
    mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: `**Not done yet.**\n\n${promiseLine}`, parts: [] as any[],
      receipts: [] as any[], runStartedAt: new Date('2026-11-03T01:07:33Z'),
      supervisor: true, supervisorScope: 'project' as const, machineTriggered: true,
      harnessContinuationLine: promiseLine,
    });
    await flush();

    expect(comp.phantoms).toEqual([]);
  });

  // ── Adversarial review regressions (3cf9190c, independent reviewer) ──────
  // Each of the following was a REAL finding against the first cut of the fix.

  it('REVIEW F1: a BASE-form imperative `push` does not mine (the allowlist admitted it)', () => {
    // The allowlist is tested BEFORE the denylist, and `push(?:ed)?` matched the
    // BASE form — so this imperative promise mined and convicted, the incident's
    // own harm class one verb over.
    expect(isCompletedActionClause('push the hotfix to origin once CI is green')).toBe(false);
    expect(isCompletedActionClause('push the fix when the suite is green')).toBe(false);
    // …while the PAST form still mines (the 5c7727c4 true positive).
    expect(isCompletedActionClause('pushed the hotfix and confirmed prod green')).toBe(true);
  });

  it('REVIEW F2: the house "Label: verb phrase" form still mines (no clause population lost)', () => {
    // stripContinuationLine deletes every rejected clause from the audited
    // window, so an over-broad denylist is a LAUNDERING channel, not just a
    // recall trim: these were all true pre-fix and each CONVICTS when mined.
    expect(isCompletedActionClause('Update: closed the ticket 8aa5688f')).toBe(true);
    expect(isCompletedActionClause('Note: archived the lane')).toBe(true);
    expect(isCompletedActionClause('Status: verified prod green')).toBe(true);
    // …but an ACTION-verb label keeps the conservative direction: "Steer:" is
    // the incident's own shape with a colon and must NOT re-admit.
    expect(isCompletedActionClause('Steer: restored lane f7e14cf8')).toBe(false);
    expect(isCompletedActionClause('Verify: confirmed prod green')).toBe(false);
  });

  it('REVIEW F7: the two verb lists have not drifted apart', () => {
    // COMPLETED_ACTION_ITEMS_RE and COMPLETED_ACTION_HEAD_RE are the same
    // vocabulary; the repo's vocabulary-parity doctrine names exactly this
    // duplication as a repeat defect. Probe a representative verb from each
    // family and require the head list to agree with the unanchored list.
    const probes = [
      'pushed the hotfix', 'shipped v2', 'deployed the build', 'merged the PR',
      'landed the wave', 'filed the ticket', 'flagged the lane', 'sent the note',
      'messaged the owner', 'archived the lane', 'created the row',
      'chartered the lane', 'spawned a worker', 'dispatched the probe lane',
      'launched the run', 'started the sweep', 'restored the lane',
      'updated the doc', 'closed the ticket', 'verified prod', 'confirmed green',
      'checked the box', 'posted the result', 'published the doc',
      'wrote the file', 'wired the hook', 'fixed the bug',
    ];
    const headMisses = probes.filter((p) => !isCompletedActionClause(p));
    expect(headMisses).toEqual([]); // a head miss must fall through to the old test
    for (const p of probes) expect(isCompletedActionItems(p)).toBe(true);
  });
});
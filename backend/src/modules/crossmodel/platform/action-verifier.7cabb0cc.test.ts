/**
 * REPLAY PIN — ticket 7cabb0cc-7382-4ae9-a9fb-46c4df58196f (mishap, 2026-10-08):
 * "Phantom action claim: chat asserted action(s) never executed".
 *
 * PRIVACY (audit 2026-10-08 W5-1c): the incident chat belongs to another
 * account, so this pin carries NO text and NO id from that chat — the claim
 * lines, the note and the chat id below are SYNTHETIC equivalents with the
 * exact incident SHAPE (a council-dispatch status line + a run-self-
 * incompletion line on a Dig-deeper research rung). Replay fixtures from a
 * non-owner chat are always synthetic.
 *
 * The mishap: a Dig-deeper research rung (the L3 deep-research council, run
 * INLINE on the escalation stream) honestly reported its run status — it had
 * dispatched both council colleagues, both ran past the dispatch ceiling and
 * came back empty, and the run ran out of turn before its own live
 * verification. The dispatch REALLY happened — chat-agent.service.ts's
 * dispatch_colleagues executor incremented dispatchRounds, both colleagues hit
 * the 12-minute COUNCIL_DISPATCH_CEILING_MS (council-dispatch.ts) and came back
 * with nothing usable, and the note explicitly told the user nothing was
 * freshly source-checked. But the council is a PIPELINE lane, the exact L3
 * shape the 899554af cross-check tier's comment deferred ("the L3 lane is a
 * separate shape — crossCheckMerged stays false there, so council notes keep
 * today's audit either way"): dispatch_colleagues is an inline chat-agent tool
 * (NOT start_coding_session / dispatch_platform_task), the colleague runs mint
 * no run-receipt and leave no tracked part — so the executed pool was EMPTY,
 * the LLM extraction labelled both honest lines [dispatch], and the verifier
 * convicted them with "Executed consequential actions this run: NONE" — the
 * verifier's own line was the only false statement in the thread. The deduped
 * mishap ticket (this one) was filed on a fully honest note.
 *
 * The fix (two seams, mirroring the established pipeline lanes):
 *   1. computePhantomClaims — a COUNCIL DISPATCH exoneration tier, the L3 twin
 *      of the 899554af cross-check tier: vocabulary-anchored
 *      (isCouncilDispatchNarration), kind-agnostic, ID-LESS only, and anchored
 *      on `councilDispatched` — TRUE only when chat-agent passes
 *      dispatchRounds > 0 (a genuine dispatch round this turn). A run that
 *      never dispatched keeps full conviction power.
 *   2. findPhantomClaims — the RUN-SELF-INCOMPLETION idiom
 *      ("I ran out of turn before completing …"): an id-less claim reporting
 *      the run's own budget exhaustion is a failure report, not a completed-
 *      action claim (same doctrine as the FAILURE-REPORT tier, whose subject
 *      is the run itself — no tool family can vouch it, none is needed).
 *
 * Mock discipline mirrors action-verifier.61b9200a.test.ts: config/database
 * and every transitively-heavy boundary is mocked at the top, above imports.
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

import {
  verifyRunActionClaimsAsync, computePhantomClaims, findPhantomClaims, ExtractedClaim,
  isCouncilDispatchNarration, isRunSelfIncompletionDetail,
} from './action-verifier';
import { ExecutedAction } from './executed-actions';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));
// A SYNTHETIC chat id (W5-1c: never an id from another account's chat).
const CHAT = '0c0ffee0-5a5a-4b4b-8c8c-000000007cab';

// The ticket's two phantom-claim details — SYNTHETIC text in the exact
// incident shape (W5-1c): the extractor quoted each line as it labelled it
// [dispatch].
const COUNCIL_CLAIM_DETAIL = 'I dispatched both council colleagues (one on the historical-dating claims, one on current battery-chemistry research), but both ran past the dispatch ceiling and their reports came back empty';
const RAN_OUT_DETAIL = 'I also ran out of turn before completing my own live verification';

// A synthetic note in the incident note's shape.
const INCIDENT_NOTE = `## Deeper findings — verifying my earlier answer

**Run status, stated honestly:** ${COUNCIL_CLAIM_DETAIL} — stopped, with nothing usable in either late report. ${RAN_OUT_DETAIL}. So the fresh live-web citations I promised are **not in hand this run**. Nothing below should be treated as freshly source-checked.`;

// The run's REAL artifacts as the incident produced them: the council round
// left NO tracked tool part and NO receipt (dispatch_colleagues is an inline
// pipeline tool; colleague runs are not sessions) — the pool was empty, which
// is exactly why the honest narration convicted.
const INCIDENT_PARTS = [] as any[];
const NO_RECEIPTS: ToolReceipt[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('ticket 7cabb0cc replay — an honest L3 council-dispatch status note is NO LONGER a phantom', () => {
  it('REPLAYS the mishap: both [dispatch] claims + councilDispatched anchor audit CLEAN — no ticket, no retraction', async () => {
    // The extraction pass labels BOTH honest lines [dispatch] claims, exactly
    // as it did in the incident (the details quote the note verbatim).
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [
        { kind: 'dispatch', detail: COUNCIL_CLAIM_DETAIL },
        { kind: 'dispatch', detail: RAN_OUT_DETAIL },
      ],
    }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: INCIDENT_PARTS, receipts: NO_RECEIPTS,
      machineTriggered: false,
      // chat-agent passes dispatchRounds > 0 — the round genuinely ran.
      councilDispatched: true,
    });
    expect(comp.phantoms).toEqual([]); // THE FIX: both honest claims exonerated
    expect(comp.councilDispatchExonerated).toBe(1); // the council line (tier 1)
    expect(comp.executed).toEqual([]); // the pool really was empty — the tier, not the pool, is what acquits

    // End-to-end through the user-facing lane: nothing files, nothing retracts.
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: INCIDENT_PARTS, receipts: NO_RECEIPTS, machineTriggered: false, councilDispatched: true });
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('RUN-SELF-INCOMPLETION tier is anchor-free: "ran out of turn" exonerates even without the council flag (any run)', async () => {
    // The claim's subject is the run itself — no pipeline anchor is needed and
    // none is checked (the incident's second conviction was exactly this line
    // on a run whose council anchor the extractor had nothing to do with).
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: RAN_OUT_DETAIL }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: `Status: ${RAN_OUT_DETAIL}. Delivering what I have.`,
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
      councilDispatched: false, // never dispatched anything
    });
    expect(comp.phantoms).toEqual([]);
    expect(comp.councilDispatchExonerated).toBe(0); // acquitted by the incompletion tier, not the council tier
  });

  it('LAUNDERING GUARD — a council-shaped claim citing an id keeps conviction (the council mints no citable ids)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'I dispatched both council colleagues', id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'I dispatched both council colleagues (session a1b2c3d4).',
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
      councilDispatched: true,
    });
    expect(comp.phantoms.length).toBe(1);
    expect(String(comp.phantoms[0].id)).toBe('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
  });

  it('ANCHOR GUARD — a council-shaped claim on a run that NEVER dispatched still convicts (flag false ⇒ byte-identical pre-fix behavior)', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: COUNCIL_CLAIM_DETAIL }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE,
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
      // councilDispatched unset — an L1/machine run that never dispatched.
    });
    expect(comp.phantoms.length).toBe(1); // still convicted
    expect(comp.councilDispatchExonerated).toBe(0);
  });

  it('NO-LAUNDERING of platform dispatch: "I dispatched two workers" (no council vocabulary) keeps conviction even with the anchor on', async () => {
    // A real phantom platform-dispatch claim must never ride the council tier:
    // the vocabulary is the discriminator, the anchor only gates it.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'I dispatched two workers to investigate the spike' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'I dispatched two workers to investigate the spike.',
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
      councilDispatched: true,
    });
    expect(comp.phantoms.length).toBe(1);
  });

  it('findPhantomClaims unit: the incompletion tier honors the shared kill switch', async () => {
    const claim: ExtractedClaim = { kind: 'dispatch', detail: RAN_OUT_DETAIL };
    const claimsWithEnv = async (env: string | undefined): Promise<ExtractedClaim[]> => {
      const prev = process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED;
      if (env === undefined) delete process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED;
      else process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED = env;
      try { return await findPhantomClaims([claim], [] as ExecutedAction[], undefined, [], undefined); }
      finally {
        if (prev === undefined) delete process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED;
        else process.env.ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED = prev;
      }
    };
    expect(await claimsWithEnv(undefined)).toEqual([]);       // exempt on — acquitted
    expect((await claimsWithEnv('1')).length).toBe(1);        // kill switch — convicted
  });

  // ── Adversarial-review F1 pins (reviewer finding 1, MAJOR): the idiom must
  // never acquit a claim that ALSO asserts a completed action. Three probed
  // laundering shapes; each must still CONVICT when nothing executed.
  it('F1 GUARD: a completed-action claim decorated with an exhaustion excuse still convicts (no execution on record)', async () => {
    // Shape A — kind idiom (filed→ticket): "…and ran out of time" is the excuse.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'I filed the ticket and ran out of time before recording its id' }],
    }) as never);
    let comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'I filed the ticket and ran out of time before recording its id.',
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);

    // Shape B — kind idiom (dispatched→lane).
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'message', detail: 'I dispatched the report to the owner lane but ran out of turn to verify it' }],
    }) as never);
    comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'I dispatched the report to the owner lane but ran out of turn to verify it.',
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);

    // Shape C — TASK idiom (the 61b9200a steps:0 shape plus the excuse): no
    // kind verb→noun pair, so only the task-idiom guard holds the line.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'I ran a computer task to find the PDF but ran out of time to verify it' }],
    }) as never);
    comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'I ran a computer task to find the PDF but ran out of time to verify it.',
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
    });
    expect(comp.phantoms).toHaveLength(1);

    // And the honest pure-incompletion shape (the incident line) still acquits.
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: RAN_OUT_DETAIL }],
    }) as never);
    comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: `Status: ${RAN_OUT_DETAIL}. Delivering what I have.`,
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
    });
    expect(comp.phantoms).toEqual([]);
  });

  it('vocabulary detectors: the incident details match; adjacent honesty lines do not over-match', () => {
    expect(isCouncilDispatchNarration({ kind: 'dispatch', detail: COUNCIL_CLAIM_DETAIL })).toBe(true);
    expect(isCouncilDispatchNarration({ kind: 'dispatch', detail: 'Dispatched colleagues to check the translations', id: '' })).toBe(true);
    expect(isCouncilDispatchNarration({ kind: 'dispatch', detail: 'I launched both colleagues on the dating claims', id: '' })).toBe(true);
    // Platform-dispatch vocabulary stays outside the tier.
    expect(isCouncilDispatchNarration({ kind: 'dispatch', detail: 'I dispatched two workers to investigate the spike' })).toBe(false);
    // (F2) a bare council/colleague MENTION rides no dispatch verb — outside.
    expect(isCouncilDispatchNarration({ kind: 'schedule', detail: 'I scheduled the council review for 6pm', id: '' })).toBe(false);
    expect(isCouncilDispatchNarration({ kind: 'dispatch', detail: 'I dispatched a coding session for the colleague-requested refactor', id: '' })).toBe(false);
    // An id-bearing claim never enters the tier (laundering guard) — hex ids
    // (the citation lanes) and NON-hex ids alike (F3: "PR-1338" fails idish
    // and would otherwise ride the id-less tier).
    expect(isCouncilDispatchNarration({ kind: 'dispatch', detail: COUNCIL_CLAIM_DETAIL, id: 'a1b2c3d4' })).toBe(false);
    expect(isCouncilDispatchNarration({ kind: 'dispatch', detail: 'I dispatched both council colleagues (PR 1338 landed)', id: 'PR-1338' })).toBe(false);

    expect(isRunSelfIncompletionDetail(RAN_OUT_DETAIL)).toBe(true);
    expect(isRunSelfIncompletionDetail('I ran out of time before finishing the sweep')).toBe(true);
    expect(isRunSelfIncompletionDetail('I dispatched the council and merged its report')).toBe(false);
  });

  // ── Adversarial-review F2 pin (reviewer finding 2, MAJOR): a bare council
  // noun on a platform action must NOT ride the tier, anchor or no anchor.
  it('F2 GUARD: "I scheduled the council review for 6pm" (a phantom schedule) still convicts with the anchor ON', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'schedule', detail: 'I scheduled the council review for 6pm' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1',
      finalText: 'Update on the deep-research plan: I scheduled the council review for 6pm tonight.',
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
      councilDispatched: true,
    });
    expect(comp.phantoms).toHaveLength(1);
  });

  // ── Adversarial-review F3 pin (reviewer finding 3, MINOR): a NON-hex id
  // (idish-false) must not ride the id-less council tier either.
  it('F3 GUARD: a council-shaped claim citing a non-hex id ("PR-1338") still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'I dispatched both council colleagues (PR 1338 landed)', id: 'PR-1338' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'I dispatched both council colleagues (PR 1338 landed).',
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
      councilDispatched: true,
    });
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('PR-1338');
  });

  // ── Adversarial-review F4 pin (reviewer finding 4, MINOR): the compound
  // shape — the suite's own pinned platform conviction plus the exhaustion
  // excuse — must stay a conviction (the dispatch idiom holds the line).
  it('F4 GUARD: "I dispatched two workers … but ran out of time before they reported back" still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'I dispatched two workers to investigate the spike but ran out of time before they reported back' }],
    }) as never);
    const comp = await computePhantomClaims({
      chatId: CHAT, userId: 'u-1', finalText: 'I dispatched two workers to investigate the spike but ran out of time before they reported back.',
      parts: [], receipts: NO_RECEIPTS, machineTriggered: false,
      councilDispatched: true,
    });
    expect(comp.phantoms).toHaveLength(1);
  });
});

/**
 * REPLAY PIN — ticket bbd8521e-39f7-4bbe-9a78-38046cc9ed9a (bug_report,
 * agent-filed 2026-10-13 by this R&D shortfall-hunt cycle): "action-verifier:
 * LLM extraction mines third-party lane-status narration as this-run action
 * claims (machine_wake_reject_back false positives)".
 *
 * THE INCIDENT (all evidence first-hand in the filing run, 2026-10-13):
 * the crossmodel project supervisor (chat daee2916) was struck 5x in one
 * morning on seam machine_wake_reject_back, each phantoms:1, outcome
 * observed, over notes whose only "action" lines narrate OTHER lanes'
 * status over REAL artifacts:
 *
 *   1. Strike 09:09:54.731Z (kinds dispatch, ids 41fd09ed) — msg bbd82814:
 *      "**2475ab13 duplicate resolved:** the **dispatched lane 41fd09ed** is
 *      well ahead — read the verdict as it landed and pushed fix commits for
 *      all three findings plus the aggravations". Lane 41fd09ed is a REAL
 *      chat (its id appears verbatim in the supervisor's own
 *      send_chat_message receipts 01bfbbab / 1a3c4ba4); the dispatch
 *      happened on an earlier wake via the ticket machinery. FALSE POSITIVE.
 *
 *   2. Strike 10:39:25.609Z (kinds message, ids 07d94e8f) — msg c96ba803:
 *      "The deliverables Result (msg 07d94e8f, PR #1464) posted on the lane
 *      is acknowledged — not re-staged". 07d94e8f is the ticket lane
 *      cf385e0c's REAL deliverables message id, and "acknowledge that
 *      message; do not re-post" is the HARNESS'S OWN instruction in the
 *      deliverables preamble — the platform instructs an idiom its own
 *      verifier then strikes. FALSE POSITIVE (worst shape).
 *
 *   3. Strikes 06:54:00Z / 10:57:24Z / 11:27:28Z (kinds message, ids
 *      24541fb3) — backstop cadence reports ("24541fb3 firing 10/24 (msg
 *      8ea56b9e, 14:45Z): fix live, deploy green…"). 24541fb3 is a REAL
 *      in_progress ticket (verified live via get_feedback in the filing
 *      run). FALSE POSITIVE.
 *
 * THE ROOT CAUSE (the conviction path this replay pins END-TO-END): the LLM
 * extractor emits a this-run ACTION claim for third-party narration (its
 * prompt says to IGNORE such reports, but nothing enforces it — verbatim
 * grounding passes, the id-shape gate passes). The action claim CARRIES the
 * id, so every deterministic citation lane then SKIPS it ("ids already
 * carried by an action claim — the tier chain judged them") — skipping the
 * very row-existence exoneration that would have acquitted it. The action
 * lane's own tier chain correctly finds no own-run execution (message-kind
 * has no artifact exoneration by design; dispatch-kind requires
 * createdAt ≤1h; the ticket-machinery dispatch lives in no state-doc
 * ledger) and convicts an honest note over real artifacts other lanes own.
 * This is the residual class behind the 2026-09-11 observe-only flip
 * ("all 9 'phantom' message ids it struck … were REAL lane messages the
 * supervisor had read"), still firing 5×/day on one supervisor.
 *
 * THE FIX: a deterministic THIRD-PARTY-ATTRIBUTION drop register
 * (dropThirdPartyAttributionClaims) wired after gateLlmClaimShapes on BOTH
 * LLM surfaces (note + args) — four frames (attributive participle,
 * agent-location, status copula, firing-status) with a FIRST-PERSON actor
 * guard. Dropped claims no longer carry their ids, so the deterministic
 * citation lanes re-evaluate them and exonerate on row existence — the
 * honest note keeps its audit trail, the strike disappears.
 *
 * Mock discipline mirrors action-verifier.c5629165.test.ts / 363f5793.test.ts.
 */
const CHAT = 'daee2916-fa75-4159-94a1-3d767abfd192'; // the crossmodel project supervisor
const REAL_LANE = '41fd09ed-9972-47d8-af80-13c79d44a9ea';
const REAL_MSG = '07d94e8f-3976-4106-8191-2d5483aa90b4';
const REAL_BACKSTOP_MSG = '8ea56b9e-1111-4222-8333-444455556666';

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
  computePhantomClaims, isThirdPartyAttributionDetail, dropThirdPartyAttributionClaims,
  ExtractedClaim,
} from './action-verifier';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));

// The supervisor's read-only receipts (verbatim shape from the run's receipt
// pull): get_chat_status reads — ZERO dispatch/message executions this run.
const READ_RECEIPTS: ToolReceipt[] = ['20651052', '0589df7f', '31406c5d'].map((id) => ({
  id: `${id}-0000-4000-8000-000000000000`, chatId: CHAT, runId: null,
  tool: 'get_chat_status', ok: true, ids: { receiptId: `${id}-0000-4000-8000-000000000000` },
  inputHash: null, outputHash: null, createdAt: new Date(),
}));

// NOTE 1 (verbatim shape of msg bbd82814's dispatched-lane line) — the STRUCK
// line of incident 1.
const INCIDENT1_NOTE = `**crossmodel 09:08Z — PR #1462 is merged with all three review findings fixed, and the 2475ab13 duplicate race is closed before it could produce a second PR.**

**2475ab13 duplicate resolved:** the **dispatched lane 41fd09ed** is well ahead — read the verdict as it landed and pushed fix commits for all three findings plus the aggravations, CI went 6/6 green.

Board: 2 active goals, 3 open todos, 0 blocked.`;

// NOTE 2 (verbatim shape of msg c96ba803's deliverables-acknowledgment line)
// — the STRUCK line of incident 2 (the harness's own instructed idiom).
const INCIDENT2_NOTE = `**crossmodel 10:38Z — ticket c5629165 lane closed clean end-to-end; lane and reviewer retired, context folded. Nothing needs the owner.**

The deliverables Result (msg 07d94e8f, PR #1464) posted on the lane is acknowledged — not re-staged.

Board: 2 active goals, 3 open todos, 0 blocked.`;

// NOTE 3 (verbatim shape of the 24541fb3 backstop-cadence line) — incidents 3.
const INCIDENT3_NOTE = `**crossmodel 15:09Z — 2475ab13 closed done and terminal.**

- 24541fb3 firing 10/24 (msg 8ea56b9e, 14:45Z): fix live, deploy green, probe still shows the pre-fix token — only the owner's one-time Slack reconnect remains.

Board: 2 active goals, 3 open todos, 0 blocked.`;

/**
 * Serve the PRODUCTION-TRUTHFUL environment for the struck notes: the lanes,
 * messages and tickets the supervisor narrated are REAL rows (created hours
 * or days earlier — NOT ≤1h fresh). With these served, every DETERMINISTIC
 * citation lane exonerates on row existence — the only conviction source is
 * the LLM action lane carrying the id (which makes the citation lanes SKIP
 * their own exoneration), exactly the production strike path.
 */
const serveRealRows = () => {
  // Lane 41fd09ed — real chat, created 2026-10-12 (hours before the strike;
  // the ticket-machinery dispatch, in no supervisor state-doc ledger).
  mockPrisma.crossModelChat.findFirst.mockImplementation(async (args: any) =>
    JSON.stringify(args).includes('41fd09ed') ? { id: REAL_LANE, createdAt: new Date('2026-10-12T20:30:00Z') } : null);
  // msg 07d94e8f — real crossModelMessage row (the lane's deliverables Result).
  mockPrisma.crossModelMessage.findFirst.mockImplementation(async (args: any) => {
    const s = JSON.stringify(args);
    if (s.includes('07d94e8f')) return { id: REAL_MSG, createdAt: new Date('2026-10-13T07:00:00Z') };
    if (s.includes('8ea56b9e')) return { id: REAL_BACKSTOP_MSG, createdAt: new Date('2026-10-13T14:45:00Z') };
    return null;
  });
  // ticket 24541fb3 — real in_progress user_feature_requests row (days old);
  // ticket c5629165 — real DONE row (closed 2026-10-13T10:00:39Z, hours before
  // the strike; the ticket-citation lane exonerates on existence).
  mockPrisma.userFeatureRequest.findFirst.mockImplementation(async (args: any) => {
    const s = JSON.stringify(args);
    if (s.includes('24541fb3')) return { id: '24541fb3-2565-49ed-ab1d-cc5dba1af3ed', updatedAt: new Date('2026-10-13T14:45:00Z') };
    if (s.includes('c5629165')) return { id: 'c5629165-8053-4e30-b5b1-3229aca0b1a4', updatedAt: new Date('2026-10-13T10:00:39Z') };
    return null;
  });
};

const BASE_INPUT = (note: string) => ({
  chatId: CHAT, userId: 'u-1', finalText: note, parts: [] as any[],
  receipts: READ_RECEIPTS, runStartedAt: new Date(), machineTriggered: true,
});

// The claims the LLM extractor emits for the struck lines (the strikes' meta
// kinds/ids name them): a [dispatch] claim citing the real lane id, a
// [message] claim citing the real deliverables msg id, a [message] claim
// citing the real ticket id.
const EXTRACTOR_DISPATCH_CLAIM: ExtractedClaim = {
  kind: 'dispatch',
  detail: 'the **dispatched lane 41fd09ed** is well ahead — read the verdict as it landed and pushed fix commits for all three findings plus the aggravations',
  id: '41fd09ed',
};
const EXTRACTOR_ACK_CLAIM: ExtractedClaim = {
  kind: 'message',
  detail: 'The deliverables Result (msg 07d94e8f, PR #1464) posted on the lane is acknowledged — not re-staged',
  id: '07d94e8f',
};
const EXTRACTOR_FIRING_CLAIM: ExtractedClaim = {
  kind: 'message',
  detail: '24541fb3 firing 10/24 (msg 8ea56b9e, 14:45Z): fix live, deploy green, probe still shows the pre-fix token',
  id: '24541fb3',
};

describe('ticket bbd8521e replay — third-party lane-status narration is not a this-run action claim', () => {
  beforeEach(() => { serveRealRows(); });
  afterEach(() => { delete process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED; });

  it('THE REGISTER (unit): the three adjudicated false-positive details match; first-person and genuine-action shapes do not', () => {
    expect(isThirdPartyAttributionDetail(EXTRACTOR_DISPATCH_CLAIM.detail)).toBe(true);  // frame (a)
    expect(isThirdPartyAttributionDetail(EXTRACTOR_ACK_CLAIM.detail)).toBe(true);      // frame (b)
    expect(isThirdPartyAttributionDetail(EXTRACTOR_FIRING_CLAIM.detail)).toBe(true);   // frame (d)
    // First-person actor: never dropped — the tier chain judges it.
    expect(isThirdPartyAttributionDetail('I dispatched lane 41fd09ed to own the follow-up')).toBe(false);
    expect(isThirdPartyAttributionDetail("I've posted the deliverables Result on the lane already")).toBe(false);
    // Genuine action idiom, third-person-free: not third-party narration.
    expect(isThirdPartyAttributionDetail('steered it with the single task: push the branch, report the PR number — receipt 01bfbbab')).toBe(false);
    // Status copula over a real lane id: frame (c).
    expect(isThirdPartyAttributionDetail('lane 41fd09ed is well ahead')).toBe(true);
    expect(isThirdPartyAttributionDetail('the lane 41fd09ed owns the cycle')).toBe(true);
    // Agent-location past/folded variants.
    expect(isThirdPartyAttributionDetail('its context is folded into the lane')).toBe(true);
  });

  it('THE REGISTER (unit): dropThirdPartyAttributionClaims splits kept/dropped exactly', () => {
    const honestThirdParty = EXTRACTOR_DISPATCH_CLAIM;
    const genuine = { kind: 'message' as const, detail: 'I sent the delta to the Fleet Supervisor — receipt 7ee7540a', id: '7ee7540a' };
    const out = dropThirdPartyAttributionClaims([honestThirdParty, genuine]);
    expect(out.dropped).toEqual([honestThirdParty]);
    expect(out.kept).toEqual([genuine]);
  });

  it('THE REGISTER (unit): kill switch ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED=1 keeps everything', () => {
    process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED = '1';
    const out = dropThirdPartyAttributionClaims([EXTRACTOR_DISPATCH_CLAIM]);
    expect(out.kept).toEqual([EXTRACTOR_DISPATCH_CLAIM]);
    expect(out.dropped).toEqual([]);
  });

  it('THE MISHAP REPLAY 1 (strike 09:09:54Z, dispatch/41fd09ed): the extractor-emitted dispatched-lane claim is DROPPED — phantoms empty', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DISPATCH_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT1_NOTE));
    await flush();
    expect(comp.phantoms).toEqual([]);
  });

  it('THE MISHAP REPLAY 2 (strike 10:39:25Z, message/07d94e8f): the harness-instructed deliverables-acknowledgment idiom is DROPPED — phantoms empty', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_ACK_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT2_NOTE));
    await flush();
    expect(comp.phantoms).toEqual([]);
  });

  it('THE MISHAP REPLAY 3 (strikes 06:54/10:57/11:27Z, message/24541fb3): the backstop firing-cadence report is DROPPED — phantoms empty', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_FIRING_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT3_NOTE));
    await flush();
    expect(comp.phantoms).toEqual([]);
  });

  it('GUARD (no false acquit): a GENUINE phantom first-person dispatch with an invented id still convicts through the full chain', async () => {
    // The phantom sentence is IN the note verbatim (grounding passes), the
    // id is invented (no row, no envelope, no haystack) — the full chain
    // must still convict it. This is the false-acquit guard.
    const noteWithPhantom = INCIDENT1_NOTE + '\n\nI dispatched lane deadbeef to own the follow-up and it is running now.';
    const phantom: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'I dispatched lane deadbeef to own the follow-up and it is running now',
      id: 'deadbeef',
    };
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [phantom] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(noteWithPhantom));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('deadbeef');
  });

  it('GUARD (kill switch restores the pre-fix strike — the exact regression this ticket pins)', async () => {
    process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED = '1';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DISPATCH_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT1_NOTE));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('41fd09ed');
  });

  it('WIRING (args surface): a third-party claim mined from tool-call ARGS is dropped too', async () => {
    // send_chat_message args carrying third-party lane narration (the steer
    // to 41fd09ed — its JSON-serialized args).
    const parts: any[] = [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: REAL_LANE, content: 'the dispatched lane 41fd09ed is well ahead; push the branch and report the PR number' } },
      { type: 'tool_result', result: '{"ok":true,"receiptId":"01bfbbab-fe6a-4111-a48e-42515f60de5f"}' },
    ];
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never)                                                                                         // note surface: no claims
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'the dispatched lane 41fd09ed is well ahead; push the branch and report the PR number', id: '41fd09ed' }] }) as never); // args surface: the third-party claim
    const comp = await computePhantomClaims({ ...BASE_INPUT(INCIDENT1_NOTE), parts });
    await flush();
    expect(comp.phantoms).toEqual([]);
  });
});

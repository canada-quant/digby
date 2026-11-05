/**
 * REPLAY PIN — ticket 899554af-ca24-470d-97f0-9b6bb3e853fa (mishap, filed
 * 2026-09-19T00:52:45Z): "Phantom action claim: chat asserted action(s) never
 * executed (chat bb8b8c99)".
 *
 * The mishap was a FALSE POSITIVE. Chat bb8b8c99-2655-4076-a56e-576c1ad42a38's
 * 'thinking'-mode (L2) run finalized at 2026-09-19T00:52:44.647Z — the
 * chat_search_usage loop_metrics row for that run (queried via fleet telemetry
 * 2026-09-19T01:25Z) stamps `{"mode":"thinking","model":"glm-5.3",…}`, i.e.
 * the L2 Double Checker lane (role 'cross_checker', chat-agent.service.ts)
 * REALLY ran beside the lead. The synthesis's answer opened:
 *
 *   "I read the paper (…), passed a full digest of it plus a digest of our
 *    harness architecture to a crossmodel agent (helper-model `cross_checker`),
 *    and merged its independent gap list with my own read."
 *
 * — a TRUE narration of the pipeline reconcile (the checker's draft was
 * injected into the orchestrator's context under [CROSS-CHECK DRAFTS]). But a
 * pipeline peer is not a consequential tool: it mints no run-receipt and
 * leaves no part, so the action verifier's executed pool was EMPTY ("Executed
 * consequential actions this run: NONE") and the [dispatch]-classified
 * narration convicted — mishap ticket + in-thread correction on a claim that
 * was the only TRUE action sentence in the answer. (Same family as d25172ca's
 * notify_user blindness: a real execution path the pool could not see.)
 *
 * Root cause, deterministic: the verifier had no knowledge that the run's own
 * answer pipeline executed cross-check lanes.
 *
 * The fix: chat-agent passes `crossCheckDelivered: crossCheckMerged` (TRUE
 * only when the checker's draft was genuinely MERGED into the answer — a
 * non-empty injected draft block, or a successful late-reconcile; reviewer
 * F1/N1 2026-09-19: never the injector latch `draftsDelivered`, which flips
 * before the gate check, so a gate-timeout / empty-draft / late-armed lead
 * that answered alone keeps full conviction power) into BOTH audit lanes
 * (pre-delivery guard ×2, post-delivery verifier ×2), and computePhantomClaims runs a vocabulary-anchored,
 * kind-agnostic exoneration tier (isCrossCheckPipelineNarration): ONLY claims
 * naming the cross-check pipeline are acquitted — a co-riding "dispatched a
 * coding session X" convicts with the flag on, and a fabricated "cross_checker
 * receipt msg xyz" still dies in the citation lanes. Runs WITHOUT the flag
 * (L1, machine wakes — which skip the checker — coding lanes, every pre-
 * 2026-09-19 caller) see byte-identical behavior.
 *
 * Mock discipline mirrors action-verifier.d25172ca.test.ts: config/database
 * and every transitively-heavy boundary is mocked at the top, above imports.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import { verifyRunActionClaimsAsync, computePhantomClaims, isCrossCheckPipelineNarration, USER_FACING_CORRECTION_BANNER } from './action-verifier';

// 2026-10-04 (owner): the post-delivery lane is OBSERVE-ONLY on human chats by default — no user-visible
// correction row. These pins assert the posted retraction, i.e. the ACTION_VERIFIER_ENFORCE=1 path.
const __prevEnforce = process.env.ACTION_VERIFIER_ENFORCE;
beforeAll(() => { process.env.ACTION_VERIFIER_ENFORCE = '1'; });
afterAll(() => { if (__prevEnforce === undefined) delete process.env.ACTION_VERIFIER_ENFORCE; else process.env.ACTION_VERIFIER_ENFORCE = __prevEnforce; });


const flush = () => new Promise((r) => setImmediate(r));
// The mishap's real chat id — the filed ticket title must read true against it.
const CHAT = 'bb8b8c99-2655-4076-a56e-576c1ad42a38';

// Verbatim claim sentence from the incident answer (as quoted in the filed
// ticket's note excerpt — the extractor's claim detail must be verbatim to
// survive the 587e9d64 grounding lane).
const CLAIM_DETAIL = 'passed a full digest of it plus a digest of our harness architecture to a crossmodel agent (helper-model `cross_checker`), and merged its independent gap list with my own read';
const MISHAP_NOTE = `# SoL-Pi vs. the Digby harness — gap analysis

I read the paper ([solpi harness.pdf](/api/crossmodel/files/2bc34cae-c1e7-47b7-ba09-8daf7ef83689/download)), ${CLAIM_DETAIL}. Findings below; run-status caveats at the end.

## The gaps, ranked

**1. No fused mutation+command primitive — HIGH.** SoL-Pi's Action Fusion merges a file edit and its follow-up run/test into one tool request returning both outcomes; our coding sessions run edit → test strictly sequentially.

**2. No evidence-reduction pipeline for large outputs.**`;

const extractIncidentClaim = () =>
  JSON.stringify({ claims: [{ kind: 'dispatch', detail: CLAIM_DETAIL, id: 'cross_checker' }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('ticket 899554af replay — TRUE L2 cross-check narration must never be struck phantom', () => {
  it('REPLAYS the mishap inputs: incident note + crossCheckDelivered:true → NO ticket, NO correction (pre-fix: both fired)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractIncidentClaim() as never);
    // The incident run's shape: user-facing lane (machineTriggered:false),
    // truthy-empty receipts array (chat-agent's `receipts ?? []`), no parts —
    // PLUS the new anchor: the L2 drafts were ACTUALLY injected this turn
    // (chat-agent's draftsDelivered).
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: [], receipts: [], machineTriggered: false, crossCheckDelivered: true });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    // THE FIX: the claim was TRUE — the verifier stays silent. Pre-fix this
    // pair fired: the deduped mishap ticket + the in-thread correction.
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('compute-level: the incident claim is extracted, then exonerated and counted — extraction itself is unchanged', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractIncidentClaim() as never);
    const out = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: [], receipts: [], machineTriggered: false, crossCheckDelivered: true });

    expect(out.claims).toHaveLength(1); // the extraction still SAW the claim
    expect(out.phantoms).toEqual([]); // …and the new tier acquitted it
    expect(out.pipelineCrossCheckExonerated).toBe(1);
    expect(out.crossWakeExonerated).toBe(0);
  });

  it('phantom direction preserved: the SAME note WITHOUT the flag files the ticket + posts the correction (the incident behavior, kept for L1 / gate-timeout runs)', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractIncidentClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: [], receipts: [], machineTriggered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe('Phantom action claim: chat asserted action(s) never executed (chat bb8b8c99)');
    expect(ticket.area).toBe('fleet-integrity');
    expect(ticket.description).toContain('[dispatch]');
    expect(ticket.description).toContain(CLAIM_DETAIL);
    expect(ticket.description).toContain('cross_checker');

    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const correction = mockPrisma.crossModelMessage.create.mock.calls[0][0] as any;
    expect(correction.data.role).toBe('assistant');
    expect(correction.data.content).toContain(USER_FACING_CORRECTION_BANNER);
    expect(correction.data.content).toContain(CLAIM_DETAIL);
  });

  it('phantom direction preserved: crossCheckDelivered:false EXPLICIT (a gate-timeout lead that answered alone) still convicts', async () => {
    mockUtilityChat.mockResolvedValueOnce(extractIncidentClaim() as never);
    verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: MISHAP_NOTE, parts: [], receipts: [], machineTriggered: false, crossCheckDelivered: false });
    await flush(); await flush(); await flush(); await flush(); await flush(); await flush();

    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });

  it('NARROWNESS: a co-riding NON-cross-check dispatch claim still convicts with the flag on — only the pipeline narration is acquitted', async () => {
    const sessionClaim = 'dispatched a coding session 1ca12570-0921-4a94-a857-f0b9b75f8933 to implement gap #1';
    const note = `${MISHAP_NOTE}\n\nFollow-ups: I also ${sessionClaim}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [
        { kind: 'dispatch', detail: CLAIM_DETAIL, id: 'cross_checker' },
        { kind: 'dispatch', detail: sessionClaim, id: '1ca12570-0921-4a94-a857-f0b9b75f8933' },
      ],
    }) as never);
    const out = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [], machineTriggered: false, crossCheckDelivered: true });

    expect(out.pipelineCrossCheckExonerated).toBe(1); // the cross-check claim acquitted…
    expect(out.phantoms).toHaveLength(1); // …the invented session dispatch convicts
    expect(String(out.phantoms[0].id)).toContain('1ca12570');
    expect(out.phantoms[0].detail).toContain('coding session');
  });

  it('kind-agnostic: a MESSAGE-kind cross-check claim is exonerated too (the extractor coin-flip safety the vocabulary anchor provides)', async () => {
    const msgDetail = 'sent the digest to the cross_checker and folded its independent answer into the summary';
    const note = `Cross-check complete: I ${msgDetail} above. Reconciled both reads before answering.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'message', detail: msgDetail, id: 'cross_checker' }] }) as never);
    const out = await computePhantomClaims({ chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [], machineTriggered: false, crossCheckDelivered: true });

    expect(out.phantoms).toEqual([]);
    expect(out.pipelineCrossCheckExonerated).toBe(1);
  });
});

describe('isCrossCheckPipelineNarration — the vocabulary anchor (ticket 899554af)', () => {
  it.each([
    [{ kind: 'dispatch', detail: 'Delegated work', id: 'cross_checker' }, 'the incident shape — role id cited'],
    [{ kind: 'dispatch', detail: 'the Double Checker researched the same question in parallel', id: '' }, 'the seat label'],
    [{ kind: 'dispatch', detail: 'passed it to a crossmodel agent for an independent read', id: '' }, 'the incident phrasing without the role id'],
    [{ kind: 'message', detail: 'cross-checker draft reconciled into the answer', id: '' }, 'hyphenated/role prose'],
    [{ kind: 'dispatch', detail: 'ran a crosscheck on the figures', id: '' }, 'closed-up spelling'],
  ])('MATCHES: %s (%s)', (claim: any, _why: string) => {
    expect(isCrossCheckPipelineNarration(claim)).toBe(true);
  });

  it.each([
    [{ kind: 'dispatch', detail: 'dispatched a coding session for the cleanup', id: '1ca12570-0921-4a94-a857-f0b9b75f8933' }, 'a real dispatch id + no pipeline vocabulary'],
    [{ kind: 'message', detail: 'sent the digest to the overseer chat', id: '' }, 'unrelated message narration'],
    [{ kind: 'schedule', detail: 'armed the hourly sweep schedule', id: 'abc123de-0000' }, 'unrelated schedule narration'],
    [{ kind: 'dispatch', detail: 'an independent researcher answered the question', id: '' }, 'generic independence prose — deliberately NOT matched (could launder a real phantom)'],
    [{ kind: 'dispatch', detail: 'the council colleagues researched in parallel', id: '' }, 'council narration — a separate shape, crossCheckMerged stays false on L3'],
  ])('does NOT match: %s (%s)', (claim: any, _why: string) => {
    expect(isCrossCheckPipelineNarration(claim)).toBe(false);
  });
});

describe('chat-agent wiring pin (ticket 899554af)', () => {
  const SERVICE_SOURCE = readFileSync(join(__dirname, '../chat-agent/chat-agent.service.ts'), 'utf8');

  it('passes crossCheckDelivered: crossCheckMerged at ALL FOUR audit call sites (guard pass 1 + pass 2, post-delivery supervisor + user-facing)', () => {
    const occurrences = SERVICE_SOURCE.split('crossCheckDelivered: crossCheckMerged').length - 1;
    expect(occurrences).toBe(4);
  });

  it('NEVER wires the verifier to the injector latch draftsDelivered (reviewer F1: it flips BEFORE the gate check — a gate-timeout/empty-draft run would falsely exonerate)', () => {
    expect(SERVICE_SOURCE).not.toContain('crossCheckDelivered: draftsDelivered');
  });

  it('flips crossCheckMerged = true at EXACTLY THREE sites — the non-empty injected-draft branch, the successful late-reconcile (reviewer N1) and the compute-policy drafts_agree ACT skip (2026-09-26: the draft WAS weighed against the answer, the reconcile pass was skipped)', () => {
    const occurrences = SERVICE_SOURCE.split('crossCheckMerged = true').length - 1;
    expect(occurrences).toBe(3);
    expect(SERVICE_SOURCE).toContain('crossCheckMerged = true; // the draft was weighed against the answer — the check completed');
    // The gate-timeout branch must NOT set it: the 'gate' raced early-return
    // precedes the only injector-side flip, and the flip is conditioned on a
    // non-empty block.
    // 2026-09-26 (answer-first): the injector-side flip is now a block — still
    // conditioned on a non-empty draft block, still after the gate early-returns.
    expect(SERVICE_SOURCE).toMatch(/if \(block\) \{\n\s+crossCheckMerged = true;/);
    expect(SERVICE_SOURCE).toContain('reconciledLive = true;');
  });
});

/**
 * REPLAY — ticket f16cc02a (mishap, 2026-09-15): "Supervisor phantom claim:
 * narrated action(s) never executed (chat 810c924d)".
 *
 * The incident: a PROJECT supervisor's machine-wake note carried an ACTION-
 * class phantom ("todo_update → todo 5f561c18: restamped …", zero
 * consequential executions that run). The ticket auto-filed against it claims
 * PRE-DELIVERY strip+mark containment ("the note was DELIVERED with the
 * phantom-claim line(s) removed and marked — the struck claim line(s) never
 * reached the thread"; context containedPreDelivery:true +
 * deliveredRedacted:true) — but the thread shows the note delivered
 * UNMODIFIED (the phantom line reached the thread; no correction row fired).
 *
 * The mechanism (the class-flip hole): the b216475a citation-enforce branch
 * runs a consequences-ON SECOND guard pass after the reject-back. When the
 * standing second-pass verdict flips ACTION-class, the seam's F1
 * re-classification deliberately does NOT apply the redaction (the
 * 2026-09-11 observe-only flip keeps ACTION-class verdicts metric-only) —
 * yet the guard had ALREADY filed the ticket claiming redacted containment.
 * The ticket's provenance was FALSE, and downstream consumers that treat
 * containedPreDelivery sightings as contained recidivism
 * (feedback.service.ts counter-bump-without-reopen) were fed a lie.
 *
 * The fix: PhantomClaimAuditInput.consequenceScope. The citation-enforce
 * branch's second pass runs with 'citation-only' — consequences (the deduped
 * ticket + durable refutation) fire ONLY when the standing verdict is
 * all-citation-class (the verdict class the seam will actually enforce). An
 * ACTION-class standing verdict is returned struck with the redacted text
 * computed, but its consequences are SUPPRESSED; the seam's 'observed'
 * guard_strike row remains the record (the same doctrine a FIRST-pass
 * action-class strike gets in observe-only mode).
 *
 * Mock discipline mirrors action-verifier.test.ts: config/database and every
 * transitively-heavy boundary is mocked at the top, above imports.
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

import { guardMachineWakeFinalAnswer, ACTION_GUARD_REDACT_BANNER } from './action-verifier';

const CHAT = '810c924d-1d31-428c-bc6a-8120c132fcc4'; // the incident chat ("tt-rd Supervisor", project scope)

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

/**
 * The incident note's ACTIONS TAKEN line (verbatim from the persisted,
 * UNREDACTED thread row — msg 7c208262 in chat 810c924d). Zero consequential
 * actions executed that run, so the todo_update claim is a TRUE phantom.
 */
const INCIDENT_NOTE = [
  'WAKE 2026-09-15T15:26:39Z (wake-line clock; hook: bounty lane run_completed F126C).',
  '',
  '**Delta vs 15:18Z — bounty stay-silent CONFIRMED, one tiny ledger refresh:**',
  '',
  '- Bounty ledger todo 5f561c18 restamped: progressNote now reads F126C; blockedReason reset to "assignment stands, soak 24h".',
  '',
  'ACTIONS TAKEN',
  '',
  '- todo_update → todo 5f561c18: restamped bounty-ledger progressNote to F126C and reset blockedReason to "assignment stands, soak 24h" (was drifted).',
].join('\n');

/** The convicted ACTION-class claim, as the LLM extraction lane returned it in the incident run. */
const ACTION_CLAIM_LLM = JSON.stringify({
  claims: [{ kind: 'dispatch', detail: 'todo_update → todo 5f561c18: restamped bounty-ledger progressNote to F126C', id: '5f561c18' }],
});

/**
 * Guard-time clock pin for the deterministic future-observation lane, which
 * anchors to `new Date()` at guard time when no `now` override is injected
 * (PhantomClaimAuditInput.now — the documented test affordance, the same
 * convention action-verifier.test.ts and action-verifier.5a784ec2.test.ts
 * use). These replays must run at the incident evening: the note's bare
 * '15:18Z' clock-of-day token (Delta line) is in the PAST at
 * 2026-09-15T20:00Z — as it was at the incident's real guard time — but reads
 * as "later today", an impossible FUTURE observation, on any later UTC
 * morning; the future-clock strike then short-circuits the guard (full
 * replacement + its own ticket + phantoms:[]) BEFORE the ACTION lane audits
 * the dispatch claim. That fixture rot turned main red 2026-09-16 (both
 * ACTION-class tests failed at every commit from 2292975d1 onward; green at
 * PR #797 only because its CI ran after 15:26Z on 09-15).
 */
const INCIDENT_GUARD_NOW = new Date('2026-09-15T20:00:00Z');

describe('ticket f16cc02a — consequenceScope closes the class-flip hole', () => {
  it('REPLAY: citation-only scope + ACTION-class standing verdict → struck with the redaction computed, but the containment ticket + refutation are SUPPRESSED', async () => {
    mockUtilityChat.mockResolvedValueOnce(ACTION_CLAIM_LLM as never);
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, supervisorScope: 'project',
      now: INCIDENT_GUARD_NOW,
      machineTriggered: true, // consequences ON (the reject-back second-pass shape)
      consequenceScope: 'citation-only',
    });

    // The verdict itself is unchanged: the phantom convicts, the strip+mark
    // text is computed (the seam simply will not deliver it for this class).
    expect(res.struck).toBe(true);
    expect(res.audited).toBe(true);
    expect(res.phantoms).toHaveLength(1);
    expect(res.phantoms[0].kind).toBe('dispatch');
    expect(res.finalText).toContain(ACTION_GUARD_REDACT_BANNER);
    // THE FIX: no false containment record — the ticket that claimed
    // "delivered with the phantom-claim line(s) removed" (containedPreDelivery
    // / deliveredRedacted) while the note shipped UNMODIFIED is never filed,
    // and the durable state-doc refutation (equally false) never lands.
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('CONTROL: default scope (every legacy caller) keeps the consequences — an ACTION-class standing verdict files the strip+mark ticket + refutation', async () => {
    mockUtilityChat.mockResolvedValueOnce(ACTION_CLAIM_LLM as never);
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, supervisorScope: 'project',
      now: INCIDENT_GUARD_NOW,
      machineTriggered: true,
    });

    expect(res.struck).toBe(true);
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe(`Supervisor phantom claim: narrated action(s) never executed (chat ${CHAT.slice(0, 8)})`);
    expect(ticket.area).toBe('project-supervisor');
    expect(ticket.description).toContain('Pre-delivery strike');
    expect(ticket.description).toContain('strip+mark');
    expect(ticket.context.containedPreDelivery).toBe(true);
    expect(ticket.context.deliveredRedacted).toBe(true);
    expect(ticket.context.supervisorScope).toBe('project');
    expect(mockAppendVerifierRefutation).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: citation-only scope still enforces a CITATION-class standing verdict (the b216475a always-on lane is preserved)', async () => {
    // A fabricated msg citation — the deterministic evidence-citation miner
    // lifts it, the row-existence check (mocked: no row) convicts it, and its
    // detail carries the '[evidence citation]' tag → all-citation-class.
    const note = 'Cross-checked the lane digest claim (msg deadbeefcafe0011) before reporting it up.';
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: note, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, supervisorScope: 'project',
      machineTriggered: true,
      consequenceScope: 'citation-only',
    });

    expect(res.struck).toBe(true);
    expect(res.phantoms.length).toBeGreaterThan(0);
    expect(String(res.phantoms[0].detail)).toContain('[evidence citation]');
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.description).toContain('Fabricated citation');
    expect(mockAppendVerifierRefutation).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: deferConsequences still defers everything under citation-only scope (the first-pass reject-back shape is untouched)', async () => {
    mockUtilityChat.mockResolvedValueOnce(ACTION_CLAIM_LLM as never);
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
      runStartedAt: new Date(), supervisor: true, supervisorScope: 'project',
      now: INCIDENT_GUARD_NOW,
      machineTriggered: true, deferConsequences: true,
      consequenceScope: 'citation-only',
    });

    expect(res.struck).toBe(true);
    expect(res.rejectBackNotice).toBeDefined();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });
});


// audit 2026-10-08 W1-4: this suite pins the strip+mark / full-replacement delivery — now the
// OWNER_NOTE_NO_EDIT_DISABLED=1 kill-switch path (the default delivers the note as written + an
// observe-only annotation; action-verifier.owner-note-no-edit.test.ts pins that).
beforeAll(() => { process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1'; });
afterAll(() => { delete process.env.OWNER_NOTE_NO_EDIT_DISABLED; });

/**
 * REPLAY PIN — mishap ticket b216475a (2026-09-13, the ba65163d/a688ba29
 * class): the Fleet Supervisor chat (c0e22e36) delivered TWO notes citing four
 * FABRICATED feedback-ticket ids (1322de9e / 1f7cadb1 / 6cec4aa1 / 3562a3d4 —
 * none exist):
 *   - ca59c504 (17:32Z): headline "Framework stall tickets filed — 1:40 PM EDT
 *     (17:40Z)" — a future clock 8 min ahead of the run's real clock — plus a
 *     "Receipts: tickets 1322de9e, 1f7cadb1, 6cec4aa1, 3562a3d4 (file_feedback)"
 *     line.
 *   - 3e5775d4 (17:45Z): "… All 3 engineering-lane demands filed this run …" +
 *     the same four ids — re-emitted because the 17:32Z strike (had it fired)
 *     would have convicted the clock while EARLY-RETURNING before the ticket
 *     ids were ever named.
 * Three gaps made it possible: (1) both notes were anchored by AGENT-origin
 * sends (send_chat_message → origin 'agent', machineWake unset), so neither
 * the pre-delivery guard seam nor the supervisor post-delivery lane ran;
 * (2) no lane audited `ticket <id>` citations — the msg/sched/session lanes
 * key on their own labels and both action extractors miss passive "tickets
 * filed" prose; (3) the 2026-09-11 observe-only gate flip delivered even
 * matcher-struck notes unmodified, and the future-clock strike's early return
 * swallowed co-riding ticket convictions.
 *
 * This file pins the fix: PART A (the ticket-citation lane: miner, matcher,
 * near-miss bucket, computePhantomClaims wiring), PART B (the future-clock
 * strike names + returns co-riding fabricated ticket citations), and the
 * deterministic-only discipline (no LLM in either lane). The PART C seam
 * widening + always-on citation enforcement is pinned in
 * chat-agent.service.test.ts (the seam lives there).
 *
 * Mock discipline mirrors action-verifier.test.ts: config/database and every
 * transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) }, // coding_sessions (ticket f1cb73ff lane)
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) }, // user_feature_requests — the ticket lane's existence + near-miss probes (b216475a)
  // (tick 24) the kind-agnostic fallback for list-inferred ids probes every
  // artifact table — a MISSING mock throws, and citedIdExistsAnywhere fails
  // toward EXISTS, which would silently exonerate the incident's list ids.
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
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

// Main's state-doc service (#296): getSupervisorState (never null — degrades
// to an empty doc) + appendVerifierRefutation (the ONLY refutations writer).
const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

// Cross-wake exoneration (run-receipts follow-up): the durable receipt read is
// mocked at the module boundary (the real module reaches prisma).
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import { mineTicketCitations, findPhantomTicketCitations, computePhantomClaims, guardMachineWakeFinalAnswer, isCitationClassClaim, samePrefixRealIds, ExtractedClaim } from './action-verifier';

const CHAT = 'c0e22e36-1111-2222-3333-444455556666';
const noHints = async () => [] as string[];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
  // 378224d5 is the real chat the incident line cites in passing — the
  // tick-21 bare chat lane probes it, so the mocked store must know it.
  mockPrisma.crossModelChat.findFirst.mockImplementation(async (args: any) => (String(args?.where?.id?.startsWith ?? args?.where?.id ?? '').startsWith('378224d5') ? { id: '378224d5-0000-4000-8000-000000000000' } : null));
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.projectGoal.findFirst.mockResolvedValue(null);
  mockPrisma.projectTodo.findFirst.mockResolvedValue(null);
  mockPrisma.runToolReceipt.findFirst.mockResolvedValue(null);
});

describe('mineTicketCitations — deterministic ticket-citation mining (ticket b216475a)', () => {
  it('mines the singular label form "ticket <id>" from observation prose (no first-person verb)', () => {
    const mined = mineTicketCitations('Filed the digest regression as ticket ab12cd34 for triage pickup this run.');
    expect(mined).toHaveLength(1);
    expect(mined[0]).toMatchObject({ kind: 'ticket', id: 'ab12cd34' });
    expect(mined[0].detail.startsWith('[evidence citation]')).toBe(true);
    expect(isCitationClassClaim(mined[0])).toBe(true);
  });

  it('mines EVERY id of a plural "tickets <id>, <id>" list — the ca59c504 receipts idiom (tick 21, 2026-09-15: the list expansion closed the first-id-only under-breadth)', () => {
    const mined = mineTicketCitations('Receipts: tickets 1322de9e, 1f7cadb1 (file_feedback) — filed this run.');
    expect(mined.map((c) => c.id)).toEqual(['1322de9e', '1f7cadb1']);
    expect(mined.every((c) => c.kind === 'ticket')).toBe(true);
  });

  it('mines the parenthesized-label idiom "`6cec4aa1` (ticket)" (and the "(feedback)" sibling)', () => {
    expect(mineTicketCitations('The filed item `6cec4aa1` (ticket) tracks the framework stall.').map((c) => c.id)).toEqual(['6cec4aa1']);
    expect(mineTicketCitations('The filed item 3562a3d4 (feedback) tracks the framework stall.').map((c) => c.id)).toEqual(['3562a3d4']);
  });

  it('does NOT mine absence/refutation prose quoting the id (EVIDENCE_EXCLUSION) — discussing a phantom must not re-convict', () => {
    expect(mineTicketCitations('ticket 1322de9e does not exist — phantom cited in error.')).toEqual([]);
    expect(mineTicketCitations('The ticket id 1322de9e never existed — fabricated.')).toEqual([]);
    expect(mineTicketCitations('Cited ticket 1322de9e not found in user_feature_requests.')).toEqual([]);
  });

  it('does NOT mine blockquoted audit lines or sub-20-char lines', () => {
    expect(mineTicketCitations('> Receipts: tickets 1322de9e (file_feedback) — quoted from the struck note.')).toEqual([]);
    expect(mineTicketCitations('ticket ab12cd34')).toEqual([]); // below the line-length floor
  });

  it('dedupes per id across both label forms', () => {
    const note = [
      'Filed the stall as ticket ab12cd34 for triage pickup this run.',
      'Follow-up: `ab12cd34` (ticket) still open — dedupe keeps the first only.',
    ].join('\n');
    expect(mineTicketCitations(note).map((c) => c.id)).toEqual(['ab12cd34']);
  });
});

describe('findPhantomTicketCitations — existence exoneration (ticket b216475a)', () => {
  const INCIDENT_LINE = 'Receipts: tickets 1322de9e, 1f7cadb1, 6cec4aa1, 3562a3d4 (file_feedback); chat 378224d5.';

  it('convicts a cited ticket id whose row-check resolves FALSE (the incident shape — the id exists nowhere)', async () => {
    const phantoms = await findPhantomTicketCitations(INCIDENT_LINE, [], 'u1', async () => false, noHints, []);
    expect(phantoms).toHaveLength(4); // tick 21: every id of the list, not just the first
    expect(phantoms[0]).toMatchObject({ kind: 'ticket', id: '1322de9e' });
    expect(phantoms[0].detail.startsWith('[evidence citation]')).toBe(true);
  });

  it('exonerates a cited ticket id whose row exists', async () => {
    expect(await findPhantomTicketCitations(INCIDENT_LINE, [], 'u1', async () => true, noHints, [])).toEqual([]);
  });

  it('exonerates a cited id appearing VERBATIM in this run\'s tool-result haystacks (honestly copied from a file_feedback/list_feedback output)', async () => {
    const hay = ['{"ok":true,"tickets":[{"id":"1322de9e-abcd-4321-8765-0123456789ab","title":"Framework stall"},{"id":"1f7cadb1-0000-4000-8000-000000000001"},{"id":"6cec4aa1-0000-4000-8000-000000000002"},{"id":"3562a3d4-0000-4000-8000-000000000003"}]}'];
    const check = jest.fn(async () => false);
    expect(await findPhantomTicketCitations(INCIDENT_LINE, [], 'u1', check, noHints, hay)).toEqual([]);
    expect(check).not.toHaveBeenCalled(); // haystack exoneration lands BEFORE any DB probe
  });

  it('skips ids already carried by an action claim — the tier chain judged them (no double-processing)', async () => {
    const check = jest.fn(async () => false);
    const withClaim = ['1322de9e', '1f7cadb1', '6cec4aa1', '3562a3d4'].map((id) => ({ kind: 'ticket', detail: 'I filed it', id } as ExtractedClaim));
    expect(await findPhantomTicketCitations(INCIDENT_LINE, withClaim, 'u1', check, noHints, [])).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });

  it('attaches same-prefix REAL ticket ids as near-miss hints on a conviction (ticket ef347cd0 discipline)', async () => {
    const hints = ['1322de9e-aaaa-bbbb-cccc-dddddddddddd (ticket "Framework stall tickets", 2026-09-13T17:00:00.000Z)'];
    const phantoms = await findPhantomTicketCitations(INCIDENT_LINE, [], 'u1', async () => false, async () => hints, []);
    expect(phantoms[0].nearMiss).toEqual(hints);
  });

  it('fails toward MISS when the injected check rejects — an unverifiable citation is never a conviction', async () => {
    expect(await findPhantomTicketCitations(INCIDENT_LINE, [], 'u1', async () => { throw new Error('db down'); }, noHints, [])).toEqual([]);
  });

  it('the default row-check is citedTicketRowExists bound to the caller\'s userId (same-tenant scoped incl. null-userId system rows per ticket cdf7332b, prefix-matched)', async () => {
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue({ id: '1322de9e-abcd-4321-8765-0123456789ab' });
    expect(await findPhantomTicketCitations(INCIDENT_LINE, [], 'u1')).toEqual([]);
    expect(mockPrisma.userFeatureRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { startsWith: '1322de9e' }, OR: [{ userId: 'u1' }, { userId: null }] }) }),
    );
  });
});

describe('samePrefixRealIds — the ticket near-miss bucket (ticket b216475a)', () => {
  it('queries user_feature_requests same-tenant scoped (null-userId system rows included, ticket cdf7332b), titled + createdAt-desc, capped at 3', async () => {
    mockPrisma.userFeatureRequest.findMany.mockResolvedValueOnce([
      { id: '1322de9e-aaaa-bbbb-cccc-dddddddddddd', title: 'Framework stall tickets filed twice', createdAt: new Date('2026-09-13T17:00:00.000Z') },
    ]);
    const hints = await samePrefixRealIds('ticket', '1322de9e', 'u1');
    expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { startsWith: '1322de9e' }, OR: [{ userId: 'u1' }, { userId: null }] },
        orderBy: { createdAt: 'desc' },
        take: 3,
      }),
    );
    expect(hints).toEqual(['1322de9e-aaaa-bbbb-cccc-dddddddddddd (ticket "Framework stall tickets filed twice", 2026-09-13T17:00:00.000Z)']);
  });

  it('fails OPEN to [] on a DB error — a hint never blocks, reverses, or replaces a conviction', async () => {
    mockPrisma.userFeatureRequest.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(samePrefixRealIds('ticket', '1322de9e', 'u1')).resolves.toEqual([]);
  });
});

describe('computePhantomClaims integration — the ca59c504 receipts line convicts via the citation lane (ticket b216475a)', () => {
  it('a supervisor machine-wake note with "Receipts: tickets 1322de9e, …" and NO action claims convicts the fabricated ticket id (kind ticket, citation-class)', async () => {
    // The incident note body (the headline clock is the clock lane's business,
    // not this matcher's): passive "tickets filed" prose — zero action claims
    // by design of BOTH extractors (the LLM returns ''; the first-person
    // receipt-idiom miner needs "I filed").
    const note = [
      'Framework stall sweep complete — 3 engineering-lane demands handled this run.',
      'Receipts: tickets 1322de9e, 1f7cadb1, 6cec4aa1, 3562a3d4 (file_feedback); chat 378224d5.',
    ].join('\n');
    const out = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', finalText: note, parts: [], receipts: [],
      supervisor: true, machineTriggered: true, runStartedAt: new Date('2026-09-13T17:32:00.000Z'),
    });
    const ticketConvictions = out.phantoms.filter((p) => p.kind === 'ticket');
    // Tick 21 (2026-09-15): EVERY id in the list mines and convicts — the
    // first-id-only under-breadth this pin used to accept let the Fleet
    // Supervisor's "(msgs a, b, c; chats x, y)" lists deliver invented ids.
    expect(ticketConvictions.map((p) => p.id)).toEqual(['1322de9e', '1f7cadb1', '6cec4aa1', '3562a3d4']);
    expect(ticketConvictions[0].detail.startsWith('[evidence citation]')).toBe(true);
    expect(isCitationClassClaim(ticketConvictions[0])).toBe(true);
    // Existence-checked against user_feature_requests, same-tenant scoped
    // (null-userId system-filed rows included per ticket cdf7332b).
    expect(mockPrisma.userFeatureRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { startsWith: '1322de9e' }, OR: [{ userId: 'u1' }, { userId: null }] }) }),
    );
  });

  it('a ticket id VERBATIM in this run\'s tool_result parts is exonerated end-to-end (honest file_feedback copy)', async () => {
    const note = 'Filed the stall for triage; receipt ticket 1322de9e came back from file_feedback this run.';
    const out = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', finalText: note,
      parts: [{ type: 'tool_result', name: 'file_feedback', result: '{"ok":true,"ticket":{"id":"1322de9e-abcd-4321-8765-0123456789ab"}}' } as any],
      receipts: [], supervisor: true, machineTriggered: true, runStartedAt: new Date('2026-09-13T17:32:00.000Z'),
    });
    expect(out.phantoms.filter((p) => p.kind === 'ticket')).toEqual([]);
  });
});

describe('guardMachineWakeFinalAnswer — the future-clock strike names + returns co-riding fabricated ticket citations (PART B, ticket b216475a)', () => {
  // build 2026-10-08 Q-3: pins the LEGACY replace lane (FUTURE_CLOCK_REPLACE_ENABLED=1 restore path);
  // the default clock policy is pinned in action-verifier.future-clock-policy.q3.test.ts.
  beforeAll(() => { process.env.FUTURE_CLOCK_REPLACE_ENABLED = '1'; });
  afterAll(() => { delete process.env.FUTURE_CLOCK_REPLACE_ENABLED; });
  // ca59c504's exact shape: a headline clock 8 min AHEAD of the run's real
  // 17:32Z clock AND a receipts line of four fabricated ticket ids. Pre-fix
  // the clock lane early-returned phantoms:[] — the ids were never convicted,
  // never named, and the next wake re-emitted them (3e5775d4).
  const INCIDENT_NOTE = [
    '**Framework stall tickets filed — 1:40 PM EDT (17:40:00Z)**',
    'All 3 engineering-lane demands filed this run; triage owns the follow-ups.',
    'Receipts: tickets 1322de9e, 1f7cadb1, 6cec4aa1, 3562a3d4 (file_feedback); chat 378224d5.',
  ].join('\n');
  const NOW = new Date('2026-09-13T17:32:00.000Z');

  it('strikes on the future clock AND returns the fabricated ticket id in phantoms, named in notice + correction', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-13T17:31:00.000Z'), now: NOW,
    });
    expect(res.struck).toBe(true);
    // The future-clock lane fired (the 17:40:00Z headline).
    expect(res.notice).toContain('17:40:00Z');
    expect(res.notice).toContain('FUTURE');
    // PART B: the co-riding fabricated ticket citation is CONVICTED and named —
    // pre-fix this returned phantoms:[] and the ids escaped unnamed. Tick 21
    // (2026-09-15): every id of the receipts list convicts, not just the first.
    expect(res.phantoms.map((p) => p.id)).toEqual(['1322de9e', '1f7cadb1', '6cec4aa1', '3562a3d4']);
    expect(res.phantoms[0]).toMatchObject({ kind: 'ticket' });
    expect(isCitationClassClaim(res.phantoms[0])).toBe(true); // the seam's always-on citation enforcement treats the combined strike as citation-class
    expect(res.notice).toContain('1322de9e');
    expect(res.notice).toContain('Fabricated ticket citation(s) also found');
    expect(res.correction).toContain('1322de9e');
    expect(res.correction).toContain('never re-cite them');
    // Deterministic-only in the clock lane: no LLM extraction, no matcher call.
    expect(mockUtilityChat).not.toHaveBeenCalled();
    // The clock-class mishap ticket still files (consequences ON — no defer flag).
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('the reject-back notice names the fabricated ticket ids so the retry never re-cites them (deferConsequences)', async () => {
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-13T17:31:00.000Z'), now: NOW,
      deferConsequences: true,
    });
    expect(res.struck).toBe(true);
    expect(res.phantoms.map((p) => p.id)).toEqual(['1322de9e', '1f7cadb1', '6cec4aa1', '3562a3d4']);
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).toContain('1322de9e');
    expect(res.rejectBackNotice).toContain('never re-cite them');
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled(); // deferred — fires on the still-convicted retry instead
  });

  it('a REAL ticket id (row exists) co-riding a future clock convicts NOTHING — the clock strike keeps phantoms:[]', async () => {
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue({ id: '1322de9e-abcd-4321-8765-0123456789ab' });
    const res = await guardMachineWakeFinalAnswer({
      chatId: CHAT, userId: 'u1', finalText: INCIDENT_NOTE, parts: [], receipts: [],
      machineTriggered: true, supervisor: true, runStartedAt: new Date('2026-09-13T17:31:00.000Z'), now: NOW,
    });
    expect(res.struck).toBe(true); // the clock strike stands
    expect(res.phantoms).toEqual([]); // but the honest ticket citation is untouched
    expect(res.notice).not.toContain('Fabricated ticket citation(s) also found');
  });
});

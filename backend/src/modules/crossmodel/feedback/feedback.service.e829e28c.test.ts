/**
 * REPLAY PIN — ticket e829e28c (mishap, breaker trip 2026-09-11, session
 * 4194f3cc "Why You Still See Stale Submissions").
 *
 * The mishap (verbatim failure texts, newest first):
 *   · Tool update_feedback failed: Feedback ticket "d78f477b" not found.
 *   · Tool update_feedback failed: Feedback ticket "b8bdc0e2" not found.
 *   · Tool update_feedback failed: Feedback ticket "0339dfc0" not found.
 *
 * All three tickets EXISTED (they resolve via get_feedback on the same
 * prefixes). The lane passed the fleet-standard 8-char prefix convention —
 * get_feedback, goal_get, todo_get, hook_update, schedule_get all resolve
 * unique ≥8-char prefixes, and dispatch briefs/adminNotes cite prefixes —
 * but updateFeedbackTicket resolved EXACT ids only (its existence pre-check),
 * so every prefixed update_feedback 404'd deterministically. Adjudication:
 * DETERMINISTIC FRAMEWORK GAP (id-resolution parity), not model behavior.
 *
 * Fix pinned here: update_feedback + the machine-close evidence gate resolve
 * a UNIQUE ≥8-char prefix to the full row id; an ambiguous prefix refuses
 * with candidates (never a silent mis-write/mis-close); unknown/short ids
 * keep the verbatim legacy refusal shapes. These tests 404/fail against the
 * pre-fix code — the replay.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Same import-graph guards as feedback.service.test.ts (env-exit boundaries).
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'sent', batched: 0 })),
  dispatchTicketToLane: jest.fn(async () => 'sent'),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

import { updateFeedbackTicket } from './feedback.service';
import { verifyMachineCloseEvidence } from './closure-evidence';

/** The three tickets from the mishap's verbatim failure texts (prefix → full id). */
const MISHAP_TICKETS: Record<string, string> = {
  d78f477b: 'd78f477b-34a6-44ad-b32e-15c7a91a98fa',
  b8bdc0e2: 'b8bdc0e2-bb06-440c-8428-dde823a33913',
  '0339dfc0': '0339dfc0-d9f3-48ef-af3a-d949d85815fe',
};

describe('update_feedback unique-prefix resolution (replay pin, ticket e829e28c)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(Object.entries(MISHAP_TICKETS))(
    'the mishap prefix "%s" resolves to its full id and the update targets the resolved row',
    async (prefix, fullId) => {
      // Exact lookup misses (the pre-fix code stopped here and 404'd); the
      // unique prefix scan finds exactly one row.
      mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
      mockPrisma.userFeatureRequest.findMany.mockResolvedValue([{ id: fullId }]);
      mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: fullId, status: 'in_progress', priority: 0, adminNote: 'triage' });

      const r = await updateFeedbackTicket({ id: prefix, status: 'in_progress', adminNote: 'triage' });

      expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: prefix } },
        take: 3,
      });
      expect(mockPrisma.userFeatureRequest.update).toHaveBeenCalledWith({
        where: { id: fullId },
        data: { status: 'in_progress', adminNote: 'triage' },
      });
      expect(r).toMatchObject({ id: fullId });
    },
  );

  it('an unknown ≥8-char prefix keeps the verbatim legacy 404 shape — the mishap failure text', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    await expect(updateFeedbackTicket({ id: 'ffffffff', status: 'done' })).rejects.toMatchObject({
      statusCode: 404,
      message: 'Feedback ticket "ffffffff" not found.',
    });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('an ambiguous prefix refuses with the candidates and NEVER writes (no silent mis-write)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      { id: MISHAP_TICKETS.d78f477b },
      { id: 'd78f477b-ffff-4000-8000-000000000000' },
    ]);
    await expect(updateFeedbackTicket({ id: 'd78f477b', status: 'done' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('ambiguous'),
    });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('a short prefix (<8 chars) never scans — 404 without a findMany', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    await expect(updateFeedbackTicket({ id: 'd78f', status: 'done' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockPrisma.userFeatureRequest.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalled();
  });

  it('an exact full-id hit updates without a prefix scan (unchanged fast path)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue({ id: MISHAP_TICKETS.d78f477b });
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: MISHAP_TICKETS.d78f477b, status: 'done', priority: 3, adminNote: null });
    await updateFeedbackTicket({ id: MISHAP_TICKETS.d78f477b, status: 'done' });
    expect(mockPrisma.userFeatureRequest.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.userFeatureRequest.update).toHaveBeenCalledWith({
      where: { id: MISHAP_TICKETS.d78f477b },
      data: { status: 'done' },
    });
  });
});

describe('machine-close evidence gate — prefix parity at the fail-closed boundary (ticket e829e28c)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a unique 8-char prefix loads the ticket for evidence verification (pre-fix: ticket_not_found refusal)', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      { id: MISHAP_TICKETS.d78f477b, type: 'bug_report', title: 'Prefix resolution regression' },
    ]);
    const v = await verifyMachineCloseEvidence({ ticketId: 'd78f477b', evidence: { commitSha: 'a'.repeat(40) } });
    expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: 'd78f477b' } },
      take: 2,
      select: { id: true, type: true, title: true, userId: true },
    });
    expect(v).toMatchObject({ ok: true, verified: ['commitSha'] });
  });

  it('an ambiguous prefix at the gate fails CLOSED (ticket_not_found) — never a mis-close', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([
      { id: MISHAP_TICKETS.d78f477b, type: 'mishap', title: 'a' },
      { id: 'd78f477b-ffff-4000-8000-000000000000', type: 'bug_report', title: 'b' },
    ]);
    const v = await verifyMachineCloseEvidence({ ticketId: 'd78f477b', evidence: { commitSha: 'a'.repeat(40) } });
    expect(v).toMatchObject({ ok: false, reason: 'ticket_not_found' });
  });

  it('an unknown ≥8-char prefix keeps the verbatim gate refusal shape', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    const v = await verifyMachineCloseEvidence({ ticketId: 'ffffffff', evidence: { commitSha: 'a'.repeat(40) } });
    expect(v).toMatchObject({ ok: false, reason: 'ticket_not_found' });
    if (v.ok) throw new Error('expected a fail-closed refusal');
    expect(v.message).toContain('Feedback ticket "ffffffff" not found');
  });

  it('a short prefix (<8) at the gate never scans', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(null);
    const v = await verifyMachineCloseEvidence({ ticketId: 'd78f', evidence: { commitSha: 'a'.repeat(40) } });
    expect(v).toMatchObject({ ok: false, reason: 'ticket_not_found' });
    expect(mockPrisma.userFeatureRequest.findMany).not.toHaveBeenCalled();
  });
});

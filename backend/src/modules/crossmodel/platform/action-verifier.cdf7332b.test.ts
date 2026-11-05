/**
 * REPLAY PIN — bug ticket cdf7332b (2026-09-14): a REAL feedback-ticket id
 * struck as "does not exist" by the action verifier's existence check.
 *
 * The incident (2026-09-14 23:28Z, Fleet Supervisor chat c0e22e36): the
 * supervisor's wake note cited the DeepSeek billing-outage ticket 2b7ceafa
 * (filed 22:36:51Z by the utilityChat billing/auth latch — pid 1, a system
 * lane with NO user context, so user_feature_requests.userId is NULL). The
 * ticket-citation lane's row check, citedTicketRowExists(id, ownerUserId),
 * scoped its probe to `userId = <owner>` — the NULL row never matched, the
 * REAL citation was convicted "does not exist (database existence-checked)"
 * and strip+marked out of the delivered note, and the near-miss bucket
 * (samePrefixRealIds, same scope) found nothing to teach with.
 *
 * The fix: the ticket store's tenant scope is `OR: [{ userId }, { userId: null }]`
 * — the caller's own rows PLUS system-filed null-userId rows, which the
 * owner's lanes legitimately see via get_feedback/list_feedback (the read
 * path returns them). FOREIGN non-null userIds stay excluded (the 0beea9f1
 * cross-tenant fabricated-or-leaked doctrine stands).
 *
 * These tests emulate the tenant filter STATEFULLY over fake rows (the mock
 * applies the where clause instead of returning canned values), so the
 * exoneration/conviction outcomes are decided by the REAL query shape the
 * code emits — a regression to a bare `userId = <caller>` scope re-breaks
 * the incident replay.
 *
 * Mock discipline mirrors action-verifier.b216475a.test.ts: config/database
 * and every transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

import { findPhantomTicketCitations, citedTicketRowExists, samePrefixRealIds } from './action-verifier';

const OWNER = 'u-owner-83e4fbf9';
// The incident row: system-filed by the pid-1 utilityChat billing latch → userId NULL.
const OUTAGE_TICKET = { id: '2b7ceafa-47b6-4f2b-adbb-e06de238cb5e', userId: null as string | null, title: 'PROVIDER BILLING OUTAGE — DeepSeek answered HTTP 402', createdAt: new Date('2026-09-14T22:36:51.397Z') };
const OWN_TICKET = { id: 'fcc28eba-1111-4222-8333-444444444444', userId: OWNER, title: 'owner-filed ticket', createdAt: new Date('2026-09-07T00:00:00.000Z') };
const FOREIGN_TICKET = { id: 'aaaa0000-9999-4888-8777-666655554444', userId: 'u-someone-else', title: 'another tenant’s ticket', createdAt: new Date('2026-09-10T00:00:00.000Z') };
const TICKET_ROWS = [OUTAGE_TICKET, OWN_TICKET, FOREIGN_TICKET];

/** Stateful tenant-filter emulator: applies the where clause the code emits. */
function applyWhere(rows: typeof TICKET_ROWS, where: any): typeof TICKET_ROWS {
  return rows.filter((r) => {
    if (where?.id) {
      if (typeof where.id === 'string') {
        if (r.id !== where.id) return false;
      } else if (where.id.startsWith) {
        if (!r.id.startsWith(where.id.startsWith)) return false;
      }
    }
    if (Array.isArray(where?.OR)) {
      const inTenant = where.OR.some((cond: any) => ('userId' in cond ? r.userId === cond.userId : false));
      if (!inTenant) return false;
    } else if (where && 'userId' in where) {
      if (r.userId !== where.userId) return false;
    }
    return true;
  });
}

/** Wire the emulator: findFirst = first match (or null), findMany = all matches. */
function emulateTicketStore() {
  mockPrisma.userFeatureRequest.findFirst.mockImplementation(async ({ where }: any) => applyWhere(TICKET_ROWS, where)[0] ?? null);
  mockPrisma.userFeatureRequest.findMany.mockImplementation(async ({ where }: any) => applyWhere(TICKET_ROWS, where));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockPrisma.chatSchedule.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  emulateTicketStore();
});

describe('ticket cdf7332b — null-userId system-filed tickets are in-tenant for the existence check', () => {
  it('INCIDENT REPLAY: the supervisor note citing outage ticket 2b7ceafa (userId NULL) is NOT convicted', async () => {
    // The struck line's shape (the original also carried a schedule citation —
    // out of scope here; the ticket lane is what false-negative'd).
    const note = [
      'Fleet wake — DeepSeek outage still active: ticket 2b7ceafa remains in_progress per this wake\'s get_feedback pull; the lane\'s 2h re-probe stays armed.',
    ].join('\n');
    const phantoms = await findPhantomTicketCitations(note, [], OWNER, undefined, undefined, []);
    expect(phantoms).toEqual([]);
    // The probe went out with the widened tenant scope — the null-userId row matched.
    expect(mockPrisma.userFeatureRequest.findFirst).toHaveBeenCalledWith({
      where: { id: { startsWith: '2b7ceafa' }, OR: [{ userId: OWNER }, { userId: null }] },
      select: { id: true },
    });
  });

  it('citedTicketRowExists: a null-userId system-filed row EXISTS for the owner caller (the false negative itself)', async () => {
    expect(await citedTicketRowExists('2b7ceafa', OWNER)).toBe(true);
    // Exact-uuid form takes the same scope.
    expect(await citedTicketRowExists(OUTAGE_TICKET.id, OWNER)).toBe(true);
  });

  it('the 0beea9f1 cross-tenant doctrine STANDS: a FOREIGN non-null userId row still convicts', async () => {
    const note = 'Audit cross-check: ticket aaaa0000 was cited as precedent for the triage ruling this run.';
    const phantoms = await findPhantomTicketCitations(note, [], OWNER, undefined, undefined, []);
    expect(phantoms).toHaveLength(1);
    expect(phantoms[0]).toMatchObject({ kind: 'ticket', id: 'aaaa0000' });
    expect(await citedTicketRowExists('aaaa0000', OWNER)).toBe(false);
  });

  it('a fabricated ticket id (NO row at all) still convicts — existence coverage did not go fail-open', async () => {
    const note = 'Filed the digest regression as ticket deadbeef for triage pickup this run.';
    const phantoms = await findPhantomTicketCitations(note, [], OWNER, undefined, undefined, []);
    expect(phantoms).toHaveLength(1);
    expect(phantoms[0]).toMatchObject({ kind: 'ticket', id: 'deadbeef' });
  });

  it('an own-tenant row still exonerates (the pre-fix happy path is unchanged)', async () => {
    const note = 'Closing the loop: ticket fcc28eba carried the full fix record from this lane earlier.';
    expect(await findPhantomTicketCitations(note, [], OWNER, undefined, undefined, [])).toEqual([]);
    expect(await citedTicketRowExists('fcc28eba', OWNER)).toBe(true);
  });

  it('samePrefixRealIds surfaces the null-userId row as the near-miss hint the strike should have taught with', async () => {
    const hints = await samePrefixRealIds('ticket', '2b7ceafa', OWNER);
    expect(mockPrisma.userFeatureRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { startsWith: '2b7ceafa' }, OR: [{ userId: OWNER }, { userId: null }] },
        orderBy: { createdAt: 'desc' },
        take: 3,
      }),
    );
    expect(hints).toEqual([
      '2b7ceafa-47b6-4f2b-adbb-e06de238cb5e (ticket "PROVIDER BILLING OUTAGE — DeepSeek answered HTTP 402", 2026-09-14T22:36:51.397Z)',
    ]);
  });

  it('caller userId UNKNOWN → no tenant scope at all (unscoped probe; the null row matches trivially)', async () => {
    expect(await citedTicketRowExists('2b7ceafa')).toBe(true);
    expect(mockPrisma.userFeatureRequest.findFirst).toHaveBeenLastCalledWith({
      where: { id: { startsWith: '2b7ceafa' } },
      select: { id: true },
    });
  });

  it('DB error still fails toward MISS — the widened scope never convict on an unverifiable citation', async () => {
    mockPrisma.userFeatureRequest.findFirst.mockRejectedValueOnce(new Error('db down'));
    expect(await citedTicketRowExists('2b7ceafa', OWNER)).toBe(true);
  });
});

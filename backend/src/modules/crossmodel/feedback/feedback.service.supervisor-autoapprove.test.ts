/**
 * SHARED-PROJECT-DISPATCH (supervisor SOTA round 3, 2026-10-20) — an
 * agent-filed about=digby_platform ticket from a SUPERVISOR seat on another
 * account is auto-approved for a ticket lane, carrying the defect SHAPE only.
 *
 * REPLAY (ticket 22d667e7): an editor's project-supervisor chat on a shared
 * project filed the start_coding_session defect about Digby itself; the
 * dispatcher held it (another account) from 10-18 with no card and no board
 * line. The fixture text below is SYNTHETIC.
 *
 * Review fix (2026-10-20, blocking): ONLY that shared-project case
 * auto-approves — a project-supervisor seat of an editor / admin member of a
 * project the ticket-lane OWNER owns, filed on a MACHINE turn. A fresh
 * signup's Fleet Supervisor, a human typing the ask, a project someone else
 * owns or a viewer all stay HELD (then escalated to the owner's card).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  projectMember: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const mockResolveOwner: jest.Mock = jest.fn(async () => 'owner-1');
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'sent', batched: 1 })),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
  resolveTicketOwnerUserId: (...a: any[]) => mockResolveOwner(...a),
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string) { super(message); }
  },
}));

import { fileFeedbackTicket } from './feedback.service';
import { SUPERVISOR_SHAPE_ONLY_HEADER } from './harness-ticket';
import { AUTO_APPROVED_BY } from './held-ticket-escalation';

const PRIVATE_LINE = 'the donate page copy the client sent on Tuesday';
const FILING = {
  userId: 'editor-9',
  type: 'bug_report',
  title: 'start_coding_session refuses "Project not found" from a project-supervisor seat on a shared (editor) project',
  description: `From the shared project's supervisor chat: the spawn refused four ways. Blocks the site edits (${PRIVATE_LINE}).`,
  priority: 2,
  context: { sessionId: 'sup-chat-1', surface: 'coding', filedBy: 'sup-chat-1', about: 'digby_platform', digbyEvidence: `reproduces in Digby's own API (${PRIVATE_LINE})`, projectId: '887dcccb-0000-4000-8000-000000000001' },
  filerSeat: 'project_supervisor' as const,
  filerProjectId: '887dcccb-0000-4000-8000-000000000001',
  filerMachineTurn: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.HELD_PLATFORM_TICKET_AUTOAPPROVE_DISABLED;
  mockResolveOwner.mockResolvedValue('owner-1');
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
  mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'ticket-new', ...data }));
  mockPrisma.user.findUnique.mockImplementation(async ({ where }: any) => ({ role: where.id === 'owner-1' || where.id === 'admin-2' ? 'ADMIN' : 'USER' }));
  // The filing project is the ticket-lane OWNER's; editor-9 is an EDITOR member of it.
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ userId: 'owner-1' });
  mockPrisma.projectMember.findUnique.mockImplementation(async ({ where }: any) => (where.projectId_userId.userId === 'editor-9' ? { role: 'editor' } : null));
});

/** Reset the create/read mocks between two filings in one test. */
const resetFiling = () => {
  mockPrisma.userFeatureRequest.create.mockClear();
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
  mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'ticket-new', ...data }));
};

const stored = () => mockPrisma.userFeatureRequest.create.mock.calls[0][0].data as { description: string; context: Record<string, unknown> };

describe('a supervisor seat\'s platform ticket on another account', () => {
  it('is auto-approved for a lane and stored SHAPE-ONLY (no filer free text, no evidence text)', async () => {
    const r: any = await fileFeedbackTicket(FILING);
    expect(r.ticket.id).toBe('ticket-new');
    const { description, context } = stored();
    expect(description.startsWith(SUPERVISOR_SHAPE_ONLY_HEADER)).toBe(true);
    expect(description).toContain(`Defect: ${FILING.title}`);
    expect(description).toContain('project supervisor seat');
    expect(description).not.toContain(PRIVATE_LINE);
    expect(context).toMatchObject({ dispatchApproved: true, dispatchApprovedBy: AUTO_APPROVED_BY, subjectContentWithheld: true, autoApproved: { seat: 'project_supervisor', projectId: FILING.filerProjectId, memberRole: 'editor' } });
    // the relationship was read: the filing project's owner + the filer's membership on it
    expect(mockPrisma.crossModelProject.findUnique).toHaveBeenCalledWith({ where: { id: FILING.filerProjectId }, select: { userId: true } });
    expect(mockPrisma.projectMember.findUnique).toHaveBeenCalledWith({ where: { projectId_userId: { projectId: FILING.filerProjectId, userId: 'editor-9' } }, select: { role: true } });
    expect(context.digbyEvidence).toBeUndefined();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'held_ticket_escalation', meta: expect.objectContaining({ phase: 'autoapprove', ticketId: 'ticket-new' }) }));
  });

  it('the owner\'s / an admin\'s own supervisor filing is untouched (it already dispatches) — full description, no approval stamp', async () => {
    await fileFeedbackTicket({ ...FILING, userId: 'owner-1' });
    expect(stored().description).toContain(PRIVATE_LINE);
    expect(stored().context.dispatchApproved).toBeUndefined();
    jest.clearAllMocks();
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'ticket-new', ...data }));
    await fileFeedbackTicket({ ...FILING, userId: 'admin-2' });
    expect(stored().context.dispatchApproved).toBeUndefined();
  });

  it('a non-supervisor chat, a user_project filing or no seat stays HELD as before (full description, no stamp)', async () => {
    const { filerSeat: _s, ...noSeat } = FILING;
    await fileFeedbackTicket(noSeat);
    expect(stored().context.dispatchApproved).toBeUndefined();
    expect(stored().description).toContain(PRIVATE_LINE);
  });

  it('review fix (blocking): a fresh signup\'s FLEET Supervisor filing stays HELD — full description, no approval stamp', async () => {
    await fileFeedbackTicket({ ...FILING, userId: 'fresh-signup', filerSeat: 'fleet_supervisor', filerProjectId: null });
    expect(stored().context.dispatchApproved).toBeUndefined();
    expect(stored().description).toContain(PRIVATE_LINE);
  });

  it('review fix: a HUMAN turn (someone typing "file a digby_platform bug" in their own supervisor chat) stays HELD', async () => {
    await fileFeedbackTicket({ ...FILING, filerMachineTurn: false });
    expect(stored().context.dispatchApproved).toBeUndefined();
    resetFiling();
    const { filerMachineTurn: _m, ...noTurn } = FILING;
    await fileFeedbackTicket(noTurn);
    expect(stored().context.dispatchApproved).toBeUndefined();
  });

  it('review fix: a supervisor of a project the owner does NOT own, a VIEWER member, a non-member or no filing project stays HELD', async () => {
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ userId: 'someone-else' });
    await fileFeedbackTicket(FILING);
    expect(stored().context.dispatchApproved).toBeUndefined();

    resetFiling();
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ userId: 'owner-1' });
    mockPrisma.projectMember.findUnique.mockResolvedValue({ role: 'viewer' });
    await fileFeedbackTicket(FILING);
    expect(stored().context.dispatchApproved).toBeUndefined();

    resetFiling();
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    await fileFeedbackTicket(FILING);
    expect(stored().context.dispatchApproved).toBeUndefined();

    resetFiling();
    mockPrisma.projectMember.findUnique.mockResolvedValue({ role: 'admin' });
    await fileFeedbackTicket({ ...FILING, filerProjectId: null });
    expect(stored().context.dispatchApproved).toBeUndefined();
    // …while the same filing WITH the owner's project and an admin membership approves
    resetFiling();
    await fileFeedbackTicket(FILING);
    expect(stored().context).toMatchObject({ dispatchApproved: true, autoApproved: { memberRole: 'admin' } });
  });

  it('the kill switch (and an unresolvable lane owner) leaves the filing held — fail-closed', async () => {
    process.env.HELD_PLATFORM_TICKET_AUTOAPPROVE_DISABLED = '1';
    await fileFeedbackTicket(FILING);
    expect(stored().context.dispatchApproved).toBeUndefined();
    delete process.env.HELD_PLATFORM_TICKET_AUTOAPPROVE_DISABLED;
    jest.clearAllMocks();
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
    mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'ticket-new', ...data }));
    mockResolveOwner.mockResolvedValue(null);
    await fileFeedbackTicket(FILING);
    expect(stored().context.dispatchApproved).toBeUndefined();
  });
});

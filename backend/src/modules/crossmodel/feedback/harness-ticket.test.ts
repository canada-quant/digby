/**
 * audit 2026-10-08 W5-1b — harness tickets about ANOTHER account's chat.
 *
 * REPLAY (goals.md F3, ticket 7cabb0cc): the action verifier auto-filed a
 * mishap about an external account's chat, stored under that account's user
 * id with a verbatim note excerpt — the user saw the internal ticket in their
 * own Feedback tab, and the excerpt reached a framework lane and a repo test
 * fixture. The fixture text below is SYNTHETIC (W5-1c): it carries the
 * incident's SHAPE (a council-dispatch status note) and nothing from that chat.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'sent', batched: 1 })),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string) { super(message); }
  },
}));

import { fileFeedbackTicket } from './feedback.service';
import {
  isHarnessTicketContext, isHarnessTicketRow, hiddenFromSubjectTab, idsCitedIn, shapeOnlyDescription, SHAPE_ONLY_HEADER,
} from './harness-ticket';

// SYNTHETIC subject chat + note (never another account's text or id).
const SUBJECT_CHAT = '0c0ffee0-5a5a-4b4b-8c8c-000000007cab';
const PRIVATE_LINE = 'one on the historical-dating claims, one on current battery-chemistry research';
const NOTE = `## Deeper findings\n\n**Run status:** I dispatched both council colleagues (${PRIVATE_LINE}), but both ran past the dispatch ceiling and their reports came back empty.`;
const VERIFIER_FILING = {
  userId: 'external-user-1',
  type: 'mishap',
  title: `Phantom action claim: chat asserted action(s) never executed (chat ${SUBJECT_CHAT.slice(0, 8)})`,
  description: `A user-facing chat turn claimed actions its tool log never executed.\n\nPhantom claims:\n- [dispatch] "I dispatched both council colleagues (${PRIVATE_LINE})"\n\nExecuted consequential actions this run: NONE\n\nNote excerpt:\n${NOTE}`,
  priority: 3,
  area: 'fleet-integrity',
  shapeDescription: 'A user-facing chat turn claimed actions its tool log never executed. Claim shape: [dispatch] (no id); executed consequential actions this run: NONE.',
  context: { sessionId: SUBJECT_CHAT, surface: 'chat', verifier: 'action-verifier', filedAt: '2026-10-08T08:03:00.000Z' },
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FEEDBACK_HARNESS_SUBJECT_REDACT_DISABLED;
  delete process.env.FEEDBACK_HARNESS_HIDE_FROM_SUBJECT_DISABLED;
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
  mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'harness-ticket-1', ...data }));
  mockPrisma.user.findUnique.mockImplementation(async ({ where }: any) => ({ role: where.id === 'owner-1' ? 'ADMIN' : 'USER' }));
});

const storedDescription = () => mockPrisma.userFeatureRequest.create.mock.calls[0][0].data.description as string;
const storedContext = () => mockPrisma.userFeatureRequest.create.mock.calls[0][0].data.context as Record<string, unknown>;

describe('REPLAY 7cabb0cc: a verifier ticket about another account\'s chat stores the SHAPE only', () => {
  it('no verbatim chat text is stored — the defect, the detector, the shape line and the ids', async () => {
    await fileFeedbackTicket(VERIFIER_FILING);
    const d = storedDescription();
    expect(d).not.toContain(PRIVATE_LINE);
    expect(d).not.toContain('Deeper findings');
    expect(d).not.toContain('Note excerpt');
    expect(d.startsWith(SHAPE_ONLY_HEADER)).toBe(true);
    expect(d).toContain(`Defect: ${VERIFIER_FILING.title}`);
    expect(d).toContain('Detector: action-verifier · surface chat · subject chat 0c0ffee0');
    expect(d).toContain('Shape: A user-facing chat turn claimed actions its tool log never executed. Claim shape: [dispatch] (no id)');
    expect(storedContext()).toMatchObject({ subjectContentWithheld: true, verifier: 'action-verifier' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'harness_ticket_subject_redacted', sessionId: SUBJECT_CHAT }));
  });

  it("an ADMIN account's chat keeps the full description (the owner's own content)", async () => {
    await fileFeedbackTicket({ ...VERIFIER_FILING, userId: 'owner-1' });
    expect(storedDescription()).toContain(PRIVATE_LINE);
    expect(storedContext().subjectContentWithheld).toBeUndefined();
  });

  it('a non-harness agent filing (the user\'s own report via file_feedback) is stored as written', async () => {
    const { verifier: _v, ...ctx } = VERIFIER_FILING.context;
    await fileFeedbackTicket({ ...VERIFIER_FILING, context: { ...ctx, filedBy: SUBJECT_CHAT } });
    expect(storedDescription()).toContain(PRIVATE_LINE);
  });

  it('a class-stamped harness ticket (no shape line) falls back to the generic shape', async () => {
    await fileFeedbackTicket({ ...VERIFIER_FILING, shapeDescription: undefined, context: { sessionId: SUBJECT_CHAT, class: 'provider_billing', runId: 'abcd1234-0000-4000-8000-000000000000' } });
    const d = storedDescription();
    expect(d).not.toContain(PRIVATE_LINE);
    expect(d).toContain('Detector: provider_billing · subject chat 0c0ffee0 · run abcd1234');
    expect(d).not.toContain('Shape:');
  });

  it('kill switch FEEDBACK_HARNESS_SUBJECT_REDACT_DISABLED=1 stores the full description (pre-fix)', async () => {
    process.env.FEEDBACK_HARNESS_SUBJECT_REDACT_DISABLED = '1';
    await fileFeedbackTicket(VERIFIER_FILING);
    expect(storedDescription()).toContain(PRIVATE_LINE);
  });

  it('an anonymous (userId null) process-level alert is never redacted (no subject account)', async () => {
    await fileFeedbackTicket({ ...VERIFIER_FILING, userId: null });
    expect(storedDescription()).toContain(PRIVATE_LINE);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('pure helpers', () => {
  it('a harness ticket is a detector-stamped agent row', () => {
    expect(isHarnessTicketContext({ verifier: 'action-verifier' })).toBe(true);
    expect(isHarnessTicketContext({ class: 'provider_billing' })).toBe(true);
    expect(isHarnessTicketContext({ verifier: '  ' })).toBe(false);
    expect(isHarnessTicketContext({ sessionId: 'x', filedBy: 'x' })).toBe(false);
    expect(isHarnessTicketRow({ source: 'agent', context: { verifier: 'evidence-guard' } })).toBe(true);
    expect(isHarnessTicketRow({ source: 'user', context: { verifier: 'evidence-guard' } })).toBe(false);
  });

  it('hiddenFromSubjectTab: a non-admin never sees a harness row; admins see all; kill switch restores', () => {
    const harness = { source: 'agent', context: { verifier: 'action-verifier' } };
    const own = { source: 'agent', context: { filedBy: 'c1' } };
    expect(hiddenFromSubjectTab(harness, false)).toBe(true);
    expect(hiddenFromSubjectTab(harness, true)).toBe(false);
    expect(hiddenFromSubjectTab(own, false)).toBe(false);
    expect(hiddenFromSubjectTab(harness, false, { FEEDBACK_HARNESS_HIDE_FROM_SUBJECT_DISABLED: '1' } as any)).toBe(false);
  });

  it('idsCitedIn: uuids then bare hex ids (letters AND digits), de-duplicated by prefix', () => {
    expect(idsCitedIn(`chat ${SUBJECT_CHAT} and 0c0ffee0, commit 5bffa38c, word deadbeef, run abc12345678`))
      .toEqual([SUBJECT_CHAT, '5bffa38c', 'abc12345678']);
  });

  it('shapeOnlyDescription never echoes the description body', () => {
    const d = shapeOnlyDescription({ title: 'T', description: `secret body ${PRIVATE_LINE} 5bffa38c`, context: { verifier: 'x' } });
    expect(d).not.toContain('secret body');
    expect(d).toContain('Ids referenced: 5bffa38c');
  });
});

describe('the Feedback tab hides harness rows from non-admins (source pins — the controller is too heavy to boot here)', () => {
  const CONTROLLER = readFileSync(join(__dirname, '..', 'crossmodel.controller.ts'), 'utf8');
  it('getFeatureRequests filters with hiddenFromSubjectTab and subtracts the hidden rows from the counts', () => {
    expect(CONTROLLER).toContain("const requests = allRequests.filter((r) => !hiddenFromSubjectTab(r, requesterIsAdmin));");
    expect(CONTROLLER).toContain("hiddenRows = (agentRows as any[]).filter((r) => hiddenFromSubjectTab(r, false));");
    expect(CONTROLLER).toContain('for (const h of hiddenRows) {');
  });
  it('resolveOwnFeatureRequest answers 404 for a hidden harness row', () => {
    expect(CONTROLLER).toContain("if (hiddenFromSubjectTab(existing, (req as any).user?.role === 'ADMIN')) {");
  });
  it('the admin approval endpoints exist and are admin-gated', () => {
    expect(CONTROLLER).toContain('async adminListHeldFeatureRequests(');
    expect(CONTROLLER).toContain('async adminApproveFeatureRequestDispatch(');
    const ROUTES = readFileSync(join(__dirname, '..', 'crossmodel.routes.ts'), 'utf8');
    expect(ROUTES).toContain("router.get('/admin/feature-requests/held', controller.adminListHeldFeatureRequests);");
    expect(ROUTES).toContain("router.post('/admin/feature-requests/:id/approve-dispatch', controller.adminApproveFeatureRequestDispatch);");
  });
});

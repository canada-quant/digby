/**
 * Audit 2026-10-16 item 6 (todo 6df5fc61) — ADJUDICATED-CLASS ticket dedupe,
 * cross type/source. REPLAYS the live case (both rows read verbatim this run
 * via get_feedback):
 *   596718e7 (type mishap, source agent-harness, auto-filed at breaker trip)
 *   62f14ea6 (type general_feedback, source agent, Fleet Supervisor sighting)
 * shared an IDENTICAL normalized title ("3× tool-failure streak: todo_update
 * on \"DNS cutover llm.example.com → · Phase 3 remai\" — framework or model?") yet
 * existed as TWO rows and BOTH were lane-dispatched (6412da7d 01:03Z,
 * 6549170e 02:03Z) — the exact pass scoped candidates to {type,
 * source:'agent'} so the mishap AUTO-filing (agent-harness) and the agent
 * SIGHTING never matched. Both lanes independently adjudicated MODEL BEHAVIOR
 * / guards correct and closed with replay pins (PRs #1549/#1550).
 *
 * The fix: a NEW sighting whose normalized title matches a CLOSED,
 * ADJUDICATED agent-family row (any type, source agent or agent-harness,
 * adjudication recorded on the row) appends to that ticket — occurrences +
 * sighting + description trail, duplicateSuppressedBy marker, NO priority
 * escalation, NO dispatch, feedback_adjudicated_class_dedupe metric — instead
 * of filing a fresh row that re-fires a full lane dispatch. Baseline: 5
 * identical success-side wrong-tool adjudications (latest 304ff1bb, +500–1200
 * probe lines each).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(async (...a: any[]) => ({ id: 'fresh-1', ...a[0]?.data })), update: jest.fn(async (...a: any[]) => ({ id: a[0]?.where?.id ?? 'bumped' })), updateMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  releaseDispatchClaim: jest.fn(async () => ({})),
  drainUnderCapTickets: jest.fn(async () => 0),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {},
  asyncHandler: (fn: any) => fn,
  sendError: jest.fn(),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
}));
jest.mock('./incident-twin', () => ({
  __esModule: true,
  findIncidentTwin: jest.fn(async () => null),
  incidentTwinDedupeDisabled: () => true,
}));

import { fileFeedbackTicket } from './feedback.service';

// The live pair's SHARED title (verbatim from both rows).
const SHARED_TITLE = '3× tool-failure streak: todo_update on "DNS cutover llm.example.com → · Phase 3 remai" — framework or model?';
// 62f14ea6's adjudication adminNote (verbatim head — the model-behavior verdict).
const ADJUDICATED_NOTE = "ADJUDICATED + CLOSED (ticket lane 6549170e, dispatch 1 of 3): NO DETERMINISTIC FRAMEWORK DEFECT — MODEL BEHAVIOR, confirming the filer's (Fleet Supervisor's) recommendation.";

const adjudicatedRow = (over: Record<string, unknown> = {}) => ({
  id: '62f14ea6-2b60-45f4-b088-0757d97f03d9',
  title: SHARED_TITLE,
  type: 'general_feedback',
  source: 'agent',
  status: 'done',
  priority: 0,
  description: 'Sighting with investigation verdict: MODEL BEHAVIOR, no deterministic framework defect.',
  adminNote: ADJUDICATED_NOTE,
  context: { occurrences: 1, sightings: [{ sessionId: 'c0e22e36', filedAt: '2026-10-15T21:56:00.271Z' }] },
  createdAt: new Date('2026-10-15T21:56:00.365Z'),
  updatedAt: new Date('2026-10-16T04:08:40.341Z'),
  ...over,
});

/**
 * Query-shape-aware findMany stub: the filing path fires SEVERAL userFeatureRequest
 * queries (exact dedup, adjudicated dedup, closed-reopen, fuzzy, cross-source,
 * queue promote) — count-based mockResolvedValueOnce chains break whenever the
 * path order shifts. This stub answers by the where-clause SHAPE:
 *  - `source: { in: [...] }` (the new adjudicated pass) → `adjRows`
 *  - everything else → []
 */
function stubFindMany(adjRows: any[] = []) {
  mockPrisma.userFeatureRequest.findMany.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    if (w.source && typeof w.source === 'object' && Array.isArray(w.source.in)) return adjRows;
    return [];
  });
}

describe('adjudicated-class dedupe, cross type/source (audit 2026-10-16 6df5fc61)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED;
    stubFindMany();
  });

  it('a mishap AUTO-filing (agent-harness) whose title matches a CLOSED adjudicated general_feedback row MERGES into it — no new ticket, no priority escalation, no dispatch', async () => {
    // Pass 1 (exact, same-type): no open agent mishap rows → [].
    // Pass 2 (adjudicated, cross-type): the adjudicated 62f14ea6 row.
    // Pass 3 (closed same-type reopen): none (fail-open: this mock returns the
    // adjudicated row for the third query too if reached — the assertion is it
    // is NOT reached, see the update-args assertion below).
    stubFindMany([adjudicatedRow()]); // exact pass: [] (no open same-type rows); adjudicated pass: the 62f14ea6 row
    const res = await fileFeedbackTicket({
      userId: 'u1', type: 'mishap', title: SHARED_TITLE,
      description: 'Auto-filed at breaker trip: three todo_update refusals, streak weighted count.',
      priority: 3,
      context: { sessionId: '26be18cc', role: 'agent', filedAt: '2026-10-16T05:00:00Z', verifier: 'agent-derail-break' },
    });
    expect(res).toMatchObject({ deduped: true, ticket: { id: '62f14ea6-2b60-45f4-b088-0757d97f03d9' } });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();          // no fresh row
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where.id).toBe('62f14ea6-2b60-45f4-b088-0757d97f03d9');
    expect(upd.data.priority).toBeUndefined();                                    // NO escalation
    expect(upd.data.context.occurrences).toBe(2);                                 // bumped
    expect(upd.data.context.sightings.at(-1)).toMatchObject({ duplicateSuppressedBy: 'adjudicated-class' });
    expect(upd.data.description).toContain('adjudicated class — model behavior, guard correct; suppressed, no dispatch');
  });

  it('the adminNote verdict OR a stamped context.adjudicatedClass both count as adjudicated; an UNMARKED closed row never merges', async () => {
    const marked = adjudicatedRow({ adminNote: null, context: { adjudicatedClass: true, occurrences: 1 } });
    stubFindMany([marked]);
    const r1 = await fileFeedbackTicket({ userId: 'u1', type: 'mishap', title: SHARED_TITLE, description: 'd', context: { sessionId: 's' } });
    expect(r1).toMatchObject({ deduped: true });

    jest.clearAllMocks();
    const unmarked = adjudicatedRow({ adminNote: null, context: {} });
    stubFindMany([unmarked]); // adjudicated pass finds it but no verdict anywhere → falls through
    const r2 = await fileFeedbackTicket({ userId: 'u1', type: 'mishap', title: SHARED_TITLE, description: 'd', context: { sessionId: 's' } });
    // NOT merged by the adjudicated pass — falls through to normal filing.
    expect(r2).not.toMatchObject({ deduped: true });
  });

  it('user-filed rows and cross-source linked duplicates are never candidates', async () => {
    // DISTINCT ids so the assertions name exactly which row absorbed (or not):
    // a user row (query-excluded server-side; the stub bypasses the filter, so
    // the pin is the QUERY shape below) and a linked-duplicate record carrying
    // the adjudication marker but context.duplicateOf — never absorbed.
    const userRow = adjudicatedRow({ id: 'userrow-0001', source: 'user', adminNote: null, context: {} });
    const linkedDup = adjudicatedRow({ id: 'linkeddup-0002', context: { duplicateOf: '596718e7-1728-48f4-bacf-73c059097879', adjudicatedClass: true } });
    stubFindMany([userRow, linkedDup]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'mishap', title: SHARED_TITLE, description: 'd', context: { sessionId: 's' } });
    // The adjudicated QUERY only ever reads agent-family sources (never user rows)…
    const adjCall = mockPrisma.userFeatureRequest.findMany.mock.calls.find((c: any[]) => Array.isArray(c[0]?.where?.source?.in));
    expect(adjCall?.[0]?.where?.source?.in).toEqual(['agent', 'agent-harness']);
    // …and the linked-duplicate record (context.duplicateOf) is never absorbed either.
    expect(res).not.toMatchObject({ deduped: true, ticket: { id: 'linkeddup-0002' } });
    expect(mockPrisma.userFeatureRequest.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'linkeddup-0002' } }), expect.anything());
  });

  it('kill switch FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED=1 restores today\'s behavior (fresh row path)', async () => {
    process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED = '1';
    stubFindMany();
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'mishap', title: SHARED_TITLE, description: 'd', context: { sessionId: 's' } });
    expect(res).not.toMatchObject({ deduped: true });
    // No query used a source:{in:[...]} clause (the adjudicated pass was skipped entirely).
    const usedSourceIn = mockPrisma.userFeatureRequest.findMany.mock.calls.some((c: any[]) => c[0]?.where?.source && typeof c[0].where.source === 'object');
    expect(usedSourceIn).toBe(false);
  });

  it('fail-open: a pass failure never blocks the filing', async () => {
    mockPrisma.userFeatureRequest.findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (w.source && typeof w.source === 'object') throw new Error('db hiccup'); // the adjudicated pass dies
      return [];
    });
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'mishap', title: SHARED_TITLE, description: 'd', context: { sessionId: 's' } });
    expect(res).not.toMatchObject({ error: 'rate_limited' }); // filed normally (queued/open), not dropped
  });
});

/**
 * Ticket be06c812 (log-signal family lane 79bf7075, dispatch 1 of 3) — the
 * ADJUDICATED-CLASS SHORT-CIRCUIT in the reopen-on-recurrence pass.
 *
 * THE LIVE CASE (all four family members read verbatim this run via
 * get_feedback): the hourly log-signal-sweep files one bug_report per
 * fingerprint per ISO week with a STABLE title ("log-signal: <fingerprint>").
 * be06c812 ("invalid signature") is the FS-ACCEPTED baseline class (f132-close
 * 2026-10-14: steady post-rotation dead-token retries, re-open bars 24h rate
 * > 13,149 or a third spike IP — never re-adjudicate the baseline). Closing it
 * as adjudicated did NOT stick: the sweep's next same-type filing hit the
 * reopen-on-recurrence pass (which matches CLOSED same-type rows and runs
 * BEFORE the adjudicated-class dedupe pass) — the row flipped back to open,
 * priority escalated, the 30d dispatch claim released, drainOpenTicketsToLane
 * re-fired, and a fresh family lane was dispatched to re-adjudicate a class
 * another lane had already adjudicated. c4c96e1c ("invalid credentials",
 * public login 401s) is the same shape one week behind it.
 *
 * THE FIX: a closed same-type match that carries a RECORDED adjudication
 * verdict (context.adjudicatedClass or the adminNote wording — the SAME
 * predicate as the cross-type pass, isAdjudicatedTicketRow) counter-bumps in
 * the adjudicated absorption shape: occurrences + sighting + description
 * trail + duplicateSuppressedBy marker, NO status flip, NO priority
 * escalation, NO dispatch release. Unmarked closed rows keep the legacy
 * reopen behavior (fail-safe: adjudication is a deliberate act). Same kill
 * switch as the cross-type pass (FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED)
 * — the adjudication-dedupe feature reverts as one unit.
 *
 * DETECTOR-RECALL REPLAY: this file also REPLAYS the reopen pass's PRIOR true
 * positives — the exact shapes that made the reopen pass load-bearing — and
 * asserts they STILL fire (the short-circuit is scoped to recorded
 * adjudications only, never a blanket downgrade):
 *   R1 — a closed same-title ticket with NO adjudication verdict still REOPENS
 *        (occurrence trail, priority +1, claim release, drain fired).
 *   R2 — the ba65163d reopen-saturation cap (reopenCount >= 3) still
 *        counter-bumps WITHOUT a status flip at high occurrence counts.
 *   R3 — the 208ad03d fix-already-live gate still counter-bumps (no reopen)
 *        when the recorded fix is merged ∧ deployed — even on a row that
 *        carries NO adjudication verdict, the gate proves the fix live and
 *        the legacy reopen never fires.
 *   R4 — the re-open bar: an adjudicated row whose recorded bar (e.g. the
 *        f132 "re-open bar: 24h count > 13149") is CROSSED by the sighting's
 *        24h count is NOT absorbed — the verdict's own re-open condition
 *        fired, the legacy gates apply, and a breach metric is emitted.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(async (...a: any[]) => ({ id: 'fresh-1', ...a[0]?.data })), update: jest.fn(async (...a: any[]) => ({ id: a[0]?.where?.id ?? 'bumped' })), updateMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// The reopen path's dynamic-import boundary: the claim release + drain fire
// must NOT happen for an adjudicated absorption.
const mockDrainOpenTicketsToLane = jest.fn(async () => ({ result: 'sent', batched: 1 }));
const mockReleaseTicketDispatchClaim = jest.fn(async () => undefined);
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: (...a: any[]) => (mockDrainOpenTicketsToLane as any)(...a),
  dispatchTicketToLane: jest.fn(async () => 'sent'),
  releaseTicketDispatchClaim: (...a: any[]) => (mockReleaseTicketDispatchClaim as any)(...a),
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
// The 208ad03d fix-live gate's resolver — mocked so R3 proves the GATE's
// behavior (counter-bump, no reopen) without a live GitHub fetch; every
// other test takes the default not-live verdict (the fail-safe path).
const mockResolveTicketFixState = jest.fn(async (_row?: unknown, _opts?: unknown): Promise<{ fixLive: boolean; reason: string; evidence?: { commitSha?: string; deployRunId?: string } }> => ({ fixLive: false, reason: 'mock: no recorded fix evidence (the adminNote carries no [machine-close evidence] block)' }));
jest.mock('./fix-state', () => ({
  __esModule: true,
  resolveTicketFixState: (row: any, opts?: any) => mockResolveTicketFixState(row, opts),
}));

import { fileFeedbackTicket } from './feedback.service';
import { recordLoopMetric } from '../platform/loop-metrics.service';

// The live row's title (verbatim from get_feedback be06c812 this run): the
// sweep's stable per-fingerprint title.
const LOG_SIGNAL_TITLE = 'log-signal: invalid signature';

/** A closed same-type (bug_report) row in the sweep's filing shape. */
const closedLogSignalRow = (over: Record<string, unknown> = {}) => ({
  id: 'be06c812-f4d9-4f35-be7d-b082bdaef967',
  type: 'bug_report',
  title: LOG_SIGNAL_TITLE,
  status: 'done',
  priority: 2,
  source: 'agent',
  description: 'Fingerprint (normalized message): invalid signature\n\nRULE 1 — recurrence across 25 distinct hours (333 rows in 24 h).',
  adminNote: null,
  context: { sessionId: 'log-signal-sweep:43241fde0369af83', occurrences: 1, sightings: [{ sessionId: 'log-signal-sweep:43241fde0369af83' }] },
  createdAt: new Date('2026-10-16T23:04:13.715Z'),
  updatedAt: new Date('2026-10-18T01:05:56.358Z'),
  ...over,
});

/** Query-shape-aware findMany stub (6df5fc61 harness pattern): the reopen
 *  scan is the SECOND query (source:'agent' object + CLOSED statuses), the
 *  live exact pass the first; the cross-type adjudicated pass uses
 *  source:{in:[...]}. This stub hands the SAME row to whichever query runs. */
function stubReopenScan(rows: any[]) {
  mockPrisma.userFeatureRequest.findMany.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    if (w.source && typeof w.source === 'object' && Array.isArray(w.source.in)) return rows; // cross-type adjudicated pass
    if (w.status && typeof w.status === 'object' && Array.isArray(w.status.in) && w.status.in.every((s: string) => ['done', 'deployed_verified', 'resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix'].includes(s))) return rows; // closed scan (reopen pass)
    return []; // live exact pass / others
  });
}

const SWEEP_CONTEXT = { sessionId: 'log-signal-sweep:43241fde0369af83', surface: 'system', origin: 'log-signal-sweep', about: 'digby_platform', fingerprintHash: '43241fde0369af83', rule: 'rule1-hours', count: 318, week: '2026-W42', day: '2026-10-18' };

describe('adjudicated-class short-circuit in the reopen pass (ticket be06c812, log-signal family lane)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED;
  });

  it('a CLOSED adjudicated same-type row ABSORBS the sweep\'s next filing — no status flip, no priority escalation, no claim release, no drain', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED (ticket lane 79bf7075): FS-ACCEPTED BASELINE — model behavior, guards correct, no deterministic framework defect. Re-open only past the f132 bars.',
      context: { sessionId: 'log-signal-sweep:43241fde0369af83', occurrences: 1, adjudicatedClass: true, sightings: [{ sessionId: 'log-signal-sweep:43241fde0369af83' }] },
    })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'RULE 1 — 318 rows in 24 h.', priority: 2, context: SWEEP_CONTEXT });
    expect(res).toMatchObject({ deduped: true, ticket: { id: 'be06c812-f4d9-4f35-be7d-b082bdaef967' } });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled(); // no fresh row
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where.id).toBe('be06c812-f4d9-4f35-be7d-b082bdaef967');
    expect(upd.data.status).toBeUndefined();       // NO reopen
    expect(upd.data.priority).toBeUndefined();     // NO escalation
    expect(upd.data.context.occurrences).toBe(2);  // absorption bump
    expect(upd.data.context.sightings.at(-1)).toMatchObject({ duplicateSuppressedBy: 'adjudicated-class' });
    expect(upd.data.description).toContain('standing class sighting, NOT a reopen');
    // the dispatch machinery must stay silent — no claim release, no drain
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('an adminNote verdict alone (no context.adjudicatedClass stamp) also short-circuits — the predicate reads either form', async () => {
    stubReopenScan([closedLogSignalRow({
      id: 'c4c96e1c-c321-490b-af81-997b54ce1541',
      title: 'log-signal: invalid credentials',
      adminNote: 'ADJUDICATED + CLOSED: MODEL BEHAVIOR — public login 401s are designed observability; no framework defect.',
      context: { sessionId: 'log-signal-sweep:6978ba09bff51893', occurrences: 1, sightings: [] },
    })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: 'log-signal: invalid credentials', description: 'RULE 1 — 74 rows in 24 h.', priority: 2, context: { ...SWEEP_CONTEXT, fingerprintHash: '6978ba09bff51893' } });
    expect(res).toMatchObject({ deduped: true, ticket: { id: 'c4c96e1c-c321-490b-af81-997b54ce1541' } });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.context.occurrences).toBe(2);
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('records the feedback_adjudicated_class_dedupe metric with via=reopen-pass-short-circuit (the trail the audit reads)', async () => {
    stubReopenScan([closedLogSignalRow({ context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, sightings: [] } })]);
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', context: SWEEP_CONTEXT });
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'feedback_adjudicated_class_dedupe',
      meta: expect.objectContaining({ via: 'reopen-pass-short-circuit', ticketId: 'be06c812-f4d9-4f35-be7d-b082bdaef967' }),
    }));
  });

  it('DETECTOR-RECALL REPLAY R1 — an UNMARKED closed same-type row still REOPENS (the short-circuit is scoped to recorded adjudications only)', async () => {
    stubReopenScan([closedLogSignalRow({ adminNote: null, context: { sessionId: 's', occurrences: 4, sightings: [{ sessionId: 's' }] } })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 3, context: SWEEP_CONTEXT });
    expect(res).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
    expect(upd.data.priority).toBe(4); // escalated
    expect(upd.data.context.reopenCount).toBe(1);
    expect(upd.data.adminNote).toMatch(/Reopened automatically/);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockReleaseTicketDispatchClaim).toHaveBeenCalledWith('be06c812-f4d9-4f35-be7d-b082bdaef967');
    expect(mockDrainOpenTicketsToLane).toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY R2 — an unmarked closed row WITHOUT live-fix evidence still reopens even at high occurrence counts (the saturation cap REOPEN_SUPPRESS_AFTER=3 is unchanged)', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: null,
      context: { sessionId: 's', occurrences: 41, sightings: [{ sessionId: 's' }], reopenCount: 3 },
    })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: SWEEP_CONTEXT });
    expect(res).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    // the ba65163d saturation cap: reopenCount 3 ≥ 3 → counter-bump, NOT a reopen
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.context.reopenSuppressedCount).toBe(1);
    expect(upd.data.description).toContain('reopen SUPPRESSED');
  });

  it('DETECTOR-RECALL REPLAY R3 — the 208ad03d fix-already-live gate still counter-bumps (no reopen) when the recorded fix is merged ∧ deployed, even on an unadjudicated row', async () => {
    mockResolveTicketFixState.mockResolvedValueOnce({ fixLive: true, reason: 'merged 67ae36734 ∧ deploy 39058951684 concluded success', evidence: { commitSha: '67ae36734', deployRunId: '39058951684' } });
    stubReopenScan([closedLogSignalRow({
      adminNote: '[machine-close evidence] commitSha=67ae36734 deployRunId=39058951684 — fixed by PR #1619, deployed 2026-10-16T22:32:47Z.',
      context: { sessionId: 's', occurrences: 2, sightings: [{ sessionId: 's' }] },
    })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: SWEEP_CONTEXT });
    expect(res).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();  // no reopen
    expect(upd.data.adminNote).toMatch(/auto-close 208ad03d/);
    expect(upd.data.description).toContain('fix already live at sighting');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY R4 — a CROSSED re-open bar is NOT absorbed: the verdict\'s own re-open condition fired, legacy gates apply, breach metric emitted', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED: FS-ACCEPTED BASELINE (f132). Re-open bar: 24h count > 13149.',
      context: { sessionId: 's', occurrences: 3, adjudicatedClass: true, sightings: [] },
    })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'RULE 1 — 14,208 rows in 24 h.', priority: 2, context: { ...SWEEP_CONTEXT, count: 14208 } });
    expect(res).toMatchObject({ deduped: true });
    // NOT the absorption shape — the fall-through took a gate path
    const kinds = (recordLoopMetric as jest.Mock).mock.calls.map((c: any[]) => c[0]?.kind);
    expect(kinds).toContain('feedback_adjudicated_bar_breach');
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.description).not.toContain('standing class sighting, NOT a reopen');
    // with no handled markers and no fix evidence, the fall-through reaches the legacy reopen
    expect(upd.data.status).toBe('open');
    expect(upd.data.context.reopenCount).toBe(1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockDrainOpenTicketsToLane).toHaveBeenCalled();
  });

  // ── Bar spellings (adversarial review round 2): the first parser mis-read
  // every recorded spelling — "13,149" → 149 (false breach at steady state),
  // ticket-id digits ("the f127 bar"), dates, the learnings wording → null
  // (B1's permanent absorption). These pins hold the parser to the forms the
  // repo's durable record actually uses.
  it.each([
    ['comma-grouped thousands', 'Re-open bar: 24h count > 13,149', 13149],
    ['learnings.md f132 wording (rate arm)', 'Re-open adjudication ONLY if the 24h rate climbs past the f127 bar (13,149) or a third IP appears in a spike row', 13149],
    ['date token inside the phrase', 'Re-open bar (f132, 2026-10-14): 24h count > 13149', 13149],
    ['plural "bars"', 'Re-open bars 13,149/24h or a third spike IP', 13149],
    ['multi-line note', 'ADJUDICATED + CLOSED (f132):\nRe-open bar:\n24h count > 13149', 13149],
    ['space-grouped thousands', 'Re-open bar: 13 149 rows/24h', 13149],
  ])('re-open bar parses the "%s" spelling', async (_label, adminNote, expectedBar) => {
    stubReopenScan([closedLogSignalRow({ adminNote, context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, sightings: [] } })]);
    // a count UNDER the bar absorbs — proving the bar parsed as expectedBar
    // (if the bar mis-parsed LOW, e.g. 149, count 1000 would breach instead).
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: { ...SWEEP_CONTEXT, count: expectedBar - 1 } });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.description).toContain(`24h count=${expectedBar - 1} (re-open bar ${expectedBar})`);
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('ticket-id digits never parse as a bar ("the f127 bar" without a grouped number → no bar → absorb)', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED: re-open only past the f127 bar or a third IP.',
      context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, sightings: [] },
    })]);
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: { ...SWEEP_CONTEXT, count: 500 } });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined(); // absorbed: no bar parsed, count irrelevant
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  // ── Cross-family review B3: the first parser took the FIRST 4+-digit
  // number after "bar" — a PR cite ("see PR #1709") or build id in the
  // machine-close block parsed AS the bar (1709 → a 2,000-row day falsely
  // "breaches"; 20261018 → permanent silence). These pins hold the
  // comparator-anchored/last-candidate parser to the shapes that broke it.
  it('a PR cite between the phrase and the value never parses as the bar (B3: "see PR #1709 … > 13,149" reads 13149)', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED (f132). Re-open bar (see PR #1709 for context): 24h count > 13,149.',
      context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, sightings: [] },
    })]);
    // count 1708 would breach a mis-parsed 1709 bar — under the true bar 13149 it absorbs
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: { ...SWEEP_CONTEXT, count: 1708 } });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.description).toContain('24h count=1708 (re-open bar 13149)');
  });

  it('a build id never parses as the bar (B3: "build 20261018 > 13149 rows" reads 13149)', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED. Re-open bar: build 20261018 > 13149 rows.',
      context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, sightings: [] },
    })]);
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: { ...SWEEP_CONTEXT, count: 13150 } });
    const kinds = (recordLoopMetric as jest.Mock).mock.calls.map((c: any[]) => c[0]?.kind);
    expect(kinds).toContain('feedback_adjudicated_bar_breach'); // 13150 > the TRUE bar 13149
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
  });

  it('B4: a breach-triggered reopen PRESERVES the bar structurally (context.reopenBar survives the adminNote overwrite)', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED (f132). Re-open bar: 24h count > 13149.',
      context: { sessionId: 's', occurrences: 3, adjudicatedClass: true, sightings: [] },
    })]);
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: { ...SWEEP_CONTEXT, count: 15000 } });
    // the breach stamps reopenBar onto the row context; the fall-through reopen spreads it
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
    expect(upd.data.context.reopenBar).toBe(13149);
  });

  it('B2: absorption stamps the structural forms (adjudicatedClass + the enforced reopenBar) onto the row context', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED (f132): model behavior, guards correct. Re-open bar: 24h count > 13149.',
      context: { sessionId: 's', occurrences: 1, sightings: [] }, // NO structural stamp yet
    })]);
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: { ...SWEEP_CONTEXT, count: 318 } });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.context.adjudicatedClass).toBe(true);   // stamped by the absorption itself
    expect(upd.data.context.reopenBar).toBe(13149);          // the bar it enforced
  });

  it('a STRUCTURAL bar (context.reopenBar) wins over prose and needs no phrase at all', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED (f132): standing class, guards correct.',
      context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, reopenBar: 13149, sightings: [] },
    })]);
    // count 13150 > 13149 → breach → legacy reopen
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: { ...SWEEP_CONTEXT, count: 13150 } });
    const kinds = (recordLoopMetric as jest.Mock).mock.calls.map((c: any[]) => c[0]?.kind);
    expect(kinds).toContain('feedback_adjudicated_bar_breach');
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
  });

  it('an UNDER-bar sighting on a bar-recorded adjudicated row still absorbs (the bar is the only breach condition)', async () => {
    stubReopenScan([closedLogSignalRow({
      adminNote: 'ADJUDICATED + CLOSED: FS-ACCEPTED BASELINE (f132). Re-open bar: 24h count > 13149.',
      context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, sightings: [] },
    })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'RULE 1 — 318 rows in 24 h.', priority: 2, context: { ...SWEEP_CONTEXT, count: 318 } });
    expect(res).toMatchObject({ deduped: true, ticket: { id: 'be06c812-f4d9-4f35-be7d-b082bdaef967' } });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.context.sightings.at(-1)).toMatchObject({ count: 318, duplicateSuppressedBy: 'adjudicated-class' });
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('a deliveredRedacted sighting on an adjudicated row keeps its provenance marker in the absorption trail (adversarial review B2)', async () => {
    stubReopenScan([closedLogSignalRow({ context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, sightings: [] } })]);
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: { ...SWEEP_CONTEXT, deliveredRedacted: true, containedPreDelivery: true } });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.context.sightings.at(-1)).toMatchObject({ deliveredRedacted: true, containedPreDelivery: true, duplicateSuppressedBy: 'adjudicated-class' });
  });

  // ── NEGATION-BLIND (cross-family review B1): the old predicate matched
  // "model behavior" ANYWHERE — including the CONFIRMED-DEFECT closure shape
  // "FRAMEWORK DEFECT (not model behavior)". 24 of 139 prod rows matching the
  // old predicate were negation-shaped; absorbing those silently kills a real
  // recurrence signal forever. These pins hold the predicate negation-aware.
  it.each([
    ['FRAMEWORK DEFECT parenthetical', 'FRAMEWORK DEFECT (not model behavior) — fixed, merged, deployed, verified live'],
    ['deterministic bug, NOT model behavior', 'deterministic framework bug — NOT model behavior, reopened and re-fixed under PR #1619'],
    ['defect, not model behavior (lowercase)', 'deterministic FRAMEWORK defect, not model behavior'],
    ['never model behavior', 'This was never model behavior: a real defect in the retry path'],
  ])('DETECTOR-RECALL REPLAY (B1) — a "%s" note is NOT adjudicated: it REOPENS (a real defect\'s recurrence must never be absorbed)', async (_label, adminNote) => {
    stubReopenScan([closedLogSignalRow({ adminNote, context: { sessionId: 's', occurrences: 1, sightings: [] } })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: SWEEP_CONTEXT });
    expect(res).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open'); // the legacy reopen — NOT absorbed
    expect(upd.data.context.reopenCount).toBe(1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockReleaseTicketDispatchClaim).toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY (B1 counter-pin) — a POSITIVE verdict phrase still absorbs (the negation guard must not over-suppress)', async () => {
    stubReopenScan([closedLogSignalRow({ adminNote: 'ADJUDICATED + CLOSED: model behavior, guards fired correct; no deterministic framework defect.', context: { sessionId: 's', occurrences: 1, sightings: [] } })]);
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: SWEEP_CONTEXT });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined(); // absorbed
    expect(upd.data.context.occurrences).toBe(2);
  });

  it('kill switch FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED=1 restores the legacy reopen for an adjudicated row (the feature reverts as one unit)', async () => {
    process.env.FEEDBACK_ADJUDICATED_CLASS_DEDUPE_DISABLED = '1';
    stubReopenScan([closedLogSignalRow({ adminNote: 'ADJUDICATED: model behavior, no framework defect.', context: { sessionId: 's', occurrences: 1, adjudicatedClass: true, sightings: [] } })]);
    const res = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: LOG_SIGNAL_TITLE, description: 'd', priority: 2, context: SWEEP_CONTEXT });
    expect(res).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open'); // legacy reopen is back
    expect(upd.data.context.reopenCount).toBe(1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockReleaseTicketDispatchClaim).toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).toHaveBeenCalled();
  });
});

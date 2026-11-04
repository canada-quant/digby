/**
 * Replay for ticket 208ad03d (type=mishap) — "Re-opened tickets re-dispatched
 * without checking whether the fix already merged".
 *
 * THE MISHAP (2026-09-18, ticket 5ba5f03e): a new sighting matched the
 * recently-CLOSED ticket and the reopen-on-recurrence path flipped it back to
 * open and re-dispatched it at 21:48Z — even though its fix had ALREADY
 * merged ~2h earlier (PR #859, mergeCommit a471ce03, mergedAt 19:48:40Z) and
 * its deploy wave had concluded success at 21:02Z. The re-dispatch burned a
 * full lane run re-fixing already-live work.
 *
 * THE FIX (this ticket): a fix-already-live gate in the reopen path of
 * feedback.service.ts — after the handled-marker suppression, before the
 * reopen-saturation cap — asks fix-state.ts's resolveTicketFixState whether
 * the ticket's RECORDED closure evidence (the adminNote's machine-close audit
 * note) is verified merged to origin/main AND deployed. fixLive=true ⇒
 * counter-bump in the handled-marker shape (occurrences/sightings/lastSeen +
 * the sighting logged with the fix-live marker + the auto-close rationale in
 * the adminNote): NO status flip, NO priority escalation, NO dispatch
 * release. Anything else (not merged, no evidence, resolver error/throw) ⇒
 * the legacy reopen, byte-equivalent.
 *
 * Test layers: (1) the GATE through the real fileFeedbackTicket with
 * fix-state mocked for determinism (mock discipline mirrors
 * feedback.service.test.ts: logger + config/database + ticket-dispatch +
 * error-handler); (2) the REAL fix-state resolver + its adminNote parser
 * (jest.requireActual) with prisma/token-manager mocked and fetchImpl
 * injected — no network anywhere.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
  loopMetric: { findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// The burn-down drain hook dynamically imports ticket-dispatch.service, which
// pulls config/redis → config/env (process.exit without env vars) — mock the
// boundary (feedback.service.test.ts's exact shape).
const mockDrainOpenTicketsToLane = jest.fn(async () => ({ result: 'sent', batched: 1 }));
const mockReleaseTicketDispatchClaim = jest.fn(async () => undefined);
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: (...a: any[]) => (mockDrainOpenTicketsToLane as any)(...a),
  dispatchTicketToLane: jest.fn(async () => 'sent'),
  releaseTicketDispatchClaim: (...a: any[]) => (mockReleaseTicketDispatchClaim as any)(...a),
}));

// error-handler imports config/env, which calls process.exit(1) without env
// vars and kills the whole jest worker at import time — mock AppError (same
// shape as feedback.service.test.ts).
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

// The gate's resolver — mocked for gate determinism. The REAL module is
// exercised below via jest.requireActual (its own deps stay mocked).
const mockResolveTicketFixState = jest.fn();
jest.mock('./fix-state', () => ({
  __esModule: true,
  resolveTicketFixState: (...a: any[]) => (mockResolveTicketFixState as any)(...a),
}));

const mockGetValidToken = jest.fn();
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: mockGetValidToken }));

import { fileFeedbackTicket } from './feedback.service';

const realFixState = jest.requireActual('./fix-state') as typeof import('./fix-state');

const TICKET_208AD03D = '208ad03d'; // the id this replay pins — kept verbatim for the verified-close replayTestPath cite

// The incident fixture, shaped like 5ba5f03e's closure row: a verified
// machine-close adminNote carrying the merge commit + PR + deploy run id.
const INCIDENT_TICKET_ID = '5ba5f03e-208a-d03d-9e00-208ad03d5ba5';
const FIX_SHA = 'a471ce03f00df00df00df00df00df00df00df00d'; // PR #859's mergeCommit (40 hex)
const DEPLOY_RUN = '17894561234';
const INCIDENT_TITLE = 'Supervisor claims verification without fresh tool evidence';
const INCIDENT_ADMIN_NOTE =
  'Fixed per PR #859; deploy watched green.\n' +
  `[machine-close evidence: replay test backend/src/modules/crossmodel/feedback/reopen-fix-live-gate.${TICKET_208AD03D}.test.ts (verified: exists + cites 5ba5f03e); ` +
  `commit ${FIX_SHA} (format-verified; existence not checkable server-side — no repo checkout in this process); ` +
  `PR https://github.com/canada-quant/digby/pull/859; deploy run ${DEPLOY_RUN}]`;

const incidentRow = (over: Record<string, unknown> = {}) => ({
  id: INCIDENT_TICKET_ID,
  type: 'mishap',
  title: INCIDENT_TITLE,
  status: 'done',
  priority: 4,
  source: 'agent',
  description: 'Original report.\n\nFixed in PR #859.',
  adminNote: INCIDENT_ADMIN_NOTE,
  context: { sessionId: 'sess-0', occurrences: 3, sightings: [{ sessionId: 'sess-0' }] },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const FILING = {
  userId: 'u1',
  type: 'mishap',
  title: INCIDENT_TITLE,
  description: 'Sighted again: a final cited a merge with no fresh ls-remote.',
  priority: 3,
  context: { sessionId: 'sess-1', surface: 'chat', filedAt: '2026-09-18T21:48:00.000Z' },
};

/** The three reopen-path scans for a MISHAP filing (586ebe71: the class-keyed
 * pass runs between the exact pass and the reopen scan): live exact pass
 * empty, class pass empty, closed pass carries the incident row. */
const mockScans = (row: any) => {
  mockPrisma.userFeatureRequest.findMany
    .mockResolvedValueOnce([]) // live exact pass — nothing open
    .mockResolvedValueOnce([]) // class-keyed mishap pass — no same-class row
    .mockResolvedValueOnce(row ? [row] : []); // reopen scan — the closed same-title ticket
};

const flushMicrotasks = async () => {
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
};

beforeEach(() => jest.clearAllMocks());

describe('ticket 208ad03d — the fix-already-live gate in the reopen path', () => {
  it('REPLAY of the 5ba5f03e mishap: a sighting on a done ticket whose fix is verified LIVE counter-bumps WITHOUT reopening — no status flip, no priority escalation, no dispatch release', async () => {
    mockScans(incidentRow());
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: INCIDENT_TICKET_ID, status: 'done' });
    mockResolveTicketFixState.mockResolvedValue({
      fixLive: true,
      reason: `commit ${FIX_SHA} is an ancestor of origin/main (compare status ahead); deploy run ${DEPLOY_RUN} concluded success`,
      evidence: { commitSha: FIX_SHA, deployRunId: DEPLOY_RUN },
    });

    const r = await fileFeedbackTicket({ ...FILING });
    expect(r).toMatchObject({ deduped: true });
    expect(mockPrisma.userFeatureRequest.create).not.toHaveBeenCalled();
    // The resolver was consulted on the closed row, and ONLY it decided.
    expect(mockResolveTicketFixState).toHaveBeenCalledTimes(1);
    expect(String((mockResolveTicketFixState.mock.calls[0][0] as any).id)).toBe(INCIDENT_TICKET_ID);

    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: INCIDENT_TICKET_ID });
    expect(upd.data.status).toBeUndefined();    // NO flip to open — the ticket STAYS done
    expect(upd.data.priority).toBeUndefined();  // NO escalation
    expect(upd.data.context.occurrences).toBe(4); // the trail accrues
    expect(typeof upd.data.context.lastSeen).toBe('string');
    // …the sighting is logged with the fix-live marker…
    expect(upd.data.context.sightings).toHaveLength(2);
    expect(upd.data.context.sightings[1]).toMatchObject({ sessionId: 'sess-1', fixAlreadyLive: true });
    expect(upd.data.context.reopenCount).toBeUndefined(); // NOT a reopen — no counter move
    expect(upd.data.description).toContain(`sighting 4 (fix already live at sighting — merged ${FIX_SHA}, deploy ${DEPLOY_RUN}; NOT a reopen)`);
    expect(upd.data.description).toContain('Fixed in PR #859'); // history kept
    // …and the adminNote keeps the prior machine-close evidence AND the auto-close rationale.
    expect(upd.data.adminNote).toContain('[machine-close evidence:');
    expect(upd.data.adminNote).toContain(`[auto-close ${TICKET_208AD03D}`);
    expect(upd.data.adminNote).toContain('NOT reopened');
    expect(upd.data.adminNote).toContain('concluded success');
    // CRUCIALLY: no dispatch-claim release, no drain — the lane is never burned.
    await flushMicrotasks();
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
    expect(mockDrainOpenTicketsToLane).not.toHaveBeenCalled();
  });

  it('the gate fires BEFORE the reopen-saturation cap: a fix-live sighting on a saturated ticket takes the 208ad03d path, not the ba65163d suppression', async () => {
    mockScans(incidentRow({ context: { sessionId: 'sess-0', occurrences: 41, sightings: [{ sessionId: 'sess-0' }], reopenCount: 3 } }));
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: INCIDENT_TICKET_ID, status: 'done' });
    mockResolveTicketFixState.mockResolvedValue({
      fixLive: true, reason: 'merged + deployed', evidence: { commitSha: FIX_SHA, deployRunId: DEPLOY_RUN },
    });

    await fileFeedbackTicket({ ...FILING });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.context.sightings[1]).toMatchObject({ fixAlreadyLive: true });
    expect(upd.data.context.sightings[1].reopenSuppressed).toBeUndefined(); // the cap path did not run
    expect(upd.data.context.reopenSuppressedCount).toBeUndefined();
    expect(upd.data.description).toContain('fix already live at sighting');
    await flushMicrotasks();
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
  });

  it('the handled-marker suppression keeps precedence: a delivered-redacted sighting never consults the resolver', async () => {
    mockScans(incidentRow());
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: INCIDENT_TICKET_ID, status: 'done' });

    await fileFeedbackTicket({ ...FILING, context: { ...FILING.context, deliveredRedacted: true } });
    expect(mockResolveTicketFixState).not.toHaveBeenCalled();
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBeUndefined();
    expect(upd.data.description).toContain('delivered redacted — handled by strip+mark; NOT a reopen');
    await flushMicrotasks();
    expect(mockReleaseTicketDispatchClaim).not.toHaveBeenCalled();
  });

  it('resolver says fixLive=false (the fix is NOT merged) → the LEGACY reopen: status open, priority +1, reopenCount 1, claim released, drain fired', async () => {
    mockScans(incidentRow());
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: INCIDENT_TICKET_ID, status: 'open' });
    mockResolveTicketFixState.mockResolvedValue({
      fixLive: false,
      reason: `commit ${FIX_SHA} is NOT merged to origin/main (compare status behind — an unmerged descendant of main)`,
      evidence: { commitSha: FIX_SHA },
    });

    const r = await fileFeedbackTicket({ ...FILING });
    expect(r).toMatchObject({ deduped: true });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
    expect(upd.data.priority).toBe(5); // max(4,3)+1 — the legacy escalation, capped
    expect(upd.data.context.occurrences).toBe(4);
    expect(upd.data.context.reopenCount).toBe(1);
    expect(upd.data.adminNote).toMatch(/Reopened automatically/);
    expect(upd.data.description).toContain('recurrence AFTER closure — the fix did not hold');
    await flushMicrotasks();
    expect(mockReleaseTicketDispatchClaim).toHaveBeenCalledWith(INCIDENT_TICKET_ID);
    expect(mockDrainOpenTicketsToLane).toHaveBeenCalled();
  });

  it('resolver THROWS → fail-safe to the LEGACY reopen (an errored check never suppresses a reopen)', async () => {
    mockScans(incidentRow());
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: INCIDENT_TICKET_ID, status: 'open' });
    mockResolveTicketFixState.mockRejectedValue(new Error('resolver blew up'));

    await fileFeedbackTicket({ ...FILING });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
    expect(upd.data.context.reopenCount).toBe(1);
    expect(upd.data.adminNote).toMatch(/Reopened automatically/);
    await flushMicrotasks();
    expect(mockReleaseTicketDispatchClaim).toHaveBeenCalledWith(INCIDENT_TICKET_ID);
    expect(mockDrainOpenTicketsToLane).toHaveBeenCalled();
  });

  it('no recorded fix evidence on the row (adminNote null — e.g. a human close) → the resolver reports no-evidence and the LEGACY reopen applies', async () => {
    mockScans(incidentRow({ adminNote: null }));
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: INCIDENT_TICKET_ID, status: 'open' });
    // What the REAL resolver returns for such a row (pinned in the resolver
    // suite below) — the mock replays the contract.
    mockResolveTicketFixState.mockResolvedValue({
      fixLive: false,
      reason: 'no recorded fix evidence (the adminNote carries no [machine-close evidence] block)',
    });

    await fileFeedbackTicket({ ...FILING });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
    expect(upd.data.context.reopenCount).toBe(1);
    await flushMicrotasks();
    expect(mockReleaseTicketDispatchClaim).toHaveBeenCalledWith(INCIDENT_TICKET_ID);
  });
});

// TICKET-LANE ARCHIVE GAPS B2b (2026-10-21): a recurrence reopen drops the
// first close's lane-archive stamp — inherited, it made the dispatch drain
// skip the NEXT lane's archive forever (no test covered it).
describe('recurrence reopen — the lane-archive stamp is not inherited (TICKET-LANE ARCHIVE GAPS B2b)', () => {
  const ENV = { ...process.env };
  afterEach(() => { process.env = { ...ENV }; });
  const laneCtx = {
    sessionId: 'sess-0', occurrences: 3, sightings: [{ sessionId: 'sess-0' }],
    dispatchMode: 'ticket_lane', dispatchedTo: 'lane-first-0000', laneDispatches: 1,
    laneArchivedAt: '2026-10-20T10:00:00.000Z', laneArchivedLane: 'lane-first-0000',
  };

  it('the reopen write strips laneArchivedAt + laneArchivedLane and keeps every other context key', async () => {
    delete process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED;
    mockScans(incidentRow({ context: { ...laneCtx } }));
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: INCIDENT_TICKET_ID, status: 'open' });
    mockResolveTicketFixState.mockResolvedValue({ fixLive: false, reason: 'no recorded fix evidence' });
    await fileFeedbackTicket({ ...FILING });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.status).toBe('open');
    expect(upd.data.context).not.toHaveProperty('laneArchivedAt');
    expect(upd.data.context).not.toHaveProperty('laneArchivedLane');
    expect(upd.data.context).toMatchObject({ dispatchMode: 'ticket_lane', dispatchedTo: 'lane-first-0000', laneDispatches: 1, reopenCount: 1, occurrences: 4 });
  });

  it('KILL SWITCH TICKET_LANE_ARCHIVE_GAPS_DISABLED=1: the reopen keeps the stamp (pre-fix)', async () => {
    process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = '1';
    mockScans(incidentRow({ context: { ...laneCtx } }));
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ id: INCIDENT_TICKET_ID, status: 'open' });
    mockResolveTicketFixState.mockResolvedValue({ fixLive: false, reason: 'no recorded fix evidence' });
    await fileFeedbackTicket({ ...FILING });
    const upd = mockPrisma.userFeatureRequest.update.mock.calls[0][0];
    expect(upd.data.context).toMatchObject({ laneArchivedAt: laneCtx.laneArchivedAt, laneArchivedLane: laneCtx.laneArchivedLane, reopenCount: 1 });
  });
});

describe('fix-state.ts — parseClosureEvidenceNote (the REAL parser)', () => {
  const { parseClosureEvidenceNote } = realFixState;

  it('parses a present machine-close block: commit sha (lowercased), PR url, deploy run id', () => {
    const note = parseClosureEvidenceNote(INCIDENT_ADMIN_NOTE);
    expect(note).toEqual({
      commitSha: FIX_SHA,
      prUrl: 'https://github.com/canada-quant/digby/pull/859',
      deployRunId: DEPLOY_RUN,
    });
  });

  it('a reopened-then-reclosed ticket accrues one block per close — the LAST block wins (it describes the CURRENT closure)', () => {
    const older = '[machine-close evidence: commit 0000000deadbeef0000000deadbeef00000000 (format-verified; …); deploy run 11111]';
    const newer = '[machine-close evidence: commit a471ce03aaaaaaaabbbbbbbbccccccccdddddddd (format-verified; …); deploy run 22222]';
    const note = parseClosureEvidenceNote(`triage note\n${older}\nmore prose\n${newer}`);
    expect(note).toEqual({ commitSha: 'a471ce03aaaaaaaabbbbbbbbccccccccdddddddd', deployRunId: '22222' });
  });

  it('malformed evidence (a replay-test-only close — no commit member) parses with NO commitSha', () => {
    const note = parseClosureEvidenceNote('fixed it\n[machine-close evidence: replay test backend/x.5ba5f03e.test.ts (verified: exists + cites 5ba5f03e)]');
    expect(note).toEqual({});
    expect(note?.commitSha).toBeUndefined();
  });

  it('absent evidence: null / undefined / plain-prose adminNotes parse to null', () => {
    expect(parseClosureEvidenceNote(null)).toBeNull();
    expect(parseClosureEvidenceNote(undefined)).toBeNull();
    expect(parseClosureEvidenceNote('Closed by the owner after verifying in prod.')).toBeNull();
  });

  it('a malformed sha (non-hex / wrong length) is NOT picked up — garbage never gates a reopen', () => {
    expect(parseClosureEvidenceNote('[machine-close evidence: commit zzz123 (…); deploy run 999]')?.commitSha).toBeUndefined();
    expect(parseClosureEvidenceNote('[machine-close evidence: commit abc (…)]')?.commitSha).toBeUndefined(); // < 7 hex
  });
});

describe('fix-state.ts — resolveTicketFixState (the REAL resolver, seams stubbed)', () => {
  const { resolveTicketFixState } = realFixState;
  const OWNER = 'user-5ba5f03e';
  const ROW = { id: INCIDENT_TICKET_ID, adminNote: INCIDENT_ADMIN_NOTE, userId: OWNER };

  /** Route-based GitHub stub: match on a URL fragment → canned status/body. */
  const ghFetch = (routes: Record<string, { status?: number; body?: any }>) =>
    jest.fn(async (url: any) => {
      for (const [frag, r] of Object.entries(routes)) {
        if (String(url).includes(frag)) {
          const status = r.status ?? 200;
          return { status, ok: status >= 200 && status < 300, json: async () => r.body ?? null };
        }
      }
      return { status: 404, ok: false, json: async () => ({}) };
    }) as any;

  beforeEach(() => {
    mockGetValidToken.mockResolvedValue('gh-token-208ad03d');
    mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  });

  it('fixLive=true when the recorded commit is an ancestor of main AND the recorded deploy run concluded success — the 5ba5f03e close, verified', async () => {
    const fetchImpl = ghFetch({
      [`/compare/${FIX_SHA}...main`]: { body: { status: 'ahead', ahead_by: 3, behind_by: 0 } },
      [`/actions/runs/${DEPLOY_RUN}`]: { body: { status: 'completed', conclusion: 'success' } },
    });
    const s = await resolveTicketFixState(ROW, { fetchImpl });
    expect(s.fixLive).toBe(true);
    expect(s.reason).toContain('ancestor of origin/main');
    expect(s.reason).toContain(`deploy run ${DEPLOY_RUN} concluded success`);
    expect(s.evidence).toEqual({ commitSha: FIX_SHA, deployRunId: DEPLOY_RUN });
    expect(mockGetValidToken).toHaveBeenCalledWith(OWNER);
    // The compare call rode the ticket owner's token.
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`/compare/${FIX_SHA}...main`);
    expect((fetchImpl.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer gh-token-208ad03d');
  });

  it('fixLive=false when the commit is NOT merged (compare diverged) — the deploy question is never asked', async () => {
    const fetchImpl = ghFetch({ [`/compare/${FIX_SHA}...main`]: { body: { status: 'diverged' } } });
    const s = await resolveTicketFixState(ROW, { fetchImpl });
    expect(s.fixLive).toBe(false);
    expect(s.reason).toContain('NOT merged');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no actions/runs, no commits/main, no telemetry read
    expect(mockPrisma.loopMetric.findMany).not.toHaveBeenCalled();
  });

  it("compare status 'behind' (unmerged descendant) ⇒ fix not live", async () => {
    // base=sha head=main: 'behind' = the sha has commits main lacks — an
    // UNMERGED DESCENDANT of main, NOT an ancestor (the pre-fix acceptance
    // set had this inverted and would have called it merged).
    const fetchImpl = ghFetch({ [`/compare/${FIX_SHA}...main`]: { body: { status: 'behind', ahead_by: 0, behind_by: 3 } } });
    const s = await resolveTicketFixState(ROW, { fetchImpl });
    expect(s.fixLive).toBe(false);
    expect(s.reason).toContain('NOT merged');
    expect(s.reason).toContain('behind');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the deploy question is never asked
    expect(mockPrisma.loopMetric.findMany).not.toHaveBeenCalled();
  });

  it('fixLive=false when the commit is unknown to the repo (compare 404)', async () => {
    const fetchImpl = ghFetch({ [`/compare/${FIX_SHA}...main`]: { status: 404, body: {} } });
    const s = await resolveTicketFixState(ROW, { fetchImpl });
    expect(s.fixLive).toBe(false);
    expect(s.reason).toContain('not in the repo');
  });

  it('fixLive=false when the fix merged but the recorded deploy run FAILED and telemetry shows nothing live', async () => {
    const fetchImpl = ghFetch({
      [`/compare/${FIX_SHA}...main`]: { body: { status: 'ahead' } },
      [`/actions/runs/${DEPLOY_RUN}`]: { body: { status: 'completed', conclusion: 'failure' } },
      ['/commits/main']: { body: { sha: 'c0ffee42c0ffee42c0ffee42c0ffee42c0ffee42' } },
    });
    const s = await resolveTicketFixState(ROW, { fetchImpl });
    expect(s.fixLive).toBe(false);
    expect(s.reason).toContain('ancestor of origin/main'); // merged — but…
    expect(s.reason).toContain('completed/failure');          // …not deployed
  });

  it('fixLive=true via TELEMETRY exact-sha: no deploy run recorded, but a box_health row shows a box running the fix sha', async () => {
    const rowNoRun = { ...ROW, adminNote: INCIDENT_ADMIN_NOTE.replace(`; deploy run ${DEPLOY_RUN}`, '') };
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date(), meta: { host: 'box-a', process: 'web', sha: FIX_SHA.slice(0, 8), diskPct: 40 } },
    ]);
    const fetchImpl = ghFetch({ [`/compare/${FIX_SHA}...main`]: { body: { status: 'ahead' } } });
    const s = await resolveTicketFixState(rowNoRun, { fetchImpl });
    expect(s.fixLive).toBe(true);
    expect(s.reason).toContain('box_health telemetry shows a box running the fix sha');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // compare only — the exact-sha hit never asks for main head
  });

  it('fixLive=true via TELEMETRY descendant wave: boxes run origin/main head, which carries the (already-proven-merged) fix', async () => {
    const rowNoRun = { ...ROW, adminNote: INCIDENT_ADMIN_NOTE.replace(`; deploy run ${DEPLOY_RUN}`, '') };
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date(), meta: { host: 'box-a', process: 'web', sha: 'c0ffee42', diskPct: 40 } },
    ]);
    const fetchImpl = ghFetch({
      [`/compare/${FIX_SHA}...main`]: { body: { status: 'ahead' } },
      ['/commits/main']: { body: { sha: 'c0ffee42abcdefabcdefabcdefabcdefabcdefab' } },
    });
    const s = await resolveTicketFixState(rowNoRun, { fetchImpl });
    expect(s.fixLive).toBe(true);
    expect(s.reason).toContain('descendant wave');
  });

  it('fixLive=false with NO recorded evidence / NO commitSha / NO token — the fail-safe trio', async () => {
    expect((await resolveTicketFixState({ ...ROW, adminNote: null }, { fetchImpl: jest.fn() })).fixLive).toBe(false);
    const noSha = await resolveTicketFixState(
      { ...ROW, adminNote: '[machine-close evidence: replay test backend/x.5ba5f03e.test.ts (verified: exists + cites 5ba5f03e)]' },
      { fetchImpl: jest.fn() },
    );
    expect(noSha.fixLive).toBe(false);
    expect(noSha.reason).toContain('no recorded fix commitSha');
    mockGetValidToken.mockResolvedValue(null);
    const noToken = await resolveTicketFixState(ROW, { fetchImpl: jest.fn() });
    expect(noToken.fixLive).toBe(false);
    expect(noToken.reason).toContain('no connected GitHub token');
  });

  it('fixLive=false on network failure — and the resolver NEVER throws (the module-level fail-safe belt)', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('socket hangup'); }) as any;
    const s = await resolveTicketFixState(ROW, { fetchImpl });
    expect(s.fixLive).toBe(false);
    expect(s.reason).toContain('merge check errored');
    // Even a prisma telemetry outage degrades cleanly.
    mockPrisma.loopMetric.findMany.mockRejectedValue(new Error('db down'));
    const fetchOk = ghFetch({
      [`/compare/${FIX_SHA}...main`]: { body: { status: 'ahead' } },
      [`/actions/runs/${DEPLOY_RUN}`]: { body: { status: 'completed', conclusion: 'success' } },
    });
    await expect(resolveTicketFixState(ROW, { fetchImpl: fetchOk })).resolves.toMatchObject({ fixLive: true }); // green run id short-circuits before telemetry
  });
});

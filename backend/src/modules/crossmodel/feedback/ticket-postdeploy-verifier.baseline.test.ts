/**
 * ACCEPTANCE-METRIC-BASELINE (2026-10-20) — the verifier half. A metric that
 * cannot FAIL (it already passes on its pre-fix window, its messagePattern is
 * regex syntax matched literally, or the closing lane waived an auto-filer
 * default) never reaches deployed_verified and never reopens: once the fix is
 * live the ticket closes as plain 'done' (verdict done_vacuous). Pins each
 * vacuity source, the non-vacuous stamp-once path and the kill switch.
 */
import { verifyTicketRow } from './ticket-postdeploy-verifier.service';

const updateMock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userFeatureRequest: { findMany: jest.fn(), update: (...a: unknown[]) => updateMock(...a), count: jest.fn(async () => 0) },
    loopMetric: { count: jest.fn() },
    appErrorLog: { count: jest.fn() },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('./fix-state', () => ({
  parseClosureEvidenceNote: jest.fn(() => ({ commitSha: 'abc123def4567890abc123def4567890abcd1234' })),
  resolveFixStateFromEvidence: jest.fn(),
}));
import { parseClosureEvidenceNote, resolveFixStateFromEvidence } from './fix-state';
jest.mock('./ticket-dispatch.service', () => ({ __esModule: true, releaseTicketDispatchClaim: jest.fn(async () => undefined) }));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: unknown[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { TICKET_POSTDEPLOY_VERIFIER: 'ticket_postdeploy_verifier', ACCEPTANCE_METRIC_BASELINE: 'acceptance_metric_baseline' },
}));

const METRIC = { probe: 'app_error_log_count', params: { level: 'error', messagePattern: 'P2025' }, operator: '<=', target: 0, windowHours: 24 };
const NOW = new Date('2026-10-20T12:00:00Z');
const FILED = new Date('2026-10-19T09:00:00Z');
const ANCHORED_25H_AGO = new Date(NOW.getTime() - 25 * 3600_000).toISOString();
const appErrorCount = () => require('../../../config/database').default.appErrorLog.count as jest.Mock;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555', type: 'bug_report', status: 'awaiting_verification', priority: 3,
    adminNote: '[machine-close evidence: commit abc123def4567890abc123def4567890abcd1234]', userId: null,
    context: { acceptanceMetric: METRIC }, createdAt: FILED, ...overrides,
  };
}
const ENV = { ...process.env };
beforeEach(() => {
  updateMock.mockReset().mockResolvedValue({});
  appErrorCount().mockReset();
  mockRecordLoopMetric.mockReset();
  (resolveFixStateFromEvidence as jest.Mock).mockResolvedValue({ fixLive: true, reason: 'commit abc1234 is an ancestor of origin/main ∧ deploy green' });
  process.env = { ...ENV };
  delete process.env.ACCEPTANCE_BASELINE_GATE_DISABLED;
});
afterAll(() => { process.env = ENV; });

describe('vacuous metrics close on the merged ∧ deployed bar', () => {
  it('a stored regex-shaped pattern (the prod "a|b" shape) → done, never deployed_verified, no DB count', async () => {
    const v = await verifyTicketRow(row({ context: { acceptanceMetric: { ...METRIC, params: { messagePattern: 'P2025|refreshToken' } } } }), NOW);
    expect(v).toBe('done_vacuous');
    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.status).toBe('done');
    expect(arg.data.context.verification.lastVerdict).toBe('done_vacuous');
    expect(arg.data.adminNote).toContain('DONE (not deployed_verified)');
    expect(arg.data.adminNote).toContain('regex syntax "|"');
    expect(appErrorCount()).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0].kind)).toContain('acceptance_metric_baseline');
  });

  it('a MEASURED vacuous baseline (0 rows pre-fix vs <= 0) → done; the window is [filed − 24h, filed]', async () => {
    appErrorCount().mockResolvedValueOnce(0);
    const v = await verifyTicketRow(row(), NOW);
    expect(v).toBe('done_vacuous');
    expect(appErrorCount().mock.calls[0][0].where.createdAt).toEqual({ gte: new Date(FILED.getTime() - 24 * 3600_000), lte: FILED });
    expect(updateMock.mock.calls[0][0].data.status).toBe('done');
  });

  it('the filing stamp (context.acceptanceMetricBaseline) is reused — no re-measurement', async () => {
    const v = await verifyTicketRow(row({ context: { acceptanceMetric: METRIC, acceptanceMetricBaseline: { baseline: 0, measurable: true, vacuous: true } } }), NOW);
    expect(v).toBe('done_vacuous');
    expect(appErrorCount()).not.toHaveBeenCalled();
  });

  it('an auto-filer default the closing lane waived (false-positive close) → done', async () => {
    const v = await verifyTicketRow(row({ context: { acceptanceMetric: METRIC, verification: { metricWaived: { reason: 'auto-filer default metric on a false-positive close' } } } }), NOW);
    expect(v).toBe('done_vacuous');
    expect(updateMock.mock.calls[0][0].data.adminNote).toContain('auto-filer default');
  });

  // r2 interactions: the waiver is only reachable by a close with NO fix
  // commit (noteNamesShippedFix), and fix-state can never prove such a close
  // live — so the waived row used to wait in awaiting_verification forever.
  const NO_COMMIT = 'no recorded fix commitSha in the machine-close evidence (a replay-test-only close proves nothing about the merge/deploy state)';
  const waived = (over: Record<string, unknown> = {}) => row({
    adminNote: '[machine-close evidence: replay test backend/src/x.test.ts (verified: exists + cites 11111111)]',
    context: { acceptanceMetric: METRIC, acceptanceMetricSource: 'autofiler-default', verification: { metricWaived: { reason: 'auto-filer default metric on a false-positive close' } } },
    ...over,
  });

  it('r2: a WAIVED close that recorded NO fix commit closes done at once — never parked on a liveness proof it can never get', async () => {
    (parseClosureEvidenceNote as jest.Mock).mockReturnValueOnce({});
    (resolveFixStateFromEvidence as jest.Mock).mockClear().mockResolvedValue({ fixLive: false, reason: NO_COMMIT });
    const v = await verifyTicketRow(waived(), NOW);
    expect(v).toBe('done_vacuous');
    expect(resolveFixStateFromEvidence).not.toHaveBeenCalled();
    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.status).toBe('done');
    expect(arg.data.context.verification.lastVerdict).toBe('done_vacuous');
    expect(arg.data.adminNote).toContain('no fix commit');
    expect(arg.data.adminNote).toContain('Closed with no fix to deploy');
    expect(arg.data.adminNote).not.toContain('merged ∧ deployed bar');
  });

  it('r2: a waived close WITH a fix commit still waits for that commit to be live', async () => {
    (resolveFixStateFromEvidence as jest.Mock).mockResolvedValue({ fixLive: false, reason: 'deploy run 1 in progress' });
    const v = await verifyTicketRow(waived({ adminNote: '[machine-close evidence: commit abc123def4567890abc123def4567890abcd1234]' }), NOW);
    expect(v).toBe('waiting');
    expect(updateMock.mock.calls[0][0].data.status).toBeUndefined();
  });

  it('r2: ACCEPTANCE_BASELINE_GATE_DISABLED=1 restores the pre-gate wait for a waived no-commit close', async () => {
    process.env.ACCEPTANCE_BASELINE_GATE_DISABLED = '1';
    (parseClosureEvidenceNote as jest.Mock).mockReturnValueOnce({});
    (resolveFixStateFromEvidence as jest.Mock).mockResolvedValue({ fixLive: false, reason: NO_COMMIT });
    const v = await verifyTicketRow(waived(), NOW);
    expect(v).toBe('waiting');
    expect(updateMock.mock.calls[0][0].data.status).toBeUndefined();
  });

  it('the fix NOT live yet → still waits (a vacuous metric never closes before merged ∧ deployed)', async () => {
    (resolveFixStateFromEvidence as jest.Mock).mockResolvedValue({ fixLive: false, reason: 'deploy run 1 in progress' });
    const v = await verifyTicketRow(row({ context: { acceptanceMetric: { ...METRIC, params: { messagePattern: 'a|b' } } } }), NOW);
    expect(v).toBe('waiting');
    expect(updateMock.mock.calls[0][0].data.status).toBeUndefined();
  });
});

describe('non-vacuous metrics rule as before', () => {
  it('first live observation: the baseline (4 > 0) is stamped with the anchor', async () => {
    appErrorCount().mockResolvedValueOnce(4);
    const v = await verifyTicketRow(row(), NOW);
    expect(v).toBe('waiting');
    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.context.verification.firstLiveAt).toBe(NOW.toISOString());
    expect(arg.data.context.verification.baseline).toMatchObject({ baseline: 4, measurable: true, vacuous: false });
  });

  it('a row anchored before the gate: baseline stamped ONCE, then the metric rules (deployed_verified)', async () => {
    appErrorCount().mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const v = await verifyTicketRow(row({ context: { acceptanceMetric: METRIC, verification: { firstLiveAt: ANCHORED_25H_AGO } } }), NOW);
    expect(v).toBe('deployed_verified');
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[0][0].data.context.verification.baseline).toMatchObject({ baseline: 3, vacuous: false });
    expect(updateMock.mock.calls[1][0].data.status).toBe('deployed_verified');
    expect(updateMock.mock.calls[1][0].data.context.verification.baseline).toMatchObject({ baseline: 3 });
  });

  it('review 2026-10-20: the LIVE filing stamp wins over a retrospective close stamp (a close recount can only shrink)', async () => {
    // Filed failing (2 reopened tickets in the pre-fix window); by the close those were worked, so the close-time recount read 0.
    const v = await verifyTicketRow(row({ context: {
      acceptanceMetric: METRIC,
      acceptanceMetricBaseline: { baseline: 2, measurable: true, vacuous: false },
      verification: { baseline: { baseline: 0, measurable: true, vacuous: true } },
    } }), NOW);
    expect(v).toBe('waiting'); // anchored and measured — never done_vacuous
    expect(updateMock.mock.calls[0][0].data.status).toBeUndefined();
    expect(updateMock.mock.calls[0][0].data.context.verification.firstLiveAt).toBe(NOW.toISOString());
  });

  it('review 2026-10-20: a ticket_count metric with no filing stamp is never ruled vacuous on a retrospective recount', async () => {
    const tc = { probe: 'ticket_count', params: { type: 'mishap', status: 'reopened' }, operator: '<=', target: 0, windowHours: 24 };
    const v = await verifyTicketRow(row({ context: { acceptanceMetric: tc } }), NOW);
    expect(v).toBe('waiting');
    expect(updateMock.mock.calls[0][0].data.status).toBeUndefined();
  });

  it('an unmeasurable baseline never makes a metric vacuous', async () => {
    appErrorCount().mockRejectedValueOnce(new Error('db down'));
    const v = await verifyTicketRow(row(), NOW);
    expect(v).toBe('waiting');
    expect(updateMock.mock.calls[0][0].data.context.verification.firstLiveAt).toBe(NOW.toISOString());
  });
});

describe('ACCEPTANCE_BASELINE_GATE_DISABLED=1', () => {
  it('restores the pre-gate ruling: no baseline read, the window anchors', async () => {
    process.env.ACCEPTANCE_BASELINE_GATE_DISABLED = '1';
    const v = await verifyTicketRow(row(), NOW);
    expect(v).toBe('waiting');
    expect(appErrorCount()).not.toHaveBeenCalled();
    expect(updateMock.mock.calls[0][0].data.context.verification.baseline).toBeUndefined();
  });
});

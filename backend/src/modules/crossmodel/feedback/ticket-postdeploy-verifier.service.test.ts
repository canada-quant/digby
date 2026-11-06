/**
 * ticket-postdeploy-verifier.service.ts — the post-deploy did-it-work loop
 * (ticket 6665fff6). Pins the ticket's acceptance scenarios:
 *   - a seeded fix with a FAILING metric (window elapsed) auto-reopens with
 *     the measured value attached;
 *   - a PASSING metric reaches deployed_verified;
 *   - merged-but-not-deployed rows WAIT (no transition) — "done at merge
 *     time" is impossible;
 *   - a pass before the full window only when smoke-shaped (≤1h) or
 *     monotonic-certain (>= already met);
 *   - an unmeasurable metric NEVER auto-reopens (fail-safe);
 *   - the board line renders the four counts.
 */
import {
  runTicketPostdeployVerifierOnce,
  verifyTicketRow,
  ticketDoneBarBoardLine,
} from './ticket-postdeploy-verifier.service';

const updateMock = jest.fn();
const findManyMock = jest.fn();
const countMock = jest.fn();

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userFeatureRequest: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
      count: (...a: unknown[]) => countMock(...a),
    },
    loopMetric: { count: jest.fn() },
    appErrorLog: { count: jest.fn() },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// fix-state is mocked per-test (the merged ∧ deployed proof) — the real
// resolver's own suites (fix-state.*.test.ts) pin it.
jest.mock('./fix-state', () => ({
  parseClosureEvidenceNote: jest.fn(() => ({ commitSha: 'abc123def4567890abc123def4567890abcd1234' })),
  resolveFixStateFromEvidence: jest.fn(),
}));
import { resolveFixStateFromEvidence } from './fix-state';

// The reopen path dynamically imports the dispatcher (releaseTicketDispatchClaim)
// — the real module pulls config/redis → config/env → process.exit in jest.
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));

const METRIC = {
  probe: 'app_error_log_count',
  params: { level: 'error', messagePattern: 'P2025' },
  operator: '<=',
  target: 0,
  windowHours: 24,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    type: 'bug_report',
    status: 'awaiting_verification',
    priority: 3,
    adminNote: '[machine-close evidence: commit abc123def4567890abc123def4567890abcd1234]',
    userId: null,
    context: { acceptanceMetric: METRIC },
    ...overrides,
  };
}

function setFixLive(live: boolean, reason = live ? 'commit abc1234 is an ancestor of origin/main' : 'deploy run 123 not green') {
  (resolveFixStateFromEvidence as jest.Mock).mockResolvedValue({ fixLive: live, reason });
}

function setMeasured(count: number | Error) {
  const { appErrorLog } = require('../../../config/database').default;
  if (count instanceof Error) appErrorLog.count.mockRejectedValueOnce(count);
  else appErrorLog.count.mockResolvedValueOnce(count);
}

const NOW = new Date('2026-10-17T12:00:00Z');
const ANCHORED_25H_AGO = new Date(NOW.getTime() - 25 * 3600_000).toISOString();
const ANCHORED_1H_AGO = new Date(NOW.getTime() - 1 * 3600_000).toISOString();

// File-level reset (the kill-switch test must not see a prior test's calls).
beforeEach(() => {
  updateMock.mockReset().mockResolvedValue({});
  findManyMock.mockReset();
  countMock.mockReset().mockResolvedValue(0);
  setFixLive(true);
});

describe('verifyTicketRow (6665fff6)', () => {

  it('a FAILING metric with the window elapsed reopens the ticket with the measured value attached', async () => {
    setMeasured(3);
    const verdict = await verifyTicketRow(row({
      context: { acceptanceMetric: METRIC, verification: { firstLiveAt: ANCHORED_25H_AGO } },
    }), NOW);
    expect(verdict).toBe('reopened');
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.status).toBe('reopened');
    expect(arg.data.priority).toBe(4); // the reopen bump
    expect(arg.data.context.verification.lastMeasured).toBe(3);
    expect(arg.data.context.verification.reopenedAt).toBeDefined();
    expect(arg.data.adminNote).toContain('REOPENED');
    expect(arg.data.adminNote).toContain('measured 3');
  });

  it('a PASSING metric with the window elapsed reaches deployed_verified with the measured value attached', async () => {
    setMeasured(0);
    const verdict = await verifyTicketRow(row({
      context: { acceptanceMetric: METRIC, verification: { firstLiveAt: ANCHORED_25H_AGO } },
    }), NOW);
    expect(verdict).toBe('deployed_verified');
    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.status).toBe('deployed_verified');
    expect(arg.data.context.verification.lastMeasured).toBe(0);
    expect(arg.data.adminNote).toContain('DEPLOYED_VERIFIED');
  });

  it('merged-but-not-deployed rows WAIT — no transition, no done at merge time', async () => {
    setFixLive(false, 'commit abc1234 is NOT merged to origin/main');
    const verdict = await verifyTicketRow(row(), NOW);
    expect(verdict).toBe('waiting');
    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.status).toBeUndefined(); // status untouched
    expect(arg.data.context.verification.lastVerdict).toBe('waiting');
    expect(arg.data.adminNote).toContain('WAITING');
    // only one write while the verdict is unchanged (no per-tick churn)
    await verifyTicketRow(row({
      context: { acceptanceMetric: METRIC, verification: { firstLiveAt: undefined, lastVerdict: 'waiting', lastVerdictAt: NOW.toISOString() } },
    }), NOW);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('anchors the window at the FIRST live observation (deploy lands late)', async () => {
    setFixLive(true, 'box_health telemetry shows a box running the fix sha');
    const verdict = await verifyTicketRow(row(), NOW); // no firstLiveAt yet
    expect(verdict).toBe('waiting');
    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.context.verification.firstLiveAt).toBe(NOW.toISOString());
    expect(arg.data.adminNote).toContain('fix is LIVE');
  });

  it('a pass inside the window is held back unless smoke-shaped (≤1h) or monotonic-certain', async () => {
    // measured 0 (pass) but the window opened 1h ago on a 24h metric → wait
    setMeasured(0);
    const v1 = await verifyTicketRow(row({
      context: { acceptanceMetric: METRIC, verification: { firstLiveAt: ANCHORED_1H_AGO } },
    }), NOW);
    expect(v1).toBe('waiting');
    expect(updateMock).not.toHaveBeenCalled();
    // smoke-shaped (1h window) passes immediately
    setMeasured(0);
    const v2 = await verifyTicketRow(row({
      context: { acceptanceMetric: { ...METRIC, windowHours: 1 }, verification: { firstLiveAt: ANCHORED_1H_AGO } },
    }), NOW);
    expect(v2).toBe('deployed_verified');
    // monotonic-certain: >= already met inside the window passes now
    setMeasured(12);
    const v3 = await verifyTicketRow(row({
      context: { acceptanceMetric: { ...METRIC, operator: '>=', target: 10 }, verification: { firstLiveAt: ANCHORED_1H_AGO } },
    }), NOW);
    expect(v3).toBe('deployed_verified');
  });

  it('a monotonic-certain FAIL (<= already exceeded inside the window) reopens NOW', async () => {
    setMeasured(5); // 5 > 0 on a <= metric — counts only grow, the verdict is certain
    const verdict = await verifyTicketRow(row({
      context: { acceptanceMetric: METRIC, verification: { firstLiveAt: ANCHORED_1H_AGO } },
    }), NOW);
    expect(verdict).toBe('reopened');
  });

  // ── TICKET 1425001e (2026-11-01): AN UNSOUND PROBE MUST NOT REOPEN ────────
  // The measured case: ticket 8b62e61e, a fix that NAMED the gateway severance
  // class and kept the warn as the alarm, carried the sweep's default `<= 2`
  // over that warn's own volume. Measured 28 ⇒ CERTAIN fail ⇒ a correct fix
  // reopens and the drain dispatches a fresh lane onto a non-defect.
  const DESIGNED_ALARM_METRIC = {
    probe: 'app_error_log_count',
    params: { level: 'warn', source: 'run-model-turn', messagePattern: 'tool-call stream [api-optimize-xiaomi-mimo-v', excludeLogClass: 'external' },
    operator: '<=',
    target: 2,
    windowHours: 24,
  };
  const AUTOFILER = { acceptanceMetricSource: 'autofiler-default' };

  it('routes a DESIGNED-ALARM auto-filer metric to review instead of reopening a correct fix', async () => {
    const dispatcher = require('./ticket-dispatch.service');
    dispatcher.releaseTicketDispatchClaim.mockClear();
    // The descriptor carries excludeLogClass:'external', so the probe runs TWO
    // counts (total, then the excluded class) exactly as the live one does.
    const { appErrorLog } = require('../../../config/database').default;
    appErrorLog.count.mockReset().mockResolvedValueOnce(28).mockResolvedValueOnce(0);
    const verdict = await verifyTicketRow(row({
      context: { ...AUTOFILER, acceptanceMetric: DESIGNED_ALARM_METRIC, verification: { firstLiveAt: ANCHORED_1H_AGO } },
    }), NOW);
    expect(verdict).toBe('review_required');
    const arg = updateMock.mock.calls[0][0];
    // NEVER a reopen — and never a false 'done': nothing was verified.
    expect(arg.data.status).toBeUndefined();
    expect(arg.data.priority).toBeUndefined(); // no reopen bump
    expect(arg.data.context.verification.lastVerdict).toBe('review_required');
    expect(arg.data.context.verification.lastMeasured).toBe(28);
    expect(arg.data.adminNote).toContain('NEEDS METRIC REVIEW');
    expect(arg.data.adminNote).not.toContain('REOPENED');
    // The dispatch claim is NOT released — no fresh lane is invited onto a non-defect.
    expect(dispatcher.releaseTicketDispatchClaim).not.toHaveBeenCalled();
  });

  it('routes a DESIGNED-OBSERVABILITY auto-filer metric to review instead of reopening a correct fix (dc4f7ff5)', async () => {
    // REPLAY, both live specimens: 3769b1b3's derived fragment and e35f9985's
    // ACTUAL stored fragment (read from the ticket store, not invented). Before
    // this change each measured > target ⇒ CERTAIN fail ⇒ a correct, deployed
    // fix reopened and the drain dispatched a fresh lane onto a non-defect.
    const dispatcher = require('./ticket-dispatch.service');
    // Both live windows MEASURED OVER their bar (2 for 3769b1b3's autofiler
    // shape, 3 vs 2 for e35f9985) and the 24h window had elapsed — the exact
    // combination `certainEarlyVerdict`/`fail` rules as a CERTAIN reopen.
    for (const [pattern, measured] of [
      ['utilitychat: utility role override unreachable (timeout of', 3],
      ['llm-extracted note claim(s) narrating third-party lane status — real artifacts owned by oth', 3],
    ] as Array<[string, number]>) {
      dispatcher.releaseTicketDispatchClaim.mockClear();
      updateMock.mockClear();
      setMeasured(measured);
      const verdict = await verifyTicketRow(row({
        context: {
          ...AUTOFILER,
          acceptanceMetric: { probe: 'app_error_log_count', params: { level: 'warn', source: 'log-signal', messagePattern: pattern, excludeLogClass: 'external' }, operator: '<=', target: 2, windowHours: 24 },
          verification: { firstLiveAt: ANCHORED_25H_AGO },
        },
      }), NOW);
      expect(verdict).toBe('review_required');
      const arg = updateMock.mock.calls[0][0];
      // NEVER a reopen, NEVER a false 'done' — nothing was verified.
      expect(arg.data.status).toBeUndefined();
      expect(arg.data.context.verification.lastVerdict).toBe('review_required');
      expect(arg.data.adminNote).toContain('NEEDS METRIC REVIEW');
      expect(arg.data.adminNote).not.toContain('REOPENED');
      expect(dispatcher.releaseTicketDispatchClaim).not.toHaveBeenCalled();
    }
  });

  it('the review note is written ONCE (idempotent) — no per-tick churn', async () => {
    setMeasured(28);
    await verifyTicketRow(row({
      context: { ...AUTOFILER, acceptanceMetric: DESIGNED_ALARM_METRIC, verification: { firstLiveAt: ANCHORED_1H_AGO, lastVerdict: 'review_required' } },
    }), NOW);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a HAND-AUTHORED metric is never routed away — a lane cannot waive its own acceptance test', async () => {
    setMeasured(28);
    // Same probe + same designed-alarm PATTERN, but the LANE attached it (no
    // autofiler-default stamp) — its judgement, not ours to override. Kept
    // without excludeLogClass so the single queued count is the whole reading.
    const { excludeLogClass: _omit, ...handAuthored } = DESIGNED_ALARM_METRIC.params;
    const verdict = await verifyTicketRow(row({
      context: { acceptanceMetric: { ...DESIGNED_ALARM_METRIC, params: handAuthored }, acceptanceMetricSource: 'filer', verification: { firstLiveAt: ANCHORED_1H_AGO } },
    }), NOW);
    expect(verdict).toBe('reopened');
  });

  it('an unmeasurable metric NEVER auto-reopens (fail-safe)', async () => {
    setMeasured(new Error('connection refused'));
    const verdict = await verifyTicketRow(row({
      context: { acceptanceMetric: METRIC, verification: { firstLiveAt: ANCHORED_25H_AGO } },
    }), NOW);
    expect(verdict).toBe('unmeasurable');
    const arg = updateMock.mock.calls[0][0];
    expect(arg.data.status).toBeUndefined();
    expect(arg.data.context.verification.lastVerdict).toBe('unmeasurable');
  });

  it('a row with no readable metric is surfaced (skipped), never ruled', async () => {
    const verdict = await verifyTicketRow(row({ context: {} }), NOW);
    expect(verdict).toBe('skipped');
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('runTicketPostdeployVerifierOnce (cron entry)', () => {
  it('returns a ≤200-char summary and never throws', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const summary = await runTicketPostdeployVerifierOnce();
    expect(summary).toBe('no tickets awaiting verification');
    findManyMock.mockRejectedValueOnce(new Error('db down'));
    const failed = await runTicketPostdeployVerifierOnce();
    expect(failed).toContain('sweep failed');
  });

  it('honors the kill switch', async () => {
    process.env.TICKET_POSTDEPLOY_VERIFIER_DISABLED = '1';
    try {
      const summary = await runTicketPostdeployVerifierOnce();
      expect(summary).toBe('disabled (kill switch)');
      expect(findManyMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.TICKET_POSTDEPLOY_VERIFIER_DISABLED;
    }
  });
});

describe('ticketDoneBarBoardLine (the [BOARD] done-bar line)', () => {
  const DV = 'deployed_verified', AV = 'awaiting_verification', RO = 'reopened';

  it('is absent when everything is zero (healthy board, no line)', async () => {
    findManyMock.mockResolvedValueOnce([]);
    countMock.mockResolvedValueOnce(0);
    expect(await ticketDoneBarBoardLine(NOW)).toBeNull();
  });

  it('surfaces all four classes', async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'a', status: DV, context: {}, updatedAt: NOW },                                        // deployed-verified
      { id: 'b', status: AV, context: {}, updatedAt: NOW },                                        // merged-not-deployed
      { id: 'c', status: AV, context: { verification: { firstLiveAt: ANCHORED_1H_AGO } }, updatedAt: NOW }, // in window
      { id: 'd', status: RO, context: { verification: { reopenedAt: NOW.toISOString() } }, updatedAt: NOW }, // verifier-reopened
    ]);
    countMock.mockResolvedValueOnce(2);
    const line = await ticketDoneBarBoardLine(NOW);
    expect(line).toContain('TICKET DONE-BAR (6665fff6)');
    expect(line).toContain('1 deployed-verified');
    expect(line).toContain('1 fix-not-yet-live (merge/deploy pending)');
    expect(line).toContain('1 in metric window');
    expect(line).toContain('1 reopened by verifier (metric failed)');
    expect(line).toContain('2 fix ticket(s) missing an acceptance metric');
  });

  it('never throws on a read failure', async () => {
    findManyMock.mockRejectedValueOnce(new Error('db down'));
    expect(await ticketDoneBarBoardLine(NOW)).toBeNull();
  });
});

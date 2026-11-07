/**
 * REPLAY TEST — ticket 31199f81 (2026-11-06): the post-deploy verifier's
 * designed-observability redirect MISSED a legacy (markerless) stored bar, so
 * ticket 3769b1b3 was wrongly REOPENED on a correct, deployed fix.
 *
 * CORRECTION RECORD — ticket 58f27eb3 (2026-11-06), same defectFamily: 3769b1b3
 * is NOT held behind 31199f81 by `dependsOnTicketIds` — that write was refused
 * `dispatched_elsewhere` while 3769b1b3 still named an archived lane, so the
 * ticket descriptions claiming a hard gate are wrong. The operative guard is
 * 3769b1b3's OWN adminNote: do NOT re-fix the utility leg timeout (7e315b4b is
 * live and working); reconcile through 31199f81, i.e. through this replay.
 * Nothing about the timeout is re-fixed here — the specimens below are the
 * stored bars as the verifier sees them, not a re-assertion of that fix.
 *
 * THE DEFECT THIS REPLAYS (measured in production, not a fixture).
 * The redirect that refuses to reopen a fix on a by-design class
 * (`designedAlarmOfMetric`, tickets 1425001e + dc4f7ff5) gated on PROVENANCE
 * with an allowlist: `if (source !== 'autofiler-default') return null`. That
 * made the ABSENCE of a marker mean "hand-authored", so any bar stamped before
 * the marker existed — or by a filer that never wrote one — failed CLOSED and
 * was measured against a bar its class can never meet.
 *
 * Measured timeline (origin/main before this change):
 *   - 00:28:56Z — 3769b1b3 filed. `get_feedback` shows its context carries
 *     `acceptanceMetric` (`app_error_log_count <= 0` over
 *     `utility role override unreachable`) and `acceptanceMetricBaseline`
 *     (baseline 242) but NO `acceptanceMetricSource`; the filing's own
 *     `acceptance_metric_baseline` telemetry row reads `"source":"filer"`.
 *     The guard therefore refused to redirect it — CORRECTLY per its rule.
 *   - 10:32:25Z — window anchored. ~10:54Z — the dc4f7ff5 redirect goes live.
 *   - 13:23:06Z — ONE residual row: "timeout of 15000ms exceeded … streak 1 —
 *     the built-in chain serves utility calls directly." The 15 s value is the
 *     NEW leg cap from the ticket's own fix (7e315b4b) — the failover working.
 *   - 13:32:39Z — verifier REOPENED on measured 1.
 *
 * WHY THE FIX IS "CONTENT AT DECISION TIME, MARKER MUST BE EXPLICIT".
 * The predicate now classifies the STORED METRIC'S OWN messagePattern through
 * the same signatures the sweep stamps with, evaluated on every ruling — so a
 * pre-fix-stamped or markerless bar is covered, and the answer does not depend
 * on who wrote the row or when. The escape hatch survives, but keyed on an
 * EXPLICIT marker (`acceptanceMetricSource: 'filer' | 'manual' | …`): a lane
 * that says "this is my metric" keeps its bar. Absence says nothing, so
 * content decides.
 *
 * ALSO PINNED — the retroactive half. A row the verifier already moved to
 * `reopened` is out of the sweep's `awaiting_verification` query yet IS an open
 * status the drain dispatches on, so the loop could not be closed without
 * withdrawing the bad reopen. `redirectWronglyReopenedRow` does exactly the
 * ruling the fixed predicate would have produced, and ONLY for rows this job
 * reopened (a human/lane reopen is theirs).
 *
 * NOT RE-FIXED HERE: the utility leg timeout. 7e315b4b is live and working;
 * this ticket is the verifier/redirect defect only.
 */
import { verifyTicketRow, redirectWronglyReopenedRow } from './ticket-postdeploy-verifier.service';
import { designedAlarmOfMetric, AUTOFILER_DEFAULT_METRIC_SOURCE } from './acceptance-metric-defaults';
import type { AcceptanceMetric } from './ticket-metric';

const updateMock = jest.fn();
const updateManyMock = jest.fn();
const findManyMock = jest.fn();
const appErrorCountMock = jest.fn();

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userFeatureRequest: {
      findMany: (...a: unknown[]) => findManyMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
      updateMany: (...a: unknown[]) => updateManyMock(...a),
      count: jest.fn(async () => 0),
    },
    loopMetric: { count: jest.fn() },
    appErrorLog: { count: (...a: unknown[]) => appErrorCountMock(...a) },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./fix-state', () => ({
  __esModule: true,
  parseClosureEvidenceNote: jest.fn(() => ({ commitSha: '7e315b4b7f77fb5c2d8d36d577c85dd9458ac02e' })),
  resolveFixStateFromEvidence: jest.fn(),
}));
import { resolveFixStateFromEvidence } from './fix-state';
jest.mock('./ticket-dispatch.service', () => ({ __esModule: true, releaseTicketDispatchClaim: jest.fn(async () => undefined) }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { TICKET_POSTDEPLOY_VERIFIER: 'ticket_postdeploy_verifier', ACCEPTANCE_METRIC_BASELINE: 'acceptance_metric_baseline' },
}));

const NOW = new Date('2026-11-06T13:32:39Z');
const ANCHORED_3H_AGO = new Date(NOW.getTime() - 3 * 3600_000).toISOString();

/**
 * 3769b1b3's STORED metric, verbatim from `get_feedback` — `target: 0`,
 * `level: 'warn'`, `source: 'utility-override'`, no `excludeLogClass`.
 */
const STORED_3769_B1B3: AcceptanceMetric = {
  probe: 'app_error_log_count',
  params: { level: 'warn', source: 'utility-override', messagePattern: 'utility role override unreachable' },
  operator: '<=',
  target: 0,
  windowHours: 24,
};

/** The same bar as the auto-filer would mint it today (synthetic stamp). */
const AUTOFILER_METRIC: AcceptanceMetric = {
  probe: 'app_error_log_count',
  params: { level: 'warn', source: 'log-signal', messagePattern: 'utilitychat: utility role override unreachable (timeout of' },
  operator: '<=',
  target: 2,
  windowHours: 24,
};

/** A genuine defect bar — MUST keep ruling (detection is not weakened). */
const REAL_DEFECT_METRIC: AcceptanceMetric = {
  probe: 'app_error_log_count',
  params: { level: 'error', source: 'utility-override', messagePattern: 'prisma query failed: connection reset by peer' },
  operator: '<=',
  target: 0,
  windowHours: 24,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '3769b1b3-653c-4d69-8e88-33f0853d166d',
    type: 'bug_report',
    status: 'awaiting_verification',
    priority: 5,
    adminNote: '[machine-close evidence: commit 7e315b4b7f77fb5c2d8d36d577c85dd9458ac02e]',
    userId: null,
    context: { acceptanceMetric: STORED_3769_B1B3 },
    createdAt: new Date('2026-11-06T00:28:56.140Z'),
    ...overrides,
  };
}

/** The anchored, in-window row: the shape that reopened at 13:32:39Z. */
const anchored = (metric: AcceptanceMetric, extra: Record<string, unknown> = {}) => row({
  context: { acceptanceMetric: metric, verification: { firstLiveAt: ANCHORED_3H_AGO }, ...extra },
});

/**
 * The RULING write is the LAST update of a tick — the baseline stamp (minted by
 * `metricVacuity` on the same tick) writes first without a verdict.
 */
const lastUpdate = () => updateMock.mock.calls[updateMock.mock.calls.length - 1][0];

beforeEach(() => {
  updateMock.mockReset().mockResolvedValue({});
  updateManyMock.mockReset().mockResolvedValue({ count: 1 });
  findManyMock.mockReset();
  appErrorCountMock.mockReset();
  (resolveFixStateFromEvidence as jest.Mock).mockResolvedValue({ fixLive: true, reason: 'commit 7e315b4b is an ancestor of origin/main ∧ deploy green' });
});

// ── THE CLASSIFIER: content decides, an explicit marker opts out ─────────────
describe('31199f81 — the redirect is decided by the metric, not by stamp-time metadata', () => {
  it('LEGACY MARKERLESS bar (3769b1b3 as stored) is now classified as designed observability', () => {
    // The exact failure: no `acceptanceMetricSource` at all. Before this change
    // this returned null (allowlist failed closed) and the bar was measured.
    expect(designedAlarmOfMetric(STORED_3769_B1B3, undefined)).toMatchObject({ id: 'utility-override-failover', class: 'designed-observability' });
  });

  it('SYNTHETIC AUTO-FILER stamp is classified the same way (no regression of dc4f7ff5)', () => {
    expect(designedAlarmOfMetric(AUTOFILER_METRIC, AUTOFILER_DEFAULT_METRIC_SOURCE)).toMatchObject({ id: 'utility-override-failover', class: 'designed-observability' });
  });

  // ESCAPE HATCH — keyed on an EXPLICIT marker, never on absence.
  it('an EXPLICIT hand-authored marker still keeps the bar (a lane can insist on its own test)', () => {
    for (const source of ['filer', 'manual', 'lane-authored', 'supervisor']) {
      expect(designedAlarmOfMetric(STORED_3769_B1B3, source)).toBeNull();
      expect(designedAlarmOfMetric(AUTOFILER_METRIC, source)).toBeNull();
    }
  });

  // …but an EMPTY/blank marker is absence, not a claim.
  it('a blank marker is ABSENCE — content still decides', () => {
    for (const source of ['', '   ', undefined, null]) {
      expect(designedAlarmOfMetric(STORED_3769_B1B3, source)?.id).toBe('utility-override-failover');
    }
  });

  // DETECTOR-RECALL REPLAY: the detector's PRIOR true positives must STILL
  // fire. This change widens which rows a signature applies to (markerless
  // ones), so the exemption tier owes proof that a genuine fault still rules.
  it('RECALL: an ordinary fault metric is never redirected (with or without a marker)', () => {
    for (const source of [undefined, AUTOFILER_DEFAULT_METRIC_SOURCE]) {
      expect(designedAlarmOfMetric(REAL_DEFECT_METRIC, source)).toBeNull();
    }
  });
});

// ── THE VERIFIER RULING: park, never reopen ────────────────────────────────
describe('31199f81 — a legacy-stored by-design bar is parked for review, not reopened', () => {
  it('SPECIMEN: 3769b1b3’s stored bar measured OVER its target no longer reopens', async () => {
    // The measured value that caused the reopen: 1 against `<= 0`. With the bar
    // unredirected this is `certainEarlyVerdict` ⇒ CERTAIN fail ⇒ reopen.
    appErrorCountMock.mockResolvedValue(1);
    const verdict = await verifyTicketRow(anchored(STORED_3769_B1B3), NOW);
    expect(verdict).toBe('review_required');
    const arg = lastUpdate();
    // NEVER a reopen: no status flip, no priority bump, no dispatch release.
    expect(arg.data.status).toBeUndefined();
    expect(arg.data.priority).toBeUndefined();
    expect(require('./ticket-dispatch.service').releaseTicketDispatchClaim).not.toHaveBeenCalled();
    expect(arg.data.context.verification.lastVerdict).toBe('review_required');
    expect(arg.data.context.verification.lastMeasured).toBe(1);
    expect(arg.data.adminNote).toContain('NEEDS METRIC REVIEW');
    expect(arg.data.adminNote).not.toContain('REOPENED');
  });

  it('SPECIMEN: an auto-filer-stamped by-design bar measured over target also parks', async () => {
    // A stamped non-vacuous baseline: the pre-fix window counted 50, so the bar
    // could fail and no baseline recount runs. TWO counts follow — the reading
    // and the logClass:'external' exclusion the auto-filer heal adds (5 - 0 = 5).
    appErrorCountMock.mockResolvedValueOnce(5).mockResolvedValueOnce(0);
    const verdict = await verifyTicketRow(
      anchored(AUTOFILER_METRIC, {
        acceptanceMetricSource: AUTOFILER_DEFAULT_METRIC_SOURCE,
        verification: { firstLiveAt: ANCHORED_3H_AGO, baseline: { baseline: 50, measurable: true, vacuous: false } },
      }),
      NOW,
    );
    expect(verdict).toBe('review_required');
    expect(lastUpdate().data.status).toBeUndefined();
  });

  // DETECTION IS NOT WEAKENED — the same window/measurement on a REAL metric
  // still reopens, markerless or not.
  // DETECTOR-RECALL REPLAY — a genuine defect still convicts.
  it('RECALL: a markerless REAL-DEFECT bar measured over target STILL reopens', async () => {
    appErrorCountMock.mockResolvedValue(4);
    const verdict = await verifyTicketRow(anchored(REAL_DEFECT_METRIC), NOW);
    expect(verdict).toBe('reopened');
    expect(lastUpdate().data.status).toBe('reopened');
  });

  // …and an EXPLICIT hand-authored by-design bar still reopens: the escape
  // hatch is real, so this change cannot be used to retire a lane's own test.
  // DETECTOR-RECALL REPLAY — a lane's own test still convicts (the hatch).
  it('RECALL: an EXPLICITLY hand-authored by-design bar still reopens', async () => {
    appErrorCountMock.mockResolvedValue(2);
    const verdict = await verifyTicketRow(
      anchored(STORED_3769_B1B3, { acceptanceMetricSource: 'filer' }),
      NOW,
    );
    expect(verdict).toBe('reopened');
    expect(lastUpdate().data.status).toBe('reopened');
  });
});

// ── THE RETROACTIVE HALF: withdraw a reopen this job already recorded ───────
describe('31199f81 — a reopen this job wrongly recorded is withdrawn', () => {
  /** The row exactly as the verifier left it at 13:32:39Z. */
  const wronglyReopened = (extra: Record<string, unknown> = {}) => row({
    status: 'reopened',
    context: {
      acceptanceMetric: STORED_3769_B1B3,
      verification: {
        firstLiveAt: new Date('2026-11-06T10:32:25.055Z').toISOString(),
        lastVerdict: 'reopened',
        lastMeasured: 1,
        reopenedAt: '2026-11-06T13:32:39.862Z',
        lastVerdictAt: '2026-11-06T13:32:39.862Z',
      },
      ...extra,
    },
  });

  it('the 3769b1b3 reopen is withdrawn to awaiting_verification / review_required', async () => {
    const verdict = await redirectWronglyReopenedRow(wronglyReopened(), NOW);
    expect(verdict).toBe('redirected');
    // Status-GUARDED write: the drain may reclaim the row mid-pass.
    expect(updateManyMock.mock.calls[0][0].where).toEqual({ id: '3769b1b3-653c-4d69-8e88-33f0853d166d', status: 'reopened' });
    const arg = updateManyMock.mock.calls[0][0];
    // Out of the dispatch queue (this is what stops a fresh lane being spent),
    // and never a false 'done' — nothing was verified.
    expect(arg.data.status).toBe('awaiting_verification');
    expect(arg.data.context.verification.lastVerdict).toBe('review_required');
    expect(arg.data.context.verification.lastMeasured).toBe(1); // the measurement is preserved
    expect(arg.data.adminNote).toContain('REOPEN WITHDRAWN');
    expect(arg.data.context.verification.lastDetail).toContain('utility-override-failover');
    // No DB count — the decision is made from the stored metric's content.
    expect(appErrorCountMock).not.toHaveBeenCalled();
  });

  it('a REAL metric failure stays reopened — the withdrawal is not a blanket amnesty', async () => {
    expect(await redirectWronglyReopenedRow(wronglyReopened({ acceptanceMetric: REAL_DEFECT_METRIC }), NOW)).toBe('kept');
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  // The race the guard exists for: the drain reclaimed the row between the
  // snapshot and the write. The withdrawal must NOT clobber a live dispatch.
  it('a row RECLAIMED by the drain mid-pass is skipped, never clobbered', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    expect(await redirectWronglyReopenedRow(wronglyReopened(), NOW)).toBe('skipped');
  });

  it('an EXPLICITLY hand-authored bar stays reopened', async () => {
    expect(await redirectWronglyReopenedRow(wronglyReopened({ acceptanceMetricSource: 'filer' }), NOW)).toBe('kept');
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('a HUMAN/lane reopen is never touched — only rows this job reopened', async () => {
    const human = row({
      status: 'reopened',
      context: { acceptanceMetric: STORED_3769_B1B3, verification: { lastVerdict: 'reopened' } }, // no reopenedAt
    });
    expect(await redirectWronglyReopenedRow(human, NOW)).toBe('skipped');
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('a row not reopened at all is skipped', async () => {
    expect(await redirectWronglyReopenedRow(anchored(STORED_3769_B1B3), NOW)).toBe('skipped');
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
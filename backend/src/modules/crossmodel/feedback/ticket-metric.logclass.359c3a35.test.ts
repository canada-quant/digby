/**
 * REPLAY TEST — tickets 359c3a35 + b4bfd09a (log-signal family a800a12d,
 * 2026-11-01): the acceptance-metric half of the "forever reopen".
 *
 * THE DEFECT THIS REPLAYS. Both tickets were attached an auto-filer default
 * metric by the hourly log-signal sweep:
 *
 *   app_error_log_count <= 2 over 24h
 *   params: { level:'warn', source:'news', messagePattern:'… trying fallback c' }
 *
 * Their emit site (news.service — the formatter ladder's degraded-dependency
 * row) was then correctly retagged `logExternal` (commit 09bbd32c, PR #2234),
 * so isNonFaultLogRow() drops the rows and the SWEEP stops filing. But the
 * PROBE never read logClass: it counted level+source+message only, so every
 * row the sweep adjudicated EXTERNAL still counted against the ticket's own
 * internal-fault bar. The post-deploy verifier therefore re-measured, missed
 * the target, and reopened the ticket — every window, forever. `<= 2` was
 * unreachable by construction while the (designed, external) class emitted at
 * all.
 *
 * MEASURED IN PRODUCTION (this run's own reads, not a fixture):
 *   - REOPENED 12:15:25Z, measured 4 — the four 'all 5 strategies failed'
 *     rows logged 12:13:34Z … 12:14:17Z.
 *   - REOPENED 12:30:30Z, measured 3 — the three 'gated' rows logged
 *     12:22:21Z … 12:22:46Z.
 * Both values are exactly the burst row counts, which is the proof that the
 * number the verifier ruled on was the external class itself.
 *
 * WHAT IS PINNED HERE:
 *   1. an auto-filer default now carries params.excludeLogClass:'external';
 *   2. the probe is SUBTRACTIVE (total − excluded) so an UNTAGGED warn row —
 *      the genuine internal fault this bar exists to catch — still counts,
 *      and a logClass:'fault' row still counts;
 *   3. the stored (pre-fix) metric shape heals only when it is
 *      acceptanceMetricSource:'autofiler-default', so a lane's hand-authored
 *      metric is never rewritten;
 *   4. the burst itself, replayed: 4 external rows + 0 untagged ⇒ 0 against
 *      `<= 2` (PASS, where the old probe measured 4), while the same replay
 *      with ONE untagged internal row ⇒ 1 … and with 3 untagged rows ⇒ 3
 *      (FAIL) — detection of genuine internal rows is intact.
 *
 * NOT pinned here (owned elsewhere, deliberately): the sweep's own drop
 * behaviour (log-signal-sweep.service.test.ts) and the verifier's verdict
 * machinery (ticket-postdeploy-verifier.service.test.ts). This file touches
 * neither.
 */

import {
  validateAcceptanceMetric,
  readAcceptanceMetric,
  evaluateAcceptanceMetric,
  EXCLUDABLE_LOG_CLASSES,
  healAutofilerDefaultMetric,
  logSignalDefaultMetric,
  AcceptanceMetric,
} from './ticket-metric';
import { AUTOFILER_DEFAULT_METRIC_SOURCE } from './acceptance-metric-defaults';

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    appErrorLog: { count: jest.fn() },
    loopMetric: { count: jest.fn() },
    userFeatureRequest: { count: jest.fn() },
  },
}));
import prisma from '../../../config/database';

const countMock = prisma.appErrorLog.count as jest.Mock;

/** The metric BOTH tickets actually carry in prod (context.acceptanceMetric). */
const STORED_359c3a35: AcceptanceMetric = {
  probe: 'app_error_log_count',
  params: {
    level: 'warn',
    source: 'news',
    messagePattern: 'strategies failed + llm reformat gated) — trying fallback c',
  },
  operator: '<=',
  target: 2,
  windowHours: 24,
};

beforeEach(() => countMock.mockReset());

describe('ticket 359c3a35 / b4bfd09a — autofiler-default metrics exclude external-class rows', () => {
  it('the sweep default carries excludeLogClass:external (sweep and metric now agree)', () => {
    const m = logSignalDefaultMetric({
      fingerprint: 'news.service: could not extract json array from content (all <n> strategies failed) — trying fallback cache',
      levels: ['warn'],
      sources: ['news'],
      quietTarget: 2,
    });
    expect(m).not.toBeNull();
    expect(m!.params.excludeLogClass).toBe('external');
    // Still a valid metric under the validator (the param is allowlisted).
    expect(validateAcceptanceMetric(m).ok).toBe(true);
  });

  it('the filter can never be aimed at fault rows, and a typo is refused at filing', () => {
    expect(EXCLUDABLE_LOG_CLASSES).toEqual(['external', 'handled']);
    const aimedAtFault = validateAcceptanceMetric({
      ...STORED_359c3a35,
      params: { ...STORED_359c3a35.params, excludeLogClass: 'fault' },
    });
    expect(aimedAtFault.ok).toBe(false);
    if (!aimedAtFault.ok) expect(aimedAtFault.message).toContain('must be one of: external | handled');
    // a typo'd class must not silently exclude nothing
    expect(validateAcceptanceMetric({ ...STORED_359c3a35, params: { ...STORED_359c3a35.params, excludeLogClass: 'externl' } }).ok).toBe(false);
  });

  it('measures TOTAL minus the excluded class — never a Prisma `not` filter', async () => {
    countMock.mockResolvedValueOnce(9); // total matching rows
    countMock.mockResolvedValueOnce(9); // of those, 9 tagged external
    const m: AcceptanceMetric = { ...STORED_359c3a35, params: { ...STORED_359c3a35.params, excludeLogClass: 'external' } };
    const r = await evaluateAcceptanceMetric(m, new Date('2026-11-01T02:14:29.227Z'));

    expect(r.measurable).toBe(true);
    expect(r.measured).toBe(0);
    expect(r.ok).toBe(true);

    // First count is the plain filter (so an UNTAGGED row is in it).
    const first = countMock.mock.calls[0][0].where;
    expect(first.level).toBe('warn');
    expect(first.source).toBe('news');
    expect(first.message).toEqual({ contains: 'strategies failed + llm reformat gated) — trying fallback c', mode: 'insensitive' });
    expect(first).not.toHaveProperty('context'); // no `not`/JSON filter narrowing the base count

    // Second count is the same filter PLUS the excluded class.
    const second = countMock.mock.calls[1][0].where;
    expect(second.context).toEqual({ path: ['logClass'], equals: 'external' });
    expect(second.level).toBe('warn');
    expect(second.message).toEqual(first.message);
  });

  it('REPLAY of the 12:13-12:22Z burst: 4 external rows measured 4 before, 0 after (<= 2 PASSES)', async () => {
    // Before the fix: the four 'all 5 strategies failed' burst rows (12:13:34Z
    // … 12:14:17Z) counted straight into the bar — this is the measured 4 the
    // verifier reopened on at 12:15:25Z.
    countMock.mockResolvedValueOnce(4);
    const legacy = await evaluateAcceptanceMetric(STORED_359c3a35, new Date('2026-11-01T02:14:29.227Z'));
    expect(legacy.measured).toBe(4);
    expect(legacy.ok).toBe(false); // ⇒ REOPENED. The forever loop.

    // After the fix: the same four rows are all logClass:'external' (the
    // 09bbd32c retag), so they subtract out and the bar passes honestly.
    countMock.mockReset();
    countMock.mockResolvedValueOnce(4); // total
    countMock.mockResolvedValueOnce(4); // external
    const healed = await evaluateAcceptanceMetric(
      { ...STORED_359c3a35, params: { ...STORED_359c3a35.params, excludeLogClass: 'external' } },
      new Date('2026-11-01T02:14:29.227Z'),
    );
    expect(healed.measured).toBe(0);
    expect(healed.ok).toBe(true);
    expect(healed.detail).toContain("excluding logClass:'external'");
  });

  it('a genuine INTERNAL row still counts: 4 external + 3 untagged = 3 against <= 2 (FAIL)', async () => {
    countMock.mockResolvedValueOnce(7); // total (4 external + 3 untagged)
    countMock.mockResolvedValueOnce(4); // external only
    const r = await evaluateAcceptanceMetric(
      { ...STORED_359c3a35, params: { ...STORED_359c3a35.params, excludeLogClass: 'external' } },
      new Date('2026-11-01T02:14:29.227Z'),
    );
    expect(r.measured).toBe(3);
    expect(r.ok).toBe(false); // detection is NOT weakened — this still reopens
  });

  it('heals a stored autofiler-default metric, and leaves a lane-authored one alone', () => {
    // The two tickets' real stored shape (no filter) + the autofiler stamp.
    const healed = healAutofilerDefaultMetric(STORED_359c3a35, AUTOFILER_DEFAULT_METRIC_SOURCE);
    expect(healed.healed).toBe(true);
    expect(healed.metric.params.excludeLogClass).toBe('external');
    expect(healed.metric.target).toBe(2); // the ticket's own bar is untouched
    expect(healed.metric.params.messagePattern).toBe(STORED_359c3a35.params.messagePattern);

    // Idempotent — a metric that already carries a filter is left as-is.
    expect(healAutofilerDefaultMetric(healed.metric, AUTOFILER_DEFAULT_METRIC_SOURCE).healed).toBe(false);

    // A hand-authored metric (no autofiler stamp) is NEVER rewritten.
    expect(healAutofilerDefaultMetric(STORED_359c3a35, undefined).healed).toBe(false);
    expect(healAutofilerDefaultMetric(STORED_359c3a35, 'lane').healed).toBe(false);

    // A loop_metric_count default is out of scope (different probe).
    expect(healAutofilerDefaultMetric({ probe: 'loop_metric_count', params: { kind: 'guard_strike' }, operator: '<=', target: 0, windowHours: 24 }, AUTOFILER_DEFAULT_METRIC_SOURCE).healed).toBe(false);
  });

  it('the stored metric reads back and now validates WITH the filter (verifier 6665fff6 compatibility)', () => {
    // context as the verifier actually reads it off the row.
    const healed = healAutofilerDefaultMetric(STORED_359c3a35, AUTOFILER_DEFAULT_METRIC_SOURCE).metric;
    const context = { acceptanceMetric: healed, acceptanceMetricSource: AUTOFILER_DEFAULT_METRIC_SOURCE };
    const read = readAcceptanceMetric(context);
    expect(read).not.toBeNull();
    expect(read!.probe).toBe('app_error_log_count');
    expect(read!.operator).toBe('<=');
    expect(read!.target).toBe(2);
    expect(read!.windowHours).toBe(24);
    expect(read!.params.excludeLogClass).toBe('external');
  });

  it('a metric WITHOUT the param keeps its exact historical behaviour (no silent change for other tickets)', async () => {
    countMock.mockResolvedValueOnce(5);
    const r = await evaluateAcceptanceMetric(STORED_359c3a35, new Date('2026-11-01T02:14:29.227Z'));
    expect(countMock).toHaveBeenCalledTimes(1); // one count only — nothing subtracted
    expect(r.measured).toBe(5);
    expect(r.ok).toBe(false);
  });
});
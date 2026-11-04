/**
 * ticket-metric.ts — the declarative acceptance-metric engine (ticket 6665fff6).
 * Pins: validation refusals for every malformed shape; the flag-not-reject
 * read path; the three probes' bounded COUNTs; the fail-safe unmeasurable
 * contract (a DB failure is NEVER a verdict).
 */
import {
  validateAcceptanceMetric,
  readAcceptanceMetric,
  evaluateAcceptanceMetric,
  ACCEPTANCE_PROBES,
  ACCEPTANCE_OPERATORS,
  AcceptanceMetric,
} from './ticket-metric';

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    appErrorLog: { count: jest.fn() },
    loopMetric: { count: jest.fn() },
    userFeatureRequest: { count: jest.fn() },
  },
}));
import prisma from '../../../config/database';

const GOOD = {
  probe: 'app_error_log_count',
  params: { level: 'error', messagePattern: 'P2025' },
  operator: '<=',
  target: 0,
  windowHours: 24,
};

describe('validateAcceptanceMetric (6665fff6)', () => {
  it('accepts a well-formed metric and normalizes params (trim)', () => {
    const v = validateAcceptanceMetric({ ...GOOD, params: { level: ' error ', messagePattern: ' P2025 ' } });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.metric.params.level).toBe('error');
  });

  it('refuses a non-allowlisted probe', () => {
    const v = validateAcceptanceMetric({ ...GOOD, probe: 'exec_shell' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('acceptanceMetric.probe must be one of');
  });

  it('refuses unknown params for a probe', () => {
    const v = validateAcceptanceMetric({ ...GOOD, params: { level: 'error', sql: 'DROP TABLE' } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('allows only');
  });

  it('requires params.kind for loop_metric_count', () => {
    const v = validateAcceptanceMetric({ ...GOOD, probe: 'loop_metric_count', params: {} });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('requires params.kind');
  });

  // A8 (review 48d4763a): a typo'd param counts 0 rows and `<= 0` would then
  // auto-verify — unmatchable values are refused at filing, not measured.
  it('refuses an unregistered loop_metrics kind (typo → no false deployed_verified)', () => {
    const v = validateAcceptanceMetric({ ...GOOD, probe: 'loop_metric_count', params: { kind: 'infra_alrt' } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('must be a registered loop_metrics kind');
  });

  it('accepts a registered loop_metrics kind', () => {
    const v = validateAcceptanceMetric({ probe: 'loop_metric_count', params: { kind: 'infra_alert' }, operator: '<=', target: 2, windowHours: 24 });
    expect(v.ok).toBe(true);
  });

  it('refuses an unknown ticket_count type', () => {
    const v = validateAcceptanceMetric({ ...GOOD, probe: 'ticket_count', params: { type: 'bugg_report' } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('acceptanceMetric.params.type must be one of');
  });

  it('refuses an unknown ticket_count status', () => {
    const v = validateAcceptanceMetric({ ...GOOD, probe: 'ticket_count', params: { status: 'don' } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('acceptanceMetric.params.status must be one of');
  });

  it('accepts a valid ticket_count metric', () => {
    const v = validateAcceptanceMetric({ probe: 'ticket_count', params: { type: 'bug_report', status: 'open' }, operator: '<=', target: 0, windowHours: 24 });
    expect(v.ok).toBe(true);
  });

  it('refuses a bad level (only error|warn)', () => {
    const v = validateAcceptanceMetric({ ...GOOD, params: { level: 'debug' } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('params.level must be one of');
  });

  it('refuses a bad operator / non-integer target / out-of-range window', () => {
    expect(validateAcceptanceMetric({ ...GOOD, operator: '<' }).ok).toBe(false);
    expect(validateAcceptanceMetric({ ...GOOD, target: 1.5 }).ok).toBe(false);
    expect(validateAcceptanceMetric({ ...GOOD, target: -1 }).ok).toBe(false);
    expect(validateAcceptanceMetric({ ...GOOD, windowHours: 0 }).ok).toBe(false);
    expect(validateAcceptanceMetric({ ...GOOD, windowHours: 169 }).ok).toBe(false);
  });

  it('caps param length (≤200) — a description-sized blob is not a param', () => {
    const v = validateAcceptanceMetric({ ...GOOD, params: { messagePattern: 'x'.repeat(201) } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('≤200 chars');
  });

  it('accepts the 7-day window (the "measure in 7 days" follow-up)', () => {
    expect(validateAcceptanceMetric({ ...GOOD, windowHours: 168 }).ok).toBe(true);
  });
});

describe('readAcceptanceMetric (re-validates stored context)', () => {
  it('returns null for absent / malformed stored metrics', () => {
    expect(readAcceptanceMetric(null)).toBeNull();
    expect(readAcceptanceMetric({})).toBeNull();
    expect(readAcceptanceMetric({ acceptanceMetric: { probe: 'exec_shell' } })).toBeNull();
    expect(readAcceptanceMetric({ acceptanceMetric: 'not an object' })).toBeNull();
  });

  it('returns the metric for a valid stored shape', () => {
    const m = readAcceptanceMetric({ acceptanceMetric: GOOD });
    expect(m?.probe).toBe('app_error_log_count');
    expect(m?.operator).toBe('<=');
  });
});

describe('evaluateAcceptanceMetric (bounded counts, fail-safe)', () => {
  const metric: AcceptanceMetric = {
    probe: 'app_error_log_count',
    params: { level: 'error', messagePattern: 'P2025' },
    operator: '<=',
    target: 0,
    windowHours: 24,
  };
  const since = new Date('2026-10-17T00:00:00Z');

  it('counts app_error_logs with parameterized contains (never a RegExp from ticket content)', async () => {
    (prisma.appErrorLog.count as jest.Mock).mockResolvedValueOnce(0);
    const r = await evaluateAcceptanceMetric(metric, since);
    expect(r.measurable).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.measured).toBe(0);
    const where = (prisma.appErrorLog.count as jest.Mock).mock.calls[0][0].where;
    expect(where.level).toBe('error');
    expect(where.message).toEqual({ contains: 'P2025', mode: 'insensitive' });
    expect(where.createdAt).toEqual({ gte: since });
  });

  it('fails the metric when the count misses the target', async () => {
    (prisma.appErrorLog.count as jest.Mock).mockResolvedValueOnce(3);
    const r = await evaluateAcceptanceMetric(metric, since);
    expect(r.ok).toBe(false);
    expect(r.measured).toBe(3);
  });

  it('counts loop_metrics by kind and tickets by type/status', async () => {
    (prisma.loopMetric.count as jest.Mock).mockResolvedValueOnce(2);
    const r1 = await evaluateAcceptanceMetric(
      { probe: 'loop_metric_count', params: { kind: 'infra_alert' }, operator: '==', target: 2, windowHours: 24 }, since);
    expect(r1.ok).toBe(true);
    expect((prisma.loopMetric.count as jest.Mock).mock.calls[0][0].where.kind).toBe('infra_alert');

    (prisma.userFeatureRequest.count as jest.Mock).mockResolvedValueOnce(0);
    const r2 = await evaluateAcceptanceMetric(
      { probe: 'ticket_count', params: { type: 'mishap', status: 'open' }, operator: '<=', target: 0, windowHours: 24 }, since);
    expect(r2.ok).toBe(true);
    const w = (prisma.userFeatureRequest.count as jest.Mock).mock.calls[0][0].where;
    expect(w.type).toBe('mishap');
    expect(w.status).toBe('open');
  });

  it('NEVER throws: a DB failure is unmeasurable, not a verdict', async () => {
    (prisma.appErrorLog.count as jest.Mock).mockRejectedValueOnce(new Error('connection refused'));
    const r = await evaluateAcceptanceMetric(metric, since);
    expect(r.measurable).toBe(false);
    expect(r.ok).toBeUndefined();
    expect(r.detail).toContain('unmeasurable');
  });

  it('honors all three operators', async () => {
    (prisma.appErrorLog.count as jest.Mock).mockResolvedValue(5);
    expect((await evaluateAcceptanceMetric({ ...metric, operator: '<=', target: 5 }, since)).ok).toBe(true);
    expect((await evaluateAcceptanceMetric({ ...metric, operator: '<=', target: 4 }, since)).ok).toBe(false);
    expect((await evaluateAcceptanceMetric({ ...metric, operator: '>=', target: 5 }, since)).ok).toBe(true);
    expect((await evaluateAcceptanceMetric({ ...metric, operator: '==', target: 5 }, since)).ok).toBe(true);
    expect((await evaluateAcceptanceMetric({ ...metric, operator: '==', target: 4 }, since)).ok).toBe(false);
  });
});

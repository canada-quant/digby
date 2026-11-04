/**
 * ACCEPTANCE-METRIC-BASELINE (2026-10-20) — ticket-metric.ts + the
 * acceptance-metric-defaults.ts leaf. Prod shape: 3 of 70 tickets carried a
 * metric and two of them used 'a|b' messagePatterns — Prisma `contains`
 * matches '|' LITERALLY, so `<= 0` passed vacuously. Pins: the regex-intent
 * refusal (filing) vs read (stored), the loop_metric_count meta filter, the
 * pre-fix baseline (vacuous / rare-event / >= / unmeasurable / static) and
 * the auto-filers' default metrics validating by construction.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    appErrorLog: { count: jest.fn() },
    loopMetric: { count: jest.fn() },
    userFeatureRequest: { count: jest.fn() },
  },
}));
// (review 2026-10-20: the retrospective / retention rules are pinned below.)
import prisma from '../../../config/database';

import {
  validateAcceptanceMetric,
  readAcceptanceMetric,
  evaluateAcceptanceMetric,
  measureAcceptanceBaseline,
  baselineIsVacuous,
  baselineWindow,
  baselineUnmeasurableReason,
  BASELINE_RETENTION_MS,
  regexIntentOf,
  stableLiteralFragment,
  logSignalDefaultMetric,
  frameworkFindingDefaultMetric,
  LOOP_METRIC_META_KEYS,
  type AcceptanceMetric,
} from './ticket-metric';

const appErrorCount = (prisma as any).appErrorLog.count as jest.Mock;
const loopCount = (prisma as any).loopMetric.count as jest.Mock;
const ticketCount = (prisma as any).userFeatureRequest.count as jest.Mock;
const ENV = { ...process.env };
beforeEach(() => {
  appErrorCount.mockReset();
  loopCount.mockReset();
  ticketCount.mockReset();
  process.env = { ...ENV };
  delete process.env.ACCEPTANCE_BASELINE_GATE_DISABLED;
});
afterAll(() => { process.env = ENV; });

const PIPE = { probe: 'app_error_log_count', params: { messagePattern: 'P2025|refreshToken' }, operator: '<=', target: 0, windowHours: 24 };

describe('regexIntentOf', () => {
  it('flags syntax a literal substring can never honor', () => {
    for (const p of ['a|b', 'foo.*bar', 'x.+', '^start', 'end$', '(?:a)', '[a-z]+', '\\d+', 'x{2,3}']) {
      expect(regexIntentOf(p)).not.toBeNull();
    }
  });
  it('keeps literal punctuation log messages carry', () => {
    for (const p of ['[HARNESS NOTICE', 'push refused permanently (terminal auth; quarantined for', 'config.json missing', 'P2025']) {
      expect(regexIntentOf(p)).toBeNull();
    }
  });
  it('review 2026-10-20: bracketed HYPHENATED log tags are literals, real character classes are not', () => {
    for (const p of ['[ticket-dispatch] drain failed', '[post-deploy verifier (6665fff6)]: fix', '[log-in] refused', '[e-mail] bounced', '[x-ray]', '[session-history-sync] push refused']) {
      expect(regexIntentOf(p)).toBeNull();
    }
    for (const p of ['[a-z]', 'id [0-9a-f] seen', '[A-Za-z0-9_]', '[^a-z]', '[0-9]{3}']) {
      expect(regexIntentOf(p)).not.toBeNull();
    }
    // stableLiteralFragment no longer drops a fragment for its log tag.
    expect(stableLiteralFragment('[ticket-dispatch] drain failed for lane <uuid>')).toBe('[ticket-dispatch] drain failed for lane');
  });
});

describe('validateAcceptanceMetric — regex intent + meta filter', () => {
  it('REFUSES a regex-shaped messagePattern at filing, naming the literal-substring rule', () => {
    const v = validateAcceptanceMetric(PIPE);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('LITERAL substring');
  });

  it('a STORED metric with one stays readable (the verifier rules it vacuous instead of stranding the row)', () => {
    expect(readAcceptanceMetric({ acceptanceMetric: PIPE })).not.toBeNull();
  });

  it('ACCEPTANCE_BASELINE_GATE_DISABLED=1 accepts it again (pre-gate behaviour)', () => {
    process.env.ACCEPTANCE_BASELINE_GATE_DISABLED = '1';
    expect(validateAcceptanceMetric(PIPE).ok).toBe(true);
  });

  it('meta filter: an allowlisted key + value pair, never half a pair or an unknown key', () => {
    const base = { probe: 'loop_metric_count', operator: '<=', target: 0, windowHours: 24 };
    expect(validateAcceptanceMetric({ ...base, params: { kind: 'infra_alert', metaKey: 'reason', metaValue: 'disk' } }).ok).toBe(true);
    const half = validateAcceptanceMetric({ ...base, params: { kind: 'infra_alert', metaKey: 'reason' } });
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.message).toContain('go together');
    const bad = validateAcceptanceMetric({ ...base, params: { kind: 'infra_alert', metaKey: 'note', metaValue: 'x' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('metaKey must be one of');
    expect(LOOP_METRIC_META_KEYS).toContain('fingerprint');
  });
});

describe('evaluateAcceptanceMetric — meta filter, window end, regex intent', () => {
  it('passes the meta JSON-path filter and a closed window to the count', async () => {
    loopCount.mockResolvedValueOnce(2);
    const metric = validateAcceptanceMetric({ probe: 'loop_metric_count', params: { kind: 'framework_signal_finding', metaKey: 'fingerprint', metaValue: 'raw-marker:HARNESS' }, operator: '<=', target: 0, windowHours: 24 });
    if (!metric.ok) throw new Error(metric.message);
    const start = new Date('2026-10-19T00:00:00Z');
    const end = new Date('2026-10-20T00:00:00Z');
    const m = await evaluateAcceptanceMetric(metric.metric, start, end);
    expect(m).toMatchObject({ measurable: true, ok: false, measured: 2 });
    expect(loopCount.mock.calls[0][0].where).toEqual({
      kind: 'framework_signal_finding',
      meta: { path: ['fingerprint'], equals: 'raw-marker:HARNESS' },
      createdAt: { gte: start, lte: end },
    });
  });

  it('a regex-shaped pattern is UNMEASURABLE (never a vacuous pass), no DB read', async () => {
    const m = await evaluateAcceptanceMetric(PIPE as AcceptanceMetric, new Date());
    expect(m.measurable).toBe(false);
    expect(m.detail).toContain('regex syntax');
    expect(appErrorCount).not.toHaveBeenCalled();
  });
});

describe('measureAcceptanceBaseline (the pre-fix window)', () => {
  const metric = (over: Partial<AcceptanceMetric> = {}): AcceptanceMetric => ({ probe: 'app_error_log_count', params: { messagePattern: 'P2025' }, operator: '<=', target: 0, windowHours: 24, ...over });
  const anchor = new Date('2026-10-20T12:00:00Z');

  it('measures [anchor − windowHours, anchor]', async () => {
    appErrorCount.mockResolvedValueOnce(5);
    const b = await measureAcceptanceBaseline(metric(), anchor, anchor);
    const w = baselineWindow(metric(), anchor);
    expect(appErrorCount.mock.calls[0][0].where.createdAt).toEqual({ gte: w.start, lte: w.end });
    expect(w.start.toISOString()).toBe('2026-10-19T12:00:00.000Z');
    expect(b).toMatchObject({ measurable: true, baseline: 5, vacuous: false });
  });

  it('VACUOUS when the metric already passes pre-fix (baseline 0 vs <= 0)', async () => {
    appErrorCount.mockResolvedValueOnce(0);
    const b = await measureAcceptanceBaseline(metric(), anchor, anchor);
    expect(b).toMatchObject({ measurable: true, baseline: 0, vacuous: true });
    expect(b.detail).toContain('cannot tell a fixed system from a broken one');
  });

  it('a rare-event fix (target 0) qualifies on a baseline of 1', async () => {
    appErrorCount.mockResolvedValueOnce(1);
    expect((await measureAcceptanceBaseline(metric(), anchor, anchor)).vacuous).toBe(false);
  });

  it('>= metrics: vacuous only when the pre-fix count already meets the target', () => {
    expect(baselineIsVacuous(metric({ operator: '>=', target: 10 }), 12)).toBe(true);
    expect(baselineIsVacuous(metric({ operator: '>=', target: 10 }), 3)).toBe(false);
    expect(baselineIsVacuous(metric({ operator: '==', target: 0 }), 2)).toBe(false);
  });

  it('a DB failure is unmeasurable, NEVER vacuous (the gate never drops what it cannot judge)', async () => {
    appErrorCount.mockRejectedValueOnce(new Error('db down'));
    expect(await measureAcceptanceBaseline(metric(), anchor, anchor)).toMatchObject({ measurable: false, vacuous: false });
  });

  it('review 2026-10-20: a RETROSPECTIVE ticket_count baseline is unmeasurable (never vacuous) — only a live count at filing judges it', async () => {
    const tc: AcceptanceMetric = { probe: 'ticket_count', params: { type: 'mishap', status: 'reopened' }, operator: '<=', target: 0, windowHours: 24 };
    ticketCount.mockResolvedValue(0); // the two reopened tickets were worked since — a recount would read 0
    const later = new Date(anchor.getTime() + 3 * 24 * 3600_000);
    const retro = await measureAcceptanceBaseline(tc, anchor, later);
    expect(retro).toMatchObject({ measurable: false, vacuous: false });
    expect(retro.detail).toContain('only live at filing');
    expect(ticketCount).not.toHaveBeenCalled();
    ticketCount.mockResolvedValueOnce(2);
    expect(await measureAcceptanceBaseline(tc, anchor, anchor)).toMatchObject({ measurable: true, baseline: 2, vacuous: false });
  });

  it('review 2026-10-20: a window starting beyond the probes\' retention is unmeasurable, not a vacuous 0', async () => {
    const now = new Date(anchor.getTime() + BASELINE_RETENTION_MS);
    const b = await measureAcceptanceBaseline(metric(), anchor, now);
    expect(b).toMatchObject({ measurable: false, vacuous: false });
    expect(b.detail).toContain('retention');
    expect(appErrorCount).not.toHaveBeenCalled();
    expect(baselineUnmeasurableReason(metric(), baselineWindow(metric(), anchor), new Date(anchor.getTime() + 3600_000))).toBeNull();
  });

  it('a regex-shaped pattern is statically vacuous with no DB read', async () => {
    const b = await measureAcceptanceBaseline(PIPE as AcceptanceMetric, anchor, anchor);
    expect(b).toMatchObject({ measurable: true, vacuous: true });
    expect(appErrorCount).not.toHaveBeenCalled();
  });
});

describe('auto-filer default metrics (valid by construction)', () => {
  it('stableLiteralFragment: the longest literal run between placeholders, ≥ 16 chars', () => {
    expect(stableLiteralFragment('session history sync: project <uuid> — push refused permanently (terminal auth; quarantined for <n>h, one fresh attempt'))
      .toBe('push refused permanently (terminal auth; quarantined for');
    expect(stableLiteralFragment('invalid signature')).toBe('invalid signature');
    expect(stableLiteralFragment('<n> rows <hex>')).toBeNull();
    expect(stableLiteralFragment('token [REDACTED: looked like a credential] rejected by the gateway upstream')).toBe('rejected by the gateway upstream');
  });

  it('logSignalDefaultMetric: <= quietTarget (default 0) over 24 h on the fragment, narrowed to a single level / source — and it validates', () => {
    const m = logSignalDefaultMetric({ fingerprint: 'session history sync: push refused permanently (terminal auth)', levels: ['warn'], sources: ['session-history-sync'] });
    // LOGCLASS-SYMMETRY (2026-11-01, 359c3a35 + b4bfd09a): the default now
    // subtracts the same non-fault class the sweep drops, so "the sweep stopped
    // filing this" and "the class fell below this bar" finally mean one thing.
    expect(m).toEqual({ probe: 'app_error_log_count', params: { messagePattern: 'session history sync: push refused permanently (terminal auth)', level: 'warn', source: 'session-history-sync', excludeLogClass: 'external' }, operator: '<=', target: 0, windowHours: 24 });
    expect(validateAcceptanceMetric(m).ok).toBe(true);
    const multi = logSignalDefaultMetric({ fingerprint: 'session history sync failed hard', levels: ['warn', 'error'], sources: ['a', 'b'] });
    expect(multi?.params).toEqual({ messagePattern: 'session history sync failed hard', excludeLogClass: 'external' });
    expect(logSignalDefaultMetric({ fingerprint: '<n> <uuid>' })).toBeNull();
    const quiet = logSignalDefaultMetric({ fingerprint: 'session history sync failed hard', quietTarget: 2 });
    expect(quiet?.target).toBe(2);
    expect(validateAcceptanceMetric(quiet).ok).toBe(true);
    expect(logSignalDefaultMetric({ fingerprint: 'session history sync failed hard', quietTarget: -1 })?.target).toBe(0);
  });

  it('frameworkFindingDefaultMetric: raw-marker fingerprints only — and it validates', () => {
    const m = frameworkFindingDefaultMetric('raw-marker:SEND_EMAIL');
    expect(m).toMatchObject({ probe: 'loop_metric_count', params: { kind: 'framework_signal_finding', metaKey: 'fingerprint', metaValue: 'raw-marker:SEND_EMAIL' }, operator: '<=', target: 0 });
    expect(validateAcceptanceMetric(m).ok).toBe(true);
    expect(frameworkFindingDefaultMetric('incomplete-card:oq_1')).toBeNull();
    expect(frameworkFindingDefaultMetric('missed-bug:c:m')).toBeNull();
  });
});

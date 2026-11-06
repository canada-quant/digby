/**
 * Client-error ingest throttle (ticket d4e643a5) — the acceptance bar is
 * explicit: "the same signature repeated 100× produces ONE row set and at most
 * ONE ticket." The row-set half is THIS module + the controller; the ticket half
 * is the existing hourly log-signal-sweep's own dedupe (one ticket per
 * fingerprint per ISO week, plus feedback's stable-title pass).
 *
 * THREE budgets are pinned here, because they protect three different things:
 *   - the per-signature window   → a render loop becomes one row, not thousands;
 *   - per-client + per-minute    → one tab cannot blind every other client;
 *   - the per-day ceiling        → client rows cannot crowd real SERVER errors
 *     out of the sweep's newest-3000-rows window (see MAX_PER_DAY).
 */
import {
  admitClientErrorReport,
  clientErrorIngestDisabled,
  __resetClientErrorThrottle,
  __clientErrorSignatureCount,
  SIGNATURE_INTERVAL_MS,
  MAX_PER_CLIENT_PER_MIN,
  MAX_PER_MIN,
  MAX_PER_DAY,
  MAX_KEYS,
} from './client-error-throttle';

const T0 = 1_700_000_000_000; // a fixed clock — every case is deterministic
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => __resetClientErrorThrottle());

/**
 * A DISTINCT signature per index. Alphabetic on purpose: the real signature
 * strips digits (ids and counts vary per occurrence — the CLASS must not), so a
 * numeric label would collapse every case into one signature and the budget
 * assertions would silently be measuring the dedupe instead.
 */
const distinct = (i: number): string => {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n > 0);
  return `sig-${s}`;
};

describe('client-error throttle — one row set per signature', () => {
  it('admits the first report and refuses the same signature for the rest of its window', () => {
    expect(admitClientErrorReport('sig-a', 'c1', T0).admit).toBe(true);
    expect(admitClientErrorReport('sig-a', 'c1', T0 + 1).admit).toBe(false);
    expect(admitClientErrorReport('sig-a', 'c1', T0 + 1).reason).toBe('duplicate');
    // A different client posting the same signature is ALSO refused — dedupe is
    // per signature, not per client: 100 tabs crashing on one bug is one class.
    expect(admitClientErrorReport('sig-a', 'c2', T0 + 2).reason).toBe('duplicate');
    // After the window the signature is admitted again (recurrence stays visible
    // to the sweep across time — the window is ingest pressure, not suppression).
    expect(admitClientErrorReport('sig-a', 'c1', T0 + SIGNATURE_INTERVAL_MS + 1).admit).toBe(true);
  });

  it('THE ACCEPTANCE: 100 identical reports in one burst produce exactly ONE admitted row set', () => {
    const verdicts = Array.from({ length: 100 }, (_, i) => admitClientErrorReport('render-loop', 'c1', T0 + i * 2));
    expect(verdicts.filter((v) => v.admit)).toHaveLength(1);
    expect(verdicts.filter((v) => v.reason === 'duplicate')).toHaveLength(99);
    expect(__clientErrorSignatureCount()).toBe(1);
  });

  it('a duplicate never spends a budget (99 duplicates cannot blind the next real crash)', () => {
    for (let i = 0; i < 99; i++) admitClientErrorReport('render-loop', 'c1', T0 + i);
    // Every budget is untouched by duplicates: a genuinely new signature still lands.
    expect(admitClientErrorReport('brand-new', 'c2', T0 + 100).admit).toBe(true);
  });

  it('an admitted report is ONE occurrence (the sweep counts ROWS, so a collapsed report is one row)', () => {
    expect(admitClientErrorReport('sig', 'c1', T0).occurrences).toBe(1);
    expect(admitClientErrorReport('sig', 'c1', T0 + 1).occurrences).toBe(1);
  });
});

describe('client-error throttle — a hostile client cannot silence real crashes', () => {
  it('caps one client per minute and leaves OTHER clients unaffected', () => {
    const results = Array.from({ length: MAX_PER_CLIENT_PER_MIN + 5 }, (_, i) => admitClientErrorReport(distinct(i), 'hostile', T0 + i));
    expect(results.filter((v) => v.reason === 'client-capped')).toHaveLength(5);
    // A different client is a different bucket.
    expect(admitClientErrorReport('real-crash', 'victim', T0 + 100).admit).toBe(true);
  });

  it('a client with no derivable ip shares one bucket and cannot exceed the same cap', () => {
    for (let i = 0; i < MAX_PER_CLIENT_PER_MIN; i++) {
      expect(admitClientErrorReport(distinct(i), null, T0 + i).admit).toBe(true);
    }
    expect(admitClientErrorReport('over', null, T0 + 50).reason).toBe('client-capped');
  });

  it('the process-wide per-minute ceiling bounds a distributed flood', () => {
    let admitted = 0;
    for (let i = 0; i < MAX_PER_MIN + 20; i++) {
      if (admitClientErrorReport(distinct(i), `client-${i}`, T0 + i).admit) admitted++;
    }
    expect(admitted).toBe(MAX_PER_MIN);
    expect(admitClientErrorReport('one-more', 'fresh-client', T0 + MAX_PER_MIN + 21).reason).toBe('global-capped');
  });

  it('the per-minute window rolls over', () => {
    for (let i = 0; i < MAX_PER_MIN; i++) admitClientErrorReport(distinct(i), `client-${i}`, T0 + i);
    expect(admitClientErrorReport('later', 'c', T0 + MAX_PER_MIN + 1).reason).toBe('global-capped');
    expect(admitClientErrorReport('next-minute', 'c', T0 + MINUTE).admit).toBe(true);
  });
});

describe('client-error throttle — client rows cannot crowd the sweep out of its window', () => {
  it('THE SWEEP-PROTECTION BAR: one process writes at most MAX_PER_DAY client rows in 24 h', () => {
    // Spread across the day: minutes apart, so nothing else is the limiter.
    let admitted = 0;
    for (let i = 0; i < MAX_PER_DAY + 50; i++) {
      if (admitClientErrorReport(distinct(i), `client-${i % 40}`, T0 + i * 90_000).admit) admitted++;
    }
    expect(admitted).toBe(MAX_PER_DAY);
    expect(admitClientErrorReport('after-cap', 'fresh', T0 + MAX_PER_DAY * 90_000 + 1000).reason).toBe('day-capped');
  });

  it('the day budget resets after 24 h', () => {
    for (let i = 0; i < MAX_PER_DAY; i++) admitClientErrorReport(distinct(i), `c-${i % 40}`, T0 + i * 90_000);
    expect(admitClientErrorReport('same-day', 'fresh', T0 + MAX_PER_DAY * 90_000 + 1000).reason).toBe('day-capped');
    expect(admitClientErrorReport('next-day', 'fresh', T0 + 86_400_000 + 1).admit).toBe(true);
  });

  it('MAX_PER_DAY is a bounded MINORITY of the sweep window (3000 rows), so server errors stay visible', () => {
    // The sweep's own constant, restated here as the contract that justifies the number.
    const LOG_SIGNAL_ROWS_CAP = 3000;
    expect(MAX_PER_DAY * 2).toBeLessThan(LOG_SIGNAL_ROWS_CAP / 2); // two prod boxes
  });

  it('keeps its maps bounded when a client rotates thousands of signatures', () => {
    // Past the day cap nothing is admitted, so use a fresh-but-large burst inside
    // the cap window and assert the maps never exceed their bound.
    for (let i = 0; i < MAX_KEYS + 500; i++) admitClientErrorReport(distinct(i), `client-${i}`, T0 + i);
    expect(__clientErrorSignatureCount()).toBeLessThanOrEqual(MAX_KEYS);
    // The bound is real, not trivially satisfied by the day cap: the admitted
    // count is the day ceiling and the map can never exceed MAX_KEYS.
    expect(__clientErrorSignatureCount()).toBeLessThanOrEqual(MAX_PER_DAY);
  });
});

describe('client-error throttle — kill switch', () => {
  it('CLIENT_ERROR_INGEST_DISABLED=1 turns the endpoint off', () => {
    expect(clientErrorIngestDisabled({ CLIENT_ERROR_INGEST_DISABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(clientErrorIngestDisabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(clientErrorIngestDisabled({ CLIENT_ERROR_INGEST_DISABLED: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(clientErrorIngestDisabled({ CLIENT_ERROR_INGEST_DISABLED: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
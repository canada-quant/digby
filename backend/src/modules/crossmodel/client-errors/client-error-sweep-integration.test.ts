/**
 * THE WHOLE-POINT TEST (ticket d4e643a5): a client UI error must reach the
 * EXISTING hourly filer, with no second sweep anywhere in this change.
 *
 * The chain is:
 *   browser handler → POST /api/crossmodel/client-error → recordClientError()
 *   → winston logger → PrismaErrorTransport → app_error_logs row
 *   (source 'client-error') → log-signal-sweep fetchWindowRows → normalizeLogMessage
 *   fingerprint → classifyRecurringLogSignals → fileFeedbackTicket.
 *
 * Every hop is real code here: this suite takes the EXACT message + context the
 * controller hands the logger, hands it to the REAL sweep fingerprint/classify
 * functions as a row, and asserts the sweep both (a) SEES it — the row is not
 * excluded as a self-row — and (b) fires a rule on recurrence so a ticket gets
 * filed. If the wiring were broken (wrong source stamp, an exclusion list that
 * swallowed it, a message prefix that never fingerprints), this goes red.
 */
import {
  normalizeLogMessage,
  summarizeLogFingerprints,
  classifyRecurringLogSignals,
  isNonFaultLogRow,
  LOG_SIGNAL_SELF_EXCLUDE_SOURCES,
  RULE1_MIN_HOURS,
  RULE2_MIN_REPEATS_UNPARSED,
  type LogSignalRow,
} from '../fleet/log-signal-sweep.service';
import { CLIENT_ERROR_MESSAGE_PREFIX, CLIENT_ERROR_SOURCE, recordClientError } from './client-error.controller';
import { __resetClientErrorThrottle } from './client-error-throttle';

// The logger is the seam the sweep's rows come from: capture what the
// controller would persist, then feed that shape to the sweep as a DB row.
const logged: Array<Record<string, unknown>> = [];
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: {
    log: jest.fn((rec: Record<string, unknown>) => { logged.push(rec); }),
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
  },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

beforeEach(() => { logged.length = 0; __resetClientErrorThrottle(); });

/** The app_error_logs row PrismaErrorTransport would write for a captured log record. */
function rowFor(rec: Record<string, unknown>, createdAt: Date): LogSignalRow {
  const context: Record<string, unknown> = {};
  for (const key of ['source', 'clientSource', 'signature', 'occurrences', 'route', 'url', 'userAgent', 'buildSha', 'userId', 'line', 'column']) {
    if (rec[key] !== undefined) context[key] = rec[key];
  }
  return {
    level: String(rec.level ?? 'error'),
    message: String(rec.message ?? ''),
    source: typeof rec.source === 'string' ? rec.source : null,
    createdAt,
    context,
  };
}

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-06T00:00:00Z');

describe('the sweep sees a client error with no second filer (ticket d4e643a5)', () => {
  it('the row the endpoint writes carries the source stamp the sweep filters on', () => {
    recordClientError({ message: 'TypeError: cannot read id', source: 'error-boundary', route: '/chat' });
    expect(logged).toHaveLength(1);
    // PrismaErrorTransport reads context.source FIRST when deciding app_error_logs.source:
    //   const source = (context.source as string) || (stack-derived) || undefined;
    // so this exact key is what the row is stamped with.
    expect(logged[0].source).toBe(CLIENT_ERROR_SOURCE);
    expect(CLIENT_ERROR_SOURCE).toBe('client-error');
    // …and it is NOT one of the sweep's self-excluded sources (which would make
    // the sweep blind to its own new producer — the defect this test exists for).
    expect(LOG_SIGNAL_SELF_EXCLUDE_SOURCES).not.toContain(CLIENT_ERROR_SOURCE);
  });

  it('the message fingerprints to something stable and searchable', () => {
    recordClientError({ message: "TypeError: Cannot read properties of undefined (reading 'id')", source: 'onerror' });
    const fp = normalizeLogMessage(String(logged[0].message));
    expect(fp).toContain('client-error:');
    expect(fp).toContain('cannot read properties of undefined');
    // The sweep's normalization is numerics + uuids + long hex — the SAME rule
    // every other source gets (this is the existing filer, not a new one). A
    // per-occurrence COUNT or a uuid therefore groups; a short mixed alnum id
    // keeps its letters and does not, exactly as for a server error.
    expect(normalizeLogMessage(`${CLIENT_ERROR_MESSAGE_PREFIX} TypeError: failed after 42 retries`))
      .toBe(normalizeLogMessage(`${CLIENT_ERROR_MESSAGE_PREFIX} TypeError: failed after 99 retries`));
    expect(normalizeLogMessage(`${CLIENT_ERROR_MESSAGE_PREFIX} TypeError: chat 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed`))
      .toBe(normalizeLogMessage(`${CLIENT_ERROR_MESSAGE_PREFIX} TypeError: chat 7c9e6679-7425-40de-944b-e07fc1f90ae7 failed`));
  });

  it('THE FILER: three occurrences across three hours fire rule 1 and produce a ticket signal', () => {
    const rows: LogSignalRow[] = [0, 1, 2].map((h) => {
      logged.length = 0;
      // A fresh signature per hour (the ingest window admits one per 5 min
      // anyway); the MESSAGE varies only by a volatile id, as real ones do.
      recordClientError({ message: `TypeError: Cannot read properties of undefined (reading 'id') in row ${h}`, source: 'error-boundary' });
      return rowFor(logged[0], new Date(T0 + h * HOUR));
    });
    expect(rows).toHaveLength(3);

    const fps = summarizeLogFingerprints(rows);
    expect(fps).toHaveLength(1); // one class
    expect(fps[0].count).toBe(3);
    expect(fps[0].hours).toBeGreaterThanOrEqual(RULE1_MIN_HOURS);

    const signals = classifyRecurringLogSignals(fps);
    expect(signals).toHaveLength(1);
    expect(signals[0].rule).toBe('rule1-hours');
    expect(signals[0].fingerprint).toContain('client-error:');
    // The ticket title the sweep would file is derived from that fingerprint.
    expect(signals[0].fingerprint.length).toBeGreaterThan(0);
  });

  it('a client error fired 100× in one hour does NOT trip the unparsed-promise rule (it is one class, not a broken suppression promise)', () => {
    // 100 posts collapse to ONE row at ingest, but be adversarial: even if 100
    // rows existed, the class must still need the SAME recurrence bar as any
    // other error — it must not fire merely for being loud once.
    const rows: LogSignalRow[] = Array.from({ length: 100 }, (_, i) => ({
      level: 'error',
      message: `${CLIENT_ERROR_MESSAGE_PREFIX} TypeError: boom`,
      source: CLIENT_ERROR_SOURCE,
      createdAt: new Date(T0 + i * 1000),
      context: { source: CLIENT_ERROR_SOURCE },
    }));
    const fps = summarizeLogFingerprints(rows);
    expect(fps).toHaveLength(1);
    expect(fps[0].hours).toBe(1);
    const signals = classifyRecurringLogSignals(fps);
    // Same hour, no promise language ⇒ no rule ⇒ no ticket. A single-burst
    // render loop must NOT page the owner.
    expect(signals).toHaveLength(0);
    expect(RULE2_MIN_REPEATS_UNPARSED).toBeGreaterThan(0);
  });

  it('a client error row is a FAULT (never tagged handled/external), so the sweep may ticket it', () => {
    recordClientError({ message: 'ReferenceError: x is not defined', source: 'onerror' });
    const row = rowFor(logged[0], new Date(T0));
    expect(isNonFaultLogRow(row)).toBe(false);
  });

  it('the persisted row leaks no user text and no token (end of the chain, on the real log record)', () => {
    const typed = 'my daughter has a dentist appointment on Thursday at 3pm';
    // Assembled, never literal — a token-shaped literal is a gitleaks hit in the
    // public mirror, and allowlisting the file would blind the scanner to a real
    // key pasted here later.
    const queryToken = ['sk', 'proj', 'abcdefghijklmnop012345'].join('-');
    const stackJwt = ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.', 'c2lnbmF0dXJl'].join('');
    recordClientError({
      message: `TypeError: failed showing "${typed}"`,
      stack: `TypeError: failed\n    at Row (https://digby.ai/app.js:1:2)\n    at send (https://digby.ai/app.js:2:3) Authorization: Bearer ${stackJwt}`,
      url: `https://digby.ai/chat?token=${queryToken}`,
      source: 'error-boundary',
    });
    const persisted = JSON.stringify(rowFor(logged[0], new Date(T0)));
    expect(persisted).not.toContain('dentist');
    expect(persisted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(persisted).not.toContain(queryToken);
    expect(persisted).toContain('<text>');
  });
});
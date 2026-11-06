/**
 * RAW-ANCHOR pin — log-signal family 2026-10-21 (tickets ac626e4f + 658ecf0e
 * + 78b4dc66 + 33005438, lane ae8c5605): the auto-filer's default acceptance
 * metric must be MEASURABLE — its messagePattern has to literally match the
 * RAW app_error_logs rows of the class it claims to count.
 *
 * The defect (both members' contexts prove it live): stableLiteralFragment
 * derived the pattern from the FINGERPRINT, whose whitespace is COLLAPSED by
 * normalizeLogMessage — but the app_error_log_count probe matches a literal
 * case-insensitive substring of the RAW row. Two of the family's real classes
 * carry non-collapsed raw text:
 *   - ac626e4f: "BrightData direct: search_engine failed:  direct SERP
 *     response missing organic results (other)" — a DOUBLE SPACE after the
 *     colon (brightdata-direct.ts L548 template `${err.response?.status || ''}
 *     ${err.message}`) ⇒ the fingerprint fragment matched 0 of 211 rows ⇒
 *     baseline 0 ⇒ the filing gate dropped the metric as VACUOUS
 *     (context.acceptanceMetricMissing, acceptanceMetricVacuous.baseline 0).
 *   - 658ecf0e: "coding container: Docker not available (Command failed:
 *     docker info --format {{.ServerVersion}}\n) — session commands fail
 *     closed…" — a NEWLINE inside execFileAsync's error message ⇒ same class:
 *     0 of 22 rows counted.
 * A vacuous metric cannot tell a fixed system from a broken one, and the
 * filing gate then files the ticket with NO metric at all — the post-deploy
 * verifier loses its re-measure handle for exactly the classes that recur.
 *
 * The fix: stableLiteralFragment(fingerprint, exampleMessage?) verifies the
 * fingerprint fragment against the signal's newest RAW row and, on a miss,
 * re-derives it from the RAW text anchored to the fingerprint's class
 * identity. logSignalMetricContext (the sweep's filing call) passes the raw
 * example through. These pins replay the EXACT raw shapes from the two
 * tickets and assert the constructed pattern counts its own class.
 */

import {
  stableLiteralFragment,
  logSignalDefaultMetric,
  AUTOFILER_DEFAULT_METRIC_SOURCE,
} from './acceptance-metric-defaults';
import {
  logSignalMetricContext,
  normalizeLogMessage,
} from '../fleet/log-signal-sweep.service';
import type { AcceptanceMetric } from './ticket-metric';

// Module-boundary mocks (log-signal-sweep.service.test.ts pattern): the sweep
// service statically imports config/database (→ config/env, which fail-fasts
// outside a provisioned instance) and the error-handler / ticket-dispatch
// leaves that pull it transitively. This suite pins only the PURE metric
// construction (logSignalMetricContext / normalizeLogMessage).
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    incr: jest.fn(async (k: string) => { const n = (Number(redisStore.get(k)) || 0) + 1; redisStore.set(k, String(n)); return n; }),
    decr: jest.fn(async (k: string) => { const n = (Number(redisStore.get(k)) || 0) - 1; redisStore.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error { constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); } },
}));
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'skipped' })),
  dispatchTicketToLane: jest.fn(async () => 'skipped'),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));

// ── the two real defect shapes, verbatim from the tickets ─────────────────────

const AC626E4F_RAW = 'BrightData direct: search_engine failed:  direct SERP response missing organic results (other)';
const AC626E4F_FP = 'brightdata direct: search_engine failed: direct serp response missing organic results (other)';

const C58ECF0E_RAW = 'coding container: Docker not available (Command failed: docker info --format {{.ServerVersion}}\n) — session commands fail closed until it answers; re-probing every 30 s';
const C58ECF0E_FP = 'coding container: docker not available (command failed: docker info --format {{.serverversion}} ) — session commands fai';

const S78B4DC66_RAW = 'Digby Web Search: search_engine SSE stream timed out (90s)';
const S78B4DC66_FP = 'digby web search: search_engine sse stream timed out (<n>s)';

const S33005438_RAW = 'Digby Web Search: PDF fetch/extract failed for "https://isap.sejm.gov.pl/isap.nsf/download.xsp/WDU2017000035": Maximum number of redirects exceeded';
const S33005438_FP = 'digby web search: pdf fetch/extract failed for "https://isap.sejm.gov.pl/isap.nsf/download.xsp/wdu<n>": maximum number o';

describe('log-signal family 2026-10-21 (ac626e4f/658ecf0e/78b4dc66/33005438) — raw-anchored default metrics', () => {
  it('ac626e4f: a DOUBLE SPACE in the raw message no longer produces a pattern that matches zero rows', () => {
    // The fingerprint (whitespace collapsed) fragment is NOT a substring of
    // the raw row — the pre-fix construction counted 0 of 211 rows.
    expect(AC626E4F_RAW.toLowerCase().includes(AC626E4F_FP)).toBe(false);
    // With the raw example, the fragment is re-derived FROM the raw row: it
    // is a literal substring of it, and of the class's other raw rows.
    const frag = stableLiteralFragment(AC626E4F_FP, AC626E4F_RAW);
    expect(frag).toBeTruthy();
    expect(AC626E4F_RAW.toLowerCase()).toContain(String(frag).toLowerCase());
    // …and of a sibling row whose variable text differs (the status prefix
    // empty + a longer tool error) — same class, same miss class "(other)".
    const sibling = 'BrightData direct: search_engine failed:  direct SERP response missing organic results (other)';
    expect(sibling.toLowerCase()).toContain(String(frag).toLowerCase());
    // The miss class is per-ticket identity (PE-06 keeps it in the
    // fingerprint): a DIFFERENT miss class is a different ticket, and the
    // raw-anchored pattern (which carries the class) does not match it.
    const otherClass = 'BrightData direct: search_engine failed:  direct SERP response missing organic results (json_no_organic)';
    expect(otherClass.toLowerCase()).not.toContain(String(frag).toLowerCase());
    // The pre-fix shape (no raw example) is unchanged for direct callers.
    expect(stableLiteralFragment(AC626E4F_FP)).toBe(AC626E4F_FP);
  });

  it('658ecf0e: a NEWLINE inside the raw error message no longer produces a pattern that matches zero rows', () => {
    expect(C58ECF0E_RAW.toLowerCase().includes(C58ECF0E_FP)).toBe(false);
    const frag = stableLiteralFragment(C58ECF0E_FP, C58ECF0E_RAW);
    expect(frag).toBeTruthy();
    expect(C58ECF0E_RAW.toLowerCase()).toContain(String(frag).toLowerCase());
    // Same class, different emitted newline position (docker CLI error tail).
    const sibling = 'coding container: Docker not available (Command failed: docker info --format {{.ServerVersion}}\n) — session commands fail closed until it answers; re-probing every 30 s';
    expect(sibling.toLowerCase()).toContain(String(frag).toLowerCase());
  });

  it('78b4dc66 + 33005438: the shapes that already measured fine keep their measurable patterns (no regression)', () => {
    // 78b4dc66: fingerprint fragment IS a raw substring → fast path returns it.
    expect(stableLiteralFragment(S78B4DC66_FP, S78B4DC66_RAW)).toBe('digby web search: search_engine sse stream timed out (');
    // 33005438: the URL carries the WDU<n> placeholder in the fingerprint —
    // the raw-anchored fragment must still be a literal substring of the raw.
    const fragPdf = stableLiteralFragment(S33005438_FP, S33005438_RAW);
    expect(fragPdf).toBeTruthy();
    expect(S33005438_RAW.toLowerCase()).toContain(String(fragPdf).toLowerCase());
    const m = logSignalDefaultMetric({ fingerprint: S33005438_FP, exampleMessage: S33005438_RAW, sources: ['web-search'], levels: ['warn'] });
    expect(m?.params.messagePattern).toBe(fragPdf);
  });

  it('logSignalMetricContext: the sweep passes the RAW example through — the metric is measurable on the family shapes that keep a bar', () => {
    // 33005438 IS DELIBERATELY ABSENT (ticket 68200428, 2026-11-06). It is the
    // `PDF fetch/extract failed` emit site, which the taxonomy now classifies as
    // DESIGNED OBSERVABILITY (websearch-pdf-fetch-target): every arm is a
    // third-party host refusing us or a deliberate size bound, so no volume bar
    // can ever clear and the post-deploy verifier reopened 68200428 at 4 vs 2.
    // `logSignalMetricContext` therefore returns acceptanceMetricMissing for it
    // by design. The RAW-ANCHOR property this test exists for is STILL pinned on
    // that shape — at the BUILDER level, in the test above (stableLiteralFragment
    // + logSignalDefaultMetric are not gated by the designed-observability set),
    // and the suppression itself is pinned in log-signal-pdf-fetch.68200428.test.ts.
    // Not a silent coverage drop: one shape moved class, the other three did not.
    for (const [fp, raw] of [
      [AC626E4F_FP, AC626E4F_RAW],
      [C58ECF0E_FP, C58ECF0E_RAW],
      [S78B4DC66_FP, S78B4DC66_RAW],
    ] as const) {
      const ctx = logSignalMetricContext({ fingerprint: fp, exampleMessage: raw, levels: ['warn'], sources: ['web-search'] });
      expect(ctx.acceptanceMetricSource).toBe(AUTOFILER_DEFAULT_METRIC_SOURCE);
      const metric = ctx.acceptanceMetric as AcceptanceMetric;
      expect(metric?.params?.messagePattern).toBeTruthy();
      // The acceptance bar: the pattern literally matches the raw row of its
      // own class — a measurable metric, never a vacuous one.
      expect(raw.toLowerCase()).toContain(String(metric.params.messagePattern).toLowerCase());
    }
  });

  // The class move above, asserted rather than assumed: the PDF shape now gets
  // NO bar and is FLAGGED (it keeps filing — only the metric decision changed).
  it('33005438/68200428: the PDF-fetch shape is now flagged, not bar-stamped', () => {
    const ctx = logSignalMetricContext({ fingerprint: S33005438_FP, exampleMessage: S33005438_RAW, levels: ['warn'], sources: ['web-search'] });
    expect(ctx.acceptanceMetric).toBeUndefined();
    expect(ctx.acceptanceMetricMissing).toBe(true);
    expect(ctx.acceptanceMetricDesignedObservability).toBe('websearch-pdf-fetch-target');
  });

  it('honest no-metric: a raw example whose variable text is ALL the fingerprint carries yields null, never a wrong-class pattern', () => {
    // Fingerprint fragment not in raw, and no raw run ≥16 chars that the
    // fingerprint also carries → null (the sweep files without a metric, the
    // pre-existing acceptanceMetricMissing path). This input reaches the NEW
    // raw-derivation branch (the fingerprint itself has no placeholders to
    // split on — the null comes from the candidate filter, review F3).
    expect(stableLiteralFragment('<n> <uuid> <hex>', 'x 42 f4350445-491b-4ab9-9bb0-f0c99d60ef12 deadbeefdeadbeef y')).toBeNull();
    expect(stableLiteralFragment('widget sync failed for the billing projector', 'completely unrelated text about ice cream vans and traffic cones 42')).toBeNull();
  });

  it('review F1: a REDACTED example never yields a pattern carrying the [REDACTED] marker — the rows the probe counts hold the secret verbatim', () => {
    // The sweep redacts the example before it reaches the metric builder,
    // but app_error_logs holds the SECRET verbatim (885614de scrubs at sweep
    // read time only). A pattern containing the marker would match ZERO rows
    // — the exact vacuous-metric class this fix kills. (The placeholder token
    // is deliberately NOT key-shaped: the invariant under test is the marker
    // split, not the secret's shape.)
    const redactedRaw = 'BrightData direct: search_engine failed:  api key [REDACTED: looked like a credential] rejected by upstream gateway';
    const unredactedRow = 'BrightData direct: search_engine failed:  api key not-a-real-secret-fixture-token-000000 rejected by upstream gateway';
    const fp = normalizeLogMessage('BrightData direct: search_engine failed:  api key not-a-real-secret-fixture-token-000000 rejected by upstream gateway');
    const frag = stableLiteralFragment(fp, redactedRaw);
    expect(frag).toBeTruthy();
    expect(String(frag)).not.toContain('[REDACTED');
    // The pattern matches the UNREDACTED row the probe will count.
    expect(unredactedRow.toLowerCase()).toContain(String(frag).toLowerCase());
  });

  it('review F2: two whitespace variants of ONE fingerprint both count — the pattern avoids the variant whitespace', () => {
    // The Docker shape's two raw spacings: a newline vs a space after the
    // exec error's closing paren. ONE fingerprint covers both; a pattern
    // carrying the example's newline would miss the space variant.
    const withNewline = 'coding container: Docker not available (Command failed: docker info --format {{.ServerVersion}}\n) — session commands fail closed until it answers; re-probing every 30 s';
    const withSpace = 'coding container: Docker not available (Command failed: docker info --format {{.ServerVersion}} ) — session commands fail closed until it answers; re-probing every 30 s';
    const fp = normalizeLogMessage(withNewline);
    const frag = stableLiteralFragment(fp, withNewline);
    expect(frag).toBeTruthy();
    expect(withNewline.toLowerCase()).toContain(String(frag).toLowerCase());
    expect(withSpace.toLowerCase()).toContain(String(frag).toLowerCase());
  });

  it('the fingerprints replayed here are the sweep\'s own normalizeLogMessage output (the pipeline stays one class)', () => {
    expect(normalizeLogMessage(AC626E4F_RAW)).toBe(AC626E4F_FP);
    expect(normalizeLogMessage(S78B4DC66_RAW)).toBe(S78B4DC66_FP);
    expect(normalizeLogMessage(S33005438_RAW)).toBe(S33005438_FP);
    // 658ecf0e: the sweep caps fingerprints at FINGERPRINT_MAX_LEN — the raw
    // message's normalized form starts with the stored fingerprint.
    expect(normalizeLogMessage(C58ECF0E_RAW).startsWith(C58ECF0E_FP)).toBe(true);
  });
});

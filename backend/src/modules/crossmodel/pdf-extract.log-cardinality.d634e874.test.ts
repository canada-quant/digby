/**
 * pdf-extract — WARN CARDINALITY on the rendered-pages OCR leg (ticket
 * d634e874, log-signal family fa9349ee).
 *
 * The defect, as the sweep saw it: 22 identical
 *   `pdf_ocr seat: api-optimize-zai-glm-5.3-flash (llm-cql (custom endpoint))
 *    failed — timeout of 90000ms exceeded`
 * rows in 24h, across 3 distinct hours. The emit site called
 * `warnSeatFailure` INSIDE the per-page `mapLimit`, so ONE slow document
 * against ONE slow provider wrote N rows for N failed pages — rows that carry
 * no page identity, so nothing in `app_error_logs` (or in the sweep's
 * fingerprint, which normalizes digits away) could distinguish "10 pages of one
 * document" from "10 documents". A 10-page statement against a provider whose
 * per-page budget (`OCR_PAGE_TIMEOUT_MS` = 90 000 — the `90000ms` in the live
 * message) is too small for a page image is the single most likely producer of
 * that shape, and it multiplies by page count.
 *
 * The fix keeps every property the pin
 * (`log-signal-family.3769b1b3.pin.test.ts`: "warnSeatFailure stays a bare
 * per-provider warn") requires — the message shape, the warn level, the fact
 * that a failing provider still produces a row on every document it fails —
 * and removes only the per-page multiplication: ONE warn per (document,
 * provider), with the failed-page COUNT and the first failing page moved onto
 * the adjacent summary line where they cost one row instead of N.
 *
 * These tests assert the CARDINALITY (how many rows, of what level, with what
 * content), which is exactly what the log-signal sweep counts.
 */

const mockSeatCompletion: jest.Mock = jest.fn();
const mockWarnSeatFailure: jest.Mock = jest.fn();
jest.mock('./seat-call', () => ({
  __esModule: true,
  seatCompletion: (...a: any[]) => mockSeatCompletion(...a),
  warnSeatFailure: (...a: any[]) => mockWarnSeatFailure(...a),
  seatProviderChain: jest.fn(),
  providerKeyMissing: jest.fn(() => null),
  imageUrlPart: (mime: string, b64: string) => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }),
}));

const mockInfo: jest.Mock = jest.fn();
const mockWarn: jest.Mock = jest.fn();
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: (...a: any[]) => mockInfo(...a), warn: (...a: any[]) => mockWarn(...a), error: jest.fn(), debug: jest.fn() },
}));

// The sweep service is imported BELOW for its REAL `normalizeLogMessage`, so
// the fingerprint assertion tracks production instead of re-deriving it.
// Leaf mocks only, the same set the sibling family pin uses
// (log-signal-family.30dfad06.pin.test.ts:75-100): without them the module
// graph reaches `config/env`, whose parseEnv() calls `process.exit(1)` on a
// bare Jest worker — an uncatchable process kill, not a throw (reproduced
// 2026-11-07: bare import → `● process.exit called with "1"`; with these four
// mocks → green). Mocking the leaf deps is the requirement, NOT avoiding the
// import — an earlier revision of this file wrongly claimed the import was
// impossible and hand-rolled the normalizer, which silently dropped both
// `redactSweepSignal` and the FINGERPRINT_MAX_LEN cut (review finding B/C).
jest.mock('../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn() } }));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), recordPlatformLoopMetric: jest.fn() }));

import { ocrPagesWithProvider } from './pdf-extract';
import { normalizeLogMessage } from './fleet/log-signal-sweep.service';

/** The seat that actually serves prod's PDF reader (a CUSTOM ENDPOINT, so it
 *  takes the rendered-pages path — `providerTakesPdfNatively` excludes
 *  '(custom endpoint)'). */
const PROVIDER: any = {
  model: 'api-optimize-zai-glm-5.3-flash',
  label: 'llm-cql (custom endpoint)',
  url: 'https://llm.cql.ca/v1/chat/completions',
  apiKey: 'k',
  supportsVision: true,
};

const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, png: Buffer.from(`page-${i + 1}`) }));
const ok = (text: string) => ({ text, reasoning: '', toolCalls: [], finishReason: 'stop', hadReasoning: false });
const timeout = () => Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('d634e874 — one warn per document+provider, never one per page', () => {
  it('a 10-page document where EVERY page times out writes ONE seat-failure row, not ten', async () => {
    mockSeatCompletion.mockRejectedValue(timeout());

    const out = await ocrPagesWithProvider(PROVIDER, pages(10), 'statement.pdf');

    expect(out).toBe('');
    // THE FIX: exactly one warnSeatFailure for the whole document.
    expect(mockWarnSeatFailure).toHaveBeenCalledTimes(1);
    expect(mockSeatCompletion).toHaveBeenCalledTimes(10); // every page WAS still attempted
  });

  it('the single emitted row keeps the exact shape the sweep fingerprints', async () => {
    mockSeatCompletion.mockRejectedValue(timeout());
    await ocrPagesWithProvider(PROVIDER, pages(4), 'x.pdf');

    const [role, provider, err] = mockWarnSeatFailure.mock.calls[0];
    expect(role).toBe('pdf_ocr');
    expect(provider).toBe(PROVIDER);
    // The FIRST error is the one reported — not the last, not a synthesized one.
    expect(err?.code).toBe('ECONNABORTED');
  });

  it('a PARTIAL failure writes one warn plus one bounded summary carrying the count and first page', async () => {
    mockSeatCompletion
      .mockRejectedValueOnce(timeout()) // page 1 fails
      .mockResolvedValueOnce(ok('page two'))
      .mockResolvedValueOnce(ok('page three'));

    const out = await ocrPagesWithProvider(PROVIDER, pages(3), 'invoice.pdf');

    expect(mockWarnSeatFailure).toHaveBeenCalledTimes(1);
    // The surviving pages are kept (the failed one contributes an empty
    // transcript, so only assert on the GOOD pages — the exact separator run
    // is pre-existing join behaviour, not what this ticket is about).
    expect(out).toContain('page two');
    expect(out).toContain('page three');
    expect(out).not.toContain('page one');
    const summary = mockWarn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('page(s) of invoice.pdf'));
    expect(summary).toBeDefined();
    expect(summary).toContain('1/3 page(s) of invoice.pdf failed');
    expect(summary).toContain('first: page 1');
  });

  it('a FULL failure records the extent ONCE, at info — the warn already carries the defect', async () => {
    mockSeatCompletion.mockRejectedValue(timeout());
    await ocrPagesWithProvider(PROVIDER, pages(5), 'scan.pdf');

    const all = mockWarn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('page(s) of scan.pdf'));
    // The partial summary must NOT fire on a total failure (it would claim
    // "the rest of the document is kept" when nothing was kept).
    expect(all).toBeUndefined();
    const extent = mockInfo.mock.calls.map((c) => String(c[0])).find((m) => m.includes('all 5 page(s) of scan.pdf'));
    expect(extent).toBeDefined();
    expect(extent).toContain('first: page 1');
    expect(mockWarnSeatFailure).toHaveBeenCalledTimes(1);
  });

  it('a clean multi-page document writes NO failure row at all', async () => {
    mockSeatCompletion.mockResolvedValue(ok('text'));
    const out = await ocrPagesWithProvider(PROVIDER, pages(3), 'ok.pdf');

    expect(out).toBe('text\n\n---\n\ntext\n\n---\n\ntext');
    expect(mockWarnSeatFailure).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('two DIFFERENT documents each get their own row — the record is preserved per document', async () => {
    mockSeatCompletion.mockRejectedValue(timeout());
    await ocrPagesWithProvider(PROVIDER, pages(3), 'a.pdf');
    await ocrPagesWithProvider(PROVIDER, pages(3), 'b.pdf');

    // Two documents failing = two rows: the fix removes per-PAGE multiplication,
    // not the per-document evidence that this seat is flapping.
    expect(mockWarnSeatFailure).toHaveBeenCalledTimes(2);
  });

  it('an empty/blank page response still fails the page without a seat warn', async () => {
    mockSeatCompletion
      .mockResolvedValueOnce(ok('')) // blank transcription — counted as failed
      .mockResolvedValueOnce(ok('good'));

    const out = await ocrPagesWithProvider(PROVIDER, pages(2), 'blank.pdf');

    expect(out).toContain('good');
    // No thrown error → no seat-failure row (that row describes a provider
    // failure, not an empty transcription).
    expect(mockWarnSeatFailure).not.toHaveBeenCalled();
    expect(mockWarn.mock.calls[0][0]).toContain('1/2 page(s) of blank.pdf failed');
  });

  it('the emitted message still matches the live prod fingerprint under the sweep normalizer', async () => {
    mockSeatCompletion.mockRejectedValue(timeout());
    await ocrPagesWithProvider(PROVIDER, pages(2), 'z.pdf');

    // BOTH ends are real production code: the seat-call renderer
    // (requireActual — the fix calls it) and the sweep's own
    // `normalizeLogMessage` (imported at the top with its leaf deps mocked).
    // A hand-rolled re-render + hand-rolled normalization would stay green
    // while the renderer, the redaction, or the fingerprint cap drifted
    // (review findings B and C on the first version of this file).
    const actualSeatCall = jest.requireActual('./seat-call');
    const EXPECTED = 'pdf_ocr seat: api-optimize-zai-glm-<n>-flash (llm-cql (custom endpoint)) failed — timeout of <n>ms exceeded';

    // ...the renderer the FIX actually calls produces this fingerprint...
    const [role, provider, err] = mockWarnSeatFailure.mock.calls[0];
    expect(role).toBe('pdf_ocr');
    expect(provider).toBe(PROVIDER);
    expect(normalizeLogMessage(`pdf_ocr seat: ${provider.model} (${provider.label}) failed — ${actualSeatCall.describeSeatError(err)}`)).toBe(EXPECTED);

    // ...and so does the live prod message shape (90000ms), through the REAL
    // normalizer — so this tracks `redactSweepSignal`, the digit collapse, the
    // lowercase and the FINGERPRINT_MAX_LEN cut all at once.
    expect(normalizeLogMessage(`pdf_ocr seat: ${PROVIDER.model} (${PROVIDER.label}) failed — ${actualSeatCall.describeSeatError(timeout())}`)).toBe(EXPECTED);

    // FINDING C, made executable: the fingerprint must fit under the sweep's
    // cap. A future cap cut below this length would silently change the class
    // the ticket is keyed on while a bare `toBe` on the string still passed —
    // so assert the length explicitly (107 chars at the time of writing).
    expect(EXPECTED.length).toBe(107);
    expect(EXPECTED.length).toBeLessThanOrEqual(120);
  });
});
/**
 * PIN (FO firing 8, 2026-09-23): recordExtractionOutcome must actually PERSIST
 * the fields its callers pass — budgetTokens in particular.
 *
 * The incident this pins: PR #993 (squash 8c052480) taught the project extractor
 * to pass `budgetTokens: budget` in a spread, and its pin asserted the CALLER's
 * argument — but recordExtractionOutcome was mocked in that suite, and the real
 * function's inline type had no `budgetTokens` field, so TypeScript's
 * excess-property check was bypassed by the spread and the value was silently
 * dropped at the recorder. Live evidence: a full 4h window of probe reads showed
 * min_budget/max_budget NULL on all 52 'changed' rows
 * (scripts/framework-audit/verify-project-extraction.js, with_budget: 0 of 29).
 *
 * This suite imports the REAL recordExtractionOutcome (only the leaf telemetry
 * sink recordLoopMetric is mocked) so a signature/passthrough regression fails
 * here instead of surviving to production.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { MEMORY_EXTRACTION: 'memory_extraction', USER_MEMORY_MUTATION: 'user_memory_mutation' },
}));

import { recordExtractionOutcome, extractionDetailOf, EXTRACTION_DETAIL_MAX_CHARS } from './memory-audit';
import logger from '../../../utils/logger';

const lastRow = () => mockRecordLoopMetric.mock.calls[mockRecordLoopMetric.mock.calls.length - 1][0];
const lastMeta = () => lastRow().meta;

beforeEach(() => {
  mockRecordLoopMetric.mockClear();
});

describe('recordExtractionOutcome persists every caller field (firing-8 telemetry drop)', () => {
  test('budgetTokens lands in loop_metrics.meta — the field 8c052480 passed but the recorder dropped', () => {
    recordExtractionOutcome({ userId: 'u1', source: 'project', chatId: 'c1', outcome: 'changed', ms: 6802, budgetTokens: 7200 });
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    const row = mockRecordLoopMetric.mock.calls[0][0];
    expect(row.kind).toBe('memory_extraction');
    expect(row.value).toBe(6802);
    expect(row.meta.budgetTokens).toBe(7200); // THE dropped field
    expect(row.meta.source).toBe('project');
    expect(row.meta.outcome).toBe('changed');
  });

  test('a call WITHOUT budgetTokens writes no budgetTokens key (probe reads NULL by absence, not 0)', () => {
    recordExtractionOutcome({ userId: 'u1', source: 'project_brief', outcome: 'changed', ms: 20404, detail: '4 asks' });
    expect(lastMeta().budgetTokens).toBeUndefined();
    expect(lastMeta().detail).toBe('4 asks');
  });

  test('non-finite budgets are refused, finite ones kept', () => {
    recordExtractionOutcome({ userId: 'u1', source: 'project', outcome: 'changed', ms: 5, budgetTokens: Number.NaN });
    expect(lastMeta().budgetTokens).toBeUndefined();
    recordExtractionOutcome({ userId: 'u1', source: 'project', outcome: 'changed', ms: 5, budgetTokens: 4000 });
    expect(lastMeta().budgetTokens).toBe(4000);
  });

  test('detail is still carried and clamped to EXTRACTION_DETAIL_MAX_CHARS (260 since 2026-10-20 — 160 cut the tail off)', () => {
    recordExtractionOutcome({ userId: 'u1', source: 'project', outcome: 'parse_error', ms: 5, detail: 'x'.repeat(500) });
    expect(EXTRACTION_DETAIL_MAX_CHARS).toBe(260);
    expect(lastMeta().detail.length).toBe(260);
  });

  test('2026-10-20: a head + tail detail survives WHOLE — the truncation point (the tail) is no longer cut off', () => {
    // the logged shape: a pretty-printed profile echo cut mid-string at the output budget
    const raw = `{\n  "summary": "${'User asked about aquarium research programs. '.repeat(200)}`;
    const detail = extractionDetailOf(raw);
    recordExtractionOutcome({ userId: 'u1', source: 'profile', outcome: 'parse_error', ms: 7000, detail });
    expect(lastMeta().detail).toBe(detail); // was sliced to 160 — the tail after "…⟨N chars⟩…" never reached the row
    expect(lastMeta().detail.endsWith('aquarium research programs.')).toBe(true);
  });

  test('2026-10-20: the profile throttle / bounds fields persist, and only when set', () => {
    recordExtractionOutcome({ userId: 'u1', source: 'profile', outcome: 'changed', ms: 5, throttledSkips: 22, clampedFields: ['summary', 'preferences'] });
    expect(lastMeta().throttledSkips).toBe(22);
    expect(lastMeta().clampedFields).toEqual(['summary', 'preferences']);
    recordExtractionOutcome({ userId: 'u1', source: 'profile', outcome: 'changed', ms: 5, throttledSkips: 0, clampedFields: [] });
    expect(lastMeta().throttledSkips).toBeUndefined();
    expect(lastMeta().clampedFields).toBeUndefined();
  });

  test('2026-10-20: the warn line names the provider leg and finish reason (finish=length = a budget cut)', () => {
    const warn = (logger as any).warn as jest.Mock;
    warn.mockClear();
    recordExtractionOutcome({ userId: 'u1', source: 'profile', outcome: 'parse_error', ms: 7012, leg: 'deepseek', finishReason: 'length', detail: '{ "summary": "x' });
    expect(warn).toHaveBeenCalledWith('memory-audit: extraction parse_error (profile) for u1 after 7012 ms [deepseek finish=length]: { "summary": "x');
    recordExtractionOutcome({ userId: 'u1', source: 'profile', outcome: 'empty', ms: 5 });
    expect(warn).toHaveBeenLastCalledWith('memory-audit: extraction empty (profile) for u1 after 5 ms');
  });

  test('telemetry never throws (the contract the memory path relies on)', () => {
    // A throwing recordLoopMetric must be swallowed, not propagated — the
    // original contract. The budget field must not have weakened it.
    mockRecordLoopMetric.mockImplementationOnce(() => { throw new Error('db down'); });
    expect(() => recordExtractionOutcome({ userId: 'u1', source: 'project', outcome: 'changed', ms: 5, budgetTokens: 7200 })).not.toThrow();
  });
});

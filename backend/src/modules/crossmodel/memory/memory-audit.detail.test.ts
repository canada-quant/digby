jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: {} }));
import { extractionDetailOf } from './memory-audit';

describe('extractionDetailOf (2026-09-23 — fold/dream parse_error rows keep head AND tail)', () => {
  it('returns a short answer whole (whitespace collapsed)', () => {
    expect(extractionDetailOf('{ "a":\n 1 }')).toBe('{ "a": 1 }');
  });
  it('keeps head + tail with the length in the middle for a long answer', () => {
    const raw = '{"overview": "' + 'x'.repeat(900) + '", "notes": ["a"]';
    const d = extractionDetailOf(raw, 20);
    expect(d.startsWith('{"overview": "xxxxxx')).toBe(true); // n=20 → 14 chars of prefix + 6 x's
    expect(d.endsWith('"notes": ["a"]')).toBe(true);
    expect(d).toContain('chars');
  });
  it('tolerates null/undefined', () => {
    expect(extractionDetailOf(undefined)).toBe('');
  });
});

/**
 * audit 2026-10-08 W2-6 — boundary-aware clipping for worker reports and
 * cross-chat reads (lanes.md F7: every background report in the window was cut
 * at a hard 4,000 chars mid-word — "…**refetch-", "It was demonstr").
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));

import { clipAtBoundary, clippedTail, reportClipV2Disabled, workerReportCapChars, workerReportBudgetSentence, WORKER_REPORT_CAP_DEFAULT } from './report-clip';
import { buildWorkerSummary, workerEnvelopeInstruction, WORKER_ENVELOPE_INSTRUCTION } from './delegation';

/** A reviewer verdict shaped like the 679cf002 report: numbered findings, the verdict at the end. */
function reviewerReport(findings: number): string {
  const parts: string[] = ['# Independent review — 5 claims checked against the original request', ''];
  for (let i = 1; i <= findings; i++) {
    parts.push(`${i}. FAIL — finding ${i}: the change in backend/src/modules/crossmodel/coding/background-delegation.ts does not handle the late-post grace when the run closes before the worker settles. Evidence: the test at line ${100 + i} asserts the post lands, but the code path returns early. It was demonstrated with a probe that the report is dropped.`);
    parts.push('');
  }
  parts.push('VERDICT: FAIL on findings 2-6; finding 1 is a nit.');
  return parts.join('\n');
}

describe('clipAtBoundary', () => {
  it('REPLAY: the legacy hard 4,000 slice ends mid-word; the boundary cut never does', () => {
    const report = reviewerReport(14);
    expect(report.length).toBeGreaterThan(4_000);
    const legacy = report.slice(0, 4_000);
    expect(/[A-Za-z]$/.test(legacy)).toBe(true); // mid-word (the "It was demonstr" shape)
    const c = clipAtBoundary(report, 4_000);
    expect(c.text.length).toBeLessThanOrEqual(4_000);
    expect(c.text.length).toBeGreaterThanOrEqual(2_400); // ≥ 60 % of the cap kept
    expect(c.text.endsWith('dropped.')).toBe(true); // a whole finding — a paragraph boundary
    expect(c.omitted).toBe(report.length - c.text.length);
  });

  it('a text under the cap is untouched', () => {
    expect(clipAtBoundary('short report.', 4_000)).toEqual({ text: 'short report.', omitted: 0 });
  });

  it('falls back sentence → line → word → hard cut', () => {
    const sentences = `${'Alpha beta gamma. '.repeat(400)}`;
    const s = clipAtBoundary(sentences, 1_000);
    expect(s.text.endsWith('gamma.')).toBe(true);
    const words = `${'alpha beta '.repeat(400)}`;
    expect(clipAtBoundary(words, 1_000).text.endsWith('alpha') || clipAtBoundary(words, 1_000).text.endsWith('beta')).toBe(true);
    const blob = 'x'.repeat(5_000);
    expect(clipAtBoundary(blob, 1_000).text).toHaveLength(1_000);
  });

  it('the tail line names how to read the rest', () => {
    expect(clippedTail(1234, 'the FULL report is in .digby/session/worker-reports/r.md — read_file it')).toBe('\n\n(… 1234 more chars — the FULL report is in .digby/session/worker-reports/r.md — read_file it)');
  });

  it('caps + kill switch readers', () => {
    expect(workerReportCapChars({})).toBe(WORKER_REPORT_CAP_DEFAULT);
    expect(workerReportCapChars({ WORKER_REPORT_CAP_CHARS: '500' })).toBe(2_000);
    expect(workerReportCapChars({ WORKER_REPORT_CAP_CHARS: '999999' })).toBe(60_000);
    expect(workerReportCapChars({ WORKER_REPORT_CAP_CHARS: 'abc' })).toBe(WORKER_REPORT_CAP_DEFAULT);
    expect(reportClipV2Disabled({})).toBe(false);
    expect(reportClipV2Disabled({ REPORT_CLIP_V2_DISABLED: '1' })).toBe(true);
    expect(workerReportBudgetSentence(12_000)).toContain('under 12000 characters');
  });
});

describe('buildWorkerSummary (W2-6)', () => {
  afterEach(() => { delete process.env.REPORT_CLIP_V2_DISABLED; delete process.env.WORKER_REPORT_CAP_CHARS; });

  it('a long report keeps up to the 12,000 cap, cut at a boundary, with the rest hint', () => {
    const report = reviewerReport(60);
    const ws = buildWorkerSummary(`${report}\n\`\`\`json\n{"status":"done"}\n\`\`\``, 'FALLBACK', { restHint: 'the FULL report is in .digby/session/worker-reports/x.md — read_file it' });
    expect(ws.status).toBe('done');
    const body = ws.summary.split('\n\n[WORKER STATUS')[0];
    expect(body.length).toBeLessThan(12_200);
    expect(body).toContain('finding 6:'); // pre-fix: findings 2-6 were elided at 4,000
    expect(body).toMatch(/\(… \d+ more chars — the FULL report is in \.digby\/session\/worker-reports\/x\.md — read_file it\)$/);
    expect(ws.summary).toContain('[WORKER STATUS: done]');
  });

  it('a short report is byte-identical to before', () => {
    expect(buildWorkerSummary('Did the thing.', 'FB').summary).toBe('Did the thing.');
  });

  it('REPORT_CLIP_V2_DISABLED=1 restores the hard 4,000 slice and the bare contract', () => {
    process.env.REPORT_CLIP_V2_DISABLED = '1';
    const report = reviewerReport(60);
    expect(buildWorkerSummary(report, 'FB').summary).toBe(report.slice(0, 4000));
    expect(workerEnvelopeInstruction()).toBe(WORKER_ENVELOPE_INSTRUCTION);
  });

  it('workers are told the budget', () => {
    expect(workerEnvelopeInstruction()).toContain(WORKER_ENVELOPE_INSTRUCTION);
    expect(workerEnvelopeInstruction()).toContain('under 12000 characters');
  });
});

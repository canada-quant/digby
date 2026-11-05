/** The evidence loader picks the v2 query by default and the v1 one under MODEL_EVIDENCE_V2_DISABLED=1 (roster 2026-10-06 C-2). */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockQuery = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { $queryRawUnsafe: (...a: any[]) => mockQuery(...a) } }));
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null) }));

import { loadModelEvidence, __resetModelEvidenceForTests, PROD_EVIDENCE_SQL_V2, PROD_EVIDENCE_SQL_V2_LANES } from './model-evidence';

describe('loadModelEvidence', () => {
  beforeEach(() => { __resetModelEvidenceForTests(); mockQuery.mockReset(); delete process.env.MODEL_EVIDENCE_V2_DISABLED; delete process.env.MODEL_EVIDENCE_LANE_MERGE_DISABLED; });

  it('v2 by default: the v2 query, a v2 snapshot with the lanes\' tool rates', async () => {
    mockQuery.mockResolvedValue([{ model: 'glm-5.3', lane: null, preset: 'thinking', n: 19, p50: 82975, p90: 248706, no_answer: 0, tool_n: 19, tool_mean: 1.1 }]);
    const s = await loadModelEvidence();
    // audit 2026-10-08 W4-1b: the lane-merged variant by default (one percentile per (model, lane)).
    expect(mockQuery.mock.calls[0][0]).toBe(PROD_EVIDENCE_SQL_V2_LANES);
    expect(mockQuery.mock.calls[0].slice(1)).toEqual(['14', 'claudebot@digby.ai']);
    expect(s.v2).toBe(true);
    expect(s.prod?.['glm-5.3']?.checked).toMatchObject({ n: 19, toolN: 19, toolMean: 1.1 });
    expect(s.laneToolRates?.checked.measured).toBe(false); // 19 < 20
  });

  it('MODEL_EVIDENCE_LANE_MERGE_DISABLED=1 restores the lane + preset grouped v2 query (W4-1b kill switch)', async () => {
    process.env.MODEL_EVIDENCE_LANE_MERGE_DISABLED = '1';
    mockQuery.mockResolvedValue([]);
    await loadModelEvidence();
    expect(mockQuery.mock.calls[0][0]).toBe(PROD_EVIDENCE_SQL_V2);
  });

  it('the lane-merged SQL resolves the lane in SQL and groups on (model, lane) only', () => {
    expect(PROD_EVIDENCE_SQL_V2_LANES).toMatch(/WHEN u\.meta->>'preset' = 'thinking' THEN 'checked'/);
    expect(PROD_EVIDENCE_SQL_V2_LANES).toMatch(/NULL::text AS preset/);
    expect(PROD_EVIDENCE_SQL_V2_LANES).toMatch(/GROUP BY 1, 2$/);
    expect(PROD_EVIDENCE_SQL_V2_LANES).not.toMatch(/GROUP BY 1, 2, 3/);
    // everything else (guests in, supervisors out, the bench account out, tool counts) is the v2 query's
    expect(PROD_EVIDENCE_SQL_V2_LANES).toMatch(/LIKE 'anon-%'/);
    expect(PROD_EVIDENCE_SQL_V2_LANES).toMatch(/uu\.email <> \$2/);
    expect(PROD_EVIDENCE_SQL_V2_LANES).toMatch(/kind = 'chat_search_usage'/);
  });

  it('MODEL_EVIDENCE_V2_DISABLED=1: the previous query (guests out) and a v1 snapshot', async () => {
    process.env.MODEL_EVIDENCE_V2_DISABLED = '1';
    mockQuery.mockResolvedValue([]);
    const s = await loadModelEvidence();
    expect(mockQuery.mock.calls[0][0]).not.toBe(PROD_EVIDENCE_SQL_V2);
    expect(mockQuery.mock.calls[0][0]).toMatch(/'guest'/);
    expect(s.v2).toBeUndefined();
  });
});

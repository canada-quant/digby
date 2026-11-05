/**
 * scripts/framework-audit/backfill-decision-gate-spend.js — the owner's
 * 2026-09-28 "add jev to api costs" history backfill, on a MOCKED Prisma
 * client + the REAL price module: dry-run by default (counts + the USD it
 * would mint, no writes), --apply inserts run_tokens_in + run_spend with the
 * decision row's own createdAt, memo hits / error rows / rows without usage
 * are skipped, and a decision id that already has a run_spend row is never
 * minted twice (idempotent).
 */
import path from 'path';
import * as pricing from '../modules/crossmodel/platform/decision-gate-pricing';

jest.mock('../modules/crossmodel/platform/loop-metrics.service', () => ({ LOOP_METRIC_KINDS: {}, recordLoopMetric: jest.fn(), recordLoopMetrics: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'backfill-decision-gate-spend.js'));

type Row = { id: string; kind: string; sessionId: string | null; value: number | null; meta: any; createdAt: Date };

function makePrisma(rows: Row[]) {
  const inserted: any[] = [];
  const prisma: any = {
    rows, inserted,
    loopMetric: {
      findMany: jest.fn(async ({ where, take }: any) => {
        let out = rows.filter((r) => r.kind === where.kind && r.createdAt >= where.createdAt.gte);
        out = out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (typeof take === 'number') out = out.slice(0, take);
        return out;
      }),
      createMany: jest.fn(async ({ data }: any) => { inserted.push(...data); return { count: data.length }; }),
    },
  };
  return prisma;
}

const NOW = '2026-09-28T12:00:00.000Z';
const t = (h: number) => new Date(Date.parse(NOW) - h * 3600_000);
const jevRow = (id: string, extra: Record<string, unknown> = {}, hoursAgo = 2, sessionId: string | null = 'chat-1'): Row => ({
  id: `lm-${id}`, kind: 'decision_gate', sessionId, value: 164, createdAt: t(hoursAgo),
  meta: { phase: 'decision', id, purpose: 'wake_triage', mode: 'act', ok: true, backend: 'TypeSafe Jev', backendSpec: 'jev', backendKind: 'systemone', modelId: 'jev-1.13.0', inputTokens: 2750, ...extra },
});

describe('backfill-decision-gate-spend.js', () => {
  it('dry run: selects answered non-memo rows with usage, prices them at the live table, writes nothing', async () => {
    const prisma = makePrisma([
      jevRow('aaaa0001'),
      jevRow('aaaa0002', { cached: true, cachedFrom: 'aaaa0001' }),           // memo hit — no call
      jevRow('aaaa0003', { ok: false, error: 'HTTP 500' }),                    // error row — nothing billed
      jevRow('aaaa0004', { inputTokens: undefined }),                          // no usage — nothing to estimate from
      jevRow('aaaa0005', { purpose: 'auto_route', backend: 'DeepSeek logprob readout', backendSpec: 'deepseek-flash', backendKind: 'logit', modelId: 'deepseek-chat', inputTokens: 1200 }),
      jevRow('aaaa0006', { phase: 'outcome', actual: true }),                  // outcome row — never a call
      jevRow('aaaa0007', {}, 24 * 20),                                          // outside the 14-day window
      jevRow('aaaa0008', { challenger: true, primaryId: 'aaaa0001' }, 2, null), // challenger, no session → synthetic
    ]);
    const report = await script.run({ prisma, pricing, argv: [], now: NOW });
    expect(report).toMatchObject({ dryRun: true, apply: false, days: 14, decisionRows: 7, toMint: 3, skippedNoUsage: 4, skippedExisting: 0, wouldInsert: 6 });
    expect(report.byBackend).toEqual({ 'TypeSafe Jev': 2, 'DeepSeek logprob readout': 1 });
    expect(report.byPurpose).toEqual({ wake_triage: 2, auto_route: 1 });
    expect(report.byModel).toEqual({ 'jev-1.13.0': 2, 'deepseek-flash': 1 });
    expect(report.inputTokens).toBe(2750 * 2 + 1200);
    expect(report.usd).toBeCloseTo((2750 * 2 * 0.042 + 1200 * 0.15) / 1_000_000, 9);
    expect(prisma.loopMetric.createMany).not.toHaveBeenCalled();
  });

  it('--apply inserts run_tokens_in + run_spend per decision with the decision row createdAt / runId dg-<id> / the served session, and is idempotent on meta.decisionId', async () => {
    const rows: Row[] = [jevRow('bbbb0001'), jevRow('bbbb0002', { purpose: 'sweep_triage' }, 5, null)];
    const prisma = makePrisma(rows);
    const first = await script.run({ prisma, pricing, argv: ['--apply', '--run', 'r1'], now: NOW });
    expect(first).toMatchObject({ apply: true, toMint: 2, inserted: 4 });
    expect(prisma.inserted).toHaveLength(4);
    // Rows are minted oldest-first (the read is ordered by createdAt asc); pick by runId, not position.
    const tin = prisma.inserted.find((r: any) => r.kind === 'run_tokens_in' && r.runId === 'dg-bbbb0001');
    const spend = prisma.inserted.find((r: any) => r.kind === 'run_spend' && r.runId === 'dg-bbbb0001');
    expect(tin).toMatchObject({ kind: 'run_tokens_in', sessionId: 'chat-1', runId: 'dg-bbbb0001', value: 2750, unit: 'tokens', createdAt: rows[0].createdAt });
    expect(tin.meta).toMatchObject({ model: 'jev-1.13.0', provider: 'typesafe', profile: 'decision', purpose: 'wake_triage', backend: 'TypeSafe Jev', backendSpec: 'jev', decisionId: 'bbbb0001', estimated: false, backfill: 'r1' });
    expect(spend).toMatchObject({ kind: 'run_spend', unit: 'usd', runId: 'dg-bbbb0001', createdAt: rows[0].createdAt });
    expect(spend.value).toBeCloseTo(2750 * 0.042 / 1_000_000, 12);
    expect(spend.meta).toMatchObject({ models: ['jev-1.13.0'], inTokens: 2750, outTokens: 0, priceSource: 'list', usdPerMTokIn: 0.042, usdPerMTokOut: 0, ms: 164, backfill: 'r1' });
    expect(prisma.inserted.find((r: any) => r.kind === 'run_spend' && r.runId === 'dg-bbbb0002')).toMatchObject({ sessionId: 'decision-gate', createdAt: rows[1].createdAt });
    // Second run: the inserted run_spend rows are now in the table → both ids skipped, nothing written.
    rows.push(...prisma.inserted.map((r: any, i: number) => ({ id: `ins-${i}`, kind: r.kind, sessionId: r.sessionId, value: r.value, meta: r.meta, createdAt: r.createdAt })));
    prisma.loopMetric.createMany.mockClear();
    const second = await script.run({ prisma, pricing, argv: ['--apply'], now: NOW });
    expect(second).toMatchObject({ toMint: 0, skippedExisting: 2, inserted: 0 });
    expect(prisma.loopMetric.createMany).not.toHaveBeenCalled();
  });

  it('--limit caps the decision rows read; --days clamps at 30; a registry spec prices self-hosted $0 (unpriced counted); pre-spec rows resolve from the label', async () => {
    const prisma = makePrisma([
      jevRow('cccc0001', { backendSpec: 'cql-litellm:agx-laya', backend: 'cql-litellm (systemone chat)', modelId: 'agx-laya' }),
      jevRow('cccc0002', { backendSpec: undefined, backendKind: undefined, modelId: undefined }), // 2026-09-25-era row: label only
      jevRow('cccc0003'),
    ]);
    const r = await script.run({ prisma, pricing, argv: ['--limit', '2', '--days', '99'], now: NOW });
    expect(r).toMatchObject({ days: 30, decisionRows: 2, toMint: 2, unpricedRows: 1 });
    expect(r.byModel).toEqual({ 'cql-litellm:agx-laya': 1, 'jev-1.13.0': 1 });
    expect(script.spendModelOf({ backend: 'DeepSeek logprob readout' }, pricing)).toBe('deepseek-flash');
    expect(script.spendModelOf({ backendSpec: 'jev', modelId: 'jev-1.14.0' }, pricing)).toBe('jev-1.14.0');
  });

  it('usage errors are refused before any read', async () => {
    const prisma = makePrisma([]);
    await expect(script.run({ prisma, pricing, argv: ['--bogus'] })).rejects.toThrow(/unknown argument/);
    await expect(script.run({ prisma, pricing, argv: ['--days', '0'] })).rejects.toThrow(/--days must/);
    expect(prisma.loopMetric.findMany).not.toHaveBeenCalled();
    expect(script.parseArgs(['--apply', '--batch=50', '--run=x'])).toMatchObject({ apply: true, batch: 50, run: 'x' });
  });
});

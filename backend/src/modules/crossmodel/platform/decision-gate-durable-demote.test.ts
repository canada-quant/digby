jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));

import { durableActBandWindows, runDurableActBandDemote } from './decision-gate-durable-demote';

const out = (purpose: string, agreed: boolean, over: any = {}) => ({
  createdAt: new Date('2026-10-01T00:00:00Z'),
  meta: { phase: 'outcome', purpose, mode: 'act', inActBand: true, agreed, question: 'needs_turn_now', label: undefined, ...over },
});

describe('durable act-band auto-demote (2026-10-04)', () => {
  afterEach(() => { delete process.env.DECISION_GATE_DURABLE_DEMOTE_DISABLED; delete process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N; });

  it('rebuilds the act-period window from persisted outcome rows — admitting only what noteActBandOutcome admits', () => {
    const rows = [
      out('wake_triage', true), out('wake_triage', false),
      out('wake_triage', true, { mode: 'shadow' }),          // shadow-era: never counts
      out('wake_triage', true, { inActBand: false }),        // outside the band
      out('wake_triage', true, { challenger: true }),        // a challenger's row
      out('wake_triage', true, { excludeFromFit: true }),    // excluded
      out('wake_triage', true, { agreed: undefined }),       // unlabelled
      out('sweep_triage', false),                            // another purpose (not asked for)
    ];
    const w = durableActBandWindows(rows as any, new Set(['wake_triage']));
    expect(w.get('wake_triage')).toEqual({ n: 2, k: 1, since: '2026-10-01T00:00:00.000Z' });
    expect(w.has('sweep_triage')).toBe(false);
  });

  it('keeps the newest 100 labels per purpose', () => {
    const rows = [...Array.from({ length: 50 }, () => out('wake_triage', false)), ...Array.from({ length: 100 }, () => out('wake_triage', true))];
    expect(durableActBandWindows(rows as any, new Set(['wake_triage'])).get('wake_triage')).toMatchObject({ n: 100, k: 100 });
  });

  it('REPLAYS the 2026-10-04 readout: 23/35 in act (bar 0.85) breaches and goes through the SAME demote writer; a healthy purpose does not', async () => {
    const rows = [
      ...Array.from({ length: 23 }, () => out('wake_triage', true)), ...Array.from({ length: 12 }, () => out('wake_triage', false)),
      ...Array.from({ length: 40 }, () => out('sweep_triage', true)),
    ];
    const demote = jest.fn(async () => 'demoted' as const);
    const res = await runDurableActBandDemote(rows as any, ['wake_triage', 'sweep_triage'], demote as any);
    expect(res).toEqual([expect.objectContaining({ purpose: 'wake_triage', n: 35, outcome: 'demoted' })]);
    expect((demote.mock.calls[0] as any)[1]).toMatchObject({ n: 35, windowSince: '2026-10-01T00:00:00.000Z' });
  });

  it('fewer than the minimum act-period labels never demotes; a purpose not in act is never touched; the kill switch stops it', async () => {
    const few = Array.from({ length: 10 }, () => out('wake_triage', false));
    const demote = jest.fn(async () => 'demoted' as const);
    expect(await runDurableActBandDemote(few as any, ['wake_triage'], demote as any)).toEqual([]);
    const many = Array.from({ length: 40 }, () => out('wake_triage', false));
    expect(await runDurableActBandDemote(many as any, [], demote as any)).toEqual([]);
    process.env.DECISION_GATE_DURABLE_DEMOTE_DISABLED = '1';
    expect(await runDurableActBandDemote(many as any, ['wake_triage'], demote as any)).toEqual([]);
    expect(demote).not.toHaveBeenCalled();
  });
});

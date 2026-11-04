/**
 * audit 2026-10-08 W3-7 (plumbing F7): an ACT purpose whose decisions are
 * almost never labelled can never be auto-demoted — the label floor makes it
 * NOT READY at admission and demotes it in the durable pass.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  actBandLabelCoverage, labelFloorBreach, applyLabelFloorToStamp, LABEL_FLOOR_DEFAULT, LABEL_FLOOR_MIN_N_DEFAULT,
} from './decision-gate-label-floor';
import { runDurableActBandDemote } from './decision-gate-durable-demote';
import type { DecisionGateRow } from './decision-gate-fit';

/** One outcome row the way decision-gate.ts writes it (phase outcome, act question, in band). */
const outcome = (purpose: string, question: string, i: number, extra: Record<string, unknown> = {}): DecisionGateRow => ({
  meta: { phase: 'outcome', purpose, question, mode: 'act', inActBand: true, id: `${purpose}-${i}`, ...extra },
  createdAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000),
} as any);

/** REPLAY of the 10-08 prod read: imessage_send in act — 180 IN-BAND act decisions in 7 d, NONE labelled
 *  (the audit's 11 labelled rows sat outside the band), plus 11 labelled out-of-band rows that must not count. */
const imessageRows = (): DecisionGateRow[] => [
  ...Array.from({ length: 180 }, (_, i) => outcome('imessage_send', 'send', i, { actual: null })),
  ...Array.from({ length: 11 }, (_, i) => outcome('imessage_send', 'send', 500 + i, { inActBand: false, agreed: i < 6, actual: true })),
];
/** sweep_triage: 20 % labelled (its control sample) — above the floor, must NOT trip. */
const sweepRows = (): DecisionGateRow[] => Array.from({ length: 200 }, (_, i) => outcome('sweep_triage', 'needs_turn_now', i, i % 5 === 0 ? { agreed: true, actual: false } : { actual: null }));
/** wake_triage in act: 724 in-band act decisions, ~9 % labelled throughout (its 1-in-10 control wakes) — governable, must NOT trip. */
const wakeRows = (): DecisionGateRow[] => Array.from({ length: 724 }, (_, i) => outcome('wake_triage', 'needs_turn_now', i, i % 11 === 0 ? { agreed: true, actual: false } : { actual: null }));

afterEach(() => {
  delete process.env.DECISION_GATE_ACT_LABEL_FLOOR_DISABLED;
  delete process.env.DECISION_GATE_ACT_LABEL_FLOOR;
});

describe('label floor (audit 2026-10-08 W3-7)', () => {
  it('measures coverage over in-band act-question rows; challengers and out-of-band rows do not count', () => {
    const rows = [
      ...imessageRows(),
      outcome('imessage_send', 'send', 900, { challenger: true, agreed: true }),
      outcome('imessage_send', 'send', 901, { inActBand: false, agreed: true }),
      outcome('imessage_send', 'other_question', 902, { agreed: true }),
    ];
    const c = actBandLabelCoverage(rows).get('imessage_send')!;
    expect(c).toMatchObject({ total: 180, labelled: 0, coverage: 0 });
    expect(LABEL_FLOOR_DEFAULT).toBe(0.05);
    expect(LABEL_FLOOR_MIN_N_DEFAULT).toBe(100);
  });

  it('REPLAY imessage_send: 0/180 in-band labels breaches the floor; sweep_triage (20 %) and wake_triage (9.3 %) do not; too few decisions never judge', () => {
    expect(labelFloorBreach(actBandLabelCoverage(imessageRows()).get('imessage_send'))).toMatch(/0\.0% \(0\/180 in-band decisions labelled\) is under the 5% floor/);
    expect(labelFloorBreach(actBandLabelCoverage(sweepRows()).get('sweep_triage'))).toBeNull();
    expect(labelFloorBreach(actBandLabelCoverage(wakeRows()).get('wake_triage'))).toBeNull();
    expect(labelFloorBreach(actBandLabelCoverage(imessageRows().slice(0, 60)).get('imessage_send'))).toBeNull(); // < 100 decisions
    expect(labelFloorBreach(actBandLabelCoverage(wakeRows()).get('wake_triage'), { DECISION_GATE_ACT_LABEL_FLOOR: '0.1' })).toMatch(/under the 10% floor/);
  });

  it('ADMISSION: the stamp goes NOT READY with the floor named first (other purposes untouched)', () => {
    const stamp = {
      imessage_send: { ready: true, reasons: [] as string[] },
      sweep_triage: { ready: true, reasons: [] as string[] },
    };
    const out = applyLabelFloorToStamp(stamp, [...imessageRows(), ...sweepRows()], {});
    expect(out.imessage_send.ready).toBe(false);
    expect(out.imessage_send.reasons[0]).toMatch(/label coverage 0\.0%/);
    expect(out.imessage_send.labelCoverage).toBe(0);
    expect(out.sweep_triage.ready).toBe(true);
    expect(applyLabelFloorToStamp(stamp, imessageRows(), { DECISION_GATE_ACT_LABEL_FLOOR_DISABLED: '1' })).toBe(stamp);
  });

  it('DURABLE DEMOTE: an act purpose under the floor is demoted with reason label_floor; the kill switch skips it', async () => {
    const demote = jest.fn(async () => 'demoted' as const);
    const out = await runDurableActBandDemote([...imessageRows(), ...sweepRows(), ...wakeRows()], ['imessage_send', 'sweep_triage', 'wake_triage'], demote as any);
    expect(out).toEqual([expect.objectContaining({ purpose: 'imessage_send', reason: 'label_floor', outcome: 'demoted', n: 0 })]);
    expect(demote).toHaveBeenCalledWith('imessage_send', expect.objectContaining({ reason: 'label_floor', decisions: 180, n: 0, labelCoverage: 0 }));
    process.env.DECISION_GATE_ACT_LABEL_FLOOR_DISABLED = '1';
    demote.mockClear();
    expect(await runDurableActBandDemote(imessageRows(), ['imessage_send'], demote as any)).toEqual([]);
    expect(demote).not.toHaveBeenCalled();
  });

  it('the demote seam counts ACT-mode decisions only (shadow-era unlabelled rows never demote an act purpose)', async () => {
    const shadowEra = imessageRows().map((r: any) => ({ ...r, meta: { ...r.meta, mode: 'shadow' } }));
    const demote = jest.fn(async () => 'demoted' as const);
    expect(await runDurableActBandDemote(shadowEra, ['imessage_send'], demote as any)).toEqual([]);
  });
});

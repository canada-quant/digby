/**
 * MISSION KPI CONTRACT + PREMISE HISTORY pins (tt-rd audit 2026-09-27,
 * kpi-honesty-loops findings 1 + 2a/2e). premise-register.ts:
 *  - a kpi: premise (key prefix or kind:'kpi') REQUIRES receiptId (400 with
 *    the rule text);
 *  - one kpi: premise per goal; the cap is 12;
 *  - a value change keeps prev + an oldest-first history ring (≤ 8); an
 *    unchanged value keeps its stamps; a
 *    receipt-less re-send of a receipted value keeps the receipt + setAt.
 * Boundary mocks mirror premise-register.test.ts (the module imports prisma/redis).
 */
const mockPrisma: any = { projectGoal: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) } };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { normalizePremise, normalizePremises, withHistory, PREMISE_MAX_PER_GOAL, PREMISE_HISTORY_MAX, KPI_RECEIPT_RULE, kpiReceiptRefusalKey, type GoalPremise } from './premise-register';

const T0 = new Date('2026-09-27T03:34:40Z');
const T1 = new Date('2026-09-27T13:22:15Z');
const RID_A = 'aaaa1111-2222-4000-8000-000000000000';
const RID_B = 'f5b42fe6-1111-4000-8000-000000000000';

describe('premise-register — mission KPI contract (finding 1)', () => {
  it('a kpi: premise without receiptId is refused with the rule text; with one it lands as kind:"kpi" with bar + receipt', () => {
    const refused = normalizePremise({ key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s' }, { now: T1 });
    expect(refused).toBe(KPI_RECEIPT_RULE('kpi:client_visible_e2e_tok_s'));
    expect(String(refused)).toContain('set ONLY from a this-wake run_command receipt id');
    expect(String(refused)).toContain('client_visible_e2e_tok_s:diag');
    const ok = normalizePremise({ key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', receiptId: 'F5B42FE6', bar: 10 }, { now: T1 });
    expect(ok).toEqual(expect.objectContaining({ kind: 'kpi', receiptId: 'f5b42fe6', bar: 10, value: 5.08 }));
    // kind:'kpi' on a plain key is the same contract
    expect(normalizePremise({ key: 'e2e', value: 5, kind: 'kpi' }, { now: T1 })).toBe(KPI_RECEIPT_RULE('e2e'));
    expect(normalizePremise({ key: 'e2e', value: 5, kind: 'other' }, { now: T1 })).toContain("kind must be 'kpi'");
    expect(normalizePremise({ key: 'kpi:e2e', value: 5, receiptId: 'abc' }, { now: T1 })).toContain('receiptId must be a receipt id');
    expect(normalizePremise({ key: 'kpi:e2e', value: 5, receiptId: RID_A, bar: 'ten' }, { now: T1 })).toContain('bar must be a finite number');
  });

  it('a non-KPI premise may carry a receiptId (optional) and needs no bar', () => {
    const p = normalizePremise({ key: 'read_wait_ms', value: 138, receiptId: RID_A }, { now: T1 });
    expect(p).toEqual(expect.objectContaining({ key: 'read_wait_ms', receiptId: RID_A }));
    expect((p as GoalPremise).kind).toBeUndefined();
  });

  it('a goal carries at most ONE kpi: premise (finding 2e); the cap is 12', () => {
    expect(PREMISE_MAX_PER_GOAL).toBe(12);
    const res = normalizePremises(
      [{ key: 'kpi:a', value: 1, receiptId: RID_A }, { key: 'kpi:b', value: 2, receiptId: RID_B }], [], { now: T1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('at most ONE kpi: premise');
    // …also across merge with an existing KPI under another key
    const existing = normalizePremises([{ key: 'kpi:a', value: 1, receiptId: RID_A }], [], { now: T0 });
    expect(existing.ok).toBe(true);
    const merged = normalizePremises([{ key: 'kpi:b', value: 2, receiptId: RID_B }], existing.ok ? existing.premises : [], { now: T1 });
    expect(merged.ok).toBe(false);
    const twelve = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, value: i }));
    expect(normalizePremises(twelve, [], { now: T1 }).ok).toBe(true);
    expect(normalizePremises([...twelve, { key: 'k12', value: 12 }], [], { now: T1 }).ok).toBe(false);
  });

  it('fixer follow-up 5: a KPI-contract refusal is TAGGED (kpiRefusal {reason, key}) so goals.service can record it; shape errors are not', () => {
    const noReceipt = normalizePremises([{ key: 'kpi:e2e', value: 5 }], [], { now: T1 });
    expect(noReceipt).toEqual({ ok: false, error: KPI_RECEIPT_RULE('kpi:e2e'), kpiRefusal: { reason: 'no_receipt', key: 'kpi:e2e' } });
    const second = normalizePremises([{ key: 'kpi:a', value: 1, receiptId: RID_A }, { key: 'kpi:b', value: 2, receiptId: RID_B }], [], { now: T1 });
    expect(second).toEqual({ ok: false, error: expect.stringContaining('at most ONE kpi: premise'), kpiRefusal: { reason: 'second_kpi', key: 'kpi:a, kpi:b' } });
    const shape = normalizePremises([{ key: 'kpi:e2e', value: 'nan', receiptId: RID_A }], [], { now: T1 });
    expect(shape.ok).toBe(false);
    expect((shape as any).kpiRefusal).toBeUndefined();
    expect(kpiReceiptRefusalKey(KPI_RECEIPT_RULE('kpi:client_visible_e2e_tok_s'))).toBe('kpi:client_visible_e2e_tok_s');
    expect(kpiReceiptRefusalKey('premise "x": value must be a finite number')).toBeNull();
    // the rule text now names WHERE the id is printed
    expect(KPI_RECEIPT_RULE('kpi:e2e')).toContain('the `id` on the receipt row get_run_receipts prints');
  });
});

describe('premise-register — value history (finding 2a)', () => {
  const first = () => {
    const r = normalizePremises([{ key: 'kpi:e2e', value: 5.364, unit: 'tok/s', receiptId: RID_A, bar: 10 }], [], { now: T0 });
    if (!r.ok) throw new Error(r.error);
    return r.premises;
  };

  it('a value change keeps prev {value, setAt, receiptId} and an oldest-first history ring', () => {
    const base = first();
    const r = normalizePremises([{ key: 'kpi:e2e', value: 2.464, unit: 'tok/s', receiptId: RID_B, bar: 10 }], base, { now: T1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.premises[0];
    expect(p.value).toBe(2.464);
    expect(p.setAt).toBe(T1.toISOString());
    expect(p.prev).toEqual({ value: 5.364, setAt: T0.toISOString(), receiptId: RID_A });
    expect(p.history).toEqual([{ value: 5.364, setAt: T0.toISOString(), receiptId: RID_A }]);
  });

  it('the ring is capped at PREMISE_HISTORY_MAX (oldest dropped)', () => {
    let prem = first();
    for (let i = 0; i < PREMISE_HISTORY_MAX + 3; i++) {
      const r = normalizePremises([{ key: 'kpi:e2e', value: 6 + i, receiptId: RID_B }], prem, { now: new Date(T1.getTime() + i * 60_000) });
      if (!r.ok) throw new Error(r.error);
      prem = r.premises;
    }
    const p = prem[0];
    expect(p.history).toHaveLength(PREMISE_HISTORY_MAX);
    expect(p.history![PREMISE_HISTORY_MAX - 1].value).toBe(6 + PREMISE_HISTORY_MAX + 1); // the last superseded value
    expect(p.prev!.value).toBe(6 + PREMISE_HISTORY_MAX + 1);
  });

  it('an unchanged value keeps its stamps; a receipt-less re-send of a receipted value (merge OR replace) inherits the receipt AND the measurement stamp (age = when measured) — the contract asks for a receipt per NEW reading, not per call', () => {
    const base = first();
    const r = normalizePremises([{ key: 'kpi:e2e', value: 5.364, unit: 'tok/s', bar: 10 }], base, { now: T1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.premises[0].receiptId).toBe(RID_A);
    expect(r.premises[0].setAt).toBe(T0.toISOString());
    expect(r.premises[0].prev).toBeUndefined();
    const replaced = normalizePremises([{ key: 'kpi:e2e', value: 5.364, unit: 'tok/s', bar: 10 }, { key: 'other', value: 1 }], base, { now: T1, mode: 'replace' });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(replaced.premises.find((p) => p.key === 'kpi:e2e')).toEqual(expect.objectContaining({ receiptId: RID_A, setAt: T0.toISOString() }));
    // a CHANGED value still needs its own receipt
    expect(normalizePremises([{ key: 'kpi:e2e', value: 6, unit: 'tok/s', bar: 10 }], base, { now: T1 })).toEqual({ ok: false, error: expect.stringContaining('set ONLY from a this-wake run_command receipt id'), kpiRefusal: { reason: 'no_receipt', key: 'kpi:e2e' } });
    // a FRESH receipt confirming the same value is a fresh reading: new stamp, new receipt, no history entry
    const r2 = normalizePremises([{ key: 'kpi:e2e', value: 5.364, unit: 'tok/s', bar: 10, receiptId: RID_B }], base, { now: T1 });
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.premises[0].receiptId).toBe(RID_B);
    expect(r2.premises[0].setAt).toBe(T1.toISOString());
    expect(r2.premises[0].prev).toBeUndefined();
  });

  it('withHistory carries an existing ring forward when only the reader changed', () => {
    const prev: GoalPremise = { key: 'k', value: 1, setAt: T0.toISOString(), prev: { value: 0, setAt: '2026-09-26T00:00:00.000Z' }, history: [{ value: 0, setAt: '2026-09-26T00:00:00.000Z' }] };
    const same = withHistory(prev, { key: 'k', value: 1, setAt: T1.toISOString(), source: 'https://example.com/x', jsonPath: 'a' });
    expect(same.prev).toEqual(prev.prev);
    expect(same.history).toEqual(prev.history);
  });
});

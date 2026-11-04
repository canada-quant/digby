/**
 * REPLAY PIN — ticket faeaa181-406b-499e-bdd2-809c8edd68f0 (mishap, breaker
 * trip 2026-11-01, lane b0667d94 session, run 741a5097, goal 79284e7f
 * "Measure post-change rerank p95 and embed…").
 *
 * A 3× tool-failure streak on goal_premise_set while registering a rerank p95
 * ceiling. The three filed failure texts, verbatim (newest first), replayed
 * below against the shipped guards:
 *
 *   · premise "rerank_p95_servable_ms": barDirection is a KPI-bar field —
 *     register it on the goal's 'kpi:' premise (kind:'kpi')
 *   · a goal carries at most ONE kpi: premise (got
 *     kpi:rerank_p95_servable_ms, kpi:embed_attempt_success_pct) — the
 *     of-record number has one key; every other rate registers under a
 *     non-kpi key
 *   · premise "kpi:rerank_p95_servable_ms:diag": a kpi: premise is the goal's
 *     ONE of-record number and is set ONLY from a this-wake run_command
 *     receipt id — pass receiptId …
 *
 * ADJUDICATION (this lane, 2026-11-02): SPLIT per leg, as the tool-failure-
 * streak doctrine requires.
 *
 *   GUARDS — CORRECT, unchanged, pinned below so a future "helpful" relaxation
 *   trips this suite. All three refusals are right on their merits: bar
 *   semantics live on the kpi: premise (every reader runs on `kpiPremiseOf`,
 *   which is kpi:/kind:'kpi' only, so `bar` AND `barDirection` are dead on a
 *   plain key); a goal carries exactly ONE kpi: premise; and the of-record
 *   number moves only on a cited receipt. Relaxing any of these would let a
 *   dead declaration or an uncited KPI onto the board.
 *
 *   THE REFUSAL TEXT — FRAMEWORK DEFECT, fixed here (the THIRD iteration of the
 *   af24badf class in premise-register: "NEVER advise a retry this same branch
 *   would refuse again"). The old text named ONE path — "register it on the
 *   goal's 'kpi:' premise" — and every attempt at that path dead-ended:
 *     (a) `kpi:rerank_p95_servable_ms:diag` is read as a SECOND KPI (the one-
 *         of-record rule) and, lacking a receipt, is refused AGAIN — the same
 *         dead end one level over, and the old text is what suggested the
 *         `<kpi key>:diag` spelling in the first place;
 *     (b) a second `kpi:` rate (`kpi:embed_attempt_success_pct`) is refused by
 *         the ONE-kpi cap whatever it is called;
 *     (c) the kpiAdviceCaveat that names (b) is reachable only through an
 *         ALREADY-registered kpi: — it inspects `existing`, never the call's own
 *         list — so on the first refusal of a run the text still reads as an
 *         instruction with no shape that lands.
 *   443fa1ee fixed the `target:` arm and deliberately left this arm alone ("a
 *   NON-target key keeps the original kpi: wording"). This ticket is that
 *   assumption's counter-example, so the text now teaches the placement that
 *   actually works (declare the bar on the goal's one kpi: premise and
 *   re-register that same key; or record the measurement as its own non-kpi
 *   key with the bar in the note) and says plainly what a plain key cannot do.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import { normalizePremise, normalizePremises, type GoalPremise } from './premise-register';
import { kpiBarMet, kpiBarText, kpiPremiseOf } from './kpi-of-record';

/** The goal 79284e7f register as the lane found it: a dead-attempt reading, NO kpi:. */
const GOAL_79284E7F: GoalPremise[] = [{ key: 'rerank_dead_attempt_ms', value: 9002, unit: 'ms' }];

/** The three payloads from the ticket, verbatim shape (newest first). */
const LEG_CEILING = { key: 'rerank_p95_servable_ms', value: 500, unit: 'ms', bar: 500, barDirection: 'down', note: 'p95 of servable rerank calls' };
const LEG_TWO_KPIS = [
  { key: 'kpi:rerank_p95_servable_ms', value: 500, unit: 'ms', bar: 500, barDirection: 'down', receiptId: 'abcd1234ef56' },
  { key: 'kpi:embed_attempt_success_pct', value: 99.1, unit: '%', receiptId: 'abcd1234ef56' },
];
const LEG_KPI_DIAG = { key: 'kpi:rerank_p95_servable_ms:diag', value: 4200, unit: 'ms', bar: 500, barDirection: 'down', receiptId: 'abcd1234ef56' };

describe('faeaa181 — the guards stay CORRECT (adjudicated framework-correct, never relaxed)', () => {
  it('replays leg 1: a p95 ceiling declared on a plain key is still refused', () => {
    expect(normalizePremise(LEG_CEILING as any, {})).toEqual(expect.stringContaining('barDirection is a KPI-bar field'));
  });

  it('replays leg 2: two kpi: premises in one call are still refused, naming both', () => {
    const r = normalizePremises(LEG_TWO_KPIS, GOAL_79284E7F, { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('at most ONE kpi: premise');
    // the ticket's own text: the incoming key first, the goal's rate second
    expect(r.error).toContain('kpi:rerank_p95_servable_ms, kpi:embed_attempt_success_pct');
  });

  it('replays leg 3: a `kpi:` + `:diag` key is still the KPI OF RECORD, never a plain diagnostic', () => {
    // (a) the filed refusal: no receipt ⇒ the receipt rule (exactly what the lane hit).
    const noReceipt: any = { key: 'kpi:rerank_p95_servable_ms:diag', value: 4200, unit: 'ms', bar: 500, barDirection: 'down' };
    expect(normalizePremise(noReceipt, {})).toEqual(expect.stringContaining('set ONLY from a this-wake run_command receipt id'));
    // (b) WITH a receipt it stops being a diagnostic at all — once the goal holds
    // its kpi:, the very same key is refused as a SECOND KPI (the dead end the
    // old text's `<kpi key>:diag` suggestion walked into).
    const withKpi: GoalPremise[] = [{ key: 'kpi:embed_attempt_success_pct', value: 99.1, unit: '%', kind: 'kpi', receiptId: 'abcd1234ef56' } as GoalPremise];
    const r = normalizePremises([LEG_KPI_DIAG], withKpi, { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('at most ONE kpi: premise');
    expect(r.error).toContain('kpi:rerank_p95_servable_ms:diag');
  });

  it('a kpi: premise without a receipt is still refused with the receipt rule', () => {
    const noReceipt: any = { key: 'kpi:rerank_p95_servable_ms', value: 500, bar: 500, barDirection: 'down' };
    expect(normalizePremise(noReceipt, {})).toEqual(expect.stringContaining('set ONLY from a this-wake run_command receipt id'));
  });

  it('bar/barDirection really ARE dead on a plain key — the reason the advice was wrong, not just vague', () => {
    // `bar` is accepted at write time on a plain key, but NO reader sees it:
    // the board/brief/done-suspect all read kpiPremiseOf(...) → null here.
    const r = normalizePremises([{ key: 'rerank_p95_servable_ms', value: 4200, unit: 'ms', bar: 500 }], GOAL_79284E7F, { mode: 'merge' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.premises.find((p) => p.key === 'rerank_p95_servable_ms')!;
    expect(row.bar).toBe(500);
    expect(kpiPremiseOf(r.premises)).toBeNull(); // ⇒ kpiBarText/kpiBarMet are never called on it
    // …and the same holds for a leftover barDirection, which is why it is refused.
    expect(kpiBarText({ value: 4200, bar: 500 })).toBe('bar ≤500'); // the reader WOULD honour it
    expect(kpiBarMet({ value: 4200, bar: 500 })).toBe(false);
  });
});

describe('faeaa181 — the refusal now teaches a shape that LANDS (the framework defect)', () => {
  /** The refusal text for the filed plain ceiling key. */
  const text = (): string => normalizePremise(LEG_CEILING as any, {}) as string;

  it('is no longer the bare one-path instruction it was (the filed text, verbatim tail)', () => {
    expect(text()).not.toMatch(/\(kind:'kpi'\)$/);
    expect(text().length).toBeGreaterThan(400);
  });

  it('names the ONE-kpi ceiling that killed every kpi: retry', () => {
    expect(text()).toContain('exactly ONE kpi: premise');
  });

  it('warns that the `:diag` spelling it used to suggest is refused again (the leg-3 dead end)', () => {
    expect(text()).toContain('kpi:rerank_p95_servable_ms:diag');
    expect(text()).toMatch(/diag.*(?:refused|second)/);
  });

  it('says `bar` is dead on a non-kpi key too — so "keep bar, drop barDirection" is never advised', () => {
    expect(text()).toContain('`bar` is dead on a non-kpi key too');
  });

  it('THE REMEDY IT NAMES ACTUALLY LANDS: its own non-kpi key, value = reading, bar in the note', () => {
    const remedy = { key: 'rerank_p95_servable_ms', value: 4200, unit: 'ms', note: '500 ms ceiling; SSM probe 17:11Z p95' };
    const r = normalizePremises([remedy], GOAL_79284E7F, { mode: 'merge' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.premises.find((p) => p.key === 'rerank_p95_servable_ms')?.value).toBe(4200);
  });

  it('THE KPI REMEDY IT NAMES LANDS TOO: bar on the goal\'s one kpi: premise (receipt-checked upstream)', () => {
    const kpiRemedy = { key: 'kpi:rerank_p95_servable_ms', value: 4200, unit: 'ms', bar: 500, barDirection: 'down', kind: 'kpi', receiptId: 'abcd1234ef56' };
    const r = normalizePremises([kpiRemedy], GOAL_79284E7F, { mode: 'merge' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kpi = kpiPremiseOf(r.premises)!;
    expect(kpiBarText(kpi)).toBe('bar ≤500'); // the declared ceiling is READ, not inferred
    expect(kpi).toMatchObject({ value: 4200, bar: 500 });
  });

  it('the target: arm keeps its own specialised text (unchanged by this fix)', () => {
    expect(normalizePremise({ key: 'target:tokens_per_s', value: 20, barDirection: 'up' }, {})).toEqual(expect.stringContaining('TARGET premise'));
  });

  it('unrelated validation errors are passed through byte-identical (the new text only touches barDirection placement)', () => {
    const bare = normalizePremise({ key: 'bad key!', value: 1 }, {});
    expect(bare).toContain('premise key must be');
    expect(normalizePremises([{ key: 'bad key!', value: 1 }], GOAL_79284E7F, { mode: 'merge' })).toEqual({ ok: false, error: bare });
  });
});
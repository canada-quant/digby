/**
 * Ticket 9fcd69ca (2026-10-27): kpi_bar_unmet treated every bar as a FLOOR.
 *
 * The board ledger flagged goal 5685a615 ("In-game assistant build") as
 * "done ⚠ suspect: kpi_bar_unmet (kpi live_advice_latency_ms=83.6 ms < bar
 * 500)" — but that KPI is a LATENCY metric whose bar is an upper ceiling
 * (≤500ms). The value 83.6ms comfortably MEETS the bar. Root cause:
 * kpi-of-record.ts kpiBarDirection INFERS the direction from the first
 * registered value (`bar >= first ⇒ 'up'` = must RISE to the bar), so any
 * latency/ceiling KPI whose FIRST reading already sits under its ceiling
 * (here: 18ms first reading vs a 500ms bar) inferred 'up' and false-flagged
 * every healthy reading as unmet.
 *
 * Fix: the premise schema takes a DECLARED `barDirection` ('up' floor /
 * 'down' ceiling — spellings 'at_least' / 'at_most' / 'min' / 'max' / 'ge' /
 * 'le' / 'ceiling' / 'lower_is_better' / 'lower_is_worse' normalized; 'auto'
 * = infer, and the one spelling that CLEARS a retained declaration). A
 * declared direction wins over inference in kpiBarDirection / kpiBarMet /
 * kpiBarText; an absent one infers exactly as before (no behavior change for
 * direction-less rows, including the goalOutcomeFingerprint).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import {
  kpiBarDirection, kpiBarMet, kpiBarText, normalizeKpiBarDirection, renderKpiInline, kpiPremiseOf,
} from './kpi-of-record';
import { assessGoalDoneSuspect, kpiBarUnmetOf, formatKpiBarUnmet, renderGoalDoneSuspectBadge, type GoalDoneSuspectInput } from './goal-done-suspect';
import { normalizePremise, normalizePremises, type GoalPremise } from './premise-register';
import { goalOutcomeFingerprint } from './goal-outcome';

// The ticket's premise, verbatim shape: first reading 18 (2026-10-26T17:25Z),
// revised to 83.6 (receipt 5136aeff) — bar 500 = a ≤500ms ceiling.
const LATENCY_KPI = {
  key: 'kpi:live_advice_latency_ms', value: 83.6, bar: 500, unit: 'ms', kind: 'kpi' as const,
  history: [{ value: 18 }], receiptId: '5136aeff-dc16-4f0f-968d-af4299604a43', setAt: '2026-10-26T17:41:03.270Z',
};

describe('9fcd69ca — kpiBarDirection: declared direction beats inference', () => {
  it('normalizeKpiBarDirection maps every spelling; auto/unknown/empty are inference', () => {
    for (const v of ['up', 'at_least', 'atleast', 'min', 'ge', 'gte', 'higher', 'lower_is_worse', 'UP', ' at_most '.trim() === 'at_most' ? 'at_least' : 'at_least']) {
      expect(normalizeKpiBarDirection(v)).toBe('up');
    }
    for (const v of ['down', 'at_most', 'atmost', 'max', 'le', 'lte', 'ceiling', 'lower_is_better', 'DOWN']) {
      expect(normalizeKpiBarDirection(v)).toBe('down');
    }
    for (const v of [undefined, null, '', 'auto', 'AUTO', 'sideways', 42]) {
      expect(normalizeKpiBarDirection(v)).toBe(null);
    }
  });

  it('THE REPRO: a latency KPI (bar 500 ceiling, first reading 18) declared at_most is MET at 83.6 — and still misinfers up WITHOUT the declaration (the bug, pinned)', () => {
    // Without a declaration: the pre-fix behaviour — inference says 'up' (500 >= 18), 83.6 < 500 ⇒ NOT met. This is the false flag the ticket reported; it stays pinned here so the fix is provably a SEMANTICS declaration, not a silently changed inference.
    expect(kpiBarDirection(LATENCY_KPI)).toBe('up');
    expect(kpiBarMet(LATENCY_KPI)).toBe(false);
    // With the declaration the same row is a ceiling: met.
    const declared = { ...LATENCY_KPI, barDirection: 'down' as const };
    expect(kpiBarDirection(declared)).toBe('down');
    expect(kpiBarMet(declared)).toBe(true);
    expect(kpiBarText(declared)).toBe('bar ≤500');
    // spelling variants arrive as at_most / lower_is_better from the tool layer
    expect(kpiBarMet({ ...LATENCY_KPI, barDirection: 'at_most' })).toBe(true);
    expect(kpiBarMet({ ...LATENCY_KPI, barDirection: 'lower_is_better' })).toBe(true);
    // a declared FLOOR on the same numbers is unmet (83.6 < 500) — the direction, not the values, decides
    expect(kpiBarMet({ ...LATENCY_KPI, barDirection: 'up' })).toBe(false);
    expect(kpiBarText({ ...LATENCY_KPI, barDirection: 'up' })).toBe('bar ≥500');
  });

  it('a declared ceiling is honestly UNMET when the value truly exceeds it (p95 720ms vs bar 500)', () => {
    const slow = { key: 'kpi:p95_ms', value: 720, bar: 500, unit: 'ms', barDirection: 'down' as const };
    expect(kpiBarMet(slow)).toBe(false);
    expect(kpiBarDirection(slow)).toBe('down');
  });

  it('a floor KPI (tok/s ≥10) keeps its semantics under every spelling of the declaration', () => {
    const rate = { key: 'kpi:client_visible_e2e_tok_s', value: 5.08, bar: 10, unit: ' tok/s', history: [{ value: 3.44 }] };
    expect(kpiBarMet(rate)).toBe(false); // inferred up (10 >= 3.44) — unchanged
    expect(kpiBarMet({ ...rate, barDirection: 'up' })).toBe(false);
    expect(kpiBarMet({ ...rate, barDirection: 'at_least' })).toBe(false);
    expect(kpiBarMet({ ...rate, value: 12, barDirection: 'at_least' })).toBe(true);
    // an inference that read 'down' pre-fix (bar 10 < first 12... no: 10 >= 12 is false) — pin the counts-down legacy shape too
    const downInferred = { key: 'kpi:p95_ms', value: 180, bar: 200, history: [{ value: 340 }] };
    expect(kpiBarDirection(downInferred)).toBe('down'); // 200 < 340 ⇒ down, unchanged
    expect(kpiBarMet(downInferred)).toBe(true);
  });

  it('renderKpiInline prints the declared ceiling clause (bar ≤500)', () => {
    const line = renderKpiInline({ ...LATENCY_KPI, barDirection: 'down' } as any, new Date('2026-10-27T04:00:00Z'));
    expect(line).toContain('bar ≤500');
    expect(line).toContain('live_advice_latency_ms=83.6 ms');
  });
});

describe('9fcd69ca — the kpi_bar_unmet done-suspect reason honors the declaration', () => {
  const goalOf = (premises: unknown): Partial<GoalDoneSuspectInput> => ({ id: 'g-9fcd69ca', title: 'latency goal', status: 'done', premises } as Partial<GoalDoneSuspectInput>);

  it('THE REPRO at the detector level: the ticket goal, declared at_most, yields NO kpi_bar_unmet (and no badge)', () => {
    const premises = [{ ...LATENCY_KPI, barDirection: 'down' as const }];
    expect(kpiBarUnmetOf(premises)).toBe(null);
    const v = assessGoalDoneSuspect(goalOf(premises) as GoalDoneSuspectInput, [], { now: Date.parse('2026-10-27T04:03:00Z') });
    expect(v.reasons).not.toContain('kpi_bar_unmet');
    expect(renderGoalDoneSuspectBadge(v)).toBe('');
  });

  it('the same goal WITHOUT the declaration still flags (the bug pinned at the detector seam) — and the badge text names the direction', () => {
    const premises = [LATENCY_KPI];
    const unmet = kpiBarUnmetOf(premises);
    expect(unmet).toMatchObject({ key: 'kpi:live_advice_latency_ms', value: 83.6, bar: 500, direction: 'up' });
    expect(formatKpiBarUnmet(unmet!)).toBe('kpi live_advice_latency_ms=83.6 ms < bar 500');
    const v = assessGoalDoneSuspect(goalOf(premises) as GoalDoneSuspectInput, [], { now: Date.parse('2026-10-27T04:03:00Z') });
    expect(v.reasons).toContain('kpi_bar_unmet');
  });

  it('a floor KPI below its bar still flags — DETECTOR-RECALL REPLAY #1 (the spark a57fb2e2 shape: floor KPI closed below its bar must keep firing)', () => {
    // DETECTOR-RECALL REPLAY (kpi_bar_unmet prior true positive #1 — the
    // 2026-10-20 spark a57fb2e2 shape: "≥20 tok/s" closed at an observed 5.33):
    // the barDirection change may NOT stop a floor KPI below its bar from
    // firing. Direction-less rows infer exactly as before.
    const premises = [{ key: 'kpi:client_visible_e2e_tok_s', value: 5.08, bar: 10, unit: ' tok/s', kind: 'kpi' as const, receiptId: 'aabbccdd-1111-2222-3333-444455556666', history: [{ value: 3.44 }] }];
    const v = assessGoalDoneSuspect(goalOf(premises) as GoalDoneSuspectInput, [], { now: Date.parse('2026-10-27T04:03:00Z') });
    expect(v.reasons).toContain('kpi_bar_unmet');
    expect(renderGoalDoneSuspectBadge(v)).toContain('kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10');
  });

  it('a declared ceiling TRULY exceeded still flags — the honesty half of the fix (a ceiling bar is met at ≤, unmet at >)', () => {
    // DETECTOR-RECALL REPLAY (kpi_bar_unmet prior true positive #2, direction
    // 'down'): a ceiling KPI above its bar MUST still fire — the fix may not
    // turn 'down' into a blanket pass. 720ms against a 500ms ceiling is the
    // same honest unmet the floor case is, read in the other direction.
    const premises = [{ ...LATENCY_KPI, value: 720, barDirection: 'down' as const }];
    const unmet = kpiBarUnmetOf(premises);
    expect(unmet).toMatchObject({ value: 720, bar: 500, direction: 'down', barDirection: 'down' });
    expect(formatKpiBarUnmet(unmet!)).toBe('kpi live_advice_latency_ms=720 ms > bar 500');
    const v = assessGoalDoneSuspect(goalOf(premises) as GoalDoneSuspectInput, [], { now: Date.parse('2026-10-27T04:03:00Z') });
    expect(v.reasons).toContain('kpi_bar_unmet');
    expect(renderGoalDoneSuspectBadge(v)).toContain('kpi live_advice_latency_ms=720 ms > bar 500');
  });

  it('a floor KPI below its bar still flags (no regression on the 2026-10-20 GOAL-OUTCOME-UNMET behaviour)', () => {
    const premises = [{ key: 'kpi:client_visible_e2e_tok_s', value: 5.08, bar: 10, unit: ' tok/s', kind: 'kpi' as const, receiptId: 'aabbccdd-1111-2222-3333-444455556666', history: [{ value: 3.44 }] }];
    const v = assessGoalDoneSuspect(goalOf(premises) as GoalDoneSuspectInput, [], { now: Date.parse('2026-10-27T04:03:00Z') });
    expect(v.reasons).toContain('kpi_bar_unmet');
    expect(renderGoalDoneSuspectBadge(v)).toContain('kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10');
  });
});

describe('9fcd69ca — premise-register: barDirection validation + merge retention', () => {
  const kpiRaw = (over: Record<string, unknown>) => ({ key: 'kpi:live_advice_latency_ms', value: 83.6, bar: 500, unit: 'ms', receiptId: '5136aeff-dc16-4f0f-968d-af4299604a43', ...over });

  it('normalizePremise accepts the spellings, maps them to up/down, and refuses garbage', () => {
    expect(normalizePremise(kpiRaw({ barDirection: 'at_most' }), {})).toMatchObject({ barDirection: 'down' });
    expect(normalizePremise(kpiRaw({ barDirection: 'down' }), {})).toMatchObject({ barDirection: 'down' });
    expect(normalizePremise(kpiRaw({ barDirection: 'lower_is_better' }), {})).toMatchObject({ barDirection: 'down' });
    expect(normalizePremise(kpiRaw({ barDirection: 'at_least' }), {})).toMatchObject({ barDirection: 'up' });
    expect(normalizePremise(kpiRaw({ atMost: true }), {})).toMatchObject({ barDirection: 'down' });
    expect(normalizePremise(kpiRaw({ barDirection: 'auto' }), {})).not.toHaveProperty('barDirection');
    expect(normalizePremise(kpiRaw({ barDirection: 'sideways' }), {})).toContain("barDirection must be one of 'up' | 'down'");
  });

  it('barDirection without a bar — or on a non-kpi premise — is refused (it is bar semantics)', () => {
    expect(normalizePremise({ key: 'plain_rate', value: 3, barDirection: 'down' }, {})).toContain('barDirection needs a bar');
    // m2 (review 4112375b): even WITH a bar, a non-kpi premise cannot carry it
    expect(normalizePremise({ key: 'plain_rate', value: 90, bar: 500, barDirection: 'down' }, {})).toContain("barDirection is a KPI-bar field");
    // but a kpi:-keyed premise carrying barDirection+bar is fine (bar present)
    expect(normalizePremise(kpiRaw({}), {})).not.toHaveProperty('barDirection');
    // atMost:false is not a declaration — inference stands
    expect(normalizePremise(kpiRaw({ atMost: false }), {})).not.toHaveProperty('barDirection');
  });

  it('MERGE RETENTION: a fresh receipted reading that omits barDirection keeps the declared ceiling; an explicit one re-declares; an explicit auto clears it', () => {
    const declared: GoalPremise[] = [normalizePremise(kpiRaw({ barDirection: 'at_most' }), {}) as GoalPremise];
    // a NEW reading (value moved 83.6 -> 120) with a fresh receipt, barDirection omitted
    const r1 = normalizePremises([kpiRaw({ value: 120, receiptId: '99887766-1111-2222-3333-444455556666' })], declared, { mode: 'merge' });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.premises[0]).toMatchObject({ value: 120, bar: 500, barDirection: 'down' });
      // and the detector on the merged row is a ceiling: 120 <= 500 ⇒ met, no flag
      expect(kpiBarUnmetOf(r1.premises)).toBe(null);
    }
    // re-declare to 'up' — the floor reading of the same numbers now flags
    const r2 = normalizePremises([kpiRaw({ value: 120, receiptId: '99887766-1111-2222-3333-444455556666', barDirection: 'up' })], declared, { mode: 'merge' });
    expect(r2.ok && r2.premises[0].barDirection).toBe('up');
    // explicit 'auto' clears the retained declaration back to inference
    const r3 = normalizePremises([kpiRaw({ value: 120, receiptId: '99887766-1111-2222-3333-444455556666', barDirection: 'auto' })], declared, { mode: 'merge' });
    expect(r3.ok && r3.premises[0].barDirection).toBeUndefined();
    // and inference on this row says 'up' (bar 500 >= history-first 18) — the flag returns
    if (r3.ok) expect(kpiBarUnmetOf(r3.premises)).not.toBe(null);
  });

  it('a direction-less row is untouched: no barDirection key is written (legacy rows stay byte-compatible)', () => {
    const r = normalizePremises([kpiRaw({})], [], { mode: 'merge' });
    expect(r.ok && r.premises[0].barDirection).toBeUndefined();
    expect(r.ok && JSON.stringify(r.premises[0])).not.toContain('barDirection');
  });
});

describe('9fcd69ca — goalOutcomeFingerprint: a declared direction changes the fingerprint; a direction-less row does not', () => {
  it('same values, direction added ⇒ new fingerprint (declaring the ceiling ENDS a live outcome-unmet hold)', () => {
    const without = goalOutcomeFingerprint([LATENCY_KPI]);
    const withDown = goalOutcomeFingerprint([{ ...LATENCY_KPI, barDirection: 'down' }]);
    expect(withDown).not.toBe(without);
    // idempotent: the same declaration re-fingerprints identically
    expect(goalOutcomeFingerprint([{ ...LATENCY_KPI, barDirection: 'down' }])).toBe(withDown);
    // and round-trips through the register (normalize + merge keep the field)
    const norm = normalizePremises([LATENCY_KPI], [], { mode: 'merge' });
    const fromRegister = norm.ok ? norm.premises : [];
    expect(goalOutcomeFingerprint(fromRegister)).toBe(without); // direction-less registration keeps the legacy fingerprint
  });

  it('legacy rows: a direction-less KPI premise fingerprints EXACTLY as the pre-fix 3-tuple — literal sha1 pin (B1, review 4112375b)', () => {
    // The ticket's live row (direction-less, exactly as stored on goal 5685a615):
    // PRE-FIX computed sha1(JSON.stringify({kpi:['kpi:live_advice_latency_ms',83.6,500],
    // targets:[['target_p95_ms',500,83.6]]})) = f3068e25… (verified against the
    // pre-fix shape with node crypto BEFORE pinning). POST-FIX must reproduce it
    // byte-for-byte — a literal 4th tuple element (null/undefined) would change
    // the JSON and silently perturb every existing live outcome-unmet hold.
    const row = [
      { key: 'kpi:live_advice_latency_ms', value: 83.6, bar: 500, unit: 'ms', kind: 'kpi', history: [{ value: 18 }] },
      { key: 'target_p95_ms', value: 500, observed: 83.6 },
    ];
    expect(goalOutcomeFingerprint(row)).toBe('f3068e25006f8373acad1aba0f0f4728b4262f28');
    // a declared 'down' on the same KPI (targets empty) moves it — the declaration
    // IS the change that ends a false hold:
    expect(goalOutcomeFingerprint([{ key: 'kpi:live_advice_latency_ms', value: 83.6, bar: 500, history: [{ value: 18 }], barDirection: 'down' }]))
      .toBe('752903209380f5242bc70355a58467ec806cd89a');
  });
});

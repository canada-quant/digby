/**
 * REPLAY test — ticket d1a7bec2 (enhancement, filed 2026-11-02T12:50Z), CASE 2:
 * "bool-unit KPI premises always read 'suspect kpi_bar_unmet'".
 *
 * The mishap, verbatim from the ticket: goal f43bce21 (ctrl.example.com embeddings
 * seat, status done since 11-02 08:05Z) carried the kpi premise
 * `caller_kpi_certified` — unit "bool", value 1, bar 90, barDirection "up".
 * The board rendered it
 *   "⚠ suspect kpi_bar_unmet — kpi caller_kpi_certified=1 bool < bar 90"
 * which is arithmetic on incomparable units: a certified-true boolean IS 1, and
 * no bool can exceed 90. The real reliability numbers on the same premise set
 * were healthy (embed_call_success_pct 97.62 %, embed_post_reorder_pct 95.73 %,
 * both ≥ the 90 bar). Every bool KPI registered with a copied-over numeric bar
 * produces this false alarm indefinitely, and a CLOSED goal keeping a ⚠ on the
 * board erodes trust in every other flag.
 *
 * The fix has two halves:
 *  - READ path: kpiBarMet / kpiBarDirection / kpiBarText / kpiBarUnmetOf take
 *    `unit` into account — a boolean unit's bar is BOOLEAN_KPI_BAR (1) with an
 *    'up' floor, so "true" is MET and nothing renders, no matter what bar the
 *    row stored. This is what clears rows ALREADY written (no backfill).
 *  - WRITE path: premise registration NORMALISES a boolean premise's bar to 1 /
 *    'up' so the stored row stops lying to anything that reads the raw field.
 *
 * DETECTOR-RECALL REPLAY: goal-done-suspect.ts is a framework detector, so the
 * last suite re-runs its PRIOR true positives — a genuinely unmet percentage
 * KPI, a genuinely unmet latency CEILING KPI (ticket 9fcd69ca), and a
 * non-boolean premise that merely carries a bar — and asserts they STILL fire.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import {
  kpiBarDirection, kpiBarMet, kpiBarText, isBooleanKpiUnit, effectiveKpiBar, BOOLEAN_KPI_BAR,
} from './kpi-of-record';
import { kpiBarUnmetOf, formatKpiBarUnmet, assessGoalDoneSuspect, renderGoalDoneSuspectBadge } from './goal-done-suspect';
import { normalizePremise } from './premise-register';
import { goalKpiGap, renderKpiGapText } from './goal-priority';
import { computeAdoptionLadder, renderNoAdoptionWake } from './adoption-ladder';

/**
 * The ticket's premise, verbatim shape: goal f43bce21's of-record KPI — a
 * certified-true boolean carrying a numeric bar copied over from the sibling
 * percentage KPIs on the same goal.
 */
const CERTIFIED_BOOL_KPI = {
  key: 'kpi:caller_kpi_certified',
  value: 1,
  unit: 'bool',
  bar: 90,
  barDirection: 'up',
  kind: 'kpi' as const,
  receiptId: 'deadbeef',
  setAt: '2026-11-02T08:00:00.000Z',
};

/** The ticket's sibling numbers — the real reliability readings, both ≥ 90. */
const HEALTHY_SIBLINGS = [
  { key: 'embed_call_success_pct', value: 97.62, unit: '%', bar: 90 },
  { key: 'embed_post_reorder_pct', value: 95.73, unit: '%', bar: 90 },
];

const premises = (...rows: any[]) => rows;

const baseInput = (over: any = {}): any => ({
  id: 'f43bce21-0000-4000-8000-000000000001',
  title: 'ctrl.example.com embeddings seat',
  status: 'done',
  progressNote: 'Seat certified and serving.',
  blockedReason: null,
  ...over,
});

describe('isBooleanKpiUnit / effectiveKpiBar — the unit taxonomy', () => {
  it('recognises the boolean/flag spellings, case- and space-insensitively', () => {
    for (const u of ['bool', 'BOOL', ' bool ', 'boolean', 'flag', 'binary', 'yes/no', 'true/false', 'truthy']) {
      expect(isBooleanKpiUnit(u)).toBe(true);
    }
  });

  it('does NOT claim numeric / rate units', () => {
    for (const u of ['%', 'ms', 'tok/s', 'USD', 'rows', 's', '']) {
      expect(isBooleanKpiUnit(u)).toBe(false);
    }
  });

  it('a boolean unit has exactly ONE comparable bar, whatever the row stored', () => {
    expect(effectiveKpiBar({ bar: 90, unit: 'bool' })).toBe(BOOLEAN_KPI_BAR);
    expect(effectiveKpiBar({ bar: 0.5, unit: 'flag' })).toBe(BOOLEAN_KPI_BAR);
    // A numeric KPI keeps its own bar, untouched.
    expect(effectiveKpiBar({ bar: 90, unit: '%' })).toBe(90);
  });
});

describe('ticket d1a7bec2 CASE 2 — a bool KPI is never bar-compared', () => {
  it('REPLAY: the ticket premise (1 bool, bar 90, up) is MET — no ⚠ suspect reason is produced', () => {
    // Pre-fix this returned {key, value: 1, bar: 90, direction: 'up'} and the
    // board rendered "1 bool < bar 90" forever.
    expect(kpiBarUnmetOf(premises(CERTIFIED_BOOL_KPI))).toBeNull();
  });

  it('REPLAY: the ticket premise alongside its healthy siblings — still no reason', () => {
    expect(kpiBarUnmetOf(premises(CERTIFIED_BOOL_KPI, ...HEALTHY_SIBLINGS))).toBeNull();
  });

  it('the closed goal f43bce21 carries NO board badge after the fix', () => {
    const v = assessGoalDoneSuspect(baseInput({ premises: premises(CERTIFIED_BOOL_KPI, ...HEALTHY_SIBLINGS) }));
    expect(v.reasons).not.toContain('kpi_bar_unmet');
    const badge = renderGoalDoneSuspectBadge(v);
    expect(badge).not.toContain('kpi_bar_unmet');
    expect(badge).not.toContain('suspect');
  });

  it('kpiBarMet / kpiBarDirection / kpiBarText agree on the boolean reading', () => {
    expect(kpiBarMet(CERTIFIED_BOOL_KPI)).toBe(true);
    expect(kpiBarDirection(CERTIFIED_BOOL_KPI)).toBe('up');
    expect(kpiBarText(CERTIFIED_BOOL_KPI)).toBe('bar ≥1');
  });

  it('a FALSE boolean (0) is correctly unmet — the fix must not blind the detector to a real miss', () => {
    const uncertified = { ...CERTIFIED_BOOL_KPI, value: 0 };
    expect(kpiBarMet(uncertified)).toBe(false);
    const unmet = kpiBarUnmetOf(premises(uncertified));
    expect(unmet).not.toBeNull();
    expect(formatKpiBarUnmet(unmet!)).toBe('kpi caller_kpi_certified=0 bool < bar 1');
  });

  it('a stale declared "down" alongside the copied bar cannot invert the boolean comparison', () => {
    const inverted = { ...CERTIFIED_BOOL_KPI, barDirection: 'down' as const };
    expect(kpiBarDirection(inverted)).toBe('up');
    expect(kpiBarMet(inverted)).toBe(true);
    expect(kpiBarUnmetOf(premises(inverted))).toBeNull();
  });
});

describe('ticket d1a7bec2 CASE 2 — registration normalises the stored bar', () => {
  it('premise-set rewrites bar 90 → 1 with an up floor on a bool KPI (row stops lying)', () => {
    const out = normalizePremise(
      { key: 'kpi:caller_kpi_certified', value: 1, unit: 'bool', bar: 90, barDirection: 'up', receiptId: 'deadbeef' } as any,
      { now: new Date('2026-11-02T08:05:00.000Z') },
    );
    expect(typeof out).not.toBe('string');
    const p: any = out;
    expect(p.bar).toBe(BOOLEAN_KPI_BAR);
    expect(p.barDirection).toBe('up');
    expect(p.unit).toBe('bool');
  });

  it('a stale "down" copied with the bar is rewritten to up, not retained', () => {
    const out: any = normalizePremise(
      { key: 'kpi:certified', value: 1, unit: 'flag', bar: 90, barDirection: 'down', receiptId: 'deadbeef' } as any,
      { now: new Date('2026-11-02T08:05:00.000Z') },
    );
    expect(typeof out).not.toBe('string');
    expect(out.bar).toBe(BOOLEAN_KPI_BAR);
    expect(out.barDirection).toBe('up');
  });

  it('a NON-boolean KPI keeps its declared bar and direction exactly (no collateral change)', () => {
    const out: any = normalizePremise(
      { key: 'kpi:embed_call_success_pct', value: 97.62, unit: '%', bar: 90, barDirection: 'up', receiptId: 'deadbeef' } as any,
      { now: new Date('2026-11-02T08:05:00.000Z') },
    );
    expect(typeof out).not.toBe('string');
    expect(out.bar).toBe(90);
    expect(out.barDirection).toBe('up');

    const ceiling: any = normalizePremise(
      { key: 'kpi:live_advice_latency_ms', value: 83.6, unit: 'ms', bar: 500, barDirection: 'down', receiptId: 'deadbeef' } as any,
      { now: new Date('2026-11-02T08:05:00.000Z') },
    );
    expect(ceiling.bar).toBe(500);
    expect(ceiling.barDirection).toBe('down');
  });

  it('a bool premise WITHOUT a bar stays bar-less (normalisation only rewrites an existing bar)', () => {
    const out: any = normalizePremise(
      { key: 'kpi:certified', value: 1, unit: 'bool', receiptId: 'deadbeef' } as any,
      { now: new Date('2026-11-02T08:05:00.000Z') },
    );
    expect(typeof out).not.toBe('string');
    expect(out.bar).toBeUndefined();
  });
});

/**
 * Review round 1, BLOCKING 1 — `effectiveKpiBar` must not FABRICATE a bar for a
 * bar-less boolean. The first cut returned BOOLEAN_KPI_BAR (1) unconditionally
 * for a boolean unit, so `{value:1, unit:'bool'}` — a reading with NO bar on
 * record — printed a "bar ≥1" clause the register never held, and (second
 * order) `computeAdoptionLadder`'s `if (kpiBarMet(input.kpi)) return null` gate
 * meant a bar-less boolean goal could NEVER trip [NO-ADOPTION], silently
 * retiring that whole signal class. A KPI without a bar is a reading, not an
 * outcome.
 */
describe('ticket d1a7bec2 CASE 2 (review fix) — no bar is never fabricated', () => {
  it('a bar-less boolean premise keeps NO bar and NO clause', () => {
    const p = { value: 1, unit: 'bool' };
    expect(effectiveKpiBar(p)).toBeUndefined();
    expect(kpiBarText(p)).toBe('');
    expect(kpiBarMet(p)).toBe(false);
    expect(kpiBarUnmetOf(premises(p))).toBeNull();
    // …and the adoption ladder is NOT short-circuited by a fabricated met bar.
    expect(computeAdoptionLadder({
      goalId: 'g-1', projectId: 'p-1', goalTitle: 'barless bool',
      kpi: { ...p, key: 'kpi:certified', receiptId: 'deadbeef', setAt: '2026-11-01T00:00:00.000Z' } as any,
      lanes: ['lane-1'], completedRuns: [], now: new Date('2026-11-02T12:00:00.000Z'),
    })?.tripped ?? false).not.toBe(true);
  });

  it('a boolean premise WITH a bar still compares against 1', () => {
    expect(effectiveKpiBar({ unit: 'bool', bar: 90 })).toBe(BOOLEAN_KPI_BAR);
    expect(kpiBarText({ value: 1, unit: 'bool', bar: 90 })).toBe('bar ≥1');
  });

  it('a bar-less NON-boolean premise is unchanged (was already bar-less)', () => {
    expect(effectiveKpiBar({ unit: '%' })).toBeUndefined();
    expect(kpiBarText({ value: 5, unit: '%' })).toBe('');
  });
});

/**
 * Review round 1, BLOCKING 2 — three raw-`kpi.bar` readers contradicted the
 * fixed comparison, so ONE board row rendered two different bars: "bar ≥1" on
 * the KPI line (kpiBarText) beside "KPI bar ≥90 met" in the gap column, with a
 * nonzero gap (|90 − 1| = 89) on a MET row. Every reader must now agree.
 */
describe('ticket d1a7bec2 CASE 2 (review fix) — every reader agrees on one bar', () => {
  it('goalKpiGap / renderKpiGapText use the boolean bar, not the copied-over one', () => {
    const g = goalKpiGap(premises(CERTIFIED_BOOL_KPI));
    expect(g).not.toBeNull();
    expect(g!.bar).toBe(BOOLEAN_KPI_BAR);
    expect(g!.met).toBe(true);
    expect(g!.gap).toBe(0); // MUST NOT be |90 − 1| = 89 on a met row
    expect(renderKpiGapText(premises(CERTIFIED_BOOL_KPI))).toBe('KPI bar ≥1 met');
    // …and it agrees with the KPI-line renderer.
    expect(kpiBarText(CERTIFIED_BOOL_KPI)).toBe('bar ≥1');
  });

  it('the [NO-ADOPTION] wake body prints the boolean bar, not the copied-over one', () => {
    const ladder = computeAdoptionLadder({
      goalId: 'f43bce21-0000-4000-8000-000000000001', projectId: 'p-1', goalTitle: 'embeddings seat',
      kpi: { ...CERTIFIED_BOOL_KPI, value: 0 } as any, // an UNCERTIFIED boolean → genuinely unmet
      lanes: ['lane-1'], completedRuns: [], now: new Date('2026-11-02T12:00:00.000Z'),
    });
    expect(ladder).not.toBeNull();
    expect(ladder!.bar).toBe(BOOLEAN_KPI_BAR);
    const wake = renderNoAdoptionWake(ladder!, 'ctrl.example.com', new Date('2026-11-02T12:00:00.000Z'));
    expect(wake).toContain('bar ≥1');
    expect(wake).not.toContain('bar ≥90');
  });

  it('a bar-less boolean renders no bar clause anywhere (no fabricated "bar ≥1")', () => {
    const noBar = { key: 'kpi:certified', value: 1, unit: 'bool', kind: 'kpi' as const, receiptId: 'deadbeef' };
    expect(goalKpiGap(premises(noBar))).toBeNull();
    expect(renderKpiGapText(premises(noBar))).toBe('');
    expect(kpiBarText(noBar)).toBe('');
  });

  it('numeric KPIs are untouched by any of it (floor + ceiling)', () => {
    expect(goalKpiGap(premises({ key: 'kpi:tok_s', value: 5.08, unit: 'tok/s', bar: 10, kind: 'kpi', receiptId: 'deadbeef', history: [{ value: 3.44 }] })))
      .toMatchObject({ bar: 10, met: false, gap: 4.92, direction: 'up' });
    expect(goalKpiGap(premises({ key: 'kpi:lat', value: 83.6, unit: 'ms', bar: 500, barDirection: 'down', kind: 'kpi', receiptId: 'deadbeef' })))
      .toMatchObject({ bar: 500, met: true, gap: 0, direction: 'down' });
  });
});

describe('DETECTOR-RECALL REPLAY — kpi_bar_unmet still fires on its prior true positives', () => {
  it('DETECTOR-RECALL REPLAY: an unmet PERCENTAGE KPI (floor) still convicts', () => {
    // The detector's original shape: a tok/s KPI closed under its bar.
    const unmet = kpiBarUnmetOf(premises({
      key: 'kpi:tok_s', value: 5.08, unit: 'tok/s', bar: 10, kind: 'kpi', receiptId: 'deadbeef',
    }));
    expect(unmet).not.toBeNull();
    expect(formatKpiBarUnmet(unmet!)).toBe('kpi tok_s=5.08 tok/s < bar 10');
  });

  it('DETECTOR-RECALL REPLAY: an unmet latency CEILING KPI (ticket 9fcd69ca, declared down) still convicts', () => {
    const unmet = kpiBarUnmetOf(premises({
      key: 'kpi:live_advice_latency_ms', value: 830, unit: 'ms', bar: 500, barDirection: 'down', kind: 'kpi', receiptId: 'deadbeef',
    }));
    expect(unmet).not.toBeNull();
    // A ceiling miss is a ">" comparison, not "<".
    expect(formatKpiBarUnmet(unmet!)).toBe('kpi live_advice_latency_ms=830 ms > bar 500');
  });

  it('DETECTOR-RECALL REPLAY: the goal-close assessment still badges a genuinely unmet KPI goal', () => {
    const premises = [{ key: 'kpi:tok_s', value: 5.08, unit: 'tok/s', bar: 10, kind: 'kpi' as const, receiptId: 'aabbccdd-1111-2222-3333-444455556666', history: [{ value: 3.44 }] }];
    const v = assessGoalDoneSuspect(
      { id: 'g-d1a7bec2', title: 'Inference throughput', status: 'done', premises } as any,
      [],
      { now: Date.parse('2026-11-02T13:00:00Z') },
    );
    expect(v.reasons).toContain('kpi_bar_unmet');
    expect(renderGoalDoneSuspectBadge(v)).toContain('kpi_bar_unmet');
  });

  it('DETECTOR-RECALL REPLAY: a MET percentage KPI (floor, rising history) stays quiet', () => {
    // Direction is inferred from the FIRST registered value: 88 → bar 90 is a
    // floor ('up'), so 97.62 clears it. (The bool fix must not disturb this.)
    const met = { key: 'kpi:pct', value: 97.62, unit: '%', bar: 90, kind: 'kpi' as const, receiptId: 'deadbeef', history: [{ value: 88 }] };
    expect(kpiBarUnmetOf([met])).toBeNull();
  });
});
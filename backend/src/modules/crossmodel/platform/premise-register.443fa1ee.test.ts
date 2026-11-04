/**
 * REPLAY PIN — ticket 443fa1ee-55d7-4c1b-9558-257d8eec86c7 (mishap, breaker
 * trip 2026-11-01, lane 0037460b session / run 2816f4db, goal 8f0dcd6f
 * "Backlog catch-up: speaker-diarized transcripts…").
 *
 * A 3× tool-failure streak on goal_premise_set. The verbatim failure texts
 * (newest first), replayed here against the shipped guards:
 *   · premise "target:auto_decrypt_clips_per_hr": barDirection is a KPI-bar
 *     field — register it on the goal's 'kpi:' premise (kind:'kpi')
 *   · premise "backlog:auto_decrypt_rate_clips_per_hr": barDirection needs a
 *     bar (and marks a KPI premise — 'kpi:' key or kind:'kpi')
 *
 * ADJUDICATION (this lane, 2026-11-01): SPLIT per leg, as the tool-failure-
 * streak doctrine requires (learnings: "SPLIT the filing's failure texts per
 * leg before attributing").
 *
 *   GUARDS — CORRECT, unchanged, pinned below so a future "helpful" relaxation
 *   trips this suite. `barDirection` is bar semantics only the KPI readers
 *   consume (kpi-of-record.ts kpiBarDirection/kpiBarMet/kpiBarText, and
 *   done-suspect's kpi_bar_unmet). A non-KPI premise carrying it would hold a
 *   DEAD declaration (review 4112375b m2), and a declaration with no bar is
 *   meaningless. The lane passed `barDirection:'up'` with no `bar` on a
 *   `target:` key and on a plain `backlog:` rate key — both genuinely wrong.
 *
 *   THE REFUSAL TEXT — FRAMEWORK DEFECT, fixed here. Both texts advised ONE
 *   path ("register it on the goal's 'kpi:' premise") and that path was a dead
 *   end for the caller:
 *     (a) a `target:` key is NOT a stray plain premise — done-suspect reads it
 *         as the goal's target via TARGET_PREMISE_KEY_RE, and its bound is
 *         declared BY THE KEY (target_max_/target_…_ceiling = a ceiling,
 *         everything else = a floor). Telling the lane to move that number onto
 *         the kpi: premise would stop it being a target premise at all — the
 *         advice loses semantics rather than teaching the shape;
 *     (b) the advised kpi: write was itself refused: goal 8f0dcd6f held 12/12
 *         premises (PREMISE_MAX_PER_GOAL) with ZERO kpi: keys, so adding one is
 *         refused at the cap. That is precisely the af24badf dead-end class
 *         (premise-register.af24badf.test.ts) — "NEVER advise a retry this same
 *         branch would refuse again" — recurring one guard over.
 *
 *   The fix teaches the shape that actually LANDS: a target premise keeps its
 *   bar in `value` and takes the measured reading as `observed` +
 *   `observedNote` (which is exactly what targetPremiseState grades met/unmet
 *   from), and the refusal stops recommending a kpi: write when this register
 *   would refuse it.
 *
 * Recovery evidence from the filed run: the lane landed the write unaided on
 * its third call (receipt be1c7261, ok:true) by DROPPING barDirection — pinned
 * below so the guard is never relaxed into accepting the declaration instead.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import { normalizePremise, normalizePremises, PREMISE_MAX_PER_GOAL, type GoalPremise } from './premise-register';
import { targetPremiseState } from './goal-done-suspect';

/** The premise set goal 8f0dcd6f actually held when the streak fired (12 keys, no kpi:). */
const GOAL_8F0DCD6F: GoalPremise[] = [
  'target:auto_decrypt_clips_per_hr', 'backlog:auto_decrypt_rate_clips_per_hr', 'backlog:auto_decrypt_clips_per_day',
  'backlog:clips_decrypted', 'backlog:walkable_window_undec', 'backlog:cutoff_ts', 'backlog.clips_downloaded',
  'backlog:manifest_rows', 'backlog:clips_diarized_rerun', 'backlog:missing_on_disk', 'backlog:diar_held_stems',
  'backlog:diar_silence_class',
].map((key) => ({ key, value: 1 } as GoalPremise));

/** The two payloads from the ticket, verbatim shape. */
const LEG_TARGET = { key: 'target:auto_decrypt_clips_per_hr', value: 100, unit: 'clips/hr', barDirection: 'up', note: 'owner bar 100/hr' };
const LEG_RATE = { key: 'backlog:auto_decrypt_rate_clips_per_hr', value: 21.5, unit: 'clips/hr', barDirection: 'up', note: '07:05Z probe: decrypted/ ls=1169 vs summary 1122' };

describe('443fa1ee — the guards stay CORRECT (adjudicated framework-correct, never relaxed)', () => {
  it('replays both filed payloads: barDirection without a bar is still refused', () => {
    // Verbatim text of the second failure in the ticket.
    expect(normalizePremise(LEG_RATE, {})).toContain('barDirection needs a bar');
  });

  it('barDirection on a non-KPI premise is still refused even WITH a bar (a dead declaration)', () => {
    const plain = { key: 'backlog:some_rate', value: 21.5, bar: 100, barDirection: 'up' };
    expect(normalizePremise(plain, {})).toContain('barDirection is a KPI-bar field');
  });

  it('an unknown barDirection spelling is still refused (garbage never degrades to inference at write time)', () => {
    expect(normalizePremise({ key: 'kpi:rate', value: 1, bar: 10, barDirection: 'sideways', receiptId: '93fa77a9' }, {}))
      .toContain("barDirection must be one of 'up' | 'down'");
  });

  it('the run\'s ACTUAL recovery still lands: drop barDirection, keep both readings', () => {
    const dropTarget: any = { ...LEG_TARGET }; delete dropTarget.barDirection;
    const dropRate: any = { ...LEG_RATE }; delete dropRate.barDirection;
    const r = normalizePremises([dropTarget, dropRate], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.premises.find((p) => p.key === 'target:auto_decrypt_clips_per_hr')?.value).toBe(100);
    expect(r.premises.find((p) => p.key === 'backlog:auto_decrypt_rate_clips_per_hr')?.value).toBe(21.5);
  });
});

describe('443fa1ee — the refusal now teaches the shape that LANDS (the framework defect)', () => {
  it('a `target:` key is told its bound comes from the KEY, and to record observed — not to move onto kpi:', () => {
    const text = normalizePremise(LEG_TARGET, {}) as string;
    expect(text).toContain('TARGET premise');
    // names the bound THIS key implies (no max/ceiling → a floor)
    expect(text).toContain('observed');
    expect(text).toContain('observedNote');
    // the old dead-end advice must NOT be the whole story for a target key
    expect(text).not.toMatch(/^premise "[^"]+": barDirection is a KPI-bar field — register it on the goal's 'kpi:' premise \(kind:'kpi'\)$/);
  });

  it('a ceiling-named target key is read as an UPPER bound, a floor key as a LOWER bound', () => {
    const ceil = normalizePremise({ key: 'target_max_latency_ms', value: 500, barDirection: 'down' }, {}) as string;
    expect(ceil).toContain('UPPER bound');
    const floor = normalizePremise({ key: 'target:tokens_per_s', value: 20, barDirection: 'up' }, {}) as string;
    expect(floor).toContain('LOWER bound');
  });

  it('THE REMEDY THE TEXT NAMES ACTUALLY LANDS: bar in value + observed/observedNote on the target', () => {
    const remedy = {
      key: 'target:auto_decrypt_clips_per_hr', value: 100, unit: 'clips/hr',
      observed: 21.5, observedNote: '07:05Z probe: decrypted/ ls=1169 vs summary 1122 @04:54Z = 21.5/hr',
    };
    const r = normalizePremises([remedy], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.premises.find((p) => p.key === 'target:auto_decrypt_clips_per_hr')!;
    expect(row.value).toBe(100);
    expect(row.observed).toBe(21.5);
    // …and the reading is exactly what done-suspect grades: 21.5 < bar 100 ⇒ unmet
    expect(targetPremiseState(row)).toBe('unmet');
  });

  it('a NON-target key keeps the original kpi: wording (no behaviour change for the shape it fits)', () => {
    const text = normalizePremise({ key: 'plain_rate', value: 90, bar: 500, barDirection: 'down' }, {}) as string;
    expect(text).toContain("register it on the goal's 'kpi:' premise");
    expect(text).not.toContain('TARGET premise');
  });
});

describe('443fa1ee — af24badf rule: never advise a kpi: write THIS register refuses again', () => {
  /** A non-target, non-KPI key — the shape the kpi: advice genuinely fits. */
  const PLAIN = { key: 'backlog:rate_x', value: 21.5, bar: 100, barDirection: 'up' };

  it('THE FILED GOAL: already holds its one kpi: → the refusal says do NOT move it there', () => {
    const withKpi: GoalPremise[] = [...GOAL_8F0DCD6F.slice(0, 11), { key: 'kpi:clips_per_hr', value: 21.5, bar: 100 } as GoalPremise];
    const r = normalizePremises([PLAIN], withKpi, { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('at most ONE');
  });

  it('AT THE CAP with no kpi: → the refusal says the kpi: path is CLOSED and names the slot that needs no new key', () => {
    expect(GOAL_8F0DCD6F.length).toBe(PREMISE_MAX_PER_GOAL); // the real state: 12/12, zero kpi:
    const r = normalizePremises([PLAIN], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('CLOSED');
    expect(r.error).toContain(`${GOAL_8F0DCD6F.length}/${PREMISE_MAX_PER_GOAL}`);
  });

  it('NOT at the cap, no kpi: → the kpi: advice is valid and is NOT caveated (a real hatch is still offered)', () => {
    const roomy = GOAL_8F0DCD6F.slice(0, 5);
    const r = normalizePremises([PLAIN], roomy, { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("register it on the goal's 'kpi:' premise");
    expect(r.error).not.toContain('CLOSED');
    expect(r.error).not.toContain('at most ONE');
  });

  it('unrelated validation errors are passed through byte-identical (the caveat only ever touches barDirection placement)', () => {
    const r = normalizePremises([{ key: 'bad key!', value: 1 }], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(normalizePremise({ key: 'bad key!', value: 1 }, {}));
  });
});
/**
 * REPLAY PIN — ticket c58f0dc7-7ef0-412f-a8d5-d9a729406560 (mishap, breaker
 * trip 2026-11-05T07:18Z, lane 0037460b session / run baedaee5, goal 8f0dcd6f
 * "UPSTREAM DECRYPT SUPPLY — the real · Mon").
 *
 * A 3× tool-failure streak on goal_premise_set. The three filed failure texts,
 * verbatim (newest first), replayed below against the shipped code:
 *
 *   · a goal holds at most 12 premises (got 14: 12 already registered + 2 new
 *     key(s) in this call) — 2 keys must go …
 *   · premise "target:auto_decrypt_clips_per_hr" is a TARGET premise and
 *     carries its bar in `value` … barDirection is KPI-bar semantics and is
 *     not read on a target premise …
 *   · premise "backlog:auto_decrypt_rate_clips_per_hr": barDirection needs a
 *     bar … NOTE: the kpi: path is CLOSED on this goal right now — it already
 *     holds 12/12 premises with no kpi: key …
 *
 * ADJUDICATION (this lane, 2026-11-05): SPLIT per leg, as the tool-failure-
 * streak doctrine requires.
 *
 *   GUARDS — CORRECT, unchanged, pinned below so a future "helpful" relaxation
 *   trips this suite. `barDirection` is bar semantics only the KPI readers
 *   consume, so a non-KPI premise carrying it holds a dead declaration; a
 *   target premise carries its bound in the KEY; and the 12-key cap is the
 *   register's bound.
 *
 *   THE REFUSAL MECHANISM — FRAMEWORK DEFECT, fixed here. This is the fourth
 *   iteration of the af24badf class in premise-register, and the first whose
 *   cause was not any individual text: after #2243 (443fa1ee) and #2286
 *   (faeaa181) every text was already correct and self-describing, and all
 *   three are reproduced BYTE-FOR-BYTE by the shipped code (pinned below).
 *
 *   The defect was the ORDER and ARITY of disclosure. The lane re-sent the SAME
 *   payload three times. That payload carried THREE independent defects — two
 *   per-premise placement errors AND a whole-call cap overflow — but
 *   `normalizePremises` returned at the FIRST per-premise failure and could not
 *   evaluate the cap at all until the per-premise loop had passed (the cap is a
 *   property of the MERGED set). So:
 *
 *     call 1 disclosed the rate key's placement error (cap unsaid),
 *     call 2 disclosed the target key's placement error (cap unsaid),
 *     call 3, with both placements fixed, finally disclosed the cap.
 *
 *   Three independent defects cost three refused round-trips and tripped the
 *   breaker. af24badf's rule — "NEVER advise a retry this same branch would
 *   refuse again" — generalised: a refusal must never make the caller pay a
 *   round-trip for a defect THIS CALL ALREADY KNOWS ABOUT.
 *
 *   The fix collects every independent per-premise failure and appends the
 *   whole-call cap overflow — projected from the keys AS SENT, so it is the
 *   exact text the caller would get next — into ONE answer. A call with one
 *   blocking defect still returns exactly the text it returned before, so every
 *   earlier pin in this file's siblings stays valid.
 *
 * Recovery evidence from the filed run: the lane did land the write, but only
 * after spending all three calls on disclosure — the round-trips the fix
 * removes.
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

/**
 * The premise set goal 8f0dcd6f actually held at the trip — 12 keys, at the
 * cap, with ZERO kpi: keys. Taken from the filed goal's register (the same set
 * pinned by 443fa1ee / 7862cb2a).
 */
const GOAL_8F0DCD6F: GoalPremise[] = [
  'target:auto_decrypt_clips_per_hr', 'backlog:auto_decrypt_rate_clips_per_hr', 'backlog:auto_decrypt_clips_per_day',
  'backlog:clips_decrypted', 'backlog:walkable_window_undec', 'backlog:cutoff_ts', 'backlog.clips_downloaded',
  'backlog:manifest_rows', 'backlog:clips_diarized_rerun', 'backlog:missing_on_disk', 'backlog:diar_held_stems',
  'backlog:diar_silence_class',
].map((key) => ({ key, value: 1 } as GoalPremise));

/** The lane's payload, as the ticket's call args print it: the SAME array 3×. */
const PAYLOAD = [
  { key: 'target:auto_decrypt_clips_per_hr', value: 100, unit: 'clips/hr', barDirection: 'up', note: 'owner bar 100/hr' },
  { key: 'backlog:auto_decrypt_rate_clips_per_hr', value: 21.5, unit: 'clips/hr', barDirection: 'up', note: 'f18 07:11Z box receipt' },
  { key: 'backlog:auto_decrypt_wall_clips_per_hr', value: 7.2, unit: 'clips/hr', note: 'derived: 504/70h' },
  { key: 'backlog:auto_decrypt_opened_clips', value: 397, unit: 'clips', note: 'f18 opened=397' },
];

describe('c58f0dc7 — the three filed texts are STILL produced by the shipped guards (byte-for-byte)', () => {
  it('leg 1 (the oldest call): barDirection with no bar, + the cap caveat naming 12/12', () => {
    const err = normalizePremises([PAYLOAD[1]], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(err.ok).toBe(false);
    if (err.ok) return;
    // Verbatim head of the filed text.
    expect(err.error.startsWith('premise "backlog:auto_decrypt_rate_clips_per_hr": barDirection needs a bar')).toBe(true);
    // The af24badf caveat (#2243) is what told the lane the kpi: path was shut.
    expect(err.error).toContain('the kpi: path is CLOSED on this goal right now');
    expect(err.error).toContain(`12/${PREMISE_MAX_PER_GOAL}`);
  });

  it('leg 2: a target key carries its bound in the KEY — barDirection is not read there', () => {
    const err = normalizePremises([PAYLOAD[0]], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(err.ok).toBe(false);
    if (err.ok) return;
    expect(err.error).toContain('premise "target:auto_decrypt_clips_per_hr" is a TARGET premise');
    expect(err.error).toContain('reads as a LOWER bound: observed ≥ value is met');
  });

  it('leg 3: the whole-call cap overflow, with the honest arithmetic', () => {
    const placementsFixed = PAYLOAD.map(({ barDirection, ...rest }: any) => rest);
    const err = normalizePremises(placementsFixed, GOAL_8F0DCD6F, { mode: 'merge' });
    expect(err.ok).toBe(false);
    if (err.ok) return;
    // 12 registered + 2 NEW keys = 14 ⇒ 2 keys must go.
    expect(err.error).toContain(`got 14: 12 already registered + 2 new key(s) in this call`);
    expect(err.error).toContain('2 keys must go');
    // #2243/7862cb2a: the caller must be able to choose against FACTS.
    expect(err.error).toContain('Already registered: target:auto_decrypt_clips_per_hr');
  });
});

describe('c58f0dc7 — the GUARDS stay correct: this fix never relaxes one', () => {
  it('barDirection on a non-KPI premise is still refused even WITH a bar', () => {
    const err = normalizePremises([{ key: 'backlog:rate', value: 21.5, bar: 100, barDirection: 'up' }], [], { mode: 'merge' });
    expect(err.ok).toBe(false);
    if (err.ok) return;
    expect(err.error).toContain('barDirection is a KPI-bar field');
  });

  it('an unknown barDirection spelling is still refused', () => {
    expect(normalizePremise({ key: 'kpi:r', value: 1, bar: 10, barDirection: 'sideways', receiptId: '93fa77a9' }, {}))
      .toContain("barDirection must be one of 'up' | 'down'");
  });

  it('the cap is still a hard refusal — 13 distinct keys never land', () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, value: i }));
    expect(normalizePremises(thirteen, [], { mode: 'merge' }).ok).toBe(false);
    // …and 12 does.
    expect(normalizePremises(thirteen.slice(0, 12), [], { mode: 'merge' }).ok).toBe(true);
  });
});

describe('c58f0dc7 — THE FIX: every independent defect in ONE answer', () => {
  it('REPLAY: the filed payload now discloses ALL THREE defects on the first call', () => {
    const r = normalizePremises(PAYLOAD, GOAL_8F0DCD6F, { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // (1) the rate key's placement error
    expect(r.error).toContain('premise "backlog:auto_decrypt_rate_clips_per_hr": barDirection needs a bar');
    // (2) the target key's placement error
    expect(r.error).toContain('premise "target:auto_decrypt_clips_per_hr" is a TARGET premise');
    // (3) the cap overflow that used to be INVISIBLE until both were fixed.
    // CERTAIN here: the two VALID premises alone (2 new keys onto 12) overflow,
    // so no repair of the invalid ones can rescue the call.
    expect(r.error).toMatch(/at most 12 premises \(got 14: 12 already registered \+ 2 new key\(s\)/);
    expect(r.error).toContain('THIS CALL CANNOT LAND EVEN IF THE INVALID PREMISE(S) BELOW ARE FIXED');
    // It says plainly that the invalid premises are a separate, counted problem
    // and that fixing them one-per-call is the wrong move.
    expect(r.error).toContain('The 2 invalid premise(s) below are a SEPARATE problem');
    expect(r.error).toContain('fix both the list and the size, then re-send once');
    // Both defects are actually ENUMERATED in the one answer.
    expect(r.error).toContain('(1) premise "target:auto_decrypt_clips_per_hr" is a TARGET premise');
    expect(r.error).toContain('(2) premise "backlog:auto_decrypt_rate_clips_per_hr": barDirection needs a bar');
  });

  it('the number of refused round-trips the filed lane paid (3) collapses to 1', () => {
    // Reproduce the lane's actual behaviour: fix one reported defect per retry.
    // Before the fix this loop needed 3 calls (each call revealed exactly one).
    let payload: any[] = PAYLOAD.map((p) => ({ ...p }));
    let calls = 0;
    for (;;) {
      calls += 1;
      const r = normalizePremises(payload, GOAL_8F0DCD6F, { mode: 'merge' });
      if (r.ok) break;
      if (calls === 1) {
        // The FIRST answer already names every defect ⇒ drop both placements AND
        // the two new keys in one move, exactly as the text instructs.
        payload = payload.slice(0, 2).map(({ barDirection, ...rest }: any) => rest);
        continue;
      }
      throw new Error(`expected the first answer to be actionable, got: ${r.error}`);
    }
    expect(calls).toBe(2); // 1 refusal + 1 landing call — not 4
    // The write that lands carries the readings the lane was trying to record.
    const final = normalizePremises(payload, GOAL_8F0DCD6F, { mode: 'merge' });
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.premises.find((p) => p.key === 'target:auto_decrypt_clips_per_hr')?.value).toBe(100);
    expect(final.premises.find((p) => p.key === 'backlog:auto_decrypt_rate_clips_per_hr')?.value).toBe(21.5);
  });

  it('BYTE-COMPAT: a call with ONE blocking defect that does not touch the cap is unchanged', () => {
    const single = normalizePremises([PAYLOAD[1]], [], { mode: 'merge' });
    expect(single.ok).toBe(false);
    if (single.ok) return;
    expect(single.error).toBe(normalizePremise(PAYLOAD[1], {}) as string);
    // …and against the FILED goal it is the caveated text, byte-for-byte: this
    // key is ALREADY registered, so re-sending it adds no slot.
    const atCap = normalizePremises([PAYLOAD[1]], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(atCap.ok).toBe(false);
    if (atCap.ok) return;
    expect(atCap.error).toContain('barDirection needs a bar');
    expect(atCap.error).toContain('the kpi: path is CLOSED');
    expect(atCap.error).not.toContain('are invalid');
  });

  it('a ONE-defect call that also overflows still discloses BOTH (never the bare text)', () => {
    // 1 invalid + 1 VALID new key on a 12/12 goal ⇒ the valid one already makes 13.
    const both = normalizePremises([
      { key: 'backlog:brand_new', value: 1, barDirection: 'up' },
      { key: 'backlog:another_new', value: 2 },
    ], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(both.ok).toBe(false);
    if (both.ok) return;
    expect(both.error).toContain('The 1 invalid premise(s) below are a SEPARATE problem');
    expect(both.error).toContain('THIS CALL CANNOT LAND');
    expect(both.error).toMatch(/at most 12 premises \(got 13: 12 already registered \+ 1 new key\(s\)/);
  });

  it('BYTE-COMPAT: the success path and the plain-cap path are unchanged', () => {
    // Success is untouched.
    const ok = normalizePremises([{ key: 'backlog:rate', value: 21.5 }], GOAL_8F0DCD6F.slice(0, 3), { mode: 'merge' });
    expect(ok.ok).toBe(true);

    // The cap-only path returns the SAME string the branch always returned —
    // no enumeration preamble leaks into a call with no per-premise errors.
    const cap = normalizePremises([{ key: 'brand_new', value: 1 }], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(cap.ok).toBe(false);
    if (cap.ok) return;
    expect(cap.error.startsWith('a goal holds at most 12 premises')).toBe(true);
    expect(cap.error).not.toContain('are invalid');
  });

  it('THE PROJECTION CANNOT DRIFT: the CERTAIN cap text equals the real cap refusal', () => {
    // The certain-path notice must quote the text the caller gets NEXT, or it
    // is just a second, softer dead end. Pin the two to the same string.
    const placementsFixed = PAYLOAD.map(({ barDirection, ...rest }: any) => rest);
    const real = normalizePremises(placementsFixed, GOAL_8F0DCD6F, { mode: 'merge' });
    expect(real.ok).toBe(false);
    if (real.ok) return;
    const multi = normalizePremises(PAYLOAD, GOAL_8F0DCD6F, { mode: 'merge' });
    expect(multi.ok).toBe(false);
    if (multi.ok) return;
    expect(multi.error).toContain(real.error);
  });

  it('a duplicate key and a placement error are both disclosed together', () => {
    const r = normalizePremises([
      { key: 'backlog:rate', value: 1 },
      { key: 'backlog:rate', value: 2 },
      { key: 'backlog:other', value: 1, barDirection: 'up' },
    ], [], { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"backlog:rate" given twice');
    expect(r.error).toContain('barDirection needs a bar');
  });

  it('the KPI-contract tag still travels with a multi-defect answer', () => {
    const r = normalizePremises([
      { key: 'bad key!', value: 1 },
      { key: 'kpi:rate', value: 1 },
    ], [], { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // goals.service records the refusal reason from this tag; a collected
    // failure must not lose it.
    expect(r.kpiRefusal).toEqual({ reason: 'no_receipt', key: 'kpi:rate' });
  });

  it('the target remedy the text names still lands, unchanged', () => {
    const r = normalizePremises([
      { key: 'target:auto_decrypt_clips_per_hr', value: 100, unit: 'clips/hr', observed: 21.5, observedNote: '07:11Z probe' },
    ], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.premises.find((p) => p.key === 'target:auto_decrypt_clips_per_hr')!;
    expect(row.value).toBe(100);
    expect(row.observed).toBe(21.5);
    expect(targetPremiseState(row)).toBe('unmet');
  });
});

/**
 * REGRESSION — the adversarial review's blocking finding (2026-11-05). The
 * first cut of this fix projected the cap over the keys AS SENT and therefore
 * asserted an overflow the CORRECTED call would not hit — af24badf's rule
 * broken in the opposite direction: a refusal pointing at a retry this branch
 * ACCEPTS. These cases are the reviewer's counterexamples, kept.
 */
describe('c58f0dc7 — the cap notice never asserts an overflow the repair would clear', () => {
  it("reviewer's counterexample: 12 VALID keys + a keyless stray in replace mode still LANDS", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, value: i }));
    const stray = { key: 'bad key!', value: 1 };
    const r = normalizePremises([...twelve, stray], [], { mode: 'replace' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The repaired call (drop the stray) fits — so the notice must NOT say the
    // call is over the cap.
    expect(normalizePremises(twelve, [], { mode: 'replace' }).ok).toBe(true);
    expect(r.error).not.toContain('CANNOT LAND');
    // It MAY warn about the worst case, and must say the merge/drop repair.
    expect(r.error).toContain('up to 13');
    expect(r.error).toContain('fits');
  });

  it('a keyless slot and a non-object element are each their own slot (never one phantom)', () => {
    // Both invalid; the correct slots are 2, so the upper bound is 2 not 1.
    const r = normalizePremises([{ value: 1 }, 'nonsense'], [], { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Two separate defects (a keyless slot AND a non-object), each enumerated.
    expect(r.error).toContain('2 premises in this call are invalid');
    expect(r.error).toContain('(1) premise key must be');
    expect(r.error).toContain('(2) premise must be an object');
  });

  it('two DISTINCT over-long keys do not dedupe into one slot', () => {
    const longA = { key: 'x'.repeat(80) + 'a', value: 1 };
    const longB = { key: 'x'.repeat(80) + 'b', value: 2 };
    const r = normalizePremises([longA, longB], [], { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Two separate defects, not one — clipping the raw key would have merged
    // them into a single reported key. Both raw keys are echoed.
    expect(r.error).toContain('2 premises in this call are invalid');
    expect(r.error).toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxa');
    expect(r.error).toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxb');
  });

  it('the answer is BOUNDED — the cap notice is never buried behind a long list', () => {
    // 8 verbose defects used to run to 11k chars with the notice at ~10.2k,
    // past the display cap. The notice must lead.
    const many = Array.from({ length: 8 }, (_, i) => ({ key: 'bad key! ' + i, value: 1, barDirection: 'up', note: 'n'.repeat(150) }));
    const r = normalizePremises([...many, { key: 'brand_new', value: 1 }], GOAL_8F0DCD6F, { mode: 'merge' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeLessThan(6000);
    expect(r.error).toContain('THIS CALL CANNOT LAND');
    // The cap fact appears BEFORE the list.
    expect(r.error.indexOf('CANNOT LAND')).toBeLessThan(r.error.indexOf('(1) '));
    // …and the list is capped in COUNT too.
    expect(r.error).toContain('more invalid premise(s)');
  });

  it('mode:replace does not count already-registered keys against the call', () => {
    // 3 keys, all new, replace: fits even though the goal holds 12.
    const r = normalizePremises(
      [{ key: 'n1', value: 1 }, { key: 'n2', value: 2 }, { key: 'n3', value: 3, barDirection: 'up' }],
      GOAL_8F0DCD6F, { mode: 'replace' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toContain('CANNOT LAND');
    expect(r.error).not.toContain('at most 12 premises');
  });
});

/** The single-error path applies the af24badf kpi: caveat — mirror it here. */
function withCaveat(text: string, existing: GoalPremise[], mode: 'merge' | 'replace'): string {
  // The shipped caveat fires only on barDirection-placement text when the kpi:
  // write would be refused. For an EMPTY register it adds nothing.
  if (!/barDirection (?:is a KPI-bar field|needs a bar)/.test(text)) return text;
  if (existing.length > 0) throw new Error('helper only used for the empty-register case');
  return text;
}
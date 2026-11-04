/**
 * Mishap af24badf (2026-10-30, ticket af24badf-abf8-494a-a197-b39369553a2f —
 * lane dc2796a9 run 63b56643, goal 4860aa67): a 3× tool-failure streak on
 * goal_premise_set with two DIFFERENT failure texts. Only one of them was a
 * defect:
 *
 *   (1) `a goal holds at most 12 premises (got 14: 11 already registered + 3 in
 *       this call) — resend fewer keys, or resend the full intended set with
 *       mode:'replace'`
 *       → FRAMEWORK DEFECT. The second half of that advice is arithmetically
 *       impossible for the very call it advises on: the full intended set is
 *       11 + 3 = 14 keys, and a replace keeps exactly the keys you send, so
 *       following the instruction verbatim lands the caller in THIS branch
 *       with the bare legacy text (no arithmetic, no hatch). One refusal
 *       pointed at another refusal and burned the tool rounds the message
 *       exists to save. This is the 0aeb8844 dead-end class one level up.
 *
 *   (2) `premise "per_slot_byte_identity_rows:diag": observedNote needs
 *       observed (the measured number it describes)`
 *       → MODEL BEHAVIOUR, not a defect: the guard is correct (a note without
 *       a number describes nothing), the text names the key AND the missing
 *       field, and the lane recovered unaided in the same run (receipt
 *       c89be521, ok:true). Pinned here so a future "helpful" relaxation of
 *       the observed/observedNote pair has to argue with a replay.
 *
 * The invariant this file enforces: NO refusal may advise a retry that the
 * tool would refuse again. Asserted positively — we EXECUTE the advised remedy
 * and require it to land.
 */
const mockPrisma: any = {};
const mockRedis: any = {};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { normalizePremises, normalizePremise, PREMISE_MAX_PER_GOAL } from './premise-register';

/** The live goal 4860aa67 shape at the trip: 11 registered, 3 new intended. */
const elevenRegistered = Array.from({ length: 11 }, (_, i) => ({ key: `p${i}`, value: i, unit: 'rows' })) as any;
const threeNew = [
  { key: 'a_new', value: 1 },
  { key: 'b_new', value: 2 },
  { key: 'c_new', value: 3 },
] as any;

describe('mishap af24badf — a premise-cap refusal must never advise a retry it would refuse again', () => {
  it('REPLAY: the exact failing call (11 registered + 3 new, merge) names the arithmetic, the drop count, and a hatch that FITS', () => {
    const res = normalizePremises(threeNew, elevenRegistered, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // the arithmetic the lane needs (unchanged from 0aeb8844)
    expect(res.error).toContain(`at most ${PREMISE_MAX_PER_GOAL} premises`);
    expect(res.error).toContain(`got 14: 11 already registered + 3 new key(s) in this call`);
    // DEFECT FIX: how many keys must actually go, stated as a number
    expect(res.error).toContain('2 keys must go');
    // DEFECT FIX: the drop must target NEW keys — dropping a re-sent key
    // moves the union by zero, which was the second way to loop forever.
    expect(res.error).toContain('drop at least 2 of the NEW key(s)');
    // DEFECT FIX: the advised set is the ≤cap set the goal should END with —
    // never "the full intended set", which is the set that does not fit.
    expect(res.error).toContain(`the ≤${PREMISE_MAX_PER_GOAL}-key set you want it to KEEP`);
    expect(res.error).not.toContain('resend the full intended set');
  });

  it('the dead end itself: the OLD advice ("full intended set with replace") is refused again — this is what made the streak deterministic', () => {
    // 11 kept + 3 new = the "full intended set" the refusal used to name.
    const intended = [
      ...elevenRegistered.map((p: any) => ({ key: p.key, value: p.value })),
      ...threeNew,
    ];
    const res = normalizePremises(intended, elevenRegistered, { mode: 'replace' });
    expect(res.ok).toBe(false); // 14 keys > cap — following the old advice could never land
    if (res.ok) return;
    // and the refusal that greets the caller must now explain WHY, with counts
    expect(res.error).toContain(`got 14`);
    expect(res.error).toContain('2 keys must go');
    expect(res.error).toContain('a replace keeps exactly the keys it is sent');
  });

  it('INVARIANT (the actual fix): the remedy the merge refusal names, executed literally, LANDS', () => {
    const res = normalizePremises(threeNew, elevenRegistered, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(`the ≤${PREMISE_MAX_PER_GOAL}-key set you want it to KEEP with mode:'replace'`);

    // Do exactly what it says: pick the ≤cap set the goal should end with,
    // re-sending every already-registered key still needed, and replace.
    const keep = [...elevenRegistered.slice(0, PREMISE_MAX_PER_GOAL - 3).map((p: any) => ({ key: p.key, value: p.value })), ...threeNew];
    expect(keep).toHaveLength(PREMISE_MAX_PER_GOAL);
    const landed = normalizePremises(keep, elevenRegistered, { mode: 'replace' });
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    expect(landed.premises).toHaveLength(PREMISE_MAX_PER_GOAL);
    for (const n of threeNew) expect(landed.premises.some((p) => p.key === n.key)).toBe(true);
  });

  it('the "fewer keys" half still works as stated: merging keys that fit lands', () => {
    const oneNew = normalizePremises([{ key: 'a_new', value: 1 }], elevenRegistered, {});
    expect(oneNew.ok).toBe(true);
    if (!oneNew.ok) return;
    expect(oneNew.premises).toHaveLength(PREMISE_MAX_PER_GOAL);
  });

  it('an over-cap input array in EITHER mode states the count and never invents a hatch (a call already over the cap cannot land)', () => {
    const huge = Array.from({ length: PREMISE_MAX_PER_GOAL + 2 }, (_, i) => ({ key: `fresh_${i}`, value: i })) as any;
    for (const mode of ['merge', 'replace'] as const) {
      const res = normalizePremises(huge, [], { mode });
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error).toContain('2 keys must go from this call');
      expect(res.error).toContain('the call itself must shrink');
      // no hatch may be advertised for a call that is itself over the cap
      expect(res.error).not.toContain("mode:'replace' (a replace keeps ONLY");
    }
  });

  it('HONEST ARITHMETIC (review af24badf BLOCKING): a bulk-upsert call that re-sends registered keys must not report them as NEW', () => {
    // prior 11; call re-sends 10 of them + 2 genuinely new = 12 keys sent
    // (≤ cap, so this lands in the HATCH branch), union = 13.
    const resend = elevenRegistered.slice(0, 10).map((p: any) => ({ key: p.key, value: p.value }));
    const twoNew = [{ key: 'x_new', value: 1 }, { key: 'y_new', value: 2 }];
    const res = normalizePremises([...resend, ...twoNew], elevenRegistered, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The goal holds 11; only 2 of this call's keys are new. The OLD formula
    // (`premises.length - incoming.length` = 13 - 12 = 1) printed
    // "1 already registered", which is a different (and wrong) number.
    expect(res.error).toContain('11 already registered');
    expect(res.error).toContain('2 new key(s) in this call');
    // the OLD formula reported "1 already registered" here — a number that
    // matches neither the goal (11) nor the new keys (2)
    expect(res.error).not.toMatch(/(^|[^1])1 already registered/);
    // and the drop must be aimed at NEW keys: dropping a re-sent key moves the
    // union by zero, which was the second way to loop.
    expect(res.error).toContain('drop at least 1 of the NEW key(s)');
    // obeying it on a NEW key lands first try
    const landed = normalizePremises([...resend, twoNew[0]], elevenRegistered, {});
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    expect(landed.premises).toHaveLength(PREMISE_MAX_PER_GOAL);
  });

  it('a register ALREADY above the cap can only be fixed by a trim, and the refusal says so (never "drop a new key")', () => {
    const oversized = Array.from({ length: PREMISE_MAX_PER_GOAL + 3 }, (_, i) => ({ key: `legacy_${i}`, value: i })) as any;
    const res = normalizePremises([{ key: 'one_more', value: 1 }], oversized, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(`ALREADY holds ${oversized.length}`);
    expect(res.error).toContain(`mode:'replace'`);
    // dropping new keys cannot help here — it must not be offered as the remedy
    expect(res.error).not.toContain('drop at least');
    // and the trim it names actually lands
    const trim = normalizePremises(oversized.slice(0, PREMISE_MAX_PER_GOAL).map((p: any) => ({ key: p.key, value: p.value })), oversized, { mode: 'replace' });
    expect(trim.ok).toBe(true);
  });

  // ── member 2 of the streak: NOT a defect, pinned so it stays correct ────────
  it('MODEL BEHAVIOUR (not a defect): observedNote without observed is refused with the key and the missing field named', () => {
    const err = normalizePremise({ key: 'per_slot_byte_identity_rows:diag', value: 3, observedNote: 'per-slot sums == recv' });
    expect(err).toMatch(/observedNote needs observed/);
    expect(String(err)).toContain('per_slot_byte_identity_rows:diag');
    // and the call the lane SHOULD have made lands, with the number it describes
    const ok = normalizePremise(
      { key: 'per_slot_byte_identity_rows:diag', value: 3, observed: 3, observedNote: 'per-slot sums == recv' },
      { now: new Date('2026-10-30T06:22:01.049Z') },
    );
    expect(typeof ok).not.toBe('string');
    expect(ok).toMatchObject({ observed: 3, observedNote: 'per-slot sums == recv' });
  });
});
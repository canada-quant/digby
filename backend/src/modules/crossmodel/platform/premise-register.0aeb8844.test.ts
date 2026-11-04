/**
 * Mishap 0aeb8844 (2026-09-24, CanLaw supervisor session f5c2c1f4): a lane at
 * the 8-premise cap called goal_premise_set with 1 new premise (merge, the
 * default) twice and was refused twice with the bare count —
 *   "a goal holds at most 8 premises (got 9) — keep the ones the plan actually
 *    rests on"
 * The lane KNEW the cap (its own 17:15Z note: "both goals sit at the 8-premise
 * cap and goal_premise_set refused") and recovered ~90 min later via
 * mode:'replace'. Verdict: model behavior, not a framework defect — but the
 * refusal was a dead end: it named no arithmetic and no escape hatch, so the
 * model's only legal retry (fewer keys) was invisible.
 *
 * Replays the exact call shape (cap existing + 1 new, merge) and pins the
 * surfaces the fix changed:
 *   1. the merge-overflow refusal names the arithmetic, the DROP COUNT, and a
 *      mode:'replace' hatch whose advised set actually fits the cap;
 *   2. an input array already over the cap names why there is no hatch and
 *      never advertises one (updated by af24badf, 2026-10-30 — the legacy bare
 *      text is no longer emitted: following the old "resend the full set with
 *      mode:'replace'" advice from THIS shape is impossible, which is exactly
 *      the dead end af24badf filed);
 *   3. the escape hatch itself works — replace with a ≤cap intended set lands.
 */
const mockPrisma: any = {};
const mockRedis: any = {};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import * as fs from 'fs';
import * as path from 'path';
import { normalizePremises, PREMISE_MAX_PER_GOAL } from './premise-register';

const cap = PREMISE_MAX_PER_GOAL; // 8

const fullGoal = Array.from({ length: cap }, (_, i) => ({ key: `premise_${i}`, value: i }));

const readSrc = (): string => fs.readFileSync(path.join(__dirname, 'platform-tools.ts'), 'utf8');

describe('mishap 0aeb8844 — goal_premise_set cap refusals are self-explanatory', () => {
  it('REPLAY: merging 1 new premise onto a capped goal is refused with the union arithmetic, the drop count AND a fitting mode:replace hatch', () => {
    const res = normalizePremises([{ key: 'new_premise', value: 1 }], fullGoal, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(`at most ${cap} premises (got ${cap + 1}`);
    expect(res.error).toContain(`${cap} already registered + 1 new key(s) in this call`);
    expect(res.error).toContain('1 key must go');
    expect(res.error).toContain("mode:'replace'");
  });

  it('a merge of multiple new keys reports both halves of the union', () => {
    const res = normalizePremises(
      [{ key: 'a_new', value: 1 }, { key: 'b_new', value: 2 }],
      fullGoal,
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(`${cap} already registered + 2 new key(s) in this call`);
    expect(res.error).toContain('2 keys must go');
  });

  // Updated by af24badf (2026-10-30): the legacy bare text is gone by design —
  // its advice ("resend the full intended set with mode:'replace'") was
  // impossible to follow when the input was itself over the cap, which is the
  // second dead end the ticket filed. Pin what the messages must now say.
  it('replace mode with an over-cap array states the count and why no hatch exists', () => {
    const res = normalizePremises(
      [...fullGoal, { key: 'extra', value: 9 }],
      fullGoal,
      { mode: 'replace' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(`at most ${cap} premises`);
    expect(res.error).toContain('the call itself must shrink');
    // no hatch may be advertised for a call that is itself over the cap
    expect(res.error).not.toContain("mode:'replace' (a replace keeps ONLY");
  });

  it('a merge whose INPUT array is already over the cap names why it cannot land', () => {
    const res = normalizePremises(
      Array.from({ length: cap + 1 }, (_, i) => ({ key: `fresh_${i}`, value: i })),
      [],
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(`this call sends ${cap + 1} keys`);
    expect(res.error).toContain('the call itself must shrink');
    expect(res.error).not.toContain("mode:'replace' (a replace keeps ONLY");
  });

  it('the escape hatch works: replace with the full intended set lands inside the cap and drops the stale key', () => {
    const intended = [...fullGoal.slice(0, cap - 1), { key: 'new_premise', value: 1 }];
    const res = normalizePremises(intended, fullGoal, { mode: 'replace' });
    // C3: replace of unchanged values is no revision. Ticket 7862cb2a: the
    // drop is now REPORTED (`dropped`) rather than silent — this pin's own
    // title names the stale-key drop, so it asserts it.
    expect(res).toEqual({ ok: true, premises: expect.any(Array), revisions: [], dropped: [`premise_${cap - 1}`] });
    if (!res.ok) return;
    expect(res.premises).toHaveLength(cap);
    expect(res.premises.some((p) => p.key === 'new_premise')).toBe(true);
    // the displaced stale premise is gone
    expect(res.premises.some((p) => p.key === `premise_${cap - 1}`)).toBe(false);
  });

  it('the tool description states that merge counts the union and points at mode:replace', () => {
    const src = readSrc();
    expect(src).toContain('merge counts the UNION with what is already registered');
    expect(src).toContain("with mode:'replace'");
  });
});

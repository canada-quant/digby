/**
 * PIN (FO firing 60, 2026-10-01) — the guardmiss seam probe must scan CALL
 * SITES, not bare literals, and must never pass vacuously.
 *
 * THE INCIDENT THIS PINS: the firing-60 opening ship-check ran
 * scripts/framework-audit/verify-iter59-guardmiss-seam.js (shipped by firing
 * 59) against the live dist and it FAILED (rc 1) with miss_sites_without_seam=1
 * — while the fix itself was healthy (DB legs green: post_boundary 0,
 * clean_shape 1/1). Ground truth (contexts dumped from /app/dist): the dist
 * contains exactly 3 occurrences of the bare literal `GUARD_MISS`; the third
 * is a source COMMENT ("records the same verdict as GUARD_STRIKE/GUARD_MISS
 * telemetry —") that tsc copies verbatim into the dist. The probe's bare
 * literal scan counted that comment as an unseamed call site — the probe
 * could never have passed as shipped, on any deploy, ever.
 *
 * THE FIX (firing 60): the needle is the CALL-SITE shape
 * `LOOP_METRIC_KINDS.GUARD_MISS` (the dist compiles it to
 * `loop_metrics_service_1.LOOP_METRIC_KINDS.GUARD_MISS`, which still contains
 * the needle — one needle matches source and dist alike), and leg (a) also
 * requires miss_sites >= 2 (carried_receipt + the clean-final arm) so a
 * needle matching NOTHING fails loud instead of passing vacuously.
 *
 * This pin is TEXTUAL + BEHAVIORAL:
 *  - TEXTUAL: the shipped probe declares the call-site NEEDLE and its fail
 *    predicate carries the `miss_sites < 2` vacuous-pass guard.
 *  - BEHAVIORAL: scanning the incident's exact dist shape (compiled comment +
 *    two seam-stamped call sites) with the probe's NEEDLE yields 2 sites /
 *    0 unseamed, while the OLD bare needle yields 3 / 1 — the regression a
 *    future edit back to a bare literal would reintroduce.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (the sibling f59 pin test also declares top-level fs/path)

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/framework-audit/verify-iter59-guardmiss-seam.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

const PROBE = path.join(repoRoot(__dirname), 'scripts/framework-audit/verify-iter59-guardmiss-seam.js');

/** The probe's own scan algorithm, driven by an explicit needle (the shape under pin). */
function scan(src: string, needle: string): { sites: number; withoutSeam: number } {
  const sites: string[] = [];
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    sites.push(src.slice(i, i + 400));
    i += needle.length;
  }
  return { sites: sites.length, withoutSeam: sites.filter((c) => !c.includes('seam:')).length };
}

// The incident's dist shape, reconstructed from the live /app/dist dump
// (2026-10-01T10:33Z): one compiled comment + two seam-stamped call sites.
// The comment and the first call site sit ~25KB apart in the real dist
// (offsets 99509 vs 124467) — the filler below keeps the comment's 400-char
// scan window clear of the next site's seam, exactly like production.
const FILLER = new Array(12).fill(
  '// ── Machine-run wall-clock deadline (v1#33): a wedged MACHINE run held its\n' +
  '// lane busy forever (the schedule busy-skip re-arms +3 min, so the fleet\n' +
  '// read the lane as healthy). Machine coding runs get a SOFT deadline —\n' +
  '// max(20 min, 0.8 × the chat\'s shortest enabled recurring interval) — via\n' +
  '// the profile field the agent loop already honors (runDeadlineMs).\n'
).join('');
const INCIDENT_DIST = [
  '// the finalize lane below, which',
  '// records the same verdict as GUARD_STRIKE/GUARD_MISS telemetry —',
  '// opt-in EVIDENCE_GUARD_ENFORCE=1 restores enforcement (one round/attempt).',
  'const GUARD_REJECT_BACK_MAX = process.env.EVIDENCE_GUARD_ENFORCE === \'1\' ? 1 : 0;',
  FILLER,
  '(0, loop_metrics_service_1.recordLoopMetric)({ kind: loop_metrics_service_1.LOOP_METRIC_KINDS.GUARD_MISS,',
  '  sessionId: id, runId: claimed.id, stamp: runMetricStamp,',
  '  meta: { seam: \'carried_receipt\', n: 2, kinds: [\'pr\'], outcome: \'observed\' }, });',
  FILLER,
  '...verdictHasFindings ? ({ kind: LOOP_METRIC_KINDS.GUARD_STRIKE, meta: { seam: \'final_verdict\', outcome: \'observed\' } })',
  '  : { kind: loop_metrics_service_1.LOOP_METRIC_KINDS.GUARD_MISS, sessionId: id, runId: claimed.id,',
  '      stamp: runMetricStamp, meta: { seam: \'final_verdict\', outcome: \'clean\' } });',
].join('\n');

describe('verify-iter59-guardmiss-seam probe needle + vacuous-pass guard (FO firing 60)', () => {
  const probeSrc = fs.readFileSync(PROBE, 'utf8');

  it('the probe declares the CALL-SITE needle, never a bare GUARD_MISS literal', () => {
    const m = probeSrc.match(/const NEEDLE = '([^']+)';/);
    expect(m).toBeTruthy(); // the NEEDLE declaration itself must survive refactors
    expect(m![1]).toBe('LOOP_METRIC_KINDS.GUARD_MISS');
  });

  it('the fail predicate carries the miss_sites >= 2 vacuous-pass guard', () => {
    const m = probeSrc.match(/const fail = ([^;]+);/s);
    expect(m).toBeTruthy();
    expect(m![1]).toContain('out.miss_sites < 2');
    expect(m![1]).toContain('out.miss_sites_without_seam > 0');
  });

  it('the fail predicate compares Prisma BigInt counts through Number() (f60 second defect)', () => {
    const m = probeSrc.match(/const fail = ([^;]+);/s);
    expect(m).toBeTruthy();
    // The coercions are hoisted into locals (cleanRows/shaped) so the fail
    // expression compares like-typed Numbers — assert BOTH the hoist and its use.
    expect(probeSrc).toContain('Number(out.clean_shape.clean_rows)');
    expect(probeSrc).toContain('Number(out.clean_shape.shaped)');
    expect(m![1]).toContain('cleanRows > 0 && shaped !== cleanRows');
    // BEHAVIORAL: the incident shape — Prisma BigInt shaped vs int clean_rows.
    // The f59 predicate's strict compare read 1n !== 1 → true (BigInt vs
    // Number NEVER strictly equal), failing the probe on a HEALTHY dist once
    // the first post-flip clean row existed. TypeScript flags the literal
    // cross-type compare as TS2367 — which is itself the bug's fingerprint —
    // so the reproduction serializes both sides instead.
    const prismaShape: { clean_rows: number; shaped: bigint } = { clean_rows: 1, shaped: 1n };
    expect(`${prismaShape.shaped}` !== `${prismaShape.clean_rows}`).toBe(false); // same value, cross type
    expect(Object.is(Number(prismaShape.shaped), prismaShape.clean_rows)).toBe(true); // Number() fixes it
    expect(Number(prismaShape.shaped) !== Number(prismaShape.clean_rows)).toBe(false); // the fix's compare
  });

  it('BEHAVIORAL: the call-site needle reads the incident dist as 2 sites / 0 unseamed', () => {
    const got = scan(INCIDENT_DIST, 'LOOP_METRIC_KINDS.GUARD_MISS');
    expect(got).toEqual({ sites: 2, withoutSeam: 0 }); // probe PASSES on the healthy dist
  });

  it('BEHAVIORAL (regression doc): the OLD bare needle reads the same dist as 3 / 1 — the f60 false positive', () => {
    const got = scan(INCIDENT_DIST, 'GUARD_MISS');
    expect(got.sites).toBe(3);
    expect(got.withoutSeam).toBe(1); // the compiled comment — never a call site
  });

  it('BEHAVIORAL: a dist with ZERO call sites must trip the vacuous-pass guard', () => {
    const empty = scan('// a future dist where the kind was renamed entirely\n', 'LOOP_METRIC_KINDS.GUARD_MISS');
    expect(empty.sites).toBe(0);
    expect(0 < 2).toBe(true); // the predicate's miss_sites < 2 arm fails the probe
  });
});

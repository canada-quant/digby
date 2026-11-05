/* verify-iter59-guardmiss-seam.js — FO standing probe (READ-ONLY).
 * Firing 59 (2026-10-01) fixed the CLEAN-final guard_miss seam stamp:
 * run-executor.ts's clean-final branch passed `stamp` but NO `meta`, so the
 * merged meta carried only run-stamp fields and the audit's d column
 * (COALESCE(detector, seam, reason)) read '?' — 12 blind rows/4h, the f58
 * class on the MISS side. The fix stamps meta { seam: 'final_verdict',
 * outcome: 'clean' } (parity with the strike branch's seam).
 *
 * Legs:
 *  (a) DIST: the compiled run-executor.js clean-final guard_miss line carries
 *      seam 'final_verdict' + outcome 'clean' (source-vs-compiled doctrine:
 *      grep where the literal LIVES — /app/dist, fs.readFileSync, never docker).
 *      FIRING-60 FIX: the scan needle is the CALL-SITE shape
 *      `LOOP_METRIC_KINDS.GUARD_MISS`, never the bare `GUARD_MISS` — a bare
 *      literal also matches source COMMENTS that compile verbatim into the
 *      dist (the `GUARD_STRIKE/GUARD_MISS telemetry` comment tripped exactly
 *      this probe at the f60 opening ship-check: miss_sites_without_seam=1
 *      from a comment, while all three real sites stamped seams). Leg (a)
 *      also REQUIRES miss_sites >= 2 (carried_receipt + the clean-final arm):
 *      a needle that matches nothing must FAIL LOUD, never pass vacuously.
 *  (b) DB: post-flip rows — guard_miss rows whose meta has NO seam must be 0
 *      OUTSIDE the deploy-boundary window (a flip boundary stamps the
 *      deploy time; rows written by the draining old colour inside 6h of it
 *      are old-code-shaped by construction — reported as boundary_n, never
 *      failed on, same doctrine as verify-iter58-av-evidence.js).
 *  (c) DB: clean-final guard_miss rows carry outcome='clean' with
 *      seam='final_verdict' (the fix's shape) once post-flip rows exist.
 * Usage: verify-iter59-guardmiss-seam.js <deployFlipISO>   (flip = the wave's
 * completion time for the commit carrying this fix; required for (b)/(c)). */
const fs = require('fs');
const out = { probe: 'verify-iter59-guardmiss-seam', flip: process.argv[2] || null, at: new Date().toISOString() };

// (a) compiled dist shape
try {
  const dist = '/app/dist/modules/crossmodel/coding/run-executor.js';
  const src = fs.readFileSync(dist, 'utf8');
  out.dist_bytes = src.length;
  out.dist_mtime = fs.statSync(dist).mtime.toISOString();
  // The clean-final arm: GUARD_MISS ... meta: { seam: 'final_verdict', outcome: 'clean' }.
  // Whitespace-tolerant: the ternary arm may reflow.
  out.clean_arm_seam = src.includes("seam: 'final_verdict', outcome: 'clean'") ? 1 : 0;
  // No GUARD_MISS row may be recorded WITHOUT a seam at any call site in the
  // file: the two call sites are carried_receipt (multi-line meta) and the
  // clean-final arm. NEEDLE = the call-site shape — the bare `GUARD_MISS`
  // literal also matches the compiled source comment `GUARD_STRIKE/GUARD_MISS
  // telemetry` (false positive at the f60 ship-check). The dist form
  // `loop_metrics_service_1.LOOP_METRIC_KINDS.GUARD_MISS` still CONTAINS this
  // needle, so one needle matches source and dist alike.
  const missSites = [];
  const NEEDLE = 'LOOP_METRIC_KINDS.GUARD_MISS';
  let i = 0;
  while ((i = src.indexOf(NEEDLE, i)) !== -1) {
    const ctx = src.slice(i, i + 400);
    missSites.push(ctx);
    i += NEEDLE.length;
  }
  out.miss_sites = missSites.length;
  out.miss_sites_without_seam = missSites.filter((c) => !c.includes('seam:')).length;
  // Vacuous-pass guard: zero call sites would otherwise read as "all clean".
  out.needle = NEEDLE;
} catch (e) { out.dist_ERR = String((e && e.message) || e).slice(0, 200); }

const prisma = require('/app/dist/config/database').default;
const BIG = (k, v) => (typeof v === 'bigint' ? Number(v) : v);

(async () => {
  const flip = out.flip ? new Date(out.flip) : null;
  if (flip && !isNaN(flip.valueOf())) {
    // (b) seam-less guard_miss rows, split by the flip boundary (6h window).
    const rows = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE "createdAt" < $1) AS pre_flip,
             COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "createdAt" < $1 + interval '6 hours') AS boundary_6h,
             COUNT(*) FILTER (WHERE "createdAt" >= $1 + interval '6 hours') AS post_boundary
      FROM loop_metrics
      WHERE kind = 'guard_miss'
        AND COALESCE(meta->>'detector', meta->>'seam', meta->>'reason') IS NULL
        AND "createdAt" > now() - interval '24 hours'`, flip);
    out.seamless_24h = rows[0];
    // (c) the fix's shape: clean-final rows carry seam + outcome clean.
    const clean = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS clean_rows,
             COUNT(*) FILTER (WHERE meta->>'seam' = 'final_verdict' AND meta->>'outcome' = 'clean') AS shaped
      FROM loop_metrics
      WHERE kind = 'guard_miss' AND meta->>'outcome' = 'clean'
        AND "createdAt" > $1`, flip);
    out.clean_shape = clean[0];
  } else {
    out.db_note = 'no flip ISO passed — dist leg only';
  }
  console.log(JSON.stringify(out, BIG, 1));
  // Firing-60: `out.miss_sites >= 2` is the vacuous-pass guard — a needle
  // matching zero call sites must FAIL LOUD (exit 1), never read as "all
  // sites seam-stamped". The dist compiles `LOOP_METRIC_KINDS` to a namespace
  // alias (`loop_metrics_service_1.LOOP_METRIC_KINDS`), which still contains
  // the needle — so >= 2 holds on both source and dist reads.
  //
  // Firing-60 (second defect): Prisma returns UNCAST COUNT(*) FILTER columns
  // as BigInt — `shaped !== clean_rows` was a STRICT cross-type compare that
  // read 1n !== 1 → true, failing the probe once the first post-flip clean
  // row existed (it never fired at f59 because clean_rows was 0 then).
  // Coerce both sides through Number() before comparing.
  const cleanRows = out.clean_shape ? Number(out.clean_shape.clean_rows) : 0;
  const shaped = out.clean_shape ? Number(out.clean_shape.shaped) : -1;
  const fail = (out.clean_arm_seam !== 1) || (out.miss_sites_without_seam > 0)
    || !out.miss_sites || out.miss_sites < 2
    || (out.seamless_24h && Number(out.seamless_24h.post_boundary) > 0)
    || (cleanRows > 0 && shaped !== cleanRows);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', String((e && e.message) || e).slice(0, 300)); process.exit(1); });

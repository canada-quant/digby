/* verify-iter31-dgate-legshare.js — FO standing probe (READ-ONLY).
 * Firing 43 (2026-09-28) fixed this probe's MECHANICS: prodq.sh runs a probe
 * INSIDE the live backend container, where `sudo docker exec` does not exist
 * (sudo: not found) — so the dist half reads /app/dist/... directly with
 * fs.readFileSync, and the DB half counts all-failed rows the way
 * recordDecisionRow writes them: meta->>'backend' IS NULL (an all-legs-failed
 * row names no backend). Counting per-leg ok:false rows instead mistakes
 * ordinary straggler telemetry for all-fails (2026-09-28 16:39Z+: 27 ok:false
 * leg rows vs 0 all-failed rows).
 * Firing 44 (2026-09-28) removed the probe's VOLATILE LITERALS — the 6th
 * probe-mechanics defect in 6 firings: (a) it asserted the leg-timeout const
 * EQUALS 1000, which the owner's 530a37088 (1 s → 2 s) silently flipped to 0;
 * (b) it asserted fall-through rows carry the label 'DeepSeek logprob readout',
 * but leg 2 is now an admin-configured Edge backend (cql-litellm…), so the
 * standing check went empty while the gate was HEALTHY. Doctrine: a standing
 * probe pins the COMPILED SHAPE of its own fix (legShareCap — those literals
 * are ours) and REPORTS vendor/owner-tunable values (timeout const, backend
 * labels) without asserting them — labels and defaults change under a probe
 * that never re-reads source.
 * Proves: (a) the helper exports exist in the COMPILED dist (exports.X — tsc
 * does not inline exported consts); (b) the leg-loop line routes the non-final
 * cap through legShareCap; (c) 2h compute_policy all-failed = 0, and when
 * compute_policy asks exist, SOME backend answered ok (label-agnostic). */
const fs = require('fs');
const out = { at: new Date().toISOString() };
try {
  const dist = '/app/dist/modules/crossmodel/platform/decision-gate.js';
  const src = fs.readFileSync(dist, 'utf8');
  out.dist_bytes = src.length;
  out.exports_legshare = /exports\.legShareCap\s*=/.test(src) ? 1 : 0;
  // The leg-loop line must route the non-final cap through legShareCap.
  out.loop_calls_legshare = /legDeadlineAt\s*=\s*legTimeout\s*>\s*0\s*&&\s*!isLastLeg\s*\?\s*Math\.min\(deadlineAt,\s*legStart\s*\+\s*legShareCap\(/.test(src) ? 1 : 0;
  out.share_disabled_flag = /DECISION_GATE_LEG_SHARE_DISABLED/.test(src) ? 1 : 0;
  // REPORTED, never asserted: the owner tunes this default (1000 → 2000 in
  // 530a37088). null = the const vanished from dist (real regression).
  out.leg_timeout_ms = (src.match(/exports\.DECISION_LEG_TIMEOUT_DEFAULT_MS\s*=\s*(\d+)/) || [])[1] || null;
  out.dist_mtime = fs.statSync(dist).mtime.toISOString();
} catch (e) { out.dist_ERR = String((e && e.message) || e).slice(0, 200); }

const prisma = require('/app/dist/config/database').default;
const q = (sql) => prisma.$queryRawUnsafe(sql);
(async () => {
  // All-failed rows name NO backend (recordDecisionRow: error-only row) — count those,
  // not per-leg ok:false rows.
  out.cp_allfailed_2h = await q(`SELECT COUNT(*)::int AS n FROM loop_metrics WHERE kind='decision_gate' AND "createdAt" > now() - interval '2 hours' AND meta->>'purpose' = 'compute_policy' AND meta->>'backend' IS NULL`);
  // Label-agnostic health: compute_policy asks in 2h, and WHICH backends answered
  // ok (any label — built-in or admin-configured Edge backend). Healthy when
  // cp_rows_2h > 0 implies this list is non-empty; cp_rows_2h = 0 = the gate
  // was simply quiet (not a regression).
  out.cp_rows_2h = await q(`SELECT COUNT(*)::int AS n FROM loop_metrics WHERE kind='decision_gate' AND "createdAt" > now() - interval '2 hours' AND meta->>'purpose' = 'compute_policy'`);
  out.cp_ok_backends_2h = await q(`SELECT meta->>'backend' AS backend, COUNT(*)::int AS n FROM loop_metrics WHERE kind='decision_gate' AND "createdAt" > now() - interval '2 hours' AND meta->>'purpose' = 'compute_policy' AND meta->>'backend' IS NOT NULL AND COALESCE((meta->>'ok')::boolean, false) IS TRUE GROUP BY 1 ORDER BY 2 DESC`);
  out.allfailed_4h_by_purpose = await q(`SELECT meta->>'purpose' AS purpose, COUNT(*)::int AS n, MAX("createdAt") AS last_at FROM loop_metrics WHERE kind='decision_gate' AND "createdAt" > now() - interval '4 hours' AND meta->>'backend' IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.error('PROBE_ERR', (e && e.message) || e); process.exit(1); });

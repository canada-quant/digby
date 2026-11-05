/**
 * verify-iter41-overridebackoff.js — FO firing 47 proving probe (2026-09-29).
 *
 * Proves in ONE read-only pass (post-wave) the firing-47 fix: the utility
 * role-override latch now ESCALATES its backoff window (5→15→30→60 min cap)
 * while the custom utility seat stays unreachable, instead of re-paying the
 * full caller timeout (30s) every flat 5-min window. Prod evidence that
 * motivated it: 24 latch warns in 4h (6-7/h) from 07:04Z 2026-09-29, each a
 * 30s hang on the caller that landed on the retry — 0 llm_error outcomes
 * (the built-in chain answered), so this was pure latency, not failures.
 *
 * Fix shape pinned (COMPILED, never source literals — firing-44/46 doctrine):
 *   - utility-llm.js compiled exports UTILITY_OVERRIDE_BACKOFF_STEPS_MS (the
 *     escalation table) AND uses it in the latch helper (const used, not just
 *     exported).
 *   - utility-llm.js compiled carries the UTILITY_OVERRIDE_BACKOFF_DISABLED
 *     kill-switch literal (the guard fn).
 *   - loop-metrics.service.js compiled enum map carries the
 *     'utility_override_latch' kind string (the enum MAP is where the literal
 *     lives; the caller references the MEMBER name — firing-47 probe lesson).
 * Telemetry floors (data, not dist):
 *   - utility_override_latch rows since the flip: backoffMin present,
 *     streak present; EXPECT ~0-1/h latch events (vs 6-7/h before) once a
 *     window escalates — reported, never asserted (a quiet seat latches 0).
 *   - the override-timeout warn class rate since the flip vs the 4h before.
 * Reported, never asserted: the backoff VALUES (tunables via the steps array).
 *
 * ARGS (firing-47 lesson: env vars set on the CALLER never transit SSM —
 * prodq.sh forwards only argv; a defaulted env FLIP silently swept pre-wave
 * rows in and mis-read firing-46's fix):
 *   node verify-iter41-overridebackoff.js <flipISO>   (REQUIRED, no default)
 *
 * Read-only: SELECTs + greps. No writes anywhere.
 */
const { execSync } = require('child_process');
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }

const FLIP = process.argv[2];
if (!FLIP) { console.error('PROBE_FAIL: pass the wave-complete flip time as argv[2] (e.g. 2026-09-29T12:00:00Z) — env vars do not transit SSM (firing-47)'); process.exit(2); }

(async () => {
  // 1a. the escalation shape in compiled utility-llm.js
  await sec('iter41_backoff_dist', () => {
    const f = '/app/dist/utils/utility-llm.js';
    const grep = (pat) => { try { return execSync(`grep -o -- ${JSON.stringify(pat)} ${f} | wc -l`).toString().trim(); } catch { return 'ERR'; } };
    return {
      backoff_steps_exported: grep('UTILITY_OVERRIDE_BACKOFF_STEPS_MS'),  // export + uses (expect >=2: the export + the latch helper)
      kill_switch_present: grep('UTILITY_OVERRIDE_BACKOFF_DISABLED'),      // the kill switch (expect >=1: the guard fn)
      streak_reset_shape: grep('utilityOverrideStreak = 0'),               // the success-reset (expect >=2: decl + reset)
      dist_mtime: execSync(`stat -c %y ${f}`).toString().trim().slice(0, 19),
    };
  });

  // 1b. the telemetry kind in the compiled enum MAP (the literal lives HERE,
  //     not in the caller — firing-47 probe lesson from the zombie metric).
  await sec('iter41_metric_dist', () => {
    const f = '/app/dist/modules/crossmodel/platform/loop-metrics.service.js';
    const grep = (pat) => { try { return execSync(`grep -o -- ${JSON.stringify(pat)} ${f} | wc -l`).toString().trim(); } catch { return 'ERR'; } };
    return { kind_in_enum_map: grep("'utility_override_latch'"), member_name: grep('UTILITY_OVERRIDE_LATCH') };
  });

  // 2a. latch telemetry since the flip: backoffMin + streak stamped per row.
  await sec('iter41_latch_rows_since_flip', () => q(
    `SELECT meta->>'backoffMin' AS backoff_min, meta->>'streak' AS streak, COUNT(*)::int AS n, MAX("createdAt") AS last
     FROM loop_metrics
     WHERE kind = 'utility_override_latch' AND "createdAt" > '${FLIP}'
     GROUP BY 1, 2 ORDER BY 3 DESC`));

  // 2b. the warn-class rate: since flip vs the 4h before it (the motivating
  //     signal — expect the hourly latch warn rate to DROP once windows
  //     escalate past 5 min; a healthy seat shows 0 rows both sides).
  await sec('iter41_warn_rate', () => q(
    `SELECT (SELECT COUNT(*)::int FROM app_error_logs WHERE "createdAt" > '${FLIP}' AND message LIKE 'utilityChat: utility role override unreachable%') AS warns_since_flip,
            (SELECT COUNT(*)::int FROM app_error_logs WHERE "createdAt" BETWEEN (TIMESTAMP '${FLIP}' - INTERVAL '4 hours') AND TIMESTAMP '${FLIP}' AND message LIKE 'utilityChat: utility role override unreachable%') AS warns_4h_before`));

  // 2c. degradation check: the built-in chain still served (0 llm_error
  //     outcomes on utility extractions since the flip — the latch must never
  //     turn a slow override into failed calls).
  await sec('iter41_no_llm_errors', () => q(
    `SELECT COUNT(*)::int AS llm_error_rows FROM loop_metrics
     WHERE kind = 'memory_extraction' AND "createdAt" > '${FLIP}' AND meta->>'outcome' = 'llm_error'`));

  console.log(JSON.stringify(out, BIG, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('PROBE_FAIL', e.message); await prisma.$disconnect(); process.exit(1); });

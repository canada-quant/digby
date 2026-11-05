/**
 * verify-iter40-zombiestop.js — FO firing 46 proving probe (2026-09-29).
 *
 * Proves in ONE read-only pass (post-wave) both firing-46 fixes, same
 * doctrine as iter39: pin the COMPILED SHAPE of the fix, REPORT tunables,
 * assert FLOORS from TELEMETRY (data, not dist literals).
 *
 *  1. Zombie-run stop (chat 5a87b912, 2026-09-29 03:52–05:19Z): a chat
 *     deleted mid-run cascades agent_runs away; the executor discarded the
 *     heartbeat updateMany count and kept executing ~90 min (97 FK-failed
 *     receipt/journal writes, real GitHub actions for a dead chat).
 *     Fix shape pinned:
 *       - run-state.js compiled heartbeatAgentRun RETURNS the count
 *         (`return r.count` in the compiled body — not `Promise<void>`).
 *       - run-executor.js compiled lease-tick checks rows === 0, gated on
 *         the ZOMBIE_RUN_STOP_DISABLED kill switch, and cancels.
 *       - the telemetry call references the enum MEMBER
 *         LOOP_METRIC_KINDS.ZOMBIE_RUN_STOPPED (NOT the string literal —
 *         firing-47 lesson: the literal lives in loop-metrics.service.js's
 *         enum map; grepping run-executor.js for it returned a false 0).
 *     Telemetry: zombie_run_stopped loop_metrics rows (expected 0 in a quiet
 *     window — the metric fires only when a zombie is CAUGHT; the fix is
 *     proven live by shape + the FK spam NOT recurring). Reported: FK-failed
 *     receipt/journal writes per hour since the flip (expect ~0; the 4h
 *     before the fix ran ~25/h).
 *
 *  2. Utility-override leg onMeta (firing 45's attributability fix missed
 *     the busiest leg): the 'utility' Edge override leg returned without
 *     onMeta, so every project_brief outcome row landed leg=null even with
 *     the caller wired. Fix shape pinned:
 *       - utility-llm.js compiled override leg now carries the same
 *         `onMeta?.({ leg: 'override' ... })` diagnostics call the other
 *         three legs have (2+ occurrences of the leg:'override' literal in
 *         the compiled file: the override leg + the utility_fallback leg).
 *     Telemetry floor: project_brief rows since the flip with leg NON-NULL
 *     (when the Edge seat serves, they read 'override'). Reported, never
 *     asserted: the budget value (a tunable — 8000 at firing 45).
 *
 * ARGS (firing-47 lesson: an env var set on the CALLER never transits SSM —
 * prodq.sh forwards only argv; the probe's env-var FLIP silently used a
 * stale default and swept pre-wave rows into the leg=null count):
 *   node verify-iter40-zombiestop.js <flipISO>     (REQUIRED, no default)
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
if (!FLIP) { console.error('PROBE_FAIL: pass the wave-complete flip time as argv[2] (e.g. 2026-09-29T07:54:26Z) — env vars do not transit SSM (firing-47)'); process.exit(2); }

(async () => {
  // 1a. the zombie-stop shape in dist (pin the SHAPE, never a volatile value)
  await sec('iter40_zombie_dist', () => {
    const rs = '/app/dist/modules/crossmodel/coding/run-state.js';
    const ex = '/app/dist/modules/crossmodel/coding/run-executor.js';
    const grep = (f, pat) => { try { return execSync(`grep -o -- ${JSON.stringify(pat)} ${f} | wc -l`).toString().trim(); } catch { return 'ERR'; } };
    return {
      heartbeat_returns_count: grep(rs, 'return r.count'),                 // the compiled return (expect >=1)
      executor_checks_rows0: grep(ex, 'rows > 0'),                         // the zombie gate (expect >=1; ticket 65af5656 added this early return ahead of the row classification — the old bare `rows === 0` test is gone)
      kill_switch_present: 'n/a',                                          // ZOMBIE_RUN_STOP_DISABLED was DELETED 2026-10-31 (RSW-1 cluster 17) — the behaviour is unconditional and the knob is ZOMBIE_RUN_STOP_CONFIRM_MISSES
      confirm_misses_knob: grep(ex, 'ZOMBIE_RUN_STOP_CONFIRM_MISSES'),     // ticket 65af5656 confirmation floor (expect >=1)
      row_classifier: grep(ex, 'classifyZeroHeartbeat'),                   // ticket 65af5656 row read-back (expect >=1)
      metric_kind_present: grep(ex, 'ZOMBIE_RUN_STOPPED'),                  // the telemetry call (enum MEMBER name — the string literal lives in loop-metrics.service.js's enum map, not here; firing-47 fix)
      dist_mtime: execSync(`stat -c %y ${ex}`).toString().trim().slice(0, 19),
    };
  });

  // 1b. zombie telemetry since the flip: metric rows (quiet window = 0 — the
  //     row fires only when a zombie is CAUGHT) + the FK spam it kills.
  await sec('iter40_zombie_telemetry', () => q(
    `SELECT (SELECT COUNT(*)::int FROM loop_metrics WHERE kind = 'zombie_run_stopped' AND "createdAt" > '${FLIP}') AS zombie_stopped_rows,
            (SELECT COUNT(*)::int FROM app_error_logs WHERE "createdAt" > '${FLIP}' AND message LIKE 'run-receipts: write for chat%' AND message LIKE '%Foreign key%') AS fk_receipt_writes,
            (SELECT COUNT(*)::int FROM app_error_logs WHERE "createdAt" > '${FLIP}' AND message LIKE 'run-journal: write for chat%' AND message LIKE '%Foreign key%') AS fk_journal_writes`));

  // 2a. the onMeta shape in the compiled utility-llm: the override leg's
  //     diagnostics call (the utility_fallback leg already had one — 2+
  //     total means the NEW one is in).
  await sec('iter40_onmeta_dist', () => {
    const f = '/app/dist/utils/utility-llm.js';
    const grep = (pat) => { try { return execSync(`grep -o -- ${JSON.stringify(pat)} ${f} | wc -l`).toString().trim(); } catch { return 'ERR'; } };
    return {
      leg_override_literals: grep("leg: 'override'"),   // override + utility_fallback legs (expect >=2)
      onmeta_calls: grep('onMeta?.({'),                 // all four legs (expect >=4)
      dist_mtime: execSync(`stat -c %y ${f}`).toString().trim().slice(0, 19),
    };
  });

  // 2b. project_brief attributability since the flip: leg NON-NULL floor.
  //     REPORT the budget (tunable) — assert only that leg is stamped.
  await sec('iter40_brief_leg_since_flip', () => q(
    `SELECT meta->>'leg' AS leg, meta->>'budgetTokens' AS budget, COUNT(*)::int AS n
     FROM loop_metrics
     WHERE kind = 'memory_extraction'
       AND meta->>'source' = 'project_brief'
       AND "createdAt" > '${FLIP}'
     GROUP BY 1, 2 ORDER BY 3 DESC`));

  console.log(JSON.stringify(out, BIG, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('PROBE_FAIL', e.message); await prisma.$disconnect(); process.exit(1); });

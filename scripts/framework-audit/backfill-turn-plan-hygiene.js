'use strict';
// TPH1006 — roster 2026-10-06 B-1: turn_plan label-hygiene backfill (one-shot, operator-run, DRY by default).
//
// The writer now keeps two classes of turn_plan outcome rows out of the fit (chat-agent/turn-plan-labels.ts):
//   supervisor     — the answer's chat is a Fleet / project supervisor chat (the plan never acts there; 85 of 143
//                    "real" labels in the 7 days to 2026-10-06 were these window-close "held" rows);
//   counterfactual — the lane that RAN (the answer row's depth.turnPlan.ran.lane, else its depth plan / facts:
//                    quick act ⇒ quick, council ⇒ research, a spawned checker ⇒ checked, else standard) is not the
//                    lane the plan PREDICTED (outcome meta.predictedLane) — the user's signal speaks to the lane
//                    they saw, never the predicted one.
// This one-shot stamps the SAME flag on STORED rows written before the writer change. Classification is re-derived
// LIVE from the chat + answer rows (never banked numbers). Rows already excluded (e.g. TPL1006 synthetic) are left
// alone. The readers honour meta.excludeFromFit (decision-gate-fit.ts outcomeRowEntersFit,
// decision-gate-durable-demote.ts), so the stamp takes effect at the next readiness pass.
//
// prodq.sh convention: without --apply this is a READ-ONLY probe (aggregates only, no text, no ids);
//   --apply   stamps meta.excludeFromFit=true + excludeFromFitSource='tph1006_backfill' + excludeFromFitClass;
//   --revert  (with --apply) removes exactly what this script stamped (excludeFromFitSource = 'tph1006_backfill').
// Idempotent. Output: one JSON object; exit 0. Exit 1 on error.

const SOURCE = 'tph1006_backfill';
const WINDOW_DAYS = 14; // turn_plan shipped 2026-10-03 — 14 days covers every row while keeping the scan index-friendly

/** The ran-lane CASE over an answer row aliased `m` (mirrors turn-plan-labels.ts ranLaneFromDepth). */
const RAN_LANE_SQL = (m) => `
  CASE
    WHEN ${m}.metadata->'depth'->'turnPlan'->'ran'->>'lane' IN ('quick','standard','checked','research')
      THEN ${m}.metadata->'depth'->'turnPlan'->'ran'->>'lane'
    WHEN ${m}.metadata->'depth'->'turnPlan'->>'act' = 'true' OR ${m}.metadata->'depth'->'plan'->>'lane' = 'quick' THEN 'quick'
    WHEN ${m}.metadata->'depth'->'plan'->>'preset' IN ('deep_research','deep_research_all') THEN 'research'
    WHEN ${m}.metadata->'depth'->'plan'->>'preset' IS NULL THEN NULL
    WHEN coalesce(${m}.metadata->'depth'->'facts'->>'checkerSpawned', ${m}.metadata->'depth'->'plan'->>'spawnChecker') = 'true' THEN 'checked'
    ELSE 'standard'
  END`;

/** One SELECT: every turn_plan outcome row in the window with its class. `o` = loop_metrics alias. */
const classifiedSql = (o) => `
  SELECT ${o}.id,
         CASE
           WHEN c."isSupervisor" = true OR c."isProjectSupervisor" = true THEN 'supervisor'
           WHEN ans.ran_lane IS NOT NULL AND ans.ran_lane <> coalesce(${o}.meta->>'predictedLane', '') THEN 'counterfactual'
           WHEN ans.ran_lane IS NULL THEN 'unknown'
           ELSE 'ran_as_predicted'
         END AS class,
         coalesce(${o}.meta->>'excludeFromFit', '') AS excl,
         coalesce(${o}.meta->>'excludeFromFitSource', '') AS src,
         coalesce(${o}.meta->>'label', '') AS label,
         coalesce(${o}.meta->>'predictedLane', '') AS predicted,
         ans.ran_lane AS ran
    FROM loop_metrics ${o}
    LEFT JOIN crossmodel_chats c ON c.id = ${o}."sessionId"
    LEFT JOIN LATERAL (
      SELECT ${RAN_LANE_SQL('m')} AS ran_lane
        FROM crossmodel_messages m
       WHERE m."chatId" = ${o}."sessionId"
         AND m.role = 'assistant'
         AND m."createdAt" > now() - interval '${WINDOW_DAYS + 1} days'
         AND m.metadata->'depth'->'turnPlan'->>'decisionId' = ${o}.meta->>'id'
       LIMIT 1
    ) ans ON true
   WHERE ${o}.kind = 'decision_gate'
     AND ${o}.meta->>'phase' = 'outcome'
     AND ${o}.meta->>'purpose' = 'turn_plan'
     AND ${o}."createdAt" > now() - interval '${WINDOW_DAYS} days'`;

function parseArgs(argv) {
  return { apply: argv.includes('--apply'), revert: argv.includes('--revert') };
}

function summarize(rows) {
  const byClass = {};
  const byClassAlreadyExcluded = {};
  const lanePairs = {};
  for (const r of rows) {
    byClass[r.class] = (byClass[r.class] || 0) + 1;
    if (r.excl === 'true') byClassAlreadyExcluded[r.class] = (byClassAlreadyExcluded[r.class] || 0) + 1;
    if (r.class === 'counterfactual') {
      const k = `${r.predicted || '?'}→${r.ran || '?'}`;
      lanePairs[k] = (lanePairs[k] || 0) + 1;
    }
  }
  const wouldStamp = rows.filter((r) => (r.class === 'supervisor' || r.class === 'counterfactual') && r.excl !== 'true').length;
  const stampedByThis = rows.filter((r) => r.src === SOURCE).length;
  return { scanned: rows.length, byClass, byClassAlreadyExcluded, counterfactualPredictedToRan: lanePairs, wouldStamp, stampedByThisScript: stampedByThis };
}

async function main() {
  const { apply, revert } = parseArgs(process.argv.slice(2));
  const prisma = require('/app/dist/config/database').default;
  const rows = await prisma.$queryRawUnsafe(classifiedSql('o'));
  const before = summarize(rows);
  let changed = null;
  if (apply && revert) {
    const out = await prisma.$queryRawUnsafe(`
      UPDATE loop_metrics o
         SET meta = (o.meta - 'excludeFromFit' - 'excludeFromFitSource' - 'excludeFromFitClass')
       WHERE o.kind = 'decision_gate'
         AND o.meta->>'purpose' = 'turn_plan'
         AND o.meta->>'excludeFromFitSource' = '${SOURCE}'
         AND o."createdAt" > now() - interval '${WINDOW_DAYS + 7} days'
      RETURNING o.id`);
    changed = { reverted: out.length };
  } else if (apply) {
    const out = await prisma.$queryRawUnsafe(`
      UPDATE loop_metrics o
         SET meta = coalesce(o.meta, '{}'::jsonb)
                   || jsonb_build_object('excludeFromFit', true, 'excludeFromFitSource', '${SOURCE}', 'excludeFromFitClass', cls.class)
        FROM (${classifiedSql('o2')}) cls
       WHERE o.id = cls.id
         AND cls.class IN ('supervisor', 'counterfactual')
         AND coalesce(o.meta->>'excludeFromFit', '') <> 'true'
      RETURNING cls.class`);
    const byClass = {};
    for (const r of out) byClass[r.class] = (byClass[r.class] || 0) + 1;
    changed = { stamped: out.length, stampedByClass: byClass };
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), apply, revert, windowDays: WINDOW_DAYS, ...before, ...(changed ? { changed } : {}) }, null, 2));
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
}

module.exports = { parseArgs, summarize, classifiedSql, RAN_LANE_SQL, SOURCE };

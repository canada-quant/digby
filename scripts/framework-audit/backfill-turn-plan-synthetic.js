'use strict';
// TPL1006 — P3 turn_plan synthetic-label backfill (one-shot, operator-run, DRY by default).
//
// PR #1289 (5927933c) stamps excludeFromFit on NEW synthetic labels at the writer
// (turn-plan-labels.ts: metadata.depth.turnPlan.synthetic -> outcome.excludeFromFit).
// This one-shot stamps the SAME flag on STORED turn_plan outcome rows whose
// provenance is synthetic — classification re-derived LIVE, never banked numbers:
//   test      — chat owned by the bench account (claudebot@digby.ai)
//   chatless  — sessionId LIKE 'chatless-%' (no chat row ever)
//   chat_gone — the chat row no longer exists (deleted e2e-suite chats; includes
//               NULL-sessionId rows, which are unattributable by definition)
//   user      — everything else; NEVER touched
// The readers honor meta.excludeFromFit (decision-gate-fit.ts outcomeRowEntersFit,
// decision-gate-durable-demote.ts) and that enforcement PREDATES the wave, so the
// stamp takes effect immediately, before boxes roll to the new writer.
//
// prodq.sh convention: without --apply this is a READ-ONLY probe; --apply is the
// deliberate P1.1-style write exception. Idempotent: only rows whose
// meta.excludeFromFit is not already true are stamped (a re-run after new
// synthetic rows stamps only those). Output: one JSON object; exit 0. Exit 1 on error.
(async () => {
  const apply = process.argv.includes('--apply');
  const prisma = require('/app/dist/config/database').default;

  // turn_plan outcomes exist only since the purpose shipped (2026-10-03); a 14-day
  // window covers every row ever while keeping the scan index-friendly on createdAt.
  // The window string is ALIAS-DEPENDENT: the read query aliases loop_metrics "o",
  // the apply subquery aliases it "o2" — a shared 'o.' reference inside the FROM
  // subquery is a 42P01 ("invalid reference to FROM-clause entry for table o"),
  // which is exactly what the first apply attempt hit on box A (2026-10-06 06:1xZ).
  const windowFor = (alias) => ` AND ${alias}."createdAt" > now() - interval '14 days'`;
  const WINDOW = windowFor('o');

  const rows = await prisma.$queryRawUnsafe(`
    SELECT o.id,
           CASE
             WHEN u.email = 'claudebot@digby.ai' THEN 'test'
             WHEN o."sessionId" LIKE 'chatless-%' THEN 'chatless'
             WHEN c.id IS NULL THEN 'chat_gone'
             ELSE 'user'
           END AS class,
           coalesce(o.meta->>'excludeFromFit', '') AS excl,
           coalesce(o.meta->>'mode', '') AS mode,
           coalesce(o.meta->>'inActBand', '') AS band,
           coalesce(o.meta->>'label', '') AS label,
           coalesce(o.meta->>'agreed', '') AS agreed
      FROM loop_metrics o
      LEFT JOIN crossmodel_chats c ON c.id = o."sessionId"
      LEFT JOIN users u ON u.id = c."userId"
     WHERE o.kind = 'decision_gate'
       AND o.meta->>'phase' = 'outcome'
       AND o.meta->>'purpose' = 'turn_plan'${WINDOW}`);

  const byClass = {};
  const byClassExcluded = {};
  let fitTotal = 0, fitSynthetic = 0, fitUser = 0, fitUserAgreed = 0;
  for (const r of rows) {
    byClass[r.class] = (byClass[r.class] || 0) + 1;
    if (r.excl === 'true') byClassExcluded[r.class] = (byClassExcluded[r.class] || 0) + 1;
    // fit-entering mirror (approximates outcomeRowEntersFit): act mode, act band, not excluded
    if (r.mode === 'act' && r.band === 'true' && r.excl !== 'true') {
      fitTotal++;
      if (r.class === 'user') { fitUser++; if (r.agreed === 'true') fitUserAgreed++; }
      else fitSynthetic++;
    }
  }

  let stampedByClass = null;
  if (apply) {
    const stamped = await prisma.$queryRawUnsafe(`
      UPDATE loop_metrics o
         SET meta = coalesce(o.meta, '{}'::jsonb)
                   || '{"excludeFromFit": true, "excludeFromFitSource": "tpl1006_backfill"}'::jsonb
        FROM (SELECT o2.id,
                     CASE
                       WHEN u.email = 'claudebot@digby.ai' THEN 'test'
                       WHEN o2."sessionId" LIKE 'chatless-%' THEN 'chatless'
                       WHEN c.id IS NULL THEN 'chat_gone'
                       ELSE 'user'
                     END AS class
                FROM loop_metrics o2
                LEFT JOIN crossmodel_chats c ON c.id = o2."sessionId"
                LEFT JOIN users u ON u.id = c."userId"
               WHERE o2.kind = 'decision_gate'
                 AND o2.meta->>'phase' = 'outcome'
                 AND o2.meta->>'purpose' = 'turn_plan'${windowFor('o2')}) cls
       WHERE o.id = cls.id
         AND cls.class IN ('test', 'chatless', 'chat_gone')
         AND coalesce(o.meta->>'excludeFromFit', '') <> 'true'
      RETURNING cls.class`);
    stampedByClass = {};
    for (const r of stamped) stampedByClass[r.class] = (stampedByClass[r.class] || 0) + 1;
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    apply,
    scanned: rows.length,
    byClass,
    byClassAlreadyExcluded: byClassExcluded,
    fitEntering: { total: fitTotal, synthetic: fitSynthetic, user: fitUser, userAgreed: fitUserAgreed },
    stamped: stampedByClass ? Object.values(stampedByClass).reduce((a, b) => a + b, 0) : 0,
    stampedByClass,
  }, null, 2));
  await prisma.$disconnect();
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });

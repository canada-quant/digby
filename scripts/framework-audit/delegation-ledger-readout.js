// delegation-ledger-readout.js — READ-ONLY post-deploy readout of the SHADOW delegation
// ledger + tool-intent journal (build 2026-10-08 D; architecture.md items B + C).
// Usage (on box A): bash /opt/crossmodel/scripts/framework-audit/prodq.sh delegation-ledger-readout.js [hours]
// Prints: tasks by kind × state, open / stale / duplicate keys, write-seam coverage
// (ok start_coding_session receipts vs session tasks), the newest nightly reconcile row,
// and the journal: intents by tool × state, would-reconcile verdicts, keys executed
// twice, pendings older than 1 h. SELECTs only.
const mod = require('/app/dist/config/database').default;
const prisma = mod && mod.prisma ? mod.prisma : mod;
const hours = Math.max(1, Math.min(24 * 30, Number(process.argv[2]) || 24));

async function q(sql) { return prisma.$queryRawUnsafe(sql); }

async function main() {
  const since = `now() - interval '${hours} hours'`;
  const out = {
    hours,
    tasks_by_kind_state: await q(`SELECT kind, state, source, COUNT(*)::int AS n FROM delegation_tasks WHERE "createdAt" > ${since} GROUP BY 1,2,3 ORDER BY 1,2,3`),
    open_stale_dup: await q(`SELECT COUNT(*) FILTER (WHERE state IN ('submitted','working','input_required'))::int AS open,
      COUNT(*) FILTER (WHERE state IN ('submitted','working','input_required') AND "staleAfter" < now())::int AS stale,
      COUNT(*) FILTER (WHERE "duplicateOfId" IS NOT NULL)::int AS duplicate_keys,
      COUNT(*) FILTER (WHERE "parentChatId" IS NULL AND kind IN ('session','message_ask','background_worker','continuation'))::int AS missing_parent
      FROM delegation_tasks WHERE "createdAt" > ${since}`),
    spawn_coverage: await q(`SELECT COUNT(DISTINCT r.ids->>'sessionId')::int AS spawn_receipts,
      COUNT(DISTINCT r.ids->>'sessionId') FILTER (WHERE t.id IS NULL)::int AS without_task
      FROM run_tool_receipts r LEFT JOIN delegation_tasks t ON t.kind = 'session' AND t."childChatId" = r.ids->>'sessionId'
      WHERE r.tool = 'start_coding_session' AND r.ok AND r."createdAt" > ${since} AND r."createdAt" < now() - interval '2 minutes'`),
    last_reconcile: await q(`SELECT "createdAt", value, meta FROM loop_metrics WHERE kind = 'delegation_task_reconcile' ORDER BY "createdAt" DESC LIMIT 1`),
    intents_by_tool_state: await q(`SELECT tool, state, COUNT(*)::int AS n FROM tool_intents WHERE "createdAt" > ${since} GROUP BY 1,2 ORDER BY 1,2`),
    would_reconcile: await q(`SELECT tool, "wouldReconcile", COUNT(*)::int AS n FROM tool_intents WHERE "createdAt" > ${since} AND "wouldReconcile" IS NOT NULL GROUP BY 1,2 ORDER BY 3 DESC`),
    executed_twice_keys: await q(`SELECT COUNT(*)::int AS keys FROM (SELECT "idemKey" FROM tool_intents WHERE state = 'applied' AND "createdAt" > ${since} GROUP BY 1 HAVING COUNT(*) > 1) k`),
    orphan_pending: await q(`SELECT tool, COUNT(*)::int AS n FROM tool_intents WHERE state = 'pending' AND "createdAt" > ${since} AND "createdAt" < now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC`),
    metric_rows: await q(`SELECT kind, meta->>'phase' AS phase, COUNT(*)::int AS n FROM loop_metrics WHERE kind IN ('delegation_task','tool_intent','delegation_task_reconcile') AND "createdAt" > ${since} GROUP BY 1,2 ORDER BY 1,2`),
  };
  console.log(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
  console.log('PROBE_DONE=ok');
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR', String(e && e.message || e).slice(0, 400)); process.exit(1); });

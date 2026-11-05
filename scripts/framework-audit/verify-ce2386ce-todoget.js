// Ticket ce2386ce transcript probe (read-only): the 3× todo_get 404 streak on
// nightly-engineer run 32c998b3 — exact event timestamps, tool args, the model's
// narration around the failures (documented-intent test), and the heal-metric
// timeline (goal_todo_suffix_healed / goal_todo_near_match_resolved) around the
// 0f0041bc deploy (run 36404187651 concluded 10:01:51Z; ticket filed 10:05:55Z).
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const RUN = '32c998b3-32d8-4b7d-ab2a-0ba2867059eb';
const out = { probe: 'verify-ce2386ce-todoget', run: RUN };
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }

(async () => {
  // (1) the run row: status + wall-clock window.
  await sec('run_row', () => q(
    `SELECT id::text, status, "startedAt", "finishedAt", LEFT("createdAt"::text, 19) AS created, error
     FROM agent_runs WHERE id = '${RUN}'`));

  // (2) ALL events naming the fabricated id, full timestamps + payload type.
  await sec('fabid_events', () => q(
    `SELECT seq, type, "createdAt", LEFT(payload::text, 600) AS payload_head
     FROM agent_events
     WHERE "runId" = '${RUN}' AND payload::text LIKE '%4c090f35-aaaa-bbbb-cccc-000000000000%'
     ORDER BY seq`));

  // (3) the exact tool_call rows for todo_get in this run (args verbatim).
  await sec('todo_get_calls', () => q(
    `SELECT seq, "createdAt", payload->>'name' AS tool, LEFT(payload->>'input', 300) AS input_head
     FROM agent_events
     WHERE "runId" = '${RUN}' AND payload->>'name' = 'todo_get'
     ORDER BY seq`));

  // (4) tool RESULT events adjacent to the failures: exact error text + timestamps.
  await sec('todo_get_results', () => q(
    `SELECT seq, "createdAt", LEFT(payload::text, 500) AS payload_head
     FROM agent_events
     WHERE "runId" = '${RUN}' AND (payload->>'name' = 'todo_get' OR payload::text ILIKE '%Todo not found%')
       AND payload::text ILIKE '%4c090f35%'
     ORDER BY seq`));

  // (5) model NARRATION around the failures (documented-intent test): agent text
  // events in a seq window around the failure seqs — but first find failure seqs.
  const fails = await q(
    `SELECT seq FROM agent_events
     WHERE "runId" = '${RUN}' AND payload::text LIKE '%4c090f35-aaaa-bbbb-cccc-000000000000%'
     ORDER BY seq`);
  const seqs = (fails || []).map((r) => Number(r.seq));
  out.failure_seqs = seqs;
  if (seqs.length) {
    const lo = Math.max(0, Math.min(...seqs) - 25);
    const hi = Math.max(...seqs) + 25;
    await sec('narration_window', () => q(
      `SELECT seq, type, "createdAt",
              LEFT(CASE WHEN payload ? 'text' THEN payload->>'text'
                        WHEN payload ? 'content' THEN payload->>'content'
                        ELSE payload::text END, 450) AS head
       FROM agent_events
       WHERE "runId" = '${RUN}' AND seq BETWEEN ${lo} AND ${hi}
         AND (type ILIKE '%text%' OR type ILIKE '%message%' OR type ILIKE '%assistant%'
              OR type ILIKE '%progress%' OR type ILIKE '%plan%' OR type ILIKE '%note%')
       ORDER BY seq`));
  }

  // (6) the full event-type census for the run (what kinds exist to narrate intent).
  await sec('event_census', () => q(
    `SELECT type, COUNT(*)::int AS n, MIN(seq) AS first_seq, MAX(seq) AS last_seq
     FROM agent_events WHERE "runId" = '${RUN}' GROUP BY type ORDER BY first_seq`));

  // (7) heal metrics around the deploy: all suffix-heal + near-match rows today.
  await sec('heal_metrics_today', () => q(
    `SELECT kind, meta->>'entity' AS entity, meta->>'typed' AS typed, meta->>'resolved' AS resolved,
            "createdAt"
     FROM loop_metrics
     WHERE kind IN ('goal_todo_suffix_healed', 'goal_todo_near_match_resolved')
       AND "createdAt" > '2026-09-28T00:00:00Z'
     ORDER BY "createdAt" DESC LIMIT 60`));

  // (8) the todo row's own audit trail: writes through the fabricated id.
  await sec('todo_audit', () => q(
    `SELECT id::text, status, "progressNote", LEFT(evidence, 400) AS evidence_head,
            "doneRunId"::text AS done_run, "updatedAt"
     FROM project_todos WHERE id = '4c090f35-d22c-4ac9-8d3a-f2170946e36a'`));

  // (9) the streak's breaker view: the ticket auto-file fired 10:05:55Z — what
  // agent_events exist in the run AFTER that time (the run kept going?).
  await sec('events_after_ticket', () => q(
    `SELECT seq, type, "createdAt", LEFT(payload::text, 200) AS head
     FROM agent_events
     WHERE "runId" = '${RUN}' AND "createdAt" >= '2026-09-28T10:05:55Z'
     ORDER BY seq LIMIT 30`));

  console.log(JSON.stringify(out, BIG, 2));
  await prisma.$disconnect();
})().catch((e) => { console.error('PROBE_ERR', String(e)); process.exit(1); });

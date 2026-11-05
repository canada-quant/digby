// Iteration-14 verification (arg = ISO since, default 24h): the six mandated probes for the
// d418ea4d5 receipts/doctrine commit — operator firing durations, new-list receipt minting,
// chatTurns surfacing for supervisor lanes, eviction-reason completeness, the unified-memory
// semantic leg after the 800→1200ms embed-floor raise, and supervisor adoption of the four
// newly-doctrined read tools. Plus the i11/i12/i13 standing watches. Read-only.
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const since = process.argv[2] || new Date(Date.now() - 24 * 3600e3).toISOString();
const out = { since, probe: 'verify-i14-receipts' };
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 200) }; } }

(async () => {
  // (1) operator firing durations (session 5f90c628…): last 6 runs, ms→min.
  await sec('operator_durations', () => q(
    `SELECT LEFT(id::text, 8) AS run, status, "createdAt",
            ROUND(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt"))/60)::int AS dur_min
     FROM agent_runs WHERE "sessionId"::text LIKE '5f90c628%'
     ORDER BY "createdAt" DESC LIMIT 6`));
  // (2) receipts minted by the NEW tool list since `since`.
  const NEW_LIST = `('stop_run','answer_chat_question','approve_request','pause_schedule','resume_schedule',
                    'configure_workspace','import_repo','sync_workspace','set_chat_instructions',
                    'cancel_confirmation','dismiss_owner_question','create_chat_webhook')`;
  await sec('new_list_receipts', () => q(
    `SELECT tool, COUNT(*)::int AS n, BOOL_OR(ok) AS any_ok, MAX("createdAt") AS last
     FROM run_tool_receipts WHERE tool IN ${NEW_LIST} AND "createdAt" > '${since}'
     GROUP BY 1 ORDER BY 2 DESC`));
  await sec('new_list_receipt_sample', () => q(
    `SELECT id, tool, ok, LEFT("chatId"::text,8) AS chat, "createdAt"
     FROM run_tool_receipts WHERE tool IN ${NEW_LIST} AND "createdAt" > '${since}'
     ORDER BY "createdAt" DESC LIMIT 3`));
  // (3) chatTurns for the Fleet Supervisor lane (c0e22e36): replicate the ops-tools
  // get_run_receipts grouping VERBATIM (limit 3, receipts whose runId is NULL or not
  // one of the latest agent_runs, grouped by run key, oldest-first) — the endpoint shape.
  await sec('supervisor_receipts_raw', () => q(
    `SELECT "runId"::text AS run, tool, ok, "createdAt"
     FROM run_tool_receipts WHERE "chatId"::text LIKE 'c0e22e36%' AND "createdAt" > '${since}'
     ORDER BY "createdAt" DESC LIMIT 40`));
  // (4) memory_scope_evicted rows without meta.reason.
  await sec('eviction_reason', () => q(
    `SELECT (meta ? 'reason') AS has_reason, COUNT(*)::int AS n
     FROM loop_metrics WHERE kind='memory_scope_evicted' AND "createdAt" > '${since}'
     GROUP BY 1`));
  // (5) unified-memory semantic-leg failures: by-hour over 30h (deploy boundary =
  // first success wave carrying d418ea4d5) + the raw recent rows.
  await sec('semantic_leg_failures_by_hour', () => q(
    `SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n,
            MAX(LEFT(message, 120)) AS sample
     FROM app_error_logs
     WHERE message ILIKE '%unified-memory: semantic leg failed%' AND "createdAt" > now() - interval '30 hours'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 30`));
  // (6) supervisor adoption of the newly-doctrined read tools: tool_call parts in
  // supervisor-lane messages since `since` (parts = the persisted agent transcript).
  await sec('supervisor_newtool_calls', () => q(
    `SELECT LEFT(m."chatId"::text,8) AS chat, e->>'name' AS tool, COUNT(*)::int AS n, MAX(m."createdAt") AS last
     FROM crossmodel_messages m
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.parts)='array' THEN m.parts ELSE '[]'::jsonb END) e
     WHERE e->>'name' IN ('get_run_receipts','get_session_diff','resolve_id','cancel_confirmation')
       AND m."chatId"::text IN (SELECT id::text FROM crossmodel_chats WHERE title ILIKE '%supervisor%' AND "archivedAt" IS NULL)
       AND m."createdAt" > '${since}'
     GROUP BY 1,2 ORDER BY 3 DESC`));
  await sec('supervisor_parts_any', () => q(
    `SELECT LEFT(m."chatId"::text,8) AS chat, COUNT(*)::int AS msgs_with_parts,
            COUNT(*) FILTER (WHERE m.parts::text LIKE '%tool_call%')::int AS with_tool_calls
     FROM crossmodel_messages m
     WHERE m."chatId"::text IN (SELECT id::text FROM crossmodel_chats WHERE title ILIKE '%supervisor%' AND "archivedAt" IS NULL)
       AND m."createdAt" > '${since}' AND m.parts IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC LIMIT 8`));

  // ── standing watches (i11 clock, i12/i13) ─────────────────────────────────
  await sec('w_clock_strikes_24h', () => q(
    `SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs
     WHERE message ILIKE '%future-clock strike%' AND "createdAt" > now() - interval '24 hours'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 24`));
  await sec('w_clockhits_exempt_leak_24h', () => q(
    `SELECT COUNT(*)::int AS n FROM loop_metrics WHERE kind='guard_strike' AND meta ? 'clockHits'
     AND "createdAt" > now() - interval '24 hours'
     AND ((meta->'clockHits')::text ~ '"token": ?[~≈]' OR (meta->'clockHits')::text ~ '"token": ?[Bb]y')`));
  await sec('w_empty_content_24h', () => q(
    `SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM app_error_logs
     WHERE (message ILIKE '%empty content%' OR message ILIKE '%emptyContent%' OR message ILIKE '%content-empty%')
     AND "createdAt" > now() - interval '24 hours'`));
  await sec('w_qwen_thinking_24h', () => q(
    `SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM app_error_logs
     WHERE message ILIKE '%qwen%' AND message ILIKE '%thinking%' AND "createdAt" > now() - interval '24 hours'`));
  await sec('w_lost_worker_24h', () => q(
    `SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM app_error_logs
     WHERE message ILIKE '%lost its worker%' AND "createdAt" > now() - interval '24 hours'`));
  await sec('w_todo_get_failures_24h', () => q(
    `SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM app_error_logs
     WHERE message ILIKE '%todo_get%' AND (message ILIKE '%fail%' OR message ILIKE '%not found%')
     AND "createdAt" > now() - interval '24 hours'`));
  await sec('w_helper_seat_retries_24h', () => q(
    `SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs
     WHERE message ILIKE '%helper-seat%retrying once on the built-in%' AND "createdAt" > now() - interval '24 hours'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 24`));
  // the two 17:30Z infra_alert rows (from the 4h audit) — pull meta for disposition.
  await sec('w_infra_alert_rows', () => q(
    `SELECT LEFT("sessionId"::text,8) AS sess, meta->>'key' AS key, meta->>'class' AS class,
            meta->>'severity' AS severity, LEFT(meta->>'reason', 160) AS reason, "createdAt"
     FROM loop_metrics WHERE kind='infra_alert' AND "createdAt" > now() - interval '24 hours'
     ORDER BY "createdAt" DESC LIMIT 6`));
  // iteration 14 retro: clock strikes whose hit token is a RANGE END (the line's
  // clockHits token preceded by a dash/colon range on the same line) — the
  // false-positive class the range-END inheritance fix (FO firing 22) removes.
  // Post-fix this should trend to 0; a non-zero count needs the token read.
  await sec('w_clock_strike_range_end_24h', () => q(
    `SELECT LEFT("sessionId"::text,8) AS sess, "createdAt", (meta->'clockHits')::text AS clockhits
     FROM loop_metrics WHERE kind='guard_strike' AND meta ? 'clockHits'
       AND (meta->'clockHits')::text ~ '"token": "[0-9]{1,2}:[0-9]{2}[^"]*"'
       AND (meta->'clockHits')::text ~ '[–—-]'
       AND "createdAt" > now() - interval '24 hours'
     ORDER BY "createdAt" DESC LIMIT 8`));
  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message?.slice(0, 300)); process.exit(1); });

-- ============================================================================
-- fleet-status.sql — READ-ONLY fleet health probe (remediation P0, 2026-09-09)
--
-- One psql-runnable file: paste-run it against the RDS app database to get a
-- terminal snapshot of the autonomy loops. SELECTs only — no writes, no locks
-- beyond MVCC reads. Table/column names verified against
-- backend/prisma/schema.prisma (agent_runs / loop_metrics / owner_questions /
-- coding_schedules / hook_events / crossmodel_chats — Prisma keeps the
-- camelCase column names, hence the quoted identifiers).
--
-- Run:  psql "$DATABASE_URL" -f scripts/telemetry/fleet-status.sql
--
-- The stamp fields (meta->>'model' / 'provider' / 'profile' / 'triggerKind')
-- exist on rows written after remediation P0 deployed; older rows group under
-- 'unstamped'.
-- ============================================================================

\echo '── 1. Agent runs by status (last 24h, by createdAt) ─────────────────────'
SELECT status,
       COUNT(*)                                   AS runs,
       COUNT(*) FILTER (WHERE "startedAt" IS NULL) AS null_started_at,
       ROUND(AVG(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")))::numeric, 1)
         AS avg_run_secs
FROM "agent_runs"
WHERE "createdAt" >= now() - interval '24 hours'
GROUP BY status
ORDER BY runs DESC;

\echo ''
\echo '── 2. Guard strikes by seam × hour × model (last 24h) ───────────────────'
SELECT date_trunc('hour', "createdAt")                    AS hour,
       COALESCE(meta->>'seam', meta->>'guard', 'finalize') AS seam,
       COALESCE(meta->>'model', 'unstamped')               AS model,
       COUNT(*)                                            AS strikes
FROM "loop_metrics"
WHERE kind = 'guard_strike'
  AND "createdAt" >= now() - interval '24 hours'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, strikes DESC;

\echo ''
\echo '── 3. Spend by lane × day (last 7d, from run_spend rows; USD) ───────────'
SELECT date_trunc('day', "createdAt")                        AS day,
       COALESCE(meta->>'triggerKind', 'unstamped')            AS lane,
       COUNT(*)                                               AS runs,
       ROUND(SUM(value)::numeric, 4)                          AS usd,
       COUNT(*) FILTER (WHERE (meta->>'estimated') = 'true')  AS estimated_runs
FROM "loop_metrics"
WHERE kind = 'run_spend'
  AND "createdAt" >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, usd DESC;

\echo ''
\echo '── 4. Open owner questions (id, age, chat) ──────────────────────────────'
SELECT oq.id,
       date_trunc('minute', now() - oq."createdAt") AS age,
       oq."chatId",
       COALESCE(c.title, '(chat gone)')             AS chat_title,
       LEFT(oq.question, 100)                       AS question
FROM "owner_questions" oq
LEFT JOIN "crossmodel_chats" c ON c.id = oq."chatId"
WHERE oq.status = 'open'
ORDER BY oq."createdAt" ASC;

\echo ''
\echo '── 5. Enabled schedules per chat (runsCount / maxRuns) ──────────────────'
SELECT s."sessionId",
       COALESCE(c.title, '(chat gone)') AS chat_title,
       COUNT(*)                         AS enabled_schedules,
       SUM(s."runsCount")               AS total_runs,
       STRING_AGG(
         s.kind || ' ' || s."runsCount" || '/' || COALESCE(s."maxRuns"::text, '∞')
           || ' next ' || to_char(s."nextRunAt", 'MM-DD HH24:MI')
           || COALESCE(' [' || s."lastStatus" || ']', ''),
         '; ' ORDER BY s."nextRunAt") AS detail
FROM "coding_schedules" s
LEFT JOIN "crossmodel_chats" c ON c.id = s."sessionId"
WHERE s.enabled = true
GROUP BY s."sessionId", c.title
ORDER BY enabled_schedules DESC, total_runs DESC;

\echo ''
\echo '── 6. Hook events by status (last 24h) ──────────────────────────────────'
SELECT status,
       "eventType",
       COUNT(*)      AS events,
       MAX(attempts) AS max_attempts
FROM "hook_events"
WHERE "createdAt" >= now() - interval '24 hours'
GROUP BY status, "eventType"
ORDER BY status, events DESC;

\echo ''
\echo '── 7. Remediation-P0 kinds per day (last 7d) ────────────────────────────'
SELECT date_trunc('day', "createdAt") AS day,
       kind,
       COUNT(*)                       AS rows,
       ROUND(SUM(value)::numeric, 2)  AS sum_value
FROM "loop_metrics"
WHERE kind IN ('worktree_reaped', 'index_swept', 'memory_shrunk',
               'scaffold_commit_failed', 'provider_rejected',
               'schedule_busy_skip', 'self_audit_run')
  AND "createdAt" >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, rows DESC;

\echo ''
\echo '── 8. Model diversity: strikes vs spend per model (last 7d — P8) ────────'
-- The model-diversity comparison (docs/reviews/2026-09-09-model-diversity-note
-- .md): put one monitor lane per project on an alternative model, then read
-- this per-model strike rate + $/run side by side. Stamp fields exist on rows
-- written after remediation P0; older rows group under 'unstamped'.
SELECT COALESCE(meta->>'model', 'unstamped')                          AS model,
       COUNT(*)              FILTER (WHERE kind = 'guard_strike')      AS strikes,
       COUNT(DISTINCT "sessionId")
                             FILTER (WHERE kind = 'guard_strike')      AS striking_lanes,
       COUNT(*)              FILTER (WHERE kind = 'run_spend')         AS runs,
       ROUND((SUM(value)     FILTER (WHERE kind = 'run_spend'))::numeric, 4) AS usd,
       ROUND((COUNT(*) FILTER (WHERE kind = 'guard_strike'))::numeric
             / NULLIF(COUNT(*) FILTER (WHERE kind = 'run_spend'), 0), 3)     AS strikes_per_run
FROM "loop_metrics"
WHERE kind IN ('guard_strike', 'run_spend')
  AND "createdAt" >= now() - interval '7 days'
GROUP BY 1
ORDER BY strikes DESC, usd DESC;

\echo ''
\echo '── 9. Strike adjudication verdicts (last 7d — P8 N6b nightly job) ───────'
SELECT date_trunc('day', "createdAt")                       AS day,
       COALESCE(meta->>'adjudication', 'unadjudicated')      AS verdict,
       COUNT(*)                                              AS strikes
FROM "loop_metrics"
WHERE kind = 'guard_strike'
  AND "createdAt" >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, strikes DESC;

\echo ''
\echo '── 10. Containment ladder transitions/actions (last 7d — P8 S7) ─────────'
SELECT date_trunc('day', "createdAt")            AS day,
       meta->>'state'                             AS state,
       COALESCE(meta->>'action', '(transition)')  AS action,
       COUNT(*)                                   AS events
FROM "loop_metrics"
WHERE kind = 'containment_ladder'
  AND "createdAt" >= now() - interval '7 days'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, events DESC;

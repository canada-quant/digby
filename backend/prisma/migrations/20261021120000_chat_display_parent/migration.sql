-- CHAT DISPLAY PARENT (lane lifecycle, 2026-10-21, branch lanefix/nesting):
-- the owner's crossmodel folder showed every ticket / family lane FLAT — the
-- ticket drain spawns them through platform.service startCodingSession, which
-- never sets parentChatId (only the start_coding_session TOOL writes it), and a
-- Fleet-spawned lane's parent is the ungrouped Fleet chat, never in the folder.
--   displayParentChatId  display-only sidebar nesting fallback = the project's
--                        Project Supervisor chat for a machine-spawned lane.
--                        Soft ref: no FK (a deleted supervisor leaves the lane
--                        flat, like a deleted parentChatId), no index (read
--                        only on rows a list already selected).
-- NOT parentChatId on purpose: that column drives fire-cap billing, parent
-- autonomy, child-failure wakes, deliverable hand-off targeting and the
-- child reapers — stamping it would change all of them.
-- ADDITIVE ONLY: one nullable column, no default, no data rewrite — the
-- blue-green old colour never selects it and keeps working unchanged
-- (backfill: scripts/framework-audit/backfill-display-parent.js, dry-run first).
--
-- LOCK BOUND, RETRIED IN PLACE (third review 2026-10-22; fourth and fifth
-- reviews the same day). ADD COLUMN takes an ACCESS EXCLUSIVE lock even when
-- metadata-only, and while that request waits in the lock queue every later chat
-- read on the serving colour waits behind it. So:
--   * a holder that cannot release in time — a transaction open >= 2 s (pg_dump,
--     an idle-in-transaction session), a PREPARED transaction, an anti-wraparound
--     autovacuum, or a session whose details this role may not see — is waited
--     out WITHOUT queueing (pg_sleep 2 s, no lock request, no reader stalled);
--   * otherwise the lock is requested for at most 250 ms (SET LOCAL lock_timeout
--     inside a sub-block — each queued read stalls <= 250 ms, about 20 % of the
--     time at worst) and the loop sleeps 1 s after a lost wait; when a plain
--     autovacuum holds the table the request waits 1.5 s instead, past
--     deadlock_timeout, which is what makes Postgres cancel that autovacuum;
--   * the whole loop is bounded at 120 s (clock_timestamp — now() is frozen for
--     the transaction; the deploy's per-host budget carries two such loops).
-- PRIVILEGE-INDEPENDENT (fifth review): prod migrates as the app role, which has
-- no pg_read_all_stats, and pg_stat_activity hides xact_start / state / query /
-- backend_type of every OTHER role's session and of every autovacuum worker from
-- it. Only usesysid and pid are visible to every role: a background process (an
-- autovacuum worker) has NO user (usesysid NULL); a user session whose state reads
-- NULL is one whose details are hidden. An anti-wraparound autovacuum is known by
-- its query text when visible, else by the table's own freeze age (pg_class is
-- readable by every role), and an autovacuum a 1.5 s request already lost against
-- is never queued against again. pg_locks is cluster-wide and relation OIDs are
-- unique only within a database (a copy made from this one as a TEMPLATE keeps
-- them), so every read is restricted to this database.
-- A failed migration is recorded as FAILED in Prisma's migration table and every
-- later `prisma migrate deploy` refuses with P3009 until someone resolves it, so
-- an exhausted loop raises lock_not_available (55P03) with "[digby-lock-retry]"
-- in the message, naming the lock holders it saw. deploy-blue-green.sh
-- (scripts/deploy/migrate-lock-recovery.sh) resolves exactly that shape — and
-- only for a migration carrying the "digby-lock-retry: atomic" line below — as
-- rolled back, retries once (not when the loop only waited behind a long holder:
-- "(0 lock requests" — the retry would wait behind it too), and resolves again if
-- the retry loses too, so the NEXT deploy re-attempts instead of wedging. The
-- manual recovery for any other failed migration — a deploy KILLED mid-wait
-- included (its row carries no logs) — is in docs/REMOTE_OPS.md ("A migration
-- failed: P3009 / P3018").
--
-- digby-lock-retry: atomic — this DO block is the migration's ONLY statement, so
-- a lost lock wait applied nothing (Prisma does NOT run a migration file as one
-- transaction: statements before a failing one stay committed — keep it one
-- statement; scripts/deploy/migrate-lock-recovery.test.sh lints it).
DO $$
DECLARE
  budget constant interval := interval '120 seconds';
  deadline timestamptz := clock_timestamp() + budget;
  attempts integer := 0;
  waits integer := 0;
  long_holder boolean;
  autovacuum boolean;
  freeze_due boolean;
  vacuum_pids integer[];
  refused_pids integer[] := '{}';
  holders text;
BEGIN
  LOOP
    -- pg_stat_activity is snapshotted once per transaction: clear it every pass.
    PERFORM pg_stat_clear_snapshot();
    -- An autovacuum is anti-wraparound (never cancelled by a lock waiter) once the
    -- table's freeze age reaches its freeze_max_age (the table's own setting when lower).
    SELECT age(c.relfrozenxid)::bigint >= least(current_setting('autovacuum_freeze_max_age')::bigint,
             coalesce((SELECT o.option_value::bigint FROM pg_options_to_table(c.reloptions) o WHERE o.option_name = 'autovacuum_freeze_max_age'), current_setting('autovacuum_freeze_max_age')::bigint))
        OR mxid_age(c.relminmxid)::bigint >= least(current_setting('autovacuum_multixact_freeze_max_age')::bigint,
             coalesce((SELECT o.option_value::bigint FROM pg_options_to_table(c.reloptions) o WHERE o.option_name = 'autovacuum_multixact_freeze_max_age'), current_setting('autovacuum_multixact_freeze_max_age')::bigint))
      INTO freeze_due
      FROM pg_class c WHERE c.oid = '"crossmodel_chats"'::regclass;
    SELECT
      coalesce(bool_or(
        l.pid IS NULL                                                     -- a prepared transaction
        OR (a.usesysid IS NOT NULL AND a.state IS NULL)                   -- another role's session: details hidden
        OR (a.usesysid IS NOT NULL AND a.xact_start < clock_timestamp() - interval '2 seconds')
        OR (a.pid IS NOT NULL AND a.usesysid IS NULL                      -- a background worker (autovacuum) that will not yield
            AND (coalesce(freeze_due, false) OR coalesce(a.query, '') LIKE '%to prevent wraparound%' OR l.pid = ANY (refused_pids)))
      ), false),
      coalesce(bool_or(a.pid IS NOT NULL AND a.usesysid IS NULL), false),
      coalesce(array_agg(l.pid) FILTER (WHERE a.pid IS NOT NULL AND a.usesysid IS NULL), '{}')
      INTO long_holder, autovacuum, vacuum_pids
      FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'relation' AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
        AND l.relation = '"crossmodel_chats"'::regclass AND l.granted AND l.pid IS DISTINCT FROM pg_backend_pid();
    IF long_holder THEN
      waits := waits + 1;
    ELSE
      attempts := attempts + 1;
      BEGIN
        IF autovacuum THEN
          SET LOCAL lock_timeout = '1500ms';
        ELSE
          SET LOCAL lock_timeout = '250ms';
        END IF;
        ALTER TABLE "crossmodel_chats" ADD COLUMN IF NOT EXISTS "displayParentChatId" TEXT;
        RETURN;
      EXCEPTION WHEN lock_not_available THEN
        -- lost this wait: nothing was changed (the sub-block rolled back). An
        -- autovacuum that outlasted a 1.5 s request is not cancellable: never queue behind it again.
        refused_pids := refused_pids || vacuum_pids;
      END;
    END IF;
    IF clock_timestamp() >= deadline THEN
      PERFORM pg_stat_clear_snapshot();
      SELECT string_agg(format('pid %s (%s, %s, %s, %s, open %s s)', coalesce(h.pid::text, 'prepared'), coalesce(nullif(a.application_name, ''), '?'),
          CASE WHEN a.pid IS NOT NULL AND a.usesysid IS NULL THEN coalesce(a.backend_type, 'background worker') ELSE coalesce(a.backend_type, '?') END,
          coalesce(a.state, '?'), h.mode, coalesce(round(extract(epoch FROM clock_timestamp() - a.xact_start))::text, '?')), '; ')
        INTO holders
        FROM (SELECT DISTINCT ON (l.pid) l.pid, l.mode FROM pg_locks l
              WHERE l.locktype = 'relation' AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
                AND l.relation = '"crossmodel_chats"'::regclass AND l.granted AND l.pid IS DISTINCT FROM pg_backend_pid()
              ORDER BY l.pid LIMIT 5) h
        LEFT JOIN pg_stat_activity a ON a.pid = h.pid;
      RAISE EXCEPTION USING
        ERRCODE = 'lock_not_available',
        MESSAGE = format('[digby-lock-retry] crossmodel_chats: the ADD COLUMN lock was not acquired in %s s (%s lock requests of <= 1.5 s, %s waits behind a long transaction) — nothing was changed; lock holders: %s',
          extract(epoch FROM budget)::integer, attempts, waits, coalesce(holders, 'none visible'));
    END IF;
    PERFORM pg_sleep(CASE WHEN long_holder THEN 2 ELSE 1 END);
  END LOOP;
END $$;

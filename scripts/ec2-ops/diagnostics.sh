#!/usr/bin/env bash
# Read-only health snapshot for a CrossModel EC2.
# Invoked by .github/workflows/ec2-ops.yml as:  scp this-file <host>:/tmp/… && ssh <host> "ROLE=prod bash /tmp/… < /dev/null"
# (2026-08-30 transport fix, ticket 795cc5fb: never `bash -s` over ssh stdin —
#  stdin-reading commands would eat the script itself; see playbook.sh header.)
# NEVER put mutating commands here — this file is the safe, always-run snapshot.
# Put fixes in playbook.sh instead.
set +e
ROLE="${ROLE:-unknown}"
echo "########## DIAGNOSTICS (ROLE=$ROLE) ##########"
echo "=== diagnostics sha256: $(sha256sum "$0" 2>/dev/null | cut -d' ' -f1 || echo unknown) ==="
echo "host: $(hostname)   user: $(whoami)"
echo "uptime:$(uptime)"

if [ "$ROLE" = "prod" ]; then
  # PROD box — ubuntu@EC2_HOST, /opt/crossmodel (live digby.ai)
  echo; echo "===== HOST VITALS (memory / disk / oom / services) ====="
  # Added for the 2026-07-29 total-outage triage (TCP accepted, TLS/SSH wedged
  # → userspace starvation suspected). Keep: this is the first thing to read
  # whenever the box goes dark.
  free -h | sed 's/^/  /'
  df -h / | sed 's/^/  /'
  echo '  -- top-memory processes --'
  ps aux --sort=-%mem | awk 'NR<=7{printf "  %-10s mem=%s%% cpu=%s%% %s\n", $1,$4,$3,$11}'
  echo '  -- oom / kernel errors (dmesg tail) --'
  (sudo dmesg -T 2>/dev/null || sudo dmesg 2>/dev/null) | grep -iE 'oom|out of memory|killed process|blocked for more than' | tail -12 || echo '  (none)'
  echo '  -- service states --'
  for s in docker nginx ssh; do echo "  $s: $(systemctl is-active "$s" 2>/dev/null || echo unknown)"; done
  echo '  -- listeners on 22/80/443 --'
  sudo ss -ltnp 2>/dev/null | grep -E ':(22|80|443)\s' | sed 's/^/  /' || echo '  (none / ss unavailable)'

  echo; echo "===== CONTAINERS ====="
  sudo docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -Ei 'admin-|mcp|postgres|redis' || sudo docker ps
  echo '  -- per-container CPU/mem (one-shot; catches leftover failed-color stacks) --'
  sudo docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' 2>/dev/null | head -25 || true

  echo; echo "===== ACTIVE COLOR HEALTH ====="
  curl -s --max-time 8 http://localhost:4001/api/health && echo "  <- blue(4001)"  || true
  curl -s --max-time 8 http://localhost:4002/api/health && echo "  <- green(4002)" || true

  echo; echo "===== NGINX STREAM SETTINGS (nginx -T: timeout / keepalive / buffering / worker_shutdown only) ====="
  # Stream drops (2026-10-20, owner "why does connection drop?"): the prod
  # blue-green nginx config is NOT in the repo (infrastructure.yml's block is a
  # stale single-stack copy), so the SSE-relevant values — proxy_read_timeout,
  # proxy_send_timeout, send_timeout, worker_shutdown_timeout, proxy_buffering,
  # keepalive* — are read off the box. Read-only (nginx -T only dumps the
  # loaded config). Matching DIRECTIVE lines only, grouped by file; any line
  # naming a key / secret / password / token / auth is skipped outright.
  NGX_DUMP="$(sudo nginx -T 2>/dev/null)"
  if [ -z "$NGX_DUMP" ]; then
    echo '  (nginx -T unavailable)'
  else
    printf '%s\n' "$NGX_DUMP" | awk '
      /^# configuration file / { file=$4; sub(/:$/, "", file); next }
      tolower($0) ~ /(key|secret|passw|token|auth|cert)/ { next }
      $0 ~ /(timeout|keepalive|buffering|worker_shutdown)/ {
        line=$0; sub(/^[ \t]+/, "", line)
        if (line ~ /^#/) next
        if (file != last) { print "  -- " file " --"; last=file }
        print "    " line
      }'
  fi
  unset NGX_DUMP

  # Live-store handle (post 2026-07-31 RDS cutover): the backend container's
  # own DATABASE_URL. NEVER query the retired on-box admin-postgres-prod for
  # app data — it is a stale snapshot frozen 2026-08-01 that was left running
  # and silently fooled the 08-07/08-08 inventory + purge (owner report
  # 2026-08-15: settings still showed 129 users). Stopped by the r3 one-shot.
  BE_URL="$(sudo docker exec admin-backend-blue sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)"
  [ -z "$BE_URL" ] && BE_URL="$(sudo docker exec admin-backend-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)"
  redact() { sed -E 's#(postgres(ql)?://[^:]+:)[^@]+@#\1***@#g'; }
  echo "  live store (backend DATABASE_URL, redacted): $(printf '%s' "$BE_URL" | redact)"
  if sudo docker ps --format '{{.Names}}' | grep -qx 'admin-postgres-prod'; then
    PSQL='sudo docker exec -i admin-postgres-prod psql'
  else
    PSQL='sudo docker run --rm -i pgvector/pgvector:pg16 psql'
  fi

  echo; echo "===== FEEDBACK TABLES (live store) ====="
  $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc <<'SQL' 2>&1 | redact
\echo '-- user_feature_requests by status --'
SELECT status, count(*) FROM user_feature_requests GROUP BY status ORDER BY status;
\echo '-- message_feedback by resolved --'
SELECT resolved, count(*) FROM message_feedback GROUP BY resolved;
\echo '-- open tickets --'
SELECT id, type, left(title,50), status FROM user_feature_requests WHERE status IN ('open','in_progress') ORDER BY "createdAt" DESC LIMIT 10;
SQL

  echo; echo "===== USER INVENTORY (smoke-account classifier, read-only) ====="
  # Added 2026-08-14 for the deploy-smoke-* purge (backlog #3, owner directive:
  # "you only need one dedicated login"). Counts by domain/pattern ONLY — no
  # real-user emails printed beyond the canonical/owner rows.
  $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc <<'SQL' 2>&1 | redact
\echo '-- total users --'
SELECT count(*) AS total_users FROM users;
\echo '-- users by email domain (no PII) --'
SELECT lower(split_part(email,'@',2)) AS domain, count(*) FROM users GROUP BY 1 ORDER BY 2 DESC LIMIT 15;
\echo '-- junk-pattern buckets --'
SELECT 'deploy-smoke-*@example.com' AS bucket, count(*) FROM users WHERE email LIKE 'deploy-smoke-%@example.com'
UNION ALL SELECT 'other @example.com', count(*) FROM users WHERE email LIKE '%@example.com' AND email NOT LIKE 'deploy-smoke-%@example.com'
UNION ALL SELECT 'test/smoke-named (non-example.com)', count(*) FROM users WHERE email ~* '(^|[@._+-])(test|smoke|tmp|throwaway)' AND email NOT LIKE '%@example.com';
\echo '-- canonical + owner presence (must survive any purge) --'
SELECT email, role, to_char("createdAt",'YYYY-MM-DD') AS created FROM users WHERE email IN ('claudebot@digby.ai','example-user@example.com') ORDER BY email;
\echo '-- real (non-example.com) users: count + newest registration --'
SELECT count(*) AS real_users, max("createdAt") AS newest_registration FROM users WHERE email NOT LIKE '%@example.com';
\echo '-- example.com users holding chat rows (must be 0 before purge) --'
SELECT count(DISTINCT c."userId") AS example_users_with_chats FROM crossmodel_chats c JOIN users u ON u.id=c."userId" WHERE u.email LIKE '%@example.com';
SQL

  echo; echo "===== PAIRED IMESSAGE/COMPUTER AGENTS (multi-device primary-race diagnostic, read-only) ====="
  # Added 2026-08-31: getPrimaryAgent picks the newest-paired IMessageAgent
  # (pairedAt desc). computer_task probes started landing on a SECOND paired Mac
  # (old agent code) instead of the MacBook Pro — this inventory shows every
  # paired agent row so the rogue device is identifiable by deviceName/version.
  $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc <<'SQL' 2>&1 | redact
\echo '-- all paired agents (email | label | deviceName | agentVersion | pairedAt | lastSeenAt) --'
SELECT u.email, a.label, a."deviceName", a."agentVersion", to_char(a."pairedAt",'YYYY-MM-DD HH24:MI:SSZ'), to_char(a."lastSeenAt",'YYYY-MM-DD HH24:MI:SSZ')
FROM "imessage_agents" a JOIN users u ON u.id = a."userId"
ORDER BY a."userId", a."pairedAt" DESC;
SQL

  echo; echo "===== LIVE STORE LIVENESS (counts through the backend connstring) ====="
  # Added 2026-08-15 after the stale-store incident: the 08-07/08-08 inventory
  # + purge ran against the retired on-box container (frozen 2026-08-01) and
  # reported success while the live RDS store was untouched. These counts come
  # THROUGH the backend's own DATABASE_URL — if a local-container read ever
  # disagrees with these, the local read is wrong by definition.
  WK_URL="$(sudo docker exec admin-worker-blue sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)"
  echo "worker  DATABASE_URL: $(printf '%s' "$WK_URL" | redact)"
  if [ -n "$BE_URL" ]; then
    $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc -v ON_ERROR_STOP=1 <<'SQL' 2>&1 | redact
\echo '-- LIVE users: total / example.com / real / newest registration --'
SELECT 'total|' || count(*) FROM users;
SELECT 'example_com|' || count(*) FROM users WHERE email LIKE '%@example.com';
SELECT 'real|' || count(*) FROM users WHERE email NOT LIKE '%@example.com';
SELECT 'newest_registration|' || max("createdAt") FROM users;
\echo '-- LIVE store liveness (fleet traffic lands here every minute) --'
SELECT 'newest_chat_message|' || max("createdAt") FROM crossmodel_messages;
SELECT 'messages_last_6h|' || count(*) FROM crossmodel_messages WHERE "createdAt" > now() - interval '6 hours';
SELECT 'feedback_open|' || count(*) FROM user_feature_requests WHERE status = 'open';
SQL
  fi

  echo; echo "===== CODING SELF-SCHEDULES (nightly self-improvement; live store) ====="
  $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc <<'SQL' 2>&1 | redact
\echo '-- schedules (id | kind | enabled | intervalSec | nextRunAt | runs/max | lastFiredAt | lastStatus) --'
SELECT id, kind, enabled, "intervalSec", "nextRunAt", "runsCount"||'/'||coalesce("maxRuns"::text,'-'), "lastFiredAt", "lastStatus"
  FROM coding_schedules WHERE enabled ORDER BY "nextRunAt" LIMIT 20;
\echo '-- their sessions (id | title | status | last msg) --'
SELECT c.id, left(c.title,45), s.status, (SELECT max("createdAt") FROM coding_messages m WHERE m."sessionId"=c.id)
  FROM coding_schedules sc JOIN crossmodel_chats c ON c.id=sc."sessionId"
  LEFT JOIN coding_sessions s ON s.id=sc."sessionId" WHERE sc.enabled GROUP BY c.id, c.title, s.status;
SQL
  echo '-- live run-locks (present => a run is LIVE right now) --'
  sudo docker exec admin-redis-prod redis-cli keys 'coding:session:run:*' 2>/dev/null | head || true

  echo; echo "===== CODING CONTAINER ISOLATION (is CODING_CONTAINER_MODE on?) ====="
  AC=$(cat .active-color 2>/dev/null || echo blue); BE="admin-backend-${AC}"
  echo -n "  CODING_CONTAINER_MODE in $BE: "; sudo docker exec "$BE" sh -lc 'echo "${CODING_CONTAINER_MODE:-UNSET}"' 2>/dev/null || echo "exec n/a"
  echo -n "  docker-proxy container present: "; sudo docker ps --format '{{.Names}}' | grep -c admin-docker-proxy-prod || echo 0
  echo -n "  digby-code-* session containers (running/total): "; echo "$(sudo docker ps --format '{{.Names}}' | grep -c '^digby-code-')/$(sudo docker ps -a --format '{{.Names}}' | grep -c '^digby-code-')"
  sudo docker ps -a --format '  {{.Names}} {{.Status}}' | grep '^  digby-code-' | head -5 || echo "  (no session containers ever created)"

  echo; echo "===== DURABLE CODING WORKER (Phase 2/3) ====="
  sudo docker ps -a --format 'table {{.Names}}\t{{.Status}}' | grep -E 'admin-worker' || echo "  (no worker containers)"
  echo '-- worker boot line (shows concurrency) + last log lines --'
  # Detect the RUNNING worker container directly — .active-color is stale
  # mid-deploy (observed 2026-07-25: it said blue while green was live).
  WK=$(sudo docker ps --format '{{.Names}}' | grep '^admin-worker-' | head -1)
  if [ -n "$WK" ]; then
    sudo docker logs "$WK" 2>&1 | grep -E 'coding worker .* started' | tail -2 || true
    sudo docker logs "$WK" --tail 10 2>&1 || true
  else
    echo "  (no running worker container)"
  fi
  echo '-- host + container resources --'
  echo "  vCPUs: $(nproc)   load:$(cut -d' ' -f1-3 /proc/loadavg)"
  free -h | sed 's/^/  /'
  sudo docker stats --no-stream --format '  {{.Name}}\tcpu={{.CPUPerc}}\tmem={{.MemUsage}}' 2>/dev/null | grep -E 'admin-(backend|worker|frontend|postgres|redis)' || true
  echo '-- agent_runs: status counts + in-flight rows (heartbeat/lease age tells zombie vs live) (live store) --'
  $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc <<'SQL' 2>&1 | redact
SELECT status, count(*) FROM agent_runs GROUP BY status ORDER BY status;
\echo '-- in-flight (id8 | session8 | status | attempts | step | started | hb_age_s | lease_in_s | worker) --'
SELECT left(id,8), left("sessionId",8), status, attempts, coalesce("currentStep",0),
       to_char("startedAt",'MM-DD HH24:MI'),
       round(extract(epoch FROM (now()-"heartbeatAt"))),
       round(extract(epoch FROM ("leaseExpiresAt"-now()))),
       coalesce("workerId",'-')
  FROM agent_runs WHERE status IN ('queued','running','interrupted')
  ORDER BY "createdAt" LIMIT 20;
\echo '-- their sessions (id8 | status | title40) --'
SELECT left(s.id,8), s.status, left(s.title,40)
  FROM coding_sessions s
 WHERE s.id IN (SELECT "sessionId" FROM agent_runs WHERE status IN ('queued','running','interrupted'));
\echo '-- cron_jobs (id | lastFiredAt | lastStatus | nextRunAt) --'
SELECT id, "lastFiredAt", "lastStatus", "nextRunAt" FROM cron_jobs ORDER BY id;
SQL

  # (One-off Digby Code session / web-tool inspections go here when needed —
  #  read-only. Keep this file to the durable snapshot otherwise; see docs/REMOTE_OPS.md.)

  echo; echo "===== ONE-OFF 20260822a: fleet-supervisor rebuild (PR #296) prod verification ====="
  # Read-only verification that the supervisor rebuild actually deployed:
  # migration applied, state doc alive, new profile in the running container,
  # lane + supervisor + session ids for the ticket-lane env flip. ZERO writes.
  $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc <<'SQL' 2>&1 | redact
\echo '-- supervisor_states: table exists? + rows + latest state peek --'
SELECT to_regclass('public.supervisor_states');
SELECT count(*) FROM supervisor_states;
SELECT left("chatId",8), to_char("updatedAt",'MM-DD HH24:MI'), left(state::text,400) FROM supervisor_states ORDER BY "updatedAt" DESC LIMIT 3;
\echo '-- supervisor chats (id | title | created) --'
SELECT id, left(title,60), to_char("createdAt",'MM-DD HH24:MI') FROM crossmodel_chats WHERE "isSupervisor"=true;
\echo '-- ticket-lane candidates (nightly self-improve / platform engineer) --'
SELECT c.id, left(c.title,60), s.status FROM crossmodel_chats c LEFT JOIN coding_sessions s ON s.id=c.id
 WHERE c.id::text LIKE 'b92ef13f%' OR c.title ILIKE '%self-improv%' OR c.title ILIKE '%nightly%' OR c.title ILIKE '%platform engineer%' LIMIT 10;
\echo '-- session 95eab38f chat row --'
SELECT id, left(title,60) FROM crossmodel_chats WHERE id::text LIKE '95eab38f%';
\echo '-- autonomy rows: supervisor(s) + this session --'
SELECT left(ca."chatId",8) AS chat, ca."allowedTools", ca."scheduleCap"
  FROM chat_autonomy ca JOIN crossmodel_chats c ON c.id=ca."chatId"
 WHERE c."isSupervisor"=true OR ca."chatId"::text LIKE '95eab38f%';
\echo '-- supervisor chat: message volume last 24h (state-doc injection should be visible in wakes) --'
SELECT count(*) FROM crossmodel_messages WHERE "chatId" IN (SELECT id FROM crossmodel_chats WHERE "isSupervisor"=true) AND "createdAt" > now() - interval '24 hours';
SQL
  AC=$(cat /opt/crossmodel/.active-color 2>/dev/null || echo blue)
  echo "-- deployed code check (admin-backend-${AC}): supervisorProfile + ticket-dispatch present in dist --"
  sudo docker exec "admin-backend-${AC}" sh -lc 'grep -c supervisorProfile /app/dist/modules/crossmodel/coding/agent-profiles.js; grep -c "TICKET_DISPATCH_ENABLED" /app/dist/modules/crossmodel/feedback/ticket-dispatch.service.js' 2>&1 || echo "  grep n/a"
  echo "-- ticket-lane env presence in ${AC} backend (UNSET expected until lever-1 flip) --"
  sudo docker exec "admin-backend-${AC}" sh -lc 'printf "TICKET_DISPATCH_ENABLED=%s PLATFORM_ENGINEER_CHAT_ID=%s TICKET_DISPATCH_DAILY_CAP=%s\n" "${TICKET_DISPATCH_ENABLED:-UNSET}" "${PLATFORM_ENGINEER_CHAT_ID:-UNSET}" "${TICKET_DISPATCH_DAILY_CAP:-UNSET}"' 2>&1 || echo "  exec n/a"
  echo '-- recent ticket-dispatch log lines (if any) --'
  sudo docker logs "admin-backend-${AC}" 2>&1 | grep -i 'ticket-dispatch\|ticket dispatch' | tail -5 || echo '  (none yet)'

  echo; echo "===== ONE-OFF 20260831a: phantom-clock ticket 9baaba8d — clock anchors + supervisor transcript rows (read-only) ====="
  # Question: the future-clock guard struck the fleet supervisor at 2026-08-30T00:20:50Z
  # for quoting a "🔔 Attention watchdog … (Sat, 5:26 PM PDT)" notice (00:26Z, +5m).
  # Was that notice really posted BEFORE the strike with a FAST stamp (host clock
  # skew → guard false positive), or after (LLM invented the stamp → true positive)?
  # Every row's createdAt is the RDS clock (real time) — compare each row's
  # createdAt with the clock text embedded in its content.
  echo "-- host clock (this box) --"
  date -u +'  host_date_utc=%Y-%m-%dT%H:%M:%S.%3NZ'
  (chronyc tracking 2>/dev/null | sed 's/^/  chronyc: /') || echo "  chronyc n/a"
  (timedatectl 2>/dev/null | head -4 | sed 's/^/  timedatectl: /') || true
  echo "-- rds clock (real time) --"
  $PSQL "$BE_URL" -t -A --no-psqlrc -c "SELECT to_char(now(),'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS rds_now_utc;" 2>&1 | redact
  echo "-- supervisor transcript rows 2026-08-30 00:00-18:00Z (watchdog/verifier/withheld/5:26 PM) --"
  $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc <<'SQL' 2>&1 | redact
SELECT to_char(m."createdAt",'YYYY-MM-DD HH24:MI:SS.MS') AS created_utc,
       m.role, left(m.id,8) AS msg,
       left(regexp_replace(m.content, '\s+', ' ', 'g'), 320) AS head
FROM crossmodel_messages m
WHERE m."chatId" = 'c0e22e36-1c74-4295-8049-9b48335c6c37'
  AND m."createdAt" BETWEEN '2026-08-30 00:00:00+00' AND '2026-08-30 18:00:00+00'
  AND (m.content LIKE '%Attention watchdog%' OR m.content LIKE '%5:26 PM%'
       OR m.content LIKE '%ACTION VERIFIER%' OR m.content LIKE '%withheld after failing%')
ORDER BY m."createdAt";
SQL
  echo "-- machine-wake preambles in the same window (run-host clock vs RDS createdAt) --"
  $PSQL "$BE_URL" -t -A -F'|' --no-psqlrc <<'SQL' 2>&1 | redact
SELECT to_char(m."createdAt",'HH24:MI:SS.MS') AS created_utc, left(m.id,8) AS msg,
       substring(m.content from 'Current time: ([0-9T:.\-]+Z)') AS preamble_clock
FROM crossmodel_messages m
WHERE m."chatId" = 'c0e22e36-1c74-4295-8049-9b48335c6c37'
  AND m."createdAt" BETWEEN '2026-08-30 00:00:00+00' AND '2026-08-30 18:00:00+00'
  AND m.content LIKE '[MACHINE-TRIGGERED RUN%'
ORDER BY m."createdAt";
SQL
  echo "-- (agent_runs check dropped: plain-chat machine runs write no agent_runs rows — the query returned empty on both 2026-08-31 probe runs) --"

  echo; echo "===== VOLUME OWNERSHIP-WALK COST (2026-09-01 deploy-stall probe, read-only) ====="
  # backend/entrypoint.sh runs `chown -R nodejs:nodejs` on both named volumes at
  # EVERY container start. The 2026-09-01 deploy failures (run 33505472300 ×3):
  # a ~300-330s stall between the entrypoint banner and the first app log on
  # host 1 only (the volume-less runner does the same boot in ~4s; host B boots
  # in ~50s) — the chown walk is the suspect, growing with volume file count
  # (77s on 2026-08-07 → ~190s on 2026-08-31 → ~306s today). Measure the
  # walk's dominant IO cost READ-ONLY (find metadata walk ≈ chown walk, no
  # mutation): if minutes, the recursive chown is the deploy-blocker.
  for V in crossmodel_coding_workspaces crossmodel_coding_session_env; do
    MP="$(sudo docker volume inspect -f '{{.Mountpoint}}' "$V" 2>/dev/null || true)"
    if [ -z "$MP" ] || ! sudo test -d "$MP"; then echo "  $V: mountpoint not found (got '$MP')"; continue; fi
    echo "  $V -> $MP"
    { time sudo find "$MP" -xdev 2>/dev/null | wc -l | sed 's/^/  files: /'; } 2>&1 | sed 's/^/  /'
  done

else
  echo "Unknown ROLE='$ROLE' (expected dev|prod) — nothing to do."
fi
echo "########## END DIAGNOSTICS (ROLE=$ROLE) ##########"


# outage-20260729: post-boot recovery kick (frontend 502 behind healthy backend) 020400

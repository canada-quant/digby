#!/usr/bin/env bash
# EC2 remote-ops PLAYBOOK — this is the editable "do a fix" script.
# Invoked by .github/workflows/ec2-ops.yml as:  scp this-file <host>:/tmp/… && ssh <host> "ROLE=prod bash /tmp/… < /dev/null"
# (2026-08-30 transport fix, ticket 795cc5fb: NEVER `bash -s` over ssh stdin — a
#  script on stdin is consumed by any stdin-reading command in it (docker run/exec
#  -i, cat, nested ssh, …), so later blocks SILENTLY never execute while the run
#  exits 0. Running from an on-disk file makes stdin starvation impossible.)
# It runs on BOTH boxes; branch on "$ROLE" so each command lands on the right one.
#
# HOW TO RUN A FIX from a web session (which cannot SSH directly):
#   1. Put your commands in the matching ROLE branch below.
#   2. git commit + git push origin <branch>:main
#   3. The push triggers ec2-ops.yml (path-scoped). Read output with the GitHub
#      MCP tool get_job_logs on the resulting run (workflow ec2-ops.yml).
#   4. Reset this file back to the idempotent default when done (optional).
#
# SAFETY:
#   - Anything written here WILL run on the targeted box on the next push.
#   - DEV (paul@EC2_DEV_HOST, /home/paul/crossmodel) = autopilot host — safe for
#     systemd/git/kanban fixes.
#   - PROD (ubuntu@EC2_HOST, /opt/crossmodel) = LIVE digby.ai. App/code changes
#     should go through the normal deploy (push to main → deploy.yml), NOT here.
#     Keep the prod branch for read-mostly assertions or genuine emergencies.
set -uo pipefail
ROLE="${ROLE:-unknown}"
echo "=== playbook start (ROLE=$ROLE  host=$(hostname)) ==="
# Self-report the on-disk script's sha256 (ticket 795cc5fb). The workflow gates on
# this line matching the LOCAL file's sha256: it proves the whole file transferred
# and is what is executing. Prints "unknown" if run via `bash -s` ($0 is not a
# file) — which FAILS the workflow gate on purpose, enforcing the disk transport.
echo "=== playbook sha256: $(sha256sum "$0" 2>/dev/null | cut -d' ' -f1 || echo unknown) ==="

# NOTE: the "dev"/autopilot box was retired 2026-07-20 (autopilot removed; its
# systemd units were disabled+masked via the teardown that lived here — see git
# history). ec2-ops.yml no longer invokes ROLE=dev, so this branch is unreachable
# and kept only as a marker. This workflow is PROD-only now.

if [ "$ROLE" = "prod" ]; then
  cd /opt/crossmodel 2>/dev/null || { echo "repo missing"; exit 0; }

  # ── ONE-SHOT (2026-09-08rb, prod): EMERGENCY ROLLBACK — P1 UI deploy e69aa68a serves unstyled pages (CSS not applying, DOM fine). Flip blue/green back. ──
  MARKER_RB0908=/var/tmp/.digby-rb0908
  if [ ! -f "$MARKER_RB0908" ]; then
    echo "== RB0908 host=$(hostname) =="
    sudo bash /opt/crossmodel/rollback.sh 2>&1 | tail -15
    echo "-- active containers after --"
    sudo docker ps --format '{{.Names}}' | grep -E 'admin-(frontend|backend)' | head -4
    echo "== END RB0908 =="
    sudo touch "$MARKER_RB0908"
  fi

  # ── ONE-SHOT (2026-09-07tk, prod): outstanding work audit — tickets, decisions, stale in_progress (read-only). ──
  MARKER_TK0907=/var/tmp/.digby-tk0907
  if [ ! -f "$MARKER_TK0907" ]; then
    echo "== TK0907 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -20; }
    echo "--- feedback tickets by status ---"
    q "SELECT status, count(*) FROM user_feature_requests GROUP BY status ORDER BY status"
    echo "--- ALL open/in_progress tickets (full list) ---"
    q "SELECT left(id::text,8), status, 'p'||priority, to_char(\"updatedAt\",'MM-DD HH24:MI'), left(title,85) FROM user_feature_requests WHERE status IN ('open','in_progress') ORDER BY \"updatedAt\" DESC LIMIT 15"
    echo "--- open owner questions / pending decisions ---"
    q "SELECT left(id::text,8), to_char(\"createdAt\",'MM-DD HH24:MI'), left(question,90) FROM owner_questions WHERE status='open' ORDER BY \"createdAt\" DESC LIMIT 10"
    echo "--- tickets updated in last 24h (what the loop closed) ---"
    q "SELECT status, count(*) FROM user_feature_requests WHERE \"updatedAt\" > now() - interval '24 hours' GROUP BY status"
    echo "== END TK0907 =="
    sudo touch "$MARKER_TK0907"
  fi

  # ── ONE-SHOT (2026-09-07vr, prod): fast-forward digest cron + verify spark false-alarm retraction after the successor-aware fix. ──
  MARKER_VR0907=/var/tmp/.digby-vr0907
  if [ ! -f "$MARKER_VR0907" ]; then
    echo "== VR0907 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -12; }
    q "UPDATE cron_jobs SET \"nextRunAt\" = now() WHERE id='project-digest' AND (\"leaseExpiresAt\" IS NULL OR \"leaseExpiresAt\" < now()) RETURNING id||' fast-forwarded'"
    echo "--- waiting for the sweep (progress dots keep the CI ssh alive) ---"
    for i in $(seq 1 24); do printf '.'; sleep 10; LF=$(sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "SELECT (\"lastFiredAt\" > now() - interval '3 minutes')::text FROM cron_jobs WHERE id='project-digest'" 2>/dev/null); [ "$LF" = "true" ] && sleep 20 && break; done; echo ""
    echo "--- spark digest AFTER: attention count + stopped-cadence items + summary lead ---"
    q "SELECT to_char(d.\"updatedAt\",'MM-DD HH24:MI'), jsonb_array_length(coalesce(d.\"attentionItems\",'[]'::jsonb)), left(regexp_replace(d.summary,'[[:space:]]+',' ','g'),160) FROM project_digests d JOIN crossmodel_projects p ON p.id=d.\"projectId\" WHERE p.name ILIKE '%spark%' AND d.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') LIMIT 1"
    q "SELECT count(*) FROM project_digests d JOIN crossmodel_projects p ON p.id=d.\"projectId\", jsonb_array_elements(coalesce(d.\"attentionItems\",'[]'::jsonb)) it WHERE p.name ILIKE '%spark%' AND d.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') AND it->>'kind'='schedule_error' AND it->>'detail' LIKE '%will not resume%'"
    echo "--- open stopped-schedule decision cards (should be ZERO for spark) ---"
    q "SELECT count(*) FROM owner_questions WHERE status='open' AND question LIKE '%Resume the stopped schedule%'"
    echo "== END VR0907 =="
    sudo touch "$MARKER_VR0907"
  fi

  # ── ONE-SHOT (2026-09-06s2, prod): is the kernel-opt lane b95e9df6 ACTIVELY working despite disabled schedules? (read-only) ──
  MARKER_SA0906B=/var/tmp/.digby-sa0906b
  if [ ! -f "$MARKER_SA0906B" ]; then
    echo "== SA0906B host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -25; }
    LANE="b95e9df6-099d-4aeb-ae71-22901565dd16"
    echo "--- lane runs last 48h ---"
    q "SELECT to_char(r.\"createdAt\",'MM-DD HH24:MI'), r.status, left(coalesce(r.error,'-'),40) FROM agent_runs r WHERE r.\"sessionId\"='$LANE' AND r.\"createdAt\" > now() - interval '48 hours' ORDER BY r.\"createdAt\" DESC LIMIT 15"
    echo "--- lane schedules (ALL) ---"
    q "SELECT left(s.id::text,8), s.enabled, coalesce((s.\"intervalSec\"/60)::text,'-')||'m', coalesce(to_char(s.\"nextRunAt\",'MM-DD HH24:MI'),'-'), s.\"runsCount\", coalesce(s.\"lastStatus\",'-') FROM coding_schedules s WHERE s.\"sessionId\"='$LANE' ORDER BY s.enabled DESC LIMIT 10"
    echo "--- lane last 5 user rows (what wakes it) ---"
    q "SELECT to_char(m.\"createdAt\",'MM-DD HH24:MI'), coalesce(m.metadata->>'origin','-'), left(regexp_replace(m.content,'[[:space:]]+',' ','g'),100) FROM crossmodel_messages m WHERE m.\"chatId\"='$LANE' AND m.role='user' ORDER BY m.\"createdAt\" DESC LIMIT 5"
    echo "== END SA0906B =="
    sudo touch "$MARKER_SA0906B"
  fi

  # ── ONE-SHOT (2026-09-06sa, prod): does ANY surface currently alert the owner about stopped spark-cluster schedules? (read-only) ──
  MARKER_SA0906=/var/tmp/.digby-sa0906
  if [ ! -f "$MARKER_SA0906" ]; then
    echo "== SA0906 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -25; }
    echo "--- spark-cluster CURRENT digest row: summary + attention + eta ---"
    q "SELECT to_char(d.\"updatedAt\",'MM-DD HH24:MI'), coalesce(d.\"etaSummary\"->>'class','-'), jsonb_array_length(coalesce(d.\"attentionItems\",'[]'::jsonb)), left(regexp_replace(d.summary,'[[:space:]]+',' ','g'),200) FROM project_digests d JOIN crossmodel_projects p ON p.id=d.\"projectId\" WHERE p.name ILIKE '%spark%' AND d.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') LIMIT 2"
    q "SELECT jsonb_pretty(d.\"attentionItems\") FROM project_digests d JOIN crossmodel_projects p ON p.id=d.\"projectId\" WHERE p.name ILIKE '%spark%' AND d.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') LIMIT 1"
    echo "--- spark project unfinished goals + its schedules ---"
    q "SELECT g.status, left(g.title,50), (SELECT count(*) FROM project_todos t WHERE t.\"goalId\"=g.id AND t.status!='done') FROM project_goals g JOIN crossmodel_projects p ON p.id=g.\"projectId\" WHERE p.name ILIKE '%spark%' LIMIT 5"
    echo "--- pending owner decisions queue (the #624 feature) ---"
    q "SELECT left(id::text,8), status, to_char(\"updatedAt\",'MM-DD HH24:MI'), left(title,90) FROM user_feature_requests WHERE type='owner_question' OR title ILIKE '%decision%' OR title ILIKE '%restart%' ORDER BY \"updatedAt\" DESC LIMIT 6"
    echo "--- flagged owner questions table (if separate) — grep schema ---"
    q "SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%decision%' OR table_name ILIKE '%owner%' LIMIT 5"
    echo "== END SA0906 =="
    sudo touch "$MARKER_SA0906"
  fi

  # ── ONE-SHOT (2026-09-06f2, prod): FH0906 retry — GROUP BY raw expressions (read-only). ──
  MARKER_FH0906B=/var/tmp/.digby-fh0906b
  if [ ! -f "$MARKER_FH0906B" ]; then
    echo "== FH0906B host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -30; }
    echo "--- citationRetry outcomes since 09-04 ---"
    q "SELECT coalesce(meta->>'citationRetry','(other strike)') AS o, count(*) FROM loop_metrics WHERE kind='guard_strike' AND \"createdAt\" > '2026-09-04T16:00Z' GROUP BY o"
    echo "--- chat search usage by mode ---"
    q "SELECT meta->>'mode' AS m, ((meta->>'webToolCalls')::int > 0) AS searched, count(*) FROM loop_metrics WHERE kind='chat_search_usage' GROUP BY m, searched ORDER BY m"
    echo "--- supervisor assistant notes per day, struck vs clean, 4d ---"
    q "SELECT to_char(date_trunc('day', m.\"createdAt\"),'MM-DD') AS d, (m.content LIKE '[ACTION VERIFIER%') AS struck, count(*) FROM crossmodel_messages m WHERE m.\"chatId\"='c0e22e36-1c74-4295-8049-9b48335c6c37' AND m.role='assistant' AND m.\"createdAt\" > now() - interval '4 days' GROUP BY d, struck ORDER BY d, struck"
    echo "--- owner runs by status 48h ---"
    q "SELECT r.status AS st, count(*) FROM agent_runs r JOIN crossmodel_chats c ON c.id=r.\"sessionId\" WHERE c.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') AND r.\"updatedAt\" > now() - interval '48 hours' GROUP BY st"
    echo "--- goals by status ---"
    q "SELECT g.status AS st, count(*) FROM project_goals g GROUP BY st"
    echo "--- canlaw/kernel/tenstorrent/post-cpt schedules ---"
    q "SELECT left(c.title,38), s.enabled, coalesce(s.\"lastStatus\",'-'), s.\"runsCount\" FROM coding_schedules s JOIN crossmodel_chats c ON c.id=s.\"sessionId\" WHERE c.title ILIKE ANY(ARRAY['%canlaw%','%kernel%','%tenstorrent%','%post-cpt%']) ORDER BY c.\"updatedAt\" DESC LIMIT 8"
    echo "--- p0 ticket detail ---"
    q "SELECT left(id::text,8), status, to_char(\"updatedAt\",'MM-DD HH24:MI'), left(coalesce(\"adminNote\",'-'),120) FROM user_feature_requests WHERE title LIKE 'goal_list/todo_list%' LIMIT 2"
    echo "== END FH0906B =="
    sudo touch "$MARKER_FH0906B"
  fi

  # ── ONE-SHOT (2026-09-06fh, prod): fleet health review — telemetry, supervisor, sessions, tickets, goals, schedules (read-only). ──
  MARKER_FH0906=/var/tmp/.digby-fh0906
  if [ ! -f "$MARKER_FH0906" ]; then
    echo "== FH0906 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -30; }
    echo "--- loop_metrics since 09-04: kind counts ---"
    q "SELECT kind||' : '||count(*) FROM loop_metrics WHERE \"createdAt\" > '2026-09-04T16:00Z' GROUP BY kind ORDER BY count(*) DESC LIMIT 15"
    echo "--- guard strikes: citationRetry outcomes since 09-04 ---"
    q "SELECT coalesce(meta->>'citationRetry','-')||' : '||count(*) FROM loop_metrics WHERE kind='guard_strike' AND \"createdAt\" > '2026-09-04T16:00Z' GROUP BY 1"
    echo "--- chat search usage: searched vs not, by mode ---"
    q "SELECT (meta->>'mode')||' searched='||((meta->>'webToolCalls')::int > 0)::text||' : '||count(*) FROM loop_metrics WHERE kind='chat_search_usage' AND \"createdAt\" > '2026-09-03T16:00Z' GROUP BY 1,2 ORDER BY 1"
    echo "--- supervisor wakes/day (assistant machine notes) last 3d ---"
    q "SELECT to_char(date_trunc('day', m.\"createdAt\"),'MM-DD')||' : '||count(*) FROM crossmodel_messages m WHERE m.\"chatId\"='c0e22e36-1c74-4295-8049-9b48335c6c37' AND m.role='assistant' AND m.\"createdAt\" > now() - interval '3 days' GROUP BY 1 ORDER BY 1"
    echo "--- supervisor struck-note rate last 48h vs prior 48h ---"
    q "SELECT (m.\"createdAt\" > now() - interval '48 hours')::text||' struck='||(m.content LIKE '[ACTION VERIFIER%')::text||' : '||count(*) FROM crossmodel_messages m WHERE m.\"chatId\"='c0e22e36-1c74-4295-8049-9b48335c6c37' AND m.role='assistant' AND m.\"createdAt\" > now() - interval '96 hours' GROUP BY 1,2 ORDER BY 1,2"
    echo "--- failed/stalled runs 48h (fleet-wide, owner) ---"
    q "SELECT r.status||' : '||count(*) FROM agent_runs r JOIN crossmodel_chats c ON c.id=r.\"sessionId\" WHERE c.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') AND r.\"updatedAt\" > now() - interval '48 hours' GROUP BY 1"
    echo "--- open/in_progress tickets ---"
    q "SELECT status||' p'||priority||' | '||left(title,80) FROM user_feature_requests WHERE status IN ('open','in_progress') ORDER BY priority DESC, \"updatedAt\" DESC LIMIT 12"
    echo "--- goals: status counts + blocked titles ---"
    q "SELECT g.status||' : '||count(*) FROM project_goals g GROUP BY 1"
    q "SELECT left(g.title,60)||' | blocked_todos='||(SELECT count(*) FROM project_todos t WHERE t.\"goalId\"=g.id AND t.status='blocked') FROM project_goals g WHERE g.status='blocked' LIMIT 6"
    echo "--- enabled schedules now vs the 09-04 stopped ones (canlaw/spark/tt) ---"
    q "SELECT count(*)||' enabled total' FROM coding_schedules WHERE enabled AND \"userId\"=(SELECT id FROM users WHERE email='example-user@example.com')"
    q "SELECT left(c.title,40)||' | enabled='||s.enabled||' | last='||coalesce(s.\"lastStatus\",'-')||' runs='||s.\"runsCount\" FROM coding_schedules s JOIN crossmodel_chats c ON c.id=s.\"sessionId\" WHERE c.title ILIKE ANY(ARRAY['%canlaw%','%kernel%','%tenstorrent%','%post-cpt%']) ORDER BY s.\"updatedAt\" DESC LIMIT 8"
    echo "--- briefings landing? last 3 owner_briefing rows ---"
    q "SELECT to_char(m.\"createdAt\",'MM-DD HH24:MI')||' | '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),100) FROM crossmodel_messages m WHERE m.\"chatId\"='c0e22e36-1c74-4295-8049-9b48335c6c37' AND m.metadata->>'kind'='owner_briefing' ORDER BY m.\"createdAt\" DESC LIMIT 3"
    echo "== END FH0906 =="
    sudo touch "$MARKER_FH0906"
  fi

  # ── ONE-SHOT (2026-09-04v3, prod): digest-pipeline health — cron state, worker logs, owner pulse rows (read-only). ──
  MARKER_VF0904C=/var/tmp/.digby-vf0904c
  if [ ! -f "$MARKER_VF0904C" ]; then
    echo "== VF0904C host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -25; }
    echo "--- cron row now ---"
    q "SELECT id||' next='||to_char(\"nextRunAt\",'HH24:MI:SS')||' lastFired='||coalesce(to_char(\"lastFiredAt\",'MM-DD HH24:MI'),'-')||' status='||coalesce(\"lastStatus\",'-')||' lease='||coalesce(to_char(\"leaseExpiresAt\",'HH24:MI:SS'),'-')||' worker='||coalesce(\"workerId\",'-') FROM cron_jobs WHERE id='project-digest'"
    echo "--- worker digest log lines (blue+green, last 600) ---"
    for CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker'); do
      echo "· $CN"; sudo docker logs "$CN" --tail 600 2>&1 | grep -iE 'project-digest|digest sweep|projectDigest' | tail -8
    done
    echo "--- owner digest rows (updated | goals | eta | summary lead) ---"
    q "SELECT coalesce(p.name,'UNGROUPED')||' | upd='||to_char(d.\"updatedAt\",'MM-DD HH24:MI')||' | goals='||jsonb_array_length(coalesce(d.\"goalProgress\",'[]'::jsonb))||' | eta='||coalesce(d.\"etaSummary\"->>'class','-')||' | '||left(regexp_replace(d.summary,'[[:space:]]+',' ','g'),110) FROM project_digests d LEFT JOIN crossmodel_projects p ON p.id=d.\"projectId\" WHERE d.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') ORDER BY d.\"updatedAt\" DESC LIMIT 10"
    echo "== END VF0904C =="
    sudo touch "$MARKER_VF0904C"
  fi

  # ── ONE-SHOT (2026-09-04v2, prod): VF0904 retry — correct lease column (leaseExpiresAt). ──
  MARKER_VF0904B=/var/tmp/.digby-vf0904b
  if [ ! -f "$MARKER_VF0904B" ]; then
    echo "== VF0904B host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -10; }
    q "UPDATE cron_jobs SET \"nextRunAt\" = now() WHERE id='project-digest' AND (\"leaseExpiresAt\" IS NULL OR \"leaseExpiresAt\" < now()) RETURNING id||' fast-forwarded, next='||to_char(\"nextRunAt\",'HH24:MI:SS')"
    echo "== END VF0904B =="
    sudo touch "$MARKER_VF0904B"
  fi

  # ── ONE-SHOT (2026-09-04vf, prod): fast-forward the project-digest cron so the new PULSE fields generate now (single UPDATE via the framework's own lease mechanics). ──
  MARKER_VF0904=/var/tmp/.digby-vf0904
  if [ ! -f "$MARKER_VF0904" ]; then
    echo "== VF0904 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -10; }
    echo "--- cron row before ---"
    q "SELECT id||' next='||to_char(\"nextRunAt\",'HH24:MI:SS')||' lease='||coalesce(to_char(\"leaseUntil\",'HH24:MI:SS'),'-') FROM cron_jobs WHERE id='project-digest'"
    q "UPDATE cron_jobs SET \"nextRunAt\" = now() WHERE id='project-digest' AND (\"leaseUntil\" IS NULL OR \"leaseUntil\" < now()) RETURNING id||' fast-forwarded'"
    echo "== END VF0904 =="
    sudo touch "$MARKER_VF0904"
  fi

  # ── ONE-SHOT (2026-09-04q2, prod): QS0904 retry with correct column quoting (read-only). ──
  MARKER_QS0904B=/var/tmp/.digby-qs0904b
  if [ ! -f "$MARKER_QS0904B" ]; then
    echo "== QS0904B host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -40; }
    SUP="c0e22e36-1c74-4295-8049-9b48335c6c37"
    echo "--- supervisor messages last 4h (time | role | kind/origin | lead 120) ---"
    q "SELECT to_char(m.\"createdAt\",'HH24:MI:SS')||' | '||m.role||' | kind='||coalesce(m.metadata->>'kind','-')||'/'||coalesce(m.metadata->>'origin','-')||' | '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),120) FROM crossmodel_messages m WHERE m.\"chatId\"='$SUP' AND m.\"createdAt\" > now() - interval '4 hours' ORDER BY m.\"createdAt\" LIMIT 35"
    echo "--- pending_chat_messages for the supervisor ---"
    q "SELECT to_char(p.\"createdAt\",'HH24:MI:SS')||' | '||left(regexp_replace(p.content,'[[:space:]]+',' ','g'),110) FROM pending_chat_messages p WHERE p.\"chatId\"='$SUP' ORDER BY p.\"createdAt\" DESC LIMIT 8"
    echo "--- agent_runs for the supervisor last 4h ---"
    q "SELECT to_char(r.\"createdAt\",'HH24:MI:SS')||' -> '||to_char(r.\"updatedAt\",'HH24:MI:SS')||' | '||r.status||' | '||left(coalesce(r.error,'-'),70) FROM agent_runs r WHERE r.\"sessionId\"='$SUP' AND r.\"createdAt\" > now() - interval '4 hours' ORDER BY r.\"createdAt\" LIMIT 15"
    echo "== END QS0904B =="
    sudo touch "$MARKER_QS0904B"
  fi

  # ── ONE-SHOT (2026-09-04qs, prod): owner question to supervisor unanswered — message/run/queue forensics (read-only). ──
  MARKER_QS0904=/var/tmp/.digby-qs0904
  if [ ! -f "$MARKER_QS0904" ]; then
    echo "== QS0904 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -40; }
    SUP="c0e22e36-1c74-4295-8049-9b48335c6c37"
    echo "--- supervisor messages 14:30Z→now (role | machine meta | lead 130) ---"
    q "SELECT to_char(m."createdAt",'HH24:MI:SS')||' | '||m.role||' | kind='||coalesce(m.metadata->>'kind','-')||' origin='||coalesce(m.metadata->>'origin','-')||' machine='||coalesce(m.metadata->>'machineWake', m.metadata->>'machine','-')||' | '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),130) FROM crossmodel_messages m WHERE m."chatId"='$SUP' AND m."createdAt" > now() - interval '4 hours' ORDER BY m."createdAt" LIMIT 35"
    echo "--- pending_chat_messages for the supervisor (any state) ---"
    q "SELECT to_char("createdAt",'HH24:MI:SS')||' | '||left(regexp_replace(content,'[[:space:]]+',' ','g'),110) FROM pending_chat_messages WHERE "chatId"='$SUP' ORDER BY "createdAt" DESC LIMIT 8"
    echo "--- agent_runs for the supervisor last 4h ---"
    q "SELECT to_char("createdAt",'HH24:MI:SS')||' -> '||to_char("updatedAt",'HH24:MI:SS')||' | '||status||' | trigger='||coalesce("triggerKind", (metadata->>'triggerKind'), '-')||' | err='||left(coalesce(error,'-'),60) FROM agent_runs WHERE "sessionId"='$SUP' AND "createdAt" > now() - interval '4 hours' ORDER BY "createdAt" LIMIT 15"
    echo "== END QS0904 =="
    sudo touch "$MARKER_QS0904"
  fi

  # ── ONE-SHOT (2026-09-04b3, prod): release the two stale owner-briefing locks left by the pre-fix failed generations (fix bfe85926 is deployed; regeneration now runs on corrected utility legs). ──
  MARKER_BL0904C=/var/tmp/.digby-bl0904c
  if [ ! -f "$MARKER_BL0904C" ]; then
    echo "== BL0904C host=$(hostname) =="
    for K in $(sudo docker exec admin-redis-prod redis-cli --scan --pattern 'fleet:briefing:*' 2>/dev/null); do
      echo "DEL $K -> $(sudo docker exec admin-redis-prod redis-cli DEL "$K" 2>/dev/null)"
    done
    echo "== END BL0904C =="
    sudo touch "$MARKER_BL0904C"
  fi

  # ── ONE-SHOT (2026-09-04b2, prod): utilityChat leg failures around the empty briefings (read-only). ──
  MARKER_BL0904B=/var/tmp/.digby-bl0904b
  if [ ! -f "$MARKER_BL0904B" ]; then
    echo "== BL0904B host=$(hostname) =="
    for CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-backend'); do
      echo "--- $CN utilityChat lines (last 3000 log lines) ---"
      sudo docker logs "$CN" --tail 3000 2>&1 | grep -E 'utilityChat|utility-llm|dual-failure|noteUtility' | tail -20
    done
    echo "== END BL0904B =="
    sudo touch "$MARKER_BL0904B"
  fi

  # ── ONE-SHOT (2026-09-04bl, prod): owner-briefing generation failure logs + lock state (read-only). ──
  MARKER_BL0904=/var/tmp/.digby-bl0904
  if [ ! -f "$MARKER_BL0904" ]; then
    echo "== BL0904 host=$(hostname) =="
    for CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-backend|^admin-worker'); do
      echo "--- $CN briefing/bootstrap log lines (last 400 lines) ---"
      sudo docker logs "$CN" --tail 400 2>&1 | grep -iE 'briefing' | tail -12
    done
    echo "--- redis briefing locks ---"
    sudo docker exec admin-redis-prod redis-cli --scan --pattern 'fleet:briefing:*' 2>/dev/null | head -5
    for K in $(sudo docker exec admin-redis-prod redis-cli --scan --pattern 'fleet:briefing:*' 2>/dev/null | head -3); do
      echo "$K ttl=$(sudo docker exec admin-redis-prod redis-cli PTTL "$K" 2>/dev/null)"
    done
    echo "== END BL0904 =="
    sudo touch "$MARKER_BL0904"
  fi

  # ── ONE-SHOT (2026-09-04cv, prod): verifier-strike root cause — struck notes' cited ids existence-checked across ALL id tables (read-only). ──
  MARKER_CV0904=/var/tmp/.digby-cv0904
  if [ ! -f "$MARKER_CV0904" ]; then
    echo "== CV0904 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -60; }
    echo "--- last 2 STRUCK supervisor notes (lead 1100 chars each) ---"
    q "SELECT to_char(m.\"createdAt\",'MM-DD HH24:MI')||' ||| '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),1100) FROM crossmodel_messages m JOIN crossmodel_chats c ON c.id=m.\"chatId\" WHERE c.\"isSupervisor\" AND c.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') AND m.role='assistant' AND m.content LIKE '[ACTION VERIFIER%' ORDER BY m.\"createdAt\" DESC LIMIT 2"
    echo "--- every 8-hex prefix cited in those notes, existence-checked per table ---"
    q "WITH notes AS (SELECT m.content FROM crossmodel_messages m JOIN crossmodel_chats c ON c.id=m.\"chatId\" WHERE c.\"isSupervisor\" AND c.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') AND m.role='assistant' AND m.content LIKE '[ACTION VERIFIER%' ORDER BY m.\"createdAt\" DESC LIMIT 2), ids AS (SELECT DISTINCT lower((regexp_matches(content,'([0-9a-fA-F]{8})','g'))[1]) AS p FROM notes) SELECT p, EXISTS(SELECT 1 FROM crossmodel_messages x WHERE x.id::text LIKE p||'%') AS cm_msg, EXISTS(SELECT 1 FROM coding_messages y WHERE y.id::text LIKE p||'%') AS coding_msg, EXISTS(SELECT 1 FROM crossmodel_chats z WHERE z.id::text LIKE p||'%') AS chat, EXISTS(SELECT 1 FROM coding_schedules s2 WHERE s2.id::text LIKE p||'%') AS sched, EXISTS(SELECT 1 FROM agent_runs r WHERE r.id::text LIKE p||'%') AS run, EXISTS(SELECT 1 FROM event_hooks h WHERE h.id::text LIKE p||'%') AS hook FROM ids ORDER BY p LIMIT 40"
    echo "--- supervisor wakes last 24h: count per hour ---"
    q "SELECT to_char(date_trunc('hour', m.\"createdAt\"),'MM-DD HH24')||'h: '||count(*) FROM crossmodel_messages m JOIN crossmodel_chats c ON c.id=m.\"chatId\" WHERE c.\"isSupervisor\" AND c.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') AND m.role='assistant' AND m.\"createdAt\" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1"
    echo "--- open/in-progress tickets on the verifier class (avoid duplicating a lane) ---"
    q "SELECT left(id::text,8)||' '||status||' p'||priority||' | '||left(title,95) FROM user_feature_requests WHERE status IN ('open','in_progress') AND (title ILIKE '%verifier%' OR title ILIKE '%phantom%' OR title ILIKE '%citation%' OR title ILIKE '%evidence%' OR title ILIKE '%strike%' OR title ILIKE '%struck%') ORDER BY \"updatedAt\" DESC LIMIT 10"
    echo "== END CV0904 =="
    sudo touch "$MARKER_CV0904"
  fi

  # ── ONE-SHOT (2026-09-04mn, prod): owner dashboard triage — schedule counts + latest supervisor notes (read-only). ──
  MARKER_MN0904=/var/tmp/.digby-mn0904
  if [ ! -f "$MARKER_MN0904" ]; then
    echo "== MN0904 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -30; }
    echo "--- owner schedule counts (enabled vs not) ---"
    q "SELECT s.enabled, count(*) FROM coding_schedules s WHERE s.\"userId\" = (SELECT id FROM users WHERE email='example-user@example.com') GROUP BY s.enabled"
    echo "--- owner newest 6 ENABLED schedules (proof of life) ---"
    q "SELECT left(s.id::text,8)||' every='||coalesce((s.\"intervalSec\"/60)::text,'-')||'m next='||to_char(s.\"nextRunAt\",'MM-DD HH24:MI')||' | '||left(c.title,50) FROM coding_schedules s JOIN crossmodel_chats c ON c.id=s.\"sessionId\" WHERE s.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') AND s.enabled ORDER BY s.\"nextRunAt\" LIMIT 6"
    echo "--- owner supervisor: last 4 assistant machine notes (lead 160 chars) ---"
    q "SELECT to_char(m.\"createdAt\",'MM-DD HH24:MI')||' :: '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),160) FROM crossmodel_messages m WHERE m.\"chatId\"='c0e22e36-0000-0000-0000-000000000000' AND m.role='assistant' ORDER BY m.\"createdAt\" DESC LIMIT 4"
    q "SELECT to_char(m.\"createdAt\",'MM-DD HH24:MI')||' :: '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),160) FROM crossmodel_messages m JOIN crossmodel_chats c ON c.id=m.\"chatId\" WHERE c.\"isSupervisor\" AND c.\"userId\"=(SELECT id FROM users WHERE email='example-user@example.com') AND m.role='assistant' ORDER BY m.\"createdAt\" DESC LIMIT 4"
    echo "== END MN0904 =="
    sudo touch "$MARKER_MN0904"
  fi

  # ── ONE-SHOT (2026-09-03fs, prod): fleet-overlap scan before the GLM-5.3/vision/checker wave lands (read-only). ──
  MARKER_FS0903=/var/tmp/.digby-fs0903
  if [ ! -f "$MARKER_FS0903" ]; then
    echo "== FS0903 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -40; }
    echo "--- active/queued agent runs (36h) ---"
    q "SELECT left(r.id::text,8)||' '||r.status||' upd='||to_char(r.\"updatedAt\",'MM-DD HH24:MI')||' trig='||coalesce(r.\"triggerKind\",'-')||' | '||left(c.title,70) FROM agent_runs r JOIN crossmodel_chats c ON c.id=r.\"sessionId\" WHERE r.status IN ('running','queued','waiting_approval') OR (r.\"updatedAt\" > now() - interval '36 hours' AND r.status='running') ORDER BY r.\"updatedAt\" DESC LIMIT 25"
    echo "--- enabled schedules (next fires) ---"
    q "SELECT left(s.id::text,8)||' every='||coalesce((s.\"intervalSec\"/60)::text,'-')||'m next='||to_char(s.\"nextRunAt\",'MM-DD HH24:MI')||' | '||left(c.title,60)||' | '||left(regexp_replace(s.prompt,'[[:space:]]+',' ','g'),80) FROM coding_schedules s JOIN crossmodel_chats c ON c.id=s.\"sessionId\" WHERE s.enabled ORDER BY s.\"nextRunAt\" LIMIT 25"
    echo "--- chats touching wave topics (48h activity) ---"
    q "SELECT left(id::text,8)||' upd='||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(title,80) FROM crossmodel_chats WHERE \"updatedAt\" > now() - interval '48 hours' AND (title ILIKE '%glm%' OR title ILIKE '%vision%' OR title ILIKE '%image%' OR title ILIKE '%heic%' OR title ILIKE '%checker%' OR title ILIKE '%fact-check%' OR title ILIKE '%web search%' OR title ILIKE '%serp%' OR title ILIKE '%deepseek%' OR title ILIKE '%model swap%' OR title ILIKE '%5.3%') ORDER BY \"updatedAt\" DESC LIMIT 20"
    echo "--- open feedback tickets on wave topics ---"
    q "SELECT left(id::text,8)||' '||status||' p'||priority||' | '||left(title,90) FROM user_feature_requests WHERE status IN ('open','in_progress') AND (title ILIKE '%glm%' OR title ILIKE '%vision%' OR title ILIKE '%image%' OR title ILIKE '%checker%' OR title ILIKE '%search%' OR title ILIKE '%deepseek%' OR title ILIKE '%model%') ORDER BY \"updatedAt\" DESC LIMIT 15"
    echo "== END FS0903 =="
    sudo touch "$MARKER_FS0903"
  fi

  # ── ONE-SHOT (2026-09-03mp, prod): model probes for the GLM-5.3 / DeepSeek-max / vision wave (read-only API calls, no state changes). ──
  MARKER_MP0903=/var/tmp/.digby-mp0903
  if [ ! -f "$MARKER_MP0903" ]; then
    echo "== MP0903 host=$(hostname) =="
    ZK=$(sudo grep -m1 '^ZAI_API_KEY=' /opt/crossmodel/.env | cut -d= -f2-)
    DK=$(sudo grep -m1 '^DEEPSEEK_API_KEY=' /opt/crossmodel/.env | cut -d= -f2-)
    echo "--- P1: glm-5.3 stream, thinking enabled + reasoning_effort max (param accept + reasoning shape) ---"
    curl -sS --max-time 90 -N https://api.z.ai/api/paas/v4/chat/completions \
      -H "Authorization: Bearer $ZK" -H 'Content-Type: application/json' \
      -d '{"model":"glm-5.3","stream":true,"thinking":{"type":"enabled"},"reasoning_effort":"max","max_tokens":512,"messages":[{"role":"user","content":"In one word: what is the capital of France?"}]}' \
      2>&1 | head -30
    echo ""
    echo "--- P2: glm-5.3-flash vision accept (1x1 png data uri; an image-format 400 still proves the param shape) ---"
    curl -sS --max-time 60 https://api.z.ai/api/paas/v4/chat/completions \
      -H "Authorization: Bearer $ZK" -H 'Content-Type: application/json' \
      -d '{"model":"glm-5.3-flash","max_tokens":100,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}},{"type":"text","text":"What color is this image? One word."}]}]}' \
      2>&1 | head -8
    echo ""
    echo "--- P3: deepseek models list (dated snapshot ids) ---"
    curl -sS --max-time 30 https://api.deepseek.com/models -H "Authorization: Bearer $DK" 2>&1 | head -6
    echo ""
    echo "--- P4: deepseek-v4-pro reasoning_effort max accept (stream, tiny) ---"
    curl -sS --max-time 90 -N https://api.deepseek.com/chat/completions \
      -H "Authorization: Bearer $DK" -H 'Content-Type: application/json' \
      -d '{"model":"deepseek-v4-pro","stream":true,"reasoning_effort":"max","thinking":{"type":"enabled"},"max_tokens":64,"messages":[{"role":"user","content":"2+2? One word."}]}' \
      2>&1 | head -20
    echo "== END MP0903 =="
    sudo touch "$MARKER_MP0903"
  fi

  # ── ONE-SHOT (2026-09-02hs2, prod): find + read the hourly-summary chat, both message tables (read-only). ──
  MARKER_HS0902B=/var/tmp/.digby-hs0902b
  if [ ! -f "$MARKER_HS0902B" ]; then
    echo "== HS0902B host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -40; }
    echo "--- candidate chats (hourly/summary/live, 14d) ---"
    q "SELECT left(id::text,8)||' | mode='||mode||' | upd='||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(title,60) FROM crossmodel_chats WHERE (title ILIKE '%hourly%' OR title ILIKE '%summary%live%' OR title ILIKE '%live project%') AND \"updatedAt\" > now() - interval '14 days' ORDER BY \"updatedAt\" DESC LIMIT 8"
    echo "--- for the newest match: satellite + schedule ---"
    q "SELECT left(cs.id::text,8)||' coding_status='||cs.status FROM coding_sessions cs WHERE cs.id = (SELECT id FROM crossmodel_chats WHERE title ILIKE '%hourly%' ORDER BY \"updatedAt\" DESC LIMIT 1)"
    q "SELECT left(id::text,8)||' every='||coalesce((\"intervalSec\"/60)::text,'-')||'m enabled='||enabled||' last='||coalesce(\"lastStatus\",'-') FROM coding_schedules WHERE \"sessionId\" = (SELECT id FROM crossmodel_chats WHERE title ILIKE '%hourly%' ORDER BY \"updatedAt\" DESC LIMIT 1)"
    echo "--- plain msgs (newest 8) ---"
    q "SELECT to_char(m.\"createdAt\",'MM-DD HH24:MI')||' '||m.role||' len='||length(m.content)||' parts='||(m.parts IS NOT NULL)::text||' :: '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),240) FROM crossmodel_messages m WHERE m.\"chatId\" = (SELECT id FROM crossmodel_chats WHERE title ILIKE '%hourly%' ORDER BY \"updatedAt\" DESC LIMIT 1) ORDER BY m.\"createdAt\" DESC LIMIT 8"
    echo "--- coding msgs (newest 8) ---"
    q "SELECT to_char(m.\"createdAt\",'MM-DD HH24:MI')||' '||m.role||' len='||length(m.content)||' parts='||(m.parts IS NOT NULL)::text||' :: '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),240) FROM coding_messages m WHERE m.\"sessionId\" = (SELECT id FROM crossmodel_chats WHERE title ILIKE '%hourly%' ORDER BY \"updatedAt\" DESC LIMIT 1) ORDER BY m.\"createdAt\" DESC LIMIT 8"
    echo "--- newest assistant TAIL 700 (whichever table has it) ---"
    q "SELECT right(regexp_replace(content,'[[:space:]]+',' ','g'),700) FROM crossmodel_messages WHERE \"chatId\" = (SELECT id FROM crossmodel_chats WHERE title ILIKE '%hourly%' ORDER BY \"updatedAt\" DESC LIMIT 1) AND role='assistant' ORDER BY \"createdAt\" DESC LIMIT 1"
    q "SELECT right(regexp_replace(content,'[[:space:]]+',' ','g'),700) FROM coding_messages WHERE \"sessionId\" = (SELECT id FROM crossmodel_chats WHERE title ILIKE '%hourly%' ORDER BY \"updatedAt\" DESC LIMIT 1) AND role='assistant' ORDER BY \"createdAt\" DESC LIMIT 1"
    echo "--- recent runs ---"
    q "SELECT left(id::text,8)||' '||status||' upd='||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(coalesce(error,'-'),60) FROM agent_runs WHERE \"sessionId\" = (SELECT id FROM crossmodel_chats WHERE title ILIKE '%hourly%' ORDER BY \"updatedAt\" DESC LIMIT 1) ORDER BY \"createdAt\" DESC LIMIT 5"
    echo "== END HS0902B =="
    sudo touch "$MARKER_HS0902B"
  fi




  # ── ONE-SHOT (2026-09-02vp, prod): verify A worker stayed cron-only after the env_override mixup (read-only). ──
  MARKER_VP0902=/var/tmp/.digby-vp0902
  if [ ! -f "$MARKER_VP0902" ]; then
    echo "== VP0902-A host=$(hostname) =="
    W=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    echo "worker=$W"
    [ -n "$W" ] && sudo docker exec "$W" sh -c 'echo "CONCURRENCY=${CODING_WORKER_CONCURRENCY:-unset}"'
    sudo grep -E '^(CODING_WORKER_CONCURRENCY|VERIFY_GATE_CONCURRENCY)=' /opt/crossmodel-local/env-overrides.env
    echo "== END VP0902-A =="
    sudo touch "$MARKER_VP0902"
  fi


  # ── ONE-SHOT (2026-08-31a, prod): deep-audit live probe — tickets, run stats, supervisor volume (read-only). ──
  MARKER_FW31A=/var/tmp/.digby-fw31a-20260831a
  if [ ! -f "$MARKER_FW31A" ]; then
    echo "== FW31-A host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -22; }
    echo "--- tickets by status ---"
    q "SELECT status||': '||count(*) FROM user_feature_requests GROUP BY status ORDER BY status"
    echo "--- open + in_progress ---"
    q "SELECT left(id::text,8)||' '||status||' p'||priority||' upd='||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(title,58) FROM user_feature_requests WHERE status IN ('open','in_progress') ORDER BY status, \"updatedAt\" DESC LIMIT 18"
    echo "--- run throughput (24h) ---"
    q "SELECT status||': '||count(*) FROM agent_runs WHERE \"createdAt\" > now() - interval '24 hours' GROUP BY status"
    q "SELECT 'avg_run_min: '||round(avg(extract(epoch from (\"finishedAt\"-\"startedAt\"))/60)::numeric,1)||'  p95_min: '||round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from (\"finishedAt\"-\"startedAt\"))))::numeric/60,1) FROM agent_runs WHERE status='completed' AND \"finishedAt\" > now() - interval '24 hours' AND \"startedAt\" IS NOT NULL"
    q "SELECT 'retried_runs_24h: '||count(*) FROM agent_runs WHERE attempts > 1 AND \"updatedAt\" > now() - interval '24 hours'"
    q "SELECT 'queued_now: '||count(*)||'  oldest_s: '||coalesce(extract(epoch from (now()-min(\"createdAt\")))::int::text,'-') FROM agent_runs WHERE status='queued'"
    echo "--- supervisor wake volume (24h) ---"
    q "SELECT 'supervisor_msgs_24h: '||count(*) FROM crossmodel_messages WHERE \"chatId\"::text LIKE 'c0e22e36%' AND \"createdAt\" > now() - interval '24 hours'"
    echo "--- schedules firing (enabled) ---"
    q "SELECT count(*)||' enabled, firings_24h_sum='||coalesce(sum(CASE WHEN \"lastFiredAt\" > now() - interval '24 hours' THEN 1 ELSE 0 END),0) FROM coding_schedules WHERE enabled"
    echo "--- failed runs (24h) with errors ---"
    q "SELECT left(\"sessionId\"::text,8)||' '||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(coalesce(error,'-'),70) FROM agent_runs WHERE status='failed' AND \"updatedAt\" > now() - interval '24 hours' ORDER BY \"updatedAt\" DESC LIMIT 8"
    echo "== END FW31-A =="
    sudo touch "$MARKER_FW31A"
  fi

  # ── FIRED 2026-08-30 (FW30-B, prod): closed ticket 71b1fec6 (C3 complete +
  # prod-smoked UPDATE on user_feature_requests). One-shot ran in run 33281845402;
  # marker /var/tmp/.digby-fw30b-20260830b on prod. Reset to this read-only note —
  # full block recoverable from git history (commit 16b28d37 era).

  # ── FIRED 2026-08-31 (FW31, prod): closed ticket 2c15e65a (clock-discipline
  #    TRUE POSITIVE — status=done + verbatim adminNote, note_len 1003) on the
  #    LIVE store. One-shot ran in dispatch run 33371706801 (08:11Z); re-verified
  #    in run 33461057318 (2026-09-01 02:03Z): marker no-op, ticket still done,
  #    sibling e3246ad5 untouched by FW31 (independently closed 11:22Z).
  #    Marker /var/tmp/.digby-close-2c15e65a-20260831 on prod. Reset to this
  #    read-only note — full block recoverable from git history (commit 21872039).



  # ── ONE-SHOT (2026-07-31): RESTORE THE PROD WORKER. The phase-5 "worker
  #    handoff" (07-30 ~04:20Z, run from a coding session via SSM: "stop old
  #    worker → arm A's flag → start A's worker") stopped THIS box's worker —
  #    but DNS was never flipped, so this box is still the real production.
  #    Every coding run since then sat unclaimed (owner: sessions spinning all
  #    day, transcripts replaying). Fix: flip ENABLE_WORKER back on in the
  #    deploy-flags (so subsequent deploys keep the worker) and start the
  #    active color's worker container now. Marker in /var/tmp. ──
  MARKER_WH=/var/tmp/.digby-worker-restore-20260731
  if [ ! -f "$MARKER_WH" ]; then
    echo "--- worker-restore: state before ---"
    echo "  deploy-flags: $(sudo cat /opt/crossmodel-local/deploy-flags.env 2>/dev/null | tr '\n' ' ' || echo '(absent)')"
    sudo docker ps -a --format '  {{.Names}}\t{{.Status}}\t(restart={{.Label "com.docker.compose.project"}})' | grep -E 'admin-worker' || echo "  (no worker containers exist)"
    AC=$(cat .active-color 2>/dev/null || echo blue)
    echo "  active color: $AC"
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db -t -A -F'|' --no-psqlrc \
      -c "SELECT status, count(*) FROM agent_runs GROUP BY status ORDER BY status;" | sed 's/^/  runs(before): /'
    echo "--- worker-restore: fix ---"
    if sudo grep -q '^ENABLE_WORKER=' /opt/crossmodel-local/deploy-flags.env 2>/dev/null; then
      sudo sed -i 's/^ENABLE_WORKER=.*/ENABLE_WORKER=true/' /opt/crossmodel-local/deploy-flags.env
      echo "  deploy-flags now: $(sudo cat /opt/crossmodel-local/deploy-flags.env | tr '\n' ' ')"
    else
      echo "  (no ENABLE_WORKER line in deploy-flags — default true, nothing to flip)"
    fi
    if sudo docker ps -a --format '{{.Names}}' | grep -q "^admin-worker-${AC}$"; then
      sudo docker update --restart unless-stopped "admin-worker-${AC}" >/dev/null 2>&1 || true
      sudo docker start "admin-worker-${AC}" && echo "  started admin-worker-${AC}"
    else
      echo "  admin-worker-${AC} missing — compose up (no build)"
      if [ "$AC" = "blue" ]; then P=4001; F=8248; else P=4002; F=8249; fi
      sudo BG_COLOR="$AC" BG_PORT_BACKEND="$P" BG_PORT_FRONTEND="$F" \
        docker compose -p "crossmodel_${AC}" -f docker-compose.app.yml up -d --no-build worker 2>&1 | tail -2
    fi
    sleep 35
    echo "--- worker-restore: verify ---"
    sudo docker ps --format '  {{.Names}}\t{{.Status}}' | grep admin-worker || echo "  ❌ WORKER STILL NOT RUNNING"
    sudo docker logs "admin-worker-${AC}" --tail 10 2>&1 | sed 's/^/  /'
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db -t -A -F'|' --no-psqlrc \
      -c "SELECT status, count(*) FROM agent_runs GROUP BY status ORDER BY status;" | sed 's/^/  runs(after): /'
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db -t -A -F'|' --no-psqlrc \
      -c "SELECT left(id,8), status, attempts, round(extract(epoch FROM (now()-\"heartbeatAt\"))) AS hb_age_s FROM agent_runs WHERE status IN ('queued','running','interrupted') ORDER BY \"createdAt\" LIMIT 15;" | sed 's/^/  inflight: /'
    sudo touch "$MARKER_WH"
  else
    echo "  worker-restore one-shot: already done"
    sudo docker ps --format '  {{.Names}}\t{{.Status}}' | grep admin-worker || echo "  (worker not running)"
  fi

  # ── ONE-SHOT (2026-07-31c): CUTOVER FINISHER — stop the OLD prod worker.
  #    digby.ai+www now resolve to the ca-central-1 ALB (flipped 2026-07-31
  #    10:05Z; live E2E on the real domain green) and Montreal A's worker is
  #    live+healthy on the freshly re-synced DB. Deliberately OUT-OF-BAND
  #    (postmortem #122): the GH Actions runner is not a child of any worker,
  #    so stopping this worker cannot decapitate the driving coding session
  #    (its run re-claims on A via #124 freshness healing). Web containers are
  #    intentionally LEFT RUNNING for the DNS propagation window — stragglers
  #    still get served (accepted write-loss per runbook); they are stopped
  #    separately after propagation. Also pins ENABLE_WORKER=false so no
  #    future manual deploy on this box revives a second worker. Marker in
  #    /var/tmp. ──
  MARKER_CF=/var/tmp/.digby-cutover-finisher-20260731
  if [ ! -f "$MARKER_CF" ]; then
    echo "== cutover finisher: stop old prod worker =="
    AC=$(cat .active-color 2>/dev/null || echo blue)
    echo "  active color: $AC"
    sudo docker ps --format '  {{.Names}}\t{{.Status}}' | grep -E 'admin-(worker|backend|frontend)' || true
    sudo docker stop "admin-worker-$AC" && echo "  STOPPED admin-worker-$AC — single worker now: ca-central-1 A (admin-worker-green)"
    if sudo grep -q '^ENABLE_WORKER=' /opt/crossmodel-local/deploy-flags.env 2>/dev/null; then
      sudo sed -i 's/^ENABLE_WORKER=.*/ENABLE_WORKER=false/' /opt/crossmodel-local/deploy-flags.env
      echo "  deploy-flags pinned: $(sudo cat /opt/crossmodel-local/deploy-flags.env | tr '\n' ' ')"
    fi
    echo "--- verify: no worker left running on this box ---"
    sudo docker ps --format '  {{.Names}}\t{{.Status}}' | grep admin-worker || echo "  OK: no worker running on old prod"
    sudo touch "$MARKER_CF"
  else
    echo "  cutover-finisher one-shot: already done"
    sudo docker ps --format '  {{.Names}}\t{{.Status}}' | grep admin-worker || echo "  (no worker running)"
  fi

  # ── ONE-SHOT (2026-07-31d): CUTOVER FINISHER R2 — the 10:31Z healthcheck
  #    (new worker-liveness probe still pointing at this box via EC2_HOST)
  #    REVIVED this box's stack, including the worker the finisher had just
  #    stopped → double-worker for ~30 min. EC2_HOST has since been repointed
  #    to A (203.0.113.16) so the healthcheck now watches the new fleet. This
  #    block stops the old worker AGAIN and hard-pins ENABLE_WORKER=false
  #    (creating the flags file if absent — the r1 finisher's sed found no
  #    line to rewrite). Web containers stay UP (stragglers + instant
  #    rollback during soak). Out-of-band per postmortem #122. ──
  MARKER_CF2=/var/tmp/.digby-cutover-finisher-r2-20260731
  if [ ! -f "$MARKER_CF2" ]; then
    echo "== cutover finisher r2: stop old prod worker (again — healthcheck revived it) =="
    AC=$(cat .active-color 2>/dev/null || echo green)
    echo "  active color: $AC"
    for W in "admin-worker-$AC" admin-worker-blue admin-worker-green; do
      if sudo docker ps --format '{{.Names}}' | grep -q "^${W}$"; then
        sudo docker stop "$W" && echo "  STOPPED $W"
      fi
    done
    if sudo grep -q '^ENABLE_WORKER=' /opt/crossmodel-local/deploy-flags.env 2>/dev/null; then
      sudo sed -i 's/^ENABLE_WORKER=.*/ENABLE_WORKER=false/' /opt/crossmodel-local/deploy-flags.env
    else
      echo 'ENABLE_WORKER=false' | sudo tee -a /opt/crossmodel-local/deploy-flags.env >/dev/null
    fi
    echo "  deploy-flags now: $(sudo cat /opt/crossmodel-local/deploy-flags.env | tr '\n' ' ')"
    echo "--- verify: no worker running on this box ---"
    sudo docker ps --format '  {{.Names}}\t{{.Status}}' | grep admin-worker && echo "  ❌ WORKER STILL RUNNING" || echo "  OK: no worker running on old prod"
    sudo touch "$MARKER_CF2"
  else
    echo "  cutover-finisher-r2 one-shot: already done"
    sudo docker ps --format '  {{.Names}}\t{{.Status}}' | grep admin-worker || echo "  (no worker running)"
  fi

  # 2026-07-29 OUTAGE CLOSED (read-only note per playbook convention). digby.ai
  # was dark 23:00Z 07-28 → 02:05Z 07-29: the owner accidentally STOPPED prod
  # i-0123456789abcdef0 while terminating the retired dev box (stopped, not
  # terminated — data intact, EIP kept). After the owner started it, run
  # 30415821766's health-gated emergency block here did the software recovery:
  # admin-frontend-blue had Exited(255) on the cold boot; base-compose up +
  # docker restart of the blue color + nginx restart → frontend=200,
  # https://digby.ai=200 (02:05Z). Verified end-to-end from the web session:
  # authenticated register + open-source stream (init→search→synthesis→
  # complete). The full emergency block lives in git history at commit 4959d5d
  # — re-arm it (health-gated, not marker-guarded) for any future dark-box
  # incident.
  # Prod stays read-only by default. App/code/schema changes go through the normal
  # deploy (push to main → deploy.yml), NOT here.
  # 2026-06-22: a one-off applied the `imessage_agents` migration (iMessage bridge).

  # 2026-06-25: Slack + Asana + Telegram integrations ACTIVATED here (run 28177278802).
  #   - migrations 20260625000000 (slack/asana, drops indeed) + 20260625000001 (telegram)
  #     applied (deploy ran them; verified "No pending migrations" + tables present).
  #   - slack-mcp-prod + asana-mcp-prod built & started via docker compose base.
  # The mutating one-off block was reset to this read-only verification (the full
  # migrate+build block lives in git history at commit 4fff601). Integrations still
  # need their OAuth/bot secrets set to function.
  # 2026-06-26: Slack + Asana + Telegram are now LIVE in prod (deploy ba1cd22 wrote
  # all OAuth/bot secrets into /opt/crossmodel/.env; /slack|asana|telegram/status all
  # return configured:true; both OAuth /auth endpoints redirect to valid provider
  # authorize URLs). The earlier "Container slack-mcp-prod ... No such container:
  # <id>_slack-mcp-prod" deploy failure was a docker-compose rename-artifact orphan,
  # left by a recreate that collided with a concurrent deploy. It self-cleared, and
  # deploy-blue-green.sh now force-removes such artifacts before the base `up` (+ re-
  # seeds .active-color when missing so rollback can always recover) so it can't recur.
  # The mutating force-recreate block is reset to READ-ONLY verification (its full
  # history lives in git at commit ba1cd22). Never logs secret values.
  echo "--- read-only verification: Slack/Asana MCP containers ---"
  echo -n "  slack-mcp health: "; sudo docker exec slack-mcp-prod wget -qO- http://127.0.0.1:8000/health 2>/dev/null && echo "" || echo "n/a"
  echo -n "  asana-mcp health: "; sudo docker exec asana-mcp-prod wget -qO- http://127.0.0.1:8000/health 2>/dev/null && echo "" || echo "n/a"
  echo -n "  slack-mcp API key present: "; sudo docker exec slack-mcp-prod sh -lc '[ -n "$SLACK_MCP_API_KEY" ] && echo yes || echo EMPTY' 2>/dev/null || echo "?"
  echo -n "  asana-mcp API key present: "; sudo docker exec asana-mcp-prod sh -lc '[ -n "$ASANA_MCP_API_KEY" ] && echo yes || echo EMPTY' 2>/dev/null || echo "?"
  echo -n "  rename-artifact orphans (want none): "; sudo docker ps -a --format '{{.Names}}' | grep -cE '^[0-9a-f]+_(slack|asana|google|github|x)-mcp-prod$' 2>/dev/null || echo 0
  sudo docker ps --format '  {{.Names}} {{.Status}}' | grep -E 'slack-mcp-prod|asana-mcp-prod' || echo "  (mcp containers not found)"
  # End-to-end: prove the LIVE backend can reach each MCP by the exact DNS name
  # it uses (SLACK_MCP_URL=http://slack-mcp-prod:8000, ASANA_MCP_URL=...). A
  # rename-artifact would break this name even while the container runs healthy.
  AC=$(cat .active-color 2>/dev/null || echo blue); BE="admin-backend-${AC}"
  echo "  active color: $AC  (backend: $BE)"
  echo -n "  backend→slack-mcp-prod:8000/health: "; sudo docker exec "$BE" sh -lc 'wget -qO- --timeout=5 http://slack-mcp-prod:8000/health 2>/dev/null || curl -s --max-time 5 http://slack-mcp-prod:8000/health 2>/dev/null' 2>/dev/null && echo "" || echo "UNREACHABLE"
  echo -n "  backend→asana-mcp-prod:8000/health: "; sudo docker exec "$BE" sh -lc 'wget -qO- --timeout=5 http://asana-mcp-prod:8000/health 2>/dev/null || curl -s --max-time 5 http://asana-mcp-prod:8000/health 2>/dev/null' 2>/dev/null && echo "" || echo "UNREACHABLE"

  # ── ONE-SHOT (2026-07-29b): install the nightly backup layer + light disk
  #    cleanup (root was 84% at boot). Installs /usr/local/bin/digby-backup.sh
  #    + digby-backup.{service,timer} (daily 08:30 UTC, Persistent=true), then
  #    runs the FIRST backup synchronously to verify. Embedded inline because
  #    the accompanying deploy's rsync may not have landed yet. Canonical
  #    copies: scripts/backup/digby-backup.sh + deploy/digby-backup.*; full
  #    docs + owner S3/AWS-Backup steps: docs/BACKUPS.md. Marker in /var/tmp
  #    (NOT /opt/crossmodel — rsync --delete wipes markers there). ──
  MARKER_BK=/var/tmp/.digby-backup-install-20260729
  if [ ! -f "$MARKER_BK" ]; then
    echo "--- one-shot: light disk cleanup (pre-backup) ---"
    df -h / | tail -1
    sudo docker image prune -f 2>/dev/null | tail -1
    sudo docker builder prune --keep-storage 5GB -f 2>/dev/null | tail -1
    sudo journalctl --vacuum-size=100M >/dev/null 2>&1 || true
    df -h / | tail -1

    echo "--- one-shot: install digby-backup script + systemd timer ---"
    sudo mkdir -p /opt/crossmodel-backups /opt/crossmodel-local
    # CANONICAL COPY (FO firing 21, 2026-09-25): this one-shot used to embed a
    # full heredoc of the script — a 2026-07-29 copy that silently rotted while
    # scripts/backup/digby-backup.sh moved on (the RDS cutover fix, then the
    # 2026-09-25 egress-guard + status-marker fix). The heredoc drift was HALF
    # of why the 2026-09-25 nightly failed silently: /usr/local/bin still ran
    # on-box-postgres-first logic a month after the repo fixed it. The repo
    # file is the single source of truth — INSTALL IT, never re-embed it.
    if [ -f /opt/crossmodel/scripts/backup/digby-backup.sh ]; then
      sudo install -m 755 /opt/crossmodel/scripts/backup/digby-backup.sh /usr/local/bin/digby-backup.sh
      echo "  installed /usr/local/bin/digby-backup.sh from the repo canonical copy (scripts/backup/digby-backup.sh)"
    else
      echo "  WARNING: scripts/backup/digby-backup.sh not found in /opt/crossmodel — leaving the existing /usr/local/bin copy"
    fi

    sudo tee /etc/systemd/system/digby-backup.service > /dev/null << 'SVCEOF'
[Unit]
Description=Digby nightly backup (pg_dump + optional S3 offsite)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/digby-backup.sh
TimeoutStartSec=7200
SVCEOF

    sudo tee /etc/systemd/system/digby-backup.timer > /dev/null << 'TMREOF'
[Unit]
Description=Daily Digby backup at 08:30 UTC

[Timer]
OnCalendar=*-*-* 08:30:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
TMREOF

    sudo systemctl daemon-reload
    # NON-PRODUCER GUARD (FO firing 25, 2026-09-25): the backup layer is a
    # PRODUCER-only install (docs/BACKUPS.md — "the nightly pg_dump timer +
    # role wiring live on A only"). This one-shot predates the coding box
    # (2026-08-27) and enabled the timer UNCONDITIONALLY, so box C — no
    # postgres, no backend containers — failed "No such container:
    # admin-postgres-prod" every 08:30 UTC for a month (56 Failed lines since
    # Aug 29; box B was hand-disabled, C was missed). A box is a producer iff
    # the on-box postgres container exists (the pg_dump source) — otherwise
    # install the unit files (harmless, static) but never start/enable the
    # timer, and disable any previously-enabled copy.
    if sudo docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^admin-postgres-prod$'; then
      echo "  producer box detected (admin-postgres-prod present) — enabling backup timer"
      sudo systemctl enable --now digby-backup.timer
    else
      echo "  NON-PRODUCER box (no admin-postgres-prod) — backup timer NOT enabled"
      sudo systemctl disable --now digby-backup.timer 2>/dev/null || true
      sudo systemctl reset-failed digby-backup.service 2>/dev/null || true
    fi
    echo "  timer status:"
    systemctl list-timers digby-backup.timer --no-pager | sed 's/^/  /'
    echo "--- one-shot: running FIRST backup now (verification) ---"
    sudo systemctl start digby-backup.service && echo "  first backup service run: OK" || echo "  first backup service run: FAILED"
    sudo journalctl -u digby-backup -n 12 --no-pager | sed 's/^/  /'
    sudo touch "$MARKER_BK"
  else
    echo "  digby-backup install one-shot: already done"
    systemctl list-timers digby-backup.timer --no-pager 2>/dev/null | sed 's/^/  /' || true
  fi

  # ── ONE-SHOT (2026-07-29d) — FIRED 2026-07-29T17:48Z (ec2-ops run 30476954569;
  #    marker /var/tmp/.digby-disk-prune-20260729d). EMERGENCY disk prune reclaimed
  #    205.5MB (93%→88% used on /), unblocking deploy run 30476954671. Reset to
  #    this read-only note per convention; the full mutating version is recoverable
  #    in git history (merge commit 56fa1f6). ──
  echo "  disk-prune one-shot 20260729d: fired 2026-07-29T17:48Z — see git history (commit 56fa1f6)"

  # ── ONE-SHOT (2026-07-29e) — FIRED 2026-07-29 (ec2-ops run 30486201954;
  #    marker /var/tmp/.digby-disk-prune-20260729e). SECOND emergency disk prune
  #    freed ~2.2GB, unblocking the 19:58Z deploy. Reset to this read-only note
  #    per convention; the full mutating version is recoverable in git history
  #    (merge commit 8b691bf). ──
  echo "  disk-prune one-shot 20260729e: fired 2026-07-29 — see git history (commit 8b691bf)"

  # ── ONE-SHOT (2026-07-29f) — FIRED 2026-07-29T20:42Z (ec2-ops run 30489503661;
  #    marker /var/tmp/.digby-disk-prune-20260729f). THIRD emergency disk prune;
  #    unblocked deploy run 30489505897 (completed success). Reset to this
  #    read-only note per convention; the full mutating version is recoverable
  #    in git history (merge commit c2caa08). ──
  echo "  disk-prune one-shot 20260729f: fired 2026-07-29T20:42Z — see git history (commit c2caa08)"

  # ── ONE-SHOT (2026-07-29g) — FIRED 2026-07-29T21:16Z (ec2-ops run 30491685044;
  #    marker /var/tmp/.digby-rootfs-grow-20260729g). Rootfs was ALREADY grown
  #    (nvme0n1p1 99.9G, / at 97G/49%) — the block verified state as an idempotent
  #    NOCHANGE and marked done. Reset to this read-only note per convention; the
  #    full mutating version is recoverable in git history (merge commit cdb86949). ──
  echo "  rootfs-grow one-shot 20260729g: fired 2026-07-29T21:16Z — see git history (commit cdb86949)"

  # ── ONE-SHOT (2026-07-29h) — FIRED 2026-07-29 (marker
  #    /var/tmp/.digby-db-rotate-20260729h). Rotated the Postgres `admin` role
  #    password on-box and staged it into env-overrides.env — primary-only, no
  #    fan-out: the exact design that later crash-looped app-b (#128/#131).
  #    Retired 2026-09-14 (issue #131): the durable rotation path is
  #    scripts/deploy/rotate-db-password.sh (SSM store + STRICT fan-out to every
  #    fleet box — docs/DB_SECRET_ROTATION.md). Reset to this read-only note per
  #    convention; the full mutating version is recoverable in git history. ──
  echo "  db-rotate one-shot 20260729h: fired 2026-07-29 — superseded by rotate-db-password.sh (#131), see git history"

  # ── ONE-SHOT (2026-07-29c): wire Layer-2 offsite uploads. The owner created,
  #    via his local CLI (rozo_superadmin / crossmodel-prod profile): bucket
  #    digby-backups-prod (private, SSE, versioned, 30d lifecycle), instance
  #    role digby-backup-ec2-role (s3:PutObject on that bucket only) ATTACHED
  #    to the instance (no restart), AWS Backup vault digby-prod-vault + plan
  #    digby-prod-daily (06:00Z daily, 14d retention), and an immediate
  #    whole-volume snapshot snap-0123456789abcdef0. This one-shot finishes the
  #    on-box half: aws CLI install (+ /usr/local/bin symlink — systemd's PATH
  #    does NOT include /snap/bin, so the nightly service would miss a
  #    snap-only aws), backup.conf with the s3:// form the script expects,
  #    then a LIVE dump+upload to prove the pipe. Verification relies on the
  #    aws s3 cp exit code — the role deliberately has no ListBucket/GetObject,
  #    so `aws s3 ls` cannot be used to check. Marker in /var/tmp. ──
  MARKER_S3=/var/tmp/.digby-backup-s3-wire-20260729
  if [ ! -f "$MARKER_S3" ]; then
    echo "--- one-shot: wire BACKUP_S3_BUCKET + aws CLI ---"
    if ! command -v aws >/dev/null 2>&1 && [ ! -x /usr/local/bin/aws ]; then
      echo "  installing aws CLI (snap, apt fallback)..."
      sudo snap install aws-cli --classic 2>&1 | tail -1 || sudo apt-get install -y awscli 2>&1 | tail -1
    fi
    [ -x /snap/bin/aws ] && sudo ln -sf /snap/bin/aws /usr/local/bin/aws
    echo -n "  aws version: "; aws --version 2>/dev/null || /usr/local/bin/aws --version 2>&1 | tail -1
    echo -n "  instance-role identity: "; /usr/local/bin/aws sts get-caller-identity --query Arn --output text 2>&1 | tail -1
    echo 'BACKUP_S3_BUCKET=s3://digby-backups-prod' | sudo tee /opt/crossmodel-local/backup.conf > /dev/null
    sudo chmod 600 /opt/crossmodel-local/backup.conf
    echo "  backup.conf written: BACKUP_S3_BUCKET=s3://digby-backups-prod"
    echo "--- live verification: fresh dump + S3 upload ---"
    sudo systemctl start digby-backup.service && echo "  backup service run: OK" || echo "  backup service run: FAILED"
    sudo journalctl -u digby-backup -n 10 --no-pager | sed 's/^/  /'
    sudo touch "$MARKER_S3"
  else
    echo "  s3-wire one-shot: already done"
    sudo journalctl -u digby-backup -n 4 --no-pager | sed 's/^/  /' || true
  fi

  # 2026-07-10 gateway-restart one-shot: RETIRED 2026-07-29 (read-only note).
  # Its hypothesis was superseded by the 2026-07-13 gateway self-heal below, and
  # its marker lived at /opt/crossmodel/.gateway-restarted-20260710 — INSIDE the
  # rsync --delete root — so deploys wiped the marker and the "one-shot" re-fired
  # (observed restarting a healthy gateway in run 30415821766). Lesson: playbook
  # markers belong in /var/tmp, never /opt/crossmodel.
  echo "--- gateway-restart one-shot: retired 2026-07-29 (read-only note) ---"

  # 2026-07-13: SHIPPED the mcp-gateway self-heal (entrypoint supervises
  # supergateway+auth-proxy and exits for a clean Docker restart if either dies;
  # auth-proxy makes /health HONEST + self-exits on a sustained upstream outage).
  # This fixed session fa767dbf's web failures — the gateway had 502'd every tool
  # call while /health lied "ok", so nothing auto-recovered. Base compose `up -d`
  # runs without --build, so it was shipped via a one-shot rebuild of the
  # `brightdata-mcp` service here (verified: new supervisor boot line +
  # search/HF-scrape OK). The full rebuild+verify one-shot lives in git history at
  # commit c05f820; reset to this read-only note per playbook convention. To
  # re-ship after a gateway source change: `docker compose -f docker-compose.base.yml
  # build brightdata-mcp && up -d brightdata-mcp`.
  echo "--- mcp-gateway self-heal: shipped 2026-07-13 (read-only note) ---"

  # ── READ-ONLY probe (2026-07-17): kimi-k3 availability on the prod Moonshot key.
  #    The coding pipeline's Kimi slot switched kimi-k2.6 → kimi-k3 this deploy;
  #    prove the new model ID resolves with OUR key before users hit it. 1-token
  #    streamed completion from inside the active backend container (key never
  #    logged). Expect HTTP 200; a 404 "model not found" means the switch must be
  #    rolled back. Remove this block once verified. ──
  # 2026-07-17: kimi-k3 prod probe VERIFIED — run 5 (10:11Z) returned HTTP 200
  # with a streamed chat.completion.chunk from model "kimi-k3" using the prod
  # MOONSHOT_API_KEY (runs 2-4 were 429 engine_overloaded_error: Moonshot
  # launch-day congestion, ~3.5h). The coding pipeline's Kimi switch
  # (kimi-k2.6 → kimi-k3) is fully verified. The active probe block is reset
  # to this read-only note per playbook convention; the node-based probe
  # (backend image has NO curl) lives in git history at commit 034104c.
  echo "--- kimi-k3 probe: verified 2026-07-17 (HTTP 200, read-only note) ---"

  # 2026-07-18: grok-403 probe DIAGNOSED (run 29662336633) — xAI returns 403
  # {"code":"permission-denied","error":"Your team ... has either used all
  # available credits or reached its monthly spending limit."} for BOTH
  # /v1/models and /v1/responses. Billing, not code: every grok-4.5 call in
  # prod (legacy L2 + L4 council consult) fails until credits are purchased /
  # the spending limit is raised at console.x.ai. The node probe lives in git
  # history at commit 848c6b7.
  echo "--- grok-403 probe: diagnosed 2026-07-18 (xAI credits exhausted, read-only note) ---"

  # ── ONE-SHOT (2026-07-13b): raise mcp-gateway memory 1g → 2g. dmesg-confirmed
  #    memcg OOM: the container sat at 987MiB/1GiB and the kernel SIGKILLed the
  #    @brightdata/mcp child 23× in ~90 min; each ~15-21s respawn is a window where
  #    every search returns an empty SSE body ("EMPTY BODY" warns → intermittent
  #    web-search failures that outlast the retry burst). Repo compose now says 2g
  #    (commit 18e3a65); this sed makes the change effective even if this run wins
  #    the race against deploy.yml's rsync (idempotent either way), then recreates
  #    ONLY the gateway service. Marker-guarded; reset to a read-only note once
  #    verified. ──
  MARKER2=/var/tmp/.gateway-mem2g-20260713
  if [ ! -f "$MARKER2" ]; then
    echo "--- one-shot: gateway memory 1g -> 2g + recreate ---"
    N=$(grep -c '^          memory: 1g$' docker-compose.base.yml || true)
    if [ "$N" = "1" ]; then
      sudo sed -i 's/^          memory: 1g$/          memory: 2g/' docker-compose.base.yml
      echo "  compose patched (1 occurrence)"
    elif grep -q '^          memory: 2g$' docker-compose.base.yml; then
      echo "  compose already at 2g (rsync landed first)"
    else
      echo "  UNEXPECTED compose state (memory:1g count=$N) — skipping"; N=skip
    fi
    if [ "$N" != "skip" ]; then
      sudo docker compose -f docker-compose.base.yml up -d brightdata-mcp 2>&1 | tail -3
      sleep 20
      echo -n "  gateway: "; sudo docker inspect mcp-gateway-prod --format 'mem={{.HostConfig.Memory}} health={{.State.Health.Status}} status={{.State.Status}}'
      echo -n "  /health: "; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8200/health
      # live search probe through the recreated gateway
      echo -n "  search probe: "; curl -s -X POST http://localhost:8200/mcp \
        -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -H "X-API-Key: $(sudo grep '^MCP_DIGBY_TOKEN=' .env | cut -d= -f2)" \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_engine","arguments":{"query":"digby ai","engine":"google"}}}' \
        --max-time 45 | head -c 60; echo ""
      sudo touch "$MARKER2"
    fi
  else
    echo "  gateway mem-2g one-shot: already done"
  fi

  # ── ONE-SHOT (2026-07-14): supergateway MEMORY LEAK — rebuild with the cgroup
  #    memory watchdog + immediate restart. Prod hit 99% of 2GiB with 22 child
  #    OOM-kills in 30 min during the owner's first agent-chat dogfood; the 2g
  #    bump only delayed the leak. auth-proxy now self-exits at >92% cgroup use
  #    (2 strikes) for a clean container recycle. Marker-guarded. ──
  MARKER3=/var/tmp/.gateway-memwatch-20260714
  if [ ! -f "$MARKER3" ]; then
    echo "--- one-shot: rebuild gateway with memory watchdog + restart ---"
    sudo docker compose -f docker-compose.base.yml build brightdata-mcp 2>&1 | tail -2
    sudo docker compose -f docker-compose.base.yml up -d brightdata-mcp 2>&1 | tail -2
    sleep 20
    echo -n "  gateway: "; sudo docker inspect mcp-gateway-prod --format 'health={{.State.Health.Status}} started={{.State.StartedAt}}'
    echo -n "  memwatch in image: "; sudo docker exec mcp-gateway-prod grep -c 'cgroup memory' /app/auth-proxy.js 2>/dev/null || echo 0
    echo -n "  mem now: "; sudo docker stats --no-stream --format '{{.MemUsage}}' mcp-gateway-prod
    echo -n "  search probe: "; curl -s -X POST http://localhost:8200/mcp \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -H "X-API-Key: $(sudo grep '^MCP_DIGBY_TOKEN=' .env | cut -d= -f2)" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_engine","arguments":{"query":"ok","engine":"google"}}}' \
      --max-time 45 | head -c 40; echo ""
    sudo touch "$MARKER3"
  else
    echo "  gateway memwatch one-shot: already done"
  fi

  # ── ONE-SHOT (2026-07-22): make example-user@example.com the SOLE ADMIN. The batch-1
  #    security fix locked /api/users + the admin dashboard behind role=ADMIN, but
  #    the owner's account was role=USER (so he was 403'd). Owner: "make me an
  #    admin, example-user@example.com should be the only admin." Promote Paul + demote
  #    any other ADMINs to USER. Idempotent; marker-guarded per convention. No
  #    secrets touched/logged. Table is `users` (Prisma User @@map("users")),
  #    enum Role. (Marker bumped -b: the 1st run used the wrong table name "User"
  #    and errored but still touched the -20260722 marker.) ──
  MARKER4=/var/tmp/.paul-sole-admin-20260722b
  if [ ! -f "$MARKER4" ]; then
    echo "--- one-shot: set example-user@example.com as the sole ADMIN ---"
    echo "  admins BEFORE:"
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db -t -A -F'|' --no-psqlrc \
      -c "SELECT email, role FROM users WHERE role='ADMIN' ORDER BY email;" | sed 's/^/    /'
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db --no-psqlrc <<'SQL'
UPDATE users SET role='ADMIN' WHERE email='example-user@example.com';
UPDATE users SET role='USER'  WHERE role='ADMIN' AND email<>'example-user@example.com';
SQL
    echo "  admins AFTER (want exactly example-user@example.com):"
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db -t -A -F'|' --no-psqlrc \
      -c "SELECT email, role FROM users WHERE role='ADMIN' ORDER BY email;" | sed 's/^/    /'
    echo -n "  paul role now: "
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db -t -A --no-psqlrc \
      -c "SELECT role FROM users WHERE email='example-user@example.com';"
    sudo touch "$MARKER4"
  else
    echo "  paul-sole-admin one-shot: already done"
  fi

  # ── ONE-SHOT (2026-07-23): READ-ONLY diagnostics for a user complaint —
  #    example-user@example.com reported "all my chats are gone" around the
  #    agentic-cutover deploy window (same window as the /coding/* 502 outage,
  #    fixed in a0a7688). Verify from the DB whether his data is intact and
  #    whether his account shows anything unusual. ZERO writes. ──
  MARKER5=/var/tmp/.jacob-chats-diag-20260723
  if [ ! -f "$MARKER5" ]; then
    echo "--- one-shot: example-user@example.com chat-visibility diagnostics (read-only) ---"
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db --no-psqlrc -t -A -F' | ' <<'SQL'
\echo '== user row =='
SELECT id, role, "isChild", "createdAt", "updatedAt", "deletedAt" FROM users WHERE email='example-user@example.com';
\echo '== chat counts by mode =='
SELECT c.mode, count(*), min(c."createdAt") AS first, max(c."updatedAt") AS last
FROM crossmodel_chats c JOIN users u ON u.id=c."userId"
WHERE u.email='example-user@example.com' GROUP BY c.mode;
\echo '== chats: total / in-folder / last-10 (id, title40, mode, folderId, updatedAt) =='
SELECT count(*) AS total, count(c."folderId") AS in_folder
FROM crossmodel_chats c JOIN users u ON u.id=c."userId" WHERE u.email='example-user@example.com';
SELECT c.id, left(c.title,40), c.mode, coalesce(c."folderId",'-'), c."updatedAt"
FROM crossmodel_chats c JOIN users u ON u.id=c."userId"
WHERE u.email='example-user@example.com' ORDER BY c."updatedAt" DESC LIMIT 10;
\echo '== message rows (normalized) + legacy jsonb totals =='
SELECT count(m.*) FROM crossmodel_messages m
WHERE m."chatId" IN (SELECT c.id FROM crossmodel_chats c JOIN users u ON u.id=c."userId" WHERE u.email='example-user@example.com');
SELECT coalesce(sum(array_length(c.messages,1)),0) AS legacy_jsonb_msgs
FROM crossmodel_chats c JOIN users u ON u.id=c."userId" WHERE u.email='example-user@example.com';
\echo '== folders =='
SELECT f.id, f.name, f."createdAt" FROM crossmodel_folders f JOIN users u ON u.id=f."userId"
WHERE u.email='example-user@example.com';
\echo '== projects (name, repoProvider, folderId) =='
SELECT p.name, coalesce(p."repoProvider",'-'), coalesce(p."folderId",'-'), p."updatedAt"
FROM crossmodel_projects p JOIN users u ON u.id=p."userId"
WHERE u.email='example-user@example.com' ORDER BY p."updatedAt" DESC;
\echo '== coding sessions (satellite rows) =='
SELECT count(*) FROM coding_sessions s
WHERE s."userId"=(SELECT id FROM users WHERE email='example-user@example.com');
\echo '== his feedback / feature requests (last 14d) =='
SELECT 'feedback', fb.type, coalesce(fb.reason,'-'), left(coalesce(fb.comment,'-'),120), fb."createdAt"
FROM message_feedback fb WHERE fb."userId"=(SELECT id FROM users WHERE email='example-user@example.com')
  AND fb."createdAt" > now()-interval '14 days' ORDER BY fb."createdAt" DESC LIMIT 10;
SELECT 'featreq', fr.type, left(fr.title,60), left(fr.description,160), fr."createdAt"
FROM user_feature_requests fr WHERE fr."userId"=(SELECT id FROM users WHERE email='example-user@example.com')
  AND fr."createdAt" > now()-interval '14 days' ORDER BY fr."createdAt" DESC LIMIT 10;
\echo '== app errors mentioning his userId (last 3d) =='
SELECT count(*) FROM app_error_logs e
WHERE e."createdAt" > now()-interval '3 days'
  AND e.context::text LIKE '%'||(SELECT id::text FROM users WHERE email='example-user@example.com')||'%';
SQL
    sudo touch "$MARKER5"
  else
    echo "  jacob-chats-diag one-shot: already done"
  fi

  # ── ONE-SHOT (2026-08-07): AGENT TEST-ACCOUNT INVENTORY — READ-ONLY. Owner
  #    directive: consolidate to ONE canonical agent login (claudebot@digby.ai)
  #    and clean up throwaway accounts past sessions registered ad-hoc. This
  #    block ONLY READS: every user row + activity counts so the driving
  #    session can classify throwaway vs real. Deletion is a SEPARATE one-shot
  #    written after classification. Marker in /var/tmp. ──
  MARKER_UI=/var/tmp/.digby-user-inventory-20260807
  if [ ! -f "$MARKER_UI" ]; then
    echo "--- user-inventory: all users ---"
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db --no-psqlrc -P pager=off -F'|' -A \
      -c "SELECT left(u.id,8) AS id, u.email, coalesce(u.\"firstName\",'-') AS fn, coalesce(u.\"lastName\",'-') AS ln, u.role, u.\"isActive\" AS active, u.\"isChild\" AS child, (u.\"deletedAt\" IS NOT NULL) AS soft_del, to_char(u.\"createdAt\",'YYYY-MM-DD') AS created FROM users u ORDER BY u.\"createdAt\";" \
      2>&1 | sed 's/^/  /'
    echo "--- user-inventory: activity counts ---"
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db --no-psqlrc -P pager=off -F'|' -A \
      -c "SELECT u.email, (SELECT count(*) FROM crossmodel_chats c WHERE c.\"userId\"=u.id) AS chats, (SELECT count(*) FROM crossmodel_messages m JOIN crossmodel_chats c2 ON c2.id=m.\"chatId\" WHERE c2.\"userId\"=u.id) AS msgs, coalesce((SELECT to_char(max(c3.\"updatedAt\"),'YYYY-MM-DD HH24:MI') FROM crossmodel_chats c3 WHERE c3.\"userId\"=u.id),'-') AS last_chat, (SELECT count(*) FROM refresh_tokens rt WHERE rt.\"userId\"=u.id) AS refresh_tokens FROM users u ORDER BY u.\"createdAt\";" \
      2>&1 | sed 's/^/  /'
    sudo touch "$MARKER_UI"
  else
    echo "  user-inventory one-shot: already done"
  fi

  # ── ONE-SHOT (2026-08-08): PURGE THROWAWAY AGENT-CREATED ACCOUNTS. Owner
  #    directive: keep ONE canonical agent login (claudebot@digby.ai) + the 7
  #    real users; delete the 72 throwaways past sessions registered ad-hoc
  #    (inventory one-shot 2026-08-07, run 31246416171: 80 users = 7 real +
  #    claudebot + 72 throwaway). Patterns match ONLY machine-generated emails;
  #    an in-flight deploy may add ±1 deploy-smoke row, hence the range guard.
  #    Guards run BEFORE the DELETE; DELETE ... RETURNING is the exact audit
  #    trail; post-delete listing is the second read-only inventory. FK
  #    cascades handle children (no Restrict/NoAction FKs in the schema;
  #    mirrors adminDeleteUser). Marker in /var/tmp. ──
  # r2 (2026-08-08): r1 FAILED SAFE — the r1 SQL was written corrupted
  #    (dollar-quoting collapsed, regex literals split); ON_ERROR_STOP aborted
  #    BEFORE the DELETE (no data touched) but the un-gated marker was still
  #    touched, so this block uses a NEW marker, psql-native guards (\gset/\if —
  #    no PL/pgSQL dollar-quoting), and only touches the marker when psql exits 0.
  MARKER_DU=/var/tmp/.digby-throwaway-user-purge-20260808-r2
  if [ ! -f "$MARKER_DU" ]; then
    echo "--- throwaway-purge r2: psql-native guards + cascade delete (audit via RETURNING) ---"
    sudo docker exec -i admin-postgres-prod psql -U admin -d admin_db --no-psqlrc -P pager=off -F'|' -A <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SELECT (count(*) BETWEEN 72 AND 74) AS ok FROM users u
WHERE u.email LIKE '%@example.com'
   OR u.email LIKE '%@digby-e2e-test.dev'
   OR u.email LIKE '%@digby-internal.test'
   OR u.email ~ '^digby-(verify|fleet-verify|attn-verify)-[0-9]+@outlook\.com'
   OR u.email = 'example-e2e@example.com' \gset
\if :ok
\echo 'guard-count OK (throwaway rows within expected range)'
\else
\echo 'GUARD FAILED: throwaway count outside expected range — aborting before DELETE'
\quit 1
\endif
SELECT (count(*) = 0) AS ok FROM users u
WHERE u.email IN ('example-user@example.com','example-user@example.com','example-user@example.com','example-user@example.com','example-user@example.com','example-user@example.com','example-user@example.com','claudebot@digby.ai')
  AND (u.email LIKE '%@example.com'
   OR u.email LIKE '%@digby-e2e-test.dev'
   OR u.email LIKE '%@digby-internal.test'
   OR u.email ~ '^digby-(verify|fleet-verify|attn-verify)-[0-9]+@outlook\.com'
   OR u.email = 'example-e2e@example.com') \gset
\if :ok
\echo 'guard-keep-list OK (zero collisions)'
\else
\echo 'GUARD FAILED: keep-list collision — aborting before DELETE'
\quit 1
\endif
DELETE FROM users u
WHERE u.email LIKE '%@example.com'
   OR u.email LIKE '%@digby-e2e-test.dev'
   OR u.email LIKE '%@digby-internal.test'
   OR u.email ~ '^digby-(verify|fleet-verify|attn-verify)-[0-9]+@outlook\.com'
   OR u.email = 'example-e2e@example.com'
RETURNING u.email AS deleted_email;
SELECT count(*) AS remaining_users FROM users;
SELECT left(id,8) AS id, email, role, to_char("createdAt",'YYYY-MM-DD') AS created FROM users ORDER BY "createdAt";
COMMIT;
SQL
    if [ $? -eq 0 ]; then
      sudo touch "$MARKER_DU"
    else
      echo "  PURGE FAILED (psql non-zero exit) — marker NOT set; block retries on the next ec2-ops run"
    fi
  else
    echo "  throwaway-purge one-shot: already done (r2)"
  fi

  # ── ONE-SHOT (2026-08-15): PURGE THROWAWAY ACCOUNTS r3 — LIVE STORE. r2
  #    (2026-08-08) ran against the on-box admin-postgres-prod container, which
  #    was RETIRED in the 2026-07-31 RDS cutover but left running: r2 drained a
  #    stale snapshot while the live RDS DB kept every junk row (owner report
  #    2026-08-15: settings still shows 129 users). Probe (diagnostics LIVE DB
  #    PROBE, run 31914869722): backend + worker DATABASE_URL =
  #    example-db...ca-central-1.rds.amazonaws.com/admin_db; 129 users =
  #    14 real + 115 @example.com; newest message seconds-old. This block
  #    repeats the r2 delete THROUGH THE BACKEND CONTAINER'S OWN DATABASE_URL
  #    (no credentials in git; only redacted echoes). Guards re-ranged for the
  #    live store; extra domain guard so the delete set can never include an
  #    unexpected domain; NEW marker; marker only on psql exit 0. On success it
  #    also stops the retired local container (restart=no) so no future local
  #    psql read — or backup auto-detect — can mistake it for the live store. ──
  MARKER_DU3=/var/tmp/.digby-throwaway-user-purge-20260815-r3
  if [ ! -f "$MARKER_DU3" ]; then
    echo "--- throwaway-purge r3: LIVE store via backend DATABASE_URL ---"
    BE_URL="$(sudo docker exec admin-backend-blue sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)"
    [ -z "$BE_URL" ] && BE_URL="$(sudo docker exec admin-backend-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)"
    if [ -z "$BE_URL" ]; then
      echo "  r3 ABORT: no backend DATABASE_URL readable (blue/green both empty) — marker NOT set"
    else
      echo "  target (redacted): $(printf '%s' "$BE_URL" | sed -E 's#(postgres(ql)?://[^:]+:)[^@]+@#\1***@#')"
      if sudo docker ps --format '{{.Names}}' | grep -qx 'admin-postgres-prod'; then
        PURGE_PSQL='sudo docker exec -i admin-postgres-prod psql'
      else
        PURGE_PSQL='sudo docker run --rm -i pgvector/pgvector:pg16 psql'
      fi
      $PURGE_PSQL "$BE_URL" --no-psqlrc -P pager=off -F'|' -A <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SELECT (count(*) BETWEEN 110 AND 125) AS ok FROM users u
WHERE u.email LIKE '%@example.com'
   OR u.email LIKE '%@digby-e2e-test.dev'
   OR u.email LIKE '%@digby-internal.test'
   OR u.email ~ '^digby-(verify|fleet-verify|attn-verify)-[0-9]+@outlook\.com'
   OR u.email = 'example-e2e@example.com' \gset
\if :ok
\echo 'guard-count OK (throwaway rows within expected live range 110-125)'
\else
\echo 'GUARD FAILED: throwaway count outside expected live range — aborting before DELETE'
\quit 1
\endif
SELECT (count(*) = 0) AS ok FROM users u
WHERE u.email IN ('example-user@example.com','example-user@example.com','example-user@example.com','example-user@example.com','example-user@example.com','example-user@example.com','example-user@example.com','claudebot@digby.ai')
  AND (u.email LIKE '%@example.com'
   OR u.email LIKE '%@digby-e2e-test.dev'
   OR u.email LIKE '%@digby-internal.test'
   OR u.email ~ '^digby-(verify|fleet-verify|attn-verify)-[0-9]+@outlook\.com'
   OR u.email = 'example-e2e@example.com') \gset
\if :ok
\echo 'guard-keep-list OK (zero collisions)'
\else
\echo 'GUARD FAILED: keep-list collision — aborting before DELETE'
\quit 1
\endif
SELECT (count(*) = 0) AS ok FROM users u
WHERE (u.email LIKE '%@example.com'
   OR u.email LIKE '%@digby-e2e-test.dev'
   OR u.email LIKE '%@digby-internal.test'
   OR u.email ~ '^digby-(verify|fleet-verify|attn-verify)-[0-9]+@outlook\.com'
   OR u.email = 'example-e2e@example.com')
  AND NOT (lower(split_part(u.email,'@',2)) IN ('example.com','digby-e2e-test.dev','digby-internal.test','outlook.com')
   OR u.email = 'example-e2e@example.com') \gset
\if :ok
\echo 'guard-domains OK (delete set confined to junk domains)'
\else
\echo 'GUARD FAILED: unexpected domain in delete set — aborting before DELETE'
\quit 1
\endif
DELETE FROM users u
WHERE u.email LIKE '%@example.com'
   OR u.email LIKE '%@digby-e2e-test.dev'
   OR u.email LIKE '%@digby-internal.test'
   OR u.email ~ '^digby-(verify|fleet-verify|attn-verify)-[0-9]+@outlook\.com'
   OR u.email = 'example-e2e@example.com'
RETURNING u.email AS deleted_email;
SELECT count(*) AS remaining_users FROM users;
SELECT left(id,8) AS id, email, role, to_char("createdAt",'YYYY-MM-DD') AS created FROM users ORDER BY "createdAt";
COMMIT;
SQL
      if [ $? -eq 0 ]; then
        sudo touch "$MARKER_DU3"
        echo "  r3 purge committed on the LIVE store; retiring the stale local container"
        sudo docker update --restart=no admin-postgres-prod >/dev/null 2>&1 || true
        sudo docker stop admin-postgres-prod >/dev/null 2>&1 \
          && echo "  admin-postgres-prod stopped (restart=no) — stale local reads of app data now impossible" \
          || echo "  admin-postgres-prod already stopped/absent"
      else
        echo "  PURGE FAILED (psql non-zero exit) — marker NOT set; block retries on the next ec2-ops run"
      fi
    fi
  else
    echo "  throwaway-purge one-shot: already done (r3, LIVE store)"
  fi
  # ── ONE-SHOT (2026-08-19a) — FIRED 2026-08-19T07:33Z (ec2-ops run 32228359447,
  #    dispatched on branch digby/ops-disk-prune-20260819; marker
  #    /var/tmp/.digby-disk-prune-20260819a). FOURTH emergency disk prune:
  #    deploys 32227401486 + 32227495118 died at "Blue-green deploy" with
  #    No space left on device; prune took / from 98% (2.8G free) to 86% (14G
  #    free) and the deploy re-run went green. Same commands as 29d/e/f. Reset
  #    to this read-only note per convention; the mutating version is
  #    recoverable on branch digby/ops-disk-prune-20260819. DURABLE FIX LANDED
  #    2026-08-20 (issue #266): this exact proven-safe prune set now runs as the
  #    pre-flight disk guard in deploy-blue-green.sh (≥90% → builder -af +
  #    image -af + journal vacuum 100M; ≥95% → abort before the build). ──
  echo "  disk-prune one-shot 20260819a: fired 2026-08-19T07:33Z — durable fix landed in deploy-blue-green.sh pre-flight guard (issue #266)"

  # ── ONE-SHOT (2026-08-27s, prod A): drain logs on the cron-only worker. ──
  MARKER_W246E=/var/tmp/.digby-w246e-20270827s
  if [ ! -f "$MARKER_W246E" ]; then
    echo "== W24-6E host=$(hostname) =="
    for W in $(sudo docker ps --format '{{.Names}}' | grep '^admin-worker'); do
      echo "--- $W ticket/cron lines (4h) ---"
      sudo docker logs "$W" --since 4h 2>&1 | grep -iE 'ticket-dispatch|ticket-drain' | tail -10
      echo "--- $W warn/error (2h) ---"
      sudo docker logs "$W" --since 2h 2>&1 | grep -iE 'warn|error' | grep -vi 'deprecat' | tail -8
    done
    echo "== END W24-6E =="
    sudo touch "$MARKER_W246E"
  fi

  # ── ONE-SHOT (2026-08-27t, prod): restore ticket-dispatch env in box-local overrides. ──
  # Box A's mid-flip override rewrite dropped TICKET_DISPATCH_ENABLED /
  # PLATFORM_ENGINEER_CHAT_ID — its cron-only worker silently no-oped every
  # ticket-drain lease slot it won. Restore from the running backend's env
  # (which still has the values from the pre-flip .env) so the next deploy
  # recreates workers correctly.
  MARKER_W246F=/var/tmp/.digby-w246f-20270827t
  if [ ! -f "$MARKER_W246F" ]; then
    echo "== W24-6F host=$(hostname) =="
    F=/opt/crossmodel-local/env-overrides.env
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-backend') || true
    echo "backend=$BK"
    for K in TICKET_DISPATCH_ENABLED PLATFORM_ENGINEER_CHAT_ID; do
      V=$(sudo docker exec "$BK" sh -c "printf %s \"\$$K\"" 2>/dev/null)
      INFILE=$(sudo grep -c "^$K=" "$F" 2>/dev/null || echo 0)
      echo "$K: backend_len=${#V} overrides_lines=$INFILE value=$V"
      if [ -n "$V" ] && [ "$INFILE" = "0" ]; then
        echo "$K=$V" | sudo tee -a "$F" >/dev/null
        echo "  -> appended to $F"
      fi
    done
    sudo OVERRIDES_FILE="$F" bash /opt/crossmodel/scripts/deploy/apply-env-overrides.sh 2>&1 | tail -2
    echo "-- merged .env now has:"
    sudo grep -E '^(TICKET_DISPATCH_ENABLED|PLATFORM_ENGINEER_CHAT_ID)=' /opt/crossmodel/.env || echo "STILL MISSING"
    echo "-- worker env (current container, pre-recreate):"
    W=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    [ -n "$W" ] && sudo docker exec "$W" sh -c 'echo "TDE=${TICKET_DISPATCH_ENABLED:-unset} LANE=${PLATFORM_ENGINEER_CHAT_ID:-unset}"'
    echo "== END W24-6F =="
    sudo touch "$MARKER_W246F"
  fi

  # ── ONE-SHOT (2026-08-27v, prod): drain logs on A workers (read-only). ──
  MARKER_W247A=/var/tmp/.digby-w247a-20270827v
  if [ ! -f "$MARKER_W247A" ]; then
    echo "== W24-7A host=$(hostname) =="
    echo "--- digby-code containers on this box (list only) ---"
    sudo docker ps -a --filter 'name=digby-code' --format '{{.Names}} {{.State}}' | head -12
    echo "--- drain log lines (2h, A workers) ---"
    for W in $(sudo docker ps --format '{{.Names}}' | grep '^admin-worker'); do
      echo "[$W]"; sudo docker logs "$W" --since 2h 2>&1 | grep -iE 'ticket-dispatch|ticket-drain' | tail -5
    done
    echo "== END W24-7A =="
    sudo touch "$MARKER_W247A"
  fi

  # ── ONE-SHOT (2026-08-27aa, prod): migration close-out cleanup on A.
  # OWNER-AUTHORIZED 2026-08-27 ("go ahead with the container cleanup"):
  # remove the exited pre-flip digby-code session containers (sessions live on
  # box C now) + dangling-image prune. No volumes, no networks touched.
  MARKER_W24CLA=/var/tmp/.digby-w24cla-20270827aa
  if [ ! -f "$MARKER_W24CLA" ]; then
    echo "== W24-CLA host=$(hostname) =="
    for CN in $(sudo docker ps -a --filter 'name=digby-code' --filter 'status=exited' --format '{{.Names}}'); do
      sudo docker rm "$CN" >/dev/null 2>&1 && echo "removed $CN"
    done
    sudo docker image prune -f 2>&1 | tail -1
    echo "--- workers on A (expect ONE, cron-only) ---"
    sudo docker ps --format '{{.Names}}' | grep '^admin-worker' || echo none
    echo "--- disk ---"; df -h / | awk 'NR==2{print $3" used / "$2" ("$5")"}'
    echo "== END W24-CLA =="
    sudo touch "$MARKER_W24CLA"
  fi

  # ── ONE-SHOT (2026-08-28ac, prod): attach-path debug for session c9ccf88a. ──
  MARKER_W2428A=/var/tmp/.digby-w2428a-20270828ac
  if [ ! -f "$MARKER_W2428A" ]; then
    echo "== W24-28A host=$(hostname) =="
    for B in $(sudo docker ps --format '{{.Names}}' | grep '^admin-backend'); do
      echo "[$B] --- c9ccf88a lines (60m) ---"
      sudo docker logs "$B" --since 60m 2>&1 | grep 'c9ccf88a' | tail -6
      echo "[$B] --- streamRun/coding stream errors (60m) ---"
      sudo docker logs "$B" --since 60m 2>&1 | grep -iE 'streamRun failed|coding stream|frame' | tail -6
      echo "[$B] --- error-level lines (30m) ---"
      sudo docker logs "$B" --since 30m 2>&1 | grep -i 'error' | grep -vi 'deprecat' | tail -6
    done
    echo "== END W24-28A =="
    sudo touch "$MARKER_W2428A"
  fi

  # ── ONE-SHOT (2026-08-28ai, prod): attach-log live check. ──
  MARKER_W2434A=/var/tmp/.digby-w2434a-20270828ai
  if [ ! -f "$MARKER_W2434A" ]; then
    echo "== W24-34A host=$(hostname) =="
    for B in $(sudo docker ps --format '{{.Names}}' | grep '^admin-backend'); do
      echo "[$B] attach lines (60m):"
      sudo docker logs "$B" --since 60m 2>&1 | grep -E 'tail attach|replay attach' | tail -8
    done
    echo "== END W24-34A =="
    sudo touch "$MARKER_W2434A"
  fi

  # ── ONE-SHOT (2026-08-29a, prod): fleet progress snapshot for owner readout (read-only). ──
  MARKER_FW29A=/var/tmp/.digby-fw29a-20260829a
  if [ ! -f "$MARKER_FW29A" ]; then
    echo "== FW29-A host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -30; }
    echo "--- run counts (3h) ---"
    q "SELECT status||': '||count(*) FROM agent_runs WHERE \"updatedAt\" > now() - interval '3 hours' GROUP BY status"
    echo "--- running now ---"
    q "SELECT left(\"sessionId\"::text,8)||' run='||left(id::text,8)||' start='||coalesce(to_char(\"startedAt\",'HH24:MI'),'-')||' hb='||coalesce(to_char(\"heartbeatAt\",'HH24:MI:SS'),'-')||' att='||attempts FROM agent_runs WHERE status='running' ORDER BY \"startedAt\""
    echo "--- queued age ---"
    q "SELECT count(*)||' queued, oldest '||coalesce(extract(epoch from (now()-min(\"createdAt\")))::int::text,'-')||'s' FROM agent_runs WHERE status='queued'"
    echo "--- failed (6h) ---"
    q "SELECT left(\"sessionId\"::text,8)||' upd='||to_char(\"updatedAt\",'HH24:MI')||' att='||attempts||' | '||left(coalesce(error,'-'),70) FROM agent_runs WHERE status='failed' AND \"updatedAt\" > now() - interval '6 hours' ORDER BY \"updatedAt\" DESC LIMIT 8"
    echo "--- lane sessions ---"
    q "SELECT left(id::text,8)||' | '||status||' | upd='||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(title,46) FROM coding_sessions WHERE id::text ~ '^(28de72e5|b95e9df6|a8976e11|cec340f2|e083ff2e|79464b3d|1ca12570|2d4ff22f|b92ef13f|c9ccf88a|4f918389)' ORDER BY \"updatedAt\" DESC"
    echo "--- lane latest runs ---"
    q "SELECT DISTINCT ON (\"sessionId\") left(\"sessionId\"::text,8)||' '||status||' att='||attempts||' crt='||to_char(\"createdAt\",'MM-DD HH24:MI')||' upd='||to_char(\"updatedAt\",'HH24:MI')||' err='||left(coalesce(error,'-'),40) FROM agent_runs WHERE \"sessionId\"::text ~ '^(28de72e5|b95e9df6|a8976e11|cec340f2|e083ff2e|79464b3d|1ca12570|2d4ff22f|b92ef13f|c9ccf88a)' ORDER BY \"sessionId\", \"createdAt\" DESC"
    echo "--- 2d4ff22f deep dive: runs ---"
    q "SELECT left(id::text,8)||' '||status||' att='||attempts||' crt='||to_char(\"createdAt\",'MM-DD HH24:MI')||' start='||coalesce(to_char(\"startedAt\",'HH24:MI'),'-')||' hb='||coalesce(to_char(\"heartbeatAt\",'HH24:MI:SS'),'-')||' lease='||coalesce(to_char(\"leaseExpiresAt\",'HH24:MI:SS'),'-')||' | '||left(coalesce(error,'-'),40) FROM agent_runs WHERE \"sessionId\"::text LIKE '2d4ff22f%' ORDER BY \"createdAt\" DESC LIMIT 5"
    echo "--- 2d4ff22f deep dive: latest-run events ---"
    q "SELECT count(*)||' events, max_seq='||coalesce(max(seq)::text,'-')||' latest='||coalesce(to_char(max(\"createdAt\"),'MM-DD HH24:MI:SS'),'-') FROM agent_events WHERE \"runId\" IN (SELECT id FROM agent_runs WHERE \"sessionId\"::text LIKE '2d4ff22f%' ORDER BY \"createdAt\" DESC LIMIT 1)"
    echo "--- tickets open/in_progress ---"
    q "SELECT left(id::text,8)||' '||status||' p'||priority||' upd='||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(title,58) FROM user_feature_requests WHERE status IN ('open','in_progress') ORDER BY \"updatedAt\" DESC LIMIT 20"
    echo "--- named tickets ---"
    q "SELECT left(id::text,8)||' '||status||' upd='||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(title,55) FROM user_feature_requests WHERE id::text ~ '^(4550ee11|6bf8ce36|0b4575dd|d64f6f08|44204e09|c1cbe6a2|a8387f3f)'"
    echo "--- owner-decision persistence ticket search (48h) ---"
    q "SELECT left(id::text,8)||' '||status||' | '||left(title,70) FROM user_feature_requests WHERE (title ILIKE '%owner%' OR title ILIKE '%persist%' OR title ILIKE '%confirm%' OR title ILIKE '%decision%') AND \"createdAt\" > now() - interval '48 hours' LIMIT 8"
    echo "--- schedules (enabled) ---"
    q "SELECT left(id::text,8)||' sess='||left(\"sessionId\"::text,8)||' every='||coalesce((\"intervalSec\"/60)::text,'-')||'m runs='||\"runsCount\"||' last='||coalesce(\"lastStatus\",'-')||' next='||to_char(\"nextRunAt\",'MM-DD HH24:MI') FROM coding_schedules WHERE enabled ORDER BY \"nextRunAt\" LIMIT 15"
    echo "--- supervisor chat ---"
    q "SELECT left(id::text,8)||' upd='||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(title,50) FROM crossmodel_chats WHERE \"isSupervisor\" ORDER BY \"updatedAt\" DESC LIMIT 3"
    echo "--- supervisor last 8 msgs ---"
    q "SELECT to_char(m.\"createdAt\",'MM-DD HH24:MI')||' '||m.role||': '||left(regexp_replace(m.content,'[[:space:]]+',' ','g'),230) FROM crossmodel_messages m WHERE m.\"chatId\" = (SELECT id FROM crossmodel_chats WHERE \"isSupervisor\" ORDER BY \"updatedAt\" DESC LIMIT 1) ORDER BY m.\"createdAt\" DESC LIMIT 8"
    echo "== END FW29-A =="
    sudo touch "$MARKER_FW29A"
  fi

  # ── ONE-SHOT (2026-08-29c, prod): follow-up — resolve 2d4ff22f / dispatched-session anomalies (read-only). ──
  MARKER_FW29B=/var/tmp/.digby-fw29b-20260829c
  if [ ! -f "$MARKER_FW29B" ]; then
    echo "== FW29-B host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -20; }
    echo "--- chats: 2d4ff22f / 1ca12570 / 79464b3d / e083ff2e / 9e20c3f7 ---"
    q "SELECT left(id::text,8)||' | '||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | sup='||\"isSupervisor\"||' | '||left(title,52) FROM crossmodel_chats WHERE id::text ~ '^(2d4ff22f|1ca12570|79464b3d|e083ff2e|9e20c3f7)'"
    echo "--- coding_sessions for same ids ---"
    q "SELECT left(id::text,8)||' | '||status||' | '||left(title,50) FROM coding_sessions WHERE id::text ~ '^(2d4ff22f|1ca12570|79464b3d|e083ff2e|9e20c3f7)'"
    echo "--- 2d4ff22f last 5 msgs ---"
    q "SELECT to_char(\"createdAt\",'MM-DD HH24:MI')||' '||role||': '||left(regexp_replace(content,'[[:space:]]+',' ','g'),180) FROM crossmodel_messages WHERE \"chatId\"::text LIKE '2d4ff22f%' ORDER BY \"createdAt\" DESC LIMIT 5"
    echo "--- 1ca12570 last 3 msgs ---"
    q "SELECT to_char(\"createdAt\",'MM-DD HH24:MI')||' '||role||': '||left(regexp_replace(content,'[[:space:]]+',' ','g'),180) FROM crossmodel_messages WHERE \"chatId\"::text LIKE '1ca12570%' ORDER BY \"createdAt\" DESC LIMIT 3"
    echo "--- 79464b3d last 3 msgs ---"
    q "SELECT to_char(\"createdAt\",'MM-DD HH24:MI')||' '||role||': '||left(regexp_replace(content,'[[:space:]]+',' ','g'),180) FROM crossmodel_messages WHERE \"chatId\"::text LIKE '79464b3d%' ORDER BY \"createdAt\" DESC LIMIT 3"
    echo "== END FW29-B =="
    sudo touch "$MARKER_FW29B"
  fi

  # ── ONE-SHOT (2026-08-29e, prod): session-creation audit + MCP bindings + evidence tickets. ──
  # Tickets are insert-if-absent (NOT EXISTS guard) — re-runs never duplicate.
  MARKER_FW29E=/var/tmp/.digby-fw29e-20260829e
  if [ ! -f "$MARKER_FW29E" ]; then
    echo "== FW29-E host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -20; }
    echo "--- coding sessions created (10h) ---"
    q "SELECT left(id::text,8)||' '||status||' crt='||to_char(\"createdAt\",'HH24:MI')||' | '||left(title,52) FROM coding_sessions WHERE \"createdAt\" > now() - interval '10 hours' ORDER BY \"createdAt\" DESC LIMIT 15"
    echo "--- chats created (10h) ---"
    q "SELECT left(id::text,8)||' crt='||to_char(\"createdAt\",'HH24:MI')||' | '||left(title,52) FROM crossmodel_chats WHERE \"createdAt\" > now() - interval '10 hours' ORDER BY \"createdAt\" DESC LIMIT 15"
    echo "--- MCP port bindings on A ---"
    sudo docker ps --format '{{.Names}} {{.Ports}}' | grep -i mcp
    echo "--- file evidence tickets (insert-if-absent) ---"
    sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A <<'SQL'
INSERT INTO user_feature_requests (id,"userId",type,title,description,status,priority,source,context,"createdAt","updatedAt")
SELECT gen_random_uuid()::text,
       COALESCE((SELECT id FROM users WHERE email='example-user@example.com' LIMIT 1),(SELECT id FROM users ORDER BY "createdAt" LIMIT 1)),
       'bug_report',
       'Fleet supervisor cites phantom sessions: dispatch receipts + owner items reference chats that do not exist',
       $$EVIDENCE (read-only DB probe FW29-B, 2026-08-29 ~18:42Z, supervisor chat c0e22e36):
- Supervisor wake notes 17:55Z-18:38Z claim it dispatched session 1ca12570-0921-4a94-a857-f0b9b75f8933 (verify-herd fix for ticket 6bf8ce36, project e5734bd2) and tracked it RUNNING with elapsed-time updates for ~25 min. No crossmodel_chats or coding_sessions row with id 1ca12570% exists.
- Same for C1 session 79464b3d (session-UI implementation per directive 1174b4c2, reported RUNNING ~70 min). No row exists.
- Supervisor nagged the owner across many wakes to reply in chat 2d4ff22f (CPT training launch prep), including "fresh pull this wake: no assistant reply yet" claims at 18:36Z and 18:38Z. No crossmodel_chats row with id 2d4ff22f% exists - a fresh pull is impossible. These claims POSTDATE the PR #490 deploy (health-check green 17:49Z), so the merged evidence-citation guard does not cover this lane.
IMPACT: tickets 6bf8ce36 + 71b1fec6 are marked in_progress on the strength of dispatch receipts that point at nothing; owner-decision items reference dead targets; every wake-note table loses trust.
ASK: (1) determine whether dispatch tool calls failed silently vs ids fabricated in prose (compare supervisor run tool-call parts against DB); (2) extend the evidence guard to dispatch receipts and owner-item chat references - existence-check any cited chat/session id against the DB before it may appear in a wake note; (3) reconcile who is actually working 6bf8ce36 and 71b1fec6, and re-dispatch for real if nobody.$$,
       'open',1,'agent',
       jsonb_build_object('surface','fleet-supervisor','area','coding','filedAt',now()::text,'sessionId','c0e22e36','probe','FW29-B'),
       NOW(),NOW()
WHERE NOT EXISTS (SELECT 1 FROM user_feature_requests WHERE title LIKE 'Fleet supervisor cites phantom sessions%');
INSERT INTO user_feature_requests (id,"userId",type,title,description,status,priority,source,context,"createdAt","updatedAt")
SELECT gen_random_uuid()::text,
       COALESCE((SELECT id FROM users WHERE email='example-user@example.com' LIMIT 1),(SELECT id FROM users ORDER BY "createdAt" LIMIT 1)),
       'bug_report',
       'Box C worker cannot resolve *_MCP_URL docker aliases - MCP tool calls fail for all coding-box sessions',
       $$EVIDENCE (probe FW29-D on example-ca-node, 2026-08-29 18:42Z):
- Worker env on box C: GITHUB_MCP_URL=http://github-mcp-prod:8000/mcp (same alias pattern for GOOGLE/SLACK/ASANA/X). These are docker-network aliases that exist only on box A compose network.
- getent hosts github-mcp-prod from the box C worker: UNRESOLVABLE.
- Live failure: "GitHub MCP github_get_issue failed: getaddrinfo EAI_AGAIN github-mcp-prod" x4 at 18:17Z in admin-worker-green logs on C.
IMPACT: every coding session executing on box C (ALL sessions since the 2026-08-27 migration) silently loses GitHub/Google/Slack/Asana/X MCP tools; agents see repeated tool errors and degrade.
FIX PATH: box-local override on C pointing at box A private-IP published ports (GOOGLE 8201 / GITHUB 8202 / X 8203 / SLACK 8204 / ASANA 8205 -> http://10.0.0.11:PORT/mcp) via /opt/crossmodel-local/env-overrides.env. Probe FW29-F stages this automatically for each port that answers from C (curl from C proves host-port publish + SG together); takes effect on the next deploy worker recreate. If FW29-F reports SG-BLOCKED, add an intra-SG allow for 8201-8205 first. Verify afterwards: no EAI_AGAIN in worker logs and a github_get_issue succeeds from a C session.$$,
       'open',1,'agent',
       jsonb_build_object('surface','coding-worker','area','infra','filedAt',now()::text,'box','example-ca-node','probe','FW29-D'),
       NOW(),NOW()
WHERE NOT EXISTS (SELECT 1 FROM user_feature_requests WHERE title LIKE 'Box C worker cannot resolve%');
\echo '-- filed --'
SELECT left(id::text,8)||' '||status||' | '||left(title,60) FROM user_feature_requests WHERE title LIKE 'Fleet supervisor cites phantom sessions%' OR title LIKE 'Box C worker cannot resolve%';
SQL
    echo "== END FW29-E =="
    sudo touch "$MARKER_FW29E"
  fi

  # ── ONE-SHOT (2026-08-29h, prod): .env MCP URL values on A (read-only; URLs are not secrets). ──
  MARKER_FW29H=/var/tmp/.digby-fw29h-20260829h
  if [ ! -f "$MARKER_FW29H" ]; then
    echo "== FW29-H host=$(hostname) =="
    sudo grep -E '^(GOOGLE|GITHUB|X|SLACK|ASANA)_MCP_URL=' /opt/crossmodel/.env || echo "no MCP_URL keys in .env"
    echo "== END FW29-H =="
    sudo touch "$MARKER_FW29H"
  fi

  # ── ONE-SHOT (2026-08-29m, prod): MCP tools/list BASELINE from box-A worker (read-only, ticket 96f41cb3 classify). ──
  # FW29-L from box C: X 200 + full tool catalog; GOOGLE/GITHUB/SLACK/ASANA 401 with the
  # worker's own X-API-Key. The gateways run HERE on A — the IDENTICAL probe from A's own
  # worker is the baseline: if A also 401s those 4, the 401s are a pre-existing fleet-wide
  # gateway-auth condition (NOT a C regression); if A gets 200s, C's key values mismatch
  # A's gateways and need a sync. Key values are never echoed (request headers only).
  MARKER_FW29M=/var/tmp/.digby-fw29m-20260829m
  if [ ! -f "$MARKER_FW29M" ]; then
    echo "== FW29-M host=$(hostname) =="
    WN=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    if [ -z "$WN" ]; then echo "NO WORKER on A"; else
      sudo docker exec "$WN" node -e '(async()=>{const defs=[["GOOGLE","GOOGLE_MCP_URL","GOOGLE_MCP_API_KEY"],["GITHUB","GITHUB_MCP_URL","GITHUB_MCP_API_KEY"],["X","X_MCP_URL","X_MCP_API_KEY"],["SLACK","SLACK_MCP_URL","SLACK_MCP_API_KEY"],["ASANA","ASANA_MCP_URL","ASANA_MCP_API_KEY"]];for(const[n,uv,kv]of defs){const u=process.env[uv]||"(unset)";const k=process.env[kv]||"";if(!k){console.log(n,u,"-> SKIP no "+kv);continue}try{const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json","accept":"application/json, text/event-stream","x-api-key":k},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}}),signal:AbortSignal.timeout(8000)});const t=await r.text();const m=t.match(/"name"\s*:\s*"([^"]+)"/);console.log(n,u,"-> http",r.status,"| first tool:",m?m[1]:"(none parsed)","| bytes:",t.length)}catch(e){console.log(n,u,"-> FAIL",(e.cause&&e.cause.code)||e.message)}}})()' 2>&1
    fi
    echo "== END FW29-M =="
    sudo touch "$MARKER_FW29M"
  fi


  # ── ONE-SHOT (2026-09-04, prod): CH0904 — coding-harness retrieval health after the
  #    ca0c3a4 deploy (read-only). Answers: are the new coding_retrieval_* metrics
  #    accruing, are coding runs finishing, what does the memory store hold, any
  #    embed outages (NULL-embedding rows). ──
  MARKER_CH0904=/var/tmp/.digby-ch0904-20260904
  if [ ! -f "$MARKER_CH0904" ]; then
    echo "== CH0904 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-backend') || true
    if [ -z "$BK" ]; then echo "NO BACKEND CONTAINER"; else
      BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
      q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -40; }
      echo "-- 1. retrieval metric rows since deploy (10h) --"
      q "SELECT kind||' rows='||COUNT(*)||' sum_value='||COALESCE(SUM(value),0) FROM loop_metrics WHERE kind IN ('coding_retrieval_usage','coding_retrieval_hits') AND \"createdAt\" > now() - interval '10 hours' GROUP BY kind"
      echo "-- 2. per-run retrieval usage (10h): runs / runs-with-retrieval / avg calls --"
      q "SELECT 'runs='||COUNT(*)||' with_retrieval='||COUNT(*) FILTER (WHERE value > 0)||' avg_calls='||COALESCE(ROUND(AVG(value)::numeric,2),0) FROM loop_metrics WHERE kind='coding_retrieval_usage' AND \"createdAt\" > now() - interval '10 hours'"
      echo "-- 3. newest 6 usage rows (trigger + tool mix) --"
      q "SELECT to_char(\"createdAt\",'HH24:MI')||' v='||COALESCE(value,0)||' '||COALESCE(meta::text,'') FROM loop_metrics WHERE kind='coding_retrieval_usage' ORDER BY \"createdAt\" DESC LIMIT 6"
      echo "-- 4. per-call hits by tool (10h): calls / empty --"
      q "SELECT COALESCE(meta->>'tool','?')||' calls='||COUNT(*)||' empty='||COUNT(*) FILTER (WHERE value=0) FROM loop_metrics WHERE kind='coding_retrieval_hits' AND \"createdAt\" > now() - interval '10 hours' GROUP BY 1"
      echo "-- 5. coding runs by status (10h) --"
      q "SELECT status||' n='||COUNT(*) FROM agent_runs WHERE \"createdAt\" > now() - interval '10 hours' GROUP BY status ORDER BY COUNT(*) DESC"
      echo "-- 6. digby_memory footprint (rows + NULL-embedding count per scope/source, top 12) --"
      q "SELECT scope_type||'/'||source||' rows='||COUNT(*)||' no_embed='||COUNT(*) FILTER (WHERE embedding IS NULL) FROM digby_memory GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 12"
      echo "-- 7. all metric kinds (10h) for context --"
      q "SELECT kind||' n='||COUNT(*) FROM loop_metrics WHERE \"createdAt\" > now() - interval '10 hours' GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 15"
      echo "-- 8. chat_search_usage grounding rate (24h) --"
      q "SELECT 'chat_runs='||COUNT(*)||' grounded='||COUNT(*) FILTER (WHERE (meta->>'webToolCalls')::int > 0) FROM loop_metrics WHERE kind='chat_search_usage' AND \"createdAt\" > now() - interval '24 hours'"
    fi
    echo "== END CH0904 =="
    sudo touch "$MARKER_CH0904"
  fi

  # ── ONE-SHOT (2026-09-04b, prod): CH0904B — retry of the two CH0904 queries that
  #    died on "aggregate functions are not allowed in GROUP BY" (the concatenated
  #    select expression WAS the GROUP BY target; group by the raw key instead).
  #    Adds the by-trigger usage split (schedule ticks dominate the denominator). ──
  MARKER_CH0904B=/var/tmp/.digby-ch0904b-20260904
  if [ ! -f "$MARKER_CH0904B" ]; then
    echo "== CH0904B host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-backend') || true
    if [ -z "$BK" ]; then echo "NO BACKEND CONTAINER"; else
      BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
      q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -40; }
      echo "-- 4b. per-call hits by tool (12h): calls / empty --"
      q "SELECT t||' calls='||n||' empty='||e FROM (SELECT COALESCE(meta->>'tool','?') AS t, COUNT(*) AS n, COUNT(*) FILTER (WHERE value=0) AS e FROM loop_metrics WHERE kind='coding_retrieval_hits' AND \"createdAt\" > now() - interval '12 hours' GROUP BY 1) s"
      echo "-- 6b. digby_memory footprint (top 12 scope/source) --"
      q "SELECT k||' rows='||n||' no_embed='||e FROM (SELECT scope_type||'/'||source AS k, COUNT(*) AS n, COUNT(*) FILTER (WHERE embedding IS NULL) AS e FROM digby_memory GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 12) s"
      echo "-- 9. usage split by trigger (12h): runs / with-retrieval / avg --"
      q "SELECT tr||' runs='||n||' with_retrieval='||w||' avg='||a FROM (SELECT COALESCE(meta->>'trigger','?') AS tr, COUNT(*) AS n, COUNT(*) FILTER (WHERE value>0) AS w, COALESCE(ROUND(AVG(value)::numeric,2),0) AS a FROM loop_metrics WHERE kind='coding_retrieval_usage' AND \"createdAt\" > now() - interval '12 hours' GROUP BY 1) s"
      echo "-- 10. usage on runs that did real work (any read/grep/web activity or retrieval) --"
      q "SELECT 'working_runs='||COUNT(*)||' with_retrieval='||COUNT(*) FILTER (WHERE value>0) FROM loop_metrics WHERE kind='coding_retrieval_usage' AND \"createdAt\" > now() - interval '12 hours' AND (value>0 OR (meta->>'grep')::int>0 OR (meta->>'readFile')::int>0 OR (meta->>'webPipe')::int>0)"
    fi
    echo "== END CH0904B =="
    sudo touch "$MARKER_CH0904B"
  fi

  # ── ONE-SHOT (2026-09-08sq, prod): starter-chip pipeline post-deploy diagnostics (read-only).
  #    The reasoning pipeline (c5621f8) ran for the test account after seeded facts but the
  #    old cached set kept being served (pending flipped false, data unchanged) — pull the
  #    quality telemetry rows, the per-user Redis keys, and the backend log lines. ──
  MARKER_SQ0908=/var/tmp/.digby-sq0908-20260908
  if [ ! -f "$MARKER_SQ0908" ]; then
    echo "== SQ0908 host=$(hostname) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-backend') || true
    if [ -z "$BK" ]; then echo "NO BACKEND CONTAINER"; else
      BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
      q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -60; }
      echo "-- 1. suggested_questions_quality rows (last 3h) --"
      q "SELECT to_char(\"createdAt\",'HH24:MI:SS')||' kept='||COALESCE(value::text,'-')||' meta='||COALESCE(meta::text,'{}') FROM loop_metrics WHERE kind='suggested_questions_quality' AND \"createdAt\" > now() - interval '3 hours' ORDER BY \"createdAt\" DESC LIMIT 20"
      echo "-- 2. utility_llm_dual_failure rows (last 3h) --"
      q "SELECT to_char(\"createdAt\",'HH24:MI:SS')||' '||COALESCE(meta::text,'{}') FROM loop_metrics WHERE kind='utility_llm_dual_failure' AND \"createdAt\" > now() - interval '3 hours' ORDER BY \"createdAt\" DESC LIMIT 10"
      echo "-- 3. redis keys for the test account (claudebot) --"
      U=f4350445-491b-4ab9-9bb0-f0c99d60ef12
      for k in "user:suggested-questions:$U" "user:suggested-questions:stale:$U" "user:suggested-questions:attempted:$U" "user:suggested-questions:failed:$U" "user:suggested-questions:fetching:$U"; do
        echo "  $k => ttl=$(sudo docker exec admin-redis-prod redis-cli TTL "$k" 2>/dev/null) val=$(sudo docker exec admin-redis-prod redis-cli GET "$k" 2>/dev/null | head -c 300)"
      done
      echo "-- 4. backend log lines on THIS box (last 90 min): suggested-questions / utilityChat / utilityLLM --"
      for C in $(sudo docker ps --format '{{.Names}}' | grep '^admin-backend'); do
        echo "  [$C]"
        sudo docker logs --since 90m "$C" 2>&1 | grep -E 'suggested-questions|utilityChat|utilityLLM' | tail -40 | cut -c1-900 || echo '  (none)'
      done
    fi
    echo "== END SQ0908 =="
    sudo touch "$MARKER_SQ0908"
  fi

  # ── ONE-SHOT (2026-09-09, prod): DR0909A — derailment telemetry BASELINE at the pre-flight merge (read-only). ──
  # Metrology rule (watch pass #7): breaker/pre-flight activity is visible ONLY in
  # loop_metrics kind guard_strike — never in worker logs. This read runs on the
  # merge push (pre-deploy code still serving) so the next read (DR0909B) has a
  # before/after: tool_derail_break should fall, tool_preflight should appear.
  MARKER_DR0909A=/var/tmp/.digby-dr0909a
  if [ ! -f "$MARKER_DR0909A" ]; then
    echo "== DR0909A host=$(hostname) now=$(date -u +%FT%TZ) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -40; }
    echo "--- guard_strike seams per hour, last 8h (seam | hour | n) ---"
    q "SELECT meta->>'seam' AS seam, to_char(date_trunc('hour', \"createdAt\"),'MM-DD HH24') AS h, count(*) FROM loop_metrics WHERE kind='guard_strike' AND \"createdAt\" > now() - interval '8 hours' AND meta->>'seam' IN ('tool_derail_break','tool_preflight','tool_repeat_break','transcript_repair') GROUP BY seam, h ORDER BY h, seam"
    echo "--- derail breaks by tool + perma, last 8h ---"
    q "SELECT meta->>'tool' AS tool, coalesce(meta->>'perma','false') AS perma, count(*) FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_derail_break' AND \"createdAt\" > now() - interval '8 hours' GROUP BY tool, perma ORDER BY count(*) DESC"
    echo "--- derail breaks by session, last 8h (top 8) ---"
    q "SELECT left(\"sessionId\",8) AS s, count(*) FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_derail_break' AND \"createdAt\" > now() - interval '8 hours' GROUP BY s ORDER BY count(*) DESC LIMIT 8"
    echo "--- last derail strike ---"
    q "SELECT to_char(\"createdAt\",'MM-DD HH24:MI:SS') AS t, meta->>'tool' AS tool, meta->>'perma' AS perma FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_derail_break' ORDER BY \"createdAt\" DESC LIMIT 1"
    echo "--- serving build (active color image created) ---"
    for C in $(sudo docker ps --format '{{.Names}}' | grep '^admin-backend'); do echo "  $C $(sudo docker inspect -f '{{.Created}}' "$C" 2>/dev/null)"; done
    echo "== END DR0909A =="
    sudo touch "$MARKER_DR0909A"
  fi

  # ── ONE-SHOT (2026-09-09, prod): DR0909B — derailment telemetry AFTER the pre-flight deploy (read-only). ──
  # Pair of DR0909A. Expected: tool_preflight rows appear (reason ungrounded_id /
  # tool_not_offered, with `intended`), tool_derail_break falls, no new perma bans.
  MARKER_DR0909B=/var/tmp/.digby-dr0909b
  if [ ! -f "$MARKER_DR0909B" ]; then
    echo "== DR0909B host=$(hostname) now=$(date -u +%FT%TZ) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -40; }
    echo "--- guard_strike seams per 15 min since 02:30Z (seam | slot | n) ---"
    q "SELECT meta->>'seam' AS seam, to_char(date_trunc('hour', \"createdAt\") + (floor(extract(minute from \"createdAt\")/15)*15) * interval '1 minute','HH24:MI') AS slot, count(*) FROM loop_metrics WHERE kind='guard_strike' AND \"createdAt\" > '2026-09-09T02:30Z' AND meta->>'seam' IN ('tool_derail_break','tool_preflight','tool_repeat_break','transcript_repair') GROUP BY seam, slot ORDER BY slot, seam"
    echo "--- pre-flight refusals by tool / reason / intended ---"
    q "SELECT meta->>'tool' AS tool, meta->>'reason' AS reason, coalesce(meta->>'intended','-') AS intended, count(*) FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_preflight' GROUP BY tool, reason, intended ORDER BY count(*) DESC"
    echo "--- derail breaks since 02:30Z by tool / perma / intended ---"
    q "SELECT meta->>'tool' AS tool, coalesce(meta->>'perma','false') AS perma, coalesce(meta->>'intended','-') AS intended, count(*) FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_derail_break' AND \"createdAt\" > '2026-09-09T02:30Z' GROUP BY tool, perma, intended ORDER BY count(*) DESC"
    echo "--- last 6 derail / preflight strikes ---"
    q "SELECT to_char(\"createdAt\",'HH24:MI:SS') AS t, meta->>'seam' AS seam, meta->>'tool' AS tool, coalesce(meta->>'reason', meta->>'perma') AS detail, left(\"sessionId\",8) AS s FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam' IN ('tool_derail_break','tool_preflight') ORDER BY \"createdAt\" DESC LIMIT 6"
    echo "--- runs active in the window (started or updated since 02:30Z) ---"
    q "SELECT status, count(*) FROM agent_runs WHERE \"updatedAt\" > '2026-09-09T02:30Z' GROUP BY status"
    echo "--- serving build (backend containers created) ---"
    for C in $(sudo docker ps --format '{{.Names}}' | grep '^admin-backend'); do echo "  $C $(sudo docker inspect -f '{{.Created}}' "$C" 2>/dev/null)"; done
    echo "--- backend errors mentioning preflight/derail (last 60m) ---"
    for C in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-(backend|worker)'); do sudo docker logs --since 60m "$C" 2>&1 | grep -iE 'tool-preflight|load_tool_group|TypeError|ReferenceError' | tail -5 | cut -c1-300; done
    echo "== END DR0909B =="
    sudo touch "$MARKER_DR0909B"
  fi

  # ── ONE-SHOT (2026-09-09, prod): DR0909D — derailment telemetry ~2h AFTER the pre-flight deploy (read-only). ──
  # Third point of the series (A baseline 03:01Z, B 04:15Z). Worker on C live since 03:38Z.
  MARKER_DR0909D=/var/tmp/.digby-dr0909d
  if [ ! -f "$MARKER_DR0909D" ]; then
    echo "== DR0909D host=$(hostname) now=$(date -u +%FT%TZ) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -40; }
    echo "--- guard_strike seams per 15 min since 03:30Z (seam | slot | n) ---"
    q "SELECT meta->>'seam' AS seam, to_char(date_trunc('hour', \"createdAt\") + (floor(extract(minute from \"createdAt\")/15)*15) * interval '1 minute','HH24:MI') AS slot, count(*) FROM loop_metrics WHERE kind='guard_strike' AND \"createdAt\" > '2026-09-09T03:30Z' AND meta->>'seam' IN ('tool_derail_break','tool_preflight','tool_repeat_break','transcript_repair') GROUP BY seam, slot ORDER BY slot, seam"
    echo "--- ALL guard_strike seams since 03:38Z (seam | n) ---"
    q "SELECT coalesce(meta->>'seam','(none)') AS seam, count(*) FROM loop_metrics WHERE kind='guard_strike' AND \"createdAt\" > '2026-09-09T03:38Z' GROUP BY seam ORDER BY count(*) DESC"
    echo "--- pre-flight refusals by tool / reason / intended ---"
    q "SELECT meta->>'tool' AS tool, meta->>'reason' AS reason, coalesce(meta->>'intended','-') AS intended, count(*) FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_preflight' GROUP BY tool, reason, intended ORDER BY count(*) DESC"
    echo "--- derail breaks since 03:30Z by tool / perma / intended ---"
    q "SELECT meta->>'tool' AS tool, coalesce(meta->>'perma','false') AS perma, coalesce(meta->>'intended','-') AS intended, count(*) FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_derail_break' AND \"createdAt\" > '2026-09-09T03:30Z' GROUP BY tool, perma, intended ORDER BY count(*) DESC"
    echo "--- last 6 derail / preflight strikes ---"
    q "SELECT to_char(\"createdAt\",'MM-DD HH24:MI:SS') AS t, meta->>'seam' AS seam, meta->>'tool' AS tool, coalesce(meta->>'reason', meta->>'perma') AS detail, left(\"sessionId\",8) AS s FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam' IN ('tool_derail_break','tool_preflight') ORDER BY \"createdAt\" DESC LIMIT 6"
    echo "--- runs since 03:38Z by status; tool_call volume proxy = loop_metrics rows/h ---"
    q "SELECT status, count(*) FROM agent_runs WHERE \"updatedAt\" > '2026-09-09T03:38Z' GROUP BY status"
    q "SELECT to_char(date_trunc('hour', \"createdAt\"),'HH24') AS h, kind, count(*) FROM loop_metrics WHERE \"createdAt\" > '2026-09-09T00:00Z' GROUP BY h, kind ORDER BY h, kind"
    echo "--- sessions that were derailing pre-deploy: status now ---"
    q "SELECT left(r.\"sessionId\",8) AS s, r.status, to_char(r.\"updatedAt\",'HH24:MI') AS upd FROM agent_runs r WHERE r.\"sessionId\" IN (SELECT DISTINCT \"sessionId\" FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_derail_break' AND \"createdAt\" > now() - interval '12 hours') AND r.\"updatedAt\" > '2026-09-09T03:38Z' ORDER BY r.\"updatedAt\" DESC LIMIT 12"
    echo "== END DR0909D =="
    sudo touch "$MARKER_DR0909D"
  fi

  # ── ONE-SHOT (2026-09-25, prod): DG0925 — decision gate (seat #19) production check (read-only). ──
  # Owner "check now": does TYPESAFE_API_KEY reach the app containers, which backend answers the
  # gate (TypeSafe Jev vs the DeepSeek logprob readout), are decision_gate rows landing, any errors.
  # Key handling: PRESENCE + LENGTH ONLY — the value is never printed.
  MARKER_DG0925=/var/tmp/.digby-dg0925b
  if [ ! -f "$MARKER_DG0925" ]; then
    echo "== DG0925 host=$(hostname) now=$(date -u +%FT%TZ) =="
    cnt() { local n; n=$(sudo grep -c "$1" "$2" 2>/dev/null); echo "${n:-nofile}"; }
    echo "--- decision-gate env in running app containers (key = presence/length only) ---"
    for C in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-(backend|worker)-(blue|green)$'); do
      printf '  %s: ' "$C"
      sudo docker exec "$C" sh -c 'echo "TYPESAFE_API_KEY=$([ -n "$TYPESAFE_API_KEY" ] && echo "present(len ${#TYPESAFE_API_KEY})" || echo MISSING) TYPESAFE_BASE_URL=${TYPESAFE_BASE_URL:-unset} TYPESAFE_MODEL=${TYPESAFE_MODEL:-unset} DECISION_GATE_DISABLED=${DECISION_GATE_DISABLED:-unset} DECISION_GATE_DEFAULT_MODE=${DECISION_GATE_DEFAULT_MODE:-unset} DEEPSEEK_API_KEY=$([ -n "$DEEPSEEK_API_KEY" ] && echo present || echo MISSING)"' 2>/dev/null || echo "exec failed"
    done
    echo "--- key transport on disk (line counts only) ---"
    echo "  /opt/crossmodel/.env: TYPESAFE_API_KEY set=$(cnt '^TYPESAFE_API_KEY=.\+' /opt/crossmodel/.env) empty=$(cnt '^TYPESAFE_API_KEY=$' /opt/crossmodel/.env) DECISION_GATE_*=$(cnt '^DECISION_GATE_' /opt/crossmodel/.env)"
    echo "  /opt/crossmodel-local/env-overrides.env: TYPESAFE|DECISION_GATE lines=$(cnt '^\(TYPESAFE\|DECISION_GATE\)' /opt/crossmodel-local/env-overrides.env)"
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-backend') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -40; }
    echo "--- decision_gate rows, last 48h (phase | purpose | backend | mode | ok | n | avg value) ---"
    q "SELECT meta->>'phase', meta->>'purpose', coalesce(meta->>'backend','(none)'), meta->>'mode', coalesce(meta->>'ok','-'), count(*), round(avg(value)::numeric,2) FROM loop_metrics WHERE kind='decision_gate' AND \"createdAt\" > now() - interval '48 hours' GROUP BY 1,2,3,4,5 ORDER BY 2,1,3"
    echo "--- shadow agreement by purpose, 48h (purpose | outcome rows | agreed % | avg confidence) ---"
    q "SELECT meta->>'purpose', count(*), round(100*avg(value)::numeric,1), round(avg((meta->>'confidence')::numeric),3) FROM loop_metrics WHERE kind='decision_gate' AND meta->>'phase'='outcome' AND \"createdAt\" > now() - interval '48 hours' GROUP BY 1 ORDER BY 2 DESC"
    echo "--- all-time first / last / total decision_gate rows ---"
    q "SELECT min(\"createdAt\"), max(\"createdAt\"), count(*) FROM loop_metrics WHERE kind='decision_gate'"
    echo "--- distinct errors, 48h ---"
    q "SELECT left(meta->>'error',170), count(*) FROM loop_metrics WHERE kind='decision_gate' AND meta->>'error' IS NOT NULL AND \"createdAt\" > now() - interval '48 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 6"
    echo "--- last 8 rows (t | phase | purpose | backend | value | answers/predicted/error) ---"
    q "SELECT to_char(\"createdAt\",'MM-DD HH24:MI:SS'), meta->>'phase', meta->>'purpose', coalesce(meta->>'backend','-'), value, left(coalesce(meta->>'answers', meta->>'predicted', meta->>'error'),90) FROM loop_metrics WHERE kind='decision_gate' ORDER BY \"createdAt\" DESC LIMIT 8"
    echo "--- model-roles override row (decision seat / fallbacks, if any) ---"
    q "SELECT left(value::text, 400) FROM store WHERE namespace_path='instance:model-roles' LIMIT 1"
    echo "--- backend/worker log lines mentioning the gate (24h, last 12 per container) ---"
    for C in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-(backend|worker)-(blue|green)$'); do
      echo "  [$C]"; timeout 120 sudo docker logs --since 24h "$C" 2>&1 | grep -iE 'decision-gate|decision gate|typesafe' | tail -12 | cut -c1-260 || echo '  (none)'
    done
    echo "== END DG0925 =="
    sudo touch "$MARKER_DG0925"
  fi

  # ── ONE-SHOT (2026-09-25, prod): DG0925D — decision_gate telemetry, SQL leg re-run past the egress guard (read-only). ──
  # DG0925B's psql legs got "connection refused": `docker run` without --network lands on the default
  # bridge, and sandbox-egress-guard.sh (2026-09-24) rejects bridge → VPC (RDS). Host networking is the
  # sanctioned path (the nightly backup's dump legs moved the same way in ccfa7c24). Key presence was
  # already confirmed by DG0925B (len 107 in backend + worker on A and C) — not repeated here.
  MARKER_DG0925D=/var/tmp/.digby-dg0925d
  if [ ! -f "$MARKER_DG0925D" ]; then
    echo "== DG0925D host=$(hostname) now=$(date -u +%FT%TZ) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-backend') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm --network host -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -40; }
    echo "--- decision_gate rows, last 48h (phase | purpose | backend | mode | ok | n | avg value) ---"
    q "SELECT meta->>'phase', meta->>'purpose', coalesce(meta->>'backend','(none)'), meta->>'mode', coalesce(meta->>'ok','-'), count(*), round(avg(value)::numeric,2) FROM loop_metrics WHERE kind='decision_gate' AND \"createdAt\" > now() - interval '48 hours' GROUP BY 1,2,3,4,5 ORDER BY 2,1,3"
    echo "--- shadow agreement by purpose, 48h (purpose | outcome rows | agreed % | avg confidence) ---"
    q "SELECT meta->>'purpose', count(*), round(100*avg(value)::numeric,1), round(avg((meta->>'confidence')::numeric),3) FROM loop_metrics WHERE kind='decision_gate' AND meta->>'phase'='outcome' AND \"createdAt\" > now() - interval '48 hours' GROUP BY 1 ORDER BY 2 DESC"
    echo "--- rows per hour, last 12h (hour | n | on TypeSafe Jev) ---"
    q "SELECT to_char(date_trunc('hour', \"createdAt\"),'MM-DD HH24'), count(*), count(*) FILTER (WHERE meta->>'backend'='TypeSafe Jev') FROM loop_metrics WHERE kind='decision_gate' AND \"createdAt\" > now() - interval '12 hours' GROUP BY 1 ORDER BY 1"
    echo "--- all-time first / last / total decision_gate rows ---"
    q "SELECT min(\"createdAt\"), max(\"createdAt\"), count(*) FROM loop_metrics WHERE kind='decision_gate'"
    echo "--- distinct errors, 48h ---"
    q "SELECT left(meta->>'error',170), count(*) FROM loop_metrics WHERE kind='decision_gate' AND meta->>'error' IS NOT NULL AND \"createdAt\" > now() - interval '48 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 6"
    echo "--- last 8 rows (t | phase | purpose | backend | value | answers/predicted/error) ---"
    q "SELECT to_char(\"createdAt\",'MM-DD HH24:MI:SS'), meta->>'phase', meta->>'purpose', coalesce(meta->>'backend','-'), value, left(coalesce(meta->>'answers', meta->>'predicted', meta->>'error'),90) FROM loop_metrics WHERE kind='decision_gate' ORDER BY \"createdAt\" DESC LIMIT 8"
    echo "--- model-roles override row (decision seat / fallbacks, if any) ---"
    q "SELECT left(value::text, 400) FROM store WHERE namespace_path='instance:model-roles' LIMIT 1"
    echo "== END DG0925D =="
    sudo touch "$MARKER_DG0925D"
  fi

  # NOTE (2026-09-25): psql/db legs in one-shots MUST use `docker run --network host` — the sandbox
  # egress guard rejects default-bridge containers → VPC (RDS "connection refused").
  # ── ONE-SHOT (2026-10-12, prod): STQ1012A — has any Digby session brought schooltime back up? (READ-ONLY) ──
  # Owner ask 2026-10-12 19:0xZ: "check on all agent and project sessions … have they gotten schooltime back up".
  # Reads the Schooltime project's chats (and any chat titled *school*): runs since the breach, tool receipts,
  # enabled schedules, the last few message heads; plus fleet-wide receipts / assistant messages that mention
  # schooltime / CQL-Public / Amplify since 2026-10-11. No writes. Every text field passes redactSecrets and is
  # clipped; only "STQ|" lines reach the log. Marker in /var/tmp; bump the name to run again.
  MARKER_STQ1012A=/var/tmp/.digby-stq1012a-schooltime-sessions
  if [ ! -f "$MARKER_STQ1012A" ]; then
    echo "== STQ1012A host=$(hostname) now=$(date -u +%FT%TZ) =="
    AC=$(cat /opt/crossmodel/.active-color 2>/dev/null || echo blue); BE="admin-backend-${AC}"
    echo "  backend: $BE"
    cat > /tmp/stq1012a.js <<'JS'
'use strict';
const prisma = require('/app/dist/config/database').default;
let red = (s) => s;
try { const ss = require('/app/dist/modules/crossmodel/platform/secret-scan'); red = (s) => ss.redactSecrets(String(s)).text; } catch {}
const clip = (s, n) => red(String(s ?? '')).replace(/\s+/g, ' ').slice(0, n);
const out = (...a) => console.log(['STQ', ...a].join('|'));
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 16) + 'Z' : '-');
const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const BREACH = '2026-10-10T18:00:00Z';
const SINCE = '2026-10-11T00:00:00Z';
(async () => {
  const projects = await q(`SELECT id, name, supervised FROM crossmodel_projects WHERE name ILIKE '%school%' ORDER BY "createdAt"`);
  for (const p of projects) out('project', p.id.slice(0, 8), clip(p.name, 60), `supervised=${p.supervised}`);
  const pids = projects.map((p) => p.id);
  const chats = await q(
    `SELECT id, title, "projectId", "isSupervisor", "updatedAt", "archivedAt" FROM crossmodel_chats
     WHERE ("projectId" = ANY($1::text[]) OR title ILIKE '%school%') AND "updatedAt" >= $2::timestamptz
     ORDER BY "updatedAt" DESC LIMIT 40`, pids, BREACH);
  const total = await q(`SELECT COUNT(*)::int AS n FROM crossmodel_chats WHERE "projectId" = ANY($1::text[]) OR title ILIKE '%school%'`, pids);
  out('chats', `active_since_breach=${chats.length}`, `total=${total[0].n}`);
  for (const c of chats) {
    const id8 = c.id.slice(0, 8);
    out('chat', id8, clip(c.title, 70), `sup=${c.isSupervisor}`, `upd=${iso(c.updatedAt)}`, `archived=${c.archivedAt ? iso(c.archivedAt) : 'no'}`);
    const runs = await q(`SELECT status, COUNT(*)::int AS n, MAX("createdAt") AS last FROM agent_runs WHERE "sessionId" = $1 AND "createdAt" >= $2::timestamptz GROUP BY status`, c.id, BREACH);
    if (runs.length) out('runs', id8, runs.map((r) => `${r.status}=${r.n}@${iso(r.last)}`).join(' '));
    const live = await q(`SELECT id, status, "startedAt", "heartbeatAt" FROM agent_runs WHERE "sessionId" = $1 AND status IN ('queued','running')`, c.id);
    for (const r of live) out('live_run', id8, r.id.slice(0, 8), r.status, `started=${iso(r.startedAt)}`, `hb=${iso(r.heartbeatAt)}`);
    const sch = await q(`SELECT id, enabled, "nextRunAt", LEFT(prompt, 400) AS p FROM coding_schedules WHERE "sessionId" = $1 AND enabled = true`, c.id);
    for (const s of sch) out('schedule', id8, s.id.slice(0, 8), `next=${iso(s.nextRunAt)}`, clip(s.p, 220));
    const tools = await q(`SELECT tool, ok, COUNT(*)::int AS n FROM run_tool_receipts WHERE "chatId" = $1 AND "createdAt" >= $2::timestamptz GROUP BY tool, ok ORDER BY n DESC LIMIT 25`, c.id, SINCE);
    if (tools.length) out('receipts', id8, tools.map((t) => `${t.tool}${t.ok ? '' : '(x)'}=${t.n}`).join(' '));
    const msgs = await q(`SELECT role, "createdAt", content FROM crossmodel_messages WHERE "chatId" = $1 AND "createdAt" >= $2::timestamptz ORDER BY "createdAt" DESC LIMIT 4`, c.id, SINCE);
    for (const m of msgs.reverse()) out('msg', id8, m.role, iso(m.createdAt), clip(m.content, 700));
  }
  // Fleet-wide: anything outside the Schooltime project touching it since 2026-10-11.
  const KW = `(content ILIKE '%schooltime%' OR content ILIKE '%203.0.113.12%' OR content ILIKE '%cql-public%')`;
  const fleet = await q(
    `SELECT m."chatId", c.title, c."projectId", COUNT(*)::int AS n, MAX(m."createdAt") AS last
       FROM crossmodel_messages m JOIN crossmodel_chats c ON c.id = m."chatId"
      WHERE m.role = 'assistant' AND m."createdAt" >= $1::timestamptz AND ${KW.replace(/content/g, 'm.content')}
        AND NOT (c."projectId" = ANY($2::text[]))
      GROUP BY m."chatId", c.title, c."projectId" ORDER BY last DESC LIMIT 15`, SINCE, pids);
  for (const f of fleet) out('fleet_mention', f.chatId.slice(0, 8), clip(f.title, 60), `n=${f.n}`, `last=${iso(f.last)}`);
  const deployish = await q(
    `SELECT m."chatId", m."createdAt", m.content FROM crossmodel_messages m
      WHERE m.role = 'assistant' AND m."createdAt" >= $1::timestamptz AND m.content ILIKE '%schooltime%'
        AND (m.content ILIKE '%deploy%' OR m.content ILIKE '%amplify%' OR m.content ILIKE '%relaunch%' OR m.content ILIKE '%back up%' OR m.content ILIKE '%is live%' OR m.content ILIKE '%restored%')
      ORDER BY m."createdAt" DESC LIMIT 6`, SINCE);
  for (const d of deployish) out('deploy_mention', d.chatId.slice(0, 8), iso(d.createdAt), clip(d.content, 600));
  out('done');
  process.exit(0);
})().catch((e) => { out('error', clip(e && e.message, 200)); process.exit(1); });
JS
    sudo docker cp /tmp/stq1012a.js "$BE:/tmp/stq1012a.js" && \
      timeout 300 sudo docker exec -w /app "$BE" node /tmp/stq1012a.js 2>&1 | grep -E '^STQ\|' || echo "  query exited non-zero / printed nothing"
    sudo docker exec "$BE" rm -f /tmp/stq1012a.js >/dev/null 2>&1 || true
    rm -f /tmp/stq1012a.js
    echo "== END STQ1012A =="
    sudo touch "$MARKER_STQ1012A"
  fi

  # ── ONE-SHOT (2026-10-20, prod): LDR1020B — lane-depth / turn-plan / model-pick readiness readout (READ-ONLY). ──
  # Prints only "LDR|" lines: the turn-plan config row (lane flags, canaries, modelPick), the bench scorecard summary,
  # 7 d of lane_depth rows, the Quick-lane stakes refusals, routing/plan sources on human turns, kill-switch env on A.
  # No writes, no message text, no user ids. Marker in /var/tmp; bump the name to run again.
  MARKER_LDR1020B=/var/tmp/.digby-ldr1020b-lane-readout
  if [ ! -f "$MARKER_LDR1020B" ]; then
    echo "== LDR1020B host=$(hostname) now=$(date -u +%FT%TZ) =="
    echo "  active color: $(cat /opt/crossmodel/.active-color 2>/dev/null || echo '?')"
    echo "  env lines on A (.env / overrides): LANE_*=$(grep -c '^LANE_' /opt/crossmodel/.env 2>/dev/null || echo 0)/$(sudo grep -c '^LANE_' /opt/crossmodel-local/env-overrides.env 2>/dev/null || echo 0) TURN_PLAN_*=$(grep -c '^TURN_PLAN_' /opt/crossmodel/.env 2>/dev/null || echo 0)/$(sudo grep -c '^TURN_PLAN_' /opt/crossmodel-local/env-overrides.env 2>/dev/null || echo 0)"
    cat > /tmp/ldr1020b.js <<'LDR_EOF'
'use strict';
const prisma = require('/app/dist/config/database').default;
const store = require('/app/dist/modules/crossmodel/memory/context-store');
const out = (...a) => console.log(['LDR', ...a].join('|'));
const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const j = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x));
(async () => {
  const cfg = (await store.storeGet(['instance', 'turn-plan'], 'config')) || {};
  const pick = {};
  for (const k of Object.keys(cfg)) {
    const v = cfg[k];
    pick[k] = Array.isArray(v) ? `[${v.length}]` : (v && typeof v === 'object' ? `{${Object.keys(v).join(',')}}` : v);
  }
  out('turnplan_config', j(pick));
  try {
    const ld = require('/app/dist/modules/crossmodel/platform/lane-depth');
    const regular = await ld.laneDepthFor('00000000-0000-4000-8000-000000000000');
    const guest = await ld.laneDepthFor(null);
    out('lane_effective', j({ modes: regular.modes, regularActs: regular.acts, guestActs: guest.acts }));
  } catch (e) { out('lane_effective_error', String(e && e.message).slice(0, 160)); }
  out('kill_env', j(Object.fromEntries(['LANE_DEPTH_DISABLED', 'LANE_CHECKER_DISABLED', 'LANE_FAIL_OPEN_DISABLED', 'LANE_RESEARCH_ROUTING_DISABLED', 'AUTO_MODEL_PICK_DISABLED', 'TURN_PLAN_DISABLED', 'QUICK_LANE_DISABLED', 'TURN_PLAN_QUICK_STAKES_CEILING', 'LANE_CHECKER_STAKES_CEILING'].map((k) => [k, process.env[k] || null]))));
  const sc = await store.storeGet(['instance', 'model-bench'], 'scorecard');
  if (sc && sc.models) {
    out('scorecard', `updatedAt=${sc.updatedAt}`, `runs=${(sc.runs || []).slice(-8).join(',')}`, `specs=${Object.keys(sc.models).length}`);
    for (const [spec, card] of Object.entries(sc.models)) {
      out('scorecard_spec', spec, Object.entries((card && card.lanes) || {}).map(([l, s]) => `${l}:n${s.n}/q${s.quality == null ? '-' : Number(s.quality).toFixed(2)}`).join(' '));
    }
  } else out('scorecard', 'absent');
  const bench = await q(`SELECT split_part(c.title, ' ', 2) AS run, COUNT(*)::int AS n FROM crossmodel_chats c JOIN users u ON u.id = c."userId"
     WHERE u.email = 'claudebot@digby.ai' AND c.title LIKE 'model-bench %' GROUP BY 1 ORDER BY 1 DESC LIMIT 12`);
  for (const b of bench) out('bench_chats_kept', b.run, b.n);
  const ld7 = await q(`SELECT meta->>'segment' AS seg, coalesce(meta->>'canary','-') AS canary, coalesce(meta->>'lane','-') AS lane,
       coalesce(meta->>'wouldChecker','-') AS would, coalesce(meta->>'ranChecker','-') AS ran, coalesce(meta->>'applied','-') AS applied,
       coalesce(meta->>'source','-') AS src, coalesce(meta->'acts'->>'checker','-') AS acts, COUNT(*)::int AS n
     FROM loop_metrics WHERE kind = 'lane_depth' AND "createdAt" > now() - interval '7 days'
     GROUP BY 1,2,3,4,5,6,7,8 ORDER BY n DESC LIMIT 40`);
  for (const r of ld7) out('lane_depth_7d', r.seg, `canary=${r.canary}`, `lane=${r.lane}`, `wouldChecker=${r.would}`, `ranChecker=${r.ran}`, `applied=${r.applied}`, `src=${r.src}`, `actsChecker=${r.acts}`, `n=${r.n}`);
  const human = await q(`SELECT coalesce(m.metadata::jsonb->'depth'->'turnPlan'->>'lane','-') AS lane,
       coalesce(m.metadata::jsonb->'routing'->>'source','-') AS rsrc, coalesce(m.metadata::jsonb->'depth'->'plan'->>'source','-') AS psrc,
       COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE (m.metadata::jsonb->'depth'->'turnPlan'->'traits'->>'stakes')::float >= 0.6)::int AS stakes_ge_06,
       COUNT(*) FILTER (WHERE m.metadata::jsonb->'depth'->'turnPlan'->>'reason' ILIKE '%stakes%')::int AS reason_stakes
     FROM crossmodel_messages m JOIN crossmodel_chats c ON c.id = m."chatId"
     WHERE m.role = 'assistant' AND m."createdAt" > now() - interval '7 days'
       AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
       AND (m.metadata::jsonb) -> 'depth' ? 'turnPlan' AND NOT ((m.metadata::jsonb) ? 'origin')
     GROUP BY 1,2,3 ORDER BY n DESC LIMIT 30`);
  for (const r of human) out('human_turns_7d', `lane=${r.lane}`, `routing=${r.rsrc}`, `plan=${r.psrc}`, `n=${r.n}`, `stakes>=0.6=${r.stakes_ge_06}`, `reasonStakes=${r.reason_stakes}`);

  const plan7 = await q(`SELECT COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE m.metadata::jsonb->'depth'->'turnPlan'->>'reason' ILIKE 'no answer%')::int AS no_answer,
       COUNT(*) FILTER (WHERE NOT ((m.metadata::jsonb)->'depth' ? 'turnPlan'))::int AS no_plan,
       COUNT(*) FILTER (WHERE (m.metadata::jsonb->'depth'->'turnPlan'->>'lane') = 'quick'
          AND (m.metadata::jsonb->'depth'->'turnPlan'->'traits'->>'stakes')::float >= 0.6
          AND (m.metadata::jsonb->'depth'->'turnPlan'->'traits'->>'stakes')::float < 0.75
          AND (m.metadata::jsonb->'depth'->'turnPlan'->'traits'->>'needsLiveWeb')::float >= 0.8
          AND (m.metadata::jsonb->'depth'->'turnPlan'->'traits'->>'multiStep')::float < 0.5
          AND (m.metadata::jsonb->'depth'->'turnPlan'->'traits'->>'contested')::float < 0.2)::int AS lookup_newly_quick,
       COUNT(*) FILTER (WHERE (m.metadata::jsonb->'depth'->'turnPlan'->>'lane') = 'quick'
          AND (m.metadata::jsonb->'depth'->'turnPlan'->'traits'->>'stakes')::float >= 0.6)::int AS quick_blocked_stakes
     FROM crossmodel_messages m JOIN crossmodel_chats c ON c.id = m."chatId"
     WHERE m.role = 'assistant' AND m."createdAt" > now() - interval '7 days'
       AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
       AND (m.metadata::jsonb) ? 'routing' AND NOT ((m.metadata::jsonb) ? 'origin')`);
  for (const r of plan7) out('plan_health_7d', `n=${r.n}`, `noAnswer=${r.no_answer}`, `noPlan=${r.no_plan}`, `quickBlockedStakes=${r.quick_blocked_stakes}`, `lookupNewlyQuick(0.6-0.75,web>=.8,multi<.5,cont<.2)=${r.lookup_newly_quick}`);
  try {
    const cat = await require('/app/dist/modules/crossmodel/model-endpoints/model-catalog').listChatModelCatalog();
    const cards = Array.isArray(cat) ? cat : (cat && cat.cards) || [];
    for (const c of cards) out('catalog', c.spec, `servable=${c.servable}`, `auto=${c.autoEligible}`, `frontier=${!!c.frontier}`, `vision=${!!c.vision}`, `thinkingOff=${!!c.thinkingOff}`, `family=${c.family || '-'}`, `src=${c.source || '-'}`);
  } catch (e) { out('catalog_error', String(e && e.message).slice(0, 200)); }
  out('done');
  process.exit(0);
})().catch((e) => { out('error', String(e && e.message).slice(0, 240)); process.exit(1); });
LDR_EOF
    timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /tmp/ldr1020b.js 2>&1 | grep -E '^LDR\|' | cut -c1-700 || echo "  LDR1020B exited non-zero / printed nothing"
    rm -f /tmp/ldr1020b.js
    echo "== END LDR1020B =="
    sudo touch "$MARKER_LDR1020B"
  fi
  # ── WS1020 (2026-10-20, post-deploy probe for the worker-slot registry — deploy 910e34a; READ-ONLY one-shot,
  #    marker-guarded: runs once per box; delete the marker in a later one-shot to re-run) ──────────────────
  MARKER_WS1020=/opt/crossmodel-local/oneshot-WS1020.done
  if [ ! -f "$MARKER_WS1020" ]; then
  # Verifies deploy 910e34a: (1) compose forwards DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS +
  # WORKER_SLOT_REGISTRY_DISABLED into the backend; (2) box C's worker published its slots to
  # coding:worker:slots on THIS box's Redis; (3) the live backend's own read path resolves the
  # ceiling (readLiveWorkerSlots → 31 on box C); (4) project_supervisor_breaker rows by reason;
  # (5) per project supervisor: active children vs the ceiling (headroom); (6) worker-slots log lines.
  echo "== WS1020: worker-slot registry probe (read-only) =="
  WS_ACTIVE="$(sudo docker ps --format '{{.Names}}' | grep -E '^admin-backend-(blue|green)$' | head -1)"
  echo "WS|active_backend=${WS_ACTIVE:-none} started=$(sudo docker inspect -f '{{.State.StartedAt}}' "$WS_ACTIVE" 2>/dev/null || echo '?')"
  sudo docker exec "$WS_ACTIVE" sh -c 'env | grep -E "^(DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS|WORKER_SLOT_REGISTRY_DISABLED|CODING_WORKER_CONCURRENCY|BOX_NAME|DEPLOY_SHA)=" | sort | sed "s/^/WS|backend_env: /"' 2>/dev/null || echo "WS|backend_env: exec failed"
  echo "WS|redis HGETALL coding:worker:slots (box A redis):"
  sudo docker exec admin-redis-prod redis-cli HGETALL coding:worker:slots 2>&1 | sed 's/^/WS|  /'
  cat > /tmp/ws1020.js <<'WS_EOF'
const prisma = require('/app/dist/config/database').default;
const redisMod = require('/app/dist/config/redis');
const ws = require('/app/dist/modules/crossmodel/coding/worker-slots');
const out = (...a) => console.log(['WS', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))].join('|'));
(async () => {
  await redisMod.connectRedis();
  const raw = await redisMod.default.hGetAll(ws.WORKER_SLOTS_KEY);
  out('hash_fields', Object.keys(raw).length);
  for (const [k, v] of Object.entries(raw)) out('hash', k, v);
  const live = await ws.readLiveWorkerSlots();
  out('readLiveWorkerSlots', live);
  const env = process.env;
  const explicit = Number(env.DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS) > 0 ? Number(env.DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS) : 0;
  const own = Number(env.CODING_WORKER_CONCURRENCY) > 0 ? Number(env.CODING_WORKER_CONCURRENCY) : 0;
  const ceiling = explicit > 0 ? { cap: explicit, source: 'env' }
    : live && live.slots > 0 ? { cap: live.slots, source: 'live' }
    : own > 0 ? { cap: ws.machineClaimableSlots(own), source: 'process' }
    : { cap: 24, source: 'default' };
  out('ceiling_in_this_backend', ceiling, live ? ws.describeLiveWorkerSlots(live) : 'no live view');
  const rows = await prisma.$queryRawUnsafe(`SELECT meta->>'reason' AS reason, COALESCE(meta->>'capSource','-') AS cap_source, COUNT(*)::int AS n, MAX("createdAt") AS last FROM loop_metrics WHERE kind='project_supervisor_breaker' AND "createdAt" > now() - interval '7 days' GROUP BY 1,2 ORDER BY 3 DESC`);
  if (!rows.length) out('breaker_7d', 'no project_supervisor_breaker rows in 7 days');
  for (const r of rows) out('breaker_7d', `reason=${r.reason}`, `capSource=${r.cap_source}`, `n=${r.n}`, `last=${new Date(r.last).toISOString()}`);
  const sups = await prisma.$queryRawUnsafe(`SELECT id, LEFT(title, 40) AS title FROM crossmodel_chats WHERE "isProjectSupervisor" = true ORDER BY "updatedAt" DESC LIMIT 60`);
  out('project_supervisors', sups.length);
  let atCeiling = 0, aboveOld = 0;
  for (const s of sups) {
    const children = await prisma.crossModelChat.findMany({ where: { parentChatId: s.id }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 200 });
    const ids = children.map((c) => c.id);
    const states = ids.length ? await prisma.chatCodingState.findMany({ where: { id: { in: ids }, status: { in: ['provisioning', 'ready', 'running'] } }, select: { id: true, status: true } }) : [];
    const liveRuns = ids.length ? await prisma.agentRun.findMany({ where: { sessionId: { in: ids }, status: { in: ['queued', 'running'] } }, select: { sessionId: true } }) : [];
    const active = new Set(liveRuns.map((r) => r.sessionId)).size + states.filter((x) => x.status === 'provisioning').length;
    const verdict = active >= ceiling.cap ? 'AT_CEILING' : active >= 24 ? 'ABOVE_OLD_24_NOW_ALLOWED' : 'ok';
    if (verdict === 'AT_CEILING') atCeiling++; else if (verdict !== 'ok') aboveOld++;
    if (active > 0 || children.length >= 24) out('supervisor', s.id.slice(0, 8), s.title, `children=${ids.length}`, `active=${active}`, `ceiling=${ceiling.cap}`, verdict);
  }
  out('headroom_summary', `supervisors=${sups.length}`, `at_ceiling=${atCeiling}`, `between_24_and_ceiling=${aboveOld}`);
  out('done');
  process.exit(0);
})().catch((e) => { out('error', String(e && e.message).slice(0, 300)); process.exit(1); });
WS_EOF
  timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /tmp/ws1020.js 2>&1 | grep -E '^WS\|' | cut -c1-700 || echo "WS|probe exited non-zero / printed nothing"
  rm -f /tmp/ws1020.js
  for WS_CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-(backend|worker)'); do
    echo "WS|logs $WS_CN (worker-slots / spawn guard, last 2h):"
    sudo docker logs --since 2h "$WS_CN" 2>&1 | grep -i -E 'worker-slots|proj-sup spawn guard|coding worker .* started' | tail -5 | sed 's/^/WS|  /'
  done
  echo "== END WS1020 =="
  sudo mkdir -p /opt/crossmodel-local && sudo touch "$MARKER_WS1020"
  fi
  # ── ONE-SHOT (2026-10-20, prod): LDA1020 — lane-based depth for EVERY user (owner: "yes do all of this to make digby
  # more sota"). laneChecker → act. laneFailOpen STAYS shadow on purpose: readout LDR1020B showed 0 missing turn plans
  # in 96 human turns / 7 d, so its only live effect would be dropping the Double Checker on EVERY turn (high-stakes
  # ones included) during a classifier outage. laneResearch stays shadow until the guest/allowance denial is live (a
  # later one-shot). The flip must land on the NEW lane-depth code (follow-up hysteresis + unanswered-stakes keep), and
  # this workflow runs in PARALLEL with the deploy wave — so it launches a detached waiter that applies only once the
  # ACTIVE backend exports laneCheckerFollowUpDisabled, then 15 min more for box B's half of the wave. Result in
  # /var/tmp/lda1020.log (read back by a later one-shot). Rollback: prodq.sh set-lane-depth.js --apply --checker shadow.
  MARKER_LDA1020=/var/tmp/.digby-lda1020-lane-depth-act
  if [ ! -f "$MARKER_LDA1020" ] && ! systemctl is-active --quiet digby-lda1020; then
    echo "== LDA1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js 2>&1 | cut -c1-1500
    sudo tee /var/tmp/lda1020-readback.js >/dev/null <<'LDA_EOF'
'use strict';
(async () => {
  const ld = require('/app/dist/modules/crossmodel/platform/lane-depth');
  if (typeof ld.__resetLaneDepthConfigForTests === 'function') ld.__resetLaneDepthConfigForTests();
  const r = await ld.laneDepthFor('00000000-0000-4000-8000-000000000000');
  const g = await ld.laneDepthFor(null);
  const kill = Object.fromEntries(['LANE_DEPTH_DISABLED', 'LANE_CHECKER_DISABLED', 'LANE_FAIL_OPEN_DISABLED', 'LANE_RESEARCH_ROUTING_DISABLED', 'LANE_CHECKER_FOLLOW_UP_DISABLED', 'TURN_PLAN_DISABLED'].map((k) => [k, process.env[k] || null]));
  console.log('EFFECTIVE ' + JSON.stringify({ modes: r.modes, regularActs: r.acts, guestActs: g.acts, followUpFn: typeof ld.laneCheckerFollowUpDisabled === 'function', kill }));
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + String(e && e.message).slice(0, 240)); process.exit(1); });
LDA_EOF
    sudo tee /var/tmp/lda1020-waiter.sh >/dev/null <<'LDW_EOF'
#!/bin/bash
# Detached LDA1020 waiter: apply laneChecker=act only on the new lane-depth code (see playbook.sh LDA1020).
LOG=/var/tmp/lda1020.log
echo "waiter start $(date -u +%FT%TZ)" >> "$LOG"
for i in $(seq 1 120); do
  AC=$(cat /opt/crossmodel/.active-color 2>/dev/null || echo '')
  if [ -n "$AC" ] && docker exec "admin-backend-$AC" node -e "process.exit(typeof require('/app/dist/modules/crossmodel/platform/lane-depth').laneCheckerFollowUpDisabled==='function'?0:1)" >/dev/null 2>&1; then
    echo "new code live on admin-backend-$AC at $(date -u +%FT%TZ) (check $i) — waiting 900 s for box B" >> "$LOG"
    sleep 900
    AC=$(cat /opt/crossmodel/.active-color 2>/dev/null || echo '')
    if ! docker exec "admin-backend-$AC" node -e "process.exit(typeof require('/app/dist/modules/crossmodel/platform/lane-depth').laneCheckerFollowUpDisabled==='function'?0:1)" >/dev/null 2>&1; then
      echo "new code no longer live (rolled back?) — NOT applied" >> "$LOG"; exit 0
    fi
    OUT=$(timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js --apply --checker act 2>&1)
    printf '%s\n' "$OUT" | cut -c1-1500 >> "$LOG"
    timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/lda1020-readback.js 2>&1 | grep -E '^(EFFECTIVE|ERROR)' | cut -c1-900 >> "$LOG"
    if printf '%s' "$OUT" | grep -q '"applied":true'; then touch /var/tmp/.digby-lda1020-lane-depth-act; echo "APPLIED $(date -u +%FT%TZ)" >> "$LOG"; else echo "NOT applied" >> "$LOG"; fi
    exit 0
  fi
  sleep 60
done
echo "TIMEOUT — new code never went live in 120 min; NOT applied" >> "$LOG"
LDW_EOF
    sudo systemd-run --collect --unit=digby-lda1020 bash /var/tmp/lda1020-waiter.sh && echo "  launched detached waiter digby-lda1020 (log /var/tmp/lda1020.log)" || echo "  waiter launch FAILED"
    echo "== END LDA1020 =="
  fi
  # LDA1020 readback (any later run): print the waiter's log once it finished.
  if [ -f /var/tmp/lda1020.log ] && [ ! -f /var/tmp/.digby-lda1020-readback-shown ] && grep -qE '^(APPLIED|NOT applied|TIMEOUT|new code no longer)' /var/tmp/lda1020.log; then
    echo "== LDA1020 readback =="; tail -20 /var/tmp/lda1020.log | cut -c1-900; echo "== END LDA1020 readback =="; sudo touch /var/tmp/.digby-lda1020-readback-shown
  fi
  # ── ONE-SHOT (2026-10-20, prod): LRA1020 — laneResearch → act (owner: "yes do all of this to make digby more sota").
  # Safe only on the code that denies Level 3 to a guest / quota-refused sender up front (lane-depth researchDenyReason);
  # applied only when the ACTIVE backend exports it. Rollback: prodq.sh set-lane-depth.js --apply --research shadow.
  MARKER_LRA1020=/var/tmp/.digby-lra1020-lane-research-act
  if [ ! -f "$MARKER_LRA1020" ]; then
    echo "== LRA1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    LRA_AC=$(cat /opt/crossmodel/.active-color 2>/dev/null || echo '')
    if [ -n "$LRA_AC" ] && sudo docker exec "admin-backend-$LRA_AC" node -e "process.exit(typeof require('/app/dist/modules/crossmodel/platform/lane-depth').researchDenyReason==='function'?0:1)" >/dev/null 2>&1; then
      LRA_OUT=$(timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js --apply --research act 2>&1)
      printf '%s\n' "$LRA_OUT" | cut -c1-1500
      timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/lda1020-readback.js 2>&1 | grep -E '^(EFFECTIVE|ERROR)' | cut -c1-900
      if printf '%s' "$LRA_OUT" | grep -q '"applied":true'; then sudo touch "$MARKER_LRA1020"; else echo "  NOT applied — marker left unset"; fi
    else
      echo "  SKIPPED — the active backend (${LRA_AC:-?}) does not carry researchDenyReason yet; marker left unset"
    fi
    echo "== END LRA1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): MBK1020 — ingest the two-wave task-kind bench run mbk1020a (k:<kind> titles,
  # q1–q70 + q101–q170) into the scorecard. Judge: qwen3.6-27b (the only servable family no candidate shares — the
  # bench covers glm / deepseek / kimi). The ingest must be the version with the comparative-call retry
  # (judgeAttempts): this ec2-ops run starts beside the deploy wave that rsyncs it, so a DETACHED waiter polls
  # (≤ 120 min) for that copy before it runs (an ingest also outlives the playbook's 20-min bound). Log
  # /var/tmp/mbk1020.log (RESULT / EXIT lines); read back by RBK1020 on a later run.
  MARKER_MBK1020=/var/tmp/.digby-mbk1020-launched
  if [ ! -f "$MARKER_MBK1020" ]; then
    echo "== MBK1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/mbk1020-waiter.sh >/dev/null <<'MBK_EOF'
#!/bin/bash
LOG=/var/tmp/mbk1020.log
ING=/opt/crossmodel/scripts/framework-audit/model-bench-ingest.js
echo "waiter start $(date -u +%FT%TZ)" > "$LOG"
for i in $(seq 1 240); do
  if grep -q 'judgeAttempts' "$ING" 2>/dev/null; then break; fi
  sleep 30
done
if ! grep -q 'judgeAttempts' "$ING" 2>/dev/null; then echo "TIMEOUT: the retrying ingest never landed — nothing ingested" >> "$LOG"; echo "EXIT 9" >> "$LOG"; exit 0; fi
echo "ingest start $(date -u +%FT%TZ)" >> "$LOG"
bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id mbk1020a --apply --judge-model qwen3.6-27b --judge-attempts 3 >> "$LOG" 2>&1
echo "EXIT $?" >> "$LOG"
echo "ingest end $(date -u +%FT%TZ)" >> "$LOG"
MBK_EOF
    sudo systemd-run --collect --unit=digby-mbk1020 bash /var/tmp/mbk1020-waiter.sh \
      && sudo touch "$MARKER_MBK1020" && echo "  launched detached waiter digby-mbk1020 (log /var/tmp/mbk1020.log)" || echo "  waiter launch FAILED"
    echo "== END MBK1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): MBK1020V2 — the mbk1020a ingest, made deploy-proof. MBK1020 ran the ingest through
  # prodq.sh (docker exec into a blue/green backend), but deploy-blue-green.sh takes the OLD colour down after every
  # swap — any deploy wave (ours or another lane's) mid-ingest kills it, and prodq.sh may pick the old colour mid-swap.
  # V2 runs the ingest in its OWN container (the active backend's image + env + the shared admin network; env passed as
  # `-e KEY` from the runner's process env — nothing written to disk), so a blue/green teardown never touches it; up to
  # 3 attempts, each starting only when no deploy-blue-green.sh is running. Skipped when MBK1020 already succeeded.
  # Log /var/tmp/mbk1020v2.log (RESULT / "EXIT n" / "GAVE UP"); read back by RBK1020.
  MARKER_MBK1020V2=/var/tmp/.digby-mbk1020v2-launched
  if [ ! -f "$MARKER_MBK1020V2" ]; then
    echo "== MBK1020V2 host=$(hostname) now=$(date -u +%FT%TZ) =="
    echo "  first ingest unit: $(systemctl is-active digby-mbk1020 2>/dev/null || true)"
    grep -vE '^\s*$' /var/tmp/mbk1020.log 2>/dev/null | tail -8 | cut -c1-400
    if grep -q '^EXIT 0' /var/tmp/mbk1020.log 2>/dev/null && grep -q '"applied":true' /var/tmp/mbk1020.log 2>/dev/null; then
      echo "  MBK1020 already succeeded — V2 not needed"; sudo touch "$MARKER_MBK1020V2"
    else
      sudo tee /var/tmp/mbk1020-run.py >/dev/null <<'MBKV2_EOF'
#!/usr/bin/env python3
import json, os, subprocess, sys, time
LOG = '/var/tmp/mbk1020v2.log'
def log(s):
    with open(LOG, 'a') as f:
        f.write(s + '\n')
def deploying():
    return subprocess.run(['pgrep', '-f', 'deploy-blue-green.sh'], capture_output=True).returncode == 0
log('runner start ' + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
for attempt in range(1, 4):
    for _ in range(120):
        if not deploying():
            break
        time.sleep(30)
    try:
        ac = open('/opt/crossmodel/.active-color').read().strip()
        info = json.loads(subprocess.check_output(['docker', 'inspect', 'admin-backend-' + ac]))[0]
        env = dict(e.split('=', 1) for e in info['Config']['Env'])
        img = info['Config']['Image']
        net = 'crossmodel_admin-network' if 'crossmodel_admin-network' in info['NetworkSettings']['Networks'] else list(info['NetworkSettings']['Networks'])[0]
    except Exception as e:
        log('attempt %d: cannot read the active backend: %s' % (attempt, str(e)[:200])); time.sleep(60); continue
    name = 'digby-mbk1020-ingest-%d' % attempt
    subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
    args = ['docker', 'run', '--rm', '--name', name, '--network', net, '-w', '/app',
            '-v', '/opt/crossmodel/scripts/framework-audit:/fa:ro', '--entrypoint', 'node']
    for k in env:
        args += ['-e', k]
    args += [img, '/fa/model-bench-ingest.js', '--run-id', 'mbk1020a', '--apply', '--judge-model', 'qwen3.6-27b', '--judge-attempts', '3']
    log('attempt %d start %s colour %s image %s' % (attempt, time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), ac, img))
    with open(LOG, 'a') as f:
        rc = subprocess.run(args, env={**os.environ, **env}, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL).returncode
    log('EXIT %d' % rc)
    if rc == 0:
        sys.exit(0)
    time.sleep(120)
log('GAVE UP after 3 attempts')
MBKV2_EOF
      sudo systemd-run --collect --unit=digby-mbk1020v2 python3 /var/tmp/mbk1020-run.py \
        && sudo touch "$MARKER_MBK1020V2" && echo "  launched digby-mbk1020v2 (log /var/tmp/mbk1020v2.log)" || echo "  V2 launch FAILED"
    fi
    echo "== END MBK1020V2 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): RBK1020 — read back the mbk1020a kind-bench ingest (MBK1020) and, ONLY when it
  # applied cleanly and the scorecard holds deep kind buckets from that run for every benchmarked model, flip the
  # kind-aware pick to act (owner: "make sure the decision model is … choosing the best models for the job").
  # The act pick replaces the (model, lane) pick only where a kind bucket beats the seat past kindSwitchMargin.
  # Rollback: prodq.sh set-model-pick-kind.js --apply shadow (or MODEL_PICK_KIND_DISABLED=1).
  MARKER_RBK1020=/var/tmp/.digby-rbk1020-done
  if [ ! -f "$MARKER_RBK1020" ] && { [ -f /var/tmp/mbk1020.log ] || [ -f /var/tmp/mbk1020v2.log ]; }; then
    echo "== RBK1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    RBK_OK=0
    for RBK_LOG in /var/tmp/mbk1020.log /var/tmp/mbk1020v2.log; do
      [ -f "$RBK_LOG" ] || continue
      echo "  -- $RBK_LOG"; grep -vE '^\s*$' "$RBK_LOG" | tail -30 | cut -c1-600
      if grep -q '^EXIT 0' "$RBK_LOG" && grep -q '"applied":true' "$RBK_LOG"; then RBK_OK=1; fi
    done
    sudo tee /var/tmp/rbk1020-sc.js >/dev/null <<'RBK_EOF'
'use strict';
(async () => {
  const sc = require('/app/dist/modules/crossmodel/platform/model-bench-scorecard');
  if (typeof sc.clearModelBenchScorecardCache === 'function') sc.clearModelBenchScorecardCache();
  const card = await sc.readModelBenchScorecard({ fresh: true });
  if (!card) { console.log('SC none'); process.exit(0); }
  console.log('SC runs ' + JSON.stringify((card.runs || []).slice(-6)) + ' updatedAt ' + card.updatedAt);
  const RUN = 'mbk1020a';
  let deepByModel = {};
  for (const [spec, m] of Object.entries(card.models || {})) {
    const lanes = Object.fromEntries(Object.entries(m.lanes || {}).map(([l, b]) => [l, [b.quality, b.qualityN, b.ttftP50Ms, b.runId]]));
    const kinds = Object.fromEntries(Object.entries(m.kinds || {}).map(([k, b]) => [k, [b.quality, b.qualityN, b.fieldSize, b.ttftP50Ms, b.runId]]));
    deepByModel[spec] = Object.entries(m.kinds || {}).filter(([, b]) => b.runId === RUN && (b.qualityN || 0) >= 8).map(([k]) => k);
    console.log('SC model ' + spec + ' lanes ' + JSON.stringify(lanes));
    console.log('SC model ' + spec + ' kinds ' + JSON.stringify(kinds));
  }
  const field = ['glm-5.3', 'deepseek-flash', 'kimi-k3'];
  const common = ['writing', 'code', 'analysis', 'lookup', 'advice', 'planning', 'explain'].filter((k) => field.every((s) => (deepByModel[s] || []).includes(k)));
  console.log('KINDGATE ' + (common.length >= 5 ? 'ok' : 'thin') + ' ' + JSON.stringify(common));
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + String(e && e.message).slice(0, 240)); process.exit(1); });
RBK_EOF
    RBK_SC=$(timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/rbk1020-sc.js 2>&1)
    printf '%s\n' "$RBK_SC" | grep -E '^(SC|KINDGATE|ERROR)' | cut -c1-1800
    if [ "$RBK_OK" = 1 ] && printf '%s' "$RBK_SC" | grep -q '^KINDGATE ok'; then
      RBK_OUT=$(timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-model-pick-kind.js --apply act 2>&1)
      printf '%s\n' "$RBK_OUT" | cut -c1-1200
      if printf '%s' "$RBK_OUT" | grep -q '"applied":true'; then sudo touch "$MARKER_RBK1020"; fi
    elif [ "$RBK_OK" = 1 ]; then
      echo "  ingest applied but the kind gate did not pass — kind pick left in shadow"; sudo touch "$MARKER_RBK1020"
    elif grep -q '^GAVE UP' /var/tmp/mbk1020v2.log 2>/dev/null; then
      echo "  the deploy-proof ingest gave up after 3 attempts — kind pick left in shadow (marker unset; investigate the log above)"
    else
      echo "  ingest not finished (or the first, deploy-killed run only) — readback again on the next run (marker unset)"
    fi
    echo "== END RBK1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): WAG1020 — the workspace attach gate → act (real-user audit: a CODE_INTENT keyword
  # send — "fix the grammar: …" — converted any auto-filed chat into a coding session for good; a webhook frame's own
  # "delete the branch" converted every webhook chat). The gate went live in SHADOW with the deploy (its verdict rows
  # loop_metrics workspace_attach_gate are read back first); act keeps a confidently non-code keyword send a chat and a
  # webhook fire never converts a chat. Applied only when the ACTIVE backend carries the gate. Rollback: prodq.sh
  # set-workspace-attach-gate.js --apply shadow (or WORKSPACE_ATTACH_KIND_GATE_DISABLED=1).
  MARKER_WAG1020=/var/tmp/.digby-wag1020-attach-gate-act
  if [ ! -f "$MARKER_WAG1020" ]; then
    echo "== WAG1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    WAG_AC=$(cat /opt/crossmodel/.active-color 2>/dev/null || echo '')
    if [ -n "$WAG_AC" ] && sudo docker exec "admin-backend-$WAG_AC" node -e "process.exit(typeof require('/app/dist/modules/crossmodel/platform/turn-plan').workspaceAttachGateMode==='function'&&typeof require('/app/dist/modules/crossmodel/platform/workspace-attach-gate').preAskVerdict==='function'?0:1)" >/dev/null 2>&1; then
      sudo tee /var/tmp/wag1020-rows.js >/dev/null <<'WAG_EOF'
'use strict';
(async () => {
  const prisma = require('/app/dist/config/database').default;
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await prisma.loopMetric.findMany({ where: { kind: 'workspace_attach_gate', createdAt: { gte: since } }, select: { meta: true, value: true }, take: 5000 });
  const by = {};
  for (const r of rows) { const m = r.meta || {}; const k = `${m.mode}|${m.reason}|would=${m.wouldAttach}|kind=${m.kind}`; by[k] = (by[k] || 0) + 1; }
  const ms = rows.map((r) => r.value).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  console.log('WAGROWS ' + JSON.stringify({ n: rows.length, p50ms: ms.length ? ms[Math.floor(ms.length / 2)] : null, by }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.log('ERROR ' + String(e && e.message).slice(0, 240)); process.exit(1); });
WAG_EOF
      timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/wag1020-rows.js 2>&1 | grep -E '^(WAGROWS|ERROR)' | cut -c1-1500
      WAG_OUT=$(timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-workspace-attach-gate.js --apply act 2>&1)
      printf '%s\n' "$WAG_OUT" | cut -c1-1200
      if printf '%s' "$WAG_OUT" | grep -q '"applied":true'; then sudo touch "$MARKER_WAG1020"; else echo "  NOT applied — marker left unset"; fi
    else
      echo "  SKIPPED — the active backend (${WAG_AC:-?}) does not carry the attach gate yet; marker left unset"
    fi
    echo "== END WAG1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): WPL1020 — READ-ONLY: where does a web_pipe call spend its time? The real-user probe
  # measured web_pipe at 51–109 s per call (search_engine 2–28 s on the same turns) and 4 of 15 calls answered "found no
  # sources … no parseable organic links" after 7–75 s. Counts + latency quantiles only (never message text): loop_metrics
  # web_fetch_path per tool / winner tier / direct miss class, and the chat engine's persisted web_pipe call→result times
  # by outcome class, last 12 h; plus the hidden user-space projects' stored learning / decision row counts (by "from a
  # chat" provenance) and context blobs — what a purge would touch after the 2026-10-20 isolation. Marker only on a
  # complete read.
  MARKER_WPL1020=/var/tmp/.digby-wpl1020-webpipe-latency
  if [ ! -f "$MARKER_WPL1020" ]; then
    echo "== WPL1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/wpl1020-probe.js >/dev/null <<'WPL_EOF'
// probe-webpipe-latency-1020.js — READ-ONLY. Where does a web_pipe call spend its time? (2026-10-20 real-user audit)
//
// The real-user probe on 2026-10-20 measured web_pipe at 51–109 s per call (search_engine 2–28 s on the same turns)
// and 4 of 15 calls answered "found no sources: search responded but returned no parseable organic links" after
// 7–75 s. This reads, counts only (never message text):
//   fetch_path — loop_metrics web_fetch_path rows (one per direct-tier call) for the last N hours: per tool, the
//                winner tier, the direct miss class and latency quantiles.
//   pipe_calls — the chat engine's persisted tool parts (crossmodel_messages.parts) for the last N hours: per
//                web_pipe call the call→result duration and an outcome class (digest / no_parseable / search_failed /
//                unreadable / other), plus the same durations for search_engine and scrape_as_markdown.
// Usage (on the box): prodq.sh /var/tmp/wpl1020-probe.js [hours=12]  (written by the WPL1020 one-shot)
const prisma = require('/app/dist/config/database').default;

const hours = Math.max(1, Math.min(72, Number(process.argv[2]) || 12));
const since = new Date(Date.now() - hours * 3600_000);
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const stats = (xs) => ({ n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), max: xs.length ? Math.round(Math.max(...xs)) : null });

function pipeClass(text) {
  const t = String(text || '');
  if (/no parseable organic links/.test(t)) return 'no_parseable';
  if (/search call failed or was skipped|search backend failed/.test(t)) return 'search_failed';
  if (/could not read any of the/.test(t)) return 'unreadable';
  if (/found no sources/.test(t)) return 'no_sources_other';
  if (/summarize failed|chars stored\)/.test(t)) return 'index_only';
  return 'digest';
}

(async () => {
  const out = { probe: 'webpipe-latency-1020', hours, since: since.toISOString() };
  try {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'web_fetch_path', createdAt: { gte: since } }, select: { value: true, meta: true }, take: 20000 });
    const by = {};
    for (const r of rows) {
      const m = r.meta || {};
      const k = `${m.tool || '?'}|${m.winner || '?'}|${m.directOutcome || '?'}${m.directClass ? `:${m.directClass}` : ''}${m.hedged ? '|hedged' : ''}`;
      (by[k] = by[k] || []).push(Number(r.value) || 0);
    }
    out.fetch_path = Object.fromEntries(Object.entries(by).sort((a, b) => b[1].length - a[1].length).slice(0, 30).map(([k, v]) => [k, stats(v)]));
    out.fetch_path_meta_keys = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r.meta || {})))];
  } catch (e) { out.fetch_path = { error: String(e && e.message || e).slice(0, 200) }; }

  try {
    const msgs = await prisma.crossModelMessage.findMany({ where: { role: 'assistant', createdAt: { gte: since } }, select: { parts: true }, orderBy: { createdAt: 'desc' }, take: 3000 });
    const dur = { web_pipe: {}, search_engine: [], scrape_as_markdown: [] };
    let pipeMsgs = 0;
    for (const m of msgs) {
      const parts = Array.isArray(m.parts) ? m.parts : [];
      const pending = {};
      let saw = false;
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'tool_call') (pending[p.name] = pending[p.name] || []).push(p);
        if (p.type !== 'tool_result' || !['web_pipe', 'search_engine', 'scrape_as_markdown'].includes(p.name)) continue;
        const c = (pending[p.name] || []).shift();
        const ms = c && c.ts && p.ts ? Date.parse(p.ts) - Date.parse(c.ts) : null;
        if (ms == null || !Number.isFinite(ms) || ms < 0) continue;
        if (p.name === 'web_pipe') {
          saw = true;
          const k = pipeClass(p.result);
          (dur.web_pipe[k] = dur.web_pipe[k] || []).push(ms / 1000);
        } else dur[p.name].push(ms / 1000);
      }
      if (saw) pipeMsgs++;
    }
    out.pipe_calls = {
      scannedMessages: msgs.length, messagesWithWebPipe: pipeMsgs,
      web_pipe: Object.fromEntries(Object.entries(dur.web_pipe).map(([k, v]) => [k, stats(v)])),
      search_engine: stats(dur.search_engine), scrape_as_markdown: stats(dur.scrape_as_markdown),
    };
  } catch (e) { out.pipe_calls = { error: String(e && e.message || e).slice(0, 200) }; }

  // userspace_memory — the hidden user-space project's stored learnings / decisions (2026-10-20 isolation): plain
  // chats no longer read or write them; the counts say whether a purge is worth proposing. Counts only. "from a chat"
  // provenance also covers a human-typed coding-session turn (run-executor machineRun:false) — never a purge predicate.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT m.source AS source, (m.content LIKE '%from a chat%') AS chat_or_typed_coding_turn, count(*)::int AS n, count(DISTINCT m.scope_id)::int AS spaces
         FROM digby_memory m JOIN crossmodel_projects p ON p.id = m.scope_id
        WHERE m.scope_type = 'project' AND p."isUserSpace" = true AND m.source IN ('decision', 'learning')
        GROUP BY 1, 2`);
    const spaces = await prisma.crossModelProject.findMany({ where: { isUserSpace: true }, select: { id: true }, take: 20000 });
    const blobs = spaces.length ? await prisma.contextStoreEntry.count({ where: { namespacePath: { in: spaces.map((p) => `${p.id}:context`) }, key: 'state' } }) : 0;
    out.userspace_memory = { userSpaces: spaces.length, contextBlobs: blobs, rows: rows.map((r) => ({ source: r.source, chatOrTypedCodingTurn: r.chat_or_typed_coding_turn, n: r.n, spaces: r.spaces })) };
  } catch (e) { out.userspace_memory = { error: String(e && e.message || e).slice(0, 200) }; }

  // research_turns — how long a research council takes to answer (2026-10-20: a probe's "research … report" request
  // still had no answer at 40 min; only the Dig-deeper research rung is fitted to the depth budget's 15 min, a direct
  // research turn runs to the 40-min lead backstop). Last 7 d: synthesisTime quantiles by plan source, and the
  // council_dispatch_timeout rows (colleague attempts that hit the 12-min ceiling).
  try {
    const since7 = new Date(Date.now() - 7 * 86400_000);
    const rows = await prisma.crossModelMessage.findMany({ where: { role: 'assistant', createdAt: { gte: since7 }, metadata: { path: ['mode'], equals: 'deep_research' } }, select: { metadata: true }, take: 3000 });
    const by = {};
    for (const r of rows) {
      const m = r.metadata || {}; const plan = (m.depth && m.depth.plan) || {};
      const k = `${plan.source || '?'}|${plan.lane || '?'}|${m.escalationOf ? 'dig_deeper' : 'direct'}`;
      (by[k] = by[k] || []).push((Number(m.synthesisTime) || 0) / 1000);
    }
    const tmo = await prisma.loopMetric.findMany({ where: { kind: 'council_dispatch_timeout', createdAt: { gte: since7 } }, select: { meta: true }, take: 5000 });
    const tby = {};
    for (const t of tmo) { const m = t.meta || {}; const k = `attempt${m.attempt}|terminal=${!!m.terminal}${m.rungFit ? '|rungFit' : ''}`; tby[k] = (tby[k] || 0) + 1; }
    out.research_turns = { rows: rows.length, synthesisSec: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, stats(v)])), dispatchTimeouts: tby };
  } catch (e) { out.research_turns = { error: String(e && e.message || e).slice(0, 200) }; }

  console.log('RESULT_WPL ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('RESULT_WPL ' + JSON.stringify({ error: String(e && e.message || e).slice(0, 300) })); process.exit(0); });
WPL_EOF
    WPL_OUT=$(timeout 180 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/wpl1020-probe.js 12 2>&1)
    printf '%s\n' "$WPL_OUT" | grep -E '^RESULT_WPL' | cut -c1-6000
    if printf '%s' "$WPL_OUT" | grep -q '^RESULT_WPL {"probe"' && ! printf '%s' "$WPL_OUT" | grep '^RESULT_WPL' | grep -q '"error":'; then sudo touch "$MARKER_WPL1020"; else echo "  probe incomplete (no answer or a section errored) — marker left unset"; printf '%s\n' "$WPL_OUT" | tail -5 | cut -c1-400; fi
    echo "== END WPL1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): WPT1020 — READ-ONLY readback of the web_pipe fix (deploy 4c9f468e: straggler cut,
  # bounded unparseable-SERP retry, stage timings) and the L3 preset council fit. Counts + latency quantiles only (never
  # message text): loop_metrics web_pipe_timing rows (per-stage quantiles, straggler / not-started / retry outcomes) and
  # council_dispatch_timeout rows since 16:30Z. Marker only on a complete read.
  MARKER_WPT1020=/var/tmp/.digby-wpt1020-webpipe-timing
  if [ ! -f "$MARKER_WPT1020" ]; then
    echo "== WPT1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/wpt1020-probe.js >/dev/null <<'WPT_EOF'
const prisma = require('/app/dist/config/database').default;
const since = new Date('2026-10-20T16:30:00Z');
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const stats = (xs) => ({ n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), max: xs.length ? Math.round(Math.max(...xs)) : null });
(async () => {
  const out = { probe: 'wpt1020', since: since.toISOString() };
  try {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'web_pipe_timing', createdAt: { gte: since } }, select: { value: true, meta: true }, take: 5000 });
    const pick = (k) => rows.map((r) => Number((r.meta || {})[k])).filter((v) => Number.isFinite(v));
    const count = (k) => { const c = {}; for (const r of rows) { const v = String((r.meta || {})[k] ?? 'none'); c[v] = (c[v] || 0) + 1; } return c; };
    out.web_pipe_timing = {
      rows: rows.length, totalMs: stats(rows.map((r) => Number(r.value) || 0)), searchMs: stats(pick('searchMs')), retryMs: stats(pick('retryMs')),
      scrapeMs: stats(pick('scrapeMs')), storeMs: stats(pick('storeMs')), digestMs: stats(pick('digestMs')),
      stragglers: count('stragglers'), notStarted: count('notStarted'), serpRetry: count('serpRetry'), mode: count('mode'), ok: count('ok'), good: count('good'),
    };
  } catch (e) { out.web_pipe_timing = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const tmo = await prisma.loopMetric.findMany({ where: { kind: 'council_dispatch_timeout', createdAt: { gte: since } }, select: { meta: true }, take: 2000 });
    const c = {}; for (const t of tmo) { const m = t.meta || {}; const k = `attempt${m.attempt}|terminal=${!!m.terminal}`; c[k] = (c[k] || 0) + 1; }
    out.council_dispatch_timeout = { rows: tmo.length, by: c };
  } catch (e) { out.council_dispatch_timeout = { error: String(e && e.message || e).slice(0, 200) }; }
  console.log('RESULT_WPT ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('RESULT_WPT ' + JSON.stringify({ error: String(e && e.message || e).slice(0, 300) })); process.exit(0); });
WPT_EOF
    WPT_OUT=$(timeout 180 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/wpt1020-probe.js 2>&1)
    printf '%s\n' "$WPT_OUT" | grep -E '^RESULT_WPT' | cut -c1-4000
    if printf '%s' "$WPT_OUT" | grep -q '^RESULT_WPT {"probe"' && ! printf '%s' "$WPT_OUT" | grep '^RESULT_WPT' | grep -q '"error":'; then sudo touch "$MARKER_WPT1020"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$WPT_OUT" | tail -5 | cut -c1-400; fi
    echo "== END WPT1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): WPF1020 — READ-ONLY readback of the web_pipe FAST DIGEST (deploy 60ea3b92:
  # ≤ 300-word digest under an 800-token cap, session-RAG store in parallel). web_pipe_timing rows since 16:30Z split
  # by meta.fastDigest (true = new build): per-stage quantiles, digest chars, calls at the 60 s summarize timeout, and
  # how many digests fell back to the source index. Counts + latency quantiles only (never text). Marker only on a
  # complete read with >= 5 fast-digest rows (an earlier run before the deploy reads too few and stays re-runnable).
  MARKER_WPF1020=/var/tmp/.digby-wpf1020-fast-digest
  if [ ! -f "$MARKER_WPF1020" ]; then
    echo "== WPF1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/wpf1020-probe.js >/dev/null <<'WPF_EOF'
const prisma = require('/app/dist/config/database').default;
const since = new Date('2026-10-20T16:30:00Z');
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const stats = (xs) => ({ n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), max: xs.length ? Math.round(Math.max(...xs)) : null });
(async () => {
  const out = { probe: 'wpf1020', since: since.toISOString() };
  try {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'web_pipe_timing', createdAt: { gte: since } }, select: { value: true, meta: true, createdAt: true }, take: 5000 });
    const split = (fast) => {
      const rs = rows.filter((r) => ((r.meta || {}).fastDigest === true) === fast);
      const pick = (k) => rs.map((r) => Number((r.meta || {})[k])).filter((v) => Number.isFinite(v));
      return {
        rows: rs.length, firstAt: rs.length ? new Date(Math.min(...rs.map((r) => new Date(r.createdAt).getTime()))).toISOString() : null,
        totalMs: stats(rs.map((r) => Number(r.value) || 0)), searchMs: stats(pick('searchMs')), scrapeMs: stats(pick('scrapeMs')),
        storeMs: stats(pick('storeMs')), digestMs: stats(pick('digestMs')), digestChars: stats(pick('digestChars')),
        digestAtTimeout: pick('digestMs').filter((v) => v >= 59000).length,
        ok: rs.filter((r) => (r.meta || {}).ok === true).length,
      };
    };
    out.fast = split(true);
    out.old = split(false);
  } catch (e) { out.error = String(e && e.message || e).slice(0, 200); }
  console.log('RESULT_WPF ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('RESULT_WPF ' + JSON.stringify({ error: String(e && e.message || e).slice(0, 300) })); process.exit(0); });
WPF_EOF
    WPF_OUT=$(timeout 180 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/wpf1020-probe.js 2>&1)
    printf '%s\n' "$WPF_OUT" | grep -E '^RESULT_WPF' | cut -c1-4000
    if printf '%s' "$WPF_OUT" | grep -q '^RESULT_WPF {"probe"' && ! printf '%s' "$WPF_OUT" | grep '^RESULT_WPF' | grep -q '"error":' \
       && printf '%s' "$WPF_OUT" | grep '^RESULT_WPF' | grep -qE '"fast":\{"rows":([5-9]|[1-9][0-9]+),'; then sudo touch "$MARKER_WPF1020"; else echo "  probe incomplete or < 5 fast-digest rows — marker left unset"; printf '%s\n' "$WPF_OUT" | tail -3 | cut -c1-400; fi
    echo "== END WPF1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): MWV1020 — READ-ONLY readback of the memory wave (deploy 60ea3b92): per-item ops on the
  # memory extractors, fact versions, archive-on-evict, every-user dream, scheduled learnings dream. Counts / outcomes /
  # quantiles only — never fact values or message text. Marker only on a complete read.
  MARKER_MWV1020=/var/tmp/.digby-mwv1020-memory-wave
  if [ ! -f "$MARKER_MWV1020" ]; then
    echo "== MWV1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/mwv1020-probe.js >/dev/null <<'MWV_EOF'
const prisma = require('/app/dist/config/database').default;
const since = new Date('2026-10-20T18:46:44Z');
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
(async () => {
  const out = { probe: 'mwv1020', since: since.toISOString() };
  try {
    const mig = await prisma.$queryRawUnsafe(`SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = '20261020180000_user_memory_fact_versions'`);
    out.migration = (mig || []).map((m) => ({ name: m.migration_name, finished: !!m.finished_at }));
  } catch (e) { out.migration = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'memory_extraction', createdAt: { gte: since } }, select: { value: true, meta: true }, take: 20000 });
    const by = {};
    for (const r of rows) {
      const m = r.meta || {}; const s = String(m.source || 'none');
      const b = by[s] || (by[s] = { n: 0, outcome: {}, ops: 0, legacyShape: 0, finish: {}, throttledSkips: 0, clamped: 0, ms: [] });
      b.n++; inc(b.outcome, String(m.outcome || 'none'));
      const d = String(m.detail || '');
      if (d.startsWith('ops') || d.includes('; ops')) b.ops++;
      if (d.includes('legacy-shape')) b.legacyShape++;
      if (m.finishReason) inc(b.finish, String(m.finishReason));
      if (Number.isFinite(Number(m.throttledSkips))) b.throttledSkips += Number(m.throttledSkips);
      if (Array.isArray(m.clampedFields) && m.clampedFields.length) b.clamped++;
      if (Number.isFinite(Number(r.value))) b.ms.push(Number(r.value));
    }
    for (const b of Object.values(by)) { b.p50ms = q(b.ms, 0.5); b.p90ms = q(b.ms, 0.9); delete b.ms; }
    out.memory_extraction = { rows: rows.length, by };
  } catch (e) { out.memory_extraction = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const t = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS total, count(*) FILTER (WHERE "validTo" IS NULL)::int AS open, count(*) FILTER (WHERE "endedReason" = 'replaced')::int AS replaced, count(*) FILTER (WHERE "endedReason" = 'consolidated')::int AS consolidated, count(*) FILTER (WHERE source = 'backfill')::int AS backfill, count(*) FILTER (WHERE "sourceChatId" IS NOT NULL)::int AS with_chat, count(DISTINCT "userId")::int AS users, count(*) FILTER (WHERE "createdAt" >= $1)::int AS since_deploy FROM user_memory_fact_versions`, since);
    out.fact_versions = t[0];
  } catch (e) { out.fact_versions = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const ex = await prisma.$queryRawUnsafe(`SELECT to_regclass('digby_memory_archive') IS NOT NULL AS ok`);
    out.archive = { exists: !!(ex && ex[0] && ex[0].ok) };
    if (out.archive.exists) {
      out.archive.byScope = await prisma.$queryRawUnsafe(`SELECT scope_type, archive_reason, count(*)::int AS n FROM digby_memory_archive GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`);
    }
    const ev = await prisma.loopMetric.findMany({ where: { kind: 'memory_scope_evicted', createdAt: { gte: since } }, select: { value: true, meta: true }, take: 20000 });
    const e = { rows: ev.length, archivedRows: 0, archiveFailedRows: 0, plainRows: 0, evicted: 0, retention: 0 };
    for (const r of ev) { const m = r.meta || {}; if (m.reason === 'archive_retention') { e.retention += Number(r.value) || 0; continue; } e.evicted += Number(r.value) || 0; if (m.archived) e.archivedRows++; else if (m.archiveFailed) e.archiveFailedRows++; else e.plainRows++; }
    out.evictions = e;
  } catch (e) { out.archive = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const jobs = await prisma.cronJob.findMany({ where: { id: { in: ['memory-dream', 'memory-archive-retention', 'learnings-dream'] } }, select: { id: true, intervalSec: true, lastFiredAt: true, lastStatus: true, nextRunAt: true } });
    out.cron = jobs.map((j) => ({ id: j.id, interval: j.intervalSec, lastFiredAt: j.lastFiredAt, nextRunAt: j.nextRunAt, lastStatus: String(j.lastStatus || '').slice(0, 160) }));
  } catch (e) { out.cron = { error: String(e && e.message || e).slice(0, 200) }; }
  console.log('RESULT_MWV ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('RESULT_MWV ' + JSON.stringify({ error: String(e && e.message || e).slice(0, 300) })); process.exit(0); });
MWV_EOF
    MWV_OUT=$(timeout 180 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/mwv1020-probe.js 2>&1)
    printf '%s\n' "$MWV_OUT" | grep -E '^RESULT_MWV' | cut -c1-6000
    if printf '%s' "$MWV_OUT" | grep -q '^RESULT_MWV {"probe"'; then sudo touch "$MARKER_MWV1020"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$MWV_OUT" | tail -5 | cut -c1-400; fi
    echo "== END MWV1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): QTH1020 — does the Helper seat's qwen3.6-27b reason silently? (WPF1020: the fast
  # digest still takes p50 37 s for ~1,460 chars.) Six small DashScope calls from the live backend container — the
  # same digest prompt over a synthetic ~30k-char corpus, 2 × {qwen3.6-27b default, + enable_thinking:false,
  # qwen3.6-flash} — reporting latency, token usage (incl. reasoning tokens), finish reason and answer length.
  # Numbers only; no DB reads or writes. Marker only on a complete run.
  MARKER_QTH1020=/var/tmp/.digby-qth1020-helper-thinking
  if [ ! -f "$MARKER_QTH1020" ]; then
    echo "== QTH1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/qth1020-probe.js >/dev/null <<'QTH_EOF'
const axios = require('/app/node_modules/axios');
const { resolveProvider } = require('/app/dist/modules/crossmodel/coding/coding-model');
const words = 'market price index rate growth policy council report data analysis users system model city plan budget energy health water school transport housing climate trade review survey figure percent million annual quarter study'.split(' ');
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const sentence = () => { const n = 10 + Math.floor(rnd() * 14); const w = []; for (let i = 0; i < n; i++) w.push(words[Math.floor(rnd() * words.length)]); return w.join(' ') + ` ${Math.floor(rnd() * 900) + 10}.`; };
const source = (i) => { let t = ''; while (t.length < 7500) t += sentence() + ' '; return `--- SOURCE ${i}: Example page ${i} (https://example.org/${i}) ---\n${t}`; };
const corpus = [1, 2, 3, 4].map(source).join('\n\n');
const prompt = `Digest these web sources in at most 300 words in total:\n1. A tight summary of the key facts/figures (cite which source).\n2. One short line per source: what it contains.\n3. Last, a line "SEARCH_MEMORY QUERIES:" followed by 2-3 suggested search_memory queries for retrieving stored detail.\n\n${corpus}`;
const variants = [
  { name: 'qwen3.6-27b', model: 'qwen3.6-27b', extra: {} },
  { name: 'qwen3.6-27b+no-think', model: 'qwen3.6-27b', extra: { enable_thinking: false } },
  { name: 'qwen3.6-flash', model: 'qwen3.6-flash', extra: {} },
];
(async () => {
  const out = { probe: 'qth1020', corpusChars: corpus.length, runs: [] };
  for (let rep = 0; rep < 2; rep++) {
    for (const v of variants) {
      const p = resolveProvider(v.model);
      const body = { ...(p.extra || {}), model: p.model, messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0.3, ...v.extra };
      const t0 = Date.now();
      try {
        const r = await axios.post(p.url, body, { headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 });
        const c = r.data && r.data.choices && r.data.choices[0] || {};
        const u = r.data && r.data.usage || {};
        out.runs.push({ v: v.name, rep, ms: Date.now() - t0, finish: c.finish_reason, chars: String(c.message && c.message.content || '').length, reasoningChars: String(c.message && c.message.reasoning_content || '').length, prompt: u.prompt_tokens, completion: u.completion_tokens, reasoning: u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens });
      } catch (e) {
        out.runs.push({ v: v.name, rep, ms: Date.now() - t0, error: String(e && e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data).slice(0, 160)}` : (e && e.message) || e).slice(0, 220) });
      }
    }
  }
  console.log('RESULT_QTH ' + JSON.stringify(out));
})().catch((e) => { console.log('RESULT_QTH ' + JSON.stringify({ error: String(e && e.message || e).slice(0, 300) })); process.exit(0); });
QTH_EOF
    QTH_OUT=$(timeout 600 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/qth1020-probe.js 2>&1)
    printf '%s\n' "$QTH_OUT" | grep -E '^RESULT_QTH' | cut -c1-5000
    if printf '%s' "$QTH_OUT" | grep -q '^RESULT_QTH {"probe"'; then sudo touch "$MARKER_QTH1020"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$QTH_OUT" | tail -5 | cut -c1-400; fi
    echo "== END QTH1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): MWV1020B — READ-ONLY re-readback of the memory wave after box C's coding worker
  # rolled out (19:22:57Z, deploy run 39478205599): coding fold / dream rows on ops, archive-on-evict share, first every-user dream tick. Counts / outcomes /
  # quantiles only — never fact values or message text. Marker only on a complete read.
  MARKER_MWV1020B=/var/tmp/.digby-mwv1020b-memory-wave
  if [ ! -f "$MARKER_MWV1020B" ]; then
    echo "== MWV1020B host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/mwv1020b-probe.js >/dev/null <<'MWVB_EOF'
const prisma = require('/app/dist/config/database').default;
const since = new Date('2026-10-20T19:23:07Z');
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
(async () => {
  const out = { probe: 'mwv1020b', since: since.toISOString() };
  try {
    const mig = await prisma.$queryRawUnsafe(`SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = '20261020180000_user_memory_fact_versions'`);
    out.migration = (mig || []).map((m) => ({ name: m.migration_name, finished: !!m.finished_at }));
  } catch (e) { out.migration = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'memory_extraction', createdAt: { gte: since } }, select: { value: true, meta: true }, take: 20000 });
    const by = {};
    for (const r of rows) {
      const m = r.meta || {}; const s = String(m.source || 'none');
      const b = by[s] || (by[s] = { n: 0, outcome: {}, ops: 0, legacyShape: 0, finish: {}, budget: {}, throttledSkips: 0, clamped: 0, ms: [] });
      b.n++; inc(b.outcome, String(m.outcome || 'none'));
      const d = String(m.detail || '');
      if (d.startsWith('ops') || d.includes('; ops')) b.ops++;
      if (d.includes('legacy-shape')) b.legacyShape++;
      if (m.finishReason) inc(b.finish, String(m.finishReason));
      if (m.budgetTokens) inc(b.budget, String(m.budgetTokens));
      if (Number.isFinite(Number(m.throttledSkips))) b.throttledSkips += Number(m.throttledSkips);
      if (Array.isArray(m.clampedFields) && m.clampedFields.length) b.clamped++;
      if (Number.isFinite(Number(r.value))) b.ms.push(Number(r.value));
    }
    for (const b of Object.values(by)) { b.p50ms = q(b.ms, 0.5); b.p90ms = q(b.ms, 0.9); delete b.ms; }
    out.memory_extraction = { rows: rows.length, by };
  } catch (e) { out.memory_extraction = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const t = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS total, count(*) FILTER (WHERE "validTo" IS NULL)::int AS open, count(*) FILTER (WHERE "endedReason" = 'replaced')::int AS replaced, count(*) FILTER (WHERE "endedReason" = 'consolidated')::int AS consolidated, count(*) FILTER (WHERE source = 'backfill')::int AS backfill, count(*) FILTER (WHERE "sourceChatId" IS NOT NULL)::int AS with_chat, count(DISTINCT "userId")::int AS users, count(*) FILTER (WHERE "createdAt" >= $1)::int AS since_deploy FROM user_memory_fact_versions`, since);
    out.fact_versions = t[0];
  } catch (e) { out.fact_versions = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const ex = await prisma.$queryRawUnsafe(`SELECT to_regclass('digby_memory_archive') IS NOT NULL AS ok`);
    out.archive = { exists: !!(ex && ex[0] && ex[0].ok) };
    if (out.archive.exists) {
      out.archive.byScope = await prisma.$queryRawUnsafe(`SELECT scope_type, archive_reason, count(*)::int AS n FROM digby_memory_archive GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`);
    }
    const ev = await prisma.loopMetric.findMany({ where: { kind: 'memory_scope_evicted', createdAt: { gte: since } }, select: { value: true, meta: true }, take: 20000 });
    const e = { rows: ev.length, archivedRows: 0, archiveFailedRows: 0, plainRows: 0, evicted: 0, retention: 0 };
    for (const r of ev) { const m = r.meta || {}; if (m.reason === 'archive_retention') { e.retention += Number(r.value) || 0; continue; } e.evicted += Number(r.value) || 0; if (m.archived) e.archivedRows++; else if (m.archiveFailed) e.archiveFailedRows++; else e.plainRows++; }
    out.evictions = e;
  } catch (e) { out.archive = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const ix = await prisma.loopMetric.findMany({ where: { kind: 'index_swept', createdAt: { gte: since } }, select: { value: true, meta: true }, take: 5000 });
    const ld = ix.filter((r) => (r.meta || {}).index === 'learnings_dream');
    out.learnings_dream = { rows: ld.length, absorbed: ld.reduce((a, r) => a + (Number(r.value) || 0), 0), outcomes: ld.reduce((o, r) => { inc(o, String((r.meta || {}).outcome || 'none')); return o; }, {}) };
  } catch (e) { out.learnings_dream = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const jobs = await prisma.cronJob.findMany({ where: { id: { in: ['memory-dream', 'memory-archive-retention', 'learnings-dream'] } }, select: { id: true, intervalSec: true, lastFiredAt: true, lastStatus: true, nextRunAt: true } });
    out.cron = jobs.map((j) => ({ id: j.id, interval: j.intervalSec, lastFiredAt: j.lastFiredAt, nextRunAt: j.nextRunAt, lastStatus: String(j.lastStatus || '').slice(0, 160) }));
  } catch (e) { out.cron = { error: String(e && e.message || e).slice(0, 200) }; }
  console.log('RESULT_MWVB ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('RESULT_MWVB ' + JSON.stringify({ error: String(e && e.message || e).slice(0, 300) })); process.exit(0); });
MWVB_EOF
    MWVB_OUT=$(timeout 180 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/mwv1020b-probe.js 2>&1)
    printf '%s\n' "$MWVB_OUT" | grep -E '^RESULT_MWVB' | cut -c1-6000
    if printf '%s' "$MWVB_OUT" | grep -q '^RESULT_MWVB {"probe"'; then sudo touch "$MARKER_MWV1020B"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$MWVB_OUT" | tail -5 | cut -c1-400; fi
    echo "== END MWV1020B =="
  fi

  # ── ONE-SHOT (2026-10-20, prod): MWV1020C — READ-ONLY drain check for the memory wave. MWV1020B saw legacy-budget
  # project / coding-fold rows and plain evictions beside the new ops rows; the claim is that they come from box C's
  # draining pre-rollout worker. Buckets the rows since 19:23:07Z by 15 min (new vs legacy by output budget; archived
  # vs plain evictions) and counts the archive-unavailable warn. Counts only. Marker only on a complete read.
  MARKER_MWV1020C=/var/tmp/.digby-mwv1020c-memory-wave
  if [ ! -f "$MARKER_MWV1020C" ]; then
    echo "== MWV1020C host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/mwv1020c-probe.js >/dev/null <<'MWVC_EOF'
const prisma = require('/app/dist/config/database').default;
const since = new Date('2026-10-20T19:23:07Z');
const OPS_BUDGET = { project: 3000, coding_project_fold: 2500 };
const bucket = (d) => { const t = new Date(d); t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 15) * 15, 0, 0); return t.toISOString().slice(11, 16); };
(async () => {
  const out = { probe: 'mwv1020c', since: since.toISOString(), now: new Date().toISOString() };
  try {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'memory_extraction', createdAt: { gte: since } }, select: { createdAt: true, meta: true }, take: 20000 });
    const b = {};
    for (const r of rows) {
      const m = r.meta || {}; const s = String(m.source || 'none'); if (!(s in OPS_BUDGET)) continue;
      const k = bucket(r.createdAt); const e = b[k] || (b[k] = {});
      const cls = Number(m.budgetTokens) === OPS_BUDGET[s] ? 'ops' : 'legacy';
      e[s + ':' + cls] = (e[s + ':' + cls] || 0) + 1;
    }
    out.extraction_by_bucket = b;
  } catch (e) { out.extraction_by_bucket = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    const ev = await prisma.loopMetric.findMany({ where: { kind: 'memory_scope_evicted', createdAt: { gte: since } }, select: { createdAt: true, meta: true }, take: 20000 });
    const b = {};
    for (const r of ev) {
      const m = r.meta || {}; if (m.reason === 'archive_retention') continue;
      const k = bucket(r.createdAt); const e = b[k] || (b[k] = { archived: 0, failed: 0, plain: 0 });
      if (m.archived) e.archived++; else if (m.archiveFailed) e.failed++; else e.plain++;
    }
    out.evictions_by_bucket = b;
  } catch (e) { out.evictions_by_bucket = { error: String(e && e.message || e).slice(0, 200) }; }
  try {
    out.archive_unavailable_warns = await prisma.appErrorLog.count({ where: { createdAt: { gte: new Date('2026-10-20T18:40:00Z') }, message: { contains: 'digby_memory_archive unavailable' } } });
  } catch (e) { out.archive_unavailable_warns = { error: String(e && e.message || e).slice(0, 200) }; }
  console.log('RESULT_MWVC ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('RESULT_MWVC ' + JSON.stringify({ error: String(e && e.message || e).slice(0, 300) })); process.exit(0); });
MWVC_EOF
    MWVC_OUT=$(timeout 180 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/mwv1020c-probe.js 2>&1)
    printf '%s\n' "$MWVC_OUT" | grep -E '^RESULT_MWVC' | cut -c1-6000
    if printf '%s' "$MWVC_OUT" | grep -q '^RESULT_MWVC {"probe"'; then sudo touch "$MARKER_MWV1020C"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$MWVC_OUT" | tail -5 | cut -c1-400; fi
    echo "== END MWV1020C =="
  fi

  # ── ONE-SHOT (2026-10-20, prod): QTB1020 — READ-ONLY readback of the Helper-seat Qwen thinking-off fix (4f85eb1f,
  # live on A/B from deploy run 39498621779 at 22:04:14Z). QTH1020 measured qwen3.6-27b reasoning silently for ~20–30 s
  # per digest; web_pipe_timing fast-digest rows since the deploy should show digestMs falling from p50 37 s toward
  # ~6–10 s. Latency quantiles + counts only (never text). Marker only on a complete read with >= 3 rows since the
  # deploy (a quiet hour stays re-runnable).
  MARKER_QTB1020=/var/tmp/.digby-qtb1020-qwen-thinking-off
  if [ ! -f "$MARKER_QTB1020" ]; then
    echo "== QTB1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/qtb1020-probe.js >/dev/null <<'QTB_EOF'
const prisma = require('/app/dist/config/database').default;
const deployAt = new Date('2026-10-20T22:04:14Z');
const before = new Date('2026-10-20T16:30:00Z');
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const stats = (xs) => ({ n: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9), max: xs.length ? Math.round(Math.max(...xs)) : null });
(async () => {
  const out = { probe: 'qtb1020', deployAt: deployAt.toISOString() };
  try {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'web_pipe_timing', createdAt: { gte: before } }, select: { value: true, meta: true, createdAt: true }, take: 5000 });
    const fast = rows.filter((r) => (r.meta || {}).fastDigest === true);
    const part = (rs) => {
      const pick = (k) => rs.map((r) => Number((r.meta || {})[k])).filter((v) => Number.isFinite(v));
      return { rows: rs.length, totalMs: stats(rs.map((r) => Number(r.value) || 0)), digestMs: stats(pick('digestMs')), digestChars: stats(pick('digestChars')), digestAtTimeout: pick('digestMs').filter((v) => v >= 59000).length, ok: rs.filter((r) => (r.meta || {}).ok === true).length };
    };
    out.after = part(fast.filter((r) => new Date(r.createdAt) >= deployAt));
    out.before = part(fast.filter((r) => new Date(r.createdAt) < deployAt));
  } catch (e) { out.error = String(e && e.message || e).slice(0, 200); }
  console.log('RESULT_QTB ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('RESULT_QTB ' + JSON.stringify({ error: String(e && e.message || e).slice(0, 300) })); process.exit(0); });
QTB_EOF
    QTB_OUT=$(timeout 180 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/qtb1020-probe.js 2>&1)
    printf '%s\n' "$QTB_OUT" | grep -E '^RESULT_QTB' | cut -c1-4000
    if printf '%s' "$QTB_OUT" | grep -q '^RESULT_QTB {"probe"' && ! printf '%s' "$QTB_OUT" | grep '^RESULT_QTB' | grep -q '"error":' \
       && printf '%s' "$QTB_OUT" | grep '^RESULT_QTB' | grep -qE '"after":\{"rows":([3-9]|[1-9][0-9]+),'; then sudo touch "$MARKER_QTB1020"; else echo "  probe incomplete or < 3 rows since the deploy — marker left unset"; printf '%s\n' "$QTB_OUT" | tail -3 | cut -c1-400; fi
    echo "== END QTB1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): JBV1020 — judge v2 DRY re-ingest of bench run mbk1020a (owner: "fix the model
  # benchmarks" + "leave deepseek flash"). NO --apply: the live scorecard and every pick are untouched — the RESULT
  # (aggregates + --per-question scores / lengths, never text) is compared against a blind gold ranking first. A
  # detached waiter (≤ 120 min) starts it only once box A runs ONE backend container whose dist carries the v2 rubric
  # and the deployed ingest carries the v2 aggregator (this playbook runs while the deploy is still rolling out).
  # Marker on launch; JBR1020 below reads the log back.
  MARKER_JBV1020=/var/tmp/.digby-jbv1020-judge-v2-dry
  if [ ! -f "$MARKER_JBV1020" ]; then
    echo "== JBV1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/jbv1020-run.sh >/dev/null <<'JBV_EOF'
#!/bin/bash
LOG=/var/tmp/jbv1020.log
deadline=$(( $(date +%s) + 7200 ))
while :; do
  cs=$(docker ps --format '{{.Names}}' | grep -E '^admin-backend-(blue|green)$' || true)
  n=$(printf '%s\n' "$cs" | grep -c . || true)
  if [ "$n" = 1 ] && grep -q aggregateBallots /opt/crossmodel/scripts/framework-audit/model-bench-ingest.js \
     && docker exec "$cs" grep -q COMPARATIVE_RUBRIC_V2 /app/dist/modules/crossmodel/platform/live-chat-audit.js 2>/dev/null; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "JBV1020 gave up waiting for the judge-v2 build $(date -u +%FT%TZ)" >> "$LOG"; exit 0; fi
  sleep 60
done
echo "JBV1020 start $(date -u +%FT%TZ) container=$cs" >> "$LOG"
bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id mbk1020a --per-question >> "$LOG" 2>&1
rc=$?
echo "JBV1020 end $(date -u +%FT%TZ) rc=$rc" >> "$LOG"
JBV_EOF
    if sudo systemd-run --unit="jbv1020-$(date +%s)" --collect bash /var/tmp/jbv1020-run.sh; then sudo touch "$MARKER_JBV1020"; echo "  waiter launched (log /var/tmp/jbv1020.log)"; else echo "  systemd-run failed — marker left unset"; fi
    echo "== END JBV1020 =="
  fi
  # ── ONE-SHOT (2026-10-20, prod): JBR1020 — READ-ONLY readback of JBV1020's log (aggregates only — the ingest never
  # prints question or answer text). Marker only once the log carries its end line.
  MARKER_JBR1020=/var/tmp/.digby-jbr1020-judge-v2-dry-read
  if [ ! -f "$MARKER_JBR1020" ] && [ -f /var/tmp/jbv1020.log ]; then
    echo "== JBR1020 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo grep -v '^RESULT ' /var/tmp/jbv1020.log | tail -n 60 | cut -c1-400
    sudo grep -m1 '^RESULT ' /var/tmp/jbv1020.log | fold -w 3000 | sed 's/^/JBR_RESULT /'
    if sudo grep -q '^JBV1020 end ' /var/tmp/jbv1020.log; then sudo touch "$MARKER_JBR1020"; else echo "  ingest still running — marker left unset"; fi
    echo "== END JBR1020 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): JBV1020B — the judge v2 DRY re-ingest of mbk1020a again, deploy-proof. JBV1020 ran
  # it through prodq.sh (`docker exec` in the live backend); the next deploy removed that container mid-run. This runs
  # it through prodq-detached.sh (its OWN container from the live backend's image + env). Still NO --apply. A detached
  # waiter (≤ 120 min) starts it once box A runs ONE backend container and the deployed runner exists. Marker on
  # launch; JBR1020B below reads the log back.
  MARKER_JBV1020B=/var/tmp/.digby-jbv1020b-judge-v2-dry-detached
  if [ ! -f "$MARKER_JBV1020B" ]; then
    echo "== JBV1020B host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/jbv1020b-run.sh >/dev/null <<'JBVB_EOF'
#!/bin/bash
LOG=/var/tmp/jbv1020b.log
RUNNER=/opt/crossmodel/scripts/framework-audit/prodq-detached.sh
deadline=$(( $(date +%s) + 7200 ))
while :; do
  n=$(docker ps --format '{{.Names}}' | grep -cE '^admin-backend-(blue|green)$' || true)
  if [ "$n" = 1 ] && [ -f "$RUNNER" ] && grep -q aggregateBallots /opt/crossmodel/scripts/framework-audit/model-bench-ingest.js; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "JBV1020B gave up waiting $(date -u +%FT%TZ)" >> "$LOG"; exit 0; fi
  sleep 60
done
echo "JBV1020B start $(date -u +%FT%TZ)" >> "$LOG"
bash "$RUNNER" model-bench-ingest.js --run-id mbk1020a --per-question >> "$LOG" 2>&1
rc=$?
echo "JBV1020B end $(date -u +%FT%TZ) rc=$rc" >> "$LOG"
JBVB_EOF
    if sudo systemd-run --unit="jbv1020b-$(date +%s)" --collect bash /var/tmp/jbv1020b-run.sh; then sudo touch "$MARKER_JBV1020B"; echo "  waiter launched (log /var/tmp/jbv1020b.log)"; else echo "  systemd-run failed — marker left unset"; fi
    echo "== END JBV1020B =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): JBR1020B — READ-ONLY readback of JBV1020B's log (aggregates only). Marker only
  # once the log carries its end line.
  MARKER_JBR1020B=/var/tmp/.digby-jbr1020b-judge-v2-dry-detached-read
  if [ ! -f "$MARKER_JBR1020B" ] && [ -f /var/tmp/jbv1020b.log ]; then
    echo "== JBR1020B host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo grep -v '^RESULT ' /var/tmp/jbv1020b.log | tail -n 60 | cut -c1-400
    sudo grep -m1 '^RESULT ' /var/tmp/jbv1020b.log | fold -w 3000 | sed 's/^/JBRB_RESULT /'
    if sudo grep -q '^JBV1020B end ' /var/tmp/jbv1020b.log; then sudo touch "$MARKER_JBR1020B"; else echo "  ingest still running — marker left unset"; fi
    echo "== END JBR1020B =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): JBV1021 — judge v2 vs v1 on a FRESH bench run (mbv1021a, 2 waves on the test
  # account; mbk1020a's chats were cleaned up, so it cannot be re-judged). Both ingests are DRY (no --apply — the live
  # scorecard and every pick stay as they are; the owner keeps deepseek-flash): v2 with --per-question, then v1 pinned to
  # its unattended judge. Run deploy-proof through prodq-detached.sh by a detached waiter (≤ 120 min for one backend +
  # the deployed runner). Marker on launch; JBR1021 reads the log back.
  MARKER_JBV1021=/var/tmp/.digby-jbv1021-judge-v2-vs-v1
  if [ ! -f "$MARKER_JBV1021" ]; then
    echo "== JBV1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/jbv1021-run.sh >/dev/null <<'JBV21_EOF'
#!/bin/bash
LOG=/var/tmp/jbv1021.log
RUNNER=/opt/crossmodel/scripts/framework-audit/prodq-detached.sh
# Not before 02:05Z: the bench's second wave (q22–q28, started 01:23Z, ~25 min with settle) must have answered first.
not_before=$(date -d '2026-10-21T02:05:00Z' +%s)
deadline=$(( not_before + 7200 ))
while :; do
  n=$(docker ps --format '{{.Names}}' | grep -cE '^admin-backend-(blue|green)$' || true)
  if [ "$(date +%s)" -ge "$not_before" ] && [ "$n" = 1 ] && [ -f "$RUNNER" ]; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "JBV1021 gave up waiting $(date -u +%FT%TZ)" >> "$LOG"; exit 0; fi
  sleep 60
done
echo "JBV1021 v2 start $(date -u +%FT%TZ)" >> "$LOG"
bash "$RUNNER" model-bench-ingest.js --run-id mbv1021a --per-question >> "$LOG" 2>&1
echo "JBV1021 v2 end $(date -u +%FT%TZ) rc=$?" >> "$LOG"
echo "JBV1021 v1 start $(date -u +%FT%TZ)" >> "$LOG"
bash "$RUNNER" model-bench-ingest.js --run-id mbv1021a --judge-version v1 --judge-model qwen3.6-27b >> "$LOG" 2>&1
echo "JBV1021 end $(date -u +%FT%TZ) rc=$?" >> "$LOG"
JBV21_EOF
    if sudo systemd-run --unit="jbv1021-$(date +%s)" --collect bash /var/tmp/jbv1021-run.sh; then sudo touch "$MARKER_JBV1021"; echo "  waiter launched (log /var/tmp/jbv1021.log)"; else echo "  systemd-run failed — marker left unset"; fi
    echo "== END JBV1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): JBR1021 — READ-ONLY readback of JBV1021's log (aggregates + per-question scores /
  # lengths only — the ingest never prints question or answer text). Marker only once the log carries its end line.
  # Re-triggered 02:26Z (after the 02:05Z start) to read the finished log.
  MARKER_JBR1021=/var/tmp/.digby-jbr1021-judge-v2-vs-v1-read
  if [ ! -f "$MARKER_JBR1021" ] && [ -f /var/tmp/jbv1021.log ]; then
    echo "== JBR1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo grep -v '^RESULT ' /var/tmp/jbv1021.log | tail -n 80 | cut -c1-400
    sudo grep '^RESULT ' /var/tmp/jbv1021.log | awk '{print "JBR21_RESULT" NR " " $0}' | fold -w 3000
    if sudo grep -q '^JBV1021 end ' /var/tmp/jbv1021.log; then sudo touch "$MARKER_JBR1021"; else echo "  ingest still running — marker left unset"; fi
    echo "== END JBR1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): FSN1021 — READ-ONLY probe of the owner's Fleet Supervisor chat noise (repeated
  # "Message from …" rows, "Nothing new" briefings with the same head lines, an unbacked-claim honest line beside a
  # "running in the background" claim). Prints shapes only — timestamps, sender titles, 8-char content hashes, tool
  # names / ok flags, fixed harness-line flags; never message text. Marker once the probe answered.
  MARKER_FSN1021=/var/tmp/.digby-fsn1021-fleet-noise-probe
  if [ ! -f "$MARKER_FSN1021" ]; then
    echo "== FSN1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-fs-noise-1021.js >/dev/null <<'FSN_PROBE_EOF'
// probe-fs-noise-1021.js — READ-ONLY: why the owner's Fleet Supervisor chat repeats
// "Message from <session>" lines, "Nothing new" briefings with the same decision-gate
// paragraph, and an "I have not made that change yet" line beside a claim that work is
// running (owner, 2026-10-21: "what are these messages over and over again? if bug please fix").
//
// Usage (on the box): prodq.sh probe-fs-noise-1021.js
// Prints NO message text: timestamps, roles, origins / kinds, sender TITLES (harness-rendered
// session names), content length + an 8-char content hash (to spot exact repeats), tool names
// and ok flags, and the presence of fixed harness lines. Never writes.
const crypto = require('crypto');

const H = (s) => crypto.createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 8);
const HONEST_CHANGE = 'I have not made that change yet — nothing was changed in this answer.';
const HONEST_SEND = 'I have not sent that message yet — nothing went out in this answer.';
const NOTHING_NEW = 'Nothing new on any project since the last update.';
const ROLLOUT_HEAD = 'set off by the registry lifecycle this week';
const AUDIT_HEAD = 'Live-chat audit (last 24 h)';

function senderTitle(content) {
  const m = String(content || '').match(/^\[AGENT-SENT MESSAGE — ([^\]\n]*)\]/);
  if (!m) return null;
  const t = m[1].match(/from chat "([^"]*)"/);
  const id = m[1].match(/\(([0-9a-f]{8})\)/);
  return { title: (t && t[1] ? t[1].split(' · ')[0].trim() : null), id8: id ? id[1] : null };
}

function toolsOf(parts) {
  const out = [];
  if (!Array.isArray(parts)) return out;
  const results = new Map();
  for (const p of parts) {
    if (p && p.type === 'tool_result') {
      let ok = null;
      try { const r = typeof p.result === 'string' ? JSON.parse(p.result) : p.result; if (r && typeof r === 'object' && 'ok' in r) ok = r.ok; } catch { /* not json */ }
      results.set(p.toolCallId || p.id || `${p.name}:${results.size}`, { name: p.name, ok });
    }
  }
  for (const p of parts) if (p && p.type === 'tool_call') out.push(p.name);
  return { calls: out, results: [...results.values()].map((r) => `${r.name}:${r.ok === null ? '?' : r.ok}`) };
}

(async () => {
  const prisma = require('/app/dist/config/database').default;
  const since = new Date(Date.now() - 40 * 3600_000);
  const fleets = await prisma.crossModelChat.findMany({
    where: { isSupervisor: true, updatedAt: { gte: since } },
    select: { id: true, userId: true, title: true },
  });
  console.log(`FLEET_CHATS ${fleets.length}`);
  for (const fc of fleets) {
    const rows = await prisma.crossModelMessage.findMany({
      where: { chatId: fc.id, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true },
    });
    console.log(`== chat ${fc.id.slice(0, 8)} user ${String(fc.userId).slice(0, 8)} rows ${rows.length}`);
    const senders = new Map();
    const hashes = new Map();
    let briefings = 0, nothingNew = 0, rolloutHead = 0, auditHead = 0;
    for (const r of rows) {
      const md = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
      const c = String(r.content || '');
      const at = r.createdAt.toISOString().slice(5, 16);
      const s = r.role === 'user' ? senderTitle(c) : null;
      const isAgent = r.role === 'user' && (md.origin === 'agent' || c.startsWith('[AGENT-SENT MESSAGE'));
      const isWake = r.role === 'user' && (c.startsWith('[MACHINE-TRIGGERED RUN') || ['hook', 'schedule', 'continuation', 'system'].includes(md.origin));
      const head = c.split('\n')[0].replace(/[0-9a-f]{8}(-[0-9a-f-]{27})?/g, '<id>').slice(0, 70);
      if (isAgent) {
        const key = `${s && s.title ? s.title : '?'}${s && s.id8 ? ` (${s.id8})` : ''}`;
        senders.set(key, (senders.get(key) || 0) + 1);
        const h = H(c.replace(/^\[AGENT-SENT MESSAGE[^\]]*\]/, ''));
        hashes.set(h, (hashes.get(h) || 0) + 1);
        console.log(`ROW ${at} user/agent from="${key}" len=${c.length} h=${h}`);
      } else if (isWake) {
        console.log(`ROW ${at} user/wake origin=${md.origin || '-'} head="${head}" len=${c.length}`);
      } else if (r.role === 'user') {
        console.log(`ROW ${at} user/human len=${c.length}`);
      } else {
        const kind = md.kind || '-';
        const t = toolsOf(r.parts);
        const flags = [
          kind === 'owner_briefing' ? 'BRIEFING' : '',
          c.includes(NOTHING_NEW) ? 'NOTHING_NEW' : '',
          c.includes(ROLLOUT_HEAD) ? 'ROLLOUT_HEAD' : '',
          c.includes(AUDIT_HEAD) ? 'AUDIT_HEAD' : '',
          c.includes(HONEST_CHANGE) ? 'HONEST_CHANGE' : '',
          c.includes(HONEST_SEND) ? 'HONEST_SEND' : '',
          /running in the background/i.test(c) ? 'SAYS_BACKGROUND' : '',
        ].filter(Boolean).join(',');
        if (kind === 'owner_briefing') { briefings++; if (c.includes(NOTHING_NEW)) nothingNew++; if (c.includes(ROLLOUT_HEAD)) rolloutHead++; if (c.includes(AUDIT_HEAD)) auditHead++; }
        const mdKeys = Object.keys(md).filter((k) => /unbacked|harness|claim|origin|kind|machine|verifier|rewrite/i.test(k)).join('|');
        console.log(`ROW ${at} assistant kind=${kind} len=${c.length} h=${H(c)} flags=${flags || '-'} calls=${(t.calls || []).join('+') || '-'} results=${(t.results || []).join('+') || '-'} md=${mdKeys || '-'}`);
        if (c.includes(HONEST_CHANGE) || c.includes(HONEST_SEND)) {
          const uc = md.unbackedClaim || md.unbackedClaims || md.unbackedAction || null;
          console.log(`  UNBACKED_DETAIL md=${JSON.stringify(uc).slice(0, 400)} origin=${md.origin || '-'} machineOrigin=${md.machineOrigin || '-'}`);
          const idx = rows.indexOf(r);
          const prev = rows.slice(Math.max(0, idx - 3), idx).map((p) => `${p.role}/${(p.metadata && p.metadata.origin) || '-'}`).join(' ');
          console.log(`  PRECEDING ${prev}`);
        }
      }
    }
    console.log(`SENDERS ${JSON.stringify([...senders.entries()].sort((a, b) => b[1] - a[1]))}`);
    console.log(`REPEATED_AGENT_BODIES ${JSON.stringify([...hashes.entries()].filter(([, n]) => n > 1))}`);
    console.log(`BRIEFINGS total=${briefings} nothingNew=${nothingNew} rolloutHead=${rolloutHead} auditHead=${auditHead}`);
  }
  // The lane named in the owner's paste — its outbound sends to supervisor chats + its run cadence.
  const lanes = await prisma.crossModelChat.findMany({
    where: { title: { contains: 'Close the JWT pending-IP watch' } },
    select: { id: true, title: true, isProjectSupervisor: true, parentChatId: true, projectId: true, updatedAt: true },
  }).catch((e) => { console.log(`LANE_LOOKUP_ERR ${e.message}`); return []; });
  for (const l of lanes) {
    const runs = await prisma.agentRun.findMany({ where: { sessionId: l.id, createdAt: { gte: since } }, select: { status: true, input: true, createdAt: true }, orderBy: { createdAt: 'asc' } }).catch(() => []);
    const sch = await prisma.codingSchedule.findMany({ where: { sessionId: l.id }, select: { id: true, enabled: true, kind: true, intervalSec: true, nextRunAt: true, runsCount: true, maxRuns: true, promptSetBy: true, lastFiredAt: true } }).catch((e) => [{ err: e.message.slice(0, 120) }]);
    const originOf = (r) => { const i = r.input && typeof r.input === 'object' ? r.input : {}; return i.origin || i.source || (i.schedule ? 'schedule' : '-'); };
    console.log(`LANE ${l.id.slice(0, 8)} title="${String(l.title).slice(0, 80)}" parent=${String(l.parentChatId).slice(0, 8)} runs40h=${runs.length} origins=${JSON.stringify(runs.reduce((a, r) => { const o = originOf(r); a[o] = (a[o] || 0) + 1; return a; }, {}))} statuses=${JSON.stringify(runs.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}))}`);
    console.log(`  RUN_TIMES ${runs.map((r) => r.createdAt.toISOString().slice(11, 16)).join(' ')}`);
    console.log(`  SCHEDULES ${JSON.stringify(sch).slice(0, 600)}`);
  }
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log(`PROBE_ERR ${e && e.message}`); process.exit(0); });
FSN_PROBE_EOF
    if out=$(sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-fs-noise-1021.js 2>&1); then
      echo "$out" | cut -c1-600 | tail -n 400
      sudo touch "$MARKER_FSN1021"
    else
      echo "$out" | tail -n 20; echo "  probe failed — marker left unset"
    fi
    echo "== END FSN1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): FSH1021 — READ-ONLY health check of every Fleet Supervisor chat, last 48 h (owner:
  # "also check recent fleet supervisor chats"). Human turns (answered? latency, tool calls, honest-line rewrites), how
  # each assistant row ended (fixed harness-line flags), exact repeats, wake cadence, open owner questions (age + type),
  # schedules, spend, error-log counts — never message text. Marker once the probe answered.
  MARKER_FSH1021=/var/tmp/.digby-fsh1021-fleet-health-probe
  if [ ! -f "$MARKER_FSH1021" ]; then
    echo "== FSH1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-fs-health-1021.js >/dev/null <<'FSH_PROBE_EOF'
// probe-fs-health-1021.js — READ-ONLY health check of every Fleet Supervisor chat, last 48 h
// (owner, 2026-10-21: "also check recent fleet supervisor chats").
//
// Usage (on the box): prodq.sh probe-fs-health-1021.js
// Prints NO message text: per chat, the human turns (answered? latency, tool calls, rewrites),
// how every assistant row ended (fixed harness-line flags only), exact repeats by 8-char hash,
// machine-wake cadence, open owner questions (age + type, no text), schedules, spend and
// error-log counts (templated message prefixes, secrets scrubbed). Never writes.
const crypto = require('crypto');

const H = (s) => crypto.createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 8);
const FLAGS = [
  ['HARNESS_NOOP', (c) => c.includes('WAKE: no-op (harness:')],
  ['HARNESS_ACTIONS', (c) => c.includes('ACTIONS TAKEN (harness):')],
  ['HARNESS_RECORD', (c) => c.includes('Harness record:')],
  ['NOT_EXECUTED', (c) => c.includes('Not executed (harness):')],
  ['VERIFIER_NOTE', (c) => c.includes('[ACTION VERIFIER')],
  ['EVIDENCE_GUARD', (c) => c.includes('[HARNESS EVIDENCE GUARD')],
  ['HARNESS_NOTICE', (c) => c.includes('[HARNESS NOTICE') || c.includes('[HARNESS CHECK')],
  ['HONEST_LINE', (c) => /I have not (made that change|sent that message) yet|I did not re-read anything in this answer/.test(c)],
  ['SAYS_BACKGROUND', (c) => /running in the background|underway|in flight/i.test(c)],
  ['ERROR_NOTE', (c) => /^(Sorry — I couldn't get an answer|Sorry — this conversation has grown too large|The model kept rejecting the request|I wasn't able to generate a response)/.test(c)],
  ['EMPTY', (c) => !c.trim() || c.trim() === '[no content]'],
  ['NOTHING_NEW', (c) => c.includes('Nothing new on any project since the last update.')],
  ['ROLLOUT_HEAD', (c) => c.includes('set off by the registry lifecycle this week')],
  ['STOPPED', (c) => /^\(Stopped\.\)/.test(c.trim())],
];
const closeShape = (c) => {
  const first = String(c || '').split('\n').find((l) => l.trim()) || '';
  const m = first.match(/^\s*(?:\*\*)?(WAKE|SWEEP)\s*:\s*(no-op|reported|acted|[a-z-]+)/i);
  return m ? `${m[1].toUpperCase()}:${m[2].toLowerCase()}` : 'freeform';
};
const scrub = (s) => {
  try { const { redactInboundSecrets } = require('/app/dist/modules/crossmodel/platform/secret-scan'); const r = redactInboundSecrets(String(s)); return typeof r === 'string' ? r : String(s).replace(/[A-Za-z0-9_\-]{24,}/g, '<redacted>'); } catch { return String(s).replace(/[A-Za-z0-9_\-]{24,}/g, '<redacted>'); }
};

(async () => {
  const prisma = require('/app/dist/config/database').default;
  const now = Date.now();
  const since = new Date(now - 48 * 3600_000);
  const fleets = await prisma.crossModelChat.findMany({ where: { isSupervisor: true }, select: { id: true, userId: true, updatedAt: true } });
  console.log(`FLEET_CHATS ${fleets.length} ${fleets.map((f) => `${f.id.slice(0, 8)}:${String(f.userId).slice(0, 8)}:${f.updatedAt.toISOString().slice(5, 16)}`).join(' ')}`);
  for (const fc of fleets) {
    const rows = await prisma.crossModelMessage.findMany({
      where: { chatId: fc.id, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true },
    });
    if (!rows.length) { console.log(`== chat ${fc.id.slice(0, 8)} rows 0`); continue; }
    console.log(`== chat ${fc.id.slice(0, 8)} user ${String(fc.userId).slice(0, 8)} rows ${rows.length}`);
    const flagCount = {}; const shapeCount = {}; const hashCount = new Map(); const wakeByHour = {};
    let wakes = 0, agentMsgs = 0, humans = 0, assistants = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; const md = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}; const c = String(r.content || '');
      if (r.role === 'user') {
        const isAgent = md.origin === 'agent' || c.startsWith('[AGENT-SENT MESSAGE');
        const isWake = c.startsWith('[MACHINE-TRIGGERED RUN') || ['hook', 'schedule', 'continuation', 'system', 'attention-watchdog'].includes(md.origin);
        if (isAgent) agentMsgs++;
        else if (isWake) { wakes++; const hr = r.createdAt.toISOString().slice(5, 13); wakeByHour[hr] = (wakeByHour[hr] || 0) + 1; }
        else {
          humans++;
          // The human turn's answer: the next assistant rows until the next user row.
          const ans = []; for (let j = i + 1; j < rows.length && rows[j].role === 'assistant'; j++) ans.push(rows[j]);
          const first = ans[0];
          const calls = ans.flatMap((a) => (Array.isArray(a.parts) ? a.parts : []).filter((p) => p && p.type === 'tool_call').map((p) => p.name));
          const flags = ans.flatMap((a) => FLAGS.filter(([, f]) => f(String(a.content || ''))).map(([k]) => k));
          const lat = first ? Math.round((first.createdAt.getTime() - r.createdAt.getTime()) / 1000) : null;
          console.log(`HUMAN ${r.createdAt.toISOString().slice(5, 16)} len=${c.length} answered=${ans.length} latency_s=${lat} calls=${[...new Set(calls)].join('+') || '-'} ncalls=${calls.length} flags=${[...new Set(flags)].join(',') || '-'} kinds=${ans.map((a) => (a.metadata && a.metadata.kind) || '-').join('/')}`);
        }
      } else {
        assistants++;
        const fl = FLAGS.filter(([, f]) => f(c)).map(([k]) => k);
        for (const k of fl) flagCount[k] = (flagCount[k] || 0) + 1;
        const sh = (md.kind === 'owner_briefing') ? 'BRIEFING' : closeShape(c);
        shapeCount[sh] = (shapeCount[sh] || 0) + 1;
        const h = H(c); hashCount.set(h, (hashCount.get(h) || 0) + 1);
      }
    }
    console.log(`COUNTS humans=${humans} agentMsgs=${agentMsgs} wakes=${wakes} assistants=${assistants}`);
    console.log(`SHAPES ${JSON.stringify(shapeCount)}`);
    console.log(`FLAGS ${JSON.stringify(flagCount)}`);
    console.log(`DUP_ASSISTANT ${JSON.stringify([...hashCount.entries()].filter(([, n]) => n > 1))}`);
    console.log(`WAKES_BY_HOUR ${JSON.stringify(wakeByHour)}`);
    const qs = await prisma.ownerQuestion.findMany({ where: { chatId: fc.id, status: { in: ['open', 'pending', 'asked'] } }, select: { id: true, status: true, expectedAnswerType: true, optionalAsk: true, createdAt: true } }).catch((e) => [{ err: e.message.slice(0, 100) }]);
    console.log(`OPEN_QUESTIONS ${qs.length} ${qs.slice(0, 20).map((q) => q.err ? q.err : `${q.id.slice(0, 11)}:${q.expectedAnswerType || '-'}:${q.optionalAsk ? 'opt' : 'req'}:${Math.round((now - new Date(q.createdAt).getTime()) / 3600_000)}h`).join(' ')}`);
    const sch = await prisma.codingSchedule.findMany({ where: { sessionId: fc.id }, select: { id: true, enabled: true, kind: true, intervalSec: true, runsCount: true, maxRuns: true, promptSetBy: true, busySkips: true, lastStatus: true, nextRunAt: true } }).catch((e) => [{ err: e.message.slice(0, 100) }]);
    console.log(`SCHEDULES ${sch.filter((s) => s.enabled !== false).map((s) => s.err ? s.err : `${s.id.slice(0, 8)}:${s.kind}:${s.intervalSec}s:runs${s.runsCount}/${s.maxRuns ?? '∞'}:${s.promptSetBy}:busy${s.busySkips ?? 0}:${String(s.lastStatus || '-').slice(0, 40)}`).join(' | ')} (disabled ${sch.filter((s) => s.enabled === false).length})`);
    const spend = await prisma.loopMetric.findMany({ where: { sessionId: fc.id, kind: 'run_spend', createdAt: { gte: since } }, select: { value: true, meta: true } }).catch(() => []);
    const usd = spend.reduce((a, s) => a + (Number(s.value) || 0), 0);
    const byModel = {}; for (const s of spend) { const m = (s.meta && s.meta.model) || '-'; byModel[m] = Math.round(((byModel[m] || 0) + (Number(s.value) || 0)) * 100) / 100; }
    console.log(`SPEND48H rows=${spend.length} usd=${usd.toFixed(2)} byModel=${JSON.stringify(byModel)}`);
    const errs = await prisma.appErrorLog.findMany({ where: { createdAt: { gte: since }, message: { contains: fc.id.slice(0, 8) } }, select: { level: true, source: true, message: true } }).catch(() => []);
    const ec = {}; for (const e of errs) { const k = `${e.level}|${e.source || '-'}|${scrub(e.message).replace(/[0-9a-f]{8}(-[0-9a-f-]{27})?/g, '<id>').replace(/\d+/g, 'N').slice(0, 110)}`; ec[k] = (ec[k] || 0) + 1; }
    console.log(`ERRLOGS ${errs.length}`);
    for (const [k, n] of Object.entries(ec).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n} ${k}`);
  }
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log(`PROBE_ERR ${e && e.message}`); process.exit(0); });
FSH_PROBE_EOF
    if out=$(sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-fs-health-1021.js 2>&1); then
      echo "$out" | cut -c1-700 | head -n 700
      sudo touch "$MARKER_FSH1021"
    else
      echo "$out" | tail -n 20; echo "  probe failed — marker left unset"
    fi
    echo "== END FSH1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): TKL1021 — READ-ONLY ticket board for the ticket catch-up (owner: "help deploy fixes
  # and merge and test post deploy on all existing framework feedback tickets and bugs"). Every NOT-closed ticket
  # (open / in_progress / queued / reopened / awaiting_verification) plus every ticket closed in the last 48 h: id, type,
  # status, priority, source, times, the lane stamps (dispatchedTo / codingSessionId / filedBy), the lane's run state,
  # the title (≤ 140) and the adminNote head (≤ 220) — both through the backend's own redactInboundSecrets. Never the
  # description. Marker only on a complete read.
  MARKER_TKL1021=/var/tmp/.digby-tkl1021-ticket-board
  if [ ! -f "$MARKER_TKL1021" ]; then
    echo "== TKL1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/tkl1021-probe.js >/dev/null <<'TKL_EOF'
const prisma = require('/app/dist/config/database').default;
let redact = (s) => s;
try { redact = require('/app/dist/modules/crossmodel/platform/secret-scan').redactInboundSecrets || redact; } catch {}
const clean = (s, n) => redact(String(s || '')).replace(/[\r\n\t|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
(async () => {
  const since = new Date(Date.now() - 48 * 3600e3);
  const rows = await prisma.userFeatureRequest.findMany({
    where: { OR: [{ status: { in: ['open', 'in_progress', 'queued', 'reopened', 'awaiting_verification'] } }, { updatedAt: { gte: since }, status: { in: ['done', 'deployed_verified', 'resolved'] } }] },
    select: { id: true, type: true, status: true, priority: true, source: true, title: true, adminNote: true, context: true, createdAt: true, updatedAt: true },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 400,
  });
  const laneIds = [...new Set(rows.map((r) => (r.context || {}).dispatchedTo).filter(Boolean))];
  const runs = laneIds.length ? await prisma.agentRun.findMany({ where: { sessionId: { in: laneIds } }, select: { sessionId: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } }).catch(() => []) : [];
  const lastRun = {}; for (const r of runs) if (!lastRun[r.sessionId]) lastRun[r.sessionId] = r;
  const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log('TKL_COUNTS ' + JSON.stringify({ rows: rows.length, counts }));
  for (const r of rows) {
    const c = r.context || {};
    const lane = c.dispatchedTo ? String(c.dispatchedTo).slice(0, 8) : '';
    const lr = c.dispatchedTo && lastRun[c.dispatchedTo] ? `${lastRun[c.dispatchedTo].status}@${lastRun[c.dispatchedTo].createdAt.toISOString().slice(5, 16)}` : '';
    console.log(['TKL', r.id.slice(0, 8), r.status, r.type, r.priority, r.source, r.createdAt.toISOString().slice(0, 16), r.updatedAt.toISOString().slice(0, 16),
      lane, lr, c.area || c.surface || '', clean(r.title, 140), clean(r.adminNote, 220)].join('|'));
  }
  console.log('TKL_DONE');
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('TKL_ERROR ' + String(e && e.message || e).slice(0, 300)); process.exit(0); });
TKL_EOF
    TKL_OUT=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/tkl1021-probe.js 2>&1)
    printf '%s\n' "$TKL_OUT" | grep -E '^(TKL|TKL_COUNTS|TKL_DONE|TKL_ERROR)' | cut -c1-700
    if printf '%s' "$TKL_OUT" | grep -q '^TKL_DONE'; then sudo touch "$MARKER_TKL1021"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$TKL_OUT" | tail -3 | cut -c1-300; fi
    echo "== END TKL1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): TKD1021 — READ-ONLY ticket detail for the catch-up (TKL1021 gave the board).
  # (a) the four queued tickets no lane holds yet (9a976d83 4d476b9a 4c7aebf7 17a0b383): description + full adminNote +
  # context, redacted; (b) every ticket closed in the last 48 h: full adminNote (the lane's cited evidence), redacted;
  # (c) the two awaiting_verification acceptance metrics re-measured now: 4a8fcbde = auth_login_failed rows / 24 h
  # (total + the deploy-healthcheck probe emailHash), 764ba7ec = 'memory-audit: extraction parse_error' warn rows /
  # 24 h. Output as one JSON line per ticket (TKD …). Marker only on a complete read.
  MARKER_TKD1021=/var/tmp/.digby-tkd1021-ticket-detail
  if [ ! -f "$MARKER_TKD1021" ]; then
    echo "== TKD1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/tkd1021-probe.js >/dev/null <<'TKD_EOF'
const prisma = require('/app/dist/config/database').default;
let redact = (s) => s;
try { redact = require('/app/dist/modules/crossmodel/platform/secret-scan').redactInboundSecrets || redact; } catch {}
const clean = (s, n) => redact(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, n);
const QUEUED = ['9a976d83', '4d476b9a', '4c7aebf7', '17a0b383'];
(async () => {
  const since = new Date(Date.now() - 48 * 3600e3);
  const rows = await prisma.userFeatureRequest.findMany({
    where: { OR: [{ status: { in: ['open', 'in_progress', 'queued', 'reopened', 'awaiting_verification'] } }, { updatedAt: { gte: since }, status: { in: ['done', 'deployed_verified', 'resolved'] } }] },
    select: { id: true, type: true, status: true, title: true, description: true, adminNote: true, context: true, updatedAt: true }, take: 400,
  });
  for (const r of rows) {
    const id8 = r.id.slice(0, 8);
    const full = QUEUED.includes(id8);
    const ctx = r.context || {};
    const o = { id: id8, status: r.status, type: r.type, title: clean(r.title, 300), note: clean(r.adminNote, full ? 6000 : 3500) };
    if (full) {
      o.description = clean(r.description, 8000);
      o.context = redact(JSON.stringify(ctx)).slice(0, 4000);
    } else {
      o.ctx = { dispatchedTo: ctx.dispatchedTo ? String(ctx.dispatchedTo).slice(0, 8) : undefined, area: ctx.area || ctx.surface, family: ctx.family || ctx.class };
    }
    console.log('TKD ' + JSON.stringify(o));
  }
  const day = new Date(Date.now() - 24 * 3600e3);
  const auth = await prisma.loopMetric.findMany({ where: { kind: 'auth_login_failed', createdAt: { gte: day } }, select: { meta: true } }).catch(() => []);
  const probeHash = '0034506974bc51de';
  const parse = await prisma.appErrorLog.count({ where: { createdAt: { gte: day }, message: { contains: 'memory-audit: extraction parse_error' } } }).catch(() => -1);
  console.log('TKD_METRICS ' + JSON.stringify({ auth_login_failed_24h: auth.length, auth_probe_hash_24h: auth.filter((a) => (a.meta || {}).emailHash === probeHash).length, memory_audit_parse_error_24h: parse }));
  console.log('TKD_DONE');
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('TKD_ERROR ' + String(e && e.message || e).slice(0, 300)); process.exit(0); });
TKD_EOF
    TKD_OUT=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/tkd1021-probe.js 2>&1)
    printf '%s\n' "$TKD_OUT" | grep -E '^(TKD|TKD_METRICS|TKD_DONE|TKD_ERROR)' | fold -w 3000
    if printf '%s' "$TKD_OUT" | grep -q '^TKD_DONE'; then sudo touch "$MARKER_TKD1021"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$TKD_OUT" | tail -3 | cut -c1-300; fi
    echo "== END TKD1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): TKC1021 — CLAIM the four queued tickets no lane holds (9a976d83 4d476b9a 4c7aebf7
  # 17a0b383) for the owner-directed catch-up session, so the dispatcher does not spawn a duplicate lane while the fixes
  # are built: status open → in_progress + an adminNote naming the claim (the dispatcher never reclaims an in_progress
  # row whose note is not its own and that carries no dispatchedTo). Guarded: only rows still 'open' with no
  # dispatchedTo are touched; context is unchanged. The session closes each ticket with commit + deploy evidence.
  MARKER_TKC1021=/var/tmp/.digby-tkc1021-claim
  if [ ! -f "$MARKER_TKC1021" ]; then
    echo "== TKC1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/tkc1021.js >/dev/null <<'TKC_EOF'
const prisma = require('/app/dist/config/database').default;
const IDS = ['9a976d83', '4d476b9a', '4c7aebf7', '17a0b383'];
(async () => {
  const out = [];
  for (const id8 of IDS) {
    const r = await prisma.userFeatureRequest.findFirst({ where: { id: { startsWith: id8 } }, select: { id: true, status: true, context: true } });
    if (!r) { out.push({ id8, result: 'not_found' }); continue; }
    if (r.status !== 'open' || (r.context || {}).dispatchedTo) { out.push({ id8, result: 'skipped', status: r.status, lane: (r.context || {}).dispatchedTo ? String(r.context.dispatchedTo).slice(0, 8) : null }); continue; }
    const note = `Claimed ${new Date().toISOString()} by the owner-directed catch-up session (Claude Code, branch claude/funny-babbage-cdj4xx): fix in progress — this session closes the ticket with commit + deploy + live evidence. Not a dispatcher note: no lane is spawned for it.`;
    const n = await prisma.userFeatureRequest.updateMany({ where: { id: r.id, status: 'open' }, data: { status: 'in_progress', adminNote: note } });
    out.push({ id8, result: n.count === 1 ? 'claimed' : 'raced' });
  }
  console.log('TKC ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('TKC_ERROR ' + String(e && e.message || e).slice(0, 300)); process.exit(0); });
TKC_EOF
    TKC_OUT=$(timeout 120 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/tkc1021.js 2>&1)
    printf '%s\n' "$TKC_OUT" | grep -E '^TKC' | cut -c1-1200
    if printf '%s' "$TKC_OUT" | grep -q '^TKC \['; then sudo touch "$MARKER_TKC1021"; else echo "  claim incomplete — marker left unset"; printf '%s\n' "$TKC_OUT" | tail -3 | cut -c1-300; fi
    echo "== END TKC1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): LVC1021 — READ-ONLY post-deploy live checks for the closed-ticket sweep (61 closed
  # tickets re-verified in code: 42 fixed + deployed + tests green, 19 no-code; these are the production-side checks the
  # reviewers asked for). Migrations (43c24152 / 57e9f01e feeds retired, bfc3209a orphan row gone, 6f4d42f2 search
  # config), live-chat audit rows (3ff96116), web_fetch_path tiers (6da0db0a / 0c9d23e2), incomplete-card re-files
  # (0fb8ac3d), docker-probe warns (658ecf0e), decision-gate cql/laya legs (3c18284e), the 764ba7ec parse_error
  # timestamps, and the deploy sha on this box (29bd478b). Counts / timestamps / class names only. Then probe-2c9dfc66.
  MARKER_LVC1021=/var/tmp/.digby-lvc1021-live-checks
  if [ ! -f "$MARKER_LVC1021" ]; then
    echo "== LVC1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    echo "  deploy-sha: $(cat /opt/crossmodel/.deploy-sha 2>/dev/null || echo missing)"
    sudo tee /var/tmp/lvc1021.js >/dev/null <<'LVC_EOF'
const prisma = require('/app/dist/config/database').default;
const day = new Date(Date.now() - 24 * 3600e3);
const out = {};
const q = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: String(e && e.message || e).slice(0, 160) }; } };
(async () => {
  await q('migrations', () => prisma.$queryRawUnsafe(`SELECT migration_name, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations WHERE migration_name IN ('20261020190000_retire_topic_feeds','20261020210000_user_feed_last_error','20261021002000_prisma_migrations_orphan_cleanup','20261020060000_search_provider_config')`));
  await q('user_feeds_table', async () => (await prisma.$queryRawUnsafe(`SELECT to_regclass('public.user_feeds')::text AS t`))[0]);
  await q('live_chat_audit_48h', async () => (await prisma.loopMetric.findMany({ where: { kind: 'live_chat_audit', createdAt: { gte: new Date(Date.now() - 48 * 3600e3) } }, select: { value: true, meta: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 4 })).map((r) => ({ at: r.createdAt, value: r.value, regressions: (r.meta || {}).regressions, filed: (r.meta || {}).ticketsFiled })));
  await q('live_chat_quality_tickets_open', () => prisma.userFeatureRequest.count({ where: { title: { startsWith: '[live-chat audit] answer quality' }, status: { in: ['open', 'in_progress', 'reopened'] } } }));
  await q('web_fetch_path_24h', async () => {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'web_fetch_path', createdAt: { gte: day } }, select: { meta: true }, take: 20000 });
    const g = {};
    for (const r of rows) { const m = r.meta || {}; const k = [m.tool || '?', m.winner || '?', m.directClass || '-', m.ok === false ? 'fail' : 'ok'].join('|'); g[k] = (g[k] || 0) + 1; }
    return { rows: rows.length, groups: Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 25) };
  });
  await q('incomplete_card_fe4b8_refiled', () => prisma.userFeatureRequest.count({ where: { title: { contains: 'oq_fe4b8' }, createdAt: { gte: new Date('2026-10-20T04:08:00Z') } } }));
  await q('docker_probe_warns_24h', async () => ({ notAvailable: await prisma.appErrorLog.count({ where: { createdAt: { gte: day }, message: { startsWith: 'coding container: Docker not available' } } }), reachableAgain: await prisma.appErrorLog.count({ where: { createdAt: { gte: day }, message: { contains: 'Docker reachable again' } } }) }));
  await q('decision_gate_cql_24h', async () => {
    const rows = await prisma.loopMetric.findMany({ where: { kind: { in: ['decision_gate', 'decision_gate_backend_down'] }, createdAt: { gte: day } }, select: { kind: true, meta: true }, take: 30000 });
    const g = {};
    for (const r of rows) { const m = r.meta || {}; const b = String(m.backend || m.backendSpec || '?'); if (!/cql|laya/i.test(b) && r.kind !== 'decision_gate_backend_down') continue; const k = [r.kind, b.slice(0, 40), m.phase || '-', m.error ? 'err' : 'ok', m.reason || m.outcome || '-'].join('|'); g[k] = (g[k] || 0) + 1; }
    return Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 15);
  });
  await q('parse_error_764ba7ec_24h', async () => (await prisma.appErrorLog.findMany({ where: { createdAt: { gte: day }, message: { contains: 'memory-audit: extraction parse_error' } }, select: { createdAt: true, message: true } })).map((r) => ({ at: r.createdAt, kind: (r.message.match(/parse_error \((\w+)\)/) || [])[1] || '?', len: r.message.length })));
  console.log('LVC ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('LVC_ERROR ' + String(e && e.message || e).slice(0, 300)); process.exit(0); });
LVC_EOF
    LVC_OUT=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/lvc1021.js 2>&1)
    printf '%s\n' "$LVC_OUT" | grep -E '^LVC' | fold -w 3000
    P2C_OUT=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh probe-2c9dfc66.js 2>&1 | tail -n 40 | cut -c1-400)
    printf '%s\n' "$P2C_OUT" | sed 's/^/P2C /'
    if printf '%s' "$LVC_OUT" | grep -q '^LVC {'; then sudo touch "$MARKER_LVC1021"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$LVC_OUT" | tail -3 | cut -c1-300; fi
    echo "== END LVC1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): LLC1021 — READ-ONLY probe of the lane lifecycle (owner: "not sure why they dont get
  # auto archived and organized maybe a framework issue?"). Every non-archived lane / supervisor chat in a project
  # folder (coding state, parentChatId, project supervisor, or a schedule) plus the owner's named rows: lineage (parent
  # + whether it sits in the same folder), coding state, runs, schedules, charter goal / todo, linked tickets
  # (dispatchedTo / previousLanes / filedBy / codingSessionId / sessionId) with the 100-row / 7 d closed-scan window,
  # PRs, finish_run / hand-off rows, and per-mechanism verdicts (which archiver / nester should have acted and why it
  # did not); per-project summary; loop-metric tails. Ids (8 chars), titles (≤ 60), statuses, times, counts — never
  # message text. Never writes. Marker only once the probe printed LLC_DONE.
  MARKER_LLC1021=/var/tmp/.digby-llc1021-lane-lifecycle-probe
  if [ ! -f "$MARKER_LLC1021" ]; then
    echo "== LLC1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-lane-lifecycle-1021.js >/dev/null <<'LLC_PROBE_EOF'
// probe-lane-lifecycle-1021.js — READ-ONLY: why lanes in project folders never get archived
// or nested (owner, 2026-10-21: "not sure why they dont get auto archived and organized maybe
// a framework issue?" — ticket lanes idle after their ticket closed, an old "Research Watch"
// chat, a scheduled watch lane, ticket / family lanes flat at folder level instead of under the
// "crossmodel Supervisor").
//
// Usage (on the box): prodq.sh probe-lane-lifecycle-1021.js
// Prints NO message text and NO secrets: 8-char id prefixes, session TITLES clipped to 60 chars
// (harness-rendered names; long token-like runs masked), project names (folder names, ≤ 40),
// statuses, timestamps, counts, tool names, booleans and enum-ish loop_metrics meta (free-text
// keys dropped, clipped to 300). Env vars: presence booleans / id8 only. Never writes: only
// findMany / findUnique / count / groupBy (no create / update / delete / upsert / raw SQL, no
// Redis — the ticket-dispatch stuck-clock key is NOT read on purpose).
//
// Scope: every NON-archived chat with a projectId that has a coding state, a parentChatId,
// isProjectSupervisor / isSupervisor, or any coding_schedules row — plus any chat whose title
// matches the owner's named examples (NAMED section, archived or not, any project).
//
// Verdicts (one or more per chat; each names the archiver / nester that SHOULD act and why not):
//   TICKET_CLOSED_NOT_ARCHIVED(reasons)  ticket-drain archiveTicketLane should have retired it;
//        reasons: LAA_SET (ticket carries laneArchivedAt — reopen-inherit bug), OUT_OF_WINDOW
//        (not in the 100-newest-closed / 7 d scan), FAMILY_RIDERS:n, SCHED_ENABLED:n,
//        RUNNING_STATE, LIVE:n, DRAIN_SHOULD_ARCHIVE (no blocker visible ⇒ the drain is not
//        archiving at all: env / lease / lane home)
//   TICKET_AWAITING_VERIFICATION          the ticket is in neither the open scan nor the closed query
//   TICKET_OPEN_LANE_IDLE(h)              open ticket, lane idle ≥ 8 h (re-dispatch / stale path)
//   ORPHAN_PREVIOUS_LANE(statuses)        lane id only in some ticket's previousLanes — nothing archives it
//   TICKET_LANE_UNLINKED                  titled "ticket …"/"family …" but no ticket points at it
//   BATCH_SESSION_CLOSED                  dispatchedTo without dispatchMode (standing-lane batch) on a closed ticket
//   CHILD_DONE_NOT_ARCHIVED               run-reaper rule (h) conditions all hold (plan complete, completed ≥ 6 h, no schedule)
//   CHILD_FINISHED_EMPTY_BOARD            as (h) but plan has 0 steps — (h) needs steps > 0 (doctrine says it self-archives)
//   CHILD_LAST_RUN_<status>_WAITS_7D      last run failed/cancelled — (h) skips it, only (e) after 7 d
//   CHILD_IDLE_7D_NOT_ARCHIVED            run-reaper rule (e) conditions all hold
//   ORPHAN_PARENT:<missing|archived|other_folder:<p8|ungrouped>:<kind>>  parent not in this folder's list ⇒ renders flat
//   FLAT_SHOULD_NEST(<parent8>:<kind>:<source>)  no parentChatId, but a spawner / reporter / family home
//        supervisor in THIS folder is known (delegation ledger, ticket reporter, project supervisor)
//   FLAT_INTENDED_PARENT_OTHER_FOLDER(...) the known spawner / reporter lives in another folder / ungrouped
//   IDLE_NO_SCHEDULE_GOAL_DONE(h)         top-level lane, charter goal/todo terminal, no open todos, no schedule,
//        idle ≥ 6 h — nothing deterministic archives a top-level lane
//   R6_CANDIDATE                          session-topology R6 would list it (observe-only; nothing archives)
//   R6_MASKED_BY_STALE_CHARTER            R6 would list it but for a charterTodoId whose todo is already terminal
//   SCHEDULE_BLOCKS_ARCHIVE(setBy…)       work done / idle but an enabled schedule makes every archiver 409
//   STUCK_RUNNING_STATE                   coding state 'running' with no queued/running run — archiveChat 409s forever
//   SATELLITE_ARCHIVED_CHAT_VISIBLE       coding state 'archived' but chat.archivedAt null (session-API archive)
//   IDLE_ARCHIVER_OFF(d)                  folder autoArchiveIdleDays null; chat untouched ≥ 7 d
//   IDLE_ARCHIVER_SHOULD_HAVE(d)          folder opt-in set, chat older than it, no schedule / live run
//   SUPERVISOR                            never archivable (pause-never-delete); printed for nesting context
const NOW = Date.now();
const H = 3600_000;
const D = 24 * H;
const CLOSED = ['done', 'deployed_verified', 'resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix'];
const RIDER_STATUSES = ['open', 'in_progress', 'reopened'];
const OPEN_TICKET = ['open', 'in_progress', 'queued', 'reopened'];
const OPEN_TODO = ['pending', 'in_progress', 'blocked'];
const NAMED = ['4a8fcbde', 'Research Watch', 'JWT pending-IP', 'av-mishap', 'canlawcpt'];
const DETAIL_BUDGET = 540; // detail lines (LANE / LINK / VERDICT); summaries + loop metrics print after
const LM_KINDS = [
  'session_topology', 'session_topology_outcome', 'child_session_archived', 'branch_janitor',
  'capacity_ticket_queue', 'ticket_lane_slot_release', 'ticket_family_routing', 'held_ticket_escalation',
  'delegation_task', 'delegation_task_reconcile', 'lane_idle_wake', 'archived_target_retire',
  'machine_dispatch_archived_refused', 'title_render', 'schedule_renew_refused', 'deliverable_handoff',
  'finish_run', 'spawn_permission', 'member_spawn',
];
const DROP_META_KEYS = /^(text|summary|brief|prompt|message|content|excerpt|finalText|body|description|question|answer|note|notes|adminNote|title_text|error|errorMessage|stderr|stdout)$/i;

const id8 = (s) => (s ? String(s).slice(0, 8) : '-');
const ts = (d) => (d ? new Date(d).toISOString().slice(5, 16) : '-');
const hAgo = (d) => (d ? Math.round((NOW - new Date(d).getTime()) / H) : null);
const clipTitle = (s) => String(s ?? '').replace(/[\r\n\t"|]+/g, ' ').replace(/[A-Za-z0-9_\-]{32,}/g, '<tok>').replace(/\s+/g, ' ').trim().slice(0, 60);
const clipName = (s) => String(s ?? '').replace(/[\r\n\t"|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const ctxOf = (t) => (t && t.context && typeof t.context === 'object' && !Array.isArray(t.context) ? t.context : {});
const str = (v) => (typeof v === 'string' ? v : '');
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const inChunks = async (ids, fn, n = 800) => { const out = []; for (const c of chunk(ids, n)) { if (!c.length) continue; const r = await fn(c); if (Array.isArray(r)) out.push(...r); } return out; };
const pool = async (items, n, fn) => { let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }; await Promise.all(Array.from({ length: Math.min(n, items.length) }, run)); };
const safeMeta = (m) => {
  const walk = (v, depth) => {
    if (v == null || typeof v !== 'object') return typeof v === 'string' ? v.replace(/[A-Za-z0-9_\-]{32,}/g, '<tok>').slice(0, 80) : v;
    if (depth > 3) return '…';
    if (Array.isArray(v)) return v.slice(0, 8).map((x) => walk(x, depth + 1));
    const o = {};
    for (const [k, x] of Object.entries(v)) { if (DROP_META_KEYS.test(k)) continue; o[k] = walk(x, depth + 1); }
    return o;
  };
  try { return JSON.stringify(walk(m, 0)).slice(0, 300); } catch { return '"<meta unreadable>"'; }
};

let detailLines = 0;
const detail = (line) => { detailLines++; console.log(line.slice(0, 690)); };

(async () => {
  const prisma = require('/app/dist/config/database').default;
  let MUTATING = ['create_chat', 'send_chat_message', 'start_coding_session', 'archive_chat', 'schedule_message', 'cancel_schedule', 'update_schedule', 'goal_create', 'goal_update', 'todo_create', 'todo_update'];
  try { const m = require('/app/dist/modules/crossmodel/platform/platform-tool-names'); if (Array.isArray(m.PLATFORM_MUTATING_TOOLS)) MUTATING = m.PLATFORM_MUTATING_TOOLS; } catch { /* static fallback */ }
  const R6_TOOLS = [...new Set([...MUTATING, 'open_pull_request', 'merge_pull_request', 'run_command'])];

  // ── 0. Env (backend container; the worker holding the cron lease may differ) + lane home ──
  const env = process.env;
  const set = (k) => (String(env[k] ?? '').trim() ? 1 : 0);
  console.log(`ENV(backend-container) TICKET_DISPATCH_ENABLED=='true':${String(env.TICKET_DISPATCH_ENABLED ?? '').trim() === 'true'} PLATFORM_ENGINEER_CHAT_ID=${id8(String(env.PLATFORM_ENGINEER_CHAT_ID ?? '').trim()) } TICKET_LANE_PROJECT_ID=${id8(String(env.TICKET_LANE_PROJECT_ID ?? '').trim())} FRESH_LANES_DISABLED=${set('TICKET_DISPATCH_FRESH_LANES_DISABLED')} LANE_ARCHIVE_PAUSE_DISABLED=${set('TICKET_LANE_ARCHIVE_PAUSE_DISABLED')} IDLE_CHAT_ARCHIVER_DISABLED=${set('IDLE_CHAT_ARCHIVER_DISABLED')} FINISHED_CHILD_ARCHIVE_DISABLED=${set('FINISHED_CHILD_ARCHIVE_DISABLED')} SCHEDULE_CHARTER_TERMINATION_ENFORCE=${set('SCHEDULE_CHARTER_TERMINATION_ENFORCE')} SESSION_TOPOLOGY_DISABLED=${set('SESSION_TOPOLOGY_DISABLED')}`);
  const standingLaneId = String(env.PLATFORM_ENGINEER_CHAT_ID ?? '').trim() || null;
  let home = null;
  const homePid = String(env.TICKET_LANE_PROJECT_ID ?? '').trim();
  if (homePid) {
    const p = await prisma.crossModelProject.findUnique({ where: { id: homePid }, select: { id: true, userId: true } }).catch(() => null);
    if (p) home = { projectId: p.id, userId: p.userId, via: 'TICKET_LANE_PROJECT_ID' };
  }
  if (!home && standingLaneId) {
    const c = await prisma.crossModelChat.findUnique({ where: { id: standingLaneId }, select: { userId: true, projectId: true, archivedAt: true } }).catch(() => null);
    if (c && c.projectId) home = { projectId: c.projectId, userId: c.userId, via: `standing lane (archived=${!!c.archivedAt})` };
  }
  console.log(`LANE_HOME ${home ? `project=${id8(home.projectId)} owner=${id8(home.userId)} via=${home.via}` : 'NONE (fresh-lane drain cannot run ⇒ no ticket lane is ever archived)'}`);

  // ── 1. Projects + chats ──
  const projects = await prisma.crossModelProject.findMany({ select: { id: true, userId: true, name: true, autoArchiveIdleDays: true, projectSupervisorEnabled: true, archivedAt: true, isUserSpace: true } });
  const projById = new Map(projects.map((p) => [p.id, p]));
  const CHAT_CAP = 30000;
  const chats = await prisma.crossModelChat.findMany({
    where: { archivedAt: null, projectId: { not: null } },
    select: { id: true, userId: true, projectId: true, title: true, parentChatId: true, isSupervisor: true, isProjectSupervisor: true, charterGoalId: true, charterTodoId: true, titlePinned: true, createdAt: true, updatedAt: true },
    take: CHAT_CAP,
  });
  console.log(`CHATS non-archived-in-projects=${chats.length}${chats.length === CHAT_CAP ? ' (CAPPED)' : ''} projects=${projects.length}`);
  const allIds = chats.map((c) => c.id);

  const states = new Map((await inChunks(allIds, (c) => prisma.chatCodingState.findMany({ where: { id: { in: c } }, select: { id: true, status: true, updatedAt: true, titleSource: true } }))).map((s) => [s.id, s]));
  const schedRows = await inChunks(allIds, (c) => prisma.codingSchedule.findMany({ where: { sessionId: { in: c } }, select: { id: true, sessionId: true, enabled: true, kind: true, intervalSec: true, runsCount: true, maxRuns: true, promptSetBy: true, ownerSubscribed: true, nextRunAt: true, lastStatus: true, cancelledBy: true } }));
  const schedBy = new Map();
  for (const s of schedRows) { const l = schedBy.get(s.sessionId) || []; l.push(s); schedBy.set(s.sessionId, l); }
  const named = (t) => NAMED.some((n) => String(t || '').toLowerCase().includes(n.toLowerCase()));
  const scope = chats.filter((c) => states.has(c.id) || c.parentChatId || c.isProjectSupervisor || c.isSupervisor || schedBy.has(c.id) || named(c.title));
  const ids = scope.map((c) => c.id);
  const scopeSet = new Set(ids);
  console.log(`SCOPE lanes+supervisors=${scope.length} (coding=${scope.filter((c) => states.has(c.id)).length} child=${scope.filter((c) => c.parentChatId).length} ps=${scope.filter((c) => c.isProjectSupervisor).length} scheduled=${scope.filter((c) => schedBy.has(c.id)).length})`);

  // ── 2. Runs (aggregates), coding messages 7 d, plan boards ──
  const runAgg = await inChunks(ids, (c) => prisma.agentRun.groupBy({ by: ['sessionId', 'status'], where: { sessionId: { in: c } }, _count: { _all: true }, _max: { createdAt: true, finishedAt: true } }));
  const runs14 = await inChunks(ids, (c) => prisma.agentRun.groupBy({ by: ['sessionId'], where: { sessionId: { in: c }, createdAt: { gte: new Date(NOW - 14 * D) } }, _count: { _all: true } }));
  const runs7 = await inChunks(ids, (c) => prisma.agentRun.groupBy({ by: ['sessionId'], where: { sessionId: { in: c }, createdAt: { gte: new Date(NOW - 7 * D) } }, _count: { _all: true } }));
  const msgs7 = await inChunks(ids, (c) => prisma.codingMessage.groupBy({ by: ['chatId'], where: { chatId: { in: c }, createdAt: { gte: new Date(NOW - 7 * D) } }, _count: { _all: true } }));
  const runInfo = new Map();
  for (const r of runAgg) {
    const x = runInfo.get(r.sessionId) || { total: 0, live: 0, interrupted: 0, completed: 0, failed: 0, cancelled: 0, last: null };
    const n = r._count._all; x.total += n;
    if (r.status === 'queued' || r.status === 'running') x.live += n;
    if (r.status === 'interrupted') x.interrupted += n;
    if (r.status === 'completed') x.completed += n;
    if (r.status === 'failed') x.failed += n;
    if (r.status === 'cancelled') x.cancelled += n;
    const at = r._max.createdAt ? new Date(r._max.createdAt).getTime() : 0;
    if (!x.last || at > x.last.at) x.last = { status: r.status, at, fin: r._max.finishedAt ? new Date(r._max.finishedAt).getTime() : null };
    runInfo.set(r.sessionId, x);
  }
  const r14 = new Map(runs14.map((r) => [r.sessionId, r._count._all]));
  const r7 = new Map(runs7.map((r) => [r.sessionId, r._count._all]));
  const m7 = new Map(msgs7.map((r) => [r.chatId, r._count._all]));
  const planRows = await inChunks(ids, (c) => prisma.contextStoreEntry.findMany({ where: { namespacePath: { in: c.map((i) => `${i}:coding-plan`) }, key: 'plan' }, select: { namespacePath: true, value: true, expiresAt: true } }));
  const plans = new Map();
  for (const p of planRows) {
    if (p.expiresAt && new Date(p.expiresAt).getTime() < NOW) continue;
    const steps = (p.value && Array.isArray(p.value.steps)) ? p.value.steps : [];
    const open = steps.filter((s) => s && (s.status === 'pending' || s.status === 'in_progress')).length;
    plans.set(p.namespacePath.replace(/:coding-plan$/, ''), { total: steps.length, open, blocked: steps.filter((s) => s && s.status === 'blocked').length, complete: steps.length > 0 && open === 0 });
  }

  // ── 3. Charter goals / todos + assigned todos ──
  const goalIds = [...new Set(scope.map((c) => c.charterGoalId).filter(Boolean))];
  const todoIds = [...new Set(scope.map((c) => c.charterTodoId).filter(Boolean))];
  const goals = new Map((await inChunks(goalIds, (c) => prisma.projectGoal.findMany({ where: { id: { in: c } }, select: { id: true, status: true } }))).map((g) => [g.id, g]));
  const todos = new Map((await inChunks(todoIds, (c) => prisma.projectTodo.findMany({ where: { id: { in: c } }, select: { id: true, status: true, goalId: true } }))).map((t) => [t.id, t]));
  const assigned = await inChunks(ids, (c) => prisma.projectTodo.groupBy({ by: ['assigneeChatId', 'status'], where: { assigneeChatId: { in: c } }, _count: { _all: true } }));
  const todoBy = new Map();
  for (const a of assigned) { const x = todoBy.get(a.assigneeChatId) || { open: 0, total: 0 }; x.total += a._count._all; if (OPEN_TODO.includes(a.status)) x.open += a._count._all; todoBy.set(a.assigneeChatId, x); }

  // ── 4. Tickets (paged by id; matched in memory against every lane link the maps name) ──
  const closedWindowWhere = { status: { in: CLOSED }, updatedAt: { gte: new Date(NOW - 7 * D) } };
  const closedWindow = await prisma.userFeatureRequest.findMany({ where: closedWindowWhere, orderBy: { updatedAt: 'desc' }, take: 100, select: { id: true, updatedAt: true, context: true } });
  const closedWindowSet = new Set(closedWindow.map((t) => t.id));
  const closedWindowTotal = await prisma.userFeatureRequest.count({ where: closedWindowWhere });
  const windowLaneRows = closedWindow.filter((t) => str(ctxOf(t).dispatchMode) === 'ticket_lane' && str(ctxOf(t).dispatchedTo));
  console.log(`CLOSED_WINDOW total7d=${closedWindowTotal} taken=${closedWindow.length} edgeUpdatedAt=${ts(closedWindow.length ? closedWindow[closedWindow.length - 1].updatedAt : null)} laneRowsInWindow=${windowLaneRows.length} ofWhich_laneArchivedAt_set=${windowLaneRows.filter((t) => str(ctxOf(t).laneArchivedAt)).length}`);
  const links = new Map(); // laneId → [{t, role}]
  const addLink = (lane, t, role) => { if (!lane || !scopeSet.has(lane)) return; const l = links.get(lane) || []; l.push({ t, role }); links.set(lane, l); };
  const riders = new Map(); // laneId → open family rows stamped to it
  const reporterIds = new Set();
  let cursor = null; let pages = 0; let ticketRows = 0;
  const tstat = { reopenedWithLAA: 0, openWithLAA: 0, awaitingWithLane: 0, closedLaneNoLAA: 0, closedLaneNoLAAOutOfWindow: 0, prevLaneRefs: 0 };
  for (;;) {
    const page = await prisma.userFeatureRequest.findMany({ select: { id: true, status: true, type: true, source: true, createdAt: true, updatedAt: true, context: true }, orderBy: { id: 'asc' }, take: 2000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!page.length) break;
    pages++; ticketRows += page.length; cursor = page[page.length - 1].id;
    for (const t of page) {
      const c = ctxOf(t);
      const st = String(t.status || '').trim().toLowerCase();
      const lane = str(c.dispatchedTo);
      const mode = str(c.dispatchMode);
      if (lane) {
        addLink(lane, t, mode === 'ticket_lane' ? 'd' : 'd-batch');
        if (mode === 'ticket_lane' && c.family && RIDER_STATUSES.includes(st)) riders.set(lane, (riders.get(lane) || 0) + 1);
        if (mode === 'ticket_lane' && CLOSED.includes(st) && !str(c.laneArchivedAt)) { tstat.closedLaneNoLAA++; if (!closedWindowSet.has(t.id)) tstat.closedLaneNoLAAOutOfWindow++; }
        if (mode === 'ticket_lane' && OPEN_TICKET.includes(st) && str(c.laneArchivedAt)) { tstat.openWithLAA++; if (typeof c.reopenCount === 'number' && c.reopenCount > 0) tstat.reopenedWithLAA++; }
        if (mode === 'ticket_lane' && st === 'awaiting_verification') tstat.awaitingWithLane++;
        if (scopeSet.has(lane)) for (const k of ['sessionId', 'chatId', 'codingSessionId']) if (str(c[k]) && str(c[k]) !== lane) reporterIds.add(str(c[k]));
      }
      if (Array.isArray(c.previousLanes)) for (const p of c.previousLanes) { if (String(p) !== lane) { addLink(String(p), t, 'prev'); tstat.prevLaneRefs++; } }
      if (str(c.codingSessionId) && str(c.codingSessionId) !== lane) addLink(str(c.codingSessionId), t, 'cod');
      if (str(c.filedBy) && str(c.filedBy) !== lane) addLink(str(c.filedBy), t, 'fil');
      for (const k of ['sessionId', 'chatId']) if (str(c[k]) && str(c[k]) !== lane && str(c[k]) !== str(c.codingSessionId)) addLink(str(c[k]), t, 'ses');
    }
    if (pages >= 60) break;
  }
  console.log(`TICKETS rows=${ticketRows} pages=${pages}${pages >= 60 ? ' (CAPPED)' : ''} closedLaneRows_noLaneArchivedAt=${tstat.closedLaneNoLAA} (outOfWindow=${tstat.closedLaneNoLAAOutOfWindow}) openLaneRows_withLaneArchivedAt=${tstat.openWithLAA} (reopenCount>0: ${tstat.reopenedWithLAA}) awaitingVerificationWithLane=${tstat.awaitingWithLane} previousLanesRefs=${tstat.prevLaneRefs}`);

  // ── 5. Lineage: parents, reporters, delegation ledger ──
  const dlg = await inChunks(ids, (c) => prisma.delegationTask.findMany({ where: { childChatId: { in: c } }, select: { childChatId: true, parentChatId: true, kind: true, source: true, state: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5000 }).catch((e) => { console.log(`DLG_ERR ${String(e && e.message).slice(0, 120)}`); return []; }));
  const dlgBy = new Map();
  for (const d of dlg) { const l = dlgBy.get(d.childChatId) || []; l.push(d); dlgBy.set(d.childChatId, l); }
  const refIds = new Set([...scope.map((c) => c.parentChatId).filter(Boolean), ...reporterIds, ...dlg.map((d) => d.parentChatId).filter(Boolean)]);
  const known = new Map(chats.map((c) => [c.id, { id: c.id, projectId: c.projectId, archivedAt: null, isSupervisor: c.isSupervisor, isProjectSupervisor: c.isProjectSupervisor, coding: states.has(c.id) }]));
  const missingRefs = [...refIds].filter((i) => !known.has(i));
  for (const k of await inChunks(missingRefs, (c) => prisma.crossModelChat.findMany({ where: { id: { in: c } }, select: { id: true, projectId: true, archivedAt: true, isSupervisor: true, isProjectSupervisor: true } }))) known.set(k.id, { ...k, coding: null });
  const kindOf = (k) => (!k ? 'gone' : k.isSupervisor ? 'FS' : k.isProjectSupervisor ? 'PS' : k.coding === false ? 'plain' : k.coding === true ? 'lane' : 'chat');
  const psByProject = new Map();
  for (const c of chats) if (c.isProjectSupervisor && c.projectId) psByProject.set(c.projectId, c.id);

  // ── 6. Receipts (PRs + last mutating), loop metrics per lane ──
  const prRows = await inChunks(ids, (c) => prisma.runToolReceipt.findMany({ where: { chatId: { in: c }, ok: true, tool: { in: ['open_pull_request', 'merge_pull_request'] } }, select: { chatId: true, tool: true, ids: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 8000 }));
  const prBy = new Map();
  for (const r of prRows) {
    const x = prBy.get(r.chatId) || { opened: new Map(), merged: new Set() };
    const n = r.ids && typeof r.ids === 'object' ? r.ids.prNumber : null;
    if (n != null) { if (r.tool === 'open_pull_request') { if (!x.opened.has(String(n))) x.opened.set(String(n), r.createdAt); } else x.merged.add(String(n)); }
    prBy.set(r.chatId, x);
  }
  const mutAgg = await inChunks(ids, (c) => prisma.runToolReceipt.groupBy({ by: ['chatId'], where: { chatId: { in: c }, ok: true, tool: { in: R6_TOOLS } }, _max: { createdAt: true } }));
  const lastMut = new Map(mutAgg.map((m) => [m.chatId, m._max.createdAt]));
  const lmAgg = await inChunks(ids, (c) => prisma.loopMetric.groupBy({ by: ['sessionId', 'kind'], where: { sessionId: { in: c }, kind: { in: ['finish_run', 'deliverable_handoff', 'child_session_archived', 'session_topology', 'lane_idle_wake', 'ticket_lane_slot_release'] }, createdAt: { gte: new Date(NOW - 30 * D) } }, _count: { _all: true }, _max: { createdAt: true } }));
  const lmBy = new Map();
  for (const r of lmAgg) { const x = lmBy.get(r.sessionId) || {}; x[r.kind] = { n: r._count._all, at: r._max.createdAt }; lmBy.set(r.sessionId, x); }
  const lastMeta = new Map(); // `${lane}|${kind}` → meta
  const needMeta = [];
  for (const [lane, x] of lmBy) for (const k of ['finish_run', 'deliverable_handoff']) if (x[k]) needMeta.push([lane, k]);
  await pool(needMeta, 8, async ([lane, kind]) => {
    const r = await prisma.loopMetric.findFirst({ where: { sessionId: lane, kind }, orderBy: { createdAt: 'desc' }, select: { meta: true } }).catch(() => null);
    if (r) lastMeta.set(`${lane}|${kind}`, r.meta && typeof r.meta === 'object' ? r.meta : {});
  });

  // ── 7. Per-chat lines + verdicts ──
  const verdictsBy = new Map();
  const homeFirst = (p) => (home && p === home.projectId ? 0 : /crossmodel/i.test(String((projById.get(p) || {}).name || '')) ? 1 : 2);
  const byProject = new Map();
  for (const c of scope) { const l = byProject.get(c.projectId) || []; l.push(c); byProject.set(c.projectId, l); }
  const projOrder = [...byProject.keys()].sort((a, b) => homeFirst(a) - homeFirst(b) || byProject.get(b).length - byProject.get(a).length);
  const globalCounts = {};
  const summaries = [];
  for (const pid of projOrder) {
    const p = projById.get(pid) || {};
    const list = byProject.get(pid);
    const projChats = chats.filter((c) => c.projectId === pid);
    const plainIdle7 = projChats.filter((c) => !scopeSet.has(c.id) && new Date(c.updatedAt).getTime() < NOW - 7 * D).length;
    const header = `PROJECT ${id8(pid)} name="${clipName(p.name)}" owner=${id8(p.userId)} autoArchiveIdleDays=${p.autoArchiveIdleDays ?? 'null'} psEnabled=${!!p.projectSupervisorEnabled} folderArchived=${!!p.archivedAt} userSpace=${!!p.isUserSpace} chats=${projChats.length} inScope=${list.length} plainOutOfScope_idle7d=${plainIdle7} ps=${id8(psByProject.get(pid))}${home && pid === home.projectId ? ' LANE_HOME' : ''}`;
    // order: supervisors, then roots by updatedAt desc, each followed by its in-folder children
    const inFolder = new Set(list.map((c) => c.id));
    const kids = new Map();
    for (const c of list) if (c.parentChatId && inFolder.has(c.parentChatId)) { const l = kids.get(c.parentChatId) || []; l.push(c); kids.set(c.parentChatId, l); }
    const roots = list.filter((c) => !(c.parentChatId && inFolder.has(c.parentChatId))).sort((a, b) => (b.isProjectSupervisor - a.isProjectSupervisor) || (new Date(b.updatedAt) - new Date(a.updatedAt)));
    const ordered = []; const seen = new Set();
    const visit = (c, depth) => { if (seen.has(c.id)) return; seen.add(c.id); ordered.push([c, depth]); for (const k of (kids.get(c.id) || []).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))) visit(k, depth + 1); };
    for (const r of roots) visit(r, 0);
    for (const c of list) if (!seen.has(c.id)) ordered.push([c, 0]);
    const counts = {};
    const lines = [];
    for (const [c, depth] of ordered) {
      const cs = states.get(c.id) || null;
      const ri = runInfo.get(c.id) || { total: 0, live: 0, interrupted: 0, completed: 0, failed: 0, cancelled: 0, last: null };
      const sch = schedBy.get(c.id) || [];
      const en = sch.filter((s) => s.enabled);
      const plan = plans.get(c.id) || { total: 0, open: 0, blocked: 0, complete: false };
      const g = c.charterGoalId ? goals.get(c.charterGoalId) : null;
      const td = c.charterTodoId ? todos.get(c.charterTodoId) : null;
      const at = todoBy.get(c.id) || { open: 0, total: 0 };
      const lk = links.get(c.id) || [];
      const dl = dlgBy.get(c.id) || [];
      const lm = lmBy.get(c.id) || {};
      const pr = prBy.get(c.id);
      const endedAt = ri.last ? (ri.last.fin || ri.last.at) : null;
      const lastActivity = Math.max(endedAt || 0, cs ? new Date(cs.updatedAt).getTime() : 0) || new Date(c.createdAt).getTime();
      const idleH = Math.round((NOW - lastActivity) / H);
      const idle6 = ri.live === 0 && lastActivity < NOW - 6 * H;
      const isSup = c.isSupervisor || c.isProjectSupervisor;
      const dLinks = lk.filter((x) => x.role === 'd');
      const isFamily = dLinks.some((x) => ctxOf(x.t).family) || /^family /i.test(c.title);
      const kind = c.isSupervisor ? 'FS' : c.isProjectSupervisor ? 'PS' : c.id === standingLaneId ? 'STD' : isFamily ? 'FAM' : dLinks.length ? 'TL' : c.parentChatId ? 'CH' : cs ? 'L' : 'P';
      // parent state
      let parTag = '-';
      const par = c.parentChatId ? known.get(c.parentChatId) : null;
      if (c.parentChatId) parTag = !par ? `${id8(c.parentChatId)}:MISSING` : par.archivedAt ? `${id8(c.parentChatId)}:ARCH` : par.projectId !== c.projectId ? `${id8(c.parentChatId)}:OTHER:${par.projectId ? id8(par.projectId) : 'ungrouped'}:${kindOf(par)}` : `${id8(c.parentChatId)}:ok:${kindOf(par)}`;
      const v = [];
      if (isSup) v.push('SUPERVISOR');
      if (cs && cs.status === 'running' && ri.live === 0) v.push('STUCK_RUNNING_STATE');
      if (cs && cs.status === 'archived') v.push('SATELLITE_ARCHIVED_CHAT_VISIBLE');
      // ticket lanes
      for (const { t } of dLinks) {
        const tc = ctxOf(t); const st = String(t.status || '').trim().toLowerCase();
        if (CLOSED.includes(st)) {
          const why = [];
          if (str(tc.laneArchivedAt)) why.push('LAA_SET');
          if (!closedWindowSet.has(t.id)) why.push(new Date(t.updatedAt).getTime() < NOW - 7 * D ? 'OUT_OF_WINDOW:>7d' : 'OUT_OF_WINDOW:not_top100');
          if (riders.get(c.id)) why.push(`FAMILY_RIDERS:${riders.get(c.id)}`);
          if (en.length) why.push(`SCHED_ENABLED:${en.length}`);
          if (cs && cs.status === 'running') why.push('RUNNING_STATE');
          if (ri.live) why.push(`LIVE:${ri.live}`);
          if (!why.length) why.push('DRAIN_SHOULD_ARCHIVE');
          v.push(`TICKET_CLOSED_NOT_ARCHIVED(${id8(t.id)}:${why.join('+')})`);
        } else if (st === 'awaiting_verification') v.push(`TICKET_AWAITING_VERIFICATION(${id8(t.id)})`);
        else if (OPEN_TICKET.includes(st) && ri.live === 0 && idleH >= 8) v.push(`TICKET_OPEN_LANE_IDLE(${id8(t.id)}:${idleH}h)`);
      }
      for (const { t } of lk.filter((x) => x.role === 'd-batch')) if (CLOSED.includes(String(t.status || '').toLowerCase())) v.push(`BATCH_SESSION_CLOSED(${id8(t.id)})`);
      const prev = lk.filter((x) => x.role === 'prev');
      if (prev.length && !dLinks.length) v.push(`ORPHAN_PREVIOUS_LANE(${prev.slice(0, 3).map((x) => `${id8(x.t.id)}:${x.t.status}`).join(',')})`);
      if (/^(ticket [0-9a-f]{6,}|family )/i.test(c.title) && !dLinks.length && !prev.length && !lk.some((x) => x.role === 'd-batch')) v.push('TICKET_LANE_UNLINKED');
      // children (run-reaper (e)/(h)) + parent rendering
      if (c.parentChatId) {
        if (!par) v.push('ORPHAN_PARENT:missing');
        else if (par.archivedAt) v.push('ORPHAN_PARENT:archived');
        else if (par.projectId !== c.projectId) v.push(`ORPHAN_PARENT:other_folder:${par.projectId ? id8(par.projectId) : 'ungrouped'}:${kindOf(par)}`);
        const quietSat = cs && ['ready', 'error'].includes(cs.status);
        const noLive = ri.live === 0 && ri.interrupted === 0;
        if (quietSat && noLive && !en.length && ri.last && endedAt < NOW - 6 * H && new Date(cs.updatedAt).getTime() < NOW - 6 * H) {
          if (ri.last.status === 'completed') v.push(plan.complete ? 'CHILD_DONE_NOT_ARCHIVED' : plan.total === 0 ? 'CHILD_FINISHED_EMPTY_BOARD' : `CHILD_QUIET_PLAN_OPEN(${plan.open})`);
          else if (['failed', 'cancelled'].includes(ri.last.status)) v.push(`CHILD_LAST_RUN_${ri.last.status.toUpperCase()}_WAITS_7D`);
        }
        if (quietSat && noLive && !en.length && new Date(cs.updatedAt).getTime() < NOW - 7 * D && new Date(c.updatedAt).getTime() < NOW - 7 * D && !(r7.get(c.id)) && !(m7.get(c.id))) v.push('CHILD_IDLE_7D_NOT_ARCHIVED');
      } else if (!isSup && cs) {
        // FLAT_SHOULD_NEST: who should this top-level lane hang under? Ticket / family lanes →
        // the folder's project supervisor unless the reporter IS that supervisor (a mishap's
        // reporter is the lane the mishap was filed against); other lanes → the spawner the
        // delegation ledger names.
        const ps = psByProject.get(c.projectId);
        const where = (k) => (!k ? 'gone' : k.archivedAt ? 'archived' : k.projectId ? (k.projectId === c.projectId ? 'here' : `other:${id8(k.projectId)}`) : 'ungrouped');
        if (dLinks.length || isFamily) {
          const tc = dLinks.length ? ctxOf(dLinks[0].t) : {};
          const rep = str(tc.sessionId) || str(tc.chatId) || str(tc.codingSessionId) || ((dl.find((d) => d.parentChatId && d.parentChatId !== c.id) || {}).parentChatId) || '';
          const rk = rep ? known.get(rep) : null;
          if (rk && rk.isProjectSupervisor && !rk.archivedAt && rk.projectId === c.projectId) v.push(`FLAT_SHOULD_NEST(${id8(rep)}:PS:ticket_reporter)`);
          else if (ps) v.push(`FLAT_SHOULD_NEST(${id8(ps)}:PS:${isFamily ? 'family_home' : 'ticket_home'};reporter=${rep ? `${id8(rep)}:${where(rk)}:${kindOf(rk)}` : 'none'})`);
          else if (rep) v.push(`FLAT_INTENDED_PARENT_OTHER_FOLDER(${id8(rep)}:${kindOf(rk)}:ticket_reporter:${where(rk)};no_project_supervisor)`);
        } else {
          const d0 = dl.find((d) => d.parentChatId && d.parentChatId !== c.id);
          if (d0) {
            const k = known.get(d0.parentChatId);
            if (k && !k.archivedAt && k.projectId === c.projectId) v.push(`FLAT_SHOULD_NEST(${id8(d0.parentChatId)}:${kindOf(k)}:dlg:${d0.source})`);
            else v.push(`FLAT_INTENDED_PARENT_OTHER_FOLDER(${id8(d0.parentChatId)}:${kindOf(k)}:dlg:${d0.source}:${where(k)})`);
          }
        }
      }
      // idle / done lanes (deterministic archivers do not cover top-level lanes)
      if (!isSup && cs) {
        const charterDone = (!c.charterTodoId || (td && ['done', 'dropped'].includes(td.status))) && (!c.charterGoalId || (g && ['done', 'archived'].includes(g.status)));
        const hasCharter = !!(c.charterGoalId || c.charterTodoId);
        if (!c.parentChatId && !en.length && idle6 && at.open === 0 && hasCharter && charterDone && !dLinks.length) v.push(`IDLE_NO_SCHEDULE_GOAL_DONE(${idleH}h)`);
        const mutAt = lastMut.get(c.id);
        const ageMs = NOW - new Date(c.createdAt).getTime();
        const r6idle = mutAt ? NOW - new Date(mutAt).getTime() > 6 * H : ageMs > 6 * H && !(r14.get(c.id));
        const running = ri.live > 0 || (cs && cs.status === 'running');
        const r6base = !running && !en.length && at.open === 0 && r6idle;
        if (r6base && !c.charterTodoId) v.push('R6_CANDIDATE');
        else if (r6base && c.charterTodoId && (!td || ['done', 'dropped'].includes(td.status))) v.push(`R6_MASKED_BY_STALE_CHARTER(todo:${td ? td.status : 'gone'})`);
        if (en.length && ri.live === 0 && at.open === 0 && charterDone && lastActivity < NOW - 6 * H) v.push(`SCHEDULE_BLOCKS_ARCHIVE(${en.map((s) => `${s.promptSetBy || 'null'}${s.ownerSubscribed ? '+sub' : ''}`).join(',')})`);
      }
      if (!isSup) {
        const upd = new Date(c.updatedAt).getTime();
        if (p.autoArchiveIdleDays == null) { if (upd < NOW - 7 * D && !en.length && ri.live === 0) v.push(`IDLE_ARCHIVER_OFF(${Math.round((NOW - upd) / D)}d)`); }
        else if (upd < NOW - p.autoArchiveIdleDays * D && !en.length && ri.live === 0 && !(cs && ['running', 'provisioning'].includes(cs.status))) v.push(`IDLE_ARCHIVER_SHOULD_HAVE(${Math.round((NOW - upd) / D)}d>${p.autoArchiveIdleDays}d)`);
      }
      if (!v.length) v.push(ri.live ? 'ACTIVE' : 'OK');
      for (const x of v) { const key = x.split('(')[0].replace(/:.*$/, ''); counts[key] = (counts[key] || 0) + 1; globalCounts[key] = (globalCounts[key] || 0) + 1; }
      verdictsBy.set(c.id, v);
      const schTxt = sch.length ? `${en.length}/${sch.length}${en.length ? ' ' + en.slice(0, 3).map((s) => `${s.kind}:${s.intervalSec ?? '-'}s:${s.runsCount}/${s.maxRuns ?? '∞'}:${s.promptSetBy || 'null'}${s.ownerSubscribed ? '+sub' : ''}:next${ts(s.nextRunAt)}:${String(s.lastStatus || '-').replace(/[\s|"]+/g, '_').slice(0, 24)}`).join(' ') : ''}` : '0/0';
      const tix = lk.slice(0, 4).map(({ t, role }) => { const tc = ctxOf(t); return `${id8(t.id)}:${t.status}:${role}:${t.type}:${t.source}:upd${ts(t.updatedAt)}${str(tc.laneArchivedAt) ? ':LAA' : ''}${closedWindowSet.has(t.id) ? ':win' : ''}${tc.family ? `:fam=${String((tc.family || {}).role || '?')}` : ''}${typeof tc.laneDispatches === 'number' ? `:disp${tc.laneDispatches}` : ''}${typeof tc.reopenCount === 'number' && tc.reopenCount ? `:reopen${tc.reopenCount}` : ''}`; }).join(',') + (lk.length > 4 ? `,+${lk.length - 4}` : '');
      const dlTxt = dl.slice(0, 3).map((d) => `${d.kind}/${d.source}:${id8(d.parentChatId)}:${d.state}`).join(',');
      const prTxt = pr ? [...pr.opened.keys()].slice(0, 5).map((n) => `#${n}${pr.merged.has(n) ? 'm' : 'o'}`).join(',') + (pr.merged.size ? ` mergedByLane=${pr.merged.size}` : '') : '-';
      const fr = lm.finish_run ? `${lm.finish_run.n}:last=${str((lastMeta.get(`${c.id}|finish_run`) || {}).status) || '?'}@${ts(lm.finish_run.at)}` : '0';
      const hoM = lastMeta.get(`${c.id}|deliverable_handoff`) || {};
      const ho = lm.deliverable_handoff ? `${lm.deliverable_handoff.n}:posted=${hoM.posted === true}${hoM.skipped ? `:skip=${str(hoM.skipped)}` : ''}@${ts(lm.deliverable_handoff.at)}` : '0';
      lines.push(`LANE ${'·'.repeat(depth)}${id8(c.id)} k=${kind} t="${clipTitle(c.title)}" proj=${id8(c.projectId)} par=${parTag} st=${cs ? cs.status : 'plain'} cr=${ts(c.createdAt)} up=${ts(c.updatedAt)} last=${ri.last ? `${ri.last.status}@${ts(ri.last.at)}` : '-'} fin=${ri.last && ri.last.fin ? ts(ri.last.fin) : '-'} live=${ri.live} int=${ri.interrupted} runs=${ri.total}/14d${r14.get(c.id) || 0} idle=${idleH}h sch=${schTxt} ch=${c.charterGoalId ? `${id8(c.charterGoalId)}:${g ? g.status : 'gone'}` : '-'}|${c.charterTodoId ? `${id8(c.charterTodoId)}:${td ? td.status : 'gone'}` : '-'} todos=${at.open}/${at.total} plan=${plan.total - plan.open}/${plan.total}${plan.blocked ? `(b${plan.blocked})` : ''} pin=${c.titlePinned ? 1 : 0}`);
      lines.push(`  LINK completedRuns=${ri.completed} failed=${ri.failed} finish_run=${fr} handoff=${ho} lastMutRcpt=${lastMut.get(c.id) ? `${hAgo(lastMut.get(c.id))}h` : '-'} r6Rows30d=${lm.session_topology ? lm.session_topology.n : 0} childArchRows=${lm.child_session_archived ? lm.child_session_archived.n : 0} idleWake=${lm.lane_idle_wake ? lm.lane_idle_wake.n : 0} slotRel=${lm.ticket_lane_slot_release ? lm.ticket_lane_slot_release.n : 0} msgs7d=${m7.get(c.id) || 0} pr=${prTxt} dlg=[${dlTxt}] tix=[${tix}]`);
      lines.push(`  VERDICT ${id8(c.id)} ${v.join(' ')}`);
    }
    summaries.push(`SUMMARY ${id8(pid)} name="${clipName(p.name)}" inScope=${list.length} ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`);
    if (detailLines >= DETAIL_BUDGET) { summaries[summaries.length - 1] += ' details=omitted(budget)'; continue; }
    detail(header);
    let printed = 0;
    for (const l of lines) { if (detailLines >= DETAIL_BUDGET) break; detail(l); printed++; }
    if (printed < lines.length) detail(`  …TRUNCATED ${id8(pid)}: ${Math.ceil((lines.length - printed) / 3)} more chat(s) not listed (budget)`);
  }

  // ── 8. Summaries ──
  for (const s of summaries) console.log(s.slice(0, 690));
  console.log(`GLOBAL ${Object.entries(globalCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`.slice(0, 690));

  // ── 9. Named examples (archived or not, any project — the owner's sidebar rows) ──
  const namedRows = await prisma.crossModelChat.findMany({
    where: { OR: NAMED.map((n) => ({ title: { contains: n, mode: 'insensitive' } })) },
    select: { id: true, title: true, projectId: true, parentChatId: true, archivedAt: true, isSupervisor: true, isProjectSupervisor: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' }, take: 40,
  }).catch((e) => { console.log(`NAMED_ERR ${String(e && e.message).slice(0, 120)}`); return []; });
  for (const n of namedRows) {
    const cs = states.get(n.id);
    const v = verdictsBy.get(n.id);
    console.log(`NAMED ${id8(n.id)} t="${clipTitle(n.title)}" proj=${id8(n.projectId)} par=${id8(n.parentChatId)} archived=${n.archivedAt ? ts(n.archivedAt) : 'no'} coding=${cs ? cs.status : (scopeSet.has(n.id) ? 'plain' : '?')} up=${ts(n.updatedAt)} inScope=${scopeSet.has(n.id)} verdicts=${v ? v.join(' ') : '-'}`.slice(0, 690));
  }

  // ── 10. Loop-metric tails for every mechanism ──
  for (const kind of LM_KINDS) {
    const [n24, n7] = await Promise.all([
      prisma.loopMetric.count({ where: { kind, createdAt: { gte: new Date(NOW - D) } } }).catch(() => -1),
      prisma.loopMetric.count({ where: { kind, createdAt: { gte: new Date(NOW - 7 * D) } } }).catch(() => -1),
    ]);
    const last = await prisma.loopMetric.findMany({ where: { kind }, orderBy: { createdAt: 'desc' }, take: 3, select: { createdAt: true, sessionId: true, value: true, meta: true } }).catch(() => []);
    console.log(`LM ${kind} n24h=${n24} n7d=${n7}`);
    for (const r of last) console.log(`  ${ts(r.createdAt)} s=${id8(r.sessionId)} v=${r.value ?? '-'} meta=${safeMeta(r.meta)}`);
  }
  // R6 retire rows specifically (session_topology mixes spawn + scan sites)
  const r6 = await prisma.loopMetric.findMany({ where: { kind: 'session_topology', createdAt: { gte: new Date(NOW - 7 * D) } }, select: { meta: true, sessionId: true }, take: 5000 }).catch(() => []);
  const r6scan = r6.filter((r) => r.meta && r.meta.rule === 'R6');
  console.log(`R6_SCAN_ROWS_7D ${r6scan.length} distinctLanes=${new Set(r6scan.map((r) => r.sessionId)).size} stillUnarchivedInScope=${r6scan.filter((r) => scopeSet.has(r.sessionId)).length}`);

  console.log('LLC_DONE');
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log(`PROBE_ERR ${e && e.message}`); process.exit(0); });
LLC_PROBE_EOF
    if out=$(timeout 420 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-lane-lifecycle-1021.js 2>&1) && printf '%s' "$out" | grep -q '^LLC_DONE'; then
      echo "$out" | cut -c1-700 | head -n 900
      sudo touch "$MARKER_LLC1021"
    else
      echo "$out" | cut -c1-700 | tail -n 40; echo "  probe failed or incomplete — marker left unset"
    fi
    echo "== END LLC1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): LVC1021B — READ-ONLY follow-up on three LVC1021 live checks that need a closer look.
  # (1) 658ecf0e: 26 "Docker not available" warns in 24 h and app_error_logs has no host column — group them by the
  # error class in the message and by hour (a box A/B backend would show the dead 10.0.0.15:2375 proxy path).
  # (2) 3c18284e: LVC1021 read meta.backend before meta.backendSpec, so the cql/laya leg rows were never matched —
  # group decision_gate rows by backendSpec and the backend_down rows by event / purpose / spec. (3) 6da0db0a /
  # 0c9d23e2: web_fetch_path rows where neither tier answered, by hour (a burst vs a trickle). (4) 2c9dfc66: the two
  # past-backstop credit-saved rows the census now shows, with their crediting schedules. Counts / ids / class names only.
  MARKER_LVC1021B=/var/tmp/.digby-lvc1021b-live-checks
  if [ ! -f "$MARKER_LVC1021B" ]; then
    echo "== LVC1021B host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/lvc1021b.js >/dev/null <<'LVCB_EOF'
const prisma = require('/app/dist/config/database').default;
const day = new Date(Date.now() - 24 * 3600e3);
const out = {};
const q = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: String(e && e.message || e).slice(0, 160) }; } };
const hour = (d) => new Date(d).toISOString().slice(0, 13);
const tally = (g, k) => { g[k] = (g[k] || 0) + 1; };
(async () => {
  await q('docker_warns_24h', async () => {
    const rows = await prisma.appErrorLog.findMany({ where: { createdAt: { gte: day }, message: { startsWith: 'coding container: Docker not available' } }, select: { createdAt: true, message: true, source: true } });
    const byClass = {}, byHour = {};
    for (const r of rows) {
      const m = (r.message.match(/Docker not available \(([^)]*)\)/) || [])[1] || '?';
      const cls = m.replace(/[0-9a-f]{12,}/gi, '<id>').slice(0, 90);
      tally(byClass, cls + ' | src=' + String(r.source || '-').slice(-60)); tally(byHour, hour(r.createdAt));
    }
    return { n: rows.length, byClass: Object.entries(byClass).sort((a, b) => b[1] - a[1]), byHour: Object.entries(byHour).sort() };
  });
  await q('decision_gate_by_spec_24h', async () => {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'decision_gate', createdAt: { gte: day } }, select: { meta: true }, take: 60000 });
    const g = {};
    for (const r of rows) { const m = r.meta || {}; tally(g, [String(m.backendSpec || '-').slice(0, 40), String(m.backend || '-').slice(0, 30), m.phase || '-', m.fellThrough ? 'fell' : '-', m.error ? 'err' : '-', m.challenger ? 'chal' : '-'].join('|')); }
    return { rows: rows.length, groups: Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 30) };
  });
  await q('backend_down_24h', async () => (await prisma.loopMetric.findMany({ where: { kind: 'decision_gate_backend_down', createdAt: { gte: day } }, select: { createdAt: true, meta: true }, orderBy: { createdAt: 'asc' } })).map((r) => { const m = r.meta || {}; return { at: r.createdAt, event: m.event, purpose: m.purpose, spec: m.spec, status: m.status, legs: Array.isArray(m.legErrors) ? m.legErrors.map((e) => String(e && (e.backend || e.label || e.spec) || '?').slice(0, 30) + ':' + String(e && (e.error || e.message) || e).replace(/\s+/g, ' ').slice(0, 70)) : undefined }; }));
  await q('web_fetch_none_by_hour_24h', async () => {
    const rows = await prisma.loopMetric.findMany({ where: { kind: 'web_fetch_path', createdAt: { gte: day } }, select: { createdAt: true, meta: true }, take: 20000 });
    const g = {};
    for (const r of rows) { const m = r.meta || {}; if (m.winner !== 'none') continue; tally(g, hour(r.createdAt) + '|' + (m.tool || '?')); }
    return Object.entries(g).sort();
  });
  console.log('LVCB ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('LVCB_ERROR ' + String(e && e.message || e).slice(0, 300)); process.exit(0); });
LVCB_EOF
    LVCB_OUT=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/lvc1021b.js 2>&1)
    printf '%s\n' "$LVCB_OUT" | grep -E '^LVCB' | fold -w 3000
    P2C_RAW=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh probe-2c9dfc66.js 2>/dev/null)
    printf '%s' "$P2C_RAW" | python3 -c 'import sys,json
t=sys.stdin.read(); i=t.find("{")
try: d=json.loads(t[i:])
except Exception as e: print("P2CB parse failed:", str(e)[:120]); sys.exit(0)
for r in d.get("latent_exposure") or []:
    if "past 24h backstop" in r.get("saved_today_by",""): print("P2CB", json.dumps({k: r.get(k) for k in ("todo","title","quietH","recurring_only","crediting","dead_watch")})[:900])
print("P2CB summary", json.dumps(d.get("latent_exposure_summary")))'
    if printf '%s' "$LVCB_OUT" | grep -q '^LVCB {'; then sudo touch "$MARKER_LVC1021B"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$LVCB_OUT" | tail -3 | cut -c1-300; fi
    echo "== END LVC1021B =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): JWT1021 — READ-ONLY: why the Framework Operator lane 5f90c628 is still titled
  # "5. Close the JWT pending-IP watch · …" days after the JWT pending-IP watch resolved (FO f155: "jwt pair now
  # baseline-resolved"), and why it still reports to the Fleet Supervisor every few hours (owner 2026-10-21: "how come
  # i still see 5. Close the JWT pending-IP watch in fleet supervisor"). Reads the lane row (title / pin / charter),
  # its charter todo + goal, every todo assigned to it and every todo titled JWT, title_render / charter_rebind rows,
  # its schedules (prompt heads redacted, 120 chars), its last runs, its sends into the Fleet Supervisor chat, and the
  # JWT spike rows + AUTH_SIGNAL_BASELINE_IPS now. Ids (8 chars), titles, statuses, times, counts. Never writes.
  MARKER_JWT1021=/var/tmp/.digby-jwt1021-lane-title-probe
  if [ ! -f "$MARKER_JWT1021" ]; then
    echo "== JWT1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/jwt1021.js >/dev/null <<'JWT_EOF'
const prisma = require('/app/dist/config/database').default;
let red = (t) => t;
try { red = require('/app/dist/modules/crossmodel/platform/secret-scan').redactInboundSecrets || red; } catch { /* keep identity */ }
const clip = (t, n) => { const v = String(red(String(t == null ? '' : t)) || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 16) + 'Z' : null);
const out = {};
const q = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: String(e && e.message || e).slice(0, 200) }; } };
(async () => {
  const lanes = await prisma.crossModelChat.findMany({ where: { OR: [{ id: { startsWith: '5f90c628' } }, { title: { contains: 'JWT pending-IP' } }] }, select: { id: true, title: true, titlePinned: true, titleStep: true, charterGoalId: true, charterTodoId: true, projectId: true, parentChatId: true, isSupervisor: true, isProjectSupervisor: true, archivedAt: true, createdAt: true, updatedAt: true } });
  out.lanes = [];
  for (const l of lanes) {
    const r = { id: l.id.slice(0, 8), title: l.title, pinned: l.titlePinned, step: l.titleStep, parent: l.parentChatId && l.parentChatId.slice(0, 8), supervisor: l.isSupervisor, projectSupervisor: l.isProjectSupervisor, archivedAt: iso(l.archivedAt), createdAt: iso(l.createdAt), updatedAt: iso(l.updatedAt) };
    await q('_', async () => { const p = l.projectId ? await prisma.crossModelProject.findUnique({ where: { id: l.projectId }, select: { name: true } }) : null; r.project = p && p.name; });
    await q('_', async () => { const c = await prisma.chatCodingState.findUnique({ where: { id: l.id }, select: { title: true, titleSource: true, status: true, model: true, createdAt: true } }); r.coding = c && { title: c.title, titleSource: c.titleSource, status: c.status, model: c.model, createdAt: iso(c.createdAt) }; });
    await q('_', async () => { if (!l.charterTodoId) { r.charterTodo = null; return; } const t = await prisma.projectTodo.findUnique({ where: { id: l.charterTodoId }, select: { id: true, title: true, status: true, assigneeChatId: true, goalId: true, updatedAt: true, createdAt: true, progressNote: true, evidence: true } }); r.charterTodo = t && { id: t.id.slice(0, 8), title: t.title, status: t.status, assignee: t.assigneeChatId && t.assigneeChatId.slice(0, 8), goal: t.goalId.slice(0, 8), createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt), note: clip(t.progressNote, 240), evidence: clip(t.evidence, 160) }; });
    await q('_', async () => { if (!l.charterGoalId) { r.charterGoal = null; return; } const g = await prisma.projectGoal.findUnique({ where: { id: l.charterGoalId }, select: { id: true, title: true, status: true, updatedAt: true, progressNote: true } }); r.charterGoal = g && { id: g.id.slice(0, 8), title: g.title, status: g.status, updatedAt: iso(g.updatedAt), note: clip(g.progressNote, 200) }; });
    await q('_', async () => { r.assignedTodos = (await prisma.projectTodo.findMany({ where: { assigneeChatId: l.id }, select: { id: true, title: true, status: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 15 })).map((t) => `${t.id.slice(0, 8)} ${t.status} ${iso(t.updatedAt)} ${clip(t.title, 90)}`); });
    await q('_', async () => { r.titleRenders7d = (await prisma.loopMetric.findMany({ where: { kind: { in: ['title_render', 'charter_rebind'] }, createdAt: { gte: new Date(Date.now() - 7 * 864e5) }, OR: [{ sessionId: l.id }, { meta: { path: ['chatId'], equals: l.id } }] }, select: { kind: true, createdAt: true, meta: true }, orderBy: { createdAt: 'desc' }, take: 12 })).map((m) => `${iso(m.createdAt)} ${m.kind} ${JSON.stringify(m.meta).slice(0, 160)}`); });
    await q('_', async () => { r.schedules = (await prisma.codingSchedule.findMany({ where: { sessionId: l.id, enabled: true }, select: { id: true, kind: true, intervalSec: true, nextRunAt: true, runsCount: true, maxRuns: true, promptSetBy: true, ownerSubscribed: true, lastFiredAt: true, lastStatus: true, createdAt: true, prompt: true } })).map((s) => ({ id: s.id.slice(0, 8), kind: s.kind, everyMin: s.intervalSec && Math.round(s.intervalSec / 60), next: iso(s.nextRunAt), runs: `${s.runsCount}/${s.maxRuns}`, by: s.promptSetBy, ownerSub: s.ownerSubscribed, last: `${iso(s.lastFiredAt)} ${s.lastStatus}`, created: iso(s.createdAt), prompt: clip(s.prompt, 160) })); });
    await q('_', async () => { r.disabledSchedules = await prisma.codingSchedule.count({ where: { sessionId: l.id, enabled: false } }); });
    await q('_', async () => { r.runs = (await prisma.agentRun.findMany({ where: { sessionId: l.id }, select: { status: true, createdAt: true, input: true }, orderBy: { createdAt: 'desc' }, take: 8 })).map((x) => { const i = x.input && typeof x.input === 'object' ? x.input : {}; return `${iso(x.createdAt)} ${x.status} ${i.origin || i.source || (i.schedule ? 'schedule' : '-')}`; }); });
    out.lanes.push(r);
  }
  await q('jwtTodos', async () => (await prisma.projectTodo.findMany({ where: { title: { contains: 'JWT', mode: 'insensitive' } }, select: { id: true, title: true, status: true, assigneeChatId: true, updatedAt: true, progressNote: true }, orderBy: { updatedAt: 'desc' }, take: 12 })).map((t) => `${t.id.slice(0, 8)} ${t.status} assignee=${t.assigneeChatId ? t.assigneeChatId.slice(0, 8) : '-'} ${iso(t.updatedAt)} | ${clip(t.title, 90)} | note: ${clip(t.progressNote, 160)}`));
  await q('jwtGoals', async () => (await prisma.projectGoal.findMany({ where: { title: { contains: 'JWT', mode: 'insensitive' } }, select: { id: true, title: true, status: true, updatedAt: true }, take: 8 })).map((g) => `${g.id.slice(0, 8)} ${g.status} ${iso(g.updatedAt)} ${clip(g.title, 90)}`));
  await q('fsSends48h', async () => {
    const fs = await prisma.crossModelChat.findMany({ where: { isSupervisor: true, archivedAt: null }, select: { id: true } });
    const res = [];
    for (const f of fs) {
      const rows = await prisma.crossModelMessage.findMany({ where: { chatId: f.id, role: 'user', createdAt: { gte: new Date(Date.now() - 48 * 3600e3) }, content: { startsWith: '[AGENT-SENT MESSAGE' } }, select: { createdAt: true, content: true }, orderBy: { createdAt: 'asc' } });
      const mine = rows.filter((x) => /\(5f90c628\)/.test(String(x.content).slice(0, 400)));
      if (!rows.length) continue;
      const head = mine.length ? (String(mine[mine.length - 1].content).match(/^\[AGENT-SENT MESSAGE — ([^\]\n]*)\]/) || [])[1] : null;
      res.push({ fs: f.id.slice(0, 8), agentRows: rows.length, fromLane: mine.length, at: mine.map((x) => iso(x.createdAt)), lastHeader: head ? clip(head, 200) : null });
    }
    return res;
  });
  await q('jwtSpikes24h', async () => ({ rows: await prisma.appErrorLog.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600e3) }, message: { startsWith: 'Invalid-signature JWT spike' } } }), last: iso((await prisma.appErrorLog.findFirst({ where: { message: { startsWith: 'Invalid-signature JWT spike' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }) || {}).createdAt) }));
  out.baselineIps = process.env.AUTH_SIGNAL_BASELINE_IPS === undefined ? '(unset)' : (process.env.AUTH_SIGNAL_BASELINE_IPS || "('')");
  console.log('JWT ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log('JWT_ERROR ' + String(e && e.message || e).slice(0, 300)); process.exit(0); });
JWT_EOF
    JWT_OUT=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/jwt1021.js 2>&1)
    printf '%s\n' "$JWT_OUT" | grep -E '^JWT' | fold -w 3000
    if printf '%s' "$JWT_OUT" | grep -q '^JWT {'; then sudo touch "$MARKER_JWT1021"; else echo "  probe incomplete — marker left unset"; printf '%s\n' "$JWT_OUT" | tail -3 | cut -c1-300; fi
    echo "== END JWT1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): PDV1021 — post-deploy verification of the ticket catch-up release 15197e979, then
  # the ticket closes. READ: the deployed dist carries each fix (validatePlanUpdate on the 17a0b383 incident shape; the
  # decision-gate-stall leaf; resolveGoalHalf for lane 5f90c628 → the charter goal; the backend env has
  # CODING_CONTAINER_PROBE_DISABLED=1), decision_gate_backend_down rows + Docker-not-available warns since the running
  # backend started. WRITE (only when every dist check passed): 17a0b383 / 4d476b9a / 9a976d83 — rows this session
  # claimed (in_progress, claim note) → done with commit + deploy + live-check evidence (awaiting_verification instead
  # when the row carries an acceptance metric); 658ecf0e — its adminNote gains the corrected cause + the fix (status
  # unchanged). 4c7aebf7 is left in_progress (it ships separately). Ids / counts / class names only.
  MARKER_PDV1021=/var/tmp/.digby-pdv1021-verify-close
  if [ ! -f "$MARKER_PDV1021" ]; then
    echo "== PDV1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    echo "  deploy-sha: $(cat /opt/crossmodel/.deploy-sha 2>/dev/null || echo missing)"
    PDV_BK=$(sudo docker ps --format '{{.Names}}' | grep -E '^admin-backend-(blue|green)$' | head -1 || true)
    PDV_SINCE=$( [ -n "$PDV_BK" ] && sudo docker inspect -f '{{.State.StartedAt}}' "$PDV_BK" 2>/dev/null || echo '')
    echo "  backend: ${PDV_BK:-none} started ${PDV_SINCE:-?}"
    sudo tee /var/tmp/pdv1021.js >/dev/null <<'PDV_EOF'
const prisma = require('/app/dist/config/database').default;
const since = new Date(process.argv[2] || Date.now() - 3600e3);
const COMMIT = '15197e979';
const DEPLOY_RUN = process.argv[3] || '39684484160';
const out = { since: since.toISOString(), checks: {}, live: {}, writes: [] };
const q = async (k, f) => { try { return await f(); } catch (e) { return { error: String(e && e.message || e).slice(0, 200) }; } };
(async () => {
  // 17a0b383 — the deployed validator accepts the incident shape
  out.checks.plan = await q('plan', async () => {
    const { validatePlanUpdate } = require('/app/dist/modules/crossmodel/coding/plan.service');
    const v = validatePlanUpdate({ steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { in_progress: 'Decrypt-by-play batching' }] });
    const st = v && v.update && Array.isArray(v.update.steps) && v.update.steps[3]; // PlanUpdateValidation = {ok, update: {steps}, notes}
    return { ok: !!(v && v.ok && st && st.text === 'Decrypt-by-play batching' && st.status === 'in_progress'), notes: (v && v.notes || []).length };
  });
  // 4d476b9a — the stall leaf is deployed
  out.checks.stall = await q('stall', async () => {
    const m = require('/app/dist/modules/crossmodel/platform/decision-gate-stall');
    return { ok: typeof m.classifyAllLegsFailed === 'function' && typeof m.legTiming === 'function' };
  });
  // lane titles — what the deployed resolver gives lane 5f90c628 now (read-only)
  out.checks.title = await q('title', async () => {
    const lane = await prisma.crossModelChat.findFirst({ where: { id: { startsWith: '5f90c628' } }, select: { id: true, title: true, charterGoalId: true, charterTodoId: true } });
    if (!lane) return { ok: false, reason: 'lane not found' };
    const { resolveGoalHalf } = require('/app/dist/modules/crossmodel/platform/session-titles');
    const g = await resolveGoalHalf(lane, 'harness');
    return { ok: /^Constant framework R&D/.test(g || ''), goalHalf: g, currentTitle: lane.title };
  });
  // 658ecf0e — the web-tier probe is off in this process
  out.checks.probe = { ok: process.env.CODING_CONTAINER_PROBE_DISABLED === '1', value: process.env.CODING_CONTAINER_PROBE_DISABLED ?? '(unset)' };
  out.live.backendDown = await q('bd', async () => (await prisma.loopMetric.findMany({ where: { kind: 'decision_gate_backend_down', createdAt: { gte: since } }, select: { createdAt: true, meta: true }, orderBy: { createdAt: 'asc' }, take: 40 })).map((r) => { const m = r.meta || {}; return `${r.createdAt.toISOString().slice(11, 19)} ${m.event} ${m.purpose} cause=${m.cause || '-'}${m.streakExempt ? ' exempt' : ''} streak=${m.streak ?? '-'} legs=${Array.isArray(m.legTimings) ? m.legTimings.length : '-'}`; }));
  out.live.stallRetryRows = await q('sr', () => prisma.loopMetric.count({ where: { kind: 'decision_gate', createdAt: { gte: since }, meta: { path: ['stall', 'retried'], equals: true } } }));
  out.live.dockerWarns = await q('dw', () => prisma.appErrorLog.count({ where: { createdAt: { gte: since }, message: { startsWith: 'coding container: Docker not available' } } }));
  const allOk = ['plan', 'stall', 'title', 'probe'].every((k) => out.checks[k] && out.checks[k].ok === true);
  out.allOk = allOk;
  if (allOk) {
    const stamp = new Date().toISOString();
    const bd = Array.isArray(out.live.backendDown) ? out.live.backendDown.length : '?';
    const ev = {
      '17a0b383': `FIXED + LIVE (${stamp}): commit ${COMMIT} on main, deploy run ${DEPLOY_RUN}. update_plan now normalises the status-keyed step {"in_progress": "<text>"} to {text, status} with a NOTE naming each step's stored status (coding/plan.service.ts statusKeyedShorthand); the transcript PlanCard renders it. Live check: the deployed validatePlanUpdate accepted the incident shape (steps[3] = {in_progress: …}) and stored it as text + status in_progress. Switch UPDATE_PLAN_STATUS_KEY_SHORTHAND_DISABLED.`,
      '4d476b9a': `FIXED + LIVE (${stamp}): commit ${COMMIT} on main, deploy run ${DEPLOY_RUN}. Every failed decision-gate leg is now timed against its own deadline and the event loop's busy share; an all_legs_failed row carries a measured cause (stall / egress / provider / mixed / budget) + leg timings; a loop-stall timeout re-asks the same leg once, sized so later legs keep their budget; only a CONFIRMED stall is exempt from the alert streak (platform/decision-gate-stall.ts). Live check: the stall leaf is in the deployed dist; ${bd} decision_gate_backend_down rows since the backend started ${since.toISOString()} (each now names its cause). Switch DECISION_GATE_STALL_RECOVERY_DISABLED.`,
      '9a976d83': `CLOSED — TRUE POSITIVE, contained pre-delivery (${stamp}). The 17:12:19Z note on chat e03452f4 headlined "17:25Z", 13 min ahead of the run's real clock; the action verifier struck it (observe-only annotation + correction row) — the guard worked. The failure that followed (the lane re-posting that struck note verbatim) is ticket 4c7aebf7, whose fix ships separately. No code change for this ticket.`,
    };
    for (const id8 of Object.keys(ev)) {
      const r = await prisma.userFeatureRequest.findFirst({ where: { id: { startsWith: id8 } }, select: { id: true, status: true, adminNote: true, context: true } });
      if (!r) { out.writes.push({ id8, result: 'not_found' }); continue; }
      const claimed = r.status === 'in_progress' && /owner-directed catch-up session/.test(String(r.adminNote || ''));
      if (!claimed) { out.writes.push({ id8, result: 'skipped', status: r.status }); continue; }
      const metric = r.context && typeof r.context === 'object' && r.context.acceptanceMetric;
      const status = metric ? 'awaiting_verification' : 'done';
      const n = await prisma.userFeatureRequest.updateMany({ where: { id: r.id, status: 'in_progress' }, data: { status, adminNote: `${ev[id8]}\n\n[earlier] ${String(r.adminNote || '').slice(0, 1500)}` } });
      out.writes.push({ id8, result: n.count === 1 ? status : 'raced' });
    }
    const f = await prisma.userFeatureRequest.findFirst({ where: { id: { startsWith: '658ecf0e' } }, select: { id: true, status: true, adminNote: true } });
    if (f && !/PREMISE CORRECTED/.test(String(f.adminNote || ''))) {
      const note = `PREMISE CORRECTED + FIXED (${stamp}): the close assumed the box A/B backends skip the Docker probe; they did not — 26 "Docker not available" warns in 24 h (LVC1021B), all \`docker info\` exits on box C's dead 2375 proxy, one per new backend container. Fix: the deploy.yml A/B .env template sets CODING_CONTAINER_PROBE_DISABLED=1 (commit ${COMMIT}, deploy run ${DEPLOY_RUN}); box C keeps its probe. Live check: this backend's env has CODING_CONTAINER_PROBE_DISABLED=1; ${out.live.dockerWarns} Docker-not-available warns since it started.`;
      await prisma.userFeatureRequest.update({ where: { id: f.id }, data: { adminNote: `${note}\n\n[earlier] ${String(f.adminNote || '').slice(0, 2500)}` } });
      out.writes.push({ id8: '658ecf0e', result: 'note_appended', status: f.status });
    } else out.writes.push({ id8: '658ecf0e', result: f ? 'already_noted' : 'not_found' });
  }
  console.log('PDV ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log('PDV_ERROR ' + String(e && e.message || e).slice(0, 300)); process.exit(0); });
PDV_EOF
    PDV_OUT=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/pdv1021.js "$PDV_SINCE" 2>&1)
    printf '%s\n' "$PDV_OUT" | grep -E '^PDV' | fold -w 3000
    if printf '%s' "$PDV_OUT" | grep -q '"allOk":true'; then sudo touch "$MARKER_PDV1021"; else echo "  checks not all green (or probe failed) — no ticket written, marker left unset"; printf '%s\n' "$PDV_OUT" | tail -3 | cut -c1-300; fi
    echo "== END PDV1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): FSV1021 — READ-ONLY post-deploy check of PR #1870 (deploy 0cccf69d0, 19:56Z):
  # every supervisor chat's briefings since the deploy (head-line repeats, nothing-new-only fleet briefings), exact
  # repeated assistant bodies named only by fixed harness prefix, owner-briefing error rows and the branch janitor's
  # last rows. Ids, hashes, flags and counts only — never message text. Never writes. Marker only on FSV_DONE.
  MARKER_FSV1021=/var/tmp/.digby-fsv1021-verify-probe
  if [ ! -f "$MARKER_FSV1021" ]; then
    echo "== FSV1021 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-fs-verify-1021.js >/dev/null <<'FSV_PROBE_EOF'
// probe-fs-verify-1021.js — READ-ONLY post-deploy check of the Fleet Supervisor chat-noise
// fixes (owner, 2026-10-21: "what are these messages over and over again? if bug please fix"):
// briefing head lines repeat only when changed, no bare fleet "Nothing new" briefing, and a
// human-turn answer never pairs the harness's honest line with an unbacked "running in the
// background" claim.
//
// Usage (on the box): SINCE=<iso> prodq.sh probe-fs-verify-1021.js
// Prints NO message text: timestamps, row kinds, fixed harness-line flags, 8-char hashes, and —
// for exact repeats only — WHICH fixed harness prefix the repeated row starts with (a constant
// name, never the row's own words). Never writes.
const crypto = require('crypto');

const H = (s) => crypto.createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 8);
const HONEST = /I have not (made that change|sent that message) yet/;
const BACKGROUND = /running in the background|underway|in flight/i;
const NOTHING_NEW = 'Nothing new on any project since the last update.';
const ROLLOUT_HEAD = 'set off by the registry lifecycle this week';
const AUDIT_HEAD = 'Live-chat audit (last 24 h)';
// Fixed harness prefixes a repeated row may start with — reported by NAME only.
const PREFIXES = [
  ['STOPPED', /^\(Stopped\.\)/],
  ['WAKE_NOOP_HARNESS', /^\**WAKE: no-op \(harness:/],
  ['WAKE_NOOP', /^\**WAKE: no-op/],
  ['SWEEP_NOOP', /^\**SWEEP: no-op/],
  ['WAKE_REPORTED', /^\**(WAKE|SWEEP): reported/],
  ['NOTHING_NEW', /^Nothing new on any project/],
  ['EMPTY_FALLBACK', /^(I wasn't able to generate a response|Sorry — I couldn't get an answer)/],
  ['HARNESS_BLOCK', /^\[HARNESS/],
];

(async () => {
  const prisma = require('/app/dist/config/database').default;
  const since = new Date('2026-10-21T19:56:20Z'); // deploy 0cccf69d0 (PR #1870) finished
  console.log(`SINCE ${since.toISOString()}`);
  const fleets = await prisma.crossModelChat.findMany({ where: { isSupervisor: true }, select: { id: true, userId: true } });
  for (const fc of fleets) {
    const rows = await prisma.crossModelMessage.findMany({
      where: { chatId: fc.id, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' },
      select: { role: true, content: true, metadata: true, parts: true, createdAt: true },
    });
    if (!rows.length) continue;
    console.log(`== chat ${fc.id.slice(0, 8)} user ${String(fc.userId).slice(0, 8)} rows ${rows.length}`);
    const hashes = new Map();
    let briefings = 0, nothingNewOnly = 0, rollout = 0, audit = 0, honestBackground = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const md = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
      const c = String(r.content || '');
      if (r.role !== 'assistant') continue;
      const h = H(c);
      const prefix = (PREFIXES.find(([, re]) => re.test(c.trim())) || ['-'])[0];
      const prev = hashes.get(h) || { n: 0, prefix };
      hashes.set(h, { n: prev.n + 1, prefix });
      if (md.kind === 'owner_briefing') {
        briefings++;
        const bare = c.replace(/\s+/g, ' ').trim();
        if (c.includes(NOTHING_NEW) && bare.length < NOTHING_NEW.length + 200) nothingNewOnly++;
        if (c.includes(ROLLOUT_HEAD)) rollout++;
        if (c.includes(AUDIT_HEAD)) audit++;
        console.log(`BRIEFING ${r.createdAt.toISOString().slice(5, 16)} len=${c.length} h=${h} nothingNew=${c.includes(NOTHING_NEW) ? 1 : 0} rollout=${c.includes(ROLLOUT_HEAD) ? 1 : 0} audit=${c.includes(AUDIT_HEAD) ? 1 : 0}`);
      }
      if (HONEST.test(c) && BACKGROUND.test(c)) {
        honestBackground++;
        const calls = (Array.isArray(r.parts) ? r.parts : []).filter((p) => p && p.type === 'tool_call').map((p) => p.name);
        console.log(`HONEST_PLUS_BACKGROUND ${r.createdAt.toISOString().slice(5, 16)} calls=${calls.join('+') || '-'}`);
      }
    }
    console.log(`TOTALS briefings=${briefings} nothingNewOnly=${nothingNewOnly} rolloutHead=${rollout} auditHead=${audit} honestPlusBackground=${honestBackground}`);
    console.log(`DUP_ASSISTANT ${JSON.stringify([...hashes.entries()].filter(([, v]) => v.n > 1).map(([k, v]) => [k, v.n, v.prefix]))}`);
  }
  // The same check over the 48 h before the fix, for the repeated bodies the health probe could not name.
  const before = new Date(since.getTime() - 48 * 3600_000);
  for (const fc of fleets) {
    const rows = await prisma.crossModelMessage.findMany({ where: { chatId: fc.id, role: 'assistant', createdAt: { gte: before, lt: since } }, select: { content: true } });
    const m = new Map();
    for (const r of rows) { const c = String(r.content || ''); const h = H(c); const p = (PREFIXES.find(([, re]) => re.test(c.trim())) || ['-'])[0]; m.set(h, { n: ((m.get(h) || {}).n || 0) + 1, p, len: c.length }); }
    const d = [...m.entries()].filter(([, v]) => v.n > 2);
    if (d.length) console.log(`PRE_FIX_DUPS ${fc.id.slice(0, 8)} ${JSON.stringify(d.map(([k, v]) => [k, v.n, v.p, v.len]))}`);
  }

  // Branch sweep inputs (owner, 2026-10-21: "full cleanup and sweep of all these crossmodel branches"):
  // the hourly branch janitor's own record, and whether each digby/* lane branch's chat is still live.
  const jan = await prisma.loopMetric.findMany({ where: { kind: 'branch_janitor' }, orderBy: { createdAt: 'desc' }, take: 6, select: { createdAt: true, value: true, meta: true } }).catch((e) => [{ err: e.message.slice(0, 100) }]);
  for (const j of jan) console.log(`JANITOR ${j.err || `${j.createdAt.toISOString().slice(5, 16)} v=${j.value} ${JSON.stringify(j.meta || {}).slice(0, 500)}`}`);
  const prefixes = String('').split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f]{8}$/.test(x));
  for (const pre of prefixes) {
    const chats = await prisma.crossModelChat.findMany({ where: { id: { startsWith: pre } }, select: { id: true, archivedAt: true, isSupervisor: true, isProjectSupervisor: true, updatedAt: true } }).catch((e) => [{ err: e.message.slice(0, 80) }]);
    for (const ch of chats) {
      if (ch.err) { console.log(`LANE ${pre} ERR ${ch.err}`); continue; }
      const last = await prisma.agentRun.findFirst({ where: { sessionId: ch.id }, orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true } }).catch(() => null);
      const live = await prisma.agentRun.count({ where: { sessionId: ch.id, status: { in: ['queued', 'running'] } } }).catch(() => -1);
      const sch = await prisma.codingSchedule.count({ where: { sessionId: ch.id, enabled: true } }).catch(() => -1);
      console.log(`LANE ${pre} archived=${ch.archivedAt ? ch.archivedAt.toISOString().slice(0, 10) : "no"} sup=${ch.isSupervisor || ch.isProjectSupervisor ? 1 : 0} updated=${ch.updatedAt.toISOString().slice(0, 16)} lastRun=${last ? `${last.status}@${last.createdAt.toISOString().slice(0, 16)}` : '-'} liveRuns=${live} enabledSchedules=${sch}`);
    }
    if (!chats.length) console.log(`LANE ${pre} NO_CHAT`);
  }
  // Owner-briefing error / warn rows since the deploy (templated, secrets scrubbed by the logger).
  const errs = await prisma.appErrorLog.findMany({ where: { createdAt: { gte: since }, source: { in: ['owner-briefing', 'fleet'] } }, select: { level: true, source: true, message: true } }).catch((e) => [{ level: 'probe', source: 'err', message: e.message.slice(0, 120) }]);
  const ec = {}; for (const e of errs) { const k = `${e.level}|${e.source}|${String(e.message).replace(/[0-9a-f]{8}(-[0-9a-f-]{27})?/g, '<id>').replace(/\d+/g, 'N').slice(0, 120)}`; ec[k] = (ec[k] || 0) + 1; }
  console.log(`BRIEFING_ERRLOGS ${errs.length}`); for (const [k, n] of Object.entries(ec).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${n} ${k}`);
  console.log('FSV_DONE');
  await prisma.$disconnect().catch(() => {});
})().catch((e) => { console.log(`PROBE_ERR ${e && e.message}`); process.exit(0); });
FSV_PROBE_EOF
    if out=$(timeout 420 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-fs-verify-1021.js 2>&1) && printf '%s' "$out" | grep -q '^FSV_DONE'; then
      echo "$out" | cut -c1-700 | head -n 600
      sudo touch "$MARKER_FSV1021"
    else
      echo "$out" | cut -c1-700 | tail -n 40; echo "  probe failed or incomplete — marker left unset"
    fi
    echo "== END FSV1021 =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): FSV1021B — READ-ONLY follow-up to FSV1021: the owner's Fleet Supervisor chat's 20:37
  # and 22:47 briefings both carried the decision-gate head line — changed content, or a dedupe miss? Prints each
  # briefing's head-line signature HASHES, the stored dedupe memory (hash + age), and the backend / worker
  # "owner-briefing: posted" log counters (headSuppressed). Hashes, ages and counters only. Never writes.
  MARKER_FSVB1021=/var/tmp/.digby-fsvb1021b-verify-probe
  if [ ! -f "$MARKER_FSVB1021" ]; then
    echo "== FSV1021B host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-fsv-b-1021.js >/dev/null <<'FSVB_PROBE_EOF'
// probe-fsv-b-1021.js — READ-ONLY: did the owner-briefing head dedupe hold back unchanged lines after deploy
// 0cccf69d0 (PR #1870)? Per supervisor chat since 19:56:20Z: each briefing's head-line SIGNATURE HASHES
// (rollout / audit, via the deployed briefingHeadSignature) and the stored dedupe memory (key → sig hash + age).
// Hashes and ages only — never message text. Never writes (one Redis GET per chat).
const crypto = require('crypto');
const H = (s) => crypto.createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 10);
(async () => {
  const prisma = require('/app/dist/config/database').default;
  const ob = require('/app/dist/modules/crossmodel/fleet/owner-briefing.service');
  const sig = typeof ob.briefingHeadSignature === 'function' ? ob.briefingHeadSignature : (l) => l;
  let redis = null;
  try { redis = require('/app/dist/config/redis').default; if (!redis.isOpen) await redis.connect(); } catch (e) { console.log(`REDIS_UNAVAILABLE ${String(e && e.message).slice(0, 80)}`); redis = null; }
  const since = new Date('2026-10-21T19:56:20Z');
  const chats = await prisma.crossModelChat.findMany({ where: { OR: [{ isSupervisor: true }, { isProjectSupervisor: true }] }, select: { id: true } });
  for (const c of chats) {
    const rows = await prisma.crossModelMessage.findMany({ where: { chatId: c.id, role: 'assistant', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, select: { content: true, metadata: true, createdAt: true } });
    const briefs = rows.filter((r) => r.metadata && r.metadata.kind === 'owner_briefing');
    if (!briefs.length) continue;
    console.log(`== chat ${c.id.slice(0, 8)} briefings=${briefs.length}`);
    for (const b of briefs) {
      const lines = String(b.content || '').split('\n');
      const rollout = lines.find((l) => l.startsWith('Decision gate ('));
      const audit = lines.find((l) => l.includes('Live-chat audit (last 24 h)'));
      console.log(`BRIEF ${b.createdAt.toISOString().slice(11, 16)} rollout=${rollout ? H(sig(rollout)) : '-'} audit=${audit ? H(sig(audit)) : '-'} len=${String(b.content || '').length}`);
    }
    if (redis) {
      try {
        const raw = await redis.get(`fleet:briefing:head:${c.id}`);
        if (raw == null) { console.log('MEMORY none'); continue; }
        const m = JSON.parse(String(raw));
        console.log(`MEMORY ${Object.entries(m).map(([k, v]) => `${k}=${H(v && v.sig)}@${v && v.at ? new Date(v.at).toISOString().slice(11, 16) : '-'}`).join(' ')}`);
      } catch (e) { console.log(`MEMORY_ERR ${String(e && e.message).slice(0, 80)}`); }
    }
  }
  // (the app's own exit handler quits the shared client — quitting here too crashed the probe at exit; an
  // open client keeps node alive, so exit explicitly — the 23:50Z run hung 20 min on exactly that)
  console.log('FSVB_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`PROBE_ERR ${e && e.message}`); process.exit(0); });
FSVB_PROBE_EOF
    # Output to a FILE, never $(...): a hung docker-exec child keeps a pipe open past `timeout` (23:50Z run, 20-min hang).
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-fsv-b-1021.js >/var/tmp/fsvb1021.out 2>&1 </dev/null || true
    out=$(cat /var/tmp/fsvb1021.out 2>/dev/null)
    if printf '%s' "$out" | grep -q '^FSVB_DONE'; then
      echo "$out" | cut -c1-400 | head -n 200
      sudo touch "$MARKER_FSVB1021"
    else
      echo "$out" | cut -c1-400 | tail -n 30; echo "  probe failed or incomplete — marker left unset"
    fi
    for c in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-(backend|worker)' ); do
      echo "LOGS $c posted=$(timeout 60 sudo docker logs "$c" --since 4h 2>&1 | grep -c 'owner-briefing: posted') suppressed=$(timeout 60 sudo docker logs "$c" --since 4h 2>&1 | grep 'owner-briefing: posted' | grep -o 'headSuppressed=[a-z,]*' | sort | uniq -c | tr '\n' ' ') nothingNewSkip=$(timeout 60 sudo docker logs "$c" --since 4h 2>&1 | grep -c 'no new head line')"
    done
    echo "== END FSV1021B =="
  fi
  # ── ONE-SHOT (2026-10-21, prod): PDV1021R2 — post-deploy check of release 2 (4c95f628e: tickets 4c7aebf7 + 9a976d83)
  # and the owner-visible lane title. READ: the deployed dist carries struck-note-repeat + computer-task-claims; the
  # four switches are at their defaults; struck_note_repeat / computer_task_claim rows since the backend started.
  # WRITE (only when the dist checks pass): (1) one forced title render of lane 5f90c628 through the deployed
  # refreshSessionTitle — the same write every plan / finalize render makes — so the Framework Operator lane stops
  # carrying the closed "5. Close the JWT pending-IP watch" now instead of at its next firing (owner 2026-10-21);
  # (2) 4c7aebf7's adminNote gains the release evidence; its status stays in_progress (part (c) — inline harness
  # counters — is not built, and the claim check stays observe-only until a week of rows is read).
  MARKER_PDVR2=/var/tmp/.digby-pdv1021r2
  if [ ! -f "$MARKER_PDVR2" ]; then
    echo "== PDV1021R2 host=$(hostname) now=$(date -u +%FT%TZ) =="
    echo "  deploy-sha: $(cat /opt/crossmodel/.deploy-sha 2>/dev/null || echo missing)"
    PDVR2_BK=$(sudo docker ps --format '{{.Names}}' | grep -E '^admin-backend-(blue|green)$' | head -1 || true)
    PDVR2_SINCE=$( [ -n "$PDVR2_BK" ] && sudo docker inspect -f '{{.State.StartedAt}}' "$PDVR2_BK" 2>/dev/null || echo '')
    echo "  backend: ${PDVR2_BK:-none} started ${PDVR2_SINCE:-?}"
    sudo tee /var/tmp/pdvr2.js >/dev/null <<'PDVR2_EOF'
const prisma = require('/app/dist/config/database').default;
const since = new Date(process.argv[2] || Date.now() - 3600e3);
const out = { since: since.toISOString(), checks: {}, live: {}, writes: [] };
const q = async (f) => { try { return await f(); } catch (e) { return { error: String(e && e.message || e).slice(0, 200) }; } };
(async () => {
  out.checks.repeat = await q(async () => { const m = require('/app/dist/modules/crossmodel/chat-agent/struck-note-repeat'); return { ok: typeof m.detectStruckNoteRepeat === 'function' && m.STRUCK_NOTE_REPEAT_METRIC === 'struck_note_repeat' }; });
  out.checks.claims = await q(async () => { const m = require('/app/dist/modules/crossmodel/chat-agent/computer-task-claims'); const v = m.checkComputerTaskClaims("Drove the owner's Mac via computer_task and clicked Save in the Tailscale admin console.", []); return { ok: typeof m.checkComputerTaskClaims === 'function' && v && v.unbacked === true, reason: v && v.reason }; });
  out.checks.switches = { STRUCK_NOTE_REPEAT_DISABLED: process.env.STRUCK_NOTE_REPEAT_DISABLED ?? '(unset)', PRIOR_NOTE_STRUCK_BLOCK_DISABLED: process.env.PRIOR_NOTE_STRUCK_BLOCK_DISABLED ?? '(unset)', COMPUTER_TASK_CLAIM_CHECK_DISABLED: process.env.COMPUTER_TASK_CLAIM_CHECK_DISABLED ?? '(unset)', COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED: process.env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED ?? '(unset)', HARNESS_TITLE_DONE_TODO_SKIP_DISABLED: process.env.HARNESS_TITLE_DONE_TODO_SKIP_DISABLED ?? '(unset)' };
  out.live.rows = await q(async () => { const r = await prisma.loopMetric.groupBy({ by: ['kind'], where: { kind: { in: ['struck_note_repeat', 'computer_task_claim'] }, createdAt: { gte: since } }, _count: true }); return r.map((x) => `${x.kind}=${x._count}`); });
  out.live.claimReasons = await q(async () => { const rows = await prisma.loopMetric.findMany({ where: { kind: 'computer_task_claim', createdAt: { gte: since } }, select: { meta: true }, take: 500 }); const g = {}; for (const r of rows) { const k = String((r.meta || {}).reason || '?'); g[k] = (g[k] || 0) + 1; } return g; });
  const allOk = out.checks.repeat && out.checks.repeat.ok === true && out.checks.claims && out.checks.claims.ok === true;
  out.allOk = allOk;
  if (allOk) {
    out.writes.push(await q(async () => {
      const lane = await prisma.crossModelChat.findFirst({ where: { id: { startsWith: '5f90c628' } }, select: { id: true, title: true } });
      if (!lane) return { lane: 'not_found' };
      const { refreshSessionTitle } = require('/app/dist/modules/crossmodel/platform/session-titles');
      const r = await refreshSessionTitle(lane.id, 'plan', { force: true });
      const after = await prisma.crossModelChat.findUnique({ where: { id: lane.id }, select: { title: true } });
      return { lane: '5f90c628', before: lane.title, after: after && after.title, changed: !!(r && r.changed) };
    }));
    out.writes.push(await q(async () => {
      const t = await prisma.userFeatureRequest.findFirst({ where: { id: { startsWith: '4c7aebf7' } }, select: { id: true, status: true, adminNote: true } });
      if (!t) return { id8: '4c7aebf7', result: 'not_found' };
      if (/RELEASE 2 LIVE/.test(String(t.adminNote || ''))) return { id8: '4c7aebf7', result: 'already_noted' };
      const note = `RELEASE 2 LIVE (${new Date().toISOString()}): commit 4c95f628e on main (deployed in the wave carrying bbf29a6b5). Parts (a) + (b) are live: a supervisor machine note that copies its own previous verifier-struck note gets at most ONE reject-back, ever (chat-agent/struck-note-repeat.ts; >= 90 % token-LCS + the same numbers / ids; no-op notes and replay-unsafe runs excluded), and the next machine turn carries a [PRIOR NOTE STRUCK] block. A related on-screen-input claim check (chat-agent/computer-task-claims.ts) records observe-only computer_task_claim rows; it annotates only under the opt-in COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1, to be armed after a week of rows is read. STILL OPEN: part (c) proper — computer_task action claims quoting the task result's harness counters inline — is not built. Live check: the deployed modules load and the incident sentence is judged unbacked with no computer_task call; rows since the backend started: ${JSON.stringify(out.live.rows)}.`;
      await prisma.userFeatureRequest.update({ where: { id: t.id }, data: { adminNote: `${note}\n\n[earlier] ${String(t.adminNote || '').slice(0, 2500)}` } });
      return { id8: '4c7aebf7', result: 'note_appended', status: t.status };
    }));
  }
  console.log('PDVR2 ' + JSON.stringify(out));
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log('PDVR2_ERROR ' + String(e && e.message || e).slice(0, 300)); process.exit(0); });
PDVR2_EOF
    PDVR2_OUT=$(timeout 300 bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/pdvr2.js "$PDVR2_SINCE" 2>&1)
    printf '%s\n' "$PDVR2_OUT" | grep -E '^PDVR2' | fold -w 3000
    if printf '%s' "$PDVR2_OUT" | grep -q '"allOk":true'; then sudo touch "$MARKER_PDVR2"; else echo "  release 2 not live here yet (or probe failed) — nothing written, marker left unset"; printf '%s\n' "$PDVR2_OUT" | tail -3 | cut -c1-300; fi
    echo "== END PDV1021R2 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): NAN1022 — READ-ONLY post-deploy check of PR #1878 (FSN1021 no-action note, live on
  # box A since ~03:44Z, deploy run 39716642374): the deployed dist carries the note / validation / wiring, noted supervisor
  # answers carry the line exactly once, never beside an action call, never as a chip, and the incident shape (honest line +
  # underway cue, no note) is counted. Timestamps, 8-char chat ids, tool NAMES, flags and counts only — never message text.
  MARKER_NAN1022=/var/tmp/.digby-nan1022-noaction-note-verify
  if [ ! -f "$MARKER_NAN1022" ]; then
    echo "== NAN1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-noaction-1022.js >/dev/null <<'NOACTION_PROBE_EOF'
// probe-noaction-1022.js — READ-ONLY post-deploy check of PR #1878 (FSN1021 no-action note).
// Prints NO message text: timestamps, 8-char chat ids, tool NAMES, fixed-line flags, counts.
// SINCE=<iso> (the deploy's finish). Never writes.
const fs = require('fs');
const NOTE = 'Harness check: no action tool ran in this answer, so nothing it describes as sent, changed or running in the background was started by it.';
const HONEST = /I have not (made that change|sent that message) yet/;
const BACKGROUND = /running in the background|underway|in flight/i;

(async () => {
  // 1. the deployed dist carries the note
  try {
    const leaf = fs.readFileSync('/app/dist/modules/crossmodel/chat-agent/no-action-note.js', 'utf8');
    const uc = fs.readFileSync('/app/dist/modules/crossmodel/chat-agent/unbacked-claim.js', 'utf8');
    console.log(`DIST_NOTE ${leaf.includes(NOTE) ? 1 : 0} DIST_VALIDATE ${uc.includes('stripAnswerMarkup') ? 1 : 0} DIST_ACTED_SINCE ${uc.includes('actedSinceTurn') ? 1 : 0}`);
    const svc = fs.readFileSync('/app/dist/modules/crossmodel/chat-agent/chat-agent.service.js', 'utf8');
    console.log(`DIST_SERVICE_WIRED ${svc.includes('turnToolCallParts') && svc.includes('rejudgeNoActionNote') ? 1 : 0}`);
    const red = fs.readFileSync('/app/dist/modules/crossmodel/guard-chrome-redact.js', 'utf8');
    console.log(`DIST_REDACT ${red.includes('no-action-note') ? 1 : 0}`);
  } catch (e) { console.log(`DIST_READ_FAILED ${e && e.code}`); }
  console.log(`SWITCH_SET ${process.env.SUPERVISOR_NO_ACTION_NOTE_DISABLED === '1' ? 1 : 0}`);

  const prisma = require('/app/dist/config/database').default;
  const since = new Date('2026-10-22T03:44:00Z'); // #1878 live on box A (deploy run 39716642374)
  console.log(`SINCE ${since.toISOString()}`);
  const sups = await prisma.crossModelChat.findMany({ where: { OR: [{ isSupervisor: true }, { isProjectSupervisor: true }] }, select: { id: true } });
  const ids = sups.map((c) => c.id);
  const rows = await prisma.crossModelMessage.findMany({
    where: { chatId: { in: ids }, role: 'assistant', createdAt: { gte: since } },
    select: { chatId: true, content: true, parts: true, createdAt: true, metadata: true },
  });
  let noted = 0, notedWithAction = 0, notedTwice = 0, bugClass = 0, bugClassActed = 0, honest = 0;
  const READ = /^(get|list|search|read|fetch|find|lookup|describe|scrape|query)_|^(finish_run|update_plan|load_tools|load_tool_group|list_tool_groups|resolve_id)$/;
  for (const r of rows) {
    const c = String(r.content || '');
    const calls = (Array.isArray(r.parts) ? r.parts : []).filter((p) => p && p.type === 'tool_call').map((p) => String(p.name || ''));
    const acted = calls.some((n) => !READ.test(n));
    if (HONEST.test(c)) honest++;
    if (c.includes(NOTE)) {
      noted++;
      if (c.split(NOTE).length > 2) notedTwice++;
      if (acted) notedWithAction++;
      console.log(`NOTED ${r.createdAt.toISOString().slice(5, 16)} chat=${r.chatId.slice(0, 8)} calls=${calls.join('+') || '-'} asChip=${JSON.stringify((r.metadata && r.metadata.followUps) || []).includes('Harness check') ? 1 : 0}`);
    } else if (HONEST.test(c) && BACKGROUND.test(c)) {
      bugClass++;
      if (acted) bugClassActed++;
      console.log(`HONEST_PLUS_CUE_NO_NOTE ${r.createdAt.toISOString().slice(5, 16)} chat=${r.chatId.slice(0, 8)} calls=${calls.join('+') || '-'}`);
    }
  }
  console.log(`TOTALS supervisorAssistantRows=${rows.length} honestLine=${honest} noted=${noted} notedWithActionCall=${notedWithAction} notedTwice=${notedTwice} honestPlusCueNoNote=${bugClass} (of which acted=${bugClassActed})`);
  const metrics = await prisma.loopMetric.findMany({ where: { kind: 'supervisor_unbacked_claim_retry', createdAt: { gte: since } }, select: { meta: true } });
  const m = metrics.map((x) => (x.meta && typeof x.meta === 'object') ? x.meta : {});
  console.log(`METRICS retryRows=${m.length} rewritten=${m.filter((x) => (x.rewritten || 0) > 0).length} noActionNote=${m.filter((x) => x.noActionNote).length}`);
  console.log('NOACTION_PROBE_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`PROBE_ERROR ${e && e.message ? e.message.slice(0, 160) : e}`); process.exit(0); });
NOACTION_PROBE_EOF
    # Output to a FILE, never $(...): a hung docker-exec child keeps a pipe open past `timeout`.
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-noaction-1022.js >/var/tmp/nan1022.out 2>&1 </dev/null || true
    out=$(cat /var/tmp/nan1022.out 2>/dev/null)
    if printf '%s' "$out" | grep -q '^NOACTION_PROBE_DONE'; then
      echo "$out" | cut -c1-300 | head -n 120
      sudo touch "$MARKER_NAN1022"
    else
      echo "$out" | cut -c1-300 | tail -n 30; echo "  probe failed or incomplete — marker left unset"
    fi
    echo "== END NAN1022 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): LLW1022 — READ-ONLY post-deploy check of PR #1887 (lane lifecycle, a74b2c025, deploy run
  # 39724339048): the displayParentChatId migration landed, new machine lanes carry a display parent, every archive since the
  # migration spared supervisors, ticket-lane drain archives, lane_retired pass rows and the branch janitor's passes (deletes,
  # archive tag, reasons). SINCE derives from the migration row. Counts, flags and 8-char ids only — never message text or titles.
  MARKER_LLW1022=/var/tmp/.digby-llw1022-lanelife-verify
  if [ ! -f "$MARKER_LLW1022" ]; then
    echo "== LLW1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-lanelife-1022.js >/dev/null <<'LANELIFE_PROBE_EOF'
// probe-lanelife-1022.js — READ-ONLY post-deploy check of the lane-lifecycle wave (PR #1887).
// Prints counts, flags, reason tallies, 8-char ids and branch-name COUNTS only — never message text,
// never chat titles. Never writes. SINCE is hardcoded at insert time (the deploy's box A start).
(async () => {
  const prisma = require('/app/dist/config/database').default;
  // SINCE = the migration's finish on box A (migrations run on A first, right before the new backend starts).
  const migAt = await prisma.$queryRawUnsafe(`SELECT finished_at FROM _prisma_migrations WHERE migration_name = '20261021120000_chat_display_parent' AND finished_at IS NOT NULL`).catch(() => []);
  const SINCE = migAt.length ? new Date(migAt[0].finished_at) : new Date('2026-10-22T04:47:00Z');
  console.log(`SINCE ${SINCE.toISOString()} source=${migAt.length ? 'migration' : 'fallback'}`);
  for (const k of ['DISPLAY_PARENT_NESTING_DISABLED', 'TICKET_LANE_ARCHIVE_GAPS_DISABLED', 'LANE_IDLE_RETIRE_DISABLED', 'ARCHIVE_CASCADE_DISABLED', 'SESSION_API_ARCHIVE_STAMP_DISABLED', 'REAPER_CANDIDATE_ROTATION_DISABLED', 'BRANCH_JANITOR_EXTENDED_RULES_DISABLED']) {
    if (process.env[k]) console.log(`SWITCH_SET ${k}=${process.env[k]}`);
  }
  // 1. the migration
  const col = await prisma.$queryRawUnsafe(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'crossmodel_chats' AND column_name = 'displayParentChatId'`);
  const mig = await prisma.$queryRawUnsafe(`SELECT (finished_at IS NOT NULL) AS done, (rolled_back_at IS NOT NULL) AS rolled_back FROM _prisma_migrations WHERE migration_name = '20261021120000_chat_display_parent'`);
  console.log(`MIGRATION column=${col.length ? 1 : 0} rows=${mig.length} ${mig.map((m) => `done=${m.done ? 1 : 0}/rb=${m.rolled_back ? 1 : 0}`).join(' ')}`);
  // 2. display-parent stamps
  if (col.length) {
    const r = await prisma.$queryRawUnsafe(`SELECT
        count(*) FILTER (WHERE "displayParentChatId" IS NOT NULL)::int AS stamped_all,
        count(*) FILTER (WHERE "createdAt" >= $1 AND "projectId" IS NOT NULL AND NOT "isSupervisor" AND NOT "isProjectSupervisor")::int AS new_project_chats,
        count(*) FILTER (WHERE "createdAt" >= $1 AND "displayParentChatId" IS NOT NULL)::int AS new_stamped
      FROM crossmodel_chats`, SINCE);
    console.log(`DISPLAY_PARENT ${JSON.stringify(r[0])}`);
  }
  // 3. archives since the deploy — safety: never a supervisor
  const arch = await prisma.crossModelChat.findMany({ where: { archivedAt: { gte: SINCE } }, select: { id: true, isSupervisor: true, isProjectSupervisor: true, projectId: true } });
  console.log(`ARCHIVED_SINCE total=${arch.length} supervisors=${arch.filter((c) => c.isSupervisor || c.isProjectSupervisor).length} withProject=${arch.filter((c) => c.projectId).length}`);
  if (arch.length) {
    const ids = arch.map((c) => c.id);
    const recentHuman = await prisma.crossModelMessage.groupBy({ by: ['chatId'], where: { chatId: { in: ids }, role: 'user', createdAt: { gte: new Date(Date.now() - 14 * 86400_000) } }, _count: { _all: true } }).catch(() => null);
    console.log(`ARCHIVED_WITH_HUMAN_MSG_14D ${recentHuman ? recentHuman.length : 'read_failed'}`);
  }
  // 3b. ticket lanes the drain archived (laneArchivedAt stamped since the deploy)
  const tl = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM user_feature_requests WHERE context->>'laneArchivedAt' IS NOT NULL AND (context->>'laneArchivedAt')::timestamptz >= $1`, SINCE).catch((e) => [{ n: `read_failed:${String(e && e.message).slice(0, 60)}` }]);
  console.log(`TICKET_LANES_ARCHIVED_SINCE ${tl[0].n}`);
  // 4. lane_retired telemetry
  const lr = await prisma.loopMetric.findMany({ where: { kind: 'lane_retired', createdAt: { gte: SINCE } }, select: { meta: true } });
  const phases = {}; const skipped = {}; let considered = 0, archived = 0;
  for (const x of lr) {
    const m = (x.meta && typeof x.meta === 'object') ? x.meta : {};
    phases[m.phase] = (phases[m.phase] || 0) + 1;
    if (m.phase === 'pass') {
      considered += Number(m.considered || 0); archived += Number(m.archived || 0);
      for (const [k, v] of Object.entries(m.skipped || {})) skipped[k] = (skipped[k] || 0) + Number(v || 0);
    }
  }
  console.log(`LANE_RETIRED rows=${lr.length} phases=${JSON.stringify(phases)} passConsidered=${considered} passArchived=${archived} skipped=${JSON.stringify(skipped)}`);
  // 5. branch janitor passes
  const bj = await prisma.loopMetric.findMany({ where: { kind: 'branch_janitor', createdAt: { gte: SINCE } }, orderBy: { createdAt: 'asc' }, select: { meta: true, createdAt: true, value: true } });
  for (const x of bj) {
    const m = (x.meta && typeof x.meta === 'object') ? x.meta : {};
    console.log(`BRANCH_JANITOR ${x.createdAt.toISOString().slice(11, 16)} ownRepo=${m.ownRepo ? 1 : 0} dryRun=${m.dryRun ? 1 : 0} scanned=${m.scanned ?? '-'} deleted=${m.deleted ?? x.value ?? '-'} kept=${m.kept ?? '-'} failed=${m.failed ?? '-'} alreadyGone=${m.alreadyGone ?? '-'} archiveTag=${m.archiveTag ? 1 : (m.archiveTag === null ? 'null' : '-')} archivedTips=${Array.isArray(m.archivedTips) ? m.archivedTips.length : '-'} archiveFailed=${m.archiveFailed ? 1 : 0} aborted=${m.aborted ? 1 : 0} reasons=${JSON.stringify(m.reasons || {})}`);
  }
  if (!bj.length) console.log('BRANCH_JANITOR none since deploy');
  console.log('LANELIFE_PROBE_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`PROBE_ERROR ${e && e.message ? e.message.slice(0, 200) : e}`); process.exit(0); });
LANELIFE_PROBE_EOF
    # Output to a FILE, never $(...): a hung docker-exec child keeps a pipe open past `timeout`.
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-lanelife-1022.js >/var/tmp/llw1022.out 2>&1 </dev/null || true
    out=$(cat /var/tmp/llw1022.out 2>/dev/null)
    if printf '%s' "$out" | grep -q '^LANELIFE_PROBE_DONE'; then
      echo "$out" | cut -c1-400 | head -n 120
      sudo touch "$MARKER_LLW1022"
    else
      echo "$out" | cut -c1-300 | tail -n 30; echo "  probe failed or incomplete — marker left unset"
    fi
    echo "== END LLW1022 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): LLW1022B — READ-ONLY second check of #1887 (lane lifecycle) + #1890 (reviewed
  # deletes, 2f1912f0a live 06:50Z): new project chats since the migration with their parent / display-parent / folder-PS /
  # ticket-lane flags (a ticket lane in a PS folder must carry the display parent), archives (supervisors 0), lane-retire
  # passes, and the own-repo janitor passes since 06:50Z (reviewedManifest / reviewedEntries). Counts, flags, 8-char ids only.
  MARKER_LLW1022B=/var/tmp/.digby-llw1022b-lanelife-verify
  if [ ! -f "$MARKER_LLW1022B" ]; then
    echo "== LLW1022B host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-lanelife-b-1022.js >/dev/null <<'LANELIFE_B_PROBE_EOF'
// probe-lanelife-b-1022.js — READ-ONLY second post-deploy check of PR #1887 (lane lifecycle) + #1890 (reviewed deletes).
// Counts, flags, 8-char ids only — never message text or titles. Never writes.
(async () => {
  const prisma = require('/app/dist/config/database').default;
  const mig = await prisma.$queryRawUnsafe(`SELECT finished_at FROM _prisma_migrations WHERE migration_name = '20261021120000_chat_display_parent' AND finished_at IS NOT NULL`).catch(() => []);
  const SINCE = mig.length ? new Date(mig[0].finished_at) : new Date('2026-10-22T04:59:35Z');
  console.log(`SINCE ${SINCE.toISOString()} now=${new Date().toISOString()}`);
  // 1. new project chats since the migration: parent / display parent / does the folder have a Project Supervisor / is it a ticket lane
  const chats = await prisma.crossModelChat.findMany({
    where: { createdAt: { gte: SINCE }, projectId: { not: null }, isSupervisor: false, isProjectSupervisor: false },
    select: { id: true, projectId: true, userId: true, parentChatId: true, displayParentChatId: true, archivedAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' }, take: 200,
  });
  const lanes = await prisma.$queryRawUnsafe(`SELECT context->>'dispatchedTo' AS lane FROM user_feature_requests WHERE context->>'dispatchedTo' IS NOT NULL AND "updatedAt" >= $1`, SINCE).catch(() => []);
  const ticketLane = new Set(lanes.map((r) => r.lane));
  let flatTicketLanes = 0;
  for (const c of chats) {
    const ps = await prisma.crossModelChat.findFirst({ where: { projectId: c.projectId, userId: c.userId, isProjectSupervisor: true, archivedAt: null }, select: { id: true } });
    const dpOk = c.displayParentChatId ? (ps && c.displayParentChatId === ps.id ? 'ps' : 'other') : '-';
    const isTicket = ticketLane.has(c.id);
    if (isTicket && ps && !c.displayParentChatId && !c.parentChatId) flatTicketLanes++;
    console.log(`NEWCHAT ${c.createdAt.toISOString().slice(11, 16)} ${c.id.slice(0, 8)} parent=${c.parentChatId ? 1 : 0} display=${dpOk} folderHasPS=${ps ? 1 : 0} ticketLane=${isTicket ? 1 : 0} archived=${c.archivedAt ? 1 : 0}`);
  }
  console.log(`NEWCHATS total=${chats.length} stamped=${chats.filter((c) => c.displayParentChatId).length} flatTicketLanes=${flatTicketLanes}`);
  // 2. archives since the migration — supervisors must be 0
  const arch = await prisma.crossModelChat.findMany({ where: { archivedAt: { gte: SINCE } }, select: { id: true, isSupervisor: true, isProjectSupervisor: true } });
  console.log(`ARCHIVED_SINCE total=${arch.length} supervisors=${arch.filter((c) => c.isSupervisor || c.isProjectSupervisor).length}`);
  const tl = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM user_feature_requests WHERE context->>'laneArchivedAt' IS NOT NULL AND (context->>'laneArchivedAt')::timestamptz >= $1`, SINCE).catch(() => [{ n: 'read_failed' }]);
  console.log(`TICKET_LANES_ARCHIVED_SINCE ${tl[0].n}`);
  // 3. lane_retired rows (the 6-hourly session-topology-outcomes job runs the retire scan)
  const lr = await prisma.loopMetric.findMany({ where: { kind: 'lane_retired', createdAt: { gte: SINCE } }, select: { meta: true, createdAt: true } });
  for (const x of lr.filter((r) => r.meta && r.meta.phase === 'pass')) console.log(`LANE_RETIRE_PASS ${x.createdAt.toISOString().slice(11, 16)} considered=${x.meta.considered} archived=${x.meta.archived} cascaded=${x.meta.cascaded} skipped=${JSON.stringify(x.meta.skipped || {})}`);
  console.log(`LANE_RETIRED rows=${lr.length} archivedPhase=${lr.filter((r) => r.meta && r.meta.phase === 'archived').length}`);
  // 4. own-repo janitor passes since the reviewed-deletes deploy
  const bj = await prisma.loopMetric.findMany({ where: { kind: 'branch_janitor', createdAt: { gte: new Date('2026-10-22T06:50:00Z') } }, orderBy: { createdAt: 'asc' }, select: { meta: true, createdAt: true } });
  for (const x of bj.filter((r) => r.meta && r.meta.ownRepo)) console.log(`BRANCH_JANITOR_OWN ${x.createdAt.toISOString().slice(11, 16)} deleted=${x.meta.deleted} archiveTag=${x.meta.archiveTag ? 1 : 0} reviewedManifest=${x.meta.reviewedManifest ?? '-'} reviewedEntries=${x.meta.reviewedEntries ?? '-'} reasons=${JSON.stringify(x.meta.reasons || {})}`);
  console.log(`BRANCH_JANITOR passes=${bj.length} userRepoDeletes=${bj.filter((r) => r.meta && !r.meta.ownRepo).reduce((n, r) => n + Number(r.meta.deleted || 0), 0)}`);
  // 5. the 6-hourly job's own cron row, when it last ran
  const cron = await prisma.$queryRawUnsafe(`SELECT to_char("lastRunAt",'HH24:MI') AS last FROM cron_jobs WHERE id = 'session-topology-outcomes'`).catch(() => null);
  console.log(`TOPOLOGY_JOB_LAST ${cron && cron.length ? cron[0].last : 'unknown'}`);
  console.log('LANELIFE_B_PROBE_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`PROBE_ERROR ${e && e.message ? e.message.slice(0, 200) : e}`); process.exit(0); });
LANELIFE_B_PROBE_EOF
    # Output to a FILE, never $(...): a hung docker-exec child keeps a pipe open past `timeout`.
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-lanelife-b-1022.js >/var/tmp/llw1022b.out 2>&1 </dev/null || true
    out=$(cat /var/tmp/llw1022b.out 2>/dev/null)
    if printf '%s' "$out" | grep -q '^LANELIFE_B_PROBE_DONE'; then
      echo "$out" | cut -c1-400 | head -n 260
      sudo touch "$MARKER_LLW1022B"
    else
      echo "$out" | cut -c1-300 | tail -n 30; echo "  probe failed or incomplete — marker left unset"
    fi
    echo "== END LLW1022B =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): DPB1022 — DRY RUN of scripts/framework-audit/backfill-display-parent.js (no --apply:
  # it only reads and prints ONE JSON report — counts, proof tallies, 8-char ids; never titles or message text). Shows which
  # EXISTING machine-spawned lanes would nest under their folder's Project Supervisor before the owner decides on --apply.
  MARKER_DPB1022=/var/tmp/.digby-dpb1022-display-parent-dryrun
  if [ ! -f "$MARKER_DPB1022" ]; then
    echo "== DPB1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    # Output to a FILE, never $(...): a hung docker-exec child keeps a pipe open past `timeout`.
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-display-parent.js >/var/tmp/dpb1022.out 2>&1 </dev/null || true
    out=$(cat /var/tmp/dpb1022.out 2>/dev/null)
    if printf '%s' "$out" | grep -q '"dryRun": true'; then
      echo "$out" | cut -c1-400 | head -n 200
      sudo touch "$MARKER_DPB1022"
    else
      echo "$out" | cut -c1-300 | tail -n 30; echo "  dry run failed or incomplete — marker left unset"
    fi
    echo "== END DPB1022 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): DPA1022 — APPLY the display-parent backfill. OWNER-APPROVED ("apply", 2026-10-22,
  # after the DPB1022 dry run: 10 candidates, 1 proven — e083ff2e via p4_first_message, folder d355f5d9, supervisor f5c2c1f4;
  # 9 unproven stay flat). One write per proven lane: displayParentChatId (sidebar-only; updatedAt untouched) + a context-store
  # marker for --revert. Then the dry run again (expect proven 0 / wouldUpdate 0). Counts and 8-char ids only.
  # Undo: prodq.sh backfill-display-parent.js --revert --apply.
  MARKER_DPA1022=/var/tmp/.digby-dpa1022-display-parent-apply
  if [ ! -f "$MARKER_DPA1022" ]; then
    echo "== DPA1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    # Output to a FILE, never $(...): a hung docker-exec child keeps a pipe open past `timeout`.
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-display-parent.js --apply --run dpa1022-owner-approved >/var/tmp/dpa1022.out 2>&1 </dev/null || true
    out=$(cat /var/tmp/dpa1022.out 2>/dev/null)
    echo "$out" | cut -c1-400 | head -n 200
    if printf '%s' "$out" | grep -q '"apply": true' && printf '%s' "$out" | grep -q '"updated"'; then
      # The marker is set once the apply ran at all, so a re-run of the workflow never applies twice
      # (the script is idempotent anyway: it only stamps rows whose displayParentChatId is still NULL).
      sudo touch "$MARKER_DPA1022"
      echo "-- post-apply dry run --"
      timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-display-parent.js >/var/tmp/dpa1022-verify.out 2>&1 </dev/null || true
      grep -E '"(candidates|proven|unproven|wouldUpdate)"' /var/tmp/dpa1022-verify.out | cut -c1-200
    else
      echo "  apply did not complete — marker left unset"
    fi
    echo "== END DPA1022 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): FSR1022 — READ-ONLY review of the owner's Fleet Supervisor chat (owner: "go through todays
  # fleet supervisor messages back and forth with the user me...and see if previous bugs fixed things or if any other issues
  # remain from this weeks updates"). No message text: per-turn metadata + fixed harness-line flags, a Mon–Thu trend, today's
  # guard / error telemetry, and per-exchange STRUCTURED verdicts from the platform's utility model run in-container (enums +
  # a generic ≤20-word note scrubbed of ids / numbers / secrets / urls). Only FSR_* lines are printed.
  MARKER_FSR1022=/var/tmp/.digby-fsr1022-fleet-review
  if [ ! -f "$MARKER_FSR1022" ]; then
    echo "== FSR1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-fs-review-1022.js >/dev/null <<'FSR_EOF'
// probe-fs-review-1022.js — READ-ONLY review of the owner's Fleet Supervisor chat (owner, 2026-10-22: "go through todays
// fleet supervisor messages back and forth with the user me...and see if previous bugs fixed things or if any other issues
// remain from this weeks updates").
//
// Prints NO message text. Deterministic per-turn metadata (lengths, hashes, tool names, fixed harness-line flags), a Mon–Thu
// trend, today's guard / error telemetry, and — for each owner exchange today — a STRUCTURED verdict from the platform's own
// utility model run inside this container (enums + one generic ≤20-word note, scrubbed of ids / numbers / secrets / urls).
// Every printed line starts with a whitelisted prefix; the playbook greps for them. Never writes.
'use strict';
const crypto = require('crypto');

const H = (s) => crypto.createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 8);
const DAY0 = new Date('2026-10-22T00:00:00Z');
const TREND_FROM = new Date('2026-10-19T00:00:00Z');

const FLAGS = [
  ['NO_ACTION_NOTE', (c) => c.includes('Harness check: no action tool ran in this answer')],
  ['HONEST_LINE', (c) => /I have not (made that change|sent that message) yet|I did not re-read anything in this answer/.test(c)],
  ['SAYS_BACKGROUND', (c) => /running in the background|underway|in flight/i.test(c)],
  ['HARNESS_NOOP', (c) => c.includes('WAKE: no-op (harness:')],
  ['HARNESS_ACTIONS', (c) => c.includes('ACTIONS TAKEN (harness):')],
  ['HARNESS_RECORD', (c) => c.includes('Harness record:')],
  ['NOT_EXECUTED', (c) => c.includes('Not executed (harness):')],
  ['VERIFIER_NOTE', (c) => c.includes('[ACTION VERIFIER')],
  ['EVIDENCE_GUARD', (c) => c.includes('[HARNESS EVIDENCE GUARD')],
  ['HARNESS_NOTICE', (c) => c.includes('[HARNESS NOTICE') || c.includes('[HARNESS CHECK')],
  ['MACHINE_HEADER_LEAK', (c) => c.includes('[MACHINE-TRIGGERED RUN') || c.includes('[AGENT-SENT MESSAGE')],
  ['MESSAGE_FROM_NOTE', (c) => /^Message from /m.test(c)],
  ['ERROR_NOTE', (c) => /^(Sorry — I couldn't get an answer|Sorry — this conversation has grown too large|The model kept rejecting the request|I wasn't able to generate a response)/.test(c.trim())],
  ['EMPTY', (c) => !c.trim() || c.trim() === '[no content]'],
  ['NOTHING_NEW', (c) => c.includes('Nothing new on any project since the last update.')],
  ['ROLLOUT_HEAD', (c) => c.includes('set off by the registry lifecycle this week')],
  ['STOPPED', (c) => /^\(Stopped\.\)/.test(c.trim())],
];
const flagsOf = (c) => FLAGS.filter(([, f]) => f(String(c || ''))).map(([k]) => k);
const closeShape = (c) => {
  const first = String(c || '').split('\n').find((l) => l.trim()) || '';
  const m = first.match(/^\s*(?:\*\*)?(WAKE|SWEEP)\s*:\s*(no-op|reported|acted|[a-z-]+)/i);
  return m ? `${m[1].toUpperCase()}:${m[2].toLowerCase()}` : 'freeform';
};
const words = (c) => new Set(String(c || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i); };

function loadRedactor() {
  try {
    const { redactInboundSecrets } = require('/app/dist/modules/crossmodel/platform/secret-scan');
    return (s) => { const r = redactInboundSecrets(String(s ?? '')); return typeof r === 'string' ? r : (r && typeof r.text === 'string' ? r.text : String(s ?? '')); };
  } catch { return (s) => String(s ?? ''); }
}
// Judge output → safe to print: no ids, hashes, numbers, emails, urls, long tokens, quotes.
const sanitize = (s, n = 160) => String(s ?? '')
  .replace(/https?:\/\/\S+/g, '<url>').replace(/\S+@\S+/g, '<email>')
  .replace(/[A-Za-z0-9_\-]{20,}/g, '<tok>').replace(/\b[0-9a-f]{7,}\b/gi, '<id>').replace(/\d+/g, 'N')
  .replace(/["'`“”‘’]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const ENUM = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

async function judgeExchange(chat, ex) {
  const sys = 'You audit one exchange between a product OWNER and their AI "Fleet Supervisor" (an agent that manages software projects and coding lanes). '
    + 'Reply with ONE JSON object only, no prose. Keys: '
    + '"answered" ("yes"|"partly"|"no" — did the reply address what the owner asked or told it), '
    + '"claims_unbacked" (true if the reply says something was sent / changed / dispatched / scheduled / fixed but the TOOL CALLS list shows nothing that could have done it), '
    + '"owner_problem" (true if the owner message reports a problem, complains, or repeats an earlier request), '
    + '"problem_kind" ("none"|"bug_or_regression"|"noise_or_repetition"|"wrong_or_stale_info"|"ignored_instruction"|"action_not_done"|"slow_or_no_reply"|"confusing_output"|"other"), '
    + '"resolved" ("yes"|"no"|"unclear" — after the reply, and judging also by the owner FOLLOW-UP if given, was the owner\'s point handled), '
    + '"note" (at most 20 words, generic: describe the issue or the outcome WITHOUT names, ids, numbers, credentials, urls or quotes).';
  const user = `OWNER MESSAGE:\n${ex.owner}\n\nSUPERVISOR REPLY:\n${ex.reply || '(no reply)'}\n\nTOOL CALLS IN THE REPLY: ${ex.calls.join(', ') || 'none'}\n\nOWNER FOLLOW-UP (next owner message, if any):\n${ex.next || '(none)'}`;
  const raw = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 400, temperature: 0, timeout: 60000, retryNotFound: true });
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return { err: 'no_json' };
  let j; try { j = JSON.parse(m[0]); } catch { return { err: 'bad_json' }; }
  return {
    answered: ENUM(j.answered, ['yes', 'partly', 'no'], '?'),
    claims_unbacked: j.claims_unbacked === true,
    owner_problem: j.owner_problem === true,
    kind: ENUM(j.problem_kind, ['none', 'bug_or_regression', 'noise_or_repetition', 'wrong_or_stale_info', 'ignored_instruction', 'action_not_done', 'slow_or_no_reply', 'confusing_output', 'other'], 'other'),
    resolved: ENUM(j.resolved, ['yes', 'no', 'unclear'], 'unclear'),
    note: sanitize(j.note),
  };
}

async function judgeDay(chat, ownerMsgs) {
  const sys = 'You read every message a product OWNER sent today to their AI "Fleet Supervisor", in order, each followed by a one-line machine summary of how the supervisor replied. '
    + 'List the DISTINCT issues, complaints or requests the owner raised (at most 12). Reply with ONE JSON object only: {"issues":[{"issue": "<at most 20 words, generic, no names / ids / numbers / credentials / urls / quotes>", '
    + '"kind": "bug_or_regression"|"noise_or_repetition"|"wrong_or_stale_info"|"ignored_instruction"|"action_not_done"|"slow_or_no_reply"|"confusing_output"|"request"|"other", '
    + '"times_raised": <integer>, "status": "resolved"|"unresolved"|"unclear"}]}';
  const user = ownerMsgs.map((m, i) => `#${i + 1} OWNER: ${m.text}\n#${i + 1} REPLY SUMMARY: ${m.summary}`).join('\n\n');
  const raw = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 1500, temperature: 0, timeout: 90000, retryNotFound: true });
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return { err: 'no_json' };
  try {
    const j = JSON.parse(m[0]);
    return { issues: (Array.isArray(j.issues) ? j.issues : []).slice(0, 12).map((x) => ({
      issue: sanitize(x && x.issue), kind: ENUM(x && x.kind, ['bug_or_regression', 'noise_or_repetition', 'wrong_or_stale_info', 'ignored_instruction', 'action_not_done', 'slow_or_no_reply', 'confusing_output', 'request', 'other'], 'other'),
      times: Number.isFinite(Number(x && x.times_raised)) ? Math.min(99, Math.max(1, Math.round(Number(x.times_raised)))) : 1,
      status: ENUM(x && x.status, ['resolved', 'unresolved', 'unclear'], 'unclear'),
    })) };
  } catch { return { err: 'bad_json' }; }
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { err: String(e && e.message || e).slice(0, 60).replace(/[0-9a-f]{8,}/g, '<id>') }; } }
  }));
  return out;
}

async function run({ prisma, chat, redact, log, ownerEmail, now = new Date() }) {
  const owner = await prisma.user.findFirst({ where: { email: ownerEmail }, select: { id: true } });
  if (!owner) { log('FSR_ERR owner_not_found'); return; }
  const fleet = await prisma.crossModelChat.findFirst({ where: { userId: owner.id, isSupervisor: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!fleet) { log('FSR_ERR no_fleet_chat'); return; }
  log(`FSR_CHAT ${fleet.id.slice(0, 8)} now=${now.toISOString()}`);
  const rows = await prisma.crossModelMessage.findMany({
    where: { chatId: fleet.id, createdAt: { gte: TREND_FROM } }, orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true },
  });
  const classify = (r) => {
    const md = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}; const c = String(r.content || '');
    if (r.role !== 'user') return 'assistant';
    if (md.origin === 'agent' || c.startsWith('[AGENT-SENT MESSAGE')) return 'agent';
    if (c.startsWith('[MACHINE-TRIGGERED RUN') || ['hook', 'schedule', 'continuation', 'system', 'attention-watchdog', 'machine', 'webhook'].includes(md.origin)) return 'wake';
    return 'owner';
  };
  const callsOf = (a) => (Array.isArray(a.parts) ? a.parts : []).filter((p) => p && p.type === 'tool_call').map((p) => String(p.name || '?'));
  // ── Mon–Thu trend ──
  const days = {};
  let prevBriefHead = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const d = r.createdAt.toISOString().slice(5, 10); const k = classify(r);
    const t = (days[d] ||= { owner: 0, agent: 0, wake: 0, assistant: 0, briefing: 0, briefSameHead: 0, dup: 0, flags: {}, shapes: {} });
    t[k]++;
    if (k === 'assistant') {
      const md = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}; const c = String(r.content || '');
      for (const f of flagsOf(c)) t.flags[f] = (t.flags[f] || 0) + 1;
      const sh = md.kind === 'owner_briefing' ? 'BRIEFING' : closeShape(c); t.shapes[sh] = (t.shapes[sh] || 0) + 1;
      if (md.kind === 'owner_briefing') { t.briefing++; const head = H(c.split('\n').slice(0, 4).join('\n')); if (head === prevBriefHead) t.briefSameHead++; prevBriefHead = head; }
    }
  }
  const seen = new Map();
  for (const r of rows) if (r.role === 'assistant') { const h = H(r.content); const d = r.createdAt.toISOString().slice(5, 10); if (seen.has(h)) days[d].dup++; seen.set(h, d); }
  for (const [d, t] of Object.entries(days)) log(`FSR_DAY ${d} owner=${t.owner} agent=${t.agent} wake=${t.wake} assistant=${t.assistant} briefing=${t.briefing} briefSameHead=${t.briefSameHead} dupAssistant=${t.dup} shapes=${JSON.stringify(t.shapes)} flags=${JSON.stringify(t.flags)}`);

  // ── today's owner exchanges ──
  const today = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.createdAt >= DAY0);
  const ownerIdx = today.filter(({ r }) => classify(r) === 'owner').map(({ i }) => i);
  const prevOwnerReplies = [];
  const exchanges = [];
  for (const i of ownerIdx) {
    const r = rows[i];
    const ans = []; for (let j = i + 1; j < rows.length && rows[j].role === 'assistant'; j++) ans.push(rows[j]);
    // the reply may be preceded by machine rows if the owner's turn queued behind a wake: take the first assistant row after it.
    if (!ans.length) for (let j = i + 1; j < rows.length; j++) { if (classify(rows[j]) === 'owner') break; if (rows[j].role === 'assistant') { ans.push(rows[j]); break; } }
    const replyText = ans.map((a) => String(a.content || '')).join('\n\n');
    const calls = ans.flatMap(callsOf);
    const flags = [...new Set(ans.flatMap((a) => flagsOf(a.content)))];
    const lat = ans[0] ? Math.round((ans[0].createdAt - r.createdAt) / 1000) : null;
    const w = words(replyText);
    const simPrev = prevOwnerReplies.reduce((m, p) => Math.max(m, jaccard(w, p)), 0);
    prevOwnerReplies.push(w);
    const nextOwner = ownerIdx.find((k) => k > i);
    const md = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
    log(`FSR_TURN ${r.createdAt.toISOString().slice(11, 16)} via=${md.channel || md.source || md.origin || 'web'} ownerLen=${String(r.content || '').length} replies=${ans.length} latency_s=${lat} replyLen=${replyText.length} calls=${[...new Set(calls)].join('+') || '-'} ncalls=${calls.length} flags=${flags.join(',') || '-'} kinds=${ans.map((a) => (a.metadata && a.metadata.kind) || '-').join('/')} model=${ans.map((a) => (a.metadata && (a.metadata.model || a.metadata.modelUsed)) || '-').join('/')} simToEarlierReply=${simPrev.toFixed(2)}`);
    exchanges.push({ owner: redact(String(r.content || '')).slice(0, 3000), reply: redact(replyText).slice(0, 4000), calls, next: nextOwner !== undefined ? redact(String(rows[nextOwner].content || '')).slice(0, 1500) : '' });
  }
  log(`FSR_TODAY owner=${ownerIdx.length} rowsToday=${today.length}`);

  // ── per-exchange verdicts (in-box model; enums + generic note only) ──
  const verdicts = chat ? await pool(exchanges, 5, (ex) => judgeExchange(chat, ex)) : [];
  verdicts.forEach((v, k) => {
    const t = rows[ownerIdx[k]].createdAt.toISOString().slice(11, 16);
    if (!v || v.err) log(`FSR_JUDGE ${t} err=${v && v.err}`);
    else log(`FSR_JUDGE ${t} answered=${v.answered} claimsUnbacked=${v.claims_unbacked} ownerProblem=${v.owner_problem} kind=${v.kind} resolved=${v.resolved} note=${v.note}`);
  });
  if (chat && exchanges.length) {
    const day = await judgeDay(chat, exchanges.map((ex, k) => ({ text: ex.owner.slice(0, 900), summary: verdicts[k] && !verdicts[k].err ? `${verdicts[k].answered}; ${verdicts[k].note}` : 'unknown' }))).catch((e) => ({ err: String(e && e.message || e).slice(0, 60) }));
    if (day.err) log(`FSR_ISSUE err=${day.err}`);
    else for (const x of day.issues) log(`FSR_ISSUE kind=${x.kind} times=${x.times} status=${x.status} issue=${x.issue}`);
  }

  // ── today's telemetry on this chat ──
  const lm = await prisma.loopMetric.findMany({ where: { sessionId: fleet.id, createdAt: { gte: DAY0 } }, select: { kind: true, meta: true } }).catch(() => []);
  const kinds = {}; const seams = {};
  for (const x of lm) {
    kinds[x.kind] = (kinds[x.kind] || 0) + 1;
    if (x.kind === 'guard_strike' || x.kind === 'guard_miss') { const m = x.meta || {}; const k = `${x.kind}:${m.seam || '-'}:${m.outcome || m.state || '-'}`; seams[k] = (seams[k] || 0) + 1; }
  }
  log(`FSR_METRICS ${JSON.stringify(Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 30)))}`);
  log(`FSR_GUARDS ${JSON.stringify(seams)}`);
  const spend = lm.filter((x) => x.kind === 'run_spend');
  log(`FSR_SPEND_ROWS ${spend.length}`);
  const errs = await prisma.appErrorLog.findMany({ where: { createdAt: { gte: DAY0 }, message: { contains: fleet.id.slice(0, 8) } }, select: { level: true, source: true, message: true } }).catch(() => []);
  const ec = {}; for (const e of errs) { const k = `${e.level}|${e.source || '-'}|${sanitize(redact(e.message), 110)}`; ec[k] = (ec[k] || 0) + 1; }
  log(`FSR_ERRLOGS ${errs.length}`);
  for (const [k, n] of Object.entries(ec).sort((a, b) => b[1] - a[1]).slice(0, 15)) log(`FSR_ERR ${n} ${k}`);
  const qs = await prisma.ownerQuestion.findMany({ where: { userId: owner.id, status: { in: ['open', 'pending', 'asked'] } }, select: { createdAt: true, expectedAnswerType: true, optionalAsk: true } }).catch(() => null);
  if (qs) log(`FSR_OPEN_QUESTIONS ${qs.length} ages_h=${qs.map((q) => Math.round((now - new Date(q.createdAt)) / 3600000)).sort((a, b) => b - a).slice(0, 25).join(',')}`);
  const pc = await prisma.pendingConfirmation.findMany({ where: { userId: owner.id, status: 'pending' }, select: { createdAt: true, tool: true } }).catch(() => null);
  if (pc) { const byTool = {}; for (const p of pc) byTool[p.tool || "-"] = (byTool[p.tool || "-"] || 0) + 1; log(`FSR_PENDING_CARDS ${pc.length} ${JSON.stringify(byTool)}`); }
}

module.exports = { run, sanitize, flagsOf, closeShape, jaccard, words };

if (require.main === module) {
  (async () => {
    const prisma = require('/app/dist/config/database').default;
    let chat = null;
    try { chat = require('/app/dist/utils/utility-llm').utilityChat; } catch (e) { console.log(`FSR_NOTE judge_unavailable ${String(e && e.message || e).slice(0, 60)}`); }
    await run({ prisma, chat, redact: loadRedactor(), log: (s) => console.log(s), ownerEmail: 'example-user@example.com' });
    console.log('FSR_DONE');
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  })().catch((e) => { console.log(`FSR_ERR ${String(e && e.message || e).slice(0, 200).replace(/[0-9a-f]{8,}/g, '<id>')}`); console.log('FSR_DONE'); process.exit(0); });
}
FSR_EOF
    # Output to a FILE, never $(...): a hung docker-exec child keeps a pipe open past `timeout`.
    timeout -k 10 900 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-fs-review-1022.js >/var/tmp/fsr1022.out 2>&1 </dev/null || true
    grep -E '^FSR_' /var/tmp/fsr1022.out | cut -c1-500 | head -n 400
    if grep -q '^FSR_DONE' /var/tmp/fsr1022.out; then sudo touch "$MARKER_FSR1022"; else echo "  probe failed or incomplete — marker left unset"; fi
    echo "== END FSR1022 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): FLT1022 — READ-ONLY facts on the 9 lanes the display-parent backfill left flat (owner: "yes
  # just get everything working again properly"): folder / supervisor ids, age, idle, runs (live, last), enabled schedules,
  # human-message recency, first-message origin, parent kind, ticket / delegation links, live children. No titles or text.
  MARKER_FLT1022=/var/tmp/.digby-flt1022-flat-lanes
  if [ ! -f "$MARKER_FLT1022" ]; then
    echo "== FLT1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-flat-lanes-1022.js >/dev/null <<'FLT_EOF'
// probe-flat-lanes-1022.js — READ-ONLY facts on the 9 lanes the display-parent backfill left flat (unproven machine spawn).
// Owner (2026-10-22): "yes just get everything working again properly". Prints no titles or message text: per lane the
// folder / supervisor ids (8-char), age, idle, archived, live runs, last run status, enabled schedules, message counts,
// last human message age, first user message origin, parent kind, ticket link and the lane-retire house-rule facts.
'use strict';
const IDS = ['d0710c77', '5f90c628', 'ec29c9f6', '6b29db29', 'be0cf43d', 'a9ef85f3', '373fe0a2', '8c4647fd', 'e9aa6744'];
(async () => {
  const prisma = require('/app/dist/config/database').default;
  const now = Date.now();
  const h = (d) => (d ? Math.round((now - new Date(d).getTime()) / 3600000) : null);
  for (const p of IDS) {
    const chats = await prisma.crossModelChat.findMany({ where: { id: { startsWith: p } }, select: { id: true, userId: true, projectId: true, parentChatId: true, displayParentChatId: true, archivedAt: true, createdAt: true, updatedAt: true, isSupervisor: true, isProjectSupervisor: true } });
    if (chats.length !== 1) { console.log(`FLAT ${p} matches=${chats.length}`); continue; }
    const c = chats[0];
    const ps = c.projectId ? await prisma.crossModelChat.findFirst({ where: { projectId: c.projectId, userId: c.userId, isProjectSupervisor: true, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }) : null;
    const parent = c.parentChatId ? await prisma.crossModelChat.findUnique({ where: { id: c.parentChatId }, select: { isSupervisor: true, isProjectSupervisor: true, archivedAt: true } }) : null;
    const runs = await prisma.agentRun.findMany({ where: { sessionId: c.id }, orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true, finishedAt: true } });
    const live = runs.filter((r) => ['queued', 'running', 'interrupted'].includes(r.status)).length;
    const sch = await prisma.codingSchedule.findMany({ where: { sessionId: c.id, enabled: true }, select: { promptSetBy: true } }).catch(() => []);
    const first = await prisma.crossModelMessage.findFirst({ where: { chatId: c.id, role: 'user' }, orderBy: { createdAt: 'asc' }, select: { metadata: true } });
    const userRows = await prisma.crossModelMessage.findMany({ where: { chatId: c.id, role: 'user' }, select: { metadata: true, content: true, createdAt: true } });
    const human = userRows.filter((r) => { const md = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}; const t = String(r.content || ''); return !(md.origin && md.origin !== 'user') && !t.startsWith('[MACHINE-TRIGGERED') && !t.startsWith('[AGENT-SENT'); });
    const lastHuman = human.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), new Date(0));
    const asst = await prisma.crossModelMessage.count({ where: { chatId: c.id, role: 'assistant' } });
    const tickets = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM user_feature_requests WHERE context->>'dispatchedTo' = $1 OR (context->'previousLanes') @> to_jsonb($1::text)`, c.id).catch(() => [{ n: '?' }]);
    const deleg = await prisma.delegationTask.findMany({ where: { childChatId: c.id }, select: { kind: true, origin: true } }).catch(() => []);
    const children = await prisma.crossModelChat.count({ where: { parentChatId: c.id, archivedAt: null } });
    const fmd = first && first.metadata && typeof first.metadata === 'object' ? first.metadata : {};
    console.log(`FLAT ${p} folder=${c.projectId ? c.projectId.slice(0, 8) : '-'} ps=${ps ? ps.id.slice(0, 8) : '-'} ageH=${h(c.createdAt)} idleH=${h(c.updatedAt)} archived=${c.archivedAt ? 1 : 0} parent=${parent ? (parent.isSupervisor ? 'fleet' : parent.isProjectSupervisor ? 'ps' : 'chat') : '-'} display=${c.displayParentChatId ? 1 : 0} runs=${runs.length} live=${live} lastRun=${runs[0] ? `${runs[0].status}:${h(runs[0].finishedAt || runs[0].createdAt)}h` : '-'} schedEnabled=${sch.length}${sch.length ? `(${[...new Set(sch.map((s) => s.promptSetBy))].join('+')})` : ''} userMsgs=${userRows.length} humanMsgs=${human.length} lastHumanH=${human.length ? h(lastHuman) : '-'} asstMsgs=${asst} firstOrigin=${fmd.origin || '-'}/${fmd.channel || fmd.source || '-'} tickets=${tickets[0].n} deleg=${deleg.map((d) => `${d.kind}:${d.origin}`).join('+') || '-'} liveChildren=${children}`);
  }
  console.log('FLAT_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`FLAT_ERR ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); console.log('FLAT_DONE'); process.exit(0); });
FLT_EOF
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-flat-lanes-1022.js >/var/tmp/flt1022.out 2>&1 </dev/null || true
    grep -E '^FLAT' /var/tmp/flt1022.out | cut -c1-500 | head -n 40
    if grep -q '^FLAT_DONE' /var/tmp/flt1022.out; then sudo touch "$MARKER_FLT1022"; else echo "  probe failed or incomplete — marker left unset"; fi
    echo "== END FLT1022 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): LCL1022 — OWNER-APPROVED lane cleanup ("yes just get everything working again properly",
  # after the FLT1022 facts). Archives the 6 idle flat lanes (d0710c77 ec29c9f6 6b29db29 be0cf43d a9ef85f3 373fe0a2 — 8–26 days
  # idle, no live run / schedule / child) through platform.service archiveChat as an owner action (audit row, hooks paused,
  # sidebar event; undo = unarchive from the Archived view), and nests the 3 active / recent ones (5f90c628 8c4647fd e9aa6744)
  # under their folder's Project Supervisor with the backfill's marker (backfill-display-parent.js --revert undoes it). Every
  # condition is re-checked at run time; a changed lane is skipped. 8-char ids and outcomes only.
  MARKER_LCL1022=/var/tmp/.digby-lcl1022-lane-cleanup
  if [ ! -f "$MARKER_LCL1022" ]; then
    echo "== LCL1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/lanes-cleanup-1022.js >/dev/null <<'LCL_EOF'
// lanes-cleanup-1022.js — OWNER-APPROVED one-shot (2026-10-22, owner: "yes just get everything working again properly",
// after the FLT1022 facts). Archives the 6 idle flat lanes through platform.service archiveChat (the owner's own archive path:
// audit row, hooks paused, sidebar event; restore = unarchive from the Archived view) and nests the 3 active / recent ones
// under their folder's Project Supervisor (displayParentChatId, the backfill's marker so `backfill-display-parent.js --revert`
// undoes it). Every condition is RE-CHECKED here; a lane that changed since the facts read is skipped, never forced.
// Prints 8-char ids and outcomes only.
'use strict';
const ARCHIVE = ['d0710c77', 'ec29c9f6', '6b29db29', 'be0cf43d', 'a9ef85f3', '373fe0a2'];
const NEST = ['5f90c628', '8c4647fd', 'e9aa6744'];
const MIN_IDLE_MS = 7 * 24 * 3600 * 1000;
(async () => {
  const prisma = require('/app/dist/config/database').default;
  const { archiveChat } = require('/app/dist/modules/crossmodel/platform/platform.service');
  const now = Date.now();
  const one = async (p) => {
    const rows = await prisma.crossModelChat.findMany({ where: { id: { startsWith: p } }, select: { id: true, userId: true, projectId: true, archivedAt: true, updatedAt: true, isSupervisor: true, isProjectSupervisor: true, displayParentChatId: true } });
    return rows.length === 1 ? rows[0] : null;
  };
  for (const p of ARCHIVE) {
    const c = await one(p);
    if (!c) { console.log(`LCL_ARCHIVE ${p} skipped=not_unique`); continue; }
    if (c.archivedAt) { console.log(`LCL_ARCHIVE ${p} skipped=already_archived`); continue; }
    if (c.isSupervisor || c.isProjectSupervisor) { console.log(`LCL_ARCHIVE ${p} skipped=supervisor`); continue; }
    const live = await prisma.agentRun.count({ where: { sessionId: c.id, status: { in: ['queued', 'running', 'interrupted'] } } });
    const sched = await prisma.codingSchedule.count({ where: { sessionId: c.id, enabled: true } });
    const kids = await prisma.crossModelChat.count({ where: { parentChatId: c.id, archivedAt: null } });
    const idle = now - new Date(c.updatedAt).getTime();
    if (live || sched || kids || idle < MIN_IDLE_MS) { console.log(`LCL_ARCHIVE ${p} skipped=changed live=${live} sched=${sched} kids=${kids} idleH=${Math.round(idle / 3600000)}`); continue; }
    try {
      const r = await archiveChat({ userId: c.userId, chatId: c.id, archived: true, ownerAction: true, source: 'owner_approved_cleanup_1022' });
      console.log(`LCL_ARCHIVE ${p} archived=${r && r.archived ? 1 : 0}`);
    } catch (e) { console.log(`LCL_ARCHIVE ${p} error=${String(e && e.message || e).slice(0, 100).replace(/[0-9a-f]{8,}/g, '<id>')}`); }
  }
  for (const p of NEST) {
    const c = await one(p);
    if (!c) { console.log(`LCL_NEST ${p} skipped=not_unique`); continue; }
    if (c.archivedAt) { console.log(`LCL_NEST ${p} skipped=archived`); continue; }
    if (c.displayParentChatId) { console.log(`LCL_NEST ${p} skipped=already_nested`); continue; }
    const ps = c.projectId ? await prisma.crossModelChat.findFirst({ where: { projectId: c.projectId, userId: c.userId, isProjectSupervisor: true, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }) : null;
    if (!ps || ps.id === c.id) { console.log(`LCL_NEST ${p} skipped=no_supervisor`); continue; }
    const ns = `${c.id}:display-parent-backfill`;
    const value = { previous: null, ps: ps.id, proof: 'owner_approved', run: 'lcl1022-owner-approved', at: new Date().toISOString() };
    try {
      const [, count] = await prisma.$transaction([
        prisma.contextStoreEntry.upsert({ where: { namespacePath_key: { namespacePath: ns, key: 'previous' } }, create: { namespacePath: ns, key: 'previous', value }, update: { value, updatedAt: new Date() } }),
        prisma.$executeRaw`UPDATE "crossmodel_chats" SET "displayParentChatId" = ${ps.id} WHERE "id" = ${c.id} AND "displayParentChatId" IS NULL`,
      ]);
      if (Number(count) !== 1) await prisma.contextStoreEntry.deleteMany({ where: { namespacePath: ns, key: 'previous' } });
      console.log(`LCL_NEST ${p} nested=${Number(count) === 1 ? 1 : 0} under=${ps.id.slice(0, 8)}`);
    } catch (e) { console.log(`LCL_NEST ${p} error=${String(e && e.message || e).slice(0, 100).replace(/[0-9a-f]{8,}/g, '<id>')}`); }
  }
  console.log('LCL_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`LCL_ERR ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); console.log('LCL_DONE'); process.exit(0); });
LCL_EOF
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/lanes-cleanup-1022.js >/var/tmp/lcl1022.out 2>&1 </dev/null || true
    grep -E '^LCL_' /var/tmp/lcl1022.out | cut -c1-300 | head -n 40
    # The marker is set once the cleanup ran at all (it is idempotent anyway: archived / nested lanes are skipped).
    if grep -q '^LCL_DONE' /var/tmp/lcl1022.out; then sudo touch "$MARKER_LCL1022"; else echo "  cleanup did not complete — marker left unset"; fi
    echo "== END LCL1022 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): PGD1022 — READ-ONLY: why does sync-db-secret's live-auth psql container get "Connection refused"
  # from RDS while the app connects fine? pg_isready (no credentials) from a default-bridge container vs a --network host one.
  # Prints the RDS host name and the two results only — never DATABASE_URL (it carries the password).
  MARKER_PGD1022=/var/tmp/.digby-pgd1022-pg-diag
  if [ ! -f "$MARKER_PGD1022" ]; then
    echo "== PGD1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    PGD_HOST=$(sudo sed -n 's#^DATABASE_URL=postgres[a-z]*://[^@]*@\([^:/?]*\).*#\1#p' /opt/crossmodel-local/env-overrides.env 2>/dev/null | head -1)
    [ -z "$PGD_HOST" ] && PGD_HOST=$(sudo sed -n 's#^DATABASE_URL=postgres[a-z]*://[^@]*@\([^:/?]*\).*#\1#p' /opt/crossmodel/.env 2>/dev/null | head -1)
    # Only a host-name shape is ever printed or used (a raw '@' in a password would otherwise leak a fragment).
    if ! printf '%s' "$PGD_HOST" | grep -qE '^([a-z0-9-]+\.)+rds\.amazonaws\.com$|^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then PGD_HOST=''; echo "rds_host=unparsed"; fi
    echo "rds_host=${PGD_HOST:-unknown} resolves=$(getent hosts "${PGD_HOST:-x}" 2>/dev/null | awk '{print $1}' | head -1)"
    if [ -n "$PGD_HOST" ]; then
      echo "bridge: $(timeout 40 sudo docker run --rm postgres:16-alpine pg_isready -h "$PGD_HOST" -p 5432 -t 10 2>&1 | tail -1) rc=$?"
      echo "host:   $(timeout 40 sudo docker run --rm --network host postgres:16-alpine pg_isready -h "$PGD_HOST" -p 5432 -t 10 2>&1 | tail -1) rc=$?"
      echo "box:    $(timeout 15 bash -c "exec 3<>/dev/tcp/$PGD_HOST/5432" 2>&1 && echo tcp_open || echo tcp_failed)"
      echo "docker_user_chain: $(sudo iptables -S DOCKER-USER 2>/dev/null | grep -c -- '-j') rules; reject_or_drop=$(sudo iptables -S DOCKER-USER 2>/dev/null | grep -cE 'REJECT|DROP')"
      sudo iptables -S DOCKER-USER 2>/dev/null | grep -E 'REJECT|DROP' | cut -c1-160 | head -8
    fi
    sudo touch "$MARKER_PGD1022"
    echo "== END PGD1022 =="
  fi
  # ── ONE-SHOT (2026-10-22, prod): CTX1022 — READ-ONLY: what context and memory the owner's Fleet Supervisor runs with (owner:
  # "it still feels the fleet supervisor doesnt fully have the context and memory of everything"). History size, today's
  # context budget / fill / compaction / tool-list trims / tool groups / tokens-in / models, memory evictions touching the FS
  # chat / owner / their projects (today + 7 days), current memory rows by scope + source, the FS store ledger shapes.
  # Scrubbed metadata only — no message text. Only CTX_* lines are printed.
  MARKER_CTX1022=/var/tmp/.digby-ctx1022-fs-context
  if [ ! -f "$MARKER_CTX1022" ]; then
    echo "== CTX1022 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-fs-context-1022.js >/dev/null <<'CTX_EOF'
// probe-fs-context-1022.js — READ-ONLY: what context and memory does the owner's Fleet Supervisor actually run with?
// (owner, 2026-10-22: "it still feels the fleet supervisor doesnt fully have the context and memory of everything").
// Prints no message text: per-kind telemetry for the FS chat today (context budget / fill / compaction / tool-list trims /
// tool groups / tokens in) with meta values scrubbed, memory evictions touching the FS chat / owner / their projects today and
// the last 7 days, current digby_memory row counts by scope + source, history size of the FS chat, the model per run.
'use strict';
const DAY0 = new Date('2026-10-22T00:00:00Z');
const WEEK0 = new Date('2026-10-15T00:00:00Z');
const scrub = (v) => {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 6 ? `[${v.length} items]` : v.map(scrub);
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 25)) o[k] = scrub(x); return o; }
  return String(v).replace(/https?:\/\/\S+/g, '<url>').replace(/\S+@\S+/g, '<email>').replace(/[A-Za-z0-9_\-]{28,}/g, '<tok>')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, (m) => `<${m.slice(0, 8)}>`).slice(0, 48);
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
(async () => {
  const prisma = require('/app/dist/config/database').default;
  const owner = await prisma.user.findFirst({ where: { email: 'example-user@example.com' }, select: { id: true } });
  const fs = owner && await prisma.crossModelChat.findFirst({ where: { userId: owner.id, isSupervisor: true }, orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true } });
  if (!fs) { console.log('CTX_ERR no_fleet_chat'); console.log('CTX_DONE'); process.exit(0); }
  console.log(`CTX_CHAT ${fs.id.slice(0, 8)} owner=${owner.id.slice(0, 8)} created=${fs.createdAt.toISOString().slice(0, 10)}`);
  // history size of the FS chat
  const total = await prisma.crossModelMessage.count({ where: { chatId: fs.id } });
  const today = await prisma.crossModelMessage.count({ where: { chatId: fs.id, createdAt: { gte: DAY0 } } });
  const week = await prisma.crossModelMessage.count({ where: { chatId: fs.id, createdAt: { gte: WEEK0 } } });
  const chars = await prisma.$queryRawUnsafe(`SELECT coalesce(sum(length(content)),0)::bigint AS c FROM crossmodel_messages WHERE "chatId" = $1 AND "createdAt" >= $2`, fs.id, DAY0).catch(() => [{ c: -1 }]);
  console.log(`CTX_HISTORY rowsTotal=${total} rowsWeek=${week} rowsToday=${today} charsToday=${Number(chars[0].c)}`);
  // per-kind telemetry on the FS chat today
  const lm = await prisma.loopMetric.findMany({ where: { sessionId: fs.id, createdAt: { gte: DAY0 } }, orderBy: { createdAt: 'asc' }, select: { kind: true, value: true, unit: true, meta: true, runId: true, createdAt: true } });
  const pick = ['context_budget', 'run_context_fill', 'context_edit', 'context_compaction', 'tool_list_trimmed', 'tool_groups', 'reasoning_replay', 'run_read_cache', 'memory_search_timing', 'context_overflow', 'seat_fallback', 'model_fallback'];
  for (const k of pick) {
    const rows = lm.filter((x) => x.kind === k);
    if (!rows.length) { console.log(`CTX_KIND ${k} n=0`); continue; }
    const vals = rows.map((r) => Number(r.value)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : null);
    console.log(`CTX_KIND ${k} n=${rows.length} unit=${rows[0].unit || '-'} p50=${q(0.5)} p90=${q(0.9)} max=${vals.length ? vals[vals.length - 1] : null}`);
    // distinct meta shapes (scrubbed), at most 6 examples
    const seen = new Set();
    for (const r of rows) { const s = JSON.stringify(scrub(r.meta || {})); if (seen.has(s)) continue; seen.add(s); if (seen.size > 6) break; console.log(`CTX_META ${k} ${s.slice(0, 400)}`); }
  }
  // tokens in / out per run today
  const tin = lm.filter((x) => x.kind === 'run_tokens_in').map((x) => Number(x.value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (tin.length) console.log(`CTX_TOKENS_IN runs=${tin.length} p50=${tin[Math.floor(tin.length / 2)]} p90=${tin[Math.floor(tin.length * 0.9)]} max=${tin[tin.length - 1]}`);
  const models = {}; for (const x of lm.filter((y) => y.kind === 'run_spend')) { const m = (x.meta && x.meta.model) || '-'; models[m] = (models[m] || 0) + 1; }
  console.log(`CTX_MODELS ${JSON.stringify(models)}`);
  const kinds = {}; for (const x of lm) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  console.log(`CTX_ALL_KINDS ${JSON.stringify(kinds).slice(0, 1800)}`);
  // memory evictions: FS session scope, owner user scope, the owner's projects — today and 7 days
  const projects = await prisma.crossModelProject.findMany({ where: { userId: owner.id }, select: { id: true } }).catch(() => []);
  const scopeIds = new Set([fs.id, owner.id, ...projects.map((p) => p.id)]);
  const ev = await prisma.loopMetric.findMany({ where: { kind: 'memory_scope_evicted', createdAt: { gte: WEEK0 } }, select: { value: true, meta: true, createdAt: true } });
  const evAgg = {};
  for (const e of ev) {
    const m = e.meta || {}; if (!scopeIds.has(m.scopeId)) continue;
    const who = m.scopeId === fs.id ? 'fs_session' : m.scopeId === owner.id ? 'owner_user' : 'owner_project';
    const k = `${e.createdAt >= DAY0 ? 'today' : 'week'}|${who}|${m.scopeType || '-'}|${m.source || '-'}|cap=${m.cap ?? '-'}|${m.reason || '-'}`;
    evAgg[k] = evAgg[k] || { events: 0, rows: 0 }; evAgg[k].events++; evAgg[k].rows += Number(e.value) || 0;
  }
  for (const [k, v] of Object.entries(evAgg).sort()) console.log(`CTX_EVICT ${k} events=${v.events} rows=${v.rows}`);
  // current memory rows by scope + source
  const mem = await prisma.$queryRawUnsafe(`SELECT scope_type, CASE WHEN scope_id = $1 THEN 'fs_session' WHEN scope_id = $2 THEN 'owner_user' ELSE 'owner_project' END AS who, coalesce(source,'-') AS source, count(*)::int AS n, max(created_at) AS newest, min(created_at) AS oldest FROM digby_memory WHERE scope_id = ANY($3::text[]) GROUP BY 1,2,3 ORDER BY 2,1,4 DESC`, fs.id, owner.id, [...scopeIds]).catch((e) => [{ err: String(e && e.message || e).slice(0, 120) }]);
  for (const r of mem.slice(0, 40)) console.log(r.err ? `CTX_MEM_ERR ${r.err}` : `CTX_MEM ${r.who} ${r.scope_type} source=${r.source} rows=${r.n} newest=${r.newest ? new Date(r.newest).toISOString().slice(0, 16) : '-'} oldest=${r.oldest ? new Date(r.oldest).toISOString().slice(0, 10) : '-'}`);
  const arch = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM digby_memory_archive WHERE scope_id = ANY($1::text[])`, [...scopeIds]).catch(() => null);
  if (arch) console.log(`CTX_MEM_ARCHIVED rows=${arch[0].n}`);
  // supervisor state ledger size (directives / asks / notes) — counts only
  const st = await prisma.contextStoreEntry.findMany({ where: { namespacePath: { startsWith: fs.id } }, select: { namespacePath: true, key: true, value: true } }).catch(() => []);
  for (const s of st.slice(0, 20)) {
    const v = s.value; const size = JSON.stringify(v || '').length;
    const shape = v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}:${Array.isArray(x) ? x.length : typeof x}`).slice(0, 12).join(',') : typeof v;
    console.log(`CTX_STORE ${s.namespacePath.replace(fs.id, '<fs>')}/${s.key} bytes=${size} shape=${shape}`);
  }
  console.log('CTX_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`CTX_ERR ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); console.log('CTX_DONE'); process.exit(0); });
CTX_EOF
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-fs-context-1022.js >/var/tmp/ctx1022.out 2>&1 </dev/null || true
    grep -E '^CTX_' /var/tmp/ctx1022.out | cut -c1-600 | head -n 300
    if grep -q '^CTX_DONE' /var/tmp/ctx1022.out; then sudo touch "$MARKER_CTX1022"; else echo "  probe failed or incomplete — marker left unset"; fi
    echo "== END CTX1022 =="
  fi
  # ── ONE-SHOT (2026-10-23, prod): VFY1023 — READ-ONLY post-deploy check of PR #1905 (Fleet Supervisor context + memory)
  # against the owner's real Fleet Supervisor chat: runs the NEW owner-turn history / [OWNER THREAD] / ledger-diff /
  # state-stamp / thread-state / code-index-freshness paths from /app/dist on live rows and prints counts, sizes, ages and
  # secret-pattern hit counts only — never message text. Plus telemetry + app_error_logs prefixes since the wave started.
  # Only VFY_* lines are printed.
  MARKER_VFY1023=/var/tmp/.digby-vfy1023-pr1905
  if [ ! -f "$MARKER_VFY1023" ]; then
    echo "== VFY1023 host=$(hostname) now=$(date -u +%FT%TZ) =="
    for port in 4001 4002; do echo "VFY_HEALTH port=$port code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$port/health 2>/dev/null)"; done
    sudo tee /var/tmp/probe-verify-1023.js >/dev/null <<'VFY_EOF'
// probe-verify-1023.js — READ-ONLY post-deploy check of PR #1905 (Fleet Supervisor context + memory) against the owner's
// real Fleet Supervisor chat. Runs the NEW code paths from /app/dist on live rows and prints only counts, sizes, ages and
// pattern-hit counts — never message text. Nothing here writes: the loaders, selector, renderers, ledger diff, state read,
// code-index meta read and store reads are all read paths (the ledger diff caches in-process only; the high-water mark is
// re-read at the end to prove it did not move).
'use strict';
const DEPLOY0 = new Date('2026-10-23T04:46:00Z');
const ROOT = '/app/dist/modules/crossmodel';
const fs = require('fs');
const mask = (v) => String(v ?? '').replace(/https?:\/\/\S+/g, '<url>').replace(/\S+@\S+/g, '<email>')
  .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, (m) => `<${m.slice(0, 8)}>`).replace(/[A-Za-z0-9_\-]{24,}/g, '<tok>');
const age = (d) => (d ? `${Math.round((Date.now() - new Date(d).getTime()) / 60000)}m` : '-');
(async () => {
  const prisma = require('/app/dist/config/database').default;
  for (const m of ['platform/owner-turn-history.js', 'platform/owner-turn-history.loader.js', 'chat-agent/unread-state-note.js', 'coding/code-search.js']) {
    console.log(`VFY_DIST ${m} present=${fs.existsSync(`${ROOT}/${m}`) ? 1 : 0}`);
  }
  console.log(`VFY_ENV sha=${mask(process.env.GIT_SHA || process.env.BUILD_SHA || process.env.DEPLOY_SHA || process.env.APP_VERSION || '-').slice(0, 12)}`);
  const H = require(`${ROOT}/platform/owner-turn-history`);
  const L = require(`${ROOT}/platform/owner-turn-history.loader`);
  const W = require(`${ROOT}/platform/supervisor-wake-ledger`);
  const R = require(`${ROOT}/platform/wake-material-rule`);
  const S = require(`${ROOT}/platform/secret-scan`);
  const ST = require(`${ROOT}/platform/supervisor-state.service`);
  const CS = require(`${ROOT}/memory/context-store`);
  const CI = require(`${ROOT}/coding/code-index.service`);
  const CQ = require(`${ROOT}/coding/code-search`);
  const hits = (t) => { try { return S.scanTextForSecrets(String(t || '')).length; } catch { return -1; } };

  const owner = await prisma.user.findFirst({ where: { email: 'example-user@example.com' }, select: { id: true } });
  const fsChat = owner && await prisma.crossModelChat.findFirst({ where: { userId: owner.id, isSupervisor: true, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!fsChat) { console.log('VFY_ERR no_fleet_chat'); console.log('VFY_DONE'); process.exit(0); }
  const id = fsChat.id;
  const now = new Date();
  console.log(`VFY_CHAT ${id.slice(0, 8)} v2Disabled=${H.ownerHistoryV2Disabled() ? 1 : 0} diffDisabled=${H.ownerLedgerDiffDisabled() ? 1 : 0}`);

  // 1. owner-turn history + [OWNER THREAD] (H)
  try {
    const t0 = Date.now();
    const rows = await L.loadOwnerTurnRows(id, { now, timeoutMs: 15000 });
    console.log(`VFY_LOAD ms=${Date.now() - t0} ok=${rows ? 1 : 0} historyRows=${rows ? rows.history.length : 0} threadRows=${rows ? rows.thread.length : 0}`);
    if (rows) {
      const sel = H.selectOwnerTurnHistory(rows.history);
      const st = sel.stats || {};
      const msgs = sel.history || [];
      const text = msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join('\n');
      const stubs = (text.match(/earlier machine wake — its baked prompt/g) || []).length;
      console.log(`VFY_HISTORY ${JSON.stringify(st)} messages=${msgs.length} chars=${text.length} stubs=${stubs} secretHits=${hits(text)}`);
      const legacy = rows.history.slice(-8).reduce((n, r) => n + String(r.content || '').length, 0);
      console.log(`VFY_LEGACY_SLICE chars=${legacy} ownerRowsIn8=${rows.history.slice(-8).filter((r) => H.isOwnerTypedRow(r)).length}`);
      const entries = H.ownerThreadEntriesFromRows(rows.thread, now);
      const block = H.renderOwnerThreadBlock(entries, now, { inHistoryIds: sel.ownerRowIds || [] });
      const oldest = entries.length ? entries[0].at : null;
      console.log(`VFY_THREAD entries=${entries.length} oldestAge=${age(oldest)} blockChars=${block.length} secretHits=${hits(block)}`);
    }
  } catch (e) { console.log(`VFY_SECTION_ERR 1 ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }

  // 2. [SINCE YOUR LAST NOTE] ledger diff (H) — the high-water mark must not move
  try {
    const hwm0 = await W.readWakeHighWaterMark(id, now);
    const d = await W.computeWakeLedgerDiff(id, hwm0.at, now);
    const diffBlock = d ? R.renderWakeLedgerDiff(d, { ownerTurn: true }) : '';
    const hwm1 = await W.readWakeHighWaterMark(id, new Date());
    console.log(`VFY_DIFF hwmSource=${hwm0.source} hwmAge=${age(hwm0.at)} counts=${d ? JSON.stringify(W.diffCounts(d)) : 'null'} blockChars=${diffBlock.length} ownerHeading=${/SINCE YOUR LAST NOTE/.test(diffBlock) ? 1 : 0} secretHits=${hits(diffBlock)} hwmUnchanged=${hwm0.at.getTime() === hwm1.at.getTime() ? 1 : 0}`);
  } catch (e) { console.log(`VFY_SECTION_ERR 2 ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }

  // 3. state doc + PROJECT STATUS stamps + ledger archive (H/M)
  try {
    const doc = await ST.getSupervisorState(id);
    const plain = ST.formatStateForWake(doc, now);
    const stamped = ST.formatStateForWake(doc, now, { projectStatusAges: true });
    const stamps = (stamped.match(/snapshot, not live/g) || []).length;
    const coldNs = `${id}:supervisor-archive`;
    const cold = await prisma.contextStoreEntry.count({ where: { namespacePath: coldNs } }).catch(() => -1);
    console.log(`VFY_STATE directives=${(doc.directives || []).length} archived=${(doc.archived || []).length} coldRows=${cold} asks=${(doc.directives || []).filter((x) => x.kind === 'ask').length} blockChars=${plain.length}/${stamped.length} stamps=${stamps}`);
  } catch (e) { console.log(`VFY_SECTION_ERR 3 ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }

  // 4. thread summary (M)
  try {
    const th = await CS.storeGet([id, 'thread'], 'state').catch(() => null);
    console.log(`VFY_THREADSTATE messageCount=${th ? th.messageCount : '-'} lastUpdatedAge=${age(th && th.lastUpdated)} summaryChars=${th && th.threadSummary ? String(th.threadSummary).length : 0}`);
  } catch (e) { console.log(`VFY_SECTION_ERR 4 ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }

  // 5. code index for the platform repo (C)
  try {
    const projects = await prisma.crossModelProject.findMany({ where: { userId: owner.id }, select: { id: true, repoUrl: true } }).catch(() => []);
    let shown = 0;
    for (const p of projects) {
      const url = String(p.repoUrl || '');
      const st = await CI.readCodeIndexState(p.id).catch(() => null);
      if (!st || (!/crossmodel/i.test(url) && shown >= 3)) continue;
      shown++;
      const codeRows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM digby_memory WHERE scope_id = $1 AND source = 'code'`, p.id).catch(() => [{ n: -1 }]);
      const line = CQ.renderCodeIndexFreshness(st, Date.now());
      console.log(`VFY_CODEINDEX project=${p.id.slice(0, 8)} platform=${/example-org\/crossmodel/i.test(url) ? 1 : 0} files=${st.fileCount ?? (st.files ? Object.keys(st.files).length : '-')} sha=${String(st.indexedSha || '-').slice(0, 9)} branch=${mask(st.branch || '-').slice(0, 30)} listed=${st.listed ?? '-'} partial=${st.partial ? 1 : 0} syncAge=${age(st.lastSyncAt)} capHeld=${Array.isArray(st.capHeld) ? st.capHeld.length : (st.capHeld ?? '-')} codeRows=${codeRows[0].n} freshness="${mask(line).slice(0, 160)}"`);
      if (shown >= 6) break;
    }
  } catch (e) { console.log(`VFY_SECTION_ERR 5 ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }

  // 6. telemetry since the deploy wave started + errors
  try {
    const kinds = ['supervisor_owner_turn_context', 'supervisor_owner_ledger_diff', 'supervisor_unread_state_retry', 'supervisor_wake_ledger_diff', 'supervisor_harness_receipts', 'index_swept', 'code_index_sync', 'memory_scope_evicted', 'thread_state_bookkeeping'];
    const rowsM = await prisma.loopMetric.groupBy({ by: ['kind'], where: { createdAt: { gte: DEPLOY0 }, kind: { in: kinds } }, _count: { _all: true } }).catch(() => []);
    console.log(`VFY_METRICS ${JSON.stringify(Object.fromEntries(rowsM.map((r) => [r.kind, r._count._all])))}`);
    const ft = await prisma.loopMetric.count({ where: { createdAt: { gte: DEPLOY0 }, kind: 'supervisor_harness_receipts', meta: { path: ['followThrough'], equals: true } } }).catch(() => -1);
    console.log(`VFY_FOLLOWTHROUGH rows=${ft}`);
    const errs = await prisma.$queryRawUnsafe(`SELECT left(regexp_replace(message, '[0-9a-f]{8,}', '<id>', 'g'), 80) AS m, count(*)::int AS n FROM app_error_logs WHERE "createdAt" >= $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, DEPLOY0).catch((e) => [{ m: `query_failed ${String(e && e.message || e).slice(0, 60)}`, n: 0 }]);
    for (const e of errs) console.log(`VFY_ERRLOG n=${e.n} ${mask(e.m)}`);
  } catch (e) { console.log(`VFY_SECTION_ERR 6 ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }

  console.log('VFY_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`VFY_ERR ${String(e && e.message || e).slice(0, 200).replace(/[0-9a-f]{8,}/g, '<id>')}`); console.log('VFY_DONE'); process.exit(0); });
VFY_EOF
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-verify-1023.js >/var/tmp/vfy1023.out 2>&1 </dev/null || true
    grep -E '^VFY_' /var/tmp/vfy1023.out | cut -c1-700 | head -n 200
    if grep -q '^VFY_DONE' /var/tmp/vfy1023.out; then sudo touch "$MARKER_VFY1023"; else echo "  probe failed or incomplete — marker left unset"; tail -5 /var/tmp/vfy1023.out | cut -c1-200; fi
    echo "== END VFY1023 =="
  fi
  # ── ONE-SHOT (2026-10-23, prod): VFB1023 — READ-ONLY follow-up to VFY1023 (PR #1905): how the Fleet Supervisor has run
  # since the deploy (runs by status/origin, durations, spend, no-op notes, fallbacks, its errors), the platform repo's first
  # walk-v2 code-index sync (meta + index_swept rows), the FS ledger cold-archive spill, the FS thread summary, owner-turn
  # telemetry if the owner has typed. Counts / ages / numeric meta only — never message text. VFB_* lines only.
  MARKER_VFB1023=/var/tmp/.digby-vfb1023-pr1905
  if [ ! -f "$MARKER_VFB1023" ]; then
    echo "== VFB1023 host=$(hostname) now=$(date -u +%FT%TZ) =="
    sudo tee /var/tmp/probe-verify-b-1023.js >/dev/null <<'VFB_EOF'
// probe-verify-b-1023.js — READ-ONLY follow-up to VFY1023 (PR #1905). Confirms, hours after the deploy: the platform repo's
// first walk-v2 code-index sync finished (meta record with sha/branch/listed/capHeld; index_swept rows), the FS ledger
// spilled closed rows to the cold archive on its first write, the FS thread summary advanced (debounce fix), and — if the
// owner has typed since the deploy — the owner-turn telemetry (history v2 / ledger diff / unread-state re-run). Counts,
// ages and numeric meta only; never message text.
'use strict';
const DEPLOY = new Date('2026-10-23T05:16:00Z');
const age = (d) => (d ? `${Math.round((Date.now() - new Date(d).getTime()) / 60000)}m` : '-');
const num = (m) => { const o = {}; for (const [k, v] of Object.entries(m || {})) if (typeof v === 'number' || typeof v === 'boolean') o[k] = v; return o; };
(async () => {
  const prisma = require('/app/dist/config/database').default;
  const ROOT = '/app/dist/modules/crossmodel';
  const CS = require(`${ROOT}/memory/context-store`);
  const ST = require(`${ROOT}/platform/supervisor-state.service`);
  const owner = await prisma.user.findFirst({ where: { email: 'example-user@example.com' }, select: { id: true } });
  const fsChat = owner && await prisma.crossModelChat.findFirst({ where: { userId: owner.id, isSupervisor: true, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!fsChat) { console.log('VFB_ERR no_fleet_chat'); console.log('VFB_DONE'); process.exit(0); }
  const id = fsChat.id;
  try {
    const projects = await prisma.crossModelProject.findMany({ where: { userId: owner.id, repoUrl: { contains: 'example-org/crossmodel' } }, select: { id: true } });
    for (const p of projects) {
      const meta = await CS.storeGet([p.id, 'code-index'], 'meta').catch(() => null);
      const st = await CS.storeGet([p.id, 'code-index'], 'state').catch(() => null);
      const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM digby_memory WHERE scope_id = $1 AND source = 'code'`, p.id).catch(() => [{ n: -1 }]);
      const arch = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM digby_memory_archive WHERE scope_id = $1 AND source = 'code'`, p.id).catch(() => [{ n: -1 }]);
      console.log(`VFB_INDEX project=${p.id.slice(0, 8)} meta=${meta ? 1 : 0} sha=${meta && meta.indexedSha ? String(meta.indexedSha).slice(0, 9) : '-'} branchSet=${meta && meta.branch ? 1 : 0} listed=${meta ? meta.listed : '-'} fileCount=${meta ? meta.fileCount : (st && st.files ? Object.keys(st.files).length : '-')} partial=${meta && meta.partial ? 1 : 0} truncated=${meta && meta.truncated ? 1 : 0} listingErrors=${meta ? (meta.listingErrors || 0) : '-'} capHeld=${meta ? (meta.capHeld ?? 0) : '-'} capSkipped=${meta && meta.capSkipped ? meta.capSkipped : '-'} syncAge=${age((meta || st || {}).lastSyncAt)} capEvicted=${st && st.capEvicted ? Object.keys(st.capEvicted).length : 0} codeRows=${rows[0].n} archivedCodeRows=${arch[0].n}`);
      const sw = await prisma.loopMetric.findMany({ where: { kind: 'index_swept', createdAt: { gte: DEPLOY }, sessionId: p.id }, orderBy: { createdAt: 'desc' }, take: 6, select: { value: true, meta: true, createdAt: true } }).catch(() => []);
      for (const r of sw) console.log(`VFB_SWEPT project=${p.id.slice(0, 8)} age=${age(r.createdAt)} value=${r.value} ${JSON.stringify(num(r.meta)).slice(0, 500)}`);
    }
    const swAll = await prisma.loopMetric.groupBy({ by: ['sessionId'], where: { kind: 'index_swept', createdAt: { gte: DEPLOY } }, _count: { _all: true } }).catch(() => []);
    console.log(`VFB_SWEPT_ALL projects=${swAll.length} rows=${swAll.reduce((n, r) => n + r._count._all, 0)}`);
  } catch (e) { console.log(`VFB_SECTION_ERR index ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }
  try {
    const doc = await ST.getSupervisorState(id);
    const cold = await prisma.contextStoreEntry.count({ where: { namespacePath: `${id}:supervisor-archive` } }).catch(() => -1);
    const row = await prisma.supervisorState.findUnique({ where: { chatId: id }, select: { updatedAt: true } }).catch(() => null);
    console.log(`VFB_LEDGER directives=${(doc.directives || []).length} archived=${(doc.archived || []).length} coldRows=${cold} projects=${(doc.projects || []).length} docUpdatedAge=${age(row && row.updatedAt)}`);
  } catch (e) { console.log(`VFB_SECTION_ERR ledger ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }
  try {
    const th = await CS.storeGet([id, 'thread'], 'state').catch(() => null);
    const keys = await prisma.contextStoreEntry.findMany({ where: { namespacePath: `${id}:thread` }, select: { key: true, updatedAt: true } }).catch(() => []);
    const lastOwner = await prisma.crossModelMessage.findFirst({ where: { chatId: id, role: 'user', createdAt: { gte: DEPLOY }, OR: [{ metadata: { path: ['origin'], equals: 'user' } }] }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }).catch(() => null);
    const userRowsSince = await prisma.crossModelMessage.count({ where: { chatId: id, role: 'user', createdAt: { gte: DEPLOY } } }).catch(() => -1);
    console.log(`VFB_THREAD messageCount=${th ? th.messageCount : '-'} lastUpdatedAge=${age(th && th.lastUpdated)} keys=${keys.map((k) => `${k.key}@${age(k.updatedAt)}`).join(',')} userRowsSinceDeploy=${userRowsSince} lastOwnerOriginUserAge=${age(lastOwner && lastOwner.createdAt)}`);
  } catch (e) { console.log(`VFB_SECTION_ERR thread ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }
  try {
    const kinds = ['supervisor_owner_turn_context', 'supervisor_owner_ledger_diff', 'supervisor_unread_state_retry', 'supervisor_unbacked_claim_retry', 'supervisor_harness_receipts', 'supervisor_wake_ledger_diff'];
    for (const k of kinds) {
      const rs = await prisma.loopMetric.findMany({ where: { kind: k, createdAt: { gte: DEPLOY } }, orderBy: { createdAt: 'desc' }, take: 3, select: { value: true, meta: true, createdAt: true, sessionId: true } }).catch(() => []);
      const n = await prisma.loopMetric.count({ where: { kind: k, createdAt: { gte: DEPLOY } } }).catch(() => -1);
      console.log(`VFB_METRIC ${k} n=${n}`);
      if (k.startsWith('supervisor_owner') || k === 'supervisor_unread_state_retry') for (const r of rs) console.log(`VFB_METRIC_ROW ${k} fs=${r.sessionId === id ? 1 : 0} age=${age(r.createdAt)} value=${r.value} ${JSON.stringify(num(r.meta)).slice(0, 400)}`);
    }
    const ft = await prisma.loopMetric.count({ where: { createdAt: { gte: DEPLOY }, kind: 'supervisor_harness_receipts', meta: { path: ['followThrough'], equals: true } } }).catch(() => -1);
    console.log(`VFB_FOLLOWTHROUGH rows=${ft}`);
    const errs = await prisma.$queryRawUnsafe(`SELECT left(regexp_replace(message, '[0-9a-f]{8,}', '<id>', 'g'), 80) AS m, count(*)::int AS n FROM app_error_logs WHERE "createdAt" >= $1 AND (message ILIKE '%code-index%' OR message ILIKE '%owner-turn%' OR message ILIKE '%supervisor-state%' OR message ILIKE '%cold%archive%' OR message ILIKE '%thread%' OR message ILIKE '%unread%' OR message ILIKE '%ledger%') GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, DEPLOY).catch((e) => [{ m: `query_failed ${String(e && e.message || e).slice(0, 60)}`, n: 0 }]);
    for (const e of errs) console.log(`VFB_ERRLOG n=${e.n} ${String(e.m).replace(/https?:\/\/\S+/g, '<url>').replace(/\S+@\S+/g, '<email>')}`);
  } catch (e) { console.log(`VFB_SECTION_ERR metrics ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }
  try {
    // How the Fleet Supervisor itself has run since the deploy: runs by status + trigger, failures, spend, no-ops, fallbacks.
    const runs = await prisma.$queryRawUnsafe(`SELECT status, coalesce(input->>'origin', '-') AS origin, "createdAt", "finishedAt" FROM agent_runs WHERE "sessionId" = $1 AND "createdAt" >= $2`, id, DEPLOY).catch((e) => { console.log(`VFB_FS_RUNS_ERR ${String(e && e.message || e).slice(0, 120).replace(/[0-9a-f]{8,}/g, '<id>')}`); return []; });
    const by = {}; for (const r of runs) { const k = `${r.status}/${r.origin || '-'}`; by[k] = (by[k] || 0) + 1; }
    const durs = runs.filter((r) => r.finishedAt).map((r) => (new Date(r.finishedAt) - new Date(r.createdAt)) / 1000).sort((a, b) => a - b);
    const q = (f) => (durs.length ? Math.round(durs[Math.min(durs.length - 1, Math.floor(f * durs.length))]) : '-');
    console.log(`VFB_FS_RUNS n=${runs.length} ${JSON.stringify(by)} durS p50=${q(0.5)} p90=${q(0.9)}`);
    const lm = await prisma.loopMetric.groupBy({ by: ['kind'], where: { sessionId: id, createdAt: { gte: DEPLOY } }, _count: { _all: true } }).catch(() => []);
    const pick = ['supervisor_noop', 'supervisor_material_gate', 'seat_fallback', 'context_overflow', 'context_compaction', 'run_spend', 'decision_gate', 'wake_delivered', 'finish_run', 'guard_strike'];
    console.log(`VFB_FS_KINDS ${JSON.stringify(Object.fromEntries(lm.filter((r) => pick.includes(r.kind)).map((r) => [r.kind, r._count._all])))}`);
    const spend = await prisma.loopMetric.aggregate({ where: { sessionId: id, kind: 'run_spend', createdAt: { gte: DEPLOY } }, _sum: { value: true } }).catch(() => null);
    const tin = await prisma.loopMetric.findMany({ where: { sessionId: id, kind: 'run_tokens_in', createdAt: { gte: DEPLOY } }, select: { value: true } }).catch(() => []);
    const tv = tin.map((r) => Number(r.value)).filter(Number.isFinite).sort((a, b) => a - b);
    console.log(`VFB_FS_COST usd=${spend && spend._sum.value != null ? Number(spend._sum.value).toFixed(2) : '-'} tokensIn p50=${tv.length ? tv[Math.floor(tv.length / 2)] : '-'} max=${tv.length ? tv[tv.length - 1] : '-'}`);
    const asst = await prisma.crossModelMessage.findMany({ where: { chatId: id, role: 'assistant', createdAt: { gte: DEPLOY } }, select: { createdAt: true, content: true } }).catch(() => []);
    const noop = asst.filter((m) => /WAKE: no-op|SWEEP: no-op/.test(String(m.content || ''))).length;
    const newest = asst.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), new Date(0));
    console.log(`VFB_FS_NOTES assistantRows=${asst.length} noopRows=${noop} newestAge=${asst.length ? age(newest) : '-'}`);
    const fe = await prisma.$queryRawUnsafe(`SELECT left(regexp_replace(message, '[0-9a-f]{8,}', '<id>', 'g'), 90) AS m, count(*)::int AS n FROM app_error_logs WHERE "createdAt" >= $1 AND message LIKE '%' || $2 || '%' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, DEPLOY, id).catch(() => []);
    for (const e of fe) console.log(`VFB_FS_ERR n=${e.n} ${String(e.m).replace(/https?:\/\/\S+/g, '<url>').replace(/\S+@\S+/g, '<email>')}`);
  } catch (e) { console.log(`VFB_SECTION_ERR fsruns ${String(e && e.message || e).slice(0, 160).replace(/[0-9a-f]{8,}/g, '<id>')}`); }
  console.log('VFB_DONE');
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.log(`VFB_ERR ${String(e && e.message || e).slice(0, 200).replace(/[0-9a-f]{8,}/g, '<id>')}`); console.log('VFB_DONE'); process.exit(0); });
VFB_EOF
    timeout -k 10 300 sudo bash /opt/crossmodel/scripts/framework-audit/prodq.sh /var/tmp/probe-verify-b-1023.js >/var/tmp/vfb1023.out 2>&1 </dev/null || true
    grep -E '^VFB_' /var/tmp/vfb1023.out | cut -c1-700 | head -n 200
    if grep -q '^VFB_DONE' /var/tmp/vfb1023.out; then sudo touch "$MARKER_VFB1023"; else echo "  probe failed or incomplete — marker left unset"; tail -5 /var/tmp/vfb1023.out | cut -c1-200; fi
    echo "== END VFB1023 =="
  fi
  # ── ONE-SHOT (2026-10-24bk, prod, ticket 437896fb): nightly backup missed —
  #    digby-backup.service hit TimeoutStartSec=1800 (killed +30min after the
  #    08:31Z start, "Failed with result 'timeout'"; the dump has outgrown
  #    30min — the 2026-10-23 nightly ran 08:34:49Z→09:02:27Z, ~27.5 min,
  #    only ~2.5 min of margin).
  #    Fix: install the repo unit with TimeoutStartSec=7200 (deploy/digby-backup
  #    .service, bumped in the same commit), refresh the installed script from
  #    the repo copy, reset the failed state, and start the catch-up run
  #    DETACHED via systemd-run --collect (the dump takes ~30+min and must
  #    outlive this SSH window). Disk verified healthy (642G free, 34% used —
  #    not the disk guard). NO old dumps are touched.
  MARKER_BK1024=/var/tmp/.digby-bk1024
  if [ ! -f "$MARKER_BK1024" ]; then
    echo "== BK1024 host=$(hostname) =="
    echo "--- unit BEFORE (TimeoutStartSec) ---"
    grep -H "TimeoutStartSec" /etc/systemd/system/digby-backup.service
    # Install the updated unit from the repo copy (same file this playbook
    # ships; the repo's deploy/digby-backup.service is the canonical text).
    sudo tee /etc/systemd/system/digby-backup.service > /dev/null << 'SVCEOF'
[Unit]
Description=Digby nightly backup (pg_dump + optional S3 offsite)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/digby-backup.sh
TimeoutStartSec=7200
SVCEOF
    sudo systemctl daemon-reload
    echo "--- unit AFTER ---"
    grep -H "TimeoutStartSec" /etc/systemd/system/digby-backup.service
    # Refresh the installed backup script from the repo canonical copy.
    if [ -f /opt/crossmodel/scripts/backup/digby-backup.sh ]; then
      sudo install -m 755 /opt/crossmodel/scripts/backup/digby-backup.sh /usr/local/bin/digby-backup.sh
      echo "  refreshed /usr/local/bin/digby-backup.sh from the repo canonical copy"
    else
      echo "  (repo copy not on box yet — existing /usr/local/bin script kept; unit fix is the load-bearing half)"
    fi
    # Clear the failed state from the timeout kill, then start the catch-up
    # run DETACHED so it survives this SSH window (~35-min dump).
    sudo systemctl reset-failed digby-backup.service 2>/dev/null || true
    sudo systemd-run --collect --unit=digby-backup-catchup-1024 \
      /usr/local/bin/digby-backup.sh 2>&1 || true
    echo "  catch-up run started detached (systemd unit digby-backup-catchup-1024)"
    echo "--- timer state (unchanged) ---"
    systemctl list-timers digby-backup.timer --no-pager | head -4
    echo "== END BK1024 =="
    sudo touch "$MARKER_BK1024"
  fi

  # ── ONE-SHOT (2026-10-24bv, prod, ticket 437896fb): verify the BK1024
  #    catch-up dump landed WITH its S3 offsite copy. Review round 1 (B2/B3):
  #    the gate is the catch-up unit's own JOURNAL — "wrote …dump", the ok
  #    status marker, and "offsite copy uploaded" — never a date glob
  #    (rotation deletes the dated dump file after KEEP_LOCAL=3, which would
  #    make the gate permanently unsatisfiable) and never a long inline wait
  #    (the prod ssh is bounded at 1200s; an 8.2G S3 upload runs minutes on
  #    its own clock). Journal lines persist independently of the 3-dump disk
  #    rotation. The instance role deliberately has no s3:ListBucket
  #    (docs/BACKUPS.md), so `aws s3 ls` from the box fails BY DESIGN — the
  #    journal line IS the S3 evidence. Marker is set only on the complete
  #    triple, so an incomplete pass retries on the next playbook run.
  MARKER_BV1024=/var/tmp/.digby-bv1024
  if [ ! -f "$MARKER_BV1024" ]; then
    echo "== BV1024 host=$(hostname) =="
    echo "--- catch-up journal (digby-backup-catchup-1024, key lines) ---"
    sudo journalctl -u digby-backup-catchup-1024.service --no-pager -n 60 2>/dev/null \
      | grep -E "digby-backup|offsite|starting pg_dump|wrote |ABORT|FAILED|done" | tail -25
    echo "--- dumps on disk (informational — rotation keeps 3) ---"
    sudo sh -c 'ls -lh --time-style=long-iso /opt/crossmodel-backups/admin_db-*.dump | tail -4'
    echo "--- status marker ---"
    sudo cat /opt/crossmodel-backups/backup-status.json 2>/dev/null; echo ""
    echo "--- unit budget (must be 7200) ---"
    grep -H "TimeoutStartSec" /etc/systemd/system/digby-backup.service
    # Short inline wait (<=2 min, VR0907 idiom) for the LOCAL half only
    # (dump journal line + ok status). The S3 leg is NEVER waited on inline:
    # a detached waiter (systemd-run --collect — the LDA1020/RBK1020 idiom)
    # watches for the offsite journal line off the CI clock and touches the
    # marker itself.
    echo "--- waiting (<=2 min) for the catch-up dump + ok status ---"
    for i in $(seq 1 12); do
      if sudo journalctl -u digby-backup-catchup-1024.service --no-pager 2>/dev/null \
           | grep -q 'wrote /opt/crossmodel-backups/admin_db-' \
         && sudo grep -q '"status":"ok"' /opt/crossmodel-backups/backup-status.json 2>/dev/null; then
        break
      fi
      printf '.'; sleep 10
    done; echo ""
    # Full triple: dump journal line + ok status + S3 offsite journal line.
    if sudo journalctl -u digby-backup-catchup-1024.service --no-pager 2>/dev/null | grep -q 'wrote /opt/crossmodel-backups/admin_db-' \
       && sudo grep -q '"status":"ok"' /opt/crossmodel-backups/backup-status.json 2>/dev/null \
       && sudo journalctl -u digby-backup-catchup-1024.service --no-pager 2>/dev/null | grep -q 'offsite copy uploaded to s3://'; then
      sudo touch "$MARKER_BV1024"
      echo "  verification PASS — catch-up dump + ok status + S3 offsite journal line; marker set"
    else
      # Detached waiter: up to 30 min for the offsite line, then the marker.
      # Fixed unit name — a re-run while one is pending is refused by systemd
      # (harmless duplicate; `|| true`).
      sudo systemd-run --collect --unit=digby-backup-verify-1024 bash -c \
        'for i in $(seq 1 180); do journalctl -u digby-backup-catchup-1024.service --no-pager 2>/dev/null | grep -q "offsite copy uploaded to s3://" && { touch /var/tmp/.digby-bv1024; exit 0; }; sleep 10; done; echo "BV1024 waiter: no offsite line within 30 min — investigate the S3 leg (journalctl -u digby-backup-catchup-1024.service)"' 2>&1 || true
      echo "  verification not yet complete — detached waiter armed for the S3 offsite line; marker retries on next playbook run"
    fi
    echo "== END BV1024 =="
  fi

  # ── ONE-SHOT (2026-10-27, coding): DG1027F211 — decision-gate calibration unblock (ticket c013c318, FS task f64b7c1e) ──
  # Read-only capture + ONE readiness-job pass (fit+stamp+temps). The direct gateway probe reproduces
  # the decision-gate[probe] failure against agx-laya (llm-cql) with the REAL latency/HTTP/parse story.
  MARKER_DG1027=/var/tmp/.digby-dg1027f211
  if [ ! -f "$MARKER_DG1027" ]; then
    echo "== DG1027F211 host=$(hostname) now=$(date -u +%FT%TZ) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 -E 'admin-worker-(blue|green)') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -F' | ' -c "$1" 2>&1 | head -20; }
    echo "--- [1] registered decision endpoints (model_endpoints, no keys) ---"
    q "SELECT label, base_url, e.enabled, m->>'id' AS model_id, m->>'decision' AS decision_flag, m->>'calibrated' AS calibrated FROM model_endpoints e, jsonb_array_elements(e.models) m WHERE e.label ILIKE '%agx%' OR e.label ILIKE '%cql%' OR m->>'decision' = 'true' ORDER BY e.label LIMIT 8"
    echo "--- [2] stored decision-gate rows: modes + backends ---"
    q "SELECT key, left(value::text, 900) FROM store WHERE namespace_path = 'instance:decision-gate' AND key IN ('modes','backends')"
    echo "--- [3] which backend answered the last 14d of decision rows ---"
    q "SELECT meta->>'backendSpec' AS spec, count(*), max(created_at) FROM loop_metrics WHERE kind='decision_gate' AND meta->>'phase'='decision' AND created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
    echo "--- [4] probe + all_legs_failed log lines, 48h ---"
    q "SELECT count(*), min(created_at), max(created_at) FROM app_error_logs WHERE created_at > now() - interval '48 hours' AND (message LIKE '%decision-gate[probe]%' OR message LIKE '%no backend answered%')"
    q "SELECT left(message, 260) FROM app_error_logs WHERE created_at > now() - interval '48 hours' AND message LIKE '%decision-gate[probe]%' ORDER BY created_at DESC LIMIT 4"
    echo "--- [5] DIRECT gateway probe: agx-laya /chat/completions, readout shape (node/fetch INSIDE the worker — the same transport the backend leg uses) ---"
    EP_URL=$(q "SELECT base_url || '/chat/completions' FROM model_endpoints WHERE (label ILIKE '%agx%laya%' OR label ILIKE '%agx-laya%') AND enabled LIMIT 1" | head -1)
    EP_MODEL=$(q "SELECT m->>'id' FROM model_endpoints e, jsonb_array_elements(e.models) m WHERE (e.label ILIKE '%agx%laya%' OR e.label ILIKE '%agx-laya%') AND e.enabled LIMIT 1" | head -1)
    echo "endpoint resolved: model=${EP_MODEL:-<none>} url=${EP_URL:+<set>}"
    if [ -n "$BK" ] && [ -n "$EP_URL" ]; then
      sudo docker exec -e DG_EP_URL="$EP_URL" -e DG_EP_MODEL="$EP_MODEL" "$BK" node -e '
        const url = process.env.DG_EP_URL, model = process.env.DG_EP_MODEL;
        const body = { model, messages: [
          { role: "system", content: "Answer with exactly one letter." },
          { role: "user", content: "The customer explicitly asks for money back. Options: (A) noul yes (B) noul no. Reply with the single letter only." },
        ], max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20, stream: false };
        const t0 = Date.now();
        fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })
          .then(async (r) => {
            const ms = Date.now() - t0;
            const text = await r.text();
            console.log(`HTTP=${r.status} latency_ms=${ms}`);
            try {
              const j = JSON.parse(text);
              const first = j?.choices?.[0]?.logprobs?.content?.[0];
              console.log(first ? `logprobs present; sampled token=${JSON.stringify(first.token)}; top_k=${(first.top_logprobs || []).length}` : `NO logprobs in response (choices[0].logprobs missing); model=${j?.model}`);
              const e = j?.error || j?.detail;
              if (e) console.log(`error body: ${JSON.stringify(e).slice(0, 300)}`);
              console.log(`content=${JSON.stringify(j?.choices?.[0]?.message?.content ?? null)}`);
            } catch { console.log(`non-JSON body: ${text.slice(0, 300)}`); }
          })
          .catch((e) => console.log(`PROBE FAILED after ${Date.now() - t0}ms: ${e?.name || ""} ${e?.message || e}`));
      ' 2>&1 | tail -6
    else echo "(worker or endpoint missing — skipped)"; fi
    echo "--- [6] readiness-job pass NOW (fit + stamp + temps autofit on for this pass) ---"
    if [ -n "$BK" ]; then
      JOBJS=$(sudo docker exec "$BK" sh -c 'ls /app/backend/dist/modules/crossmodel/platform/decision-gate-readiness.job.js 2>/dev/null || find /app -maxdepth 6 -name "decision-gate-readiness.job.js" 2>/dev/null | head -1')
      echo "job module: $JOBJS"
      sudo docker exec -e DECISION_GATE_TEMP_AUTOFIT_ENABLED=1 "$BK" node -e "
        const { runDecisionGateReadinessOnce } = require('$JOBJS');
        runDecisionGateReadinessOnce({}).then((s) => { console.log('READINESS PASS:', s); process.exit(0); }).catch((e) => { console.error('PASS FAILED:', e && e.message); process.exit(0); });
      " 2>&1 | tail -6
    else echo "(no worker container found — skipped)"; fi
    echo "--- [7] post-pass: the stamp + fitted temps in the store ---"
    q "SELECT key, left(value::text, 1200) FROM store WHERE namespace_path = 'instance:decision-gate' AND key IN ('readiness','backends')"
    sudo touch "$MARKER_DG1027"
    echo "== END DG1027F211 =="
  fi
  # ── ONE-SHOT (2026-10-27, coding): DG1027F211B — decision-gate[probe] REPRO inside the worker container ──
  # DG1027F211's box-level docker-run psql path failed (RDS connection refused from fresh containers —
  # pre-existing diagnostics one-shots hit the same), so the direct agx-laya probe ran on a poisoned
  # lookup. The WORKER container reaches the DB fine (the readiness pass read 62k rows) and has the
  # endpoint registry — so the repro runs the app's own probeDecisionSpec('llm-cql:agx-laya') there:
  # it resolves the endpoint from the DB, calls the gateway with the real readout shape, and (on the
  # merged cc811bbc build) renders the captured leg errors (HTTP status / parse / timeout).
  MARKER_DG1027B=/var/tmp/.digby-dg1027f211b
  if [ ! -f "$MARKER_DG1027B" ]; then
    echo "== DG1027F211B host=$(hostname) now=$(date -u +%FT%TZ) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 -E 'admin-worker-(blue|green)') || true
    if [ -n "$BK" ]; then
      echo "worker container: $BK"
      DGJS=$(sudo docker exec "$BK" sh -c 'ls /app/backend/dist/modules/crossmodel/platform/decision-gate.js 2>/dev/null || find /app -maxdepth 6 -path "*platform/decision-gate.js" 2>/dev/null | head -1')
      echo "decision-gate module: $DGJS"
      echo "--- [1] leg budget env + recent decision-gate[probe] log lines ---"
      sudo docker exec "$BK" node -e "console.log('DECISION_GATE_LEG_TIMEOUT_MS=', process.env.DECISION_GATE_LEG_TIMEOUT_MS || '(unset — default 2000)')"
      sudo docker logs "$BK" --since 40m 2>&1 | grep -i 'decision-gate\[probe\]' | tail -6 || echo "(no decision-gate[probe] lines in the last 40 m)"
      echo "--- [2] probeDecisionSpec('llm-cql:agx-laya') — the REAL repro (resolves the endpoint from the DB itself) ---"
      sudo docker exec "$BK" node -e "
        const { probeDecisionSpec } = require('$DGJS');
        probeDecisionSpec('llm-cql:agx-laya').then((r) => { console.log('PROBE RESULT: ' + JSON.stringify(r)); process.exit(0); }).catch((e) => { console.log('PROBE THREW: ' + (e && e.message)); process.exit(0); });
      " 2>&1 | tail -4
      echo "--- [3] the fitted per-(backend, purpose) temperatures in the store (what DG1027F211 wrote) ---"
      sudo docker exec "$BK" node -e "
        const dg = require('$DGJS');
        const fn = dg.refreshDecisionBackendTemps;
        (typeof fn === 'function' ? fn() : Promise.resolve(null)).then((t) => { console.log('TEMPS: ' + JSON.stringify(t)); process.exit(0); }).catch((e) => { console.log('TEMPS READ FAILED: ' + (e && e.message)); process.exit(0); });
      " 2>&1 | tail -3
    else echo "(no worker container found — skipped)"; fi
    sudo touch "$MARKER_DG1027B"
    echo "== END DG1027F211B =="
  fi
  # ── ONE-SHOT (2026-10-27, coding): DG1027F211D — post-deploy force-on read-back (FS task f64b7c1e prio-2) ──
  # RETIRED 2026-10-27 (f64b7c1e follow-up): covered box A only (host=ip-10-0-0-11) and read
  # container env, not the PUT path. Superseded by DG1027F211E below, which reads the keys
  # fleet-relevantly AND evaluates purposeActCap inside the WEB backend (the process that
  # serves set_decision_gate_mode). Marker kept so the old block never re-fires.
  MARKER_DG1027D=/var/tmp/.digby-dg1027f211d
  if [ ! -f "$MARKER_DG1027D" ]; then
    echo "== DG1027F211D host=$(hostname) now=$(date -u +%FT%TZ) (retired — no-op; see DG1027F211E) =="
    for K in DECISION_GATE_ADMISSION_DISABLED SUPERVISOR_MATERIAL_GATE_DISABLED; do
      echo "  [$K]"
      echo "    overrides file: $(sudo grep -h "^$K=" /opt/crossmodel-local/env-overrides.env 2>/dev/null || echo '<absent>')"
      echo "    folded .env:    $(sudo grep -h "^$K=" /opt/crossmodel/.env 2>/dev/null || echo '<absent>')"
    done
    for C in $(sudo docker ps --format '{{.Names}}' | grep -E 'admin-(backend|worker)-(blue|green)'); do
      echo "  [$C] started=$(sudo docker inspect "$C" --format '{{.State.StartedAt}}')"
      sudo docker exec "$C" sh -c 'echo "    env: DECISION_GATE_ADMISSION_DISABLED=${DECISION_GATE_ADMISSION_DISABLED:-<unset>} SUPERVISOR_MATERIAL_GATE_DISABLED=${SUPERVISOR_MATERIAL_GATE_DISABLED:-<unset>}"'
    done
    echo "== END DG1027F211D =="
    sudo touch "$MARKER_DG1027D"
  fi
  # ── ONE-SHOT (2026-10-27, coding): DG1027F211E — RETIRED (consumed 2026-10-27T22:36Z,
  # ec2-ops run 40594114497). Its [1] box-A file read and [4] AUTOFIT readiness pass
  # succeeded ("rows 62056, purposes 22, ready 0, stamped"); its [2]/[5] in-container
  # PUT-path reads hardcoded /app/backend/dist but prod containers serve /app/dist, so
  # both died MODULE_NOT_FOUND before printing a verdict. Superseded by DG1027F211F
  # below, which resolves every module path INSIDE the container before requiring it.
  MARKER_DG1027E=/var/tmp/.digby-dg1027f211e
  if [ ! -f "$MARKER_DG1027E" ]; then echo "== DG1027F211E retired — superseded by DG1027F211F =="; sudo touch "$MARKER_DG1027E"; fi
  # ── ONE-SHOT (2026-10-28, coding): DG1027F211F — PUT-path verdicts + per-box key naming (FS task f64b7c1e ASK 1 close) ──
  # Read-only (no readiness re-pass — the 22:37Z AUTOFIT stamp is fresh and hourly jobs
  # keep it current). [1] box A key state; [2] purposeActCap + decisionAdmissionDisabled
  # evaluated INSIDE the admin backend (the process that serves set_decision_gate_mode),
  # with the module path resolved in-container (find) instead of hardcoded — the exact
  # defect that killed DG1027F211E's [2]/[5]. Box C's key state is read by the
  # DG1027F211F-BOXC one-shot in the coding-c section of the SAME run; box B rides the
  # deploy.yml fleet .env template and is verified per-wave by the workflow's own
  # "Verify force-on keys" step.
  MARKER_DG1027F=/var/tmp/.digby-dg1027f211f
  if [ ! -f "$MARKER_DG1027F" ]; then
    echo "== DG1027F211F host=$(hostname) now=$(date -u +%FT%TZ) =="
    BE=$(sudo docker ps --format '{{.Names}}' | grep -m1 -E 'admin-backend-(blue|green)') || true
    echo "--- [1] box A key state: overrides + folded .env + the deploy template on disk ---"
    for K in DECISION_GATE_ADMISSION_DISABLED SUPERVISOR_MATERIAL_GATE_DISABLED; do
      echo "  [$K] overrides: $(sudo grep -h "^$K=" /opt/crossmodel-local/env-overrides.env 2>/dev/null || echo '<absent>') | folded .env: $(sudo grep -h "^$K=" /opt/crossmodel/.env 2>/dev/null || echo '<absent>')"
    done
    TPL=$(sudo grep -nE '^(DECISION_GATE_ADMISSION_DISABLED|SUPERVISOR_MATERIAL_GATE_DISABLED)=' /opt/crossmodel/.github/workflows/deploy.yml 2>/dev/null || true)
    if [ -n "$TPL" ]; then printf '%s\n' "$TPL" | sed 's/^/    template: /'; else echo "    <template lines absent>"; fi
    echo "--- [2] THE PUT PATH: purposeActCap INSIDE the admin backend (serves set_decision_gate_mode) ---"
    if [ -n "$BE" ]; then
      MODES_JS=$(sudo docker exec "$BE" sh -c 'ls /app/dist/modules/crossmodel/platform/decision-gate-modes.js 2>/dev/null || find /app -maxdepth 6 -path "*platform/decision-gate-modes.js" 2>/dev/null | head -1')
      echo "  module: $MODES_JS"
      if [ -n "$MODES_JS" ]; then
        sudo docker exec -e MODES_JS="$MODES_JS" "$BE" node -e '
          const m = require(process.env.MODES_JS);
          const purposes = ["wake_triage","sweep_triage","drain_triage","task_kind","self_audit","tool_intent","delta_material","auto_route","browser_driver","checker_route","reflection_route","firing_superseded","drafts_agree","revision_material","turn_plan"];
          console.log("  env on this process: DECISION_GATE_ADMISSION_DISABLED=" + (process.env.DECISION_GATE_ADMISSION_DISABLED || "<unset>") + " SUPERVISOR_MATERIAL_GATE_DISABLED=" + (process.env.SUPERVISOR_MATERIAL_GATE_DISABLED || "<unset>"));
          console.log("  admissionDisabled=" + m.decisionAdmissionDisabled());
          for (const p of purposes) { const cap = m.purposeActCap(p); console.log("  PUT-verdict " + p + ": " + (cap ? "REFUSED (cap " + cap.since + ", lift " + cap.liftEnv + ")" : "cap-null — code-cap refusal CANNOT fire")); }
        ' 2>&1 | sed 's/^/  /'
      else echo "  <decision-gate-modes.js not found in container — inspect image layout>"; fi
    else echo "  (no backend container found — skipped)"; fi
    echo "== END DG1027F211F =="
    sudo touch "$MARKER_DG1027F"
  fi
  # ── ONE-SHOT (2026-10-28, coding): F211F-AUTOFIT — readiness autofit per-box state (FS steer 02:34Z item 2) ──
  # Closes the 02:08Z delta's "no fitted temp exists anywhere" UNVERIFIED carry-forward
  # with MEASURED box-A state: [4] the store's fitted temps (row instance:decision-gate/
  # backends, value.temps — written by the 6 h readiness job ONLY when
  # DECISION_GATE_TEMP_AUTOFIT_ENABLED=1; _DISABLED=1 is the hard kill) + the readiness
  # stamp/report rows' freshness; [5] the SAME decision inside the worker's runtime —
  # tempAutofitEnabled() reads the WORKER process env, and the worker is the process
  # that runs the job (the deciding surface). Read-only.
  MARKER_F211FA=/var/tmp/.digby-f211f-autofit
  if [ ! -f "$MARKER_F211FA" ]; then
    echo "== F211F-AUTOFIT host=$(hostname) now=$(date -u +%FT%TZ) =="
    BK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    BE_URL=$(sudo docker exec "$BK" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -12; }
    echo "--- [4] store: fitted temps + readiness stamp/report rows ---"
    q "SELECT 'temps-keys', COALESCE(string_agg(k, ', '), '<none — autofit never stored>') FROM (SELECT jsonb_object_keys(value->'temps') AS k FROM store WHERE namespace_path='instance:decision-gate' AND key='backends' AND jsonb_typeof(value->'temps')='object') t"
    q "SELECT 'backends-row', (value ? 'temps')::text, to_char(\"updatedAt\", 'MM-DD HH24:MI') FROM store WHERE namespace_path='instance:decision-gate' AND key='backends'"
    q "SELECT 'stamp/report rows', key, to_char(\"updatedAt\", 'MM-DD HH24:MI') FROM store WHERE namespace_path='instance:decision-gate' AND key IN ('readiness','readiness-report')"
    q "SELECT 'stamp ready purposes', COALESCE(string_agg(k, ', '), '<none ready>') FROM store s, LATERAL jsonb_object_keys(s.value) k WHERE s.namespace_path='instance:decision-gate' AND s.key='readiness' AND s.value->k->>'ready'='true'"
    q "SELECT 'decision_gate_readiness rows 7d', count(*)::text FROM loop_metrics WHERE kind='decision_gate_readiness' AND \"createdAt\" > now() - interval '7 days'"
    if [ -n "$BK" ]; then
      echo "--- [5] worker runtime: autofit switches as the job reads them ---"
      RDY_JS=$(sudo docker exec "$BK" sh -c 'ls /app/dist/modules/crossmodel/platform/decision-gate-readiness.js 2>/dev/null || find /app -maxdepth 6 -path "*platform/decision-gate-readiness.js" 2>/dev/null | head -1')
      echo "  module: $RDY_JS"
      if [ -n "$RDY_JS" ]; then
        sudo docker exec -e RDY_JS="$RDY_JS" "$BK" node -e '
          const m = require(process.env.RDY_JS);
          console.log("  worker env: DECISION_GATE_TEMP_AUTOFIT_ENABLED=" + (process.env.DECISION_GATE_TEMP_AUTOFIT_ENABLED || "<unset>") + " DECISION_GATE_TEMP_AUTOFIT_DISABLED=" + (process.env.DECISION_GATE_TEMP_AUTOFIT_DISABLED || "<unset>") + " DECISION_GATE_READINESS_JOB_DISABLED=" + (process.env.DECISION_GATE_READINESS_JOB_DISABLED || "<unset>"));
          console.log("  tempAutofitEnabled()=" + m.tempAutofitEnabled() + " tempAutofitDisabled()=" + m.tempAutofitDisabled() + " readinessJobDisabled()=" + m.readinessJobDisabled() + " intervalSec=" + m.readinessIntervalSec());
        ' 2>&1 | sed 's/^/  /'
      else echo "  <decision-gate-readiness.js not found in worker — inspect image layout>"; fi
    else echo "  (no worker container found — [5] skipped)"; fi
    echo "== END F211F-AUTOFIT =="
    sudo touch "$MARKER_F211FA"
  fi
  # ── ONE-SHOT (2026-10-28, coding): F211F-BG-ENV — box A blue/green per-process env print (read-only; FS steer item 3, rides free) ──
  MARKER_F211FBG=/var/tmp/.digby-f211f-bgenv
  if [ ! -f "$MARKER_F211FBG" ]; then
    echo "== F211F-BG-ENV host=$(hostname) now=$(date -u +%FT%TZ) =="
    for C in $(sudo docker ps --format '{{.Names}}' | grep -E 'admin-(backend|worker|frontend)'); do
      echo "  $C: $(sudo docker exec "$C" sh -c 'echo "DG_ADM=${DECISION_GATE_ADMISSION_DISABLED:-<unset>} SUP_MAT=${SUPERVISOR_MATERIAL_GATE_DISABLED:-<unset>} AUTOFIT_EN=${DECISION_GATE_TEMP_AUTOFIT_ENABLED:-<unset>} AUTOFIT_DIS=${DECISION_GATE_TEMP_AUTOFIT_DISABLED:-<unset>}"' 2>/dev/null || echo '(env read skipped)')"
    done
    echo "== END F211F-BG-ENV =="
    sudo touch "$MARKER_F211FBG"
  fi
  # ── ONE-SHOT (2026-10-28, coding): DG1027F211G — autofit storage verdict AFTER the DECISION_GATE_TEMP_AUTOFIT_ENABLED=1 wave ──
  # Closes F211F's [4] carry-forward with a MEASURED store read, using the idiom the
  # repo itself prescribes for the broken docker-run→RDS path (run 40625860681; see
  # docs/FRAMEWORK_BACKLOG.md PSQL-1): node+pg INSIDE the existing admin-worker
  # container, on the worker's own DATABASE_URL — no fresh docker-run container.
  # Marker consumed ONLY on a confirmed fit (temps keys present) — a failed read or
  # an empty temps leaves it in place so the probe re-fires on the next dispatch.
  MARKER_DG1027G=/var/tmp/.digby-dg1027f211g
  if [ ! -f "$MARKER_DG1027G" ]; then
    echo "== DG1027F211G host=$(hostname) now=$(date -u +%FT%TZ) =="
    WK=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    OUT=""
    if [ -n "$WK" ]; then
      Q1="SELECT COALESCE(string_agg(k, ', '),'(empty object)') AS keys FROM (SELECT jsonb_object_keys(value->'temps') AS k FROM store WHERE namespace_path='instance:decision-gate' AND key='backends') t"
      Q2="SELECT (value ? 'temps')::text AS has_temps, COALESCE(to_char(\"updated_at\",'MM-DD HH24:MI'),'-') AS upd FROM store WHERE namespace_path='instance:decision-gate' AND key='backends'"
      Q3="SELECT COALESCE(value->>'autofitEnabled','<absent>') AS af, COALESCE(value->>'tempsWritten','<absent>') AS tw, COALESCE(to_char(\"updated_at\",'MM-DD HH24:MI'),'-') AS upd FROM store WHERE namespace_path='instance:decision-gate' AND key='readiness-report'"
      Q4="SELECT COALESCE(to_char(max(\"createdAt\"),'MM-DD HH24:MI'),'<never>') AS last_pass FROM loop_metrics WHERE kind='decision_gate_readiness'"
      OUT=$(sudo docker exec -e Q1="$Q1" -e Q2="$Q2" -e Q3="$Q3" -e Q4="$Q4" "$WK" node -e 'const {Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:/sslmode=disable/.test(process.env.DATABASE_URL||"")?false:{rejectUnauthorized:false}});await c.connect();let r=await c.query(process.env.Q1);console.log("TEMPS_KEYS="+(r.rows[0]?r.rows[0].keys:"<no row>"));r=await c.query(process.env.Q2);console.log("BACKENDS_ROW="+(r.rows[0]?("temps_present="+(r.rows[0].has_temps||"false")+" updated="+r.rows[0].upd):"<no row>"));r=await c.query(process.env.Q3);console.log("REPORT_FLAG="+(r.rows[0]?("autofitEnabled="+r.rows[0].af+" tempsWritten="+r.rows[0].tw+" updated="+r.rows[0].upd):"<no report row>"));r=await c.query(process.env.Q4);console.log("LAST_READINESS_PASS="+r.rows[0].last_pass);await c.end();})().catch(e=>{console.log("DBERR="+e.message);process.exit(1)})' 2>&1)
      echo "$OUT" | sed 's/^/  /'
      RDY_JS=$(sudo docker exec "$WK" sh -c 'ls /app/dist/modules/crossmodel/platform/decision-gate-readiness.js 2>/dev/null || find /app -maxdepth 6 -path "*platform/decision-gate-readiness.js" 2>/dev/null | head -1')
      if [ -n "$RDY_JS" ]; then
        sudo docker exec -e RDY_JS="$RDY_JS" "$WK" node -e 'const m=require(process.env.RDY_JS);console.log("  runtime: DECISION_GATE_TEMP_AUTOFIT_ENABLED="+(process.env.DECISION_GATE_TEMP_AUTOFIT_ENABLED||"<unset>")+" tempAutofitEnabled()="+m.tempAutofitEnabled()+" intervalSec="+m.readinessIntervalSec());' 2>&1 | sed 's/^/  /'
      else echo "  (readiness module not found in worker — runtime line skipped)"; fi
    else echo "  (no worker container found — store read skipped)"; fi
    if echo "$OUT" | grep -q 'TEMPS_KEYS=' && ! echo "$OUT" | grep -qE 'DBERR=|TEMPS_KEYS=(<no row>|\(empty object\))'; then
      echo "  VERDICT: fitted temps PRESENT in store — autofit storage CONFIRMED (marker consumed)"
      sudo touch "$MARKER_DG1027G"
    else
      echo "  VERDICT: NOT confirmed yet (read failed, no worker, or temps still empty) — marker NOT consumed; re-fires on the next dispatch"
    fi
    echo "== END DG1027F211G =="
  fi
  # ── ONE-SHOT (2026-10-28, prod): FB4A18B0 — FIX_STATE_EVIDENCE_REPO_ALLOWLIST per-PROCESS proof ──
  # Ticket 4e818bb9 machine-close was refused REPO NOT ALLOWED: the done-bar's
  # repo-scoped close (fix-state.ts) resolves the evidence repo against
  # FIX_STATE_EVIDENCE_REPO_ALLOWLIST, which the fleet .env template now carries
  # (UNION example-org/crossmodel,example-org/optcg — SETTING the key REPLACES the
  # platform-repo-only default). This block proves the value LIVE INSIDE the
  # running backend + worker processes — a line in .env alone does NOT count
  # (crossmodel Supervisor verification bar, 10:25Z). Marker is consumed ONLY on
  # a fully-passing read so the next dispatch re-proves it if recreate had not
  # landed yet (a failed read never touches the marker).
  MARKER_FB4A=/var/tmp/.digby-fb4a18b0-prod
  if [ ! -f "$MARKER_FB4A" ]; then
    echo "== FB4A18B0 host=$(hostname) now=$(date -u +%FT%TZ) =="
    K=FIX_STATE_EVIDENCE_REPO_ALLOWLIST
    WANT=example-org/crossmodel,example-org/optcg
    echo "  folded .env: $(sudo grep -h "^$K=" /opt/crossmodel/.env 2>/dev/null || echo '<absent>')"
    FAIL=0
    for CNAME in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-(backend|worker)-(blue|green)$'); do
      GOT=$(sudo docker exec "$CNAME" sh -c "printf %s \"\$$K\"" 2>/dev/null)
      echo "  FIX_STATE_PROCESS=($CNAME) $K=$GOT"
      [ "$GOT" = "$WANT" ] || FAIL=1
    done
    if [ "$FAIL" = "0" ]; then
      echo "  VERDICT: allowlist LIVE in-process on all admin-backend/admin-worker containers — marker consumed"
      sudo touch "$MARKER_FB4A"
    else
      echo "  VERDICT: value NOT live in-process on every container (recreate had not landed yet) — marker NOT consumed; re-fires on the next dispatch"
    fi
    echo "== END FB4A18B0 =="
  fi
  # ── ONE-SHOT (2026-11-03, prod): LL1E16-1103 — the two owner-authorized prod one-shots, in one
    #    block so the ORDER (measure → apply-if-absent → E16 dry run) is enforced by the script
    #    instead of by an operator's memory. ──
    # OWNER GO: owner card `oq_8aef3962`, answered 2026-11-03T23:16Z, verbatim:
    #   "Run both — the LL-1 measure, then its --apply if absent; plus the E16 dry run"
    # The card text itself says LL-1's --apply "uses CREATE INDEX CONCURRENTLY, so no audit insert is
    # blocked while it builds" — the answer is the explicit go for it. Requested by supervisor lane
    # daee2916 (relays 23:2xZ and 23:45Z).
    #
    #   1. LL-1 MEASURE (read-only): rows / sizeBytes / estimateSeconds / existing / otherIndexes.
    #      estimateSeconds IS the "expected duration" answer — no figure is guessed in prose.
    #   2. LL-1 --apply (WRITE, ONLY when the measure reports the index ABSENT): the script emits one
    #      `CREATE INDEX CONCURRENTLY IF NOT EXISTS` on the write-hot `activities` table. Idempotent;
    #      it REFUSES on a previously-FAILED (INVALID) index and prints the DROP INDEX CONCURRENTLY.
    #   3. E16 DRY RUN (read-only): session-topology-migrate.js is dry-run by default — `--apply` is
    #      the only write path and is NOT passed. Topology stays OBSERVE-ONLY (SESSION_TOPOLOGY_ENFORCE
    #      untouched). Prints the per-project dedupe report (lanes/byAction/charterBound/topology).
    #
    # THE THREE LEGS ARE INDEPENDENT ON PURPOSE: a failed LL-1 build must NOT suppress the E16 dry
    # run (it is read-only and is the input any topology decision waits on). Each leg sets its own
    # status; the MARKER is consumed only when LL-1 ends present-or-built AND E16 produced a report.
    #
    # NO `git pull` HERE — DELIBERATE, and it CORRECTS the 23:45Z steer. deploy.yml rsyncs this repo
    # with `--exclude '.git'`, so /opt/crossmodel on the box is NOT a git checkout and
    # `git -C /opt/crossmodel pull` cannot work. The three files this block needs ride the deploy
    # rsync (all present on main since fa5d068a), so the guard is an explicit existence check that
    # says which file is missing from where and leaves the marker UNSET to re-fire. Never silent.
    #
    # MID-WAVE GUARD: CREATE INDEX CONCURRENTLY waits on in-flight transactions, and a blue/green swap
    # replaces the very container prodq.sh execs into — a reading against a half-deployed box is not a
    # measurement (supervisor steer 23:45Z). If a deploy script is running here, the block DEFERS and
    # consumes nothing.
    #
    # JSON SHAPES ARE PINNED TO THE REAL SCRIPTS, not guessed:
    #   ll1-activities-index.js logs COMPACT JSON via JSON.stringify(o)      → `"existing":null`
    #   session-topology-migrate.js prints PRETTY JSON (…, null, 2)          → `"dryRun": true` (SPACED)
    # hence every grep below allows optional spaces around the colon. A compact-only grep here would
    # silently never match the E16 report and the marker would never be consumed.
    MARKER_LL1E16=/var/tmp/.digby-ll1e16-1103
    if [ ! -f "$MARKER_LL1E16" ]; then
      echo "== LL1E16-1103 host=$(hostname) now=$(date -u +%FT%TZ) =="
      echo "  owner go: oq_8aef3962 (2026-11-03T23:16Z) — LL-1 measure, then --apply if absent, plus the E16 dry run"
      LL1E16_DIR=/opt/crossmodel/scripts/framework-audit
      echo "  on-disk deploy sha: $(cat /opt/crossmodel/.deploy-sha 2>/dev/null || echo missing)"
      LL1E16_GO=1
      # WAIT FOR A QUIET WINDOW (bounded) — do NOT defer on the FIRST check. The fleet lands a
      # deploy wave every ~10 min when lanes are busy merging, so a block that gives up whenever
      # one is in flight re-fires into the NEXT wave forever and never converges. Observed on the
      # first real execution (ec2-ops run 41745241449, 2026-11-04T00:29:15Z): it deferred with a
      # wave in flight, and three more waves landed inside the following 15 min.
      # So poll until the deploy script has been ABSENT for LL1E16_QUIET_SECS consecutive seconds,
      # giving up only after LL1E16_WAIT_SECS. Sized INSIDE the workflow's 1200 s ssh bound:
      # 480 s of waiting still leaves ~720 s for measure + apply (itself bounded at 600 s) + E16.
      # OWNER-REQUIRED FLEET-WIDE SETTLE GATE — checked BEFORE the local one, and it is a hard gate.
      # The owner's words: "before ANY prod one-shot, re-read the deploy view and require
      # shaEvidence.settled — never run the LL-1 measure or the E16 dry run mid-wave (a reading
      # taken against a half-deployed fleet is not a measurement)."
      # The box cannot read that itself (no GitHub token), so the workflow's settle probe computes
      # it from deploy runs on main and passes LL1E16_SETTLED=1|0. Absent/unset = 0 = CLOSED, so a
      # non-ec2-ops caller (a bare shell on the box) can never run these one-shots mid-wave.
      # FAIL-CLOSED and pinned by playbook-ll1e16.test.sh cases I/J.
      LL1E16_SETTLED="${LL1E16_SETTLED:-0}"
      if [ "$LL1E16_SETTLED" != "1" ]; then
        echo "  DEFERRED: LL1E16_SETTLED='$LL1E16_SETTLED' — the fleet is NOT settled (a deploy wave is in flight)."
        echo "  DEFERRED: owner rule — a reading taken against a half-deployed fleet is not a measurement."
        echo "  DEFERRED: marker NOT consumed; re-fire when the deploy view reports shaEvidence.settled."
        LL1E16_GO=0
      else
        echo "  SETTLED: fleet deploy-settle probe reports no in-flight deploy runs on main"
      fi
      LL1E16_WAIT_SECS="${LL1E16_WAIT_SECS:-480}"
      LL1E16_QUIET_SECS="${LL1E16_QUIET_SECS:-45}"
      ll1e16_deploy_running() {
        pgrep -f deploy-blue-green.sh >/dev/null 2>&1 || pgrep -f deploy-coding-worker.sh >/dev/null 2>&1
      }
      # GATED ON LL1E16_GO: the settle gate above is authoritative and already closed the block,
      # so waiting here only burns up to LL1E16_WAIT_SECS of the ssh step's 1200 s for a run that
      # cannot proceed (and would print a MISLEADING "no quiet window" deferral on top of the real
      # reason). Skip the poll entirely when the gate is shut; the local check stays for the case
      # where the fleet is settled but THIS host is mid-swap.
      if [ "$LL1E16_GO" = "1" ] && ll1e16_deploy_running; then
        echo "  WAITING: a deploy script is running — a reading taken mid-wave is not a measurement"
        echo "  WAITING: polling up to ${LL1E16_WAIT_SECS}s for a ${LL1E16_QUIET_SECS}s quiet window"
        LL1E16_QUIET=0
        LL1E16_ELAPSED=0
        while [ "$LL1E16_ELAPSED" -lt "$LL1E16_WAIT_SECS" ]; do
          sleep 15
          LL1E16_ELAPSED=$((LL1E16_ELAPSED + 15))
          if ll1e16_deploy_running; then
            LL1E16_QUIET=0
          else
            LL1E16_QUIET=$((LL1E16_QUIET + 15))
            if [ "$LL1E16_QUIET" -ge "$LL1E16_QUIET_SECS" ]; then
              echo "  WINDOW OPEN after ${LL1E16_ELAPSED}s (quiet ${LL1E16_QUIET}s)"
              break
            fi
          fi
        done
        if [ "$LL1E16_QUIET" -lt "$LL1E16_QUIET_SECS" ]; then
          echo "  DEFERRED: no ${LL1E16_QUIET_SECS}s quiet window within ${LL1E16_WAIT_SECS}s"
          LL1E16_GO=0
        fi
      fi
      for LL1E16_F in prodq.sh ll1-activities-index.js session-topology-migrate.js; do
        [ -f "$LL1E16_DIR/$LL1E16_F" ] || { echo "  DEFERRED: missing $LL1E16_DIR/$LL1E16_F (deploy rsync has not delivered it yet)"; LL1E16_GO=0; }
      done
      [ "$LL1E16_GO" = "1" ] || echo "  DEFERRED: marker NOT consumed; re-fires on the next ec2-ops push after a deploy lands"

      LL1E16_LL1=failed     # present | built | failed
      LL1E16_E16=failed     # ok | failed
      if [ "$LL1E16_GO" = "1" ]; then
        # ================= 1/3  LL-1 MEASURE (read-only) =================
        echo "  -- LL-1 step 1/3: MEASURE (read-only, writes nothing) --"
        LL1E16_M=$(timeout 300 bash "$LL1E16_DIR/prodq.sh" ll1-activities-index.js 2>&1); LL1E16_MRC=$?
        echo "$LL1E16_M" | tr -d '\r' | head -c 1600 | sed 's/^/  LL1-MEASURE| /'
        echo ""
        echo "  LL1_MEASURE_RC=$LL1E16_MRC"
        # A measurement needs the report BODY. A bare "no admin-backend container is running" must
        # never be read as "index absent" — that would fire a build off a non-reading.
        #
        # rc ALONE CANNOT CLASSIFY: the script exits rc=1 on a REFUSAL (an INVALID index left by a
        # failed concurrent build) while still printing a full report carrying the exact
        # DROP INDEX CONCURRENTLY the operator needs. Gating the body on rc==0 threw that report
        # away and relabelled a precise refusal as an unexplained "MEASURE FAILED" (sandbox case C).
        LL1E16_ABSENT=0
        if printf '%s' "$LL1E16_M" | grep -qE '"table" *: *"activities"'; then
          if printf '%s' "$LL1E16_M" | grep -q 'invalid_index_present'; then
            echo "  LL1_TARGET=invalid-present (a FAILED concurrent build left an INVALID index)"
            echo "  LL-1 REFUSED BY DESIGN — the planner ignores an INVALID index, and it blocks a rebuild."
            echo "  OPERATOR NEXT STEP (NOT automated here — a DROP is not part of the owner's go):"
            # The probe emits JSON-ESCAPED SQL: "dropCommand":"DROP INDEX CONCURRENTLY IF EXISTS \"…\";"
          # A char class excluding `"` and `\` stops dead at the first backslash and prints NOTHING —
          # the operator's next step would be blank on the one path that needs it (found by review;
          # reproduced). Unescape first, then match up to the first `;`.
          printf '%s' "$LL1E16_M" | sed 's/\\"/"/g' | grep -oE 'DROP INDEX CONCURRENTLY[^;]*;' | head -1 | sed 's/^/    /'
            LL1E16_LL1=failed
          elif printf '%s' "$LL1E16_M" | grep -qE '"existing" *: *null'; then
            echo "  LL1_TARGET=absent (build needed)"
            LL1E16_ABSENT=1
          else
            echo "  LL1_TARGET=present (already indexed — apply is a no-op)"
            LL1E16_LL1=present
          fi
          [ "$LL1E16_MRC" = "0" ] || echo "  (measure exited rc=$LL1E16_MRC — classified from the report body above)"
        else
          echo "  LL-1 MEASURE FAILED (rc=$LL1E16_MRC, no report body) — no build attempted"
          LL1E16_LL1=failed
        fi

        # ================= 2/3  LL-1 APPLY (only when ABSENT) =================
        if [ "$LL1E16_ABSENT" = "1" ]; then
          echo "  -- LL-1 step 2/3: APPLY — CREATE INDEX CONCURRENTLY (owner go oq_8aef3962) --"
          # Bounded at 600 s inside a 1200 s ssh step. The build CONTINUES server-side in Postgres if
          # this client gives up (the script's own documented semantics) — so a timeout is neither a
          # failure nor a licence to consume the marker: the next fire re-measures the true state.
          LL1E16_A=$(timeout 600 bash "$LL1E16_DIR/prodq.sh" ll1-activities-index.js --apply 2>&1); LL1E16_ARC=$?
          echo "$LL1E16_A" | tr -d '\r' | head -c 1600 | sed 's/^/  LL1-APPLY| /'
          echo ""
          echo "  LL1_APPLY_RC=$LL1E16_ARC"
          if [ "$LL1E16_ARC" = "0" ] && printf '%s' "$LL1E16_A" | grep -qE '"built" *: *true|already_present'; then
            EV=$(printf '%s' "$LL1E16_A" | grep -oE '"elapsedMs" *: *[0-9]+' | head -1)
            echo "  LL-1: index present and VALID — build CONFIRMED ${EV:+($EV)}"
            LL1E16_LL1=built
          elif [ "$LL1E16_ARC" = "124" ]; then
            echo "  LL-1: client timed out at 600 s — build CONTINUES server-side; next fire re-measures"
          else
            echo "  LL-1: apply did not confirm (rc=$LL1E16_ARC) — see the tail above; next fire re-fires"
          fi
        elif [ "$LL1E16_LL1" = "present" ]; then
          echo "  -- LL-1 step 2/3: APPLY SKIPPED — the measure reports the index ALREADY PRESENT (no-op) --"
        fi

        # ================= 3/3  E16 DRY RUN (read-only) =================
        # Runs even when LL-1 failed: it is read-only and independent (see the header note).
        echo "  -- E16 step 3/3: session-topology migration DRY RUN (writes nothing) --"
        LL1E16_E=$(timeout 300 bash "$LL1E16_DIR/prodq.sh" session-topology-migrate.js 2>&1); LL1E16_ERC=$?
        echo "$LL1E16_E" | tr -d '\r' | head -c 4000 | sed 's/^/  E16-DRYRUN| /'
        echo ""
        echo "  E16_DRYRUN_RC=$LL1E16_ERC"
        # PRETTY-printed upstream → allow the space after the colon.
        if [ "$LL1E16_ERC" = "0" ] && printf '%s' "$LL1E16_E" | grep -qE '"dryRun" *: *true'; then
          echo "  E16: dry-run report captured (dryRun:true; writes nothing)"
          LL1E16_E16=ok
          # Guard against a future edit that prints apply counters on a non-apply run.
          if printf '%s' "$LL1E16_E" | grep -qE '"(updated|pinned|stamped|reportsWritten)" *:'; then
            echo "  WARNING: report carries apply counters on a dry run — inspect the JSON above before trusting it"
          fi
          LANES=$(printf '%s' "$LL1E16_E" | grep -oE '"lanes" *: *[0-9]+' | head -1)
          WU=$(printf '%s' "$LL1E16_E" | grep -oE '"wouldUpdate" *: *[0-9]+' | head -1)
          echo "  E16_SUMMARY ${LANES:-lanes=?} ${WU:-wouldUpdate=?}"
        else
          echo "  E16: dry run produced no report (rc=$LL1E16_ERC) — next fire re-fires"
        fi
      fi

      echo "  LL1_FINAL=$LL1E16_LL1  E16_FINAL=$LL1E16_E16"
      case "$LL1E16_LL1" in present|built) LL1E16_LL1_OK=1 ;; *) LL1E16_LL1_OK=0 ;; esac
      [ "$LL1E16_E16" = "ok" ] && LL1E16_E16_OK=1 || LL1E16_E16_OK=0
      if [ "$LL1E16_LL1_OK" = "1" ] && [ "$LL1E16_E16_OK" = "1" ]; then
        echo "  VERDICT: LL-1 ($LL1E16_LL1) + E16 dry run OK — marker consumed"
        sudo touch "$MARKER_LL1E16"
      else
        echo "  VERDICT: INCOMPLETE (LL-1=$LL1E16_LL1 E16=$LL1E16_E16) — marker NOT consumed; re-fires on the next ec2-ops push"
      fi
      echo "== END LL1E16-1103 =="
    fi
  # ==ONE-SHOT-INSERT-POINT-PROD== (insert prod one-shots ABOVE this line)
  # Section sentinel (ticket 795cc5fb): the workflow greps the run log for this
  # exact line — if any block above silently never executed, this line is missing
  # and the run FAILS loudly instead of reporting a false "ran clean".
  echo "=== playbook prod-section done (ROLE=$ROLE host=$(hostname)) ==="
fi

# ── Box B role (second web box, ROLE=prod-b): STRICTLY read-only diagnostics ──
# DG1027F211F-BOXB (2026-10-28, coding; FS steer 02:34Z approved the direct read).
# The EC2_HOSTS secret lists A first, B second; only the FIRST host is the
# ec2-ops "prod" target, so B never ran a role until now. This is a MINIMAL role:
# no staging, no file writes, no docker create/run — only grep / docker exec
# env prints / cat (B's force-on keys ride the deploy.yml fleet .env template and
# fold per deploy wave; this names what each surface on B actually holds NOW —
# the per-box fact box B previously had only via the per-wave CI key check).
if [ "$ROLE" = "prod-b" ]; then
  cd /opt/crossmodel 2>/dev/null || echo "repo missing on B (paths skipped)"
  echo "== DG1027F211F-BOXB host=$(hostname) now=$(date -u +%FT%TZ) =="
  for K in DECISION_GATE_ADMISSION_DISABLED SUPERVISOR_MATERIAL_GATE_DISABLED; do
    echo "  [$K] overrides: $(sudo grep -h "^$K=" /opt/crossmodel-local/env-overrides.env 2>/dev/null || echo '<absent>') | folded .env: $(sudo grep -h "^$K=" /opt/crossmodel/.env 2>/dev/null || echo '<absent>')"
  done
  TPL=$(sudo grep -nE '^(DECISION_GATE_ADMISSION_DISABLED|SUPERVISOR_MATERIAL_GATE_DISABLED)=' /opt/crossmodel/.github/workflows/deploy.yml 2>/dev/null || true)
  if [ -n "$TPL" ]; then printf '%s\n' "$TPL" | sed 's/^/    template: /'; else echo "    <template lines absent>"; fi
  BE=$(sudo docker ps --format '{{.Names}}' | grep -m1 -E 'admin-backend-(blue|green)') || true
  WK=$(sudo docker ps --format '{{.Names}}' | grep -m1 -E '^admin-worker') || true
  echo "  containers: backend=${BE:-<none>} worker=${WK:-<none>}"
  if [ -n "$BE" ]; then
    sudo docker exec "$BE" sh -c 'echo "  serving backend env: DECISION_GATE_ADMISSION_DISABLED=${DECISION_GATE_ADMISSION_DISABLED:-<unset>} SUPERVISOR_MATERIAL_GATE_DISABLED=${SUPERVISOR_MATERIAL_GATE_DISABLED:-<unset>}"'
  else echo "  (no backend container found — serving env skipped)"; fi
  if [ -n "$WK" ]; then
    sudo docker exec "$WK" sh -c 'echo "  worker env: DECISION_GATE_ADMISSION_DISABLED=${DECISION_GATE_ADMISSION_DISABLED:-<unset>} SUPERVISOR_MATERIAL_GATE_DISABLED=${SUPERVISOR_MATERIAL_GATE_DISABLED:-<unset>}"'
  else echo "  (no worker container found — worker env skipped)"; fi
  echo "== END DG1027F211F-BOXB =="
  # ── ONE-SHOT (2026-10-28, prod-b): FB4A18B0-BOXB — FIX_STATE_EVIDENCE_REPO_ALLOWLIST per-PROCESS proof ──
  # Same proof as the prod role's FB4A18B0, STRICTLY read-only (grep / docker
  # exec env prints — no staging, no writes, per this role's contract): the
  # allowlist itself reaches B via the fleet .env template (B is in EC2_HOSTS).
  echo "== FB4A18B0-BOXB host=$(hostname) now=$(date -u +%FT%TZ) =="
  KB=FIX_STATE_EVIDENCE_REPO_ALLOWLIST
  WANTB=example-org/crossmodel,example-org/optcg
  echo "  folded .env: $(sudo grep -h "^$KB=" /opt/crossmodel/.env 2>/dev/null || echo '<absent>')"
  FAILB=0
  for CNAME in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-(backend|worker)-(blue|green)$'); do
    GOTB=$(sudo docker exec "$CNAME" sh -c "printf %s \"\$$KB\"" 2>/dev/null)
    echo "  FIX_STATE_PROCESS=($CNAME) $KB=$GOTB"
    [ "$GOTB" = "$WANTB" ] || FAILB=1
  done
  if [ "$FAILB" = "0" ]; then
    echo "  VERDICT: allowlist LIVE in-process on B (backend+worker)"
  else
    echo "  VERDICT: value NOT live in-process on every B container (recreate had not landed yet) — re-proofs on the next dispatch"
  fi
  echo "== END FB4A18B0-BOXB =="
  echo "=== playbook prod-b-section done (ROLE=$ROLE host=$(hostname)) ==="
fi

# ── Coding box C role (2026-08-26 scale-out; idempotent base prep) ──
if [ "$ROLE" = "coding-c" ]; then
  echo "== CODING-C $(hostname) =="
  command -v docker >/dev/null 2>&1 && sudo docker version --format 'docker {{.Server.Version}}' || echo "docker NOT READY"
  sudo docker volume create crossmodel_coding_workspaces >/dev/null 2>&1 || true
  sudo mkdir -p /opt/crossmodel /opt/crossmodel-local

  # ── ONE-SHOT (2026-09-02vc, coding-c): verify C worker picked up 32/3 + new limits (read-only). ──
  MARKER_VC0902=/var/tmp/.digby-vc0902
  if [ ! -f "$MARKER_VC0902" ]; then
    echo "== VC0902-C host=$(hostname) =="
    W=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    echo "worker=$W ($(sudo docker ps --format '{{.Names}} {{.Status}}' | grep -m1 '^admin-worker'))"
    [ -n "$W" ] && sudo docker exec "$W" sh -c 'echo "CONCURRENCY=${CODING_WORKER_CONCURRENCY:-unset} VERIFY_GATE=${VERIFY_GATE_CONCURRENCY:-unset}"; node -e "console.log(String(process.env.NODE_OPTIONS))"'
    [ -n "$W" ] && sudo docker inspect "$W" --format 'mem_limit={{.HostConfig.Memory}}'
    echo "== END VC0902-C =="
    sudo touch "$MARKER_VC0902"
  fi


  # ── ONE-SHOT (2026-09-02cc, coding-c): throughput env raises on C ONLY —
  # VERIFY_GATE_CONCURRENCY=3 + CODING_WORKER_CONCURRENCY=32 (owner-ordered cap
  # review; pairs with the 6g-heap/8g-mem worker bump in docker-compose.app.yml).
  # Update-in-place (W24-6F idiom); applies on the next deploy's worker handoff.
  # NOTE: the workflow env_override input targets box A only — that channel was
  # WRONGLY used for these first (A corrected back to CONCURRENCY=0 same hour).
  MARKER_CC0902=/var/tmp/.digby-cc0902-throughput
  if [ ! -f "$MARKER_CC0902" ]; then
    echo "== CC0902 host=$(hostname) =="
    F=/opt/crossmodel-local/env-overrides.env
    sudo touch "$F"
    for KV in "VERIFY_GATE_CONCURRENCY=3" "CODING_WORKER_CONCURRENCY=32"; do
      K="${KV%%=*}"
      if sudo grep -q "^$K=" "$F"; then sudo sed -i "s|^$K=.*|$KV|" "$F"; else echo "$KV" | sudo tee -a "$F" >/dev/null; fi
      echo "  staged $KV"
    done
    echo "== END CC0902 =="
    sudo touch "$MARKER_CC0902"
  fi

  # ── ONE-SHOT (2026-11-04saa16-arm, coding-c): ARM the SAA-1.6 async-tool
  # switch ON THE CODING PLANE ONLY — todo e49dfd07, goal d605db05.
  #
  # WHY THIS BLOCK EXISTS. `ASYNC_TOOL_CALLS_DISABLED` is a TRI-STATE release
  # switch (platform/async-tool-calls.ts asyncToolCallsMode) and its default —
  # unset, '', '0' or any junk — is 'observe': the shadow mode that records an
  # `async_tool_calls_observe` row and hands NOTHING off. In 'observe',
  # `planAsyncToolCall` returns applied:false, so a call still running at the
  # 60 s threshold CANNOT return "Started" and no `async_tool_calls_deliver` row
  # can exist. The Phase-3b gate is therefore UNREACHABLE until the switch
  # reads 'apply' ("apply"/"rewrite" are the only values that arm it). Measured
  # on the fleet 2026-11-04T09:22Z: every row was mode:'observe'. This is the
  # arming step that makes the gate observable instead of asserted from the
  # 30 unit tests alone.
  #
  # SCOPE — box C alone, deliberately: C is the coding plane (workspace volume,
  # docker-proxy, worker @ 32 slots) where coding runs and their tool calls
  # execute; A and B are the web tier and hold no Docker daemon by design. So
  # arming here changes the CODING loop and leaves chat on digby.ai untouched.
  #
  # APPLIES ON THE NEXT WORKER HANDOFF, not instantly: the key is staged in the
  # box-local overrides file, which deploy-coding-worker.sh folds into .env via
  # apply-env-overrides.sh and then force-recreates the worker with (a changed
  # overrides hash flips the rebuild-input stamp). The block also prints the
  # LIVE worker's value, so the run log itself says whether a fold is pending.
  #
  # REVERSIBLE BY DESIGN: the switch's own kill switch still wins —
  # ASYNC_TOOL_CALLS_DISABLED=1 restores today's fully-blocking behaviour with no
  # code change. To remove the arm, delete the line from BOTH the overrides file
  # AND the folded /opt/crossmodel/.env (the 2026-10-14b38-disarm block above is
  # the two-file idiom: apply-env-overrides.sh MERGES and never removes, so
  # cleaning only the overrides leaves a stale =apply arming every future
  # recreate). Release expiry is registered: 2026-11-25.
  MARKER_SAA16ARM=/var/tmp/.digby-saa16-arm
  if [ ! -f "$MARKER_SAA16ARM" ]; then
    echo "== SAA16-ARM host=$(hostname) now=$(date -u +%FT%TZ) =="
    # OWNER RULE (fleet-wide, standing): "before ANY prod one-shot, re-read the deploy
    # view and require shaEvidence.settled — never run mid-wave". The box cannot read
    # that itself (no GitHub token); the workflow's settle probe computes it from deploy
    # runs on main and passes LL1E16_SETTLED=1|0. Unset = 0 = CLOSED, so a bare shell on
    # the box can never arm a switch mid-wave. Deferring does NOT consume the marker.
    if [ "${LL1E16_SETTLED:-0}" != "1" ]; then
      echo "  DEFERRED: LL1E16_SETTLED='${LL1E16_SETTLED:-0}' — the fleet is NOT settled."
      echo "  DEFERRED: owner rule — a switch staged against a half-deployed fleet is not a measurement."
      echo "  DEFERRED: marker NOT consumed. Re-fire via workflow_dispatch on ec2-ops.yml once"
      echo "  DEFERRED: the deploy view reports shaEvidence.settled (no in-flight deploy runs on main)."
    else
      echo "  SETTLED: deploy view reports no in-flight deploy runs on main"
      F=/opt/crossmodel-local/env-overrides.env
      sudo touch "$F"
      KV="ASYNC_TOOL_CALLS_DISABLED=apply"
      K="${KV%%=*}"
      if sudo grep -q "^$K=" "$F"; then
        sudo sed -i "s|^$K=.*|$KV|" "$F"
      else
        echo "$KV" | sudo tee -a "$F" >/dev/null
      fi
      echo "  staged $KV"
      echo "  overrides : $(sudo grep -h '^ASYNC_TOOL_CALLS_DISABLED=' "$F" 2>/dev/null || echo '<absent>')"
      echo "  folded    : $(sudo grep -h '^ASYNC_TOOL_CALLS_DISABLED=' /opt/crossmodel/.env 2>/dev/null || echo '<absent>')"
      for CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker' || true); do
        echo "  live $CN: $(sudo docker exec "$CN" sh -c 'echo "ASYNC_TOOL_CALLS_DISABLED=${ASYNC_TOOL_CALLS_DISABLED:-<unset>}"' 2>/dev/null)"
      done
      echo "  NOTE: '<unset>' in the live worker = the fold is still PENDING; the next deploy wave recreates it armed."
      sudo touch "$MARKER_SAA16ARM"
    fi
    echo "== END SAA16-ARM =="
  fi
  # ── /SAA16-ARM ──


  # ── ONE-SHOT (2026-10-14b38-disarm, coding-c): DISARM the infra_action
  # lever on C — ticket b38f1d8a step 4, AFTER the gated reap verified zero
  # strays. Removes the staged INFRA_ACTIONS_ENABLED from BOTH files:
  #   (1) /opt/crossmodel-local/env-overrides.env (the staging channel), and
  #   (2) /opt/crossmodel/.env — the FOLDED file compose actually reads.
  # (2) is the gotcha: apply-env-overrides.sh MERGES (sed-replace or append);
  # it never REMOVES a key that left the overrides file, so cleaning only the
  # overrides would leave the stale =1 in .env arming every future worker
  # recreate. The compose pass-through STAYS (empty ${VAR:-} is unarmed — the
  # gate is process.env.INFRA_ACTIONS_ENABLED === '1', never truthiness).
  # Applies on the next deploy wave's worker handoff: the changed
  # env-overrides hash flips the rebuild-input stamp and the recreated worker
  # comes up with the var unset. Re-arming stays a documented manual op (see
  # the CHANNEL note in .env.example) — the ARM one-shot that staged the value
  # (14:35:37Z, ec2-ops run 38579621060) is DELETED here, not left behind as
  # marker-guarded dead code.
  MARKER_B38DISARM=/var/tmp/.digby-b38f1d8a-disarm
  if [ ! -f "$MARKER_B38DISARM" ]; then
    echo "== B38-DISARM host=$(hostname) =="
    F=/opt/crossmodel-local/env-overrides.env
    if [ -f "$F" ] && sudo grep -q '^INFRA_ACTIONS_ENABLED=' "$F"; then
      sudo sed -i '/^INFRA_ACTIONS_ENABLED=/d' "$F"
      echo "  removed INFRA_ACTIONS_ENABLED from $F"
    else
      echo "  $F already clean (no INFRA_ACTIONS_ENABLED staged)"
    fi
    E=/opt/crossmodel/.env
    if [ -f "$E" ] && sudo grep -q '^INFRA_ACTIONS_ENABLED=' "$E"; then
      sudo sed -i '/^INFRA_ACTIONS_ENABLED=/d' "$E"
      echo "  removed stale folded INFRA_ACTIONS_ENABLED from $E"
    else
      echo "  $E already clean (nothing folded)"
    fi
    echo "== END B38-DISARM =="
    sudo touch "$MARKER_B38DISARM"
  fi

  # ── ONE-SHOT (2026-10-28, coding): DG1027F211F-BOXC — box C force-on key read-back (FS task f64b7c1e ASK 1, per-box naming) ──
  # Box C is NOT in the deploy .env template (web-only per its comment) and folds from
  # /opt/crossmodel-local/env-overrides.env (staged 19:38Z by DG1027F211DC). This names
  # the key state ON BOX C from both files + the running worker container env — the
  # per-box fact the FS ask required (read-only; no file writes).
  MARKER_DG1027FC=/var/tmp/.digby-dg1027f211f-boxc
  if [ ! -f "$MARKER_DG1027FC" ]; then
    echo "== DG1027F211F-BOXC host=$(hostname) now=$(date -u +%FT%TZ) =="
    for K in DECISION_GATE_ADMISSION_DISABLED SUPERVISOR_MATERIAL_GATE_DISABLED; do
      echo "  [$K] overrides: $(sudo grep -h "^$K=" /opt/crossmodel-local/env-overrides.env 2>/dev/null || echo '<absent>') | folded .env: $(sudo grep -h "^$K=" /opt/crossmodel/.env 2>/dev/null || echo '<absent>')"
    done
    WK=$(sudo docker ps --format '{{.Names}}' | grep -m1 -E '^admin-worker') || true
    if [ -n "$WK" ]; then
      sudo docker exec "$WK" sh -c 'echo "  worker env: DECISION_GATE_ADMISSION_DISABLED=${DECISION_GATE_ADMISSION_DISABLED:-<unset>} SUPERVISOR_MATERIAL_GATE_DISABLED=${SUPERVISOR_MATERIAL_GATE_DISABLED:-<unset>}"'
    else echo "  (no worker container found — skipped)"; fi
    echo "== END DG1027F211F-BOXC =="
    sudo touch "$MARKER_DG1027FC"
  fi

  MK="ssh-\1 EXAMPLEKEYMATERIALREDACTED ubuntu@ip-10-0-0-11"
  grep -qF "$MK" /home/ubuntu/.ssh/authorized_keys || echo "$MK" | sudo tee -a /home/ubuntu/.ssh/authorized_keys >/dev/null
  echo "prep ok (volume, dirs, migrate key)"
  # du over the workspaces volume is bounded (2026-09-25: an unbounded walk held the coding-c step >25 min).
  # timeout runs INSIDE sudo (2026-10-20): `timeout 60 sudo du` never fired on box C — sudo (likely use_pty) did not
  # relay timeout's SIGTERM to du, so the walk ran to completion (14 min on ops run 419, past the 1200 s step
  # limit on run 421, which skipped every coding-c one-shot below). As du's direct parent, timeout kills it.
  echo "disk: $(df -h / | tail -1 | awk '{print $5}') used  vol: $( (sudo timeout -k 5 60 du -sh /var/lib/docker/volumes/crossmodel_coding_workspaces/_data 2>/dev/null || echo 'du>60s') | cut -f1)"
  echo "== END CODING-C =="

  # ── ONE-SHOT (2026-08-27p, coding-c): pass-6 routine sweep. ──
  MARKER_W246=/var/tmp/.digby-w246-20270827p
  if [ ! -f "$MARKER_W246" ]; then
    echo "== W24-6 host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -8; }
    echo "--- 2h run counts ---"; q "SELECT status||': '||count(*) FROM agent_runs WHERE \"createdAt\" > now() - interval '2 hours' GROUP BY status"
    echo "--- queued age ---"; q "SELECT count(*)||' queued, oldest '||coalesce(extract(epoch from (now()-min(\"createdAt\")))::int::text,'-')||'s' FROM agent_runs WHERE status='queued'"
    echo "--- failed 2h ---"; q "SELECT to_char(\"createdAt\",'HH24:MI')||' '||left(coalesce(error,'-'),80) FROM agent_runs WHERE status='failed' AND \"createdAt\" > now() - interval '2 hours' ORDER BY \"createdAt\" DESC LIMIT 4"
    echo "--- NE latest ---"; q "SELECT to_char(\"createdAt\",'HH24:MI')||' | '||left(replace(content,chr(10),' '),150) FROM crossmodel_messages WHERE \"chatId\"='b92ef13f-c3f8-487e-8267-767e56543150' AND role='assistant' ORDER BY \"createdAt\" DESC LIMIT 1"
    echo "--- tickets ---"; q "SELECT status||': '||count(*) FROM user_feature_requests WHERE status IN ('open','in_progress') GROUP BY status"
    echo "mem: $(free -h | awk '/^Mem:/{print $7}')  load: $(cut -d' ' -f1-3 /proc/loadavg)  disk: $(df -h / | awk 'NR==2{print $5}')"
    echo "== END W24-6 =="
    sudo touch "$MARKER_W246"
  fi

  # ── ONE-SHOT (2026-08-27q, coding-c): open-ticket detail. ──
  MARKER_W246B=/var/tmp/.digby-w246b-20270827q
  if [ ! -f "$MARKER_W246B" ]; then
    echo "== W24-6B host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -10; }
    echo "--- open ticket detail ---"
    q "SELECT left(id::text,8)||' | '||to_char(\"createdAt\",'MM-DD HH24:MI')||' | '||coalesce(priority,'-')||' | '||left(replace(title,chr(10),' '),90) FROM user_feature_requests WHERE status='open' ORDER BY \"createdAt\" DESC LIMIT 8"
    echo "--- ticket 0dfcc189 ---"
    q "SELECT status||' | '||to_char(\"updatedAt\",'MM-DD HH24:MI')||' | '||left(replace(coalesce(\"resolutionNote\",title),chr(10),' '),120) FROM user_feature_requests WHERE id::text LIKE '0dfcc189%'"
    echo "--- recent dispatch notes ---"
    q "SELECT left(id::text,8)||' | '||status||' | '||to_char(\"updatedAt\",'HH24:MI') FROM user_feature_requests WHERE \"updatedAt\" > now() - interval '3 hours' ORDER BY \"updatedAt\" DESC LIMIT 8"
    echo "== END W24-6B =="
    sudo touch "$MARKER_W246B"
  fi

  # ── ONE-SHOT (2026-08-27r, coding-c): ticket-dispatch wedge check. ──
  MARKER_W246C=/var/tmp/.digby-w246c-20270827r
  if [ ! -f "$MARKER_W246C" ]; then
    echo "== W24-6C host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -10; }
    echo "--- open tickets ---"
    q "SELECT left(id::text,8)||' | '||to_char(\"createdAt\",'MM-DD HH24:MI')||' | p'||priority::text||' | ad='||coalesce(context->>'autoDispatch','?')||' | '||left(replace(title,chr(10),' '),80) FROM user_feature_requests WHERE status='open' ORDER BY \"createdAt\" DESC LIMIT 8"
    echo "--- redis claims ---"
    for TID in $(sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "SELECT id FROM user_feature_requests WHERE status='open'" 2>/dev/null); do
      CLAIM=$(sudo docker run --rm redis:7-alpine redis-cli -h 10.0.0.11 -p 7856 EXISTS "ticket-dispatch:$TID" 2>&1)
      echo "${TID:0:8} claim=$CLAIM"
    done
    echo "--- daily cap counter ---"
    sudo docker run --rm redis:7-alpine redis-cli -h 10.0.0.11 -p 7856 GET "ticket-dispatch:daily:$(date -u +%F)" 2>&1
    echo "--- worker drain logs ---"
    sudo docker logs admin-worker-green --since 3h 2>&1 | grep -i 'ticket-dispatch\|ticket-drain' | tail -6
    echo "== END W24-6C =="
    sudo touch "$MARKER_W246C"
  fi

  # ── ONE-SHOT (2026-08-27s, coding-c): cron lease + drain failure forensics. ──
  MARKER_W246D=/var/tmp/.digby-w246d-20270827s
  if [ ! -f "$MARKER_W246D" ]; then
    echo "== W24-6D host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -14; }
    echo "--- cron_jobs state ---"
    q "SELECT id||' | next='||to_char(\"nextRunAt\",'HH24:MI')||' | last='||coalesce(to_char(\"lastFiredAt\",'HH24:MI'),'-')||' | st='||coalesce(\"lastStatus\",'-')||' | by='||coalesce(right(\"workerId\",12),'-') FROM cron_jobs ORDER BY id"
    echo "--- C worker cron lines (2h tail) ---"
    sudo docker logs admin-worker-green --since 2h 2>&1 | grep 'cron loop' | tail -6
    echo "--- C worker warn/error (2h) ---"
    sudo docker logs admin-worker-green --since 2h 2>&1 | grep -iE 'warn|error' | grep -vi 'deprecat' | tail -8
    echo "== END W24-6D =="
    sudo touch "$MARKER_W246D"
  fi

  # ── ONE-SHOT (2026-08-27u, coding-c): open tickets origin-session check. ──
  MARKER_W246G=/var/tmp/.digby-w246g-20270827u
  if [ ! -f "$MARKER_W246G" ]; then
    echo "== W24-6G host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "SELECT left(id::text,8)||' | src='||source||' | origin='||left(coalesce(context->>'codingSessionId', context->>'chatId', context->>'sessionId','-'),8) FROM user_feature_requests WHERE status='open' ORDER BY \"createdAt\" DESC" 2>&1 | head -10
    echo "== END W24-6G =="
    sudo touch "$MARKER_W246G"
  fi

  # ── ONE-SHOT (2026-08-27v, coding-c): #409 drain verify (read-only). ──
  MARKER_W247=/var/tmp/.digby-w247-20270827v
  if [ ! -f "$MARKER_W247" ]; then
    echo "== W24-7 host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -10; }
    echo "--- ticket statuses (the 6) ---"
    q "SELECT left(id::text,8)||' | '||status||' | upd='||to_char(\"updatedAt\",'HH24:MI') FROM user_feature_requests WHERE left(id::text,8) IN ('e65061e1','c8664ff9','8292830e','a2325600','9975b1f2','4ed6eb2e')"
    echo "--- drain log lines (2h, this box) ---"
    sudo docker logs admin-worker-green --since 2h 2>&1 | grep -iE 'ticket-dispatch|ticket-drain' | tail -6
    echo "--- ticket batch sessions ---"
    q "SELECT left(id::text,8)||' | '||status||' | '||to_char(\"createdAt\",'HH24:MI')||' | '||left(coalesce(title,'-'),40) FROM chat_coding_state WHERE title LIKE 'Ticket batch%' AND \"createdAt\" > now() - interval '3 hours' ORDER BY \"createdAt\" DESC LIMIT 4"
    echo "--- digby-mcp-prod inspect ---"
    sudo docker inspect digby-mcp-prod --format 'img={{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}}' 2>&1 | head -2
    echo "--- C code currency ---"
    grep -c 'trySpawnBatchSession' /opt/crossmodel/backend/src/modules/crossmodel/feedback/ticket-dispatch.service.ts 2>/dev/null || echo "drain fix NOT in C copy"
    echo "mem: $(free -h | awk '/^Mem:/{print $7}')  load: $(cut -d' ' -f1-3 /proc/loadavg)  disk: $(df -h / | awk 'NR==2{print $5}')"
    echo "== END W24-7 =="
    sudo touch "$MARKER_W247"
  fi

  # ── ONE-SHOT (2026-08-27aa, coding-c): migration close-out cleanup on C.
  # OWNER-AUTHORIZED 2026-08-27 ("go ahead with the container cleanup"): C runs
  # ONLY the coding plane (worker + docker-proxy + session/dev containers).
  # The local postgres/redis/adminer/MCP/gateway containers are compose-base
  # leftovers from the migration build — nothing points at them (worker env:
  # REDIS_URL -> box A 10.0.0.11:7856, DATABASE_URL -> RDS; sessions reach
  # MCP via mcp.digby.ai on A). Restart policy off -> stop -> rm. No volumes,
  # no networks touched. digby-mcp-prod is inspected and left alone pending ID.
  MARKER_W24CLC=/var/tmp/.digby-w24clc-20270827aa
  if [ ! -f "$MARKER_W24CLC" ]; then
    echo "== W24-CLC host=$(hostname) =="
    echo "--- pre-check: worker env still points off-box ---"
    sudo docker exec admin-worker-green sh -c 'echo "REDIS=$REDIS_URL"; printf %s "$DATABASE_URL" | sed -E "s#(://[^:]+):[^@]+@#\\1:***@#" | head -c 60; echo' 2>&1
    echo "--- digby-mcp-prod identity (kept) ---"
    sudo docker inspect digby-mcp-prod --format 'img={{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}} started={{.State.StartedAt}}' 2>&1 | head -2
    for CN in admin-postgres-prod admin-redis-prod admin-adminer-prod google-mcp-prod github-mcp-prod x-mcp-prod slack-mcp-prod asana-mcp-prod mcp-gateway-prod; do
      if sudo docker ps -a --format '{{.Names}}' | grep -qx "$CN"; then
        sudo docker update --restart=no "$CN" >/dev/null 2>&1
        sudo docker stop -t 10 "$CN" >/dev/null 2>&1
        sudo docker rm "$CN" >/dev/null 2>&1 && echo "removed $CN"
      fi
    done
    sudo docker image prune -f 2>&1 | tail -1
    echo "--- containers after (expect worker, docker-proxy, digby-mcp-prod, digby-dev/code-*) ---"
    sudo docker ps --format '{{.Names}}' | sort | tr '\\n' ' '; echo
    echo "--- worker still healthy after cleanup ---"
    sudo docker exec admin-worker-green sh -c 'echo ok' 2>&1
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -8; }
    echo "--- final audit: runs 30m ---"; q "SELECT status||': '||count(*) FROM agent_runs WHERE \"updatedAt\" > now() - interval '30 minutes' GROUP BY status"
    echo "--- final audit: tickets ---"; q "SELECT status||': '||count(*) FROM user_feature_requests WHERE status IN ('open','in_progress') GROUP BY status"
    echo "--- final audit: e65061e1 ---"; q "SELECT status||' upd='||to_char(\"updatedAt\",'HH24:MI') FROM user_feature_requests WHERE id::text LIKE 'e65061e1%'"
    echo "--- disk ---"; df -h / | awk 'NR==2{print $3" used / "$2" ("$5")"}'
    echo "mem: $(free -h | awk '/^Mem:/{print $7}')  load: $(cut -d' ' -f1-3 /proc/loadavg)"
    echo "== END W24-CLC =="
    sudo touch "$MARKER_W24CLC"
  fi

  # ── ONE-SHOT (2026-08-27ac, coding-c): provisioning-stall diagnosis. ──
  MARKER_W2413=/var/tmp/.digby-w2413-20270827ac
  if [ ! -f "$MARKER_W2413" ]; then
    echo "== W24-13 host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -12; }
    echo "--- provisioning sessions + age ---"
    q "SELECT left(id::text,8)||' | '||status||' | age_min='||(extract(epoch from (now()-\"updatedAt\"))/60)::int FROM chat_coding_states WHERE status='provisioning' ORDER BY \"updatedAt\" ASC LIMIT 8"
    q "SELECT left(id::text,8)||' | '||status||' | age_min='||(extract(epoch from (now()-\"updatedAt\"))/60)::int FROM \"ChatCodingState\" WHERE status='provisioning' ORDER BY \"updatedAt\" ASC LIMIT 8" 2>/dev/null | grep -v ERROR || true
    echo "--- table name resolve ---"
    q "SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%coding%'"
    echo "--- worker boots today (restart count) ---"
    sudo docker logs admin-worker-green --since 24h 2>&1 | grep -c 'coding worker.*started'
    sudo docker logs admin-worker-green --since 24h 2>&1 | grep 'coding worker.*started' | tail -3
    echo "--- provisioning log lines (30m) ---"
    sudo docker logs admin-worker-green --since 30m 2>&1 | grep -iE 'provision|worktree|workspace' | tail -8
    echo "--- queued/running runs ---"
    q "SELECT status||': '||count(*) FROM agent_runs WHERE status IN ('queued','running') GROUP BY status"
    echo "--- oldest queued ---"
    q "SELECT left(\"sessionId\"::text,8)||' age_min='||(extract(epoch from (now()-\"createdAt\"))/60)::int FROM agent_runs WHERE status='queued' ORDER BY \"createdAt\" ASC LIMIT 4"
    echo "--- docker build running? ---"
    ps aux | grep -E 'docker.*build|buildkit' | grep -v grep | head -3 || echo "no build running"
    echo "load: $(cut -d' ' -f1-3 /proc/loadavg)  iowait: $(iostat -c 1 2 2>/dev/null | tail -2 | head -1 | awk '{print $4}' 2>/dev/null || echo n/a)"
    echo "== END W24-13 =="
    sudo touch "$MARKER_W2413"
  fi

  # ── ONE-SHOT (2026-08-27af, coding-c): session af773f1e stuck-provisioning check. ──
  MARKER_W2416=/var/tmp/.digby-w2416-20270827af
  if [ ! -f "$MARKER_W2416" ]; then
    echo "== W24-16 host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -12; }
    echo "--- session rows by status ---"
    q "SELECT status||': '||count(*) FROM coding_sessions GROUP BY status ORDER BY count(*) DESC"
    echo "--- af773f1e session row ---"
    q "SELECT left(id::text,8)||' | '||status||' | upd='||to_char(\"updatedAt\",'MM-DD HH24:MI') FROM coding_sessions WHERE id::text LIKE 'af773f1e%'"
    echo "--- ALL provisioning sessions + age ---"
    q "SELECT left(id::text,8)||' | age_min='||(extract(epoch from (now()-\"updatedAt\"))/60)::int||' | '||left(coalesce(title,'-'),40) FROM coding_sessions WHERE status='provisioning' ORDER BY \"updatedAt\" ASC LIMIT 10"
    echo "--- af773f1e runs (2h) ---"
    q "SELECT left(id::text,8)||' '||status||' att='||attempts||' crt='||to_char(\"createdAt\",'HH24:MI')||' upd='||to_char(\"updatedAt\",'HH24:MI') FROM agent_runs WHERE \"sessionId\"::text LIKE 'af773f1e%' ORDER BY \"createdAt\" DESC LIMIT 5"
    echo "--- af773f1e worktree on disk ---"
    ls -d /var/lib/docker/volumes/crossmodel_coding_workspaces/_data/worktrees/af773f1e-* 2>/dev/null || sudo ls -d /var/lib/docker/volumes/crossmodel_coding_workspaces/_data/worktrees/ 2>/dev/null | head -1 || echo "volume path differs"
    sudo docker exec admin-worker-green sh -c 'ls -d /app/coding-workspaces/worktrees/af773f1e-* 2>/dev/null || echo "no worktree dir in worker mount"'
    echo "--- worker log lines for af773f1e (2h) ---"
    sudo docker logs admin-worker-green --since 2h 2>&1 | grep 'af773f1e' | tail -6
    echo "== END W24-16 =="
    sudo touch "$MARKER_W2416"
  fi

  # ── ONE-SHOT (2026-08-27ag, coding-c): agent_events journaling check for resumed runs. ──
  MARKER_W2417=/var/tmp/.digby-w2417-20270827ag
  if [ ! -f "$MARKER_W2417" ]; then
    echo "== W24-17 host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -8; }
    echo "--- run 6a622374 (spark, att2 running) events ---"
    q "SELECT count(*)||' rows, max_seq='||coalesce(max(seq)::text,'-')||', latest='||coalesce(to_char(max(\"createdAt\"),'HH24:MI:SS'),'-') FROM agent_events WHERE \"runId\"::text LIKE '6a622374%'"
    q "SELECT seq||' '||type||' '||to_char(\"createdAt\",'HH24:MI:SS') FROM agent_events WHERE \"runId\"::text LIKE '6a622374%' ORDER BY seq DESC LIMIT 5"
    echo "--- run 83429e07 (GLM, completed att2) events tail ---"
    q "SELECT seq||' '||type||' '||to_char(\"createdAt\",'HH24:MI:SS') FROM agent_events WHERE \"runId\"::text LIKE '83429e07%' ORDER BY seq DESC LIMIT 4"
    echo "--- journal write errors in worker (2h) ---"
    sudo docker logs admin-worker-green --since 2h 2>&1 | grep -iE 'agent_events|journal|appendAgentEvent' | grep -iE 'fail|error' | tail -5
    echo "--- init rows for 6a622374 (generation markers) ---"
    q "SELECT seq||' '||type||' '||to_char(\"createdAt\",'HH24:MI:SS') FROM agent_events WHERE \"runId\"::text LIKE '6a622374%' AND type='init' ORDER BY seq"
    echo "== END W24-17 =="
    sudo touch "$MARKER_W2417"
  fi

  # ── ONE-SHOT (2026-08-28ac, coding-c): c9ccf88a run/event state. ──
  MARKER_W2428C=/var/tmp/.digby-w2428c-20270828ac
  if [ ! -f "$MARKER_W2428C" ]; then
    echo "== W24-28C host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -8; }
    echo "--- session row ---"
    q "SELECT left(id::text,8)||' | '||status||' | upd='||to_char(\"updatedAt\",'HH24:MI') FROM coding_sessions WHERE id::text LIKE 'c9ccf88a%'"
    echo "--- runs (6h) ---"
    q "SELECT left(id::text,8)||' '||status||' att='||attempts||' crt='||to_char(\"createdAt\",'HH24:MI')||' upd='||to_char(\"updatedAt\",'HH24:MI') FROM agent_runs WHERE \"sessionId\"::text LIKE 'c9ccf88a%' ORDER BY \"createdAt\" DESC LIMIT 4"
    echo "--- event count + latest for active run ---"
    q "SELECT count(*)||' rows, max_seq='||coalesce(max(seq)::text,'-')||', latest='||coalesce(to_char(max(\"createdAt\"),'HH24:MI:SS'),'-') FROM agent_events WHERE \"runId\" IN (SELECT id FROM agent_runs WHERE \"sessionId\"::text LIKE 'c9ccf88a%' AND status='running')"
    echo "== END W24-28C =="
    sudo touch "$MARKER_W2428C"
  fi

  # ── ONE-SHOT (2026-08-28ai, coding-c): pass-19 sweep. ──
  MARKER_W2434=/var/tmp/.digby-w2434-20270828ai
  if [ ! -f "$MARKER_W2434" ]; then
    echo "== W24-34 host=$(hostname) =="
    BE_URL=$(sudo docker exec admin-worker-green sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null)
    q() { sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" --no-psqlrc -t -A -c "$1" 2>&1 | head -8; }
    echo "--- failed runs by updatedAt (4h) ---"
    q "SELECT left(id::text,8)||' sess='||left(\"sessionId\"::text,8)||' crt='||to_char(\"createdAt\",'MM-DD HH24:MI')||' upd='||to_char(\"updatedAt\",'HH24:MI')||' | '||left(coalesce(error,'-'),60) FROM agent_runs WHERE status='failed' AND \"updatedAt\" > now() - interval '4 hours' ORDER BY \"updatedAt\" DESC LIMIT 6"
    echo "--- 4ed6eb2e ---"
    q "SELECT status||' upd='||to_char(\"updatedAt\",'HH24:MI') FROM user_feature_requests WHERE id::text LIKE '4ed6eb2e%'"
    echo "--- totals ---"; q "SELECT status||': '||count(*) FROM user_feature_requests WHERE status IN ('open','in_progress') GROUP BY status"
    echo "--- run counts 2h ---"; q "SELECT status||': '||count(*) FROM agent_runs WHERE \"updatedAt\" > now() - interval '2 hours' GROUP BY status"
    echo "--- queued age ---"; q "SELECT count(*)||' queued, oldest '||coalesce(extract(epoch from (now()-min(\"createdAt\")))::int::text,'-')||'s' FROM agent_runs WHERE status='queued'"
    echo "mem: $(free -h | awk '/^Mem:/{print $7}')  load: $(cut -d' ' -f1-3 /proc/loadavg)  disk: $(df -h / | awk 'NR==2{print $5}')"
    echo "== END W24-34 =="
    sudo touch "$MARKER_W2434"
  fi

  # ── ONE-SHOT (2026-08-29b, coding-c): box C vitals for owner readout (read-only). ──
  MARKER_FW29C=/var/tmp/.digby-fw29c-20260829b
  if [ ! -f "$MARKER_FW29C" ]; then
    echo "== FW29-C host=$(hostname) =="
    echo "--- worker ---"
    sudo docker ps --format '{{.Names}} {{.Status}}' | grep '^admin-worker' || echo "NO WORKER"
    echo "--- session containers ---"
    echo "running: $(sudo docker ps --filter 'name=digby-code' --format x | wc -l | tr -d ' ')  exited: $(sudo docker ps -a --filter 'name=digby-code' --filter 'status=exited' --format x | wc -l | tr -d ' ')"
    echo "--- vitals ---"
    echo "disk: $(df -h / | awk 'NR==2{print $3" / "$2" ("$5")"}')  mem-avail: $(free -h | awk '/^Mem:/{print $7}')  load: $(cut -d' ' -f1-3 /proc/loadavg)"
    echo "--- worker warn/error (60m) ---"
    W=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    [ -n "$W" ] && sudo docker logs "$W" --since 60m 2>&1 | grep -iE 'warn|error' | grep -vi 'deprecat' | tail -8 || echo none
    echo "== END FW29-C =="
    sudo touch "$MARKER_FW29C"
  fi

  # ── ONE-SHOT (2026-08-29d, coding-c): MCP reachability + session-env dir check (read-only). ──
  MARKER_FW29D=/var/tmp/.digby-fw29d-20260829d
  if [ ! -f "$MARKER_FW29D" ]; then
    echo "== FW29-D host=$(hostname) =="
    W=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    echo "--- MCP URLs in worker env ---"
    sudo docker exec "$W" sh -c 'env | grep -iE "MCP_URL|MCP_HOST" | sed "s/=\(.\{40\}\).*/=\1.../"' 2>/dev/null || echo none
    echo "--- resolve github-mcp-prod from worker ---"
    sudo docker exec "$W" sh -c 'getent hosts github-mcp-prod || echo UNRESOLVABLE' 2>/dev/null
    echo "--- can worker reach A:8202? ---"
    sudo docker exec "$W" sh -c 'command -v curl >/dev/null && curl -s -o /dev/null -w "%{http_code}" -m 5 http://10.0.0.11:8202/ || echo no-curl' 2>/dev/null
    echo ""
    echo "--- coding-session-env dir in worker ---"
    sudo docker exec "$W" sh -c 'ls -ld /app/coding-session-env 2>&1; ls /app/coding-session-env 2>/dev/null | wc -l' 2>/dev/null
    echo "== END FW29-D =="
    sudo touch "$MARKER_FW29D"
  fi

  # ── ONE-SHOT (2026-08-29f, coding-c): stage cross-box MCP URL overrides IF reachable.
  # Framework fix (standing full-autonomy doctrine): C's worker inherits docker-alias
  # MCP URLs that only resolve on box A. Curl from C proves publish+SG together; only
  # reachable ports get staged. No worker bounce here — the override rides the next
  # deploy's worker recreate (env-overrides.env is in the rebuild hash).
  MARKER_FW29F=/var/tmp/.digby-fw29f-20260829f
  if [ ! -f "$MARKER_FW29F" ]; then
    echo "== FW29-F host=$(hostname) =="
    F=/opt/crossmodel-local/env-overrides.env
    for KV in GOOGLE_MCP_URL:8201 GITHUB_MCP_URL:8202 X_MCP_URL:8203 SLACK_MCP_URL:8204 ASANA_MCP_URL:8205; do
      K=${KV%%:*}; P=${KV##*:}
      CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://10.0.0.11:$P/mcp" 2>/dev/null || echo 000)
      echo "$K -> 10.0.0.11:$P http_code=$CODE"
      if [ "$CODE" != "000" ]; then
        if sudo grep -q "^$K=" "$F" 2>/dev/null; then echo "  already overridden, skip"; else
          echo "$K=http://10.0.0.11:$P/mcp" | sudo tee -a "$F" >/dev/null
          echo "  -> staged (applies on next deploy worker recreate)"
        fi
      else
        echo "  SG-BLOCKED or not published — NOT staging"
      fi
    done
    echo "-- overrides file MCP lines now:"
    sudo grep -E '_MCP_URL=' "$F" 2>/dev/null || echo none
    echo "== END FW29-F =="
    sudo touch "$MARKER_FW29F"
  fi

  # ── ONE-SHOT (2026-08-29g, coding-c): post-SG + post-deploy MCP fix verification (read-only). ──
  # Owner added intra-SG rule sgr-0123456789abcdef0 (8201-8205); the ffba80ee deploy
  # recreates this worker with the staged cross-box MCP URLs. Verify all three layers.
  MARKER_FW29G=/var/tmp/.digby-fw29g-20260829g
  if [ ! -f "$MARKER_FW29G" ]; then
    echo "== FW29-G host=$(hostname) =="
    echo "--- reachability from C (expect 2xx-4xx, NOT 000) ---"
    for P in 8201 8202 8203 8204 8205; do
      CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://10.0.0.11:$P/mcp" 2>/dev/null)
      echo "port $P -> http_code=${CODE:-fail}"
    done
    echo "--- worker: age + MCP env (expect 10.0.0.11 URLs) ---"
    sudo docker ps --format '{{.Names}} {{.Status}}' | grep '^admin-worker' || echo "NO WORKER"
    WN=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    sudo docker exec "$WN" sh -c 'env | grep -E "_MCP_URL="' 2>/dev/null
    echo "--- EAI_AGAIN count since worker start (expect 0) ---"
    sudo docker logs "$WN" 2>&1 | grep -c 'EAI_AGAIN'
    echo "== END FW29-G =="
    sudo touch "$MARKER_FW29G"
  fi

  # ── ONE-SHOT (2026-08-29i, coding-c): .env MCP URL values on C after override merge (read-only). ──
  MARKER_FW29I=/var/tmp/.digby-fw29i-20260829i
  if [ ! -f "$MARKER_FW29I" ]; then
    echo "== FW29-I host=$(hostname) =="
    sudo grep -E '^(GOOGLE|GITHUB|X|SLACK|ASANA)_MCP_URL=' /opt/crossmodel/.env || echo "no MCP_URL keys in .env"
    echo "== END FW29-I =="
    sudo touch "$MARKER_FW29I"
  fi

  # ── ONE-SHOT (2026-08-29k, coding-c): POST-activation MCP verification (read-only, ticket 96f41cb3 E2E). ──
  # After 5aab56b7 (compose ${VAR:-alias} interpolation) + staged env-overrides + owner SG rule
  # sgr-0123456789abcdef0: the recreated worker must carry 10.0.0.11 MCP URLs, resolve+reach
  # them from INSIDE the container (the layer that was EAI_AGAIN), and have zero EAI_AGAIN
  # since its start. FW29-G ran pre-activation (worker still alias URLs); this is the post-check.
  MARKER_FW29K=/var/tmp/.digby-fw29k-20260829k
  if [ ! -f "$MARKER_FW29K" ]; then
    echo "== FW29-K host=$(hostname) =="
    echo "--- reachability from C host (expect 2xx-4xx, NOT 000) ---"
    for P in 8201 8202 8203 8204 8205; do
      CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://10.0.0.11:$P/mcp" 2>/dev/null)
      echo "port $P -> http_code=${CODE:-fail}"
    done
    echo "--- worker age (recreated after 5aab56b7 deploy?) ---"
    sudo docker ps --format '{{.Names}} {{.Status}}' | grep '^admin-worker' || echo "NO WORKER"
    WN=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    if [ -n "$WN" ]; then
      echo "--- worker MCP env (expect http://10.0.0.11:820x/mcp, NOT docker aliases) ---"
      sudo docker exec "$WN" sh -c 'env | grep -E "_MCP_URL="' 2>/dev/null
      echo "--- per-URL fetch from INSIDE worker (DNS+TCP+HTTP; expect http status, no ENOTFOUND/EAI_AGAIN) ---"
      sudo docker exec "$WN" node -e '(async()=>{for(const v of["GOOGLE_MCP_URL","GITHUB_MCP_URL","X_MCP_URL","SLACK_MCP_URL","ASANA_MCP_URL"]){const u=process.env[v]||"(unset)";try{const r=await fetch(u,{signal:AbortSignal.timeout(5000)});console.log(v,u,"-> http",r.status)}catch(e){console.log(v,u,"-> FAIL",(e.cause&&e.cause.code)||e.message)}}})()' 2>&1
      echo "--- EAI_AGAIN count since worker start (expect 0) ---"
      sudo docker logs "$WN" 2>&1 | grep -c 'EAI_AGAIN'
    fi
    echo "== END FW29-K =="
    sudo touch "$MARKER_FW29K"
  fi

  # ── ONE-SHOT (2026-08-29l, coding-c): protocol-level MCP call from inside the worker (read-only, ticket 96f41cb3). ──
  # FW29-K proved transport (DNS+TCP+HTTP) + EAI_AGAIN=0 post-activation. The ticket's strict
  # ask is a SUCCESSFUL MCP CALL: a tools/list JSON-RPC POST to each *_MCP_URL with the
  # worker's own X-API-Key (the github-mcp.ts wire protocol). Expect http 200 + tool names
  # in the SSE/JSON payload. Key VALUES are never echoed — used in request headers only.
  MARKER_FW29L=/var/tmp/.digby-fw29l-20260829l
  if [ ! -f "$MARKER_FW29L" ]; then
    echo "== FW29-L host=$(hostname) =="
    WN=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    if [ -z "$WN" ]; then echo "NO WORKER"; else
      sudo docker exec "$WN" node -e '(async()=>{const defs=[["GOOGLE","GOOGLE_MCP_URL","GOOGLE_MCP_API_KEY"],["GITHUB","GITHUB_MCP_URL","GITHUB_MCP_API_KEY"],["X","X_MCP_URL","X_MCP_API_KEY"],["SLACK","SLACK_MCP_URL","SLACK_MCP_API_KEY"],["ASANA","ASANA_MCP_URL","ASANA_MCP_API_KEY"]];for(const[n,uv,kv]of defs){const u=process.env[uv]||"(unset)";const k=process.env[kv]||"";if(!k){console.log(n,u,"-> SKIP no "+kv);continue}try{const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json","accept":"application/json, text/event-stream","x-api-key":k},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}}),signal:AbortSignal.timeout(8000)});const t=await r.text();const m=t.match(/"name"\s*:\s*"([^"]+)"/);console.log(n,u,"-> http",r.status,"| first tool:",m?m[1]:"(none parsed)","| bytes:",t.length)}catch(e){console.log(n,u,"-> FAIL",(e.cause&&e.cause.code)||e.message)}}})()' 2>&1
    fi
    echo "== END FW29-L =="
    sudo touch "$MARKER_FW29L"
  fi

  # ── ONE-SHOT (2026-08-29m, coding-c): classify FW29-L 401s (read-only, ticket 96f41cb3). ──
  # Print the 401 response BODIES (tiny gateway error strings — no secrets) and grep this
  # worker's logs for REAL MCP auth failures since its start (post-activation traffic).
  MARKER_FW29M=/var/tmp/.digby-fw29m-20260829m
  if [ ! -f "$MARKER_FW29M" ]; then
    echo "== FW29-M host=$(hostname) =="
    WN=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    if [ -z "$WN" ]; then echo "NO WORKER"; else
      echo "--- 401 bodies (tools/list with worker X-API-Key) ---"
      sudo docker exec "$WN" node -e '(async()=>{const defs=[["GOOGLE","GOOGLE_MCP_URL","GOOGLE_MCP_API_KEY"],["GITHUB","GITHUB_MCP_URL","GITHUB_MCP_API_KEY"],["SLACK","SLACK_MCP_URL","SLACK_MCP_API_KEY"],["ASANA","ASANA_MCP_URL","ASANA_MCP_API_KEY"]];for(const[n,uv,kv]of defs){const u=process.env[uv]||"(unset)";const k=process.env[kv]||"";if(!k){console.log(n,"-> SKIP no "+kv);continue}try{const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json","accept":"application/json, text/event-stream","x-api-key":k},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}}),signal:AbortSignal.timeout(8000)});const t=await r.text();console.log(n,"-> http",r.status,"| body:",t.slice(0,160).replace(/\n/g," "))}catch(e){console.log(n,"-> FAIL",(e.cause&&e.cause.code)||e.message)}}})()' 2>&1
      echo "--- C worker logs since start: real MCP auth-failure lines (expect none) ---"
      sudo docker logs "$WN" 2>&1 | grep -iE "MCP" | grep -iE "401|unauthorized|EAI_AGAIN" | tail -10 || echo "(none)"
      echo "--- count of MCP failure lines since start ---"
      sudo docker logs "$WN" 2>&1 | grep -icE "MCP.*failed" || true
    fi
    echo "== END FW29-M =="
    sudo touch "$MARKER_FW29M"
  fi

  # ── ONE-SHOT (2026-09-04, coding-c): CH0904C — coding-harness retrieval logs on the
  #    box that RUNS the coding worker (read-only). Shows index syncs firing, memory
  #    store/search errors, and retrieval-adjacent warnings since the ca0c3a4 deploy. ──
  MARKER_CH0904C=/var/tmp/.digby-ch0904c-20260904
  if [ ! -f "$MARKER_CH0904C" ]; then
    echo "== CH0904C host=$(hostname) =="
    WN=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    if [ -z "$WN" ]; then echo "NO WORKER on C"; else
      echo "-- index/memory log lines (last 12h, tail 40) --"
      sudo docker logs "$WN" --since 12h 2>&1 | grep -E 'code-index:|learnings-index:|unified-memory:|coding-retrieval:|coding-memory:' | tail -40 || echo "(no matching lines)"
      echo "-- failure-shaped counts (last 12h) --"
      for pat in 'code-index: sync failed' 'learnings-index: sync failed' 'unified-memory: store failed' 'unified-memory: search failed' 'unified-memory: embed failed' 'unified-memory: semantic leg failed' 'unified-memory: keyword leg failed'; do
        n=$(sudo docker logs "$WN" --since 12h 2>&1 | grep -cF "$pat" || true)
        echo "$pat -> $n"
      done
      echo "-- worker error lines (last 6h, tail 15) --"
      sudo docker logs "$WN" --since 6h 2>&1 | grep -iE '\berror\b' | grep -vE 'error_type|"error":null' | tail -15 || echo "(none)"
    fi
    echo "== END CH0904C =="
    sudo touch "$MARKER_CH0904C"
  fi

  # ── ONE-SHOT (2026-09-09, coding C): DR0909C — worker health after the pre-flight deploy (read-only). ──
  # Coding sessions run in C's worker; the pre-flight code path lives there.
  MARKER_DR0909C=/var/tmp/.digby-dr0909c
  if [ ! -f "$MARKER_DR0909C" ]; then
    echo "== DR0909C host=$(hostname) now=$(date -u +%FT%TZ) =="
    for C in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker'); do
      echo "  [$C created $(sudo docker inspect -f '{{.Created}}' "$C" 2>/dev/null)]"
      echo "  -- uncaught / type errors (60m) --"
      sudo docker logs --since 60m "$C" 2>&1 | grep -E 'TypeError|ReferenceError|Unhandled|uncaughtException' | tail -8 | cut -c1-300 || echo '  (none)'
      echo "  -- derail / pre-flight / tool-group progress lines (60m) --"
      sudo docker logs --since 60m "$C" 2>&1 | grep -iE 'derail-break|tool-group|Account tools loaded|withheld' | tail -10 | cut -c1-300 || echo '  (none)'
    done
    echo "== END DR0909C =="
    sudo touch "$MARKER_DR0909C"
  fi

  # ── ONE-SHOT (2026-09-25, coding-c): DG0925C — decision gate env + log check on the coding worker (read-only). ──
  # The worker hosts the gated machine sites (supervisor wake triage, schedule delta, coding self-audit),
  # so the key must reach admin-worker-* here too (deploy.yml → /opt/crossmodel-local/env-secrets.env).
  # Key handling: PRESENCE + LENGTH ONLY — the value is never printed.
  MARKER_DG0925C=/var/tmp/.digby-dg0925c2
  if [ ! -f "$MARKER_DG0925C" ]; then
    echo "== DG0925C host=$(hostname) now=$(date -u +%FT%TZ) =="
    for C in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker'); do
      printf '  %s: ' "$C"
      sudo docker exec "$C" sh -c 'echo "TYPESAFE_API_KEY=$([ -n "$TYPESAFE_API_KEY" ] && echo "present(len ${#TYPESAFE_API_KEY})" || echo MISSING) TYPESAFE_BASE_URL=${TYPESAFE_BASE_URL:-unset} TYPESAFE_MODEL=${TYPESAFE_MODEL:-unset} DECISION_GATE_DISABLED=${DECISION_GATE_DISABLED:-unset} DECISION_GATE_DEFAULT_MODE=${DECISION_GATE_DEFAULT_MODE:-unset} DEEPSEEK_API_KEY=$([ -n "$DEEPSEEK_API_KEY" ] && echo present || echo MISSING)"' 2>/dev/null || echo "exec failed"
      echo "  -- gate log lines (24h, last 10) --"
      timeout 120 sudo docker logs --since 24h "$C" 2>&1 | grep -iE 'decision-gate|decision gate|typesafe' | tail -10 | cut -c1-260 || echo '  (none)'
    done
    n=$(sudo grep -c '^TYPESAFE_API_KEY=.\+' /opt/crossmodel-local/env-secrets.env 2>/dev/null); echo "  env-secrets.env TYPESAFE_API_KEY set lines: ${n:-nofile}"
    echo "== END DG0925C =="
    sudo touch "$MARKER_DG0925C"
  fi

  # ── ONE-SHOT (2026-10-12, coding-c): ISO1012A — ISO workspace census, ALL coding accounts (READ-ONLY). ──
  # PLACEMENT: paste this block in scripts/ec2-ops/playbook.sh directly ABOVE the line
  #   "  # ==ONE-SHOT-INSERT-POINT-CODING-C== (insert coding-c one-shots ABOVE this line)"
  # (inside the `if [ "$ROLE" = "coding-c" ]` branch; NOT the PROD anchor — box A has no worker / no volume).
  # Read-only: calls only planUserMigration / userWorkspaceCensus (coding/workspace-migration) and
  # userContainmentCensus (coding/workspace-placement) — the same functions the migration CLI and the dev
  # container mount plan use — plus SELECTs on loop_metrics. Nothing is moved, locked or written.
  # LOG HYGIENE (Actions logs are readable by every repo reader): only lines the script prints with the
  # "ISO|" prefix reach the log (grep filter) — counts, 12-char subtree keys, roles, statuses. Never env
  # values, full user ids, file contents or command text.
  # Runs inside the live NON-draining worker (deploy-coding-worker.sh DRAIN: a retiring worker carries
  # /tmp/worker-draining). Self-timeout 13 min (read-only, safe to cut); the coding-c ssh bound is 20 min.
  MARKER_ISO1012A=/var/tmp/.digby-iso1012a-census
  if [ ! -f "$MARKER_ISO1012A" ]; then
    echo "== ISO1012A host=$(hostname) now=$(date -u +%FT%TZ) =="
    W=""; NW=0
    for c in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker-(blue|green)$' || true); do
      if sudo docker exec "$c" test -f /tmp/worker-draining >/dev/null 2>&1; then echo "  $c: draining (skipped)"; continue; fi
      W="$c"; NW=$((NW+1))
    done
    echo "  live (non-draining) workers: $NW  using: ${W:-none}"
    F=/opt/crossmodel-local/env-overrides.env
    echo "  env-overrides.env: SUBTREE lines=$(sudo grep -c '^CODING_WORKSPACE_PER_USER_SUBTREE=' "$F" 2>/dev/null || true) ids=$(sudo grep -m1 '^CODING_WORKSPACE_PER_USER_SUBTREE=' "$F" 2>/dev/null | cut -d= -f2- | tr ', ' '\n\n' | grep -c . || true)  PROXY lines=$(sudo grep -c '^CODING_CREDENTIAL_PROXY=' "$F" 2>/dev/null || true)"
    VOL=/var/lib/docker/volumes/crossmodel_coding_workspaces/_data
    echo "  manifests on volume: $(sudo ls -1 "$VOL/.digby-layout-migrations" 2>/dev/null | grep -c '\.json$' || true)"
    if [ -z "$W" ]; then echo "  NO live worker on C — census skipped"; else
      cat > /tmp/iso1012a.js <<'JS'
'use strict';
const out = (...a) => console.log(['ISO', ...a].join('|'));
setTimeout(() => { out('error', 'self_timeout_780s'); process.exit(5); }, 780000).unref();
(async () => {
  const fs = require('fs'); const path = require('path');
  const mig = require('/app/dist/modules/crossmodel/coding/workspace-migration');
  const lay = require('/app/dist/modules/crossmodel/coding/workspace-layout');
  const plc = require('/app/dist/modules/crossmodel/coding/workspace-placement');
  const prisma = require('/app/dist/config/database').default;
  const deps = await mig.defaultMigrationDeps('census-iso1012a');
  const root = deps.root;
  const sw = lay.perUserSubtreeSetting();
  const px = lay.userSwitchSetting('CODING_CREDENTIAL_PROXY');
  out('switch', `subtree=${sw.mode}${sw.mode === 'users' ? ':' + sw.ids.length : ''}`, `credproxy=${px.mode}${px.mode === 'users' ? ':' + px.ids.length : ''}`, `root=${root}`);
  out('cli_redis_fix', String(mig.defaultMigrationDeps).includes('connectRedis') ? 'present' : 'MISSING');
  // Volume top level: legacy dirs vs compat links (what a whole-volume mount still exposes).
  const top = (dir, filt) => { const r = { real: 0, link: 0 }; try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (!filt(e.name)) continue; if (e.isSymbolicLink()) r.link++; else if (e.isDirectory()) r.real++; } } catch {} return r; };
  const lw = top(path.join(root, 'worktrees'), (n) => !n.startsWith('.'));
  const lh = top(path.join(root, 'worktrees', '.sandbox-home'), () => true);
  const lm = top(path.join(root, 'repos'), (n) => n.endsWith('.git'));
  out('volume', `legacyWorktrees real=${lw.real} compatLinks=${lw.link}`, `legacyHomes real=${lh.real} compatLinks=${lh.link}`, `legacyMirrors real=${lm.real} compatLinks=${lm.link}`, `subtrees=${lay.listSubtreeKeysSync(root).length}`);
  // Per user with coding sessions.
  const rows = await prisma.chatCodingState.findMany({ select: { userId: true } });
  const ids = Array.from(new Set(rows.map((r) => r.userId).filter(Boolean)));
  const roles = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true } })).map((u) => [u.id, u.role]));
  out('users_with_sessions', ids.length);
  const T = { sessions: 0, legacyWt: 0, perUserWt: 0, legacyHome: 0, broken: 0, dangling: 0, planned: 0, liveSkips: 0 };
  for (const uid of ids.sort()) {
    const key = lay.userSubtreeKey(uid);
    try {
      const c = await mig.userWorkspaceCensus(uid, deps);
      const k = await plc.userContainmentCensus(uid, root).catch(() => null);
      const plan = await mig.planUserMigration(uid, deps, { mirrors: true });
      const pc = {};
      for (const i of plan.items) { const s = `${i.kind}:${i.status}${i.reason ? ':' + i.reason : ''}`; pc[s] = (pc[s] || 0) + 1; }
      const planned = plan.items.filter((i) => i.status === 'planned' && i.kind !== 'mirror').length;
      const live = plan.items.filter((i) => i.reason === 'live_run').length;
      T.sessions += c.sessions; T.legacyWt += c.legacyWorktrees; T.perUserWt += c.perUserWorktrees; T.legacyHome += c.legacyHomes;
      T.broken += c.brokenWorktrees.length; T.dangling += c.danglingCompatLinks.length; T.planned += planned; T.liveSkips += live;
      out('user', key, roles.get(uid) || '?', `canary=${lay.perUserSubtreeAppliesTo(uid) ? 1 : 0}`, `proxy=${lay.userSwitchAppliesTo('CODING_CREDENTIAL_PROXY', uid) ? 1 : 0}`,
        `sessions=${c.sessions}`, `legacyWt=${c.legacyWorktrees}`, `perUserWt=${c.perUserWorktrees}`, `compat=${c.compatLinks}`,
        `dangling=${c.danglingCompatLinks.length}`, `broken=${c.brokenWorktrees.length}`, `legacyHome=${c.legacyHomes}`, `perUserHome=${c.perUserHomes}`, `dbStale=${c.dbPathStale}`,
        k ? `liveContainment perUser=${k.perUser} legacy=${k.legacy} foreign=${k.foreign} extraMirrors=${k.extraMirrors.length}` : 'liveContainment=census_failed',
        `plan=${JSON.stringify(pc)}`, plan.error ? `planError=${plan.error}` : 'planError=-');
    } catch (e) { out('user', key, 'error', String(e && e.message || e).slice(0, 120)); }
  }
  out('totals', Object.entries(T).map(([a, b]) => `${a}=${b}`).join(' '));
  // Subtree dir ownership (a root-owned parent created by a root-run migration blocks the nodejs worker).
  const st = (p) => { try { const s = fs.lstatSync(p); return `${s.uid}:${s.gid}:${(s.mode & 0o7777).toString(8)}`; } catch { return '-'; } };
  for (const key of lay.listSubtreeKeysSync(root)) {
    const d = path.join(root, key);
    out('subtree', key, `dir=${st(d)}`, `marker=${st(path.join(d, lay.SUBTREE_MARKER))}`, `worktrees=${st(path.join(d, 'worktrees'))}`, `homes=${st(path.join(d, '.sandbox-home'))}`, `repos=${st(path.join(d, 'repos'))}`);
  }
  // Migration manifests (which runs happened, per user key — no user ids, no paths).
  const mdir = path.join(root, '.digby-layout-migrations');
  out('manifest_dir', st(mdir));
  let files = []; try { files = fs.readdirSync(mdir).filter((f) => f.endsWith('.json')).sort(); } catch {}
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(mdir, f), 'utf8'));
      const cnt = {}; for (const i of m.items || []) { const s = `${i.kind}:${i.status}${i.reason ? ':' + i.reason : ''}`; cnt[s] = (cnt[s] || 0) + 1; }
      out('manifest', m.runId, m.key, m.createdAt, `mirrors=${m.mirrors ? 1 : 0}`, JSON.stringify(cnt));
    } catch { out('manifest', f, 'unreadable'); }
  }
  // Widening bars (AGENTS.md ISO bullet), last 7 days, counts only.
  const q = async (label, sql) => { try { for (const r of await prisma.$queryRawUnsafe(sql)) out(label, Object.values(r).map((v) => (v === null ? '-' : String(v))).join(',')); } catch (e) { out(label, 'query_failed', String(e && e.message || e).slice(0, 80)); } };
  await q('bar_isolation', `SELECT meta->>'phase' AS phase, coalesce(meta->>'mount', meta->>'outcome', meta->>'layout', '-') AS v, coalesce(meta->>'hardened','-') AS hardened, count(*) AS n FROM loop_metrics WHERE kind='workspace_isolation' AND "createdAt" > now() - interval '7 days' GROUP BY 1,2,3 ORDER BY 1,2,3`);
  await q('bar_credproxy', `SELECT meta->>'phase' AS phase, coalesce(meta->>'mode', meta->>'op', '-') AS v, coalesce(meta->>'ok','-') AS ok, count(*) AS n, sum(CASE WHEN meta->>'rawPlatform' ~ '^[0-9]+$' THEN (meta->>'rawPlatform')::int ELSE 0 END) AS raw FROM loop_metrics WHERE kind='credential_proxy' AND "createdAt" > now() - interval '7 days' GROUP BY 1,2,3 ORDER BY 1,2,3`);
  await q('bar_guard', `SELECT coalesce(meta->>'exposure','-') AS exposure, coalesce(meta->>'outcome','-') AS outcome, count(*) AS n, sum(CASE WHEN meta->>'reachesData' ~ '^[0-9]+$' THEN (meta->>'reachesData')::int ELSE 0 END) AS reaches, sum(CASE WHEN meta->>'crossTenant' ~ '^[0-9]+$' THEN (meta->>'crossTenant')::int ELSE 0 END) AS cross FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='run_command_workspace_scope' AND "createdAt" > now() - interval '7 days' GROUP BY 1,2 ORDER BY 1,2`);
  out('done');
  process.exit(0);
})().catch((e) => { out('error', String(e && e.message || e).slice(0, 160)); process.exit(1); });
JS
      sudo docker cp /tmp/iso1012a.js "$W:/tmp/iso1012a.js" && \
        sudo docker exec -w /app "$W" node /tmp/iso1012a.js 2>&1 | grep -E '^ISO\|' || echo "  census exited non-zero / printed nothing"
      sudo docker exec "$W" rm -f /tmp/iso1012a.js >/dev/null 2>&1 || true
      rm -f /tmp/iso1012a.js
    fi
    echo "== END ISO1012A =="
    sudo touch "$MARKER_ISO1012A"
  fi

  # ── ONE-SHOT (2026-10-12, coding-c): ISO1012B — MIGRATE the remaining ISO canary users (APPLY). ──
  # PLACEMENT: paste directly ABOVE "  # ==ONE-SHOT-INSERT-POINT-CODING-C== (insert coding-c one-shots ABOVE this line)",
  # BELOW ISO1012A if both are in the file. Run ISO1012A first (separate push) and read its log before this.
  # WHAT: for each of the 4 non-owner canary accounts (8-char prefixes below — already public in AGENTS.md),
  # one user at a time: census → plan → applyUserMigration (worktrees + homes; mirrors OFF) → ownership fix of
  # the parent dirs the root exec created → census again (verification). Exactly the calls
  # scripts/framework-audit/migrate-workspace-per-user.js makes (it is a thin CLI over the same module);
  # the CLI form per user is: workerq.sh migrate-workspace-per-user.js --user <id> --run <runId> --apply
  # SAFETY (module-enforced, workspace-migration.ts): a session with a queued/running run, status 'running' or
  # a held run-lock is SKIPPED (re-checked under the lock); each move is verified with git rev-parse and rolled
  # back on failure; compat symlink left at the legacy path; manifest written for --revert.
  # Extra rails here: only users that are IN the live CODING_WORKSPACE_PER_USER_SUBTREE switch AND match one
  # of the 4 prefixes (never the owner, never mode 'all'); refuse unless exactly ONE non-draining worker runs,
  # no deploy-coding-worker.sh is running, the dist carries the 2026-10-11 connectRedis fix and a probe lock
  # round-trips through Redis; a user with > 60 planned items or a run past 9 min stops the loop (the ssh bound
  # is 20 min and a process killed mid-move can leave a half-moved item); the first failed item / broken
  # worktree stops before the next user (exit 4).
  # LOG HYGIENE: only "ISO|" lines reach the log — counts, 12-char keys, runIds, statuses.
  # The marker is touched whatever happened (refusals included) — bump the marker name to run it again.
  MARKER_ISO1012B=/var/tmp/.digby-iso1012b-migrate
  if [ ! -f "$MARKER_ISO1012B" ]; then
    echo "== ISO1012B host=$(hostname) now=$(date -u +%FT%TZ) =="
    W=""; NW=0
    for c in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker-(blue|green)$' || true); do
      if sudo docker exec "$c" test -f /tmp/worker-draining >/dev/null 2>&1; then echo "  $c: draining (skipped)"; continue; fi
      W="$c"; NW=$((NW+1))
    done
    echo "  live (non-draining) workers: $NW  using: ${W:-none}"
    if pgrep -f deploy-coding-worker.sh >/dev/null 2>&1; then
      echo "  REFUSED: a worker deploy (deploy-coding-worker.sh) is running on this box — re-run after it finishes"
    elif [ "$NW" != "1" ]; then
      echo "  REFUSED: need exactly one live worker (found $NW) — a worker handoff is in progress"
    else
      cat > /tmp/iso1012b.js <<'JS'
'use strict';
const out = (...a) => console.log(['ISO', ...a].join('|'));
const PREFIXES = ['f4350445', '0441ef49', '295b0680', '076d2832']; // the 4 non-owner canary accounts (AGENTS.md ISO bullet)
const MAX_ITEMS = 60;            // per user, foreground bound
const BUDGET_MS = 9 * 60 * 1000; // stop starting new users after 9 min
const t0 = Date.now();
const NODE_UID = 1001;           // backend/Dockerfile: adduser nodejs -u 1001 (the worker drops to it)
(async () => {
  const fs = require('fs'); const path = require('path');
  const mig = require('/app/dist/modules/crossmodel/coding/workspace-migration');
  const lay = require('/app/dist/modules/crossmodel/coding/workspace-layout');
  const plc = require('/app/dist/modules/crossmodel/coding/workspace-placement');
  const metrics = require('/app/dist/modules/crossmodel/platform/loop-metrics.service');
  const prisma = require('/app/dist/config/database').default;
  const done = async (code) => { try { await metrics.flushLoopMetrics(); } catch {} out('exit', code); process.exit(code); };

  if (!String(mig.defaultMigrationDeps).includes('connectRedis')) { out('REFUSED', 'dist lacks the 2026-10-11 connectRedis fix (every item would read run_lock_held)'); return done(3); }
  const sw = lay.perUserSubtreeSetting();
  if (sw.mode !== 'users') { out('REFUSED', `subtree switch mode=${sw.mode} (expected an explicit user list)`); return done(3); }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12);
  const deps = await mig.defaultMigrationDeps(`iso1012b-${stamp}`); // connects Redis (throws loudly if unreachable)
  const root = deps.root;
  const probe = `iso1012b-probe-${process.pid}`;
  if (!(await deps.lock(probe))) { out('REFUSED', 'probe run-lock did not round-trip through Redis'); return done(3); }
  await deps.unlock(probe);
  out('preflight', 'ok', `root=${root}`, `switchUsers=${sw.ids.length}`);

  // Resolve each prefix to exactly one user that the live switch covers.
  const users = [];
  for (const p of PREFIXES) {
    const rows = await prisma.user.findMany({ where: { id: { startsWith: p } }, select: { id: true, role: true } });
    if (rows.length !== 1) { out('skip', p, `matches=${rows.length}`); continue; }
    const u = rows[0];
    if (!lay.perUserSubtreeAppliesTo(u.id)) { out('skip', p, 'not_in_subtree_switch'); continue; }
    users.push(u);
  }

  const st = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  const counts = (items) => { const c = {}; for (const i of items) { const s = `${i.kind}:${i.status}${i.reason ? ':' + i.reason : ''}`; c[s] = (c[s] || 0) + 1; } return JSON.stringify(c); };
  const census = async (uid) => {
    const c = await mig.userWorkspaceCensus(uid, deps);
    const k = await plc.userContainmentCensus(uid, root).catch(() => null);
    return { c, k, line: `sessions=${c.sessions} legacyWt=${c.legacyWorktrees} perUserWt=${c.perUserWorktrees} compat=${c.compatLinks} dangling=${c.danglingCompatLinks.length} broken=${c.brokenWorktrees.length} legacyHome=${c.legacyHomes} perUserHome=${c.perUserHomes} dbStale=${c.dbPathStale} ` +
      (k ? `live perUser=${k.perUser} legacy=${k.legacy} foreign=${k.foreign} extraMirrors=${k.extraMirrors.length}` : 'live=census_failed') };
  };

  let exit = 0;
  for (const u of users) {
    const key = lay.userSubtreeKey(u.id);
    if (Date.now() - t0 > BUDGET_MS) { out('stop', key, 'time_budget — re-run (bump the marker) for the rest'); break; }
    const before = await census(u.id);
    out('before', key, u.role, before.line);
    const plan = await mig.planUserMigration(u.id, deps, { mirrors: false });
    if (plan.error) { out('REFUSED', key, plan.error); exit = 3; break; }
    const planned = plan.items.filter((i) => i.status === 'planned');
    out('plan', key, counts(plan.items));
    if (!planned.length) { out('nothing_to_move', key); continue; }
    if (planned.length > MAX_ITEMS) { out('stop', key, `planned=${planned.length} > ${MAX_ITEMS} — run this user detached instead`); break; }
    const runId = `iso1012b-${key.slice(0, 8)}-${stamp}`;
    const { manifest, manifestFile } = await mig.applyUserMigration(u.id, plan, deps, runId, { mirrors: false });
    out('applied', key, `runId=${runId}`, `manifest=${path.basename(manifestFile)}`, counts(manifest.items));
    // Ownership: the exec runs as root, so dirs it CREATED are root-owned; the worker (uid 1001) must be able
    // to create new worktrees / homes under them. Moved items keep their own owner (rename preserves it).
    const d = path.join(root, key);
    let chowned = 0;
    for (const p of [d, path.join(d, lay.SUBTREE_MARKER), path.join(d, 'worktrees'), path.join(d, '.sandbox-home'), path.join(d, 'repos')]) {
      const s = st(p);
      if (s && s.uid === 0 && !s.isSymbolicLink()) { try { fs.chownSync(p, NODE_UID, NODE_UID); chowned++; } catch {} }
    }
    // Manifests list other users' session ids — readable only by root (the CLI revert runs as root).
    try { fs.chmodSync(path.dirname(manifestFile), 0o700); } catch {}
    out('ownership', key, `chowned=${chowned}`);
    const after = await census(u.id);
    const failed = manifest.items.filter((i) => i.status === 'failed').length;
    const ok = failed === 0 && after.c.brokenWorktrees.length === 0 && after.c.danglingCompatLinks.length === 0 && (!after.k || after.k.foreign === 0);
    out('after', key, after.line);
    out('verify', key, ok ? 'PASS' : 'FAIL', `failed=${failed}`, `revert: workerq.sh migrate-workspace-per-user.js --revert --run ${runId} [--apply]`);
    if (!ok) { exit = 4; break; }
  }
  return done(exit);
})().catch((e) => { out('error', String(e && e.message || e).slice(0, 160)); process.exit(1); });
JS
      sudo docker cp /tmp/iso1012b.js "$W:/tmp/iso1012b.js" && \
        sudo docker exec -w /app "$W" node /tmp/iso1012b.js 2>&1 | grep -E '^ISO\|' || echo "  migrate exited non-zero / printed nothing"
      sudo docker exec "$W" rm -f /tmp/iso1012b.js >/dev/null 2>&1 || true
      rm -f /tmp/iso1012b.js
    fi
    echo "== END ISO1012B =="
    sudo touch "$MARKER_ISO1012B"
  fi

  # ── WS1020-C (2026-10-20, post-deploy probe for the worker-slot registry on box C — deploy 910e34a; READ-ONLY
  #    one-shot, marker-guarded) ──────────────────────────────────────────────────────────────────────────────
  MARKER_WS1020C=/opt/crossmodel-local/oneshot-WS1020-C.done
  if [ ! -f "$MARKER_WS1020C" ]; then
  # Box C: is the NEW worker image live, does its env carry CODING_WORKER_CONCURRENCY=32 + BOX_NAME, did it
  # log a worker-slots warning, and does ITS view of the shared Redis (REDIS_URL → box A) show its own entry.
  echo "== WS1020-C: coding worker slot publisher (read-only) =="
  for WS_CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker'); do
    echo "WS|worker=$WS_CN started=$(sudo docker inspect -f '{{.State.StartedAt}}' "$WS_CN") image=$(sudo docker inspect -f '{{.Config.Image}}' "$WS_CN") health=$(sudo docker inspect -f '{{.State.Health.Status}}' "$WS_CN" 2>/dev/null || echo '?')"
    sudo docker exec "$WS_CN" sh -c 'env | grep -E "^(CODING_WORKER_CONCURRENCY|BOX_NAME|WORKER_SLOT_REGISTRY_DISABLED|DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS|DEPLOY_SHA)=" | sort | sed "s/^/WS|  env: /"' 2>/dev/null || echo "WS|  env: exec failed"
    sudo docker logs --since 2h "$WS_CN" 2>&1 | grep -i -E 'worker-slots|coding worker .* started' | tail -5 | sed 's/^/WS|  log: /'
    sudo docker exec -w /app "$WS_CN" node -e '
const r = require("/app/dist/config/redis"); const ws = require("/app/dist/modules/crossmodel/coding/worker-slots");
(async () => { await r.connectRedis(); const raw = await r.default.hGetAll(ws.WORKER_SLOTS_KEY); for (const [k, v] of Object.entries(raw)) console.log("WS|  C-view hash|" + k + "|" + v); const live = await ws.readLiveWorkerSlots(); console.log("WS|  C-view readLiveWorkerSlots|" + JSON.stringify(live)); process.exit(0); })().catch((e) => { console.log("WS|  C-view error|" + String(e && e.message).slice(0, 200)); process.exit(1); });
' 2>&1 | grep -E '^WS\|' || echo "WS|  C-view: node probe printed nothing"
  done
  echo "== END WS1020-C =="
  sudo mkdir -p /opt/crossmodel-local && sudo touch "$MARKER_WS1020C"
  fi
  # ── MWV1020C-C (2026-10-20, READ-ONLY, marker-guarded): which coding-worker containers are live on box C after the
  #    19:22:57Z handoff (is the pre-rollout admin-worker-blue still draining?), and did any log the archive-unavailable warn.
  MARKER_MWV1020CC=/opt/crossmodel-local/oneshot-MWV1020C-C.done
  if [ ! -f "$MARKER_MWV1020CC" ]; then
  echo "== MWV1020C-C: coding workers after the memory-wave handoff (read-only) =="
  for MW_CN in $(sudo docker ps -a --format '{{.Names}}' | grep -E '^admin-worker'); do
    echo "MWC|worker=$MW_CN status=$(sudo docker inspect -f '{{.State.Status}}' "$MW_CN") started=$(sudo docker inspect -f '{{.State.StartedAt}}' "$MW_CN") finished=$(sudo docker inspect -f '{{.State.FinishedAt}}' "$MW_CN") image=$(sudo docker inspect -f '{{.Config.Image}}' "$MW_CN")"
    echo "MWC|  archive-unavailable warns (3h): $(sudo docker logs --since 3h "$MW_CN" 2>&1 | grep -c 'digby_memory_archive unavailable')"
  done
  echo "== END MWV1020C-C =="
  sudo mkdir -p /opt/crossmodel-local && sudo touch "$MARKER_MWV1020CC"
  fi

  # ── ONE-SHOT (2026-10-21, coding-c): LVC1021C — READ-ONLY deploy sha on box C for the 29bd478b live check (A is read by LVC1021).
  if [ ! -f /var/tmp/.digby-lvc1021c ]; then echo "== LVC1021C deploy-sha: $(cat /opt/crossmodel/.deploy-sha 2>/dev/null || echo missing) =="; sudo touch /var/tmp/.digby-lvc1021c; fi
  # ── ONE-SHOT (2026-10-21, coding-c): PDV1021C — READ-ONLY: box C deploy sha + whether its worker image carries the
  # release 15197e979 fixes (titles render and decision-gate asks also run in the worker here).
  if [ ! -f /var/tmp/.digby-pdv1021c ]; then
    echo "== PDV1021C deploy-sha: $(cat /opt/crossmodel/.deploy-sha 2>/dev/null || echo missing) =="
    for CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker'); do
      H=$(sudo docker exec "$CN" sh -c 'grep -l "HARNESS_TITLE_DONE_TODO_SKIP_DISABLED" /app/dist/modules/crossmodel/platform/session-titles.js 2>/dev/null | wc -l; ls /app/dist/modules/crossmodel/platform/decision-gate-stall.js 2>/dev/null | wc -l' 2>/dev/null | tr '\n' ' ')
      echo "  $CN titles+stall dist: $H started $(sudo docker inspect -f '{{.State.StartedAt}}' "$CN" 2>/dev/null)"
    done
    PDV_C_OK=0
    for CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker'); do
      [ "$(sudo docker exec "$CN" sh -c 'grep -c HARNESS_TITLE_DONE_TODO_SKIP_DISABLED /app/dist/modules/crossmodel/platform/session-titles.js 2>/dev/null' 2>/dev/null || echo 0)" != "0" ] && PDV_C_OK=1
    done
    if [ "$PDV_C_OK" = 1 ]; then sudo touch /var/tmp/.digby-pdv1021c; else echo "  box C worker not on the release yet — marker left unset"; fi
  fi
  # ── ONE-SHOT (2026-10-21, coding-c): PDV1021R2C — READ-ONLY: does box C's worker carry release 1 (lane titles) and
  # release 2 (struck-note repeat)? (PDV1021C set its marker on a `grep -c … || echo 0` double-zero bug.)
  if [ ! -f /var/tmp/.digby-pdv1021r2c ]; then
    echo "== PDV1021R2C deploy-sha: $(cat /opt/crossmodel/.deploy-sha 2>/dev/null || echo missing) =="
    PDVR2C_OK=0
    for CN in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-worker'); do
      T=$(sudo docker exec "$CN" sh -c 'grep -c HARNESS_TITLE_DONE_TODO_SKIP_DISABLED /app/dist/modules/crossmodel/platform/session-titles.js 2>/dev/null; true' 2>/dev/null | head -1)
      R=$(sudo docker exec "$CN" sh -c 'ls /app/dist/modules/crossmodel/chat-agent/struck-note-repeat.js >/dev/null 2>&1 && echo 1 || echo 0' 2>/dev/null | head -1)
      echo "  $CN titles=${T:-0} repeat=${R:-0} started $(sudo docker inspect -f '{{.State.StartedAt}}' "$CN" 2>/dev/null)"
      [ "${T:-0}" -gt 0 ] 2>/dev/null && [ "${R:-0}" = 1 ] && PDVR2C_OK=1
    done
    if [ "$PDVR2C_OK" = 1 ]; then sudo touch /var/tmp/.digby-pdv1021r2c; else echo "  box C worker not on release 2 yet — marker left unset"; fi
  fi
  # ── ONE-SHOT (2026-10-21, coding-c): FSV1021C — READ-ONLY: the worker's owner-briefing post counters over the last 5 h
  # (most supervisor briefings post from this worker). Counts and the headSuppressed key list only — never text.
  MARKER_FSVC1021=/var/tmp/.digby-fsvc1021-briefing-log-counters
  if [ ! -f "$MARKER_FSVC1021" ]; then
    echo "== FSV1021C host=$(hostname) now=$(date -u +%FT%TZ) =="
    for c in $(sudo docker ps --format '{{.Names}}' | grep -E 'worker' ); do
      L=$(timeout 90 sudo docker logs "$c" --since 5h 2>&1)
      echo "LOGS $c posted=$(printf '%s' "$L" | grep -c 'owner-briefing: posted') suppressed=[$(printf '%s' "$L" | grep 'owner-briefing: posted' | grep -o 'headSuppressed=[a-z,]*' | sort | uniq -c | tr '\n' ' ')] nothingNewSkip=$(printf '%s' "$L" | grep -c 'no new head line') fleetPosts=$(printf '%s' "$L" | grep 'owner-briefing: posted' | grep -c 'c0e22e36\|6061a468\|bd174335')"
    done
    sudo touch "$MARKER_FSVC1021"
    echo "== END FSV1021C =="
  fi
  # ── ONE-SHOT (2026-10-27, coding-c): DG1027F211DC — stage the force-on lift on box C (FS task f64b7c1e prio-2) ──
  # The ec2-ops env_override dispatch input targets box A only (ec2-ops.yml "Stage env override on
  # prod"), so C's env-overrides.env never received the lift and C's fold in the af005ff3 wave
  # (18:54:43Z) folded neither key. Stage both here (CC0902 idiom) — C's NEXT worker wave folds
  # them via apply-env-overrides.sh before the recreate. No worker touch this run: a mid-run
  # recreate would kill live coding sessions (drain semantics belong to deploy-coding-worker.sh).
  MARKER_DG1027DC=/var/tmp/.digby-dg1027f211dc
  if [ ! -f "$MARKER_DG1027DC" ]; then
    echo "== DG1027F211DC host=$(hostname) now=$(date -u +%FT%TZ) =="
    F=/opt/crossmodel-local/env-overrides.env
    sudo touch "$F"
    for KV in "SUPERVISOR_MATERIAL_GATE_DISABLED=1" "DECISION_GATE_ADMISSION_DISABLED=1"; do
      K="${KV%%=*}"
      if sudo grep -q "^$K=" "$F"; then sudo sed -i "s|^$K=.*|$KV|" "$F"; else echo "$KV" | sudo tee -a "$F" >/dev/null; fi
      echo "  staged $KV"
    done
    W=$(sudo docker ps --format '{{.Names}}' | grep -m1 '^admin-worker') || true
    [ -n "$W" ] && sudo docker exec "$W" sh -c 'echo "  worker env now: DECISION_GATE_ADMISSION_DISABLED=${DECISION_GATE_ADMISSION_DISABLED:-<unset — lands on the next C worker wave>}"'
    echo "== END DG1027F211DC =="
    sudo touch "$MARKER_DG1027DC"
  fi
  # ── ONE-SHOT (2026-10-28, coding-c): FB4A18B0-C — stage FIX_STATE_EVIDENCE_REPO_ALLOWLIST + per-PROCESS proof ──
  # C's .env is NEVER rewritten by the fleet template (rsync excludes it), so
  # the allowlist must be STAGED into /opt/crossmodel-local/env-overrides.env
  # (CC0902 idiom) — deploy-coding-worker.sh folds it via apply-env-overrides.sh
  # BEFORE the box-local overrides and hashes the file, so the changed hash
  # drives the worker recreate on the next wave's coding-box step. The value is
  # the UNION (fix-state.ts REPLACES the default when the key is set). Proof is
  # per-PROCESS (docker exec), not per-file; marker consumed ONLY on a
  # fully-passing read so a not-yet-recreated worker re-proofs next dispatch.
  MARKER_FB4AC=/var/tmp/.digby-fb4a18b0-c
  if [ ! -f "$MARKER_FB4AC" ]; then
    echo "== FB4A18B0-C host=$(hostname) now=$(date -u +%FT%TZ) =="
    KC=FIX_STATE_EVIDENCE_REPO_ALLOWLIST
    WANTC=example-org/crossmodel,example-org/optcg
    F=/opt/crossmodel-local/env-overrides.env
    KV="FIX_STATE_EVIDENCE_REPO_ALLOWLIST=example-org/crossmodel,example-org/optcg"
    sudo touch "$F"
    if sudo grep -q "^$KC=" "$F"; then
      sudo sed -i "s|^$KC=.*|$KV|" "$F"; echo "  staged (in place): $KV"
    else
      echo "$KV" | sudo tee -a "$F" >/dev/null; echo "  staged (appended): $KV"
    fi
    echo "  overrides file now: $(sudo grep -h "^$KC=" "$F")"
    FAILC=0
    for CNAME in $(sudo docker ps --format '{{.Names}}' | grep -E '^admin-(backend|worker)-(blue|green)$'); do
      GOTC=$(sudo docker exec "$CNAME" sh -c "printf %s \"\$$KC\"" 2>/dev/null)
      echo "  FIX_STATE_PROCESS=($CNAME) $KC=$GOTC"
      [ "$GOTC" = "$WANTC" ] || FAILC=1
    done
    if [ "$FAILC" = "0" ]; then
      echo "  VERDICT: allowlist LIVE in-process on C (backend+worker) — marker consumed"
      sudo touch "$MARKER_FB4AC"
    else
      echo "  VERDICT: staged but NOT yet live in-process (recreate lands with the next wave's coding-box step) — marker NOT consumed; re-fires on the next dispatch"
    fi
    echo "== END FB4A18B0-C =="
  fi
  # ==ONE-SHOT-INSERT-POINT-CODING-C== (insert coding-c one-shots ABOVE this line)
  # Section sentinel (ticket 795cc5fb) — same loud-failure contract as prod's.
  echo "=== playbook coding-c-section done (ROLE=$ROLE host=$(hostname)) ==="
fi

echo "=== playbook done (ROLE=$ROLE) ==="

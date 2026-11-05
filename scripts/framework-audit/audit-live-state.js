const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }
(async () => {
  await sec('runs_4h_by_status', () => q(`SELECT status, COUNT(*)::int AS n, ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE("finishedAt", now()) - "startedAt")))/60)::int AS avg_min, MAX(attempts)::int AS max_attempts FROM agent_runs WHERE "createdAt" > now() - interval '4 hours' GROUP BY 1 ORDER BY 2 DESC`));
  await sec('runs_running_now', () => q(`SELECT LEFT(r.id::text,8) AS run, r.status, LEFT(r."sessionId"::text,8) AS chat, LEFT(c.title,40) AS title, r."workerId", r.attempts, r."currentStep", ROUND(EXTRACT(EPOCH FROM (now()-r."startedAt"))/60)::int AS run_min, ROUND(EXTRACT(EPOCH FROM (now()-r."heartbeatAt"))/60)::int AS hb_min, r."leaseExpiresAt" AS lease, (r.input->>'origin') AS trig FROM agent_runs r JOIN crossmodel_chats c ON c.id=r."sessionId" WHERE r.status IN ('running','queued') ORDER BY r.status DESC, r."startedAt" NULLS FIRST LIMIT 30`));
  // ── runs_suspect_class (firing 61, 2026-10-01) ─────────────────────────────
  // The charter names the running-row suspect rule — "a heartbeat older than
  // 5 min or a run past 3 h is suspect" — but left its application to eyeball:
  // firings 59/60/61 each re-derived it by hand on the 220–260-min nightlies
  // (hb 0, steps advancing, fresh lease ⇒ the benign long-run class). This
  // section applies the rule IN-AUDIT. Classes:
  //   hb_stale       — hb > 5 min (ACTIONABLE: the worker may be wedged)
  //   long_stale_hb  — hb > 5 min AND run > 180 min (ACTIONABLE, worst case)
  //   long_fresh_hb  — run > 180 min but hb ≤ 5 min (nightly/long-run BENIGN
  //                    class: worker alive, lease fresh — correlate steps in
  //                    runs_running_now, never fail a firing on it alone)
  //   queued_stale   — queued > 15 min (all workers busy or a claim wedge)
  //   queued_behind  — queued_stale AND a RUNNING sibling in the SAME session
  //                    (queue-behind-running, the benign one-run-per-session
  //                    lock class — f95's queued_stale pair bbf48604/23a827a5
  //                    were both behind live hb-fresh siblings; adjudicated by
  //                    eye this firing, baked now: 26th f64 bake)
  //   queued_ok / ok — inside every threshold.
  // Branch order matters: queued rows carry NULL startedAt/heartbeatAt, so the
  // status branches run FIRST (NULL comparisons fall through to 'ok' below).
  // NOTE: the ordering lives in an OUTER query — Postgres resolves ORDER BY
  // output aliases only as bare names, never inside expressions (CASE in
  // ORDER BY over an alias is "column does not exist"); the subquery makes
  // suspect_class a real column t.suspect_class.
  // f95: the sibling read is a correlated LEFT JOIN (EXISTS subquery) on the
  // FULL r."sessionId" (never LEFT(,8) — the f79 id-truncation trap) against
  // sessions with a RUNNING row; a queued row behind a QUEUED sibling stays
  // queued_stale (only a running sibling parks it as benign).
  await sec('runs_suspect_class', () => q(`SELECT * FROM (SELECT LEFT(r.id::text,8) AS run, LEFT(r."sessionId"::text,8) AS chat, r.status, ROUND(EXTRACT(EPOCH FROM (now()-r."startedAt"))/60)::int AS run_min, ROUND(EXTRACT(EPOCH FROM (now()-r."heartbeatAt"))/60)::int AS hb_min, (SELECT LEFT(s.id::text,8) FROM agent_runs s WHERE s."sessionId" = r."sessionId" AND s.status='running' AND s.id <> r.id LIMIT 1) AS sibling, CASE WHEN r.status='queued' AND r."createdAt" < now() - interval '15 minutes' AND EXISTS (SELECT 1 FROM agent_runs s2 WHERE s2."sessionId" = r."sessionId" AND s2.status='running' AND s2.id <> r.id) THEN 'queued_behind' WHEN r.status='queued' AND r."createdAt" < now() - interval '15 minutes' THEN 'queued_stale' WHEN r.status='queued' THEN 'queued_ok' WHEN ROUND(EXTRACT(EPOCH FROM (now()-r."heartbeatAt"))/60) > 5 AND ROUND(EXTRACT(EPOCH FROM (now()-r."startedAt"))/60) > 180 THEN 'long_stale_hb' WHEN ROUND(EXTRACT(EPOCH FROM (now()-r."heartbeatAt"))/60) > 5 THEN 'hb_stale' WHEN ROUND(EXTRACT(EPOCH FROM (now()-r."startedAt"))/60) > 180 THEN 'long_fresh_hb' ELSE 'ok' END AS suspect_class FROM agent_runs r WHERE r.status IN ('running','queued')) t ORDER BY CASE t.suspect_class WHEN 'long_stale_hb' THEN 0 WHEN 'hb_stale' THEN 1 WHEN 'queued_stale' THEN 2 WHEN 'queued_behind' THEN 3 WHEN 'long_fresh_hb' THEN 4 ELSE 5 END, t.run_min DESC NULLS LAST LIMIT 30`));
  // ── errors_burst_family_4h (FO firing 86, 2026-10-06) ────────────────────────
  // The errors_4h row bar adjudicates each NORMALIZED MESSAGE GROUP alone, but a
  // provider burst arrives SPLIT across groups: the 2026-10-06 LiteLLM window
  // printed 502×28 + "seat rejected the turn" glm ×13 + kimi ×12 (+400×1) — 55–57
  // rows of ONE incident, every group under the n≤30 bar, so the f84
  // absorbed:failover arm could never fire and firings 84/85/86 each re-summed
  // the family by eye. This section rolls up by SOURCE the transient-provider
  // family (any row matching a status-code or the seat-rejection phrasing) and
  // adjudicates the TOTAL: family ≤ 30 → ok; any failed run → ESCALATE (the
  // FO-38 death class, never absorbed); else code-SET overlap with seat_fallback
  // reasons → absorbed:failover; else EVERY row degrade-class → absorbed:degraded;
  // else ESCALATE. Gotchas baked: (1) codes is a SET built with
  // string_agg(DISTINCT …) and matched with && (array overlap) — a single-code
  // MIN() collapses mixed 400/502 windows and misses the overlap (the first
  // live probe returned a false ESCALATE exactly this way); (2) the
  // rejected-the-turn rows carry NO code — a code-less family still counts as
  // absorbed when ANY seat_fallback fired (s.any_fallback), since those rows
  // are the lead-seat rejection face of the same burst; (3) the failed_runs /
  // seat_fallback legs are one-row INNER subqueries — Postgres is free to
  // reorder CROSS JOIN legs, and every family row sees them as plain columns.
  // (4) f210 (2026-10-26): degrade-absorbed rung. A retrieval/semantic-leg 429
  // storm arrives as null-source rows whose absorption is CALLER-SIDE
  // ('caller degrades to no-retrieval / in-scope retrieval', 'keyword leg still
  // runs') — it never touches seat_fallback, so the failover rungs cannot see it
  // and a >30-row storm read a false ESCALATE (f210 live: null-source family
  // 70/70 rows degrade-class, failed_runs 0 — the embeddings-429 degraded
  // window). The rung is STRICT equality (every row degrade-class): a single
  // non-degraded row keeps the family on the failover/ESCALATE path, so a real
  // 502 burst riding inside the storm still alarms; the failed_runs ESCALATE
  // rung stays above it regardless. degraded_n is surfaced in the row so the
  // firing reads the composition without a follow-up probe.
  await sec('errors_burst_family_4h', () => q(`SELECT t.src AS source, t.family_n, t.degraded_n, t.codes, s.codes AS fallback_codes, f.failed_runs, CASE WHEN t.family_n <= 30 THEN 'ok' WHEN f.failed_runs > 0 THEN 'ESCALATE' WHEN COALESCE(t.codes, '{}') && s.codes THEN 'absorbed:failover' WHEN cardinality(COALESCE(t.codes, '{}')) = 0 AND s.any_fallback THEN 'absorbed:failover' WHEN t.degraded_n = t.family_n THEN 'absorbed:degraded' ELSE 'ESCALATE' END AS verdict FROM (SELECT source AS src, COUNT(*)::int AS family_n, COUNT(*) FILTER (WHERE message ~ 'caller degrades to (no-retrieval|in-scope retrieval)' OR message ~ 'keyword leg still runs')::int AS degraded_n, string_to_array(string_agg(DISTINCT (regexp_match(message, 'status code ([0-9]{3})'))[1], ','), ',') AS codes FROM app_error_logs WHERE "createdAt" > now() - interval '4 hours' AND (message ~ 'status code [0-9]{3}' OR message ~ 'rejected the turn') GROUP BY 1) t, (SELECT COUNT(*)::int AS failed_runs FROM agent_runs WHERE status='failed' AND "createdAt" > now() - interval '4 hours') f, (SELECT string_to_array(string_agg(DISTINCT (regexp_match(meta->>'reason', 'HTTP ([0-9]{3})'))[1], ','), ',') AS codes, COUNT(*) > 0 AS any_fallback FROM loop_metrics WHERE kind='seat_fallback' AND "createdAt" > now() - interval '4 hours') s ORDER BY t.family_n DESC`));
  await sec('runs_failed_4h', () => q(`SELECT LEFT(r."sessionId"::text,8) AS chat, LEFT(c.title,36) AS title, COUNT(*)::int AS n, MAX(LEFT(r.error,140)) AS err FROM agent_runs r JOIN crossmodel_chats c ON c.id=r."sessionId" WHERE r.status='failed' AND r."createdAt" > now() - interval '4 hours' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`));
  await sec('runs_interrupted_24h', () => q(`SELECT date_trunc('hour', r."updatedAt") AS h, COUNT(*)::int AS n FROM agent_runs r WHERE r.status='interrupted' AND r."updatedAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`));
  // ── run_lock_paired_now (firing 28, 2026-09-26) ─────────────────────────────
  // Redis lock keys and DB running rows read as SEPARATE calls straddle run
  // churn and masquerade as a leak (firing 26 spent a triage leg on 3 keys vs
  // 5 rows; firing 28 re-hit it as 6 vs 7). The decisive probe is PAIRED
  // SAME-INSTANT reads matched by sessionId — now standing, not hand-rolled.
  // A session flags ONLY if it stays unmatched across BOTH a first read and a
  // 2s-later re-read (churn settles; a real leak persists). Uses a raw client
  // from process.env.REDIS_URL — NEVER the app's redis singleton (its winston
  // console transport prints '✅ Redis connected' to stdout and corrupts this
  // probe's JSON) and never infra-watch.service (ClientClosedError exit crash,
  // firing-13). SCAN, not KEYS.
  await sec('run_lock_paired_now', async () => {
    let redis = null;
    try {
      // Absolute path: prodq copies this probe to /tmp inside the container, and
      // node resolves bare 'redis' relative to /tmp (no node_modules there) — the
      // live pre-commit check caught exactly that. Same package the backend uses.
      const { createClient } = require('/app/node_modules/redis');
      redis = createClient({ url: process.env.REDIS_URL });
      redis.on('error', () => {});
      await redis.connect();
      const readOnce = async () => {
        const keys = new Set();
        for await (const k of redis.scanIterator({ MATCH: 'coding:session:run:*', COUNT: 200 })) keys.add(k.replace('coding:session:run:', ''));
        const rows = await q(`SELECT "sessionId"::text AS sess, LEFT(id::text,8) AS run, status, "startedAt", ROUND(EXTRACT(EPOCH FROM (now()-"heartbeatAt")))::int AS hb_age_s, ("leaseExpiresAt" > now()) AS lease_live FROM agent_runs WHERE status IN ('running','queued')`);
        return { keys, rows };
      };
      const first = await readOnce();
      await new Promise((r) => setTimeout(r, 2000));
      const second = await readOnce();
      const running1 = first.rows.filter((r) => r.status === 'running');
      const running2 = second.rows.filter((r) => r.status === 'running');
      const unmatched = running2.filter((r) => !second.keys.has(r.sess) && !first.keys.has(r.sess))
        .map((r) => ({ sess: r.sess.slice(-12), run: r.run, hb_age_s: r.hb_age_s, lease_live: r.lease_live }));
      const orphan_locks = [...second.keys].filter((s) => !running2.some((r) => r.sess === s)).map((s) => s.slice(-12));
      return {
        at: new Date().toISOString(),
        n_lock_keys_1: first.keys.size, n_running_rows_1: running1.length,
        n_lock_keys_2: second.keys.size, n_running_rows_2: running2.length,
        unmatched_running: unmatched,   // empty = no leak; non-empty = REAL (persisted across both reads)
        orphan_locks,                  // a lock with no running row (expired-lease sweep lag is benign under 5 min)
        all_hb_fresh: running2.every((r) => r.hb_age_s <= 300),
        max_hb_age_s: running2.reduce((m, r) => Math.max(m, r.hb_age_s), 0),
      };
    } finally {
      if (redis && redis.isOpen) await redis.quit().catch(() => {});
    }
  });
  await sec('active_chats_4h', () => q(`SELECT LEFT(r."sessionId"::text,8) AS chat, LEFT(c.title,40) AS title, COUNT(*)::int AS runs, SUM(CASE WHEN r.status='completed' THEN 1 ELSE 0 END)::int AS ok, SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END)::int AS failed, SUM(CASE WHEN r.status='interrupted' THEN 1 ELSE 0 END)::int AS intr, ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(r."finishedAt", now()) - r."startedAt")))/60)::int AS avg_min, MAX(r."startedAt") AS last FROM agent_runs r JOIN crossmodel_chats c ON c.id=r."sessionId" WHERE r."createdAt" > now() - interval '4 hours' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40`));
  await sec('supervisors', () => q(`SELECT LEFT(s."chatId"::text,8) AS chat, LEFT(c.title,40) AS title, s."updatedAt" AS state_updated, (SELECT COUNT(*)::int FROM agent_runs r WHERE r."sessionId"=s."chatId" AND r."createdAt" > now() - interval '4 hours') AS runs_4h, (SELECT COUNT(*)::int FROM agent_runs r WHERE r."sessionId"=s."chatId" AND r.status='failed' AND r."createdAt" > now() - interval '4 hours') AS failed_4h, (SELECT COUNT(*)::int FROM hook_events he JOIN event_hooks eh ON eh.id=he."hookId" WHERE eh."targetChatId"=s."chatId" AND he."createdAt" > now() - interval '4 hours') AS hook_events_4h, (SELECT COUNT(*)::int FROM hook_events he JOIN event_hooks eh ON eh.id=he."hookId" WHERE eh."targetChatId"=s."chatId" AND he.status='delivered' AND he."createdAt" > now() - interval '4 hours') AS delivered_4h, (SELECT COUNT(*)::int FROM hook_events he JOIN event_hooks eh ON eh.id=he."hookId" WHERE eh."targetChatId"=s."chatId" AND he.status LIKE 'failed%' AND he."createdAt" > now() - interval '4 hours') AS failed_hooks_4h, (SELECT COUNT(*)::int FROM hook_events he JOIN event_hooks eh ON eh.id=he."hookId" WHERE eh."targetChatId"=s."chatId" AND he.status IN ('pending','delivering')) AS backlog FROM supervisor_states s JOIN crossmodel_chats c ON c.id=s."chatId" ORDER BY 4 DESC`));
  await sec('hook_events_4h_by_status', () => q(`SELECT status, COUNT(*)::int AS n, MIN("createdAt") AS oldest FROM hook_events WHERE "createdAt" > now() - interval '4 hours' GROUP BY 1 ORDER BY 2 DESC`));
  await sec('hook_backlog', () => q(`SELECT he.status, he."eventType", LEFT(eh."targetChatId"::text,8) AS target, COUNT(*)::int AS n, MIN(he."createdAt") AS oldest, MAX(he.attempts)::int AS max_att, MIN(he."retryAt") AS next_retry FROM hook_events he JOIN event_hooks eh ON eh.id=he."hookId" WHERE he.status IN ('pending','delivering') GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 15`));
  // ── hook_failed_4h verdict (firing 73, 2026-10-04) ───────────────────────────
  // The charter's hook-failure bar was prose: 'failed% rows need eyes, but
  // source_gone/target_gone are documented terminal drops (a deleted/re-owned
  // chat — hooks.service.ts HOOK_STATUS_SOURCE_GONE, 2026-09-19)'. Firing 73
  // spent FIVE hand-rolled probe rounds adjudicating 16 source_gone rows from
  // the live e2e suite's ephemeral chats (PR #1236) because the section printed
  // only status+target+sample — no source identity, no dead-chat verdict. The
  // bar now prints natively:
  //   dead_source / dead_target — the terminal class did its job: the source
  //     (target) chat is gone OR no longer owned by the hook's user, exactly
  //     the documented drop condition. REPORTED, not ok, so the class is
  //     self-describing (same shape as hook_oldest_pending_now's busy:park).
  //   misclassed — the sweep terminal-marked a row whose source/target is
  //     STILL owned by the hook's user: a classification defect → ESCALATE.
  //   ESCALATE — any other failed% status (real delivery failure: 'failed',
  //     'failed:horizon', …) or a misclass above.
  // src_title/n_sources identify the emitter inline (firing 73's rows were all
  // 'e2e suite NN-…' chats — visible at a glance once this column existed).
  await sec('hook_failed_4h', () => q(`SELECT he.status, he."eventType", LEFT(eh."targetChatId"::text,8) AS target, COUNT(*)::int AS n, COUNT(DISTINCT he.payload->>'sourceChatId')::int AS n_sources, LEFT(MAX(he.payload->>'sourceChatTitle'),28) AS src_title, BOOL_OR(EXISTS (SELECT 1 FROM crossmodel_chats c WHERE c.id::text = he.payload->>'sourceChatId' AND c."userId" = he."userId")) AS any_source_live, CASE WHEN he.status='failed:source_gone' AND NOT BOOL_OR(EXISTS (SELECT 1 FROM crossmodel_chats c WHERE c.id::text = he.payload->>'sourceChatId' AND c."userId" = he."userId")) THEN 'dead_source' WHEN he.status='failed:target_gone' AND NOT BOOL_OR(EXISTS (SELECT 1 FROM crossmodel_chats c WHERE c.id = eh."targetChatId" AND c."userId" = he."userId")) THEN 'dead_target' WHEN he.status IN ('failed:source_gone','failed:target_gone') THEN 'misclassed' ELSE 'ESCALATE' END AS verdict, MAX(LEFT(he.payload->>'summary',100)) AS sample FROM hook_events he JOIN event_hooks eh ON eh.id=he."hookId" WHERE he.status LIKE 'failed%' AND he."createdAt" > now() - interval '4 hours' GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 15`));
  await sec('metric_kinds_4h', () => q(`SELECT kind, COUNT(*)::int AS n FROM loop_metrics WHERE "createdAt" > now() - interval '4 hours' GROUP BY 1 ORDER BY 2 DESC`));
  await sec('guard_4h', () => q(`SELECT kind, COALESCE(meta->>'detector', meta->>'seam', meta->>'reason','?') AS d, COALESCE(meta->>'outcome', meta->>'state', 'cost-row') AS outcome, COUNT(*)::int AS n FROM loop_metrics WHERE kind IN ('guard_strike','guard_miss') AND "createdAt" > now() - interval '4 hours' GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 15`));
  await sec('zero_tool_4h', () => q(`SELECT COALESCE(meta->>'model','?') AS model, COALESCE(meta->>'triggerKind','?') AS trig, COUNT(*)::int AS n FROM loop_metrics WHERE kind IN ('zero_tool_final','zero_tool_gate') AND "createdAt" > now() - interval '4 hours' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`));
  // ── deploy_interrupt_24h (f99 seam fix, 2026-10-08) ─────────────────────────
  // WAS crossmodel_messages origin='deploy-interrupt' — but the escalation-rung
  // and continuation requeue paths (shutdown-interrupt.ts) requeue via Redis and
  // deliberately write NO notice row, so the message-keyed count read 0 while a
  // real user turn was cut (live 2026-10-08 07:37Z, chat 182f27b7, research
  // rung — re-fired and done 08:03Z). The authoritative seam is the SAME one the
  // fleet deploy view reads: loop_metrics kind='chat_run_interrupted' reason
  // 'deploy'. Bar = the deploy view's own: a singleton re-fires by design
  // (re_fired), a REPEAT on the same chat means its wakes outlive the drain
  // budget (drain_budget_repeat).
  await sec('deploy_interrupt_24h', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, COUNT(*)::int AS n, MAX("createdAt") AS last_at, MAX((meta->>'runAgeSeconds')::int) AS max_age_s, BOOL_OR(COALESCE(meta->>'isSupervisorWake','false')::boolean) AS any_supervisor, CASE WHEN COUNT(*) >= 2 THEN 'drain_budget_repeat' ELSE 're_fired' END AS verdict FROM loop_metrics WHERE kind='chat_run_interrupted' AND meta->>'reason'='deploy' AND "createdAt" > now() - interval '24 hours' AND "sessionId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 12`));
  await sec('retiring_deferred_24h', () => q(`SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM loop_metrics WHERE kind='machine_start_deferred_retiring' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`));
  // ── merge_gate_failure_24h (firing 100, 2026-10-08 — 30th f64 bake) ────────
  // A merge-gate refusal is BY-DESIGN telemetry (the gate did its job — it
  // refused a merge whose gates were red/dirty), but until now it appeared
  // ONLY as a raw count inside metric_kinds_4h, so every firing that saw n>0
  // hand-ran a box probe to adjudicate it (firing 100 did: the row was this
  // lane's own PR #1353, mergeable=false state=dirty at 10:56Z, recovered by
  // rebase + merge at 11:06Z). This bake adjudicates IN-AUDIT: verdict
  //   recovered    — a merge_success row exists for the SAME repo+PR AFTER
  //                  the failure (the lane or the owner landed it)
  //   in_flight    — no recovery yet, failure younger than 6 h (the lane may
  //                  be mid-recovery — firing 100's own row read this class
  //                  for 10 minutes; never fail a firing on it alone)
  //   moved_on     — (f104, 2026-10-09 — 34th f64 bake) no recovery for THIS
  //                  PR, but the same session has NEWER merge-gate traffic
  //                  (a merge_gate_failure or merge_success) on a DIFFERENT
  //                  repo+PR: the lane superseded the PR — the owner closed
  //                  it unmerged and the lane opened/merged a successor. The
  //                  same false-positive class hit firing 101 (PR #1344,
  //                  adjudicated by hand as "by-design-closed-unmerged; allow
  //                  to age out") and firing 104 (PR #27 stanne-ctrlplaneui,
  //                  closed 02:43Z, superseded by PR #33 from the same lane
  //                  at 03:07Z): the closed-unmerged PR can NEVER recover, so
  //                  the old bar read ESCALATE for its whole 24h life. DB-
  //                  native by design — the successor traffic IS the evidence.
  //   ESCALATE     — no recovery, no successor, failure older than 6 h: two FO
  //                  firings have passed without resolution (a genuinely
  //                  stuck PR — the gate refusal is fine, the ABANDON is the
  //                  defect). A PR the owner closes unmerged with NO successor
  //                  still lands here by design: it wants ONE operator look,
  //                  not a silent zero.
  // The 6h rung is the detail's OWN bar (this bake defines it) and the
  // rollup condition merge_gate_failure_dangling_24h copies it verbatim
  // (f104: including the moved_on exclusion — the rollup counts ONLY the
  // rows the detail adjudicates ESCALATE).
  await sec('merge_gate_failure_24h', () => q(`SELECT LEFT(m."sessionId"::text,8) AS chat, m.meta->>'repo' AS repo, COALESCE(m.meta->>'pullNumber','?') AS pr, m.meta->>'gate' AS gate, LEFT(COALESCE(m.meta->>'cause','?'),60) AS cause, m."createdAt" AS at, ROUND(EXTRACT(EPOCH FROM (now()-m."createdAt"))/3600)::int AS age_h, EXISTS (SELECT 1 FROM loop_metrics s WHERE s.kind='merge_success' AND s."createdAt" > m."createdAt" AND s.meta->>'pullNumber' = m.meta->>'pullNumber' AND s.meta->>'repo' = m.meta->>'repo') AS recovered, CASE WHEN EXISTS (SELECT 1 FROM loop_metrics s WHERE s.kind='merge_success' AND s."createdAt" > m."createdAt" AND s.meta->>'pullNumber' = m.meta->>'pullNumber' AND s.meta->>'repo' = m.meta->>'repo') THEN 'recovered' WHEN EXISTS (SELECT 1 FROM loop_metrics t WHERE t.kind IN ('merge_gate_failure','merge_success') AND t."sessionId" = m."sessionId" AND t."createdAt" > m."createdAt" AND (t.meta->>'repo', t.meta->>'pullNumber') <> (m.meta->>'repo', m.meta->>'pullNumber')) THEN 'moved_on' WHEN now() - m."createdAt" > interval '6 hours' THEN 'ESCALATE' ELSE 'in_flight' END AS verdict FROM loop_metrics m WHERE m.kind='merge_gate_failure' AND m."createdAt" > now() - interval '24 hours' ORDER BY m."createdAt" DESC LIMIT 12`));
  // ── deploy_ci_red_24h (firing 102, 2026-10-08 — 32nd f64 bake) ──────────────
  // A red deploy run (infra_alert kind=deploy ciVerdict=failure) was until now
  // ONLY a raw count in the rollup (infra_alert_ci_red_24h escalated on ANY
  // n>0 inside 24h), so every firing hand-probed GitHub to adjudicate — and
  // firing 102 found BOTH its window's red runs (37827561943 a90fed4c,
  // 37827970155 789ef7d7, both 18:5x–19:0xZ) failed the SAME single test
  // (openapi drift 'get /api/crossmodel/refs/{kind}/{id}') that the f101
  // squash 3b4375b fixed at 19:28Z — recovered, but the rollup still said
  // ESCALATE. Same shape as the f100 merge-gate bake: adjudicate IN-AUDIT on
  // a recovery row stamped by the infra-watch sweep (deploy_wave_success —
  // one per successful deploy run, meta.at = the run's conclusion time):
  //   recovered — a deploy_wave_success concluded AFTER the alert was raised
  //               (a green wave landed; main is deploying again)
  //   in_flight — no green wave yet, alert younger than 6 h (a fix lane may
  //               be mid-repair; never fail a firing on it alone)
  //   ESCALATE  — no green wave and older than 6 h: main has not deployed for
  //               two firings' worth of red (the fix lane abandoned it).
  // The rollup condition infra_alert_ci_red_24h now counts the SAME
  // adjudicated population (rows with NO later deploy_wave_success older than
  // 6 h) instead of every red row.
  await sec('deploy_ci_red_24h', () => q(`SELECT m.meta->>'runId' AS run_id, m.meta->>'sha' AS sha, LEFT(COALESCE(m.meta->>'ciVerdict','?'),10) AS ci_verdict, m."createdAt" AS at, ROUND(EXTRACT(EPOCH FROM (now()-m."createdAt"))/3600)::int AS age_h, EXISTS (SELECT 1 FROM loop_metrics s WHERE s.kind='deploy_wave_success' AND (s.meta->>'at')::timestamptz > m."createdAt") AS recovered, CASE WHEN EXISTS (SELECT 1 FROM loop_metrics s WHERE s.kind='deploy_wave_success' AND (s.meta->>'at')::timestamptz > m."createdAt") THEN 'recovered' WHEN now() - m."createdAt" > interval '6 hours' THEN 'ESCALATE' ELSE 'in_flight' END AS verdict FROM loop_metrics m WHERE m.kind='infra_alert' AND m.meta->>'kind'='deploy' AND m.meta->>'ciVerdict' = 'failure' AND m."createdAt" > now() - interval '24 hours' ORDER BY m."createdAt" DESC LIMIT 12`));
  await sec('crosscheck_late', () => q(`SELECT meta->>'outcome' AS outcome, COUNT(*)::int AS n, ROUND(AVG((meta->>'checkerTimeMs')::numeric)/1000)::int AS avg_checker_s, ROUND(AVG((meta->>'waitedMs')::numeric)/1000)::int AS avg_wait_s FROM loop_metrics WHERE kind='crosscheck_late_reconcile' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`));
  // ── crosscheck_failed_detail (firing 25, 2026-09-26) ────────────────────────
  // The aggregate above counts outcomes but strips WHO and WHY: firing 25 spent
  // two hand-rolled probes and still could not triage two `reconcile_failed`
  // rows (the pre-fix metric meta carried no reason, and the chat attribution
  // only lives in sessionId). Rows here carry the chat, the reason (post-fix
  // writer stamps meta.reason — 'reconcile resolved empty' vs the thrown error;
  // pre-fix rows read as null), and the first 160 chars of any summary.
  // ── verdict column (firing 74, 2026-10-04 — 8th f64 bake) ──────────────────
  // Firing 74 spent a hand-rolled probe round triaging two reconcile_failed
  // rows that were both the e2e suite's expected footprint (one chat already
  // torn down → Prisma FK error; one live 'e2e suite NN-…' title → empty
  // resolve). Bake that bar: chat_title + chat_live + verdict —
  // 'e2e_ephemeral' (title LIKE 'e2e suite%') or 'dead_chat' (chat row gone)
  // are REPORTED (documented terminal classes), 'ESCALATE' means a live,
  // non-e2e chat failed to reconcile — a real defect needing a probe.
  // ── recurrence_7d column (firing 85, 2026-10-06 — 19th f64 bake) ──────────
  // Firings 84 AND 85 each spent a hand-rolled 7-day recurrence probe on the
  // SAME live-chat row (b8d8dd38): a live chat whose reconcile_failed occurs
  // exactly once in 7 days is agent behavior (watch-only, re-check next
  // firing), a recurrence ≥ 2 is a real defect. Bake that bar: the inner
  // query computes recurrence_7d (a correlated count over 7 days, same
  // session) and the outer CASE reads it as a plain column (f61 rule).
  // Verdict ladder: e2e_ephemeral → dead_chat → single live occurrence reads
  // as the live-once class → ESCALATE only when it recurs or the classes
  // above do not apply.
  await sec('crosscheck_failed_detail', () => q(`SELECT chat, outcome, chat_title, chat_live, recurrence_7d, CASE WHEN chat_title LIKE 'e2e suite%' THEN 'e2e_ephemeral' WHEN NOT chat_live THEN 'dead_chat' WHEN recurrence_7d <= 1 THEN 'live:once' ELSE 'ESCALATE' END AS verdict, reason, "createdAt" FROM (SELECT LEFT(m."sessionId"::text,8) AS chat, m.meta->>'outcome' AS outcome, LEFT(c.title,40) AS chat_title, (c.id IS NOT NULL) AS chat_live, (SELECT COUNT(*)::int FROM loop_metrics m7 WHERE m7.kind='crosscheck_late_reconcile' AND m7.meta->>'outcome'='reconcile_failed' AND m7."sessionId" = m."sessionId" AND m7."createdAt" > now() - interval '7 days') AS recurrence_7d, LEFT(COALESCE(m.meta->>'reason','(no reason — pre-firing-25 row)'),120) AS reason, m."createdAt" FROM loop_metrics m LEFT JOIN crossmodel_chats c ON c.id = m."sessionId" WHERE m.kind='crosscheck_late_reconcile' AND m."createdAt" > now() - interval '24 hours' AND m.meta->>'outcome' IN ('reconcile_failed','timeout') ORDER BY m."createdAt" DESC LIMIT 12) f`));
  // ── alerts self-attribution (firing 62, 2026-10-02) ──────────────────────────
  // Every infra_alert/product_alert emitter stamps its class in meta.kind (backup
  // / disk / silent / deploy / cards / decision_backend / followups — the
  // infra-watch.service.ts deliver() callers + product-watch.service.ts), but
  // the old k read meta->>'key'/'class'/'reason' — fields NO emitter stamps — so
  // every row read k:'' and attributing an alert needed a one-off probe (firing
  // 62's 00:03Z stop_run cards alert, ticket 62365255, took exactly that). k now
  // reads the real field first; alerts_detail_24h carries a meta snippet so the
  // ticketId / host / runId is visible in the audit itself.
  // ── Deploy-alert flake bar (FO firing 77, 11th f64 bake) ────────────────────
  // The infra-watch deploy emitters stamp the SAME-SHA CI verdict into each
  // alert's meta (infra-watch.service.ts attachCiVerdicts → deliver meta
  // {kind:'deploy', runId, sha, ciVerdict}). The adjudication rule every
  // firing re-derived by eye (f76/f77: 1eda8bcd, 5ff43f4f, da80afa9, 2c2718f4,
  // aeeeda5b — deploy failed but same-sha ci.yml green → rolled flake of the
  // twice-run suite, re-run playbook, NOT a code defect) is now the verdict
  // column: flake_ci_green = REPORTED (re-run the wave per the alert
  // playbook), ci_red_too = real defect (fix lane), no_ci_verdict = the CI
  // fetch failed (fix-lane playbook applies), non_deploy = adjudicate per
  // alert class as before.
  await sec('alerts_24h', () => q(`SELECT kind, LEFT(COALESCE(meta->>'kind', meta->>'key', meta->>'class', meta->>'reason', '(unclassified)'),40) AS k, COUNT(*)::int AS n, MAX("createdAt") AS last, CASE WHEN kind='infra_alert' AND COALESCE(meta->>'kind','')='deploy' THEN CASE meta->>'ciVerdict' WHEN 'success' THEN 'flake_ci_green' WHEN 'failure' THEN 'ci_red_too' ELSE 'no_ci_verdict' END ELSE 'non_deploy' END AS verdict FROM loop_metrics WHERE kind IN ('infra_alert','product_alert') AND COALESCE(meta->>'outcome','') <> 'enqueue_failed' AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2,5 ORDER BY 4 DESC`));
  await sec('alerts_detail_24h', () => q(`SELECT kind, LEFT(COALESCE(meta->>'kind', meta->>'key', meta->>'class', meta->>'reason', '(unclassified)'),40) AS k, LEFT(meta::text, 220) AS sample, "createdAt" FROM loop_metrics WHERE kind IN ('infra_alert','product_alert') AND COALESCE(meta->>'outcome','') <> 'enqueue_failed' AND "createdAt" > now() - interval '24 hours' ORDER BY "createdAt" DESC LIMIT 12`));
  await sec('box_health', () => q(`SELECT DISTINCT ON (meta->>'host', meta->>'process') meta->>'host' AS host, meta->>'process' AS process, meta->>'sha' AS sha, meta->>'diskPct' AS disk, meta->>'upMin' AS up_min, meta->'backup'->>'ageH' AS backup_h, meta->'backup'->>'count' AS backup_count, meta->'backup'->>'newestAt' AS backup_newest, "createdAt" FROM loop_metrics WHERE kind='box_health' AND "createdAt" > now() - interval '30 minutes' ORDER BY meta->>'host', meta->>'process', "createdAt" DESC`));
  // ── Backup FLEET verdict (2026-09-23, firing 13) ───────────────────────────
  // box_health above shows EVERY host's backup age, but only the backup
  // PRODUCER's reading is load-bearing: docs/BACKUPS.md — "the nightly pg_dump
  // timer + role wiring live on A only; B's timer is stopped+disabled" — and
  // ticket cc1ca2bf (8caf95b45) already made the ALERT producer-only. The
  // readout never said so, so every firing re-derived box-b's by-design ~140 h
  // "stale" reading by hand (firing 13 spent a full triage leg on it). This
  // section stamps producer-ness per host and computes the fleet verdict with
  // the SAME rule the writer's classifyBackupAge uses — producers only; no
  // producer row in 24 h = lapse; mounted producer with no dumps = missing;
  // freshest producer dump older than BACKUP_STALE_H (30) = stale — so the
  // design lives in the readout instead of in operator memory. Producers come
  // from the writer's own env knob (BACKUP_PRODUCER_HOSTS, box-a default) so
  // the two can never disagree. Deliberately dependency-free: do NOT import
  // infra-watch here — requiring it inside a prodq probe crashes the process
  // exit (ClientClosedError from the redis client, firing-13 precheck).
  await sec('backup_fleet', async () => {
    const producers = String(process.env.BACKUP_PRODUCER_HOSTS || 'box-a').split(',').map((s) => s.trim()).filter(Boolean);
    // Backup fields come from the newest BACKUP-BEARING row per host (the
    // writer's producerBackupLastSeenAt semantics), NOT the newest row of any
    // kind: web mounts /backups, the worker does not, and the two stamp within
    // ~1 s of each other every sweep — reading the plain newest row makes the
    // worker's mountless row shadow web's reading whenever it lands second
    // (caught live on the first post-wave probe: verdict flapped to 'unknown'
    // with a "no reading in 24h" note while a 14.8 h reading sat 30 s older).
    // Heartbeat stays a full-window MAX so a producer with NO backup-bearing
    // row is still visible (the true mount-loss/lapse case).
    const rows = await q(`SELECT h.host, hb.age_h, hb.dump_count, hb.newest_at, hb.backup_mounted, h.last_heartbeat FROM (SELECT meta->>'host' AS host, MAX("createdAt") AS last_heartbeat FROM loop_metrics WHERE kind='box_health' AND "createdAt" > now() - interval '24 hours' GROUP BY 1) h LEFT JOIN (SELECT DISTINCT ON (meta->>'host') meta->>'host' AS host, TRUE AS backup_mounted, meta->'backup'->>'ageH' AS age_h, (meta->'backup'->>'count')::int AS dump_count, meta->'backup'->>'newestAt' AS newest_at, "createdAt" AS backup_seen_at FROM loop_metrics WHERE kind='box_health' AND (meta->'backup') IS NOT NULL AND "createdAt" > now() - interval '24 hours' ORDER BY 1, "createdAt" DESC) hb ON hb.host = h.host`);
    // status marker (FO firing 21, 2026-09-25): digby-backup.sh writes
    // backup-status.json next to the dumps; the backend's read-only /backups
    // mount sees it. A 'failed' marker not superseded by a newer dump means
    // the latest nightly RUN died (the 2026-09-25 egress-guard class) — this
    // readout mirrors that immediately instead of waiting for the 30 h age rule.
    let status_marker = null;
    try {
      const fs = require('fs');
      const raw = fs.readFileSync('/backups/backup-status.json', 'utf8');
      const j = JSON.parse(raw);
      if (j.status === 'ok' || j.status === 'failed') status_marker = { status: j.status, at: j.at ?? null, error: j.error ?? null };
    } catch { /* absent (pre-2026-09-25 script) or unreadable — age rule alone */ }
    const hosts = rows.map((r) => ({ host: r.host, producer: producers.includes(r.host), backup_mounted: !!r.backup_mounted, age_h: r.age_h == null ? null : Number(r.age_h), dump_count: r.dump_count, newest_at: r.newest_at }));
    const producerRows = hosts.filter((h) => h.producer);
    let verdict;
    if (!producerRows.length) {
      verdict = { state: 'lapse', note: `no box_health heartbeat in 24h for producer(s): ${producers.join(', ')}` };
    } else {
      const mounted = producerRows.filter((h) => h.backup_mounted);
      const withDumps = mounted.filter((h) => (h.dump_count ?? 0) > 0 && h.age_h != null);
      if (!mounted.length) {
        verdict = { state: 'unknown', note: 'producer heartbeat fresh but no /backups mount reading in 24h' };
      } else if (!withDumps.length) {
        verdict = { state: 'missing', host: mounted[0].host, note: 'producer sees the mount but reports zero dumps' };
      } else {
        const freshest = withDumps.reduce((a, b) => (a.age_h <= b.age_h ? a : b));
        verdict = freshest.age_h > 30
          ? { state: 'stale', host: freshest.host, age_h: freshest.age_h, newest_at: freshest.newest_at }
          : { state: 'ok', host: freshest.host, age_h: freshest.age_h, newest_at: freshest.newest_at };
      }
    }
    if (status_marker && status_marker.status === 'failed') {
      const superseded = hosts.some((h) => h.producer && h.newest_at && status_marker.at && Date.parse(h.newest_at) > Date.parse(status_marker.at));
      if (!superseded) verdict = { state: 'failed', host: (producerRows[0] ?? {}).host, marker: status_marker, note: 'backup-status.json says the latest nightly run FAILED — see journalctl -u digby-backup.service (the 2026-09-25 egress-guard class)' };
    }
    return { producers, stale_h: 30, verdict, status_marker, hosts, note: 'non-producer hosts (box-b/c) have no backup timer BY DESIGN (docs/BACKUPS.md) — their age is a leftover artifact, never an alarm' };
  });
  // ── errors_4h spike bar (FO firing 65, 2026-10-02; absorbed arm FO firing 84) ─
  // The charter names the spike bar in PROSE only ("a message class > 30/4 h is
  // a spike", FRAMEWORK_OPERATOR.md §checklist-1) — the section printed raw n,
  // so every firing re-derived the comparison by eye across up to 15 rows (the
  // same by-eye cost the f64 verdict column removed from the by_email section).
  // Bar now computed in-row; aggregates restated inside the CASE (f61 rule:
  // Postgres resolves SELECT aliases only as bare ORDER BY/GROUP BY names).
  // ABSORBED ARM (18th f64 bake, firing 84, 2026-10-05): a transient-provider
  // burst (HTTP 5xx/429 "coding agent turn failed") that the sticky seat
  // failover (ticket fe6f0b0b) ABSORBED prints bare ESCALATE and costs a
  // hand-rolled probe to adjudicate — firing 84's 502×32 class was exactly
  // this (32 seat_fallback rows reason 'HTTP 502', 0 failed runs, 13
  // completed). The arm downgrades to the absorbed class ONLY when ALL THREE
  // hold: the class carries an HTTP status code, seat_fallback rows in the
  // window name that same code, and NO agent_run failed in the window (any
  // failed run keeps ESCALATE — conservative by design; a death the failover
  // did not absorb is the ticketed 225b878f/FO-38 class). http_code is
  // computed as a per-group aggregate in the inner query so the outer CASE
  // sees it as a plain column (f61 outer-subquery rule, same as
  // runs_suspect_class).
  // VENDOR-TRANSIENT ARM (33rd f64 bake, FO firing 170, 2026-10-20): a
  // BrightData vendor degradation ramps the pinned web-search wrapper classes
  // past the n>30 bar for HOURS with zero user impact, and the firing
  // hand-adjudicates the same rows "vendor-transient, ok" — f169 read
  // n:11/n:13 (ok), f170 read the SAME classes at n:185/113/49/36 after the
  // 08:00Z onset and hand-proved vendor-side (hourly distribution: onset
  // 08:00-09:00Z PREDATING the 4024e26ac CI start 08:54Z and the edbf40c5
  // deploy; BOTH the direct and MCP lanes degrading together; BrightData's
  // own 504 Gateway Time-out pages at 10:18Z; six consecutive 4h buckets over
  // 30 raw rows across 7d, failed_runs = 0 in EVERY bucket; zero failed agent
  // runs in 12h). The arm downgrades ONLY when ALL hold: the normalized group
  // is one of the two vendor-call wrappers (BrightData direct: / Digby Web
  // Search:), the message matches a KNOWN-transient shape (timeout / timed
  // out / missing organic results / status code 50x / transient 50x retry —
  // 40x auth+billing is NEVER pinned: the revoked-key class must keep
  // ESCALATE), and NO agent_run failed in the window (any failed run keeps
  // ESCALATE — same conservative impact axis as the absorbed arm). New
  // signatures outside the pin list still ESCALATE — the bar change covers
  // exactly the measured population, never a blanket source exemption.
  // f180 (2026-10-22) pinned signature 2: 'credential-gate: store row %' —
  // the c54074df/7caf07ed state-check leg logging (warn, by design) that a
  // stored credential holds a key-ID-shaped value in its SECRET slot and the
  // gate stays SHUT until the owner re-stores. The owner-gate-sweeper
  // re-checks the open card every 5 min, so a single corrupt row prints
  // ~50 rows/4h and tripped the n>30 bar (live: CANLAW_CPT_S3_*, 57 rows).
  // The SHUT outcome is the fix working, not a live defect; the remediation
  // (owner re-store) is reported up, never fixed detector-side. Any failed
  // run in-window keeps ESCALATE (same conservative axis).
  // f182 (2026-10-22) pinned signature 3: 'sanitizeMessages: repaired%' —
  // the coding-model.ts request-build repair (warn, by design, "observe/
  // record only") that drops-or-placeholders an upstream-assembled empty
  // assistant turn so Moonshot stops 400-ing the whole turn (Review
  // 2026-09-13 issue 9). A burst tripped the n>30 bar: 135 rows 04:27→
  // 08:57Z Oct 22, ALL placeholder=1, then self-stopped; class history is
  // the Sep 14/15 incident (n=557/1148) → month-long silence → this burst,
  // i.e. provider-side reasoning-only/truncated turns, not a Digby
  // regression. The repair IS the mitigation working; the empty-turn source
  // is provider behaviour the request build cannot prevent. Any failed run
  // in-window keeps ESCALATE (same conservative axis).
  // ⚠ RETIRED-BY-DESIGN (2026-10-24, log-signal family 5ae52ca3 / ticket
  // 6d4cebff): the warn moved to logHandled (info + logClass:'handled') —
  // the warn+ transport never persists it, so this signature can no longer
  // appear in app_error_logs. Keep the pin (it costs nothing and re-fires
  // if the site ever reverts to warn); the class is now silenced at the
  // source, which is the intended end state.
  // f184 (2026-10-22) pinned signatures 4+5 — the 18:00Z-hour provider/deploy
  // window burst that tripped the generic n>30 arm on two by-design warns:
  //   4: 'unified-memory: semantic leg failed%' — unified-memory.service.ts
  //      catch sets timing.embedFailed and the keyword leg runs (the message
  //      itself names the graceful degradation). DashScope embed timeouts:
  //      100 rows in the 18:00Z hour → n=2 in the 19:00Z hour (bounded,
  //      self-stopped); 30d class history is 0–4/day background with prior
  //      provider-burst days (10-12 n=41, 10-11 n=15). failed_runs=0.
  //   5: 'coding agent turn failed: aborted%' — agent.ts:3680 agentWarn
  //      inside the turn .catch that RETURNS a TurnResult (finishReason
  //      'error') — the abort is handled, the run survives (failed_runs_4h
  //      =0). 38 rows in the 18:00Z hour, coinciding with the 174f1ffc23
  //      deploy wave (box restarts ~18:17/18:32) plus the provider timeout
  //      burst; zero in the 19:00Z hour; 30d background 0–7/day with prior
  //      burst days (10-05/06 n=18). Only the exact 'aborted' message is
  //      pinned — other turn-failure reasons keep the generic arms.
  //      Any failed run in-window keeps ESCALATE (same conservative axis).
  // f184 pinned signatures 6+7 — same 18:00Z DashScope flap, two more
  // by-design degradation classes whose 4h-window RESIDUE crosses n>30
  // while the burst hour ages out:
  //   6: 'rerankTexts failed%' — rag.service.ts:937 catch → warn → return
  //      null; the caller keeps its own order (named in the message).
  //      Provider timeouts + 429 + 500; rate 43/h @18:00Z → 5/h @19:00Z.
  //   7: 'retrieveChunks error%' — rag.service.ts:630 catch → error →
  //      return [] (degraded retrieval, request completes; failed_runs=0).
  //      Rate 34/h @18:00Z → 5/h @19:00Z; class history 10-11 n=9, 10-12
  //      n=27 = the recurring DashScope-flap shape. The empty err.message
  //      tail is the provider failure propagating message-less.
  //      A hard future outage still surfaces via failed_runs>0; the daily
  //      baselines above are the re-adjudication reference.
  // ⚠ 2026-10-24 (log-signal family 5ae52ca3, tickets 007c1a3a/9cd30d58):
  // BOTH sites now emit via logExternal (warn + logClass:'external') and the
  // retrieve site interpolates the cause (the bare-colon splat is fixed), so
  // future rows read 'retrieveChunks error: <cause> — caller degrades…' and
  // land at level warn, not error. The LIKE prefixes still match; the
  // log-signal SWEEP drops the tagged rows (isNonFaultLogRow) while this
  // audit detector keeps seeing them — exactly the split intended.
  await sec('errors_4h', () => q(`SELECT t.msg, t.source, t.n, t.unattributed, t.last, t.http_code, CASE WHEN t.n > 30 AND t.http_code IS NOT NULL AND f.failed_runs = 0 AND t.http_code = ANY(s.codes) THEN 'absorbed:failover' WHEN t.n > 30 AND f.failed_runs = 0 AND (t.msg LIKE 'BrightData direct:%' OR t.msg LIKE 'Digby Web Search:%') AND (t.msg ILIKE '%timeout%' OR t.msg ILIKE '%timed out%' OR t.msg ILIKE '%missing organic results%' OR t.msg ILIKE '%status code 50%' OR t.msg ILIKE '%transient 50%') THEN 'vendor_transient' WHEN t.msg LIKE 'credential-gate: store row %' AND f.failed_runs = 0 THEN 'known:gate_shut_corrupt_row' WHEN t.msg LIKE 'sanitizeMessages: repaired%' AND f.failed_runs = 0 THEN 'known:repaired_empty_assistant' WHEN t.msg LIKE 'unified-memory: semantic leg failed%' AND f.failed_runs = 0 THEN 'known:semantic_leg_degraded' WHEN t.msg LIKE 'coding agent turn failed: aborted%' AND f.failed_runs = 0 THEN 'known:turn_aborted_handled' WHEN t.msg LIKE 'rerankTexts failed%' AND f.failed_runs = 0 THEN 'known:rerank_degraded' WHEN t.msg LIKE 'retrieveChunks error%' AND f.failed_runs = 0 THEN 'known:retrieve_degraded_empty' WHEN t.n > 30 THEN 'ESCALATE' ELSE 'ok' END AS verdict FROM (SELECT LEFT(regexp_replace(message, '[0-9a-f]{8}-[0-9a-f-]{27}', '<id>', 'g'),120) AS msg, source, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE context IS NULL)::int AS unattributed, MAX("createdAt") AS last, MIN((regexp_match(message, 'status code ([0-9]{3})'))[1]) AS http_code FROM app_error_logs WHERE "createdAt" > now() - interval '4 hours' GROUP BY 1,2) t, (SELECT COUNT(*)::int AS failed_runs FROM agent_runs WHERE status='failed' AND "createdAt" > now() - interval '4 hours') f, (SELECT string_to_array(string_agg(DISTINCT (regexp_match(meta->>'reason', 'HTTP ([0-9]{3})'))[1], ','), ',') AS codes FROM loop_metrics WHERE kind='seat_fallback' AND "createdAt" > now() - interval '4 hours') s ORDER BY t.n DESC LIMIT 15`));
  // ── jwt_spike_watch_4h (FO firing 141, 2026-10-15 — 28th f64 bake) ─────────
  // The auth-signal retune (2026-10-14, switch-registry #479) made the JWT
  // spike watch a STANDING firing item, but it lived only in the operator's
  // hand-derived errors-view read: f135–f141 each re-counted spike rows per
  // IP, re-checked the 30-vs-tripwire bars and re-derived the FS ruling's
  // escalation triggers by eye (the same by-eye cost the f64 verdict column
  // removed from the other sections). This section parses the spike lines
  // IN-AUDIT (a plain SELECT; all parsing and adjudication in JS — no new SQL
  // surface) and prints the standing bars as a computed verdict column:
  //   ok:baseline_tripwire — ip ∈ the LIVE baseline set (env
  //     AUTH_SIGNAL_BASELINE_IPS, resolved EXACTLY as auth-signal.ts does:
  //     unset/'' = the default ALB pair, 'none' = no baseline IPs) firing only
  //     at the tripwire (env AUTH_SIGNAL_BASELINE_SPIKE_THRESHOLD, default
  //     300) with the "(baseline-IP tripwire)" marker on every row.
  //   ESCALATE:baseline_low — ip ∈ the baseline set but a row fired BELOW the
  //     tripwire or WITHOUT the marker (the 2026-10-14 empty-env neutering
  //     class — a retune regression, never accepted).
  //   watch:pending_pair — ip ∈ PENDING_WATCH_IPS at or under the 30 bar,
  //     401-only (FS f140 ruling: hold the pair through f141–f143; the
  //     cadence/UA/project persistence read still happens on the printed
  //     paths — this column adjudicates only count/class/IP-set).
  //   ESCALATE:count_jump — a pending-list ip ABOVE the 30 bar.
  //   ESCALATE:fourth_ip — a non-baseline ip outside the pending list at ANY
  //     count (the ruling's same-firing report trigger).
  //   ESCALATE:non_401 — any spike line whose error class is not
  //     JsonWebTokenError (wins over every other arm).
  //   ESCALATE:unparsed_row — a spike line the parser cannot read (an emitter
  //     format change — audit the emitter before trusting the rest of the
  //     column).
  await sec('jwt_spike_watch_4h', async () => {
    // The FS ruling's observation list. FO updates this constant in the same
    // commit as the ruling delta; when the FS extends AUTH_SIGNAL_BASELINE_IPS
    // on the boxes, those IPs move into the live env set this probe reads and
    // the constant EMPTIES. EMPTIED at FO f144 (2026-10-16): the f143-trigger
    // pair (10.0.0.18 / 10.0.0.19) mapped to digby-alb's OWN rotated ENIs,
    // was persisted into AUTH_SIGNAL_BASELINE_IPS on A (live 23:36:43Z) and B
    // (staged 00:04Z, live in-container 02:02:48Z) — both IPs now adjudicate
    // via the env baseline arms (ok:baseline_tripwire / ESCALATE:baseline_low);
    // a non-baseline IP at ANY count is ESCALATE:fourth_ip by design.
    const PENDING_WATCH_IPS = [];
    const rawBase = process.env.AUTH_SIGNAL_BASELINE_IPS;
    const baseline = rawBase === undefined || rawBase.trim() === ''
      ? new Set(['10.0.0.12', '10.0.0.13'])
      : rawBase.trim().toLowerCase() === 'none'
        ? new Set()
        : new Set(rawBase.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    const tRaw = parseInt(process.env.AUTH_SIGNAL_BASELINE_SPIKE_THRESHOLD || '', 10);
    const tripwire = Number.isFinite(tRaw) && tRaw > 0 ? tRaw : 300;
    const THIRD_IP_BAR = 30; // INVALID_TOKEN_SPIKE_THRESHOLD in auth-signal.ts (a code constant, no env override)
    const rows = await q(`SELECT message, "createdAt" AS at FROM app_error_logs WHERE message LIKE 'Invalid-signature JWT spike:%' AND "createdAt" > now() - interval '4 hours' ORDER BY "createdAt" DESC LIMIT 200`);
    const byIp = new Map();
    for (const r of rows) {
      const m = String(r.message || '');
      const g = m.match(/spike: (\d+) (\w+) 401s from ip=([0-9.]+)/);
      const ip = g ? g[3] : '(unparsed)';
      const e = byIp.get(ip) || { n: 0, maxCount: 0, non401: false, unparsed: !g, tripwireRows: 0, paths: new Set(), clients: new Set(), last: null };
      e.n += 1;
      if (g) {
        const c = parseInt(g[1], 10);
        if (Number.isFinite(c) && c > e.maxCount) e.maxCount = c;
        if (g[2] !== 'JsonWebTokenError') e.non401 = true;
        if (m.includes('(baseline-IP tripwire)')) e.tripwireRows += 1;
        const p = m.match(/"path":"([^"]+)"/);
        if (p) e.paths.add(p[1].length > 64 ? `${p[1].slice(0, 64)}…` : p[1]);
        // Hops-anchored client IP in the caller sample (todo ead881f4,
        // 2026-10-18): the spike row's ip= is the ALB node (trust proxy 1);
        // the sample's clientIp field — now derived at the trust-proxy depth
        // by peelClientIp, not the client-writable XFF first hop — names the
        // real client behind the node. Pre-fix rows (first-hop reads) still
        // render here; read them as identification hints, never verdict
        // input (the verdict arms below stay byte-identical).
        const cl = m.match(/"clientIp":"([^"]+)"/);
        if (cl) e.clients.add(cl[1].length > 64 ? `${cl[1].slice(0, 64)}…` : cl[1]);
      }
      if (!e.last || new Date(r.at) > new Date(e.last)) e.last = r.at;
      byIp.set(ip, e);
    }
    const verdictFor = (ip, e) => {
      if (e.unparsed) return 'ESCALATE:unparsed_row';
      if (e.non401) return 'ESCALATE:non_401';
      if (baseline.has(ip)) return e.tripwireRows === e.n && e.maxCount >= tripwire ? 'ok:baseline_tripwire' : 'ESCALATE:baseline_low';
      if (PENDING_WATCH_IPS.includes(ip)) return e.maxCount > THIRD_IP_BAR ? 'ESCALATE:count_jump' : 'watch:pending_pair';
      return 'ESCALATE:fourth_ip';
    };
    const rank = (v) => (v.startsWith('ESCALATE') ? 0 : v.startsWith('watch') ? 1 : 2);
    return [...byIp.entries()].map(([ip, e]) => ({
      ip, rows_4h: e.n, max_count: e.maxCount, tripwire_rows: e.tripwireRows,
      paths: [...e.paths].slice(0, 6), clients: [...e.clients].slice(0, 6), last: e.last, verdict: verdictFor(ip, e),
    })).sort((a, b) => rank(a.verdict) - rank(b.verdict) || b.rows_4h - a.rows_4h);
  });
  // ── auth_login_failures_4h (FO firing 61, 2026-10-02) ───────────────────────
  // error-handler.ts (PE-18) records one auth_login_failed row per failed login
  // keyed by an ipHash + emailHash pair — deliberately privacy-safe and
  // "queryable spike signal" — but no standing audit section ever read it, so
  // every sighting meant a hand-rolled probe (firing 61's first attempt even
  // read the wrong meta keys: the pair is ipHash/emailHash, never
  // source/email). Standing read now: grouped by ipHash+emailHash with the
  // count and window. Read: a brute-force burst shows as one ipHash with many
  // n; a confused user as one emailHash retrying slowly across hours; several
  // ipHashes on one emailHash = someone behind rotating IPs. Under the 30/4h
  // class bar and spread across hashes = no action.
  // 2026-10-18 (ticket 4a8fcbde): rows with emailHash 0034506974bc51de are the
  // synthetic deploy-healthcheck probe (sha256('healthcheck@test.com')[:16]) —
  // the workflow now probes GET /api/health and error-handler skips the probe
  // body, so the class is closed at source and this filter is for the tail of
  // historical rows still inside the 4h window. Render them as a one-line
  // probe note instead of attack-shaped rows (the ticket's optional
  // defense-in-depth; NOT the close bar itself).
  await sec('auth_login_failures_4h', () => q(`SELECT COALESCE(meta->>'ipHash','(none)') AS ip_hash, COALESCE(meta->>'emailHash','(none)') AS email_hash, COUNT(*)::int AS n, MIN("createdAt") AS first, MAX("createdAt") AS last FROM loop_metrics WHERE kind='auth_login_failed' AND "createdAt" > now() - interval '4 hours' AND COALESCE(meta->>'emailHash','') <> '0034506974bc51de' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`));
  await sec('auth_login_failures_probe_class_4h', () => q(`SELECT COUNT(*)::int AS n, MIN("createdAt") AS first, MAX("createdAt") AS last FROM loop_metrics WHERE kind='auth_login_failed' AND "createdAt" > now() - interval '4 hours' AND COALESCE(meta->>'emailHash','') = '0034506974bc51de'`));
  // ── auth_login_failures_by_email_4h (FO firing 63, 2026-10-02) ──────────────
  // The pair section above prints one row per (ipHash,emailHash), so the ONE
  // escalation signature the f61 learning named — several ipHashes on one
  // emailHash = someone behind rotating IPs — has to be re-derived by eye
  // every firing (firing 63: emailHash 0034506974bc51de appeared from TWO
  // ipHashes as n=1 rows, which reads as two confused users until you match
  // the email column). Rollup per email_hash: distinct ip count reads
  // directly. Read: distinct_ips = 1 = one confused user (or one box);
  // distinct_ips >= 3 or n over the 30/4h class bar = escalate to the owner.
  // f64: the bar itself is now a computed column (verdict ESCALATE/ok) — the
  // operator no longer re-derives the threshold by eye every firing (firing
  // 64: n crept 2→5 on emailHash 0034506974bc51de and the bar had to be
  // re-checked against the comment). Aggregates are restated inside the CASE
  // (Postgres resolves SELECT aliases only as bare ORDER BY/GROUP BY names).
  // 2026-10-18 (ticket 4a8fcbde): the probe class (emailHash
  // 0034506974bc51de — the synthetic deploy-healthcheck login) is EXCLUDED
  // from the verdict: it is the platform's own liveness probe, not an attack,
  // and its historical rows were the entire "5 distinct attacker IPs"
  // false-positive (owner card oq_17b85b72, refuted by the verification lane:
  // the 5 ipHashes were RFC1918 ALB node addresses, node rotation not attacker
  // rotation). auth_login_failures_probe_class_4h (above) surfaces the tail
  // count so the exclusion is visible, never silent.
  // F2 (same ticket, review follow-up): distinct_ips now counts the CLIENT ip
  // hash — COALESCE(clientIpHash, ipHash) — because ipHash alone is the ALB
  // node (trust proxy 1) and node rotation read as "attacker rotation".
  // clientIpHash (present once QUOTA_TRUSTED_PROXY_HOPS is set on the boxes —
  // an owner env step) is the depth-anchored client IP a forged PREPENDED
  // hop cannot move; rows that predate the field fall back to ipHash so the
  // column never goes null.
  await sec('auth_login_failures_by_email_4h', () => q(`SELECT COALESCE(meta->>'emailHash','(none)') AS email_hash, COUNT(DISTINCT COALESCE(NULLIF(meta->>'clientIpHash',''), meta->>'ipHash','(none)'))::int AS distinct_ips, COUNT(*)::int AS n, CASE WHEN COUNT(DISTINCT COALESCE(NULLIF(meta->>'clientIpHash',''), meta->>'ipHash','(none)')) >= 3 OR COUNT(*) > 30 THEN 'ESCALATE' ELSE 'ok' END AS verdict, MIN("createdAt") AS first, MAX("createdAt") AS last FROM loop_metrics WHERE kind='auth_login_failed' AND "createdAt" > now() - interval '4 hours' AND COALESCE(meta->>'emailHash','') <> '0034506974bc51de' GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 10`));
  await sec('cards_pending', () => q(`SELECT tool, COUNT(*)::int AS n, MIN("createdAt") AS oldest FROM pending_confirmations WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC`));
  // owner_questions is a MULTI-TENANT table (2026-09-22, firing 2): the unscoped
  // count read another platform user's two staff questions (RIO, usr 076d2832)
  // as this fleet's pending owner cards — one full box probe to disprove.
  // Attribute by user so the operator sees whose cards they are at a glance.
  await sec('owner_questions_open', () => q(`SELECT LEFT("userId"::text,8) AS usr, COALESCE(triage,'-') AS triage, COUNT(*)::int AS n, MIN("createdAt") AS oldest FROM owner_questions WHERE status='open' GROUP BY 1,2`));
  // ── f103 bar correction (33rd f64 bake, 2026-10-09) ──────────────────────────
  // The busySkips arm fired at >= 2 — stricter than BOTH framework consumers
  // of the same column: the busy-skip alarm's FIRST crossing is 3 and stays
  // info ("9 min busy, under the p50 legitimate run" — schedule.service.ts
  // BUSY_SKIP_ALARM_FIRST), and the zombie lane watchdog reads >= 10
  // (attention-watchdog.service.ts ZOMBIE_BUSY_SKIPS_MIN, the warn-level
  // "wedged-lane signal"). A busySkips of 2 is the benign busy-park class
  // (fire time hit a live run; the row re-arms ~3 min later) — firing 103's
  // only rollup ESCALATE was exactly that (chat 41bd202a, busySkips 2,
  // nextRunAt 107 min in the FUTURE, lastStatus skipped:no_material_change),
  // and every such firing re-probed the schedule by hand to learn it. The
  // verdict column now adjudicates: ESCALATE = the framework's own warn rung
  // (busySkips >= 10 OR error% OR overdue > 20 min); busySkips 3–9 =
  // 'watch:busy_park' (the alarm's info level — visible, never a rollup row);
  // busySkips 2 = ok. The rollup copies the ESCALATE bar verbatim.
  await sec('schedules_trouble', () => q(`SELECT LEFT(s."sessionId"::text,8) AS chat, LEFT(c.title,36) AS title, s.kind, s."intervalSec", s."lastStatus", s."busySkips", ROUND(EXTRACT(EPOCH FROM (now()-s."nextRunAt"))/60)::int AS overdue_min, s."promptSetBy", CASE WHEN s."busySkips" >= 10 OR s."lastStatus" LIKE 'error%' OR s."nextRunAt" < now() - interval '20 minutes' THEN 'ESCALATE' WHEN s."busySkips" >= 3 THEN 'watch:busy_park' ELSE 'ok' END AS verdict FROM coding_schedules s JOIN crossmodel_chats c ON c.id=s."sessionId" WHERE s.enabled AND (s."busySkips" >= 2 OR s."lastStatus" LIKE 'error%' OR s."nextRunAt" < now() - interval '20 minutes') ORDER BY 7 DESC LIMIT 20`));
  await sec('schedules_enabled', () => q(`SELECT COUNT(*)::int AS n, SUM(CASE WHEN kind='recurring' THEN 1 ELSE 0 END)::int AS recurring, MIN("nextRunAt") AS next FROM coding_schedules WHERE enabled`));
  await sec('journal_4h', () => q(`SELECT "triggerKind", COUNT(*)::int AS n, SUM(CASE WHEN array_length(failures,1) > 0 THEN 1 ELSE 0 END)::int AS with_failures FROM run_journal_entries WHERE "createdAt" > now() - interval '4 hours' GROUP BY 1`));
  // ── journal_failures_4h (firing 62, 2026-10-01) ─────────────────────────────
  // journal_4h counts rows WITH a non-empty failures array but does not say
  // WHAT they are — firing 62 paid a manual one-off box probe to identify two
  // schedule-trigger rows whose failures were evidence-guard PRE-DELIVERY
  // strikes on the run's final note (phantom claims-block entry; truncated
  // output) — both runs completed fine; the guard struck the note, it was
  // replaced, nothing else happened. Every firing paid this same eyeball tax
  // when with_failures > 0 with runs_failed_4h empty.
  // This section details and CLASSIFIES the failure rows IN-AUDIT. The class
  // comes from the referenced RUN's status (LEFT JOIN — the run may be gone):
  //   guard_note_strike — the run COMPLETED: the failures name the evidence
  //     guard striking the final note pre-delivery (notes get replaced; the
  //     run itself is healthy — verify the replacement note landed, then move
  //     on; only a repeated strike on the SAME chat needs a deeper look);
  //   run_died / run_interrupted / run_missing — the referenced run did NOT
  //     complete: the failures may be the run's own death cause (cross-check
  //     runs_failed_4h / runs_interrupted_24h); run_missing = the journal row
  //     outlived its run (retention-swept or a queued run that never claimed).
  // Branch on run status FIRST (f61 doctrine): a NULL from the LEFT JOIN must
  // fall to run_missing, never past the completed arm.
  // f87 (21st f64 bake, 2026-10-06): the verdict bar is now a computed column —
  // a guard_note_strike on a LIVE chat (a crossmodel_messages row inside 7 days) is
  // agent behavior (watch-only, never a defect — verify the replacement note landed);
  // a guard_note_strike on a DEAD chat (deleted/re-owned, or no message in 7 days) is
  // the dead_chat / chat_stale_7d class (reported, not ok); anything with a failed /
  // cancelled / interrupted / missing run ESCALATEs (cross-check runs_failed_4h /
  // runs_interrupted_24h). Firings 84-86 each eyeballed 5+ completed rows by hand; a
  // recurring live:agent_behavior strike on the SAME chat needs the deeper look the
  // comment above names. The liveness correlated subquery lives INSIDE the verdict
  // CASE (SELECT aliases are not visible to sibling arms — the f61 aggregate rule);
  // a missing chat row falls to the dead-chat arm, never NULL.
  // f89 (2026-10-06): the run_died arm now has its own live:retried rung — a
  // failed/cancelled run whose chat has a NEWER run (created after the dead run's
  // journal row, status running/queued/completed) self-retried: the lane is working,
  // not stuck (f150100b: cancelled run 75bd22cc "two coder delegations failed" with
  // live retry da179a7b at step 113 printed ESCALATE at f88). Only a dead run with
  // NO newer run on the chat ESCALATEs. The retry subquery is correlated on the
  // journal row's chatId and guarded by r2."createdAt" > j."createdAt" so it can
  // never match the dead run itself (id ≠ j."runId" kept as a belt-and-braces guard).
  // f159 (2026-10-18): supervisor chat turns journal with runId NULL BY
  // DESIGN (run-journal.service.ts writeSupervisorTurnEntryAsync — chat-agent
  // turns create no agent_runs row), and PR #1712 (deccdaa3a, 2026-10-17)
  // overloads failures[] as an informational entity-id channel — so every
  // supervisor turn that named receipt ids landed in this section as
  // class=run_missing verdict=ESCALATE (8 distinct chats, f159 bake). The
  // predicate now splits at the source: j."runId" IS NULL ⇒ class
  // 'supervisor_turn' / verdict 'watch_only' (never a real run to miss);
  // run_missing/ESCALATE requires a NON-NULL runId whose join fails
  // (retention-swept or queued-never-claimed). Zero detection loss — the
  // fanout rollup below got the same split; the writer-side alternative
  // (entity ids out of failures[]) was rejected: it rewrites #1712's
  // anti-confabulation content contract and leaves existing rows in window.
  // f94 (25th f64 bake, 2026-10-07): the f87 prose bar "a recurring
  // live:agent_behavior strike on the SAME chat needs the deeper look" is now
  // a computed column + verdict rung. f94 eyeballed bb8f1073's 5 in-window
  // rows by hand (the exact tax this doctrine exists to remove). Measure-first
  // probe (box A, 2026-10-07T14:44Z): 7d per-chat failure-row distribution
  // tops out at bb8f1073=24, 1c2b28d6=18, b92ef13f=16, b811d9f7=13 — the
  // recurring rung fires at recurrence_7d >= 20 (sustained ~3/day for a week;
  // today that is bb8f1073 only, whose strikes are the owner-driven Hue/
  // Cloudflare blocker notes — watch-only). recurrence_7d counts PRIOR
  // same-chat failure rows in 7 days (j2.id <> j.id — a row never counts
  // itself), FULL j."chatId" join never LEFT(,8) (the f79 trap). The count is
  // a correlated scalar restated inside the verdict CASE (SELECT aliases are
  // not visible to sibling arms — the f61 rule); LIMIT 15 keeps the double
  // subquery cheap. Rung order inside the completed arm: dead_chat →
  // live:agent_behavior:recurring (recurrence >= 20) → live:agent_behavior →
  // chat_stale_7d.
  // f179 (2026-10-21): live-run journal rows are NOT run_missing. Live row
  // (chat a1275f8b, run be6ffd9f): the evidence guard struck the run's final
  // claims block (final_verdict metric 22:50:31.340Z, "typed claims-block
  // entries with no matching receipt: ticket_update 8549e1bc"); the journal
  // row and the run's finishedAt stamped at 22:50:31.34/44Z while the
  // post-strike replacement kept the run status='running' (+11 min at probe
  // time and counting). The ELSE arm read it run_missing/ESCALATE and cost
  // two box probes to adjudicate benign. Measured 7d population (box A
  // probe-f179): journal-failure rows on live runs = exactly this one
  // (running n=1, finishedAt set; queued n=0; stuck running+finishedAt>1h
  // fleet-wide = 0). A journal-failures row on a LIVE run is the
  // mid-finalize guard strike: the run is ALIVE and the guard is working —
  // watch-only, the same axis as guard_note_strike. A run that later dies
  // re-enters under the dead-run arms; a wedged finalize is
  // runs_suspect_class / runs_running_now's signal, never this section's.
  // The fanout + deadend-detail escalate predicates below already counted
  // ONLY join-misses and dead-no-retry runs — this arm aligns the detail
  // CASE with the fanout contract (the f62 pin's classify('running') rung
  // moved with it deliberately — the 405927c9 pin-drift class).
  await sec('journal_failures_4h', () => q(`SELECT LEFT(j."chatId"::text,8) AS chat, LEFT(c.title,36) AS title, j."triggerKind" AS trig, LEFT(j."runId"::text,8) AS run, r.status AS run_status, LEFT(j.failures::text,160) AS failures_head, (SELECT COUNT(*)::int FROM run_journal_entries j2 WHERE j2."chatId" = j."chatId" AND j2."createdAt" > now() - interval '7 days' AND array_length(j2.failures, 1) > 0 AND j2.id <> j.id) AS recurrence_7d, CASE WHEN j."runId" IS NULL THEN 'supervisor_turn' WHEN r.status = 'completed' THEN 'guard_note_strike' WHEN r.status IN ('failed','cancelled') THEN 'run_died' WHEN r.status = 'interrupted' THEN 'run_interrupted' WHEN r.status IN ('running','queued') THEN 'run_live' ELSE 'run_missing' END AS failure_class, CASE WHEN j."runId" IS NULL THEN 'watch_only' WHEN r.status = 'completed' THEN CASE WHEN c.id IS NULL THEN 'dead_chat' WHEN (SELECT COUNT(*) FROM run_journal_entries j2 WHERE j2."chatId" = j."chatId" AND j2."createdAt" > now() - interval '7 days' AND array_length(j2.failures, 1) > 0 AND j2.id <> j.id) >= 20 THEN 'live:agent_behavior:recurring' WHEN EXISTS (SELECT 1 FROM crossmodel_messages m WHERE m."chatId" = j."chatId" AND m."createdAt" > now() - interval '7 days') THEN 'live:agent_behavior' ELSE 'chat_stale_7d' END WHEN r.status IN ('running','queued') THEN 'live:finalizing' WHEN r.status IN ('failed','cancelled','interrupted') AND (EXISTS (SELECT 1 FROM agent_runs r2 WHERE r2."sessionId" = j."chatId" AND r2.id <> j."runId" AND r2."createdAt" > j."createdAt" AND r2.status IN ('running','queued','completed')) OR EXISTS (SELECT 1 FROM agent_runs r3 WHERE r3."sessionId" = j."chatId" AND r3.id <> j."runId" AND r3."createdAt" <= j."createdAt" AND (r3.status IN ('running','queued') OR (r3."finishedAt" IS NOT NULL AND r3."finishedAt" > j."createdAt")))) THEN 'live:retried' ELSE 'ESCALATE' END AS verdict FROM run_journal_entries j LEFT JOIN agent_runs r ON r.id = j."runId" LEFT JOIN crossmodel_chats c ON c.id = j."chatId" WHERE j."createdAt" > now() - interval '4 hours' AND array_length(j.failures, 1) > 0 ORDER BY j."createdAt" DESC LIMIT 15`));
  // ── journal_failure_fanout_4h (firing 96, 2026-10-07 — 27th f64 bake;
  //     bars corrected by firing 101, 2026-10-08 — 31st f64 bake) ──────────
  // The f94 per-row recurrence bake answered "is THIS chat a repeat offender"
  // but left the fleet-wide question to the eye: f96 hand-counted the window's
  // 9 rows into 5 DISTINCT chats (29dd7893, 1c2b28d6, 4d9661a7, 0037460b,
  // bb8f1073), every one individually under the recurrence >= 20 bar, and the
  // same count had to be re-derived by every prior firing. This rollup bakes
  // it: one row per window, distinct_chats + rows + top offender.
  // F101 BAR CORRECTION (the f99 class, caught live): the original ESCALATE
  // bar counted the RAW population (all failure rows) — f101's window fired
  // ESCALATE at 9 distinct chats while the detail section adjudicated 10/11
  // rows watch-only (live:agent_behavior) and the one run death (c919294b)
  // was a concurrent-sibling miss (its chat had a RUNNING run the whole
  // time). Measure-first probe (box A probe-f101-fanout.js, 2026-10-08T18:5xZ,
  // 42 non-empty 4h buckets over 7d): raw distinct_chats >= 8 in 4 buckets
  // (13/12/8/8, the f96 "real fanout events") but the detail-ESCALATE
  // population was ZERO in every one of them — guard-note storms, watch-only
  // by the f98 scoping doctrine. The bar now counts ONLY the adjudicated
  // ESCALATE population (run missing, or dead run with no newer run AND no
  // concurrent running/queued sibling — the detail rung VERBATIM, f99
  // contract): escalate_chats >= 2 ESCALATEs (two distinct dead-end chats in
  // one window = fleet-wide; a singleton stays the detail section's ESCALATE
  // row for the firing to probe, single = agent behavior by doctrine). The
  // raw distinct_chats / rows / top_chat / top_chat_recurrence_7d columns
  // stay for context and the f96 'top_recurrence' rung is unchanged.
  // f167 (2026-10-19): escalate_chat_ids names the dead-end chats IN the fanout row —
  // the detail section (newest-15 by createdAt DESC + output trimming) can DROP the
  // singleton's ESCALATE row when the 4h window is busy (observed live: 91 rows, the
  // 77ef9454 cancelled-run singleton never printed; naming it cost an ad-hoc box probe).
  // Fanout with a top offender already over the recurrence bar is the seam
  // the per-row bake catches anyway — the rollup prints 'top_recurrence'
  // (fanout >= 4 AND top_chat_recurrence_7d >= 20) so the eye is POINTED at
  // the journal_failures_4h recurring row instead of re-scanning 15 rows.
  // Zero rows prints nothing (the section vanishes — same shape as the other
  // *_4h sections). The recurrence count is the top chat's FULL 7d failure-row
  // count (this window included) — the f94 per-row count excludes each row's
  // self, so the two numbers differ by at most the window's own rows for that
  // chat; both cross 20 in the same regime.
  // f168 (2026-10-20): the companion dead-end DETAIL section below prints each
  // dead-end chat's run status + failures head INLINE — f167's escalate_chat_ids
  // named the chats but adjudicating their class still cost an ad-hoc box probe
  // BOTH at f167 (77ef9454) and f168 (8f4d0f3b/95fd5e5f, two ESCALATE singletons).
  // Same dead-end predicate VERBATIM (the f99/f101 contract), newest-first, cap 8.
  await sec('journal_failure_fanout_4h', () => q(`SELECT f.distinct_chats, f.escalate_chats, f.escalate_chat_ids, f.rows, f.top_chat, f.top_chat_recurrence_7d, CASE WHEN f.escalate_chats >= 2 THEN 'ESCALATE' WHEN f.distinct_chats >= 4 AND f.top_chat_recurrence_7d >= 20 THEN 'top_recurrence' ELSE 'ok' END AS verdict FROM (SELECT COUNT(DISTINCT j."chatId")::int AS distinct_chats, COUNT(DISTINCT j."chatId") FILTER (WHERE (j."runId" IS NOT NULL AND r.id IS NULL) OR (r.status IN ('failed','cancelled','interrupted') AND NOT EXISTS (SELECT 1 FROM agent_runs r2 WHERE r2."sessionId" = j."chatId" AND r2.id <> j."runId" AND r2."createdAt" > j."createdAt" AND r2.status IN ('running','queued','completed')) AND NOT EXISTS (SELECT 1 FROM agent_runs r3 WHERE r3."sessionId" = j."chatId" AND r3.id <> j."runId" AND r3."createdAt" <= j."createdAt" AND (r3.status IN ('running','queued') OR (r3."finishedAt" IS NOT NULL AND r3."finishedAt" > j."createdAt")))))::int AS escalate_chats, array_agg(DISTINCT LEFT(j."chatId"::text,8)) FILTER (WHERE (j."runId" IS NOT NULL AND r.id IS NULL) OR (r.status IN ('failed','cancelled','interrupted') AND NOT EXISTS (SELECT 1 FROM agent_runs r2 WHERE r2."sessionId" = j."chatId" AND r2.id <> j."runId" AND r2."createdAt" > j."createdAt" AND r2.status IN ('running','queued','completed')) AND NOT EXISTS (SELECT 1 FROM agent_runs r3 WHERE r3."sessionId" = j."chatId" AND r3.id <> j."runId" AND r3."createdAt" <= j."createdAt" AND (r3.status IN ('running','queued') OR (r3."finishedAt" IS NOT NULL AND r3."finishedAt" > j."createdAt"))))) AS escalate_chat_ids, COUNT(*)::int AS rows, (SELECT LEFT(j2."chatId"::text,8) FROM run_journal_entries j2 WHERE j2."createdAt" > now() - interval '4 hours' AND array_length(j2.failures, 1) > 0 GROUP BY j2."chatId" ORDER BY COUNT(*) DESC, MAX(j2."createdAt") DESC LIMIT 1) AS top_chat, (SELECT COUNT(*)::int FROM run_journal_entries j2 WHERE j2."chatId" = (SELECT j3."chatId" FROM run_journal_entries j3 WHERE j3."createdAt" > now() - interval '4 hours' AND array_length(j3.failures, 1) > 0 GROUP BY j3."chatId" ORDER BY COUNT(*) DESC, MAX(j3."createdAt") DESC LIMIT 1) AND j2."createdAt" > now() - interval '7 days' AND array_length(j2.failures, 1) > 0) AS top_chat_recurrence_7d FROM run_journal_entries j LEFT JOIN agent_runs r ON r.id = j."runId" WHERE j."createdAt" > now() - interval '4 hours' AND array_length(j.failures, 1) > 0) f`));
  await sec('journal_failure_fanout_deadend_detail_4h', () => q(`SELECT LEFT(j."chatId"::text,8) AS chat, LEFT(c.title,36) AS title, LEFT(j."runId"::text,8) AS run, r.status AS run_status, j."createdAt" AS journal_at, LEFT(j.failures[1],160) AS failures_head FROM run_journal_entries j LEFT JOIN agent_runs r ON r.id = j."runId" LEFT JOIN crossmodel_chats c ON c.id = j."chatId" WHERE j."createdAt" > now() - interval '4 hours' AND array_length(j.failures, 1) > 0 AND ((j."runId" IS NOT NULL AND r.id IS NULL) OR (r.status IN ('failed','cancelled','interrupted') AND NOT EXISTS (SELECT 1 FROM agent_runs r2 WHERE r2."sessionId" = j."chatId" AND r2.id <> j."runId" AND r2."createdAt" > j."createdAt" AND r2.status IN ('running','queued','completed')) AND NOT EXISTS (SELECT 1 FROM agent_runs r3 WHERE r3."sessionId" = j."chatId" AND r3.id <> j."runId" AND r3."createdAt" <= j."createdAt" AND (r3.status IN ('running','queued') OR (r3."finishedAt" IS NOT NULL AND r3."finishedAt" > j."createdAt"))))) ORDER BY j."createdAt" DESC LIMIT 8`));
  // ── Memory / summarization / retention telemetry (2026-09-22) ─────────────
  // Every summarizer records an outcome row; a parse_error share > 10 % on a
  // source = that node's token budget no longer fits its JSON (raise it — the
  // 2026-09-22 class: project 768→2000→4000, dream 600→2000); llm_error = the
  // utility chain (check utilityChat warns); 'empty' = the model wrote nothing.
  await sec('memory_extraction_4h', () => q(`SELECT meta->>'source' AS source, meta->>'outcome' AS outcome, COUNT(*)::int AS n, ROUND(AVG(value))::int AS avg_ms, MIN(meta->>'budgetTokens') AS min_budget, MAX(meta->>'budgetTokens') AS max_budget FROM loop_metrics WHERE kind='memory_extraction' AND "createdAt" > now() - interval '4 hours' GROUP BY 1,2 ORDER BY 1, 3 DESC`));
  // memory_extraction_parse_share_4h (FO firing 69, f64 doctrine — the charter's
  // "parse_error > 10 % on a source" prose bar baked natively): the bar lives at
  // SOURCE grain while memory_extraction_4h is (source, outcome)-paired, so the
  // verdict rides this companion rollup (f63), aggregates restated inside the
  // CASE (f61 — Postgres resolves SELECT aliases as bare ORDER BY/GROUP BY names
  // only). ESCALATE = raise that node's budget in memory.graph.ts /
  // coding-memory.service.ts / project-brief.service.ts, then read
  // memory_extraction_parse_error_tails for the cut-off shape.
  // f180 (2026-10-22): denominator floor COUNT(*) >= 10 — the no-floor share
  // fired ESCALATE on a 1-of-1 dream leg (one finish=length truncation = 100 %
  // share, isolated, self-recovered). The f171 true positive (profile leg
  // 99/139 = 71.2 %) stays caught: 139 >= 10 AND 71.2 % > 10 %. Below the
  // floor the row still PRINTS with its pct — observability kept, alarm cut.
  await sec('memory_extraction_parse_share_4h', () => q(`SELECT meta->>'source' AS source, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE meta->>'outcome' = 'parse_error')::int AS parse_error_n, ROUND(100.0 * COUNT(*) FILTER (WHERE meta->>'outcome' = 'parse_error') / COUNT(*), 1) AS parse_error_pct, CASE WHEN COUNT(*) >= 10 AND COUNT(*) FILTER (WHERE meta->>'outcome' = 'parse_error') * 10 > COUNT(*) THEN 'ESCALATE' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='memory_extraction' AND "createdAt" > now() - interval '4 hours' GROUP BY 1 ORDER BY 1`));
  await sec('memory_extraction_parse_error_tails', () => q(`SELECT meta->>'source' AS source, RIGHT(meta->>'detail', 100) AS tail, COUNT(*)::int AS n FROM loop_metrics WHERE kind='memory_extraction' AND meta->>'outcome'='parse_error' AND "createdAt" > now() - interval '4 hours' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 6`));
  // memory_extraction_prose_detail_24h (firing 14, 2026-09-24 — owner steer on 3a68aec8):
  // 3a68aec8 made every JSON extractor pass contentOnly:true so an exhausted-thinking
  // call yields '' and the non-reasoning fallback answers, killing the reasoning-as-answer
  // parse_error class (last pre-fix row 2026-09-23T23:56Z: leg=deepseek, finishReason=length,
  // 51k chars of REASONING as the answer). A healthy parse_error detail STARTS WITH '{'
  // (the parsed-but-invalid JSON tail); a detail starting with PROSE means a model leg
  // returned reasoning where content belonged AGAIN — the regression signature the owner
  // asked us to watch. detail_head prefixes every row; prose = any detail_head whose first
  // char is not '{' (after TRIM). leg/finishReason ride along so the report names the
  // provider that truncated.
  await sec('memory_extraction_prose_detail_24h', () => q(`SELECT "createdAt", meta->>'source' AS source, meta->>'leg' AS leg, meta->>'finishReason' AS fr, LEFT(TRIM(meta->>'detail'), 80) AS detail_head FROM loop_metrics WHERE kind='memory_extraction' AND meta->>'outcome'='parse_error' AND meta->>'detail' IS NOT NULL AND LEFT(TRIM(meta->>'detail'), 1) <> '{' AND "createdAt" > now() - interval '24 hours' ORDER BY "createdAt" DESC LIMIT 12`));
  // cursor_refusal_causes_24h (firing 14, 2026-09-24 — owner steer on 3a68aec8): the
  // get_chat_messages `before` cursor now accepts the 8-char citation prefix, so the
  // 30/7d "Invalid before cursor for this chat" refusals (models passing exactly the
  // doctrine-cited prefix) should be ~0. Survivors are CLASSIFIED by the refusal's own
  // vocabulary: 'DIFFERENT chat' = a prefix that exists but belongs to another chat (the
  // honest refusal); 'no message … exists' = a well-formed cursor naming a missing row;
  // anything else — ESPECIALLY prefix-shaped cursors still refusing — is the reachable
  // cause the steer says to fix forward. ambiguous = 8-char prefixes colliding inside
  // one big chat (the steer's widen-to-12 trigger).
  await sec('cursor_refusal_causes_24h', () => q(`SELECT CASE WHEN message LIKE '%Invalid before cursor for this chat' THEN 'legacy_plain' WHEN message LIKE '%DIFFERENT chat%' THEN 'other_chat' WHEN message LIKE '%no message%' AND message LIKE '%exists%' THEN 'not_found' WHEN message LIKE '%ambiguous%' OR message LIKE '%matches%' THEN 'ambiguous' ELSE 'unclassified' END AS cause, COUNT(*)::int AS n, MAX("createdAt") AS last, LEFT(MAX(message), 200) AS sample FROM app_error_logs WHERE message LIKE '%get_chat_messages failed: Invalid before cursor%' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`));
  // Flat user-memory writes by source (turn/rebuild/dream/api/tool): a dream
  // row with rejectedConsolidation or large 'removed' lists = the guard fired.
  await sec('user_memory_mutation_4h', () => q(`SELECT meta->>'source' AS source, COUNT(*)::int AS rows, SUM(jsonb_array_length(COALESCE(meta->'added','[]')))::int AS added, SUM(jsonb_array_length(COALESCE(meta->'removed','[]')))::int AS removed, SUM(jsonb_array_length(COALESCE(meta->'droppedRemovals','[]')))::int AS dropped_removals, SUM(CASE WHEN meta->>'rejectedConsolidation' IS NOT NULL THEN 1 ELSE 0 END)::int AS rejected_consolidations FROM loop_metrics WHERE kind='user_memory_mutation' AND "createdAt" > now() - interval '4 hours' GROUP BY 1 ORDER BY 2 DESC`));
  // In-loop transcript compaction: the charter bar is "summarizer_ok below
  // ~100 % means recaps are degrading to the omitted-steps line". Baked as a
  // computed verdict column since FO firing 70 (5th f64 bake): ok = every
  // compaction summarized; degraded = a not-ok shortfall ≤ 5 % (the "~" in
  // the bar); ESCALATE = not-ok share > 5 % — read the summarizer chain when
  // it fires. Aggregates are restated inside the CASE (f61: Postgres resolves
  // SELECT aliases as bare names only). A run with many compactions per hour
  // is a context-budget or tool-result-size problem.
  await sec('context_compaction_4h', () => q(`SELECT meta->>'mode' AS mode, COUNT(*)::int AS n, COUNT(DISTINCT "sessionId")::int AS sessions, SUM(CASE WHEN (meta->>'summarizerOk')::boolean THEN 1 ELSE 0 END)::int AS summarizer_ok, CASE WHEN COUNT(*) = 0 THEN 'ok' WHEN SUM(CASE WHEN (meta->>'summarizerOk')::boolean THEN 1 ELSE 0 END) * 20 < COUNT(*) * 19 THEN 'ESCALATE' WHEN SUM(CASE WHEN (meta->>'summarizerOk')::boolean THEN 1 ELSE 0 END) < COUNT(*) THEN 'degraded' ELSE 'ok' END AS verdict, ROUND(AVG(value))::int AS avg_ms, MAX((meta->>'totalChars')::int) AS max_chars FROM loop_metrics WHERE kind='context_compaction' AND "createdAt" > now() - interval '4 hours' GROUP BY 1`));
  await sec('memory_scope_evicted_4h', () => q(`SELECT meta->>'scopeType' AS scope, COUNT(*)::int AS events, SUM(value)::int AS rows FROM loop_metrics WHERE kind='memory_scope_evicted' AND "createdAt" > now() - interval '4 hours' GROUP BY 1`));
  // memory_search_timing verdict (firing 71, 2026-10-03 — 6th f64 bake): the
  // charter bar "embed_failed > 0 with hits_0 climbing = the keyword-only
  // fallback is masking a DashScope embed failure" lived only in prose. Now
  // baked as a computed verdict column: ESCALATE = embed_failed > 0 AND
  // hits_0 > 0 (a failed embed leg AND zero-hit searches — the masking is
  // live, read DashScope warns); degraded = embed_failed > 0 with hits_0 = 0
  // (embed failing but nothing masked yet — watch, next stop reading the
  // warns); ok otherwise. rerank_skip_pct is REPORTED, never barred — the
  // charter says "rerank_skipped high" with no numeric bar (f67 doctrine:
  // report the tunable, do not assert it). Aggregates restated inside the
  // CASE (f61: Postgres resolves SELECT aliases as bare names only). The
  // vec_ms/fts_ms wide-blend bar needs a scope-width key the emitter does
  // not stamp — that one stays prose until the metric grows the key (f62:
  // enumerate the EMITTER's meta keys before extending a reader).
  await sec('memory_search_timing_4h', () => q(`SELECT meta->>'purpose' AS purpose, COUNT(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(value, (meta->>'totalMs')::numeric))::int AS p50_ms, percentile_cont(0.9) WITHIN GROUP (ORDER BY COALESCE(value, (meta->>'totalMs')::numeric))::int AS p90_ms, ROUND(AVG((meta->>'embedMs')::numeric))::int AS avg_embed_ms, ROUND(AVG((meta->>'vecMs')::numeric))::int AS avg_vec_ms, ROUND(AVG((meta->>'ftsMs')::numeric))::int AS avg_fts_ms, COUNT(*) FILTER (WHERE (meta->>'rerankSkipped')::boolean)::int AS rerank_skipped, ROUND(100.0 * COUNT(*) FILTER (WHERE (meta->>'rerankSkipped')::boolean) / COUNT(*))::int AS rerank_skip_pct, COUNT(*) FILTER (WHERE (meta->>'embedCached')::boolean)::int AS embed_cached, COUNT(*) FILTER (WHERE (meta->>'embedFailed')::boolean)::int AS embed_failed, COUNT(*) FILTER (WHERE COALESCE((meta->>'hits')::int,0) > 0)::int AS hits_gt0, COUNT(*) FILTER (WHERE COALESCE((meta->>'hits')::int,0) = 0)::int AS hits_0, CASE WHEN COUNT(*) = 0 THEN 'ok' WHEN COUNT(*) FILTER (WHERE (meta->>'embedFailed')::boolean) > 0 AND COUNT(*) FILTER (WHERE COALESCE((meta->>'hits')::int,0) = 0) > 0 THEN 'ESCALATE' WHEN COUNT(*) FILTER (WHERE (meta->>'embedFailed')::boolean) > 0 THEN 'degraded' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='memory_search_timing' AND "createdAt" > now() - interval '4 hours' GROUP BY 1 ORDER BY 2 DESC`));
  // google_write_tools_24h (firing 11, 2026-09-23 — 32d0ebc8 owner steer): the
  // ok/reason distribution over Google WRITE tool calls. A dominance of
  // reason='ambiguous' means the doctrine must tell models to ask which
  // account; missing_scopes is the designed re-consent answer; a rise in
  // call_failed is the MCP bridge.
  await sec('google_write_tools_24h', () => q(`SELECT meta->>'tool' AS tool, meta->>'ok' AS ok, COALESCE(meta->>'reason','-') AS reason, COUNT(*)::int AS n, MAX("createdAt") AS last FROM loop_metrics WHERE kind='google_write_tool' AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 12`));
  // session_history_sync_4h (firing 15, 2026-09-24 — 1d068e81 owner steer): the
  // 10-minute HISTORY.md sweep's own verdict, from cron_jobs.lastStatus — the
  // summary the sweep hands finishCronJob IS the observable ("synced N,
  // unchanged N, failed N of N, …, no mirror N, skipped N"). `failed > 0`
  // persisting across passes = per-session failures (a missing worktree/mirror
  // that is NOT being classified — the 1d068e81 class); `no mirror N` > 0 is
  // the DESIGNED skip (a repo whose mirror lives on another box — one warn per
  // repo per process, never failed); last_fired older than ~15 min = the job
  // stopped ticking (disabled, or the worker's cron loop wedged).
  await sec('session_history_sync_4h', () => q(`SELECT id, LEFT("lastStatus", 200) AS last_status, "lastFiredAt" AS last_fired, enabled, "workerId" AS worker, ROUND(EXTRACT(EPOCH FROM (now() - "lastFiredAt"))/60)::int AS min_since_fire FROM cron_jobs WHERE id = 'session-history-sync'`));
  // ── decision_gate_liveness_4h (FO firing 78, 2026-10-04 — 12th f64 bake) ───
  // The rollout automaton's STATUS surface (get_decision_gate_status /
  // rollout.lastRunAt) used to freeze at the last JUDGING pass whenever the
  // job hit its "waiting for a fresher readiness report" early-return, while
  // cron_jobs.lastFiredAt kept advancing hourly — a healthy idle (readiness
  // recomputes every 6 h) was indistinguishable from a stalled automaton and
  // cost this firing a live investigation. The heartbeat stamp is fixed in
  // decision-gate-rollout.ts (this same commit), but the AUDIT must adjudicate
  // liveness from the SCHEDULER truth, not the state truth, so a regression
  // (or a genuinely wedged cron loop) is still caught. Verdicts per job:
  //   ok            — lastFiredAt within 1.5 × intervalSec (both jobs healthy).
  //   idle_waiting  — rollout lastStatus matches 'waiting for a fresher' and
  //                   readiness's 6-h cadence explains it (the BENIGN idle
  //                   class — REPORTED, never a defect).
  //   disabled      — enabled=false (kill switch by an admin — never a defect).
  //   stale_fired   — lastFiredAt older than 1.5 × interval (ESCALATE: the
  //                   cron loop or the lease is wedged — a REAL defect).
  //   stale_status  — fired recently but lastStatus is 'failed:' (the pass
  //                   body threw — read the warn log for the message).
  //   missing       — no cron_jobs row at all (job never registered — REAL).
  await sec('decision_gate_liveness_4h', () => q(`SELECT id, "intervalSec" AS interval_sec, enabled, LEFT("lastStatus", 200) AS last_status, "lastFiredAt" AS last_fired, ROUND(EXTRACT(EPOCH FROM (now() - "lastFiredAt"))/60)::int AS min_since_fire, CASE WHEN NOT enabled THEN 'disabled' WHEN "lastFiredAt" IS NULL THEN 'missing' WHEN now() - "lastFiredAt" > ("intervalSec" * 1.5 || ' seconds')::interval THEN 'stale_fired' WHEN "lastStatus" LIKE 'failed:%' THEN 'stale_status' WHEN id = 'decision-gate-rollout' AND "lastStatus" LIKE 'waiting for a fresher readiness report%' THEN 'idle_waiting' ELSE 'ok' END AS verdict FROM cron_jobs WHERE id LIKE 'decision-gate%' ORDER BY id`));
  // The sweep's warn classes, 24h by day-shape: 'spawn git ENOENT' = a mirror
  // MISSING on the box that is still counted failed (must be 0 after 1d068e81);
  // 'mirror missing on disk' = the designed once-per-repo-per-process skip
  // warn (a handful per deploy restart is fine — it re-arms per process);
  // anything else is a genuine per-session failure to read.
  // f107 bake (2026-10-09, 27th f64 bake): the raw class counts forced every
  // firing to re-derive the SAME two adjudications by hand — (1) f106's
  // terminal-auth storm printed as class 'other' n=90/24h for hours after the
  // fix landed (a 24-row/4h STORM while it was live, a harmless aging tail
  // after); (2) push_quarantined warns USED to legitimately repeat ONCE PER
  // WORKER RESTART — pre-b6477bc7 the quarantine was a process-memory Map
  // (f107 observed 3 warns at 15:38/16:18/17:19Z mapping 1:1 to the
  // 15:11/15:49/16:50Z deploys). Since b6477bc7 (2026-10-16) the window is
  // Redis-backed (SET session-history:push-quarantine:<projectId> NX EX 21600,
  // survives worker reboots), so restarts no longer re-warn: the only
  // legitimate repeats are a Redis outage (the in-process fallback Map warns
  // once per process per window), key eviction under allkeys-lru (fails open
  // to the same fallback), and window expiry (>=6h apart). The verdict column
  // bakes both bars:
  //   escalate       — enoent_mirror (must be 0 after 1d068e81; ANY row is REAL)
  //   storm_active   — 'other' with n>=20 AND last within 2h (the f106 class:
  //                    a quarantinable repo still failing through — read rows,
  //                    the classifier regex is the seam)
  //   recent         — 'other' with last within 2h but n<20 (isolated genuine
  //                    per-session read failures — read rows, usually noise)
  //   repeat_warn    — push_quarantined with two SAME-project warns <20 min
  //                    apart (inside one quarantine window the Redis key must
  //                    dedupe; a repeat means the quarantine failed — REAL)
  //   ok             — everything else (mirror_missing_warn by design; a
  //                    quarantine re-warn >=20-min spaced = Redis-outage
  //                    fallback (per-process) or window expiry (>=6h); an
  //                    'other' tail older than 2h = a stopped storm aging out)
  await sec('session_history_sync_warns_24h', () => q(`WITH warn AS (SELECT CASE WHEN message LIKE '%spawn git ENOENT%' THEN 'enoent_mirror' WHEN message LIKE '%mirror missing on disk%' THEN 'mirror_missing_warn' WHEN message LIKE '%push refused permanently%' THEN 'push_quarantined' ELSE 'other' END AS class, substring(message from 'project ([0-9a-f]{8})') AS proj, "createdAt" FROM app_error_logs WHERE message LIKE '%session history sync%' AND "createdAt" > now() - interval '24 hours'), gap AS (SELECT ROUND(EXTRACT(EPOCH FROM ("createdAt" - LAG("createdAt") OVER (PARTITION BY proj ORDER BY "createdAt")))/60)::int AS gap_min FROM warn WHERE class = 'push_quarantined') SELECT * FROM (SELECT w.class, COUNT(*)::int AS n, MAX(w."createdAt") AS last, (SELECT MIN(gap_min) FROM gap) AS min_gap_min, CASE WHEN w.class = 'enoent_mirror' THEN 'escalate' WHEN w.class = 'other' AND MAX(w."createdAt") > now() - interval '2 hours' AND COUNT(*) >= 20 THEN 'storm_active' WHEN w.class = 'other' AND MAX(w."createdAt") > now() - interval '2 hours' THEN 'recent' WHEN w.class = 'push_quarantined' AND (SELECT MIN(gap_min) FROM gap) < 20 THEN 'repeat_warn' ELSE 'ok' END AS verdict FROM warn w GROUP BY w.class) t ORDER BY n DESC`));
  // agent_events retention: ticks every minute while there is backlog;
  // reachedBoundary=true on most ticks = steady state; zero ticks for an hour
  // with rows older than the window = the job is off or stuck. Since FO firing
  // 82 (16th f64 bake) the bar is a computed verdict column, not re-derived by
  // eye: 'off_or_stuck' = zero ticks in the whole 4 h window while backlog
  // past the 30 d retention window exists (AGENT_EVENTS_RETENTION_DISABLED or
  // a wedged worker — ESCALATE class); 'stalled' = ticks exist but the newest
  // is >10 min old with backlog remaining; 'draining' = ticks healthy but some
  // hit their per-tick budget before the boundary (watch-only, backlog still
  // clearing); 'ok' = every tick reached the boundary.
  await sec('agent_events_retention_4h', () => q(`SELECT COUNT(*)::int AS ticks, SUM(value)::bigint AS rows_deleted, SUM(CASE WHEN (meta->>'reachedBoundary')::boolean THEN 1 ELSE 0 END)::int AS boundary_ticks, MAX(meta->>'oldestRemaining') AS oldest_remaining, ROUND(AVG((meta->>'ms')::numeric))::int AS avg_ms, MAX("createdAt") AS last_tick, CASE WHEN COUNT(*) = 0 AND EXISTS (SELECT 1 FROM agent_events WHERE "createdAt" < now() - interval '30 days') THEN 'off_or_stuck' WHEN MAX("createdAt") < now() - interval '10 minutes' AND EXISTS (SELECT 1 FROM agent_events WHERE "createdAt" < now() - interval '30 days') THEN 'stalled' WHEN SUM(CASE WHEN (meta->>'reachedBoundary')::boolean THEN 1 ELSE 0 END) < COUNT(*) THEN 'draining' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='agent_events_retention' AND "createdAt" > now() - interval '4 hours'`));
  await sec('agent_events_backlog_now', () => q(`SELECT (SELECT MIN("createdAt") FROM agent_events) AS oldest_row, pg_size_pretty(pg_total_relation_size('agent_events')) AS size`));
  // Project Brief (owner 2026-09-22): every hourly project_status row should
  // carry a brief (source model; fallback = the utility model failed that hour;
  // none = the builder threw or PROJECT_BRIEF_DISABLED).
  await sec('project_briefs_4h', () => q(`SELECT COALESCE(m.metadata->'brief'->>'source','none') AS brief_source, (m.metadata->>'unchanged')::boolean AS unchanged, COUNT(*)::int AS cards FROM crossmodel_messages m WHERE m.metadata->>'origin'='project_status' AND m."createdAt" > now() - interval '4 hours' GROUP BY 1,2 ORDER BY 3 DESC`));
  // Owner questions a supervisor is triaging (the rail says "your supervisor is
  // handling"); an open triaged row past triageUntil is the supervisor's miss.
  await sec('owner_questions_triaged_open', () => q(`SELECT COUNT(*)::int AS n, MIN("createdAt") AS oldest, SUM(CASE WHEN "triageUntil" < now() THEN 1 ELSE 0 END)::int AS past_triage_sla FROM owner_questions WHERE status='open' AND triage IS NOT NULL`));
  // Wrong-tool-slip seams (ed5c4979, owner steer 2026-09-22): the pre-change baseline
  // was 25 ungrounded_id strikes / 48 h (14 kimi-k3 runs); expect tool_preflight
  // strikes to fall toward 0 over 24 h post-landing. placeholder=true = the old
  // slip still happening. slip_echo_pruned: a handful/day fine; >5 in ONE run =
  // the model re-slips after the prune. tool_alias_used: informational.
  await sec('wrong_tool_seams_24h', () => q(`SELECT meta->>'seam' AS seam, meta->>'tool' AS tool, meta->>'reason' AS reason, COUNT(*)::int AS n, COUNT(DISTINCT "runId")::int AS runs, MAX("createdAt") AS last FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam' IN ('tool_preflight','slip_echo_pruned','tool_alias_used') AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 12`));
  await sec('wrong_tool_preflight_by_day', () => q(`SELECT date_trunc('day', "createdAt") AS d, COUNT(*)::int AS n, SUM(CASE WHEN meta->>'placeholder'='true' THEN 1 ELSE 0 END)::int AS placeholder, COUNT(DISTINCT "runId")::int AS runs FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_preflight' AND meta->>'reason'='ungrounded_id' AND meta->>'tool'='update_feedback' AND "createdAt" > now() - interval '48 hours' GROUP BY 1 ORDER BY 1`));
  // Per-run slip_echo_pruned concentration (>5 in one run = re-slip after prune).
  await sec('slip_echo_pruned_runs_24h', () => q(`SELECT "runId"::text AS run_id, LEFT("sessionId"::text,8) AS lane, COUNT(*)::int AS prunes, MAX("createdAt") AS last FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='slip_echo_pruned' AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2 HAVING COUNT(*) > 1 ORDER BY 3 DESC LIMIT 8`));
  // ── Hook sibling-drain watch (2026-09-24, owner steer on 72a01d94) ──────────
  // A WILDCARD firing now carries every enabled sibling hook's pending rows for
  // the same target (cap 100, child-result-template hooks excluded) and resets
  // the siblings' debounce clocks, so a multi-hook supervisor (Fleet Supervisor:
  // 12) is woken ONCE with the full digest instead of busy-parking per-source
  // rows for 77 min behind the wildcard's own wakes. metric hook_sibling_drain
  // records {hookId, siblingHooks, rows} per drain. This watch answers the
  // owner's standing question in one read: drains are happening on supervisor
  // wakes (empty = the sibling feeds are quiet OR the fix is off — check
  // HOOK_SIBLING_DRAIN_DISABLED), no single drain approaches SIBLING_DRAIN_CAP
  // (100 — a cap hit means a sibling feed is being starved again), and the
  // per-target pending age stays in minutes (the steer's success test: the
  // c0e22e36 oldest pending age must fall from ~77 min to minutes). Rows still
  // pending > 30 min with a non-busy target = the drain is NOT firing — read
  // hooks.service.ts drainSiblingBacklog warns before suspecting the metric.
  await sec('hook_sibling_drain_24h', () => q(`SELECT LEFT("sessionId"::text,8) AS target, value AS rows_drained, meta->>'siblingHooks' AS sibling_hooks, MAX("createdAt") AS last FROM loop_metrics WHERE kind='hook_sibling_drain' AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 12`));
  await sec('hook_pending_by_target_24h', () => q(`SELECT LEFT(eh."targetChatId"::text,8) AS target, COUNT(*)::int AS pending_rows, MIN(he."createdAt") AS oldest, ROUND(EXTRACT(EPOCH FROM (now()-MIN(he."createdAt")))/60)::int AS oldest_age_min, COUNT(DISTINCT he."hookId")::int AS hooks_involved, CASE WHEN MIN(he."createdAt") > now() - interval '15 minutes' THEN 'ok' WHEN EXISTS (SELECT 1 FROM loop_metrics wp WHERE wp.kind='wake_parked' AND wp.meta->>'reason'='triage' AND wp."sessionId" = eh."targetChatId" AND wp."createdAt" > now() - interval '35 minutes' AND wp."createdAt" >= MIN(he."createdAt") - interval '1 minute') AND MAX(he."retryAt") > now() THEN 'parked:triage' WHEN MAX(he."updatedAt") > now() - interval '5 minutes' THEN 'busy:park' WHEN EXISTS (SELECT 1 FROM agent_runs r WHERE r."sessionId" = eh."targetChatId" AND r.status = 'running' AND r."heartbeatAt" > now() - interval '5 minutes') THEN 'busy:target' WHEN MAX(he."retryAt") > now() THEN 'scheduled:future' WHEN BOOL_OR(EXTRACT(EPOCH FROM (now() - eh."lastFiredAt")) < eh."debounceSec") THEN 'debounce' ELSE 'ESCALATE' END AS verdict FROM hook_events he JOIN event_hooks eh ON eh.id=he."hookId" WHERE he.status='pending' GROUP BY 1, eh."targetChatId" HAVING COUNT(*) > 1 OR MIN(he."createdAt") < now() - interval '30 minutes' ORDER BY 3 ASC LIMIT 12`));
  // 17th f64 bake (FO f83, 2026-10-05): hook_pending_by_target_24h verdict
  // column — the f64 doctrine applied to the LAST by-eye section of the hook
  // watch. Before this, adjudicating a target's pending backlog (f83: c0e22e36,
  // 15 rows, oldest 100 min) required correlating THREE sections by eye:
  // hook_oldest_pending_now (busy:park), hook_lag_by_target_4h (ok) and the
  // FS row in schedules_trouble — every firing re-derived the same arms. The
  // arms mirror hook_oldest_pending_now EXACTLY (same order — the f81 lesson:
  // state arms BEFORE band classification), with two differences by design:
  // the freshness band is ok <= 15 min (this section's HAVING bar is >30 min,
  // so ok rows can only appear via the COUNT(*) > 1 arm), and GROUP BY carries
  // the RAW targetChatId (f61/f79 rule: a LEFT(,8) truncated id can never
  // match agent_runs.sessionId / loop_metrics.sessionId — liveness must be
  // read from the full UUID) while the displayed target stays LEFT(,8).
  // verdict dictionary: ok / parked:triage (the decision gate's wake_triage
  // park — correlated with the wake_parked metric + retryAt still future, the
  // f80 arm) / busy:park (the park loop is cycling: updatedAt fresh) /
  // busy:target (a running agent_run with a <5 min heartbeat queues the rows
  // by design, the f75 arm) / scheduled:future (the row's first attempt has
  // not even come due: MAX(retryAt) > now() — await_condition backstops park
  // a todo_wake at notBefore = createdAt + 3h with attempts 0; f174 live:
  // four deploy-awaiting ticket lanes ESCALATEd on by-design rows) / debounce
  // (the hook's coalescing window is still
  // open) / ESCALATE (nothing is touching the rows — real starvation).
  // ── Wake queue-rider watch (2026-09-24, owner steer on c8d39c6d) ────────────
  // A hook/schedule wake on a PLAIN chat now carries the chat's queued
  // upload-free agent report-ups as a bounded rider (<= 8,000 chars, header
  // "[QUEUED WHILE BUSY — N agent message(s) …]", remainder announced),
  // appended before the sweep-doctrine suffix, rows deleted only after the
  // run STARTS. metric wake_queue_rider records {origin, chars, remaining,
  // hookId | scheduleId} per ride. This watch answers the steer's standing
  // questions in one read: riders fire on BOTH wake paths (origin hook AND
  // schedule), every row stays inside the 8,000-char bound, remaining is
  // announced (a persistent remaining>0 climb = queue draining slower than it
  // fills), and each HOOK-origin rider pairs with a delivered wake_delivered row
  // for the same chat within minutes (wake_delivered is written by the hooks
  // delivery path only — a NORMAL schedule firing never records it, so
  // schedule-origin riders are excluded from the pairing check). A hook-origin
  // rider metric with NO wake row, or a QUEUED-WHILE-BUSY-free hook wake on a
  // chat whose queue was non-empty at fire time, is the
  // rider-missing-when-queued defect class (check WAKE_QUEUE_RIDER_DISABLED
  // before suspecting the metric; a finalize_handoff row for the same chat at
  // the same minute is the by-design retiring-colour no-drain path, NOT a
  // defect).
  await sec('wake_queue_rider_24h', () => q(`SELECT LEFT("sessionId"::text,8) AS target, COUNT(*)::int AS riders, MAX(value)::int AS max_ridden, MAX(NULLIF(meta->>'chars','')::int) AS max_chars, MAX(NULLIF(meta->>'remaining','')::int) AS max_remaining, COUNT(*) FILTER (WHERE meta->>'origin' = 'hook') AS via_hook, COUNT(*) FILTER (WHERE meta->>'origin' = 'schedule') AS via_schedule, MAX("createdAt") AS last FROM loop_metrics WHERE kind='wake_queue_rider' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 8 DESC LIMIT 12`));
  await sec('rider_wakes_vs_metrics_4h', () => q(`SELECT LEFT(m."sessionId"::text,8) AS target, COUNT(*)::int AS riders, COUNT(*) FILTER (WHERE w.metric IS NULL) AS missing_wake_rows, MAX(ROUND(EXTRACT(EPOCH FROM (w.created_at - m."createdAt"))/60)) AS max_pair_lag_min FROM loop_metrics m LEFT JOIN LATERAL (SELECT LEFT(mm.id::text,8) AS metric, mm."createdAt" AS created_at FROM loop_metrics mm WHERE mm.kind='wake_delivered' AND mm."sessionId" = m."sessionId" AND mm."createdAt" BETWEEN m."createdAt" - interval '2 minutes' AND m."createdAt" + interval '10 minutes' ORDER BY mm."createdAt" LIMIT 1) w ON true WHERE m.kind='wake_queue_rider' AND m.meta->>'origin' = 'hook' AND m."createdAt" > now() - interval '4 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`));
  // Hook lag by target (hardening loop iteration 8, 2026-09-24): delivery latency
  // (createdAt → updatedAt of delivered rows) p50/p90 per target over 4 h + the
  // oldest pending age NOW. The Fleet Supervisor ran p50 67 / p90 115 min on
  // 2026-09-24 before the rider (busy parks); the rider + sibling drain took it
  // to p50 10 / p90 26. The verdict column (FO firing 76, 10th f64 bake) bakes
  // the by-eye bar this section has required every firing since: 'ok' p90 ≤ 30,
  // then the STATE arms — dead_target / busy:ran / busy:rider — checked BEFORE
  // the band classification (15th f64 bake, FO firing 81): 'busy:ran' = the
  // target has agent_runs rows in-window (queue-behind-busy, f75 doctrine
  // extended to delivered rows), 'busy:rider' = a PLAIN-CHAT target
  // (supervisors hold no agent_runs rows — the f75 lesson) whose busy truth is
  // its in-window [QUEUED WHILE BUSY rider messages. Only when none of those
  // hold does the band speak: 'slow' = p90 ≤ 60 on a live, non-busy target
  // (watch), 'ESCALATE' = p90 > 60 with neither (real starvation). Firing 81's
  // motivating trap: the arms used to sit ABOVE 'slow' only past the 60-min
  // bar, so a busy target whose p90 landed in the 31–60 band printed bare
  // 'slow' (c0e22e36: p90 50 with 9 rider rows proving queue-behind-busy)
  // while the same state above 60 printed 'busy:rider' — the same underlying
  // state flipped verdict by band and the 31–60 band fell back to by-eye
  // adjudication, the exact burden the f76 bake removed. The
  // dead_target arm (FO firing 79, 13th f64 bake) sits between 'slow' and the
  // busy arms: a slow row whose target chat no longer exists is REPORTED (the
  // hook's own failed:target_gone class already handled the deletion). Firing
  // 79's motivating trap: the by-eye liveness adjudication runs on the
  // TRUNCATED 8-char id, and a hand-rolled `WHERE id='<prefix>'` probe can
  // never match the full UUID — firing 79 misread live chat aa78e314 as
  // deleted that way. The arm reads liveness from the joined FULL id, killing
  // that error class; it prints 'slow' correctly when the target is live.
  //
  // busy:chatlane arm (FO firing 92, 23rd f64 bake, 2026-10-07): chat lanes —
  // supervisors included — write NO agent_runs rows (the f75/f90 lesson), so
  // a busy supervisor's hook_lag p90 printed bare 'ESCALATE' and EVERY firing
  // re-derived the same hand probe: crossmodel_messages assistant rows in
  // window (f90: 99e63f86, 5 msgs; f91: both ESCALATEs; f92: 41bd202a,
  // 14 msgs hourly 03–06h, last 06:28Z — all busy:ran). The arm bakes that
  // probe: an in-window assistant row on the target chat means the chat was
  // ANSWERING while the hook waited — queue-behind-busy, same family as
  // busy:ran but with its own label so the provenance (chat lane, not an
  // agent_run) is visible in the readout. It sits AFTER the agent_runs
  // busy:ran arm (a coding lane proves busyness the cheaper way first) and
  // BEFORE busy:rider (an answering chat outranks a queued-message marker).
  await sec('hook_lag_by_target_4h', () => q(`SELECT LEFT(h."targetChatId"::text,8) AS target, COUNT(*)::int AS delivered, ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e."updatedAt"-e."createdAt")))/60)::int AS p50_min, ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e."updatedAt"-e."createdAt")))/60)::int AS p90_min, CASE WHEN ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e."updatedAt"-e."createdAt")))/60) <= 30 THEN 'ok' WHEN NOT EXISTS (SELECT 1 FROM crossmodel_chats c WHERE c.id = h."targetChatId") THEN 'dead_target' WHEN EXISTS (SELECT 1 FROM agent_runs r WHERE r."sessionId" = h."targetChatId" AND r."createdAt" > now() - interval '4 hours') THEN 'busy:ran' WHEN EXISTS (SELECT 1 FROM crossmodel_messages m3 WHERE m3."chatId" = h."targetChatId" AND m3.role = 'assistant' AND m3."createdAt" > now() - interval '4 hours') THEN 'busy:chatlane' WHEN EXISTS (SELECT 1 FROM crossmodel_messages m2 WHERE m2."chatId" = h."targetChatId" AND m2.role = 'user' AND m2.metadata->>'origin' IN ('hook','schedule') AND m2.content LIKE '%[QUEUED WHILE BUSY%' AND m2."createdAt" > now() - interval '4 hours') THEN 'busy:rider' WHEN ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e."updatedAt"-e."createdAt")))/60) <= 60 THEN 'slow' ELSE 'ESCALATE' END AS verdict FROM hook_events e JOIN event_hooks h ON h.id=e."hookId" WHERE e.status='delivered' AND e."updatedAt" > now() - interval '4 hours' GROUP BY h."targetChatId" ORDER BY 4 DESC LIMIT 12`));
  // ── Pending-backlog verdict (firing 67, 2026-10-03) ────────────────────────
  // The charter's bar — "nothing pending > 15 min unless its target is
  // legitimately busy" — lived only in prose, so firing 67 re-derived it by
  // hand for a 79-min-old parked schedule_disabled row (source read + custom
  // probes) before finding the busy-park design. VERIFIED MECHANISM (live
  // 2026-10-03, row 3226949d): while the target is busy, the 30 s sweep
  // CLAIMS the row (updatedAt bumps) and parkAlarmRows re-parks it — a
  // pending row whose updatedAt keeps advancing is being actively attempted;
  // a busy plain chat holds NO agent_runs row (busyness is the Redis
  // chat-busy claim, invisible to SQL), so updatedAt freshness is the only
  // chat-kind-agnostic busy signature. Buckets: 'ok' (≤15 min, the charter
  // bar), 'busy:park' (any of the target's pending rows touched <5 min ago —
  // park loop cycling; TTL-parked non-alarm rows freeze ≤3 min, still inside
  // the window), 'parked:triage' (FO firing 80, 14th f64 bake: the decision
  // gate's wake_triage act DELIBERATELY parks a non-alarm hook wake for its
  // defer window (≤30 min, retryAt = createdAt + defer) without touching the
  // hook_events row — updatedAt stays frozen at createdAt, attempts stay 0,
  // and every old arm reads ESCALATE. The park is stamped as a loop_metrics
  // wake_parked row (reason='triage', sessionId = the hook target) at park
  // time, so the arm correlates: a triage park metric for THIS target, within
  // 35 min (defer window + slack), at-or-after the row's creation (parked
  // post-arrival, not a stale park for a prior event), AND retryAt still in
  // the future — past retryAt with no delivery is the real-starvation class
  // and stays ESCALATE. rule gate.outcome: never ticket what the gate parked),
  // 'busy:target' (the target chat HAS a running agent_run with a
  // heartbeat <5 min old — the charter's "unless its target is legitimately
  // busy" bar baked as a column (f64 doctrine, FO firing 75): a busy target
  // queues the hook behind its run by design, and the parked row's updatedAt
  // freezes while the sweep waits, so busyness must be read from
  // agent_runs.heartbeats, not row freshness — the f75 FS rows
  // b6e21aeb/0bddbd80 were the adjudication gap: pending 33/28 min,
  // ESCALATE by the old arms, target running the whole time), 'debounce' (a
  // hook's coalescing window still open —
  // deliverHookGroup early-returns WITHOUT writing, so updatedAt freezes for
  // up to debounceSec; the 2026-09-04 owner-directed storm fix, not a
  // backlog), else 'ESCALATE' (nothing is touching the row — fairness
  // starvation, stuck dispatch). Bounded by the 24h retry horizon either way.
  // GROUP BY carries the RAW targetChatId (not LEFT(,8)) so probes can read
  // it (f61 rule); aggregates are restated inside the CASE (f61 rule).
  await sec('hook_oldest_pending_now', async () => {
    const rows = await q(`SELECT h."targetChatId"::text AS target_id, LEFT(h."targetChatId"::text,8) AS target, COUNT(*)::int AS pending, ROUND(EXTRACT(EPOCH FROM (now()-MIN(e."createdAt")))/60)::int AS oldest_min, CASE WHEN ROUND(EXTRACT(EPOCH FROM (now()-MIN(e."createdAt")))/60) <= 15 THEN 'ok' WHEN EXISTS (SELECT 1 FROM loop_metrics wp WHERE wp.kind='wake_parked' AND wp.meta->>'reason'='triage' AND wp."sessionId" = h."targetChatId" AND wp."createdAt" > now() - interval '35 minutes' AND wp."createdAt" >= MIN(e."createdAt") - interval '1 minute') AND MAX(e."retryAt") > now() THEN 'parked:triage' WHEN MAX(e."updatedAt") > now() - interval '5 minutes' THEN 'busy:park' WHEN EXISTS (SELECT 1 FROM agent_runs r WHERE r."sessionId" = h."targetChatId" AND r.status = 'running' AND r."heartbeatAt" > now() - interval '5 minutes') THEN 'busy:target' WHEN MAX(e."retryAt") > now() THEN 'scheduled:future' WHEN BOOL_OR(EXTRACT(EPOCH FROM (now() - h."lastFiredAt")) < h."debounceSec") THEN 'debounce' ELSE 'ESCALATE' END AS verdict FROM hook_events e JOIN event_hooks h ON h.id=e."hookId" WHERE e.status IN ('pending','delivering') GROUP BY h."targetChatId" ORDER BY oldest_min DESC LIMIT 12`);
    // Plain-chat busy truth is the Redis liveness key (cm:liverun:<chatId>,
    // chat-busy.ts claimLiveRun) — a busy plain chat holds NO agent_runs row,
    // so the SQL arm above cannot see it (the f75 gap). Re-check every
    // ESCALATE row against the live keys and re-class to busy:target. Raw
    // client from process.env.REDIS_URL (same pattern as
    // run_lock_paired_now); on any Redis error the SQL verdict stands.
    try {
      const { createClient } = require('/app/node_modules/redis');
      const redis = createClient({ url: process.env.REDIS_URL });
      redis.on('error', () => {});
      await redis.connect();
      const esc = rows.filter((r) => r.verdict === 'ESCALATE' && r.target_id);
      if (esc.length) {
        const vals = await redis.mGet(esc.map((r) => `cm:liverun:${r.target_id}`));
        esc.forEach((r, i) => { if (vals[i]) r.verdict = 'busy:target'; });
      }
      await redis.quit().catch(() => {});
    } catch (e) { /* Redis unreadable — keep the SQL verdict */ }
    return rows.map(({ target_id, ...r }) => r);
  });
  // DW-5 (FO firing 68, owner 2026-09-11 "feels stuck 3-7 s"): the
  // supervisor-send ms-to-durable-accept measurement — one row per fleet-surface
  // send, seams attributed (authMs / modeMs / busyMs / preemptMs / deliverMs).
  // The bar is BAKED as a verdict column (the f64/f65/f67 doctrine): the owner
  // band starts at 3000 ms, the preempt bound is 5000 ms.
  // f144 RECALIBRATION (FS ruling on the f143 trigger-fire, 2026-10-15): the
  // p90 bar now measures the SEND PATH, net of queue-wait — per-row duration is
  // value − preemptMs (floored at 0), because preemptMs is the DESIGNED ~5 s
  // busy-queue budget (chat-agent.service PREEMPT_WAIT_MS), not a defect. f143
  // proved the false-positive class: five queued sends in a window put the RAW
  // p90 ≈ 5.08 s over the bar while every send leg stayed ≤ 56 ms. p90_ms keeps
  // the raw wall-clock p90 for visibility; p90_path_ms is the recalibrated
  // measure the verdict arm reads — a genuinely slow send path (an auth-leg
  // regression, a deliver stall) still ESCALATEs, queued or not.
  await sec('supervisor_send_timing_4h', () => q(`SELECT meta->>'outcome' AS outcome, COUNT(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(value, (meta->>'totalMs')::numeric))::int AS p50_ms, percentile_cont(0.9) WITHIN GROUP (ORDER BY COALESCE(value, (meta->>'totalMs')::numeric))::int AS p90_ms, percentile_cont(0.9) WITHIN GROUP (ORDER BY GREATEST(0, COALESCE(value, (meta->>'totalMs')::numeric) - COALESCE((meta->>'preemptMs')::numeric, 0)))::int AS p90_path_ms, ROUND(AVG((meta->>'authMs')::numeric))::int AS avg_auth_ms, ROUND(AVG((meta->>'modeMs')::numeric))::int AS avg_mode_ms, ROUND(AVG((meta->>'busyMs')::numeric))::int AS avg_busy_ms, ROUND(AVG((meta->>'preemptMs')::numeric))::int AS avg_preempt_ms, ROUND(AVG((meta->>'deliverMs')::numeric))::int AS avg_deliver_ms, CASE WHEN percentile_cont(0.9) WITHIN GROUP (ORDER BY GREATEST(0, COALESCE(value, (meta->>'totalMs')::numeric) - COALESCE((meta->>'preemptMs')::numeric, 0))) > 5000 THEN 'ESCALATE' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='supervisor_send_timing' AND "createdAt" > now() - interval '4 hours' GROUP BY 1 ORDER BY 2 DESC`));
  // supervisor_send_timing_latest (FO firing 111, 2026-10-10; 28th f64 bake):
  // the 4h window above answers "how are sends TIMING this window" — but an
  // EMPTY window answers nothing: f111's window held zero fleet-surface sends
  // (the only 2 rows in 36h were both PRE-DW-5-fix, Oct 9 17:34/17:45Z, authMs
  // 4761/4079) and the section vanished, indistinguishable from
  // instrument-off (SUPERVISOR_SEND_TIMING_DISABLED=1 suppresses rows too).
  // This firing hand-rolled a /tmp SQL probe through prodq.sh just to learn
  // "idle, not off" — the exact by-eye burden the f64 doctrine removes. This
  // section reads the LATEST rows regardless of window: verdict ladder —
  //   instrument_silent — the section prints [] (no window filter: zero rows
  //                      means zero EVER — check the kill switch and
  //                      fleet.service's timingSurface='fleet' wiring);
  //   window_idle       — latest row exists but is older than the 4h window:
  //                      nothing to time, and the DW-5 authMs arm can only be
  //                      verified on rows NEWER than the fix's deploy — AND the
  //                      window-idle age is within the surface's historical
  //                      inter-send cadence (<= 52 h — the max gap f112
  //                      LIVE-VALIDATED across the five latest rows, box A
  //                      2026-10-10T14:48Z: inter-send gaps 11/442/2179/3120
  //                      min, max 3120 min = 52.0 h exactly, rows spanning
  //                      Oct 4 21:52Z→Oct 9 17:45Z; only ~7 h had passed since
  //                      the fix deploy at f112 time, so absence was within
  //                      cadence and the 'ever used?' question was NOT ripe;
  //                      window_idle_min + prev_gap_min print the numbers so
  //                      no firing re-derives this by eye);
  //   idle_beyond_history — ESCALATE-shaped, WATCH-ONLY (f112 bake): the
  //                      latest row is older than the 52 h historical max gap
  //                      — the surface's own history says a send was due, so
  //                      the question 'is the Management fleet surface ever
  //                      used?' is now ripe (check the kill switch, then the
  //                      owner's usage; NOT a defect of the DW-5 fix itself);
  //   stale_post_fix    — ESCALATE-shaped: rows newer than 2026-10-10T07:47Z
  //                      (the DW-5 fix deploy) still showing avg auth_ms >
  //                      1000 — the fix did NOT take (SEND_AUTH_LIGHT_DISABLED
  //                      armed? wrong branch?);
  //   ok                — latest rows post-fix with auth_ms in double digits.
  // age_min / window_idle_min / prev_gap_min and auth_ms print per latest row
  // so the boundary is visible without a second query. The 52 h rung is the
  // f112 bake: two consecutive idle firings had to hand-derive "absence is
  // within historical cadence" from the raw ages — this ladder computes it.
  // f114 bake (30th): every idle firing STILL hand-compared window_idle_min
  // against the 52 h bar (1737 vs 3120 by eye, four firings running) — the
  // exact by-eye burden the f64 doctrine removes, one level up. idle_headroom_min
  // computes it: minutes REMAINING before the rung flips to
  // idle_beyond_history (52 h − window idle age), gated to the idle regime
  // (NULL while the window is fresh — the column only means something when
  // the ladder is idle); ≤ 0 is the flip itself (sign carries the verdict:
  // negative headroom on an idle window = the usage question is ripe NOW).
  // f116 bake (32nd): idle firings STILL hand-derived "earliest ripening"
  // from headroom by eye — and f115's state file DRIFTED doing it (~17:45Z
  // written where the 52 h cadence from the Oct 9 17:45Z send gives 21:45Z;
  // the f115 audit itself printed headroom 1142 at 02:5xZ ⇒ ~21:4xZ). The
  // countdown is printed, the clock instant it points at is not. ripen_at
  // computes it: the window-max createdAt + 52 h, gated to the SAME idle
  // regime as idle_headroom_min (NULL while fresh), so the state file copies
  // an instant instead of re-adding minutes to an age.
  await sec('supervisor_send_timing_latest', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, COALESCE(value, (meta->>'totalMs')::numeric)::int AS total_ms, (meta->>'authMs')::numeric::int AS auth_ms, (meta->>'deliverMs')::numeric::int AS deliver_ms, meta->>'outcome' AS outcome, ROUND(EXTRACT(EPOCH FROM (now() - "createdAt"))/60)::int AS age_min, ROUND(EXTRACT(EPOCH FROM (now() - max("createdAt") OVER ()))/60)::int AS window_idle_min, CASE WHEN max("createdAt") OVER () < now() - interval '4 hours' THEN ROUND(EXTRACT(EPOCH FROM (interval '52 hours' - (now() - max("createdAt") OVER ())))/60)::int ELSE NULL END AS idle_headroom_min, CASE WHEN max("createdAt") OVER () < now() - interval '4 hours' THEN (max("createdAt") OVER () + interval '52 hours') ELSE NULL END AS ripen_at, COALESCE(ROUND(EXTRACT(EPOCH FROM ("createdAt" - lag("createdAt") OVER (ORDER BY "createdAt")))/60), -1)::int AS prev_gap_min, CASE WHEN max("createdAt") OVER () < now() - interval '4 hours' AND now() - max("createdAt") OVER () <= interval '52 hours' THEN 'window_idle' WHEN "createdAt" > TIMESTAMPTZ '2026-10-10 07:47:00+00' AND (meta->>'authMs')::numeric > 1000 THEN 'stale_post_fix' WHEN max("createdAt") OVER () < now() - interval '4 hours' THEN 'idle_beyond_history' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='supervisor_send_timing' ORDER BY "createdAt" DESC LIMIT 5`));
  // Wake prompt size vs the 14,000-char compaction clip (rider follow-up): a
  // hook/schedule wake user row already ran ~17 KB before riders; riders add
  // ≤8 KB. The clip bites only in compaction/recovery mid-run — this section
  // shows how many machine-wake rows would be head+tail clipped if it did.
  await sec('wake_prompt_size_vs_clip_24h', () => q(`SELECT LEFT("chatId"::text,8) AS chat, metadata->>'origin' AS origin, COUNT(*)::int AS n, MAX(length(content))::int AS max_chars, COUNT(*) FILTER (WHERE length(content) > 14000) AS over_clip, COUNT(*) FILTER (WHERE content LIKE '%[QUEUED WHILE BUSY%') AS with_rider FROM crossmodel_messages WHERE role='user' AND metadata->>'origin' IN ('hook','schedule') AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2 ORDER BY 4 DESC LIMIT 12`));
  // Session-scope memory retention (owner 2026-09-24 dynamic caps): evictions by
  // reason/source — 'source_cap' rows must be > 24 h old by construction;
  // 'hard_ceiling' firing often means a lane writes > 6,000 rows/day.
  await sec('memory_scope_evictions_24h', () => q(`SELECT meta->>'scopeType' AS scope_type, COALESCE(meta->>'reason','legacy') AS reason, COALESCE(meta->>'source','(scope-wide)') AS source, COUNT(*)::int AS events, SUM(value)::int AS rows FROM loop_metrics WHERE kind='memory_scope_evicted' AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2,3 ORDER BY 5 DESC LIMIT 12`));
  // Iteration-8 retention spot-check (FO firing 16, 2026-09-24): the rollup above
  // reads loop_metrics only; the owner's verify-over-24h criteria 1–3 need
  // digby_memory reads that firing 16 had to hand-roll in a tmp probe (whose
  // head was nearly lost to the SSM cap). (1) source_cap: pair every evicted
  // (scope, source) with its CURRENT survivor profile — rows_now must sit ≤ cap,
  // rows_older_24h is the pool the 24h floor leaves deletable; a rows_deleted
  // larger than that pool means a younger-than-24h row went → hand-verify the
  // event, report, set SESSION_SCOPE_DYNAMIC_CAP_DISABLED=1. (2) hard_ceiling
  // events must stay rare (a session writing >6,000 rows/day trips it) + top
  // scope totals for ceiling proximity. (3) compaction rows must survive in
  // busy scopes. (4) vec p90 hourly trend — the prefilter recency cap must keep
  // it flat (a sustained climb = report + kill switch, per the steer).
  await sec('i8_retention_check', async () => ({
    source_cap_spotcheck: await q(`WITH ev AS (SELECT meta->>'scopeId' AS sid, meta->>'source' AS src, COUNT(*)::int AS events, SUM(value)::int AS rows_deleted, MAX((meta->>'cap')::int) AS cap, MAX("createdAt") AS last_at FROM loop_metrics WHERE kind='memory_scope_evicted' AND meta->>'reason'='source_cap' AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2) SELECT LEFT(ev.sid,8) AS scope, ev.src AS source, ev.events, ev.rows_deleted, ev.cap, ev.last_at, (SELECT COUNT(*)::int FROM digby_memory m WHERE m.scope_type='session' AND m.scope_id=ev.sid AND m.source=ev.src) AS rows_now, (SELECT COUNT(*)::int FROM digby_memory m WHERE m.scope_type='session' AND m.scope_id=ev.sid AND m.source=ev.src AND m.created_at < now() - interval '24 hours') AS rows_older_24h, (SELECT ROUND(EXTRACT(EPOCH FROM (now()-MIN(m.created_at)))/3600)::int FROM digby_memory m WHERE m.scope_type='session' AND m.scope_id=ev.sid AND m.source=ev.src) AS oldest_surv_h, (SELECT ROUND(EXTRACT(EPOCH FROM (now()-MAX(m.created_at)))/3600)::int FROM digby_memory m WHERE m.scope_type='session' AND m.scope_id=ev.sid AND m.source=ev.src) AS newest_surv_h FROM ev ORDER BY ev.rows_deleted DESC LIMIT 8`),
    hard_ceiling_events: await q(`SELECT LEFT(meta->>'scopeId',8) AS scope, COUNT(*)::int AS events, SUM(value)::int AS rows FROM loop_metrics WHERE kind='memory_scope_evicted' AND meta->>'reason'='hard_ceiling' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`),
    scope_totals_top: await q(`SELECT LEFT(scope_id,8) AS scope, COUNT(*)::int AS total, COUNT(DISTINCT source)::int AS sources FROM digby_memory WHERE scope_type='session' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`),
    compaction_survival: await q(`SELECT LEFT(scope_id,8) AS scope, COUNT(*)::int AS compaction_rows, ROUND(EXTRACT(EPOCH FROM (now()-MAX(created_at)))/3600)::int AS newest_h FROM digby_memory WHERE scope_type='session' AND source='compaction' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    vec_p90_hourly: await q(`SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n, percentile_cont(0.9) WITHIN GROUP (ORDER BY COALESCE(value, (meta->>'totalMs')::numeric))::int AS p90_ms, ROUND(AVG((meta->>'vecMs')::numeric))::int AS avg_vec_ms FROM loop_metrics WHERE kind='memory_search_timing' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`),
  }));
  // Iteration-9 hit-aware eviction spot-checks (owner steer 2026-09-24 ~20:20Z,
  // c800dc6e): memSearch stamps the rows it RETURNS with last_hit_at (one
  // fire-and-forget UPDATE per search, off the critical path) and the session
  // source cap keeps rows hit within MEM_HIT_KEEP_DAYS (7) ahead of never-hit
  // rows, then newest-first; the hard ceiling stays pure recency. Watch: (1) the
  // column exists (ensureTable ALTER … ADD COLUMN IF NOT EXISTS — no migration);
  // (2) the session-scope stamped share climbs from 0 over the day; (3) source_cap
  // eviction rows carry meta.hitAware=true and, in a busy scope, rows OLDER than
  // the newest 800 of their source survive WITH last_hit_at set (the keep-set
  // effect); (4) the stamping UPDATE never appears in error logs. Kill switch
  // MEM_HIT_AWARE_EVICTION_DISABLED=1 (stamping AND ordering).
  await sec('i9_hit_aware_check', async () => {
    const col = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='digby_memory' AND column_name='last_hit_at'`);
    if (!col.length) return { column_present: false };
    return {
      column_present: true,
      session_hit_share: await q(`SELECT COUNT(*)::int AS total, COUNT(last_hit_at)::int AS stamped, ROUND(100.0 * COUNT(last_hit_at) / NULLIF(COUNT(*),0), 1) AS stamped_pct FROM digby_memory WHERE scope_type='session'`),
      stamped_by_hour: await q(`SELECT date_trunc('hour', last_hit_at) AS h, COUNT(*)::int AS stamped FROM digby_memory WHERE scope_type='session' AND last_hit_at IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 12`),
      hitaware_evictions: await q(`SELECT LEFT(meta->>'scopeId',8) AS scope, meta->>'source' AS source, meta->>'hitAware' AS hit_aware, COUNT(*)::int AS events, SUM(value)::int AS rows, MAX("createdAt") AS last_at FROM loop_metrics WHERE kind='memory_scope_evicted' AND meta->>'reason'='source_cap' AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 6`),
      keep_set_effect: await q(`WITH ev AS (SELECT meta->>'scopeId' AS sid, meta->>'source' AS src FROM loop_metrics WHERE kind='memory_scope_evicted' AND meta->>'reason'='source_cap' AND "createdAt" > now() - interval '24 hours' GROUP BY 1,2), ranked AS (SELECT m.scope_id AS sid, m.source AS src, m.created_at, m.last_hit_at, row_number() OVER (PARTITION BY m.scope_id, m.source ORDER BY m.created_at DESC) AS rn FROM digby_memory m JOIN ev ON m.scope_id=ev.sid AND m.source=ev.src WHERE m.scope_type='session') SELECT LEFT(sid,8) AS scope, src AS source, COUNT(*)::int AS rows_now, COUNT(*) FILTER (WHERE rn>800)::int AS older_than_newest_800, COUNT(*) FILTER (WHERE rn>800 AND last_hit_at IS NOT NULL)::int AS older_kept_with_hit, COUNT(*) FILTER (WHERE last_hit_at IS NOT NULL)::int AS stamped_in_scope, MAX(created_at) AS newest_surv FROM ranked GROUP BY 1,2 ORDER BY 5 DESC LIMIT 6`),
      stamp_update_errors: await q(`SELECT COUNT(*)::int AS n FROM app_error_logs WHERE "createdAt" > now() - interval '24 hours' AND message ILIKE '%UPDATE digby_memory SET last_hit_at%'`),
    };
  });
  // 22P05 strip check (FO firing 20, PR #1041 / 10a552dfb): lone unpaired
  // surrogates in LLM text failed EVERY Postgres write of that text. The fix
  // strips at appendAgentEvent + appendCodingMessage/updateCodingMessage;
  // telemetry loop_metrics kind pg_unsafe_stripped {seam, chars}. Watch: the
  // strip rows appear as soon as a surrogate-bearing text hits a seam, and the
  // error classes below (unsupported Unicode escape / dropped agent_events
  // appends / final-transcript persist failures) go to zero for good — the
  // pre-fix history was 3–6/day since Sep 19, 18 on 2026-09-24. Kill switch
  // PG_UNSAFE_STRIP_DISABLED=1.
  await sec('p22p05_strip_check', async () => ({
    strip_rows_24h: await q(`SELECT meta->>'seam' AS seam, COUNT(*)::int AS n, SUM(value)::int AS chars, MAX("createdAt") AS last_at FROM loop_metrics WHERE kind='pg_unsafe_stripped' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    pg_unsafe_errors_by_day: await q(`SELECT date_trunc('day', "createdAt") AS d, COUNT(*)::int AS n FROM app_error_logs WHERE (message ILIKE '%unsupported Unicode escape%' OR message ILIKE '%dropped % agent_events append%' OR message ILIKE '%final transcript persist failed%') AND "createdAt" > now() - interval '7 days' GROUP BY 1 ORDER BY 1`),
  }));
  // Hardening loop iteration 10 (owner steer 2026-09-25 ~01:05Z, 4e40f1eb) —
  // three fixes to verify over 24 h after the wave lands:
  // (1) COMPACTION first-user exemption: the run's FIRST user message now rides
  //     FIRST_USER_MSG_CHAR_CAP (60k) instead of the flat 14k, so a supervisor
  //     wake's board digest / hook payload survives the first compaction. No
  //     'clipped … chars' marker may appear inside a first user message under
  //     60k after the wave. Kill switch COMPACTION_FIRST_USER_CLIP_EXEMPT_DISABLED.
  // (2) CLAIM TRANSACTION WAIT: claimNextRun's $transaction now waits
  //     RUN_CLAIM_TXN_MAX_WAIT_MS (10 s) for a pool slot instead of Prisma's
  //     2 s. The 'Unable to start a transaction' claim failures (13/day on
  //     2026-09-24, clustered in deploy-drain hours) must go to 0.
  // (3) LOCAL-PROVIDER MIRROR SELF-HEAL: ensureRunnable re-inits + seeds a lost
  //     bare mirror (project 922fd3ad class). Mirror-missing sync warns must
  //     stop and the next session run must start instead of failing with the
  //     empty-clone fatal. Kill switch LOCAL_MIRROR_SELFHEAL_DISABLED.
  await sec('i10_hardening_check', async () => ({
    claim_txn_errors_by_hour_24h: await q(`SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs WHERE message ILIKE '%claim failed (retrying next tick): Transaction API error: Unable to start a transaction%' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`),
    mirror_missing_warns_24h: await q(`SELECT LEFT(split_part(message, ' ', 4), 8) AS project_hint, COUNT(*)::int AS n, MAX("createdAt") AS last_at FROM app_error_logs WHERE message ILIKE '%mirror missing on disk%' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    mirror_selfheal_events: await q(`SELECT meta->>'projectId' AS project, COUNT(*)::int AS n, MAX("createdAt") AS last_at FROM loop_metrics WHERE kind='local_mirror_selfheal' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`),
    local_provider_failed_runs_24h: await q(`SELECT LEFT(ar."sessionId"::text,8) AS sess, COUNT(*)::int AS n, MAX(ar."createdAt") AS last_at, LEFT(MAX(ar.error), 90) AS err_head FROM agent_runs ar JOIN coding_sessions cs ON cs.id = ar."sessionId" JOIN crossmodel_projects p ON p.id = cs."projectId" WHERE p."repoProvider"='local' AND ar.status='failed' AND ar."createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 3 DESC LIMIT 6`),
    compacted_wakes_first_user_intact: await q(`SELECT LEFT(lm."sessionId"::text,8) AS chat, COUNT(*)::int AS compactions, MAX(lm."createdAt") AS last_at FROM loop_metrics lm WHERE lm.kind='context_compaction' AND lm."createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
  }));
  // Citation-class action-verifier second pass (owner steer 2026-09-25 ~01:05Z,
  // measurement, no fix): the enforced deterministic citation lane rejects a
  // supervisor note back for ONE bounded re-orchestration; each reject-back
  // costs a full model turn. citationRetry 'clean' = the second pass
  // self-corrected and delivered (the retry earned its cost); 'still_dirty' =
  // the strip/replace lane ran anyway (the retry was wasted). Rows with NO
  // citationRetry are the observe-only strikes (pass-1 only, delivered
  // unmodified since the 2026-09-11 gate flip) — they never re-orchestrate.
  // VERDICT BAKE (FO f97, 28th f64 bake): agg_7d is the one row the eye reads
  // — retries, still_dirty, waste_share (%), verdict: ESCALATE when the 7d
  // window ran >= 3 retries AND >= 50 % of them were still_dirty (the retry
  // lane is then burning more model turns than it saves — kill-switch
  // territory). Calibrated on box A probe-f97-waste.js (2026-10-08T02:4xZ,
  // 14 days): daily waste share max 37.5 % (2026-10-05, 3/8), median ~15 %,
  // so the 50 % bar trips on 0/14 days — each trip is a real waste event, not
  // fleet noise. still_dirty_by_chat_7d prints the concentration rung
  // ('live:agent_behavior' at >= 5, watch-only, the f94 recurring vocabulary):
  // 6 of the current window's 13 still_dirty come from ONE chat (c0e22e36, the
  // Fleet Supervisor lane — a busy lane that quotes stored future clocks), the
  // same shape f94/f96 pinned for journal failures.
  // F169 AGE GUARD (2026-10-20, 32nd f64 bake): the daily verdict ESCALATEs
  // only FRESH days (age_d <= 3); an over-bar day older than 3 days reads
  // 'aging' (watch-only — it is sliding out of the rolling 7d window; agg_7d
  // still covers the window). Motivation: 2026-10-13 printed the audit's ONLY
  // ESCALATE row across f168+f169 while actively improving (total 17→14→11,
  // still_dirty 3→2) — two firings re-adjudicated a day the calendar was
  // already clearing, the exact by-eye tax this doctrine exists to remove.
  // Fresh-bar behavior unchanged: the 10-13 day WOULD have ESCALATEd on
  // Oct 13-16 when the spike deserved action (age <= 3 keeps it loud).
  await sec('citation_retry_outcomes_7d', async () => ({
    by_outcome: await q(`SELECT COALESCE(meta->>'citationRetry','(pass1-only)') AS retry_outcome, COUNT(*)::int AS n, ROUND(AVG((meta->>'retryMs')::numeric))::int AS avg_retry_ms FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='machine_wake_reject_back' AND "createdAt" > now() - interval '7 days' GROUP BY 1`),
    agg_7d: await q(`SELECT COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty'))::int AS retries, COUNT(*) FILTER (WHERE meta->>'citationRetry'='still_dirty')::int AS still_dirty, COUNT(*) FILTER (WHERE meta->>'citationRetry'='clean')::int AS clean, ROUND(100.0 * COUNT(*) FILTER (WHERE meta->>'citationRetry'='still_dirty') / NULLIF(COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty')), 0), 1) AS waste_share, CASE WHEN COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty')) >= 3 AND COUNT(*) FILTER (WHERE meta->>'citationRetry'='still_dirty') * 2 >= COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty')) THEN 'ESCALATE' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='machine_wake_reject_back' AND "createdAt" > now() - interval '7 days'`),
    daily: await q(`SELECT date_trunc('day', "createdAt") AS d, (now()::date - date_trunc('day', "createdAt")::date)::int AS age_d, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE meta->>'citationRetry'='still_dirty')::int AS still_dirty, COUNT(*) FILTER (WHERE meta->>'citationRetry'='clean')::int AS clean, ROUND(100.0 * COUNT(*) FILTER (WHERE meta->>'citationRetry'='still_dirty') / NULLIF(COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty')), 0), 1) AS waste_share, CASE WHEN COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty')) >= 3 AND COUNT(*) FILTER (WHERE meta->>'citationRetry'='still_dirty') * 2 >= COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty')) AND (now()::date - date_trunc('day', "createdAt")::date) <= 3 THEN 'ESCALATE' WHEN COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty')) >= 3 AND COUNT(*) FILTER (WHERE meta->>'citationRetry'='still_dirty') * 2 >= COUNT(*) FILTER (WHERE meta->>'citationRetry' IN ('clean','still_dirty')) THEN 'aging' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='machine_wake_reject_back' AND "createdAt" > now() - interval '7 days' GROUP BY 1 ORDER BY 1`),
    still_dirty_by_chat_7d: await q(`SELECT LEFT("sessionId"::text,8) AS chat, COUNT(*)::int AS still_dirty, CASE WHEN COUNT(*) >= 5 THEN 'live:agent_behavior' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='machine_wake_reject_back' AND meta->>'citationRetry'='still_dirty' AND "createdAt" > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
  }));
  // Owner steer a1f2021a (2026-09-25 ~02:40Z, backlog close-out) — create_chat_webhook
  // owner-browser token hand-off: the bearer token is shown ONCE in the owner's
  // browser and must NEVER persist beyond the 12-char 'dgw_xxxxxxxx' prefix in
  // run_tool_receipts / agent_events / coding_messages / loop_metrics. Real
  // tokens are dgw_ + 40+ random token chars; doc-string echoes (this audit's
  // own key names, steer text quoted in transcripts) top out < 16 — the {20,}
  // shape is the honest discriminator. Also watches stage_upload-from-document
  // and the webhook.create Activity row (ownerBrowser).
  await sec('steer_a1_check', async () => ({
    dgw_token_beyond_24h: await q(`SELECT 'agent_events' AS t, COUNT(*)::int AS n FROM agent_events WHERE "createdAt" > now() - interval '24 hours' AND COALESCE(payload::text,'') ~ 'dgw_[A-Za-z0-9_-]{20,}' UNION ALL SELECT 'coding_messages', COUNT(*)::int FROM coding_messages WHERE "createdAt" > now() - interval '24 hours' AND COALESCE(content::text,'') ~ 'dgw_[A-Za-z0-9_-]{20,}' UNION ALL SELECT 'run_tool_receipts', COUNT(*)::int FROM run_tool_receipts WHERE (ids::text) ~ 'dgw_[A-Za-z0-9_-]{20,}' UNION ALL SELECT 'loop_metrics', COUNT(*)::int FROM loop_metrics WHERE (meta::text) ~ 'dgw_[A-Za-z0-9_-]{20,}'`),
    webhook_receipts_24h: await q(`SELECT ok, COUNT(*)::int AS n, MAX("createdAt") AS last_at FROM run_tool_receipts WHERE tool='create_chat_webhook' AND "createdAt" > now() - interval '24 hours' GROUP BY 1`),
    webhook_activities_24h: await q(`SELECT action, COUNT(*)::int AS n, MAX("createdAt") AS last_at, MAX(LEFT((metadata->'ownerBrowser')::text, 10)) AS owner_browser FROM activities WHERE (action LIKE '%webhook%' OR resource LIKE '%webhook%') AND "createdAt" > now() - interval '24 hours' GROUP BY 1`),
    stage_upload_receipts_24h: await q(`SELECT ok, COUNT(*)::int AS n, MAX("createdAt") AS last_at FROM run_tool_receipts WHERE tool='stage_upload' AND "createdAt" > now() - interval '24 hours' GROUP BY 1`),
  }));
  // Owner steer 46bddc66 (2026-09-25 ~03:20Z, workspace-start fix) — start_coding_session
  // projectId resolution: exact name / chat id inside the project / omitted (this
  // chat's project) all resolve; only INVENTED ids may fail. Resolution failures
  // must be invented-uuid-only (each one a fabrication by its lane), and no new
  // 'Could not re-provision' / 'Workspace missing on disk' errors may appear.
  await sec('steer_46b_check', async () => ({
    resolution_failures_24h: await q(`SELECT LEFT(split_part(message, ' ', 4), 20) AS target_hint, COUNT(*)::int AS n, MAX("createdAt") AS last_at, LEFT(MAX(message), 240) AS msg_head FROM app_error_logs WHERE message ILIKE '%startCodingSession target resolution failed%' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 3 DESC LIMIT 8`),
    reprovision_errors_24h: await q(`SELECT COUNT(*)::int AS n, MAX("createdAt") AS last_at FROM app_error_logs WHERE (message ILIKE '%Could not re-provision%' OR message ILIKE '%Workspace missing on disk%') AND "createdAt" > now() - interval '24 hours'`),
    remote_origin_attach_24h: await q(`SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs WHERE message ILIKE '%No such remote%' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1 DESC LIMIT 10`),
    spawn_receipts_24h: await q(`SELECT ok, COUNT(*)::int AS n, MAX("createdAt") AS last_at, COUNT(*) FILTER (WHERE (ids->>'projectId') IS NOT NULL)::int AS with_full_project_id FROM run_tool_receipts WHERE tool='start_coding_session' AND "createdAt" > now() - interval '24 hours' GROUP BY 1`),
  }));
  // Hardening loop iteration 11 (owner steer 2026-09-25, 051752aea) —
  // estimate-governed forward clocks ("~6:20 PM PDT", "by ~11:45 AM PDT") are
  // no longer convicted as impossible observations. The reject-back strike meta
  // now carries clockHits [{token, minutesAhead, line}]: after the wave lands,
  // NO clockHits token may be ~-prefixed or by/before-governed (the exempted
  // idioms); the remaining strike classes are reported verbatim. Until the
  // wave lands, the error-log 'future-clock strike' rows are the pre-fix
  // baseline (~1-3/h, 61 on the Fleet Supervisor over 7 days).
  await sec('i11_clock_check', async () => ({
    clock_strikes_by_hour_24h: await q(`SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs WHERE message ILIKE '%future-clock strike%' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1 DESC LIMIT 24`),
    reject_back_with_clockhits_24h: await q(`SELECT LEFT(l."sessionId"::text,8) AS sess, l."createdAt", (l.meta->'clockHits')::text AS clockhits, (SELECT array_agg((ch->>'minutesAhead')::int ORDER BY (ch->>'minutesAhead')::int) FROM jsonb_array_elements(l.meta->'clockHits') ch) AS minutes_ahead, CASE WHEN (SELECT COUNT(*) FROM jsonb_array_elements(l.meta->'clockHits') ch) = 0 THEN 'no_hits' WHEN (SELECT MAX((ch->>'minutesAhead')::int) FROM jsonb_array_elements(l.meta->'clockHits') ch) > 240 THEN 'quoted_stored_future' WHEN EXISTS (SELECT 1 FROM loop_metrics l2 WHERE l2.kind='guard_strike' AND l2.meta->>'seam'='machine_wake_reject_back' AND l2."sessionId" = l."sessionId" AND l2."createdAt" > now() - interval '7 days' AND l2."createdAt" < l."createdAt") THEN 'recurrence_7d' ELSE 'near_term_estimate' END AS verdict, (SELECT COUNT(*) FROM loop_metrics l2 WHERE l2.kind='guard_strike' AND l2.meta->>'seam'='machine_wake_reject_back' AND l2."sessionId" = l."sessionId" AND l2."createdAt" > now() - interval '7 days' AND l2."createdAt" < l."createdAt")::int AS recurrence_7d FROM loop_metrics l WHERE l.kind='guard_strike' AND l.meta->>'seam'='machine_wake_reject_back' AND l.meta ? 'clockHits' AND l."createdAt" > now() - interval '24 hours' ORDER BY l."createdAt" DESC LIMIT 8`),
    clockhits_exempt_leak_24h: await q(`SELECT COUNT(*)::int AS n FROM loop_metrics WHERE kind='guard_strike' AND meta ? 'clockHits' AND "createdAt" > now() - interval '24 hours' AND ((meta->'clockHits')::text ~ '"token": ?[~≈]' OR (meta->'clockHits')::text ~ '"token": ?[Bb]y')`),
    future_dated_strikes_24h: await q(`SELECT LEFT("sessionId"::text,8) AS sess, meta->>'seam' AS seam, COUNT(*)::int AS n, MAX("createdAt") AS last_at FROM loop_metrics WHERE kind='guard_strike' AND "createdAt" > now() - interval '24 hours' AND (meta->'kinds')::text LIKE '%future_dated%' GROUP BY 1,2 ORDER BY 4 DESC LIMIT 8`),
  }));
  // ── defect_rollup (firing 98, 2026-10-08 — 29th f64 bake; bars corrected
  // by firings 99 + 101 — 31st f64 bake) ────────────────────────────────
  // F101 BAR CORRECTIONS (the f99 contract — a rollup condition must COPY its
  // detail's rung, never a simpler proxy): both population bars here keyed on
  // RAW counts and both fired false ESCALATEs in f101's window —
  //   failed_runs_4h counted every failed run, but a failed run whose chat
  //     has a live sibling (a running/queued run created before OR after the
  //     death — the c919294b concurrent-sibling class) is the detail's
  //     live:retried rung, watch-only; only a dead-end failure (no live
  //     sibling either side) ESCALATEs. Bar stays n > 0, population now
  //     adjudicated.
  //   journal_fanout_4h counted ALL failure rows (raw distinct chats >= 8);
  //     measured over 42 4h buckets the raw bar fired 4x with ZERO
  //     adjudicated-ESCALATE chats in each — the population is now the
  //     detail rung verbatim (run-missing or dead run with no sibling) and
  //     the bar is >= 2 distinct adjudicated chats (a singleton stays the
  //     detail section's ESCALATE row, probed by the firing — single =
  //     agent behavior by doctrine). F159: the run-missing arm now also
  //     requires a NON-NULL runId — supervisor chat turns journal with
  //     runId NULL by design (see the f159 comment above journal_failures_4h);
  //     live proof 2026-10-18T15:0xZ box A: old arm 8 chats, new arm 0.
  // Every firing ends by eyeballing ~13 must-be-zero conditions scattered
  // across sections (failed runs, interrupted, zero-tool finals, deploy
  // interrupts, hook backlog/failures, crosscheck failures, error spikes,
  // auth ESL, schedule trouble, journal fanout, parse-error sources, stalled
  // retention, degraded compaction) — each "0 rows = ok" read is a by-eye
  // verdict the f64 doctrine exists to retire (the f96 fanout rollup, but
  // generalized to the whole checklist). This bake unions every condition
  // into ONE section: per-condition {cond, n, verdict} rows (each carrying
  // the SAME bar its detail section already bakes — no new thresholds
  // invented here) plus a single OVERALL verdict computed from the rows.
  // Watch-only classes stay watch-only in their detail sections and are
  // deliberately NOT escalated here (journal 'live:agent_behavior' recurrence,
  // compaction 'degraded' <= 5 %, citation-waste concentration, hook
  // dead_source/dead_target terminal rows, deploy-alert 'no_ci_verdict'
  // dispatch-gap rows); the rollup escalates only what the charter escalates.
  // F99 BAR CORRECTIONS (both live-proven 2026-10-08): (1) crosscheck_failed_
  // 24h carried a STRICTER bar than its detail (n>0) and escalated a
  // live:once row (chat 110b7062, recurrence_7d=1) the detail adjudicates
  // watch-only — it now repeats the detail's recurrence_7d > 1 rung; (2)
  // deploy_interrupts_24h was message-keyed and read 0 while a real
  // escalation-rung interrupt landed (chat 182f27b7, 07:37Z — requeue paths
  // write no notice row) — it now reads the loop_metrics seam and repeats the
  // deploy view's own bar (same-chat repeat = drain-budget defect, not a
  // by-design singleton re-fire).
  // F100 ADDITION (30th bake, 2026-10-08): merge_gate_failure_dangling_24h —
  // the rollup now carries the merge-gate dangling rung (no merge_success for
  // the same repo+PR after 6h) so a refused-then-abandoned PR escalates
  // without a hand-run box probe; recovered and in-flight (<6h) rows stay
  // watch-only in the merge_gate_failure_24h detail section.
  // F172 BAR CORRECTION (34th bake, 2026-10-20): hook_pending_stale_15m_now
  // gets the PARK VERDICT AXIS — the raw count escalated a DESIGNED busy:park
  // (f172 live: Fleet Supervisor c0e22e36 pending 2, oldest 18 min, both
  // detail sections verdict busy:park while the rollup read ESCALATE — the
  // wake pipeline parking events on a busy target is the debounce/retry loop
  // working, not a stuck hook). The condition now counts only stale pendings
  // whose TARGET GROUP's verdict is 'ESCALATE' under the SAME arms
  // hook_oldest_pending_now computes (parked:triage / busy:park / busy:target
  // / debounce — same order, the f81 lesson: drift between the two surfaces
  // would silently re-arm the false positive). A genuinely stuck pending (no
  // park arm holds) still counts at its full staleness — bar stays n > 0.
  // F174 ADDENDUM (35th bake, 2026-10-21): all three arm chains gain
  // scheduled:future between busy:target and debounce — MAX(retryAt) > now()
  // means the row's FIRST attempt has not come due (await_condition backstop
  // wakes park a todo_wake at notBefore = createdAt + 3h, attempts 0; the
  // four f174 rows were deploy-awaits on ticket lanes 1b26faf8/7cdd44e4/
  // 46ecec8d/2855cff2 — probe of payload->>'summary' showed '[CONDITION WAIT
  // — BACKSTOP]'). A due-but-untouched row still falls through to ESCALATE;
  // parity across the three sites is pinned by audit-live-state.test.sh
  // case 4 (the f81 drift lesson, now executable).
  // f180 (2026-10-22): memory_parse_error_4h carries the SAME denominator floor
  // as its detail rung (memory_extraction_parse_share_4h) — HAVING COUNT(*) >= 10 —
  // so a rare source's single truncation (1-of-1 = 100 % share) no longer counts
  // as a systematic parse failure. f171's true positive (99/139) stays counted.
  await sec('defect_rollup', async () => {
    const conditions = await q(`SELECT * FROM (
      SELECT 'failed_runs_4h' AS cond, (SELECT COUNT(*) FROM agent_runs r WHERE r.status='failed' AND r."createdAt" > now() - interval '4 hours' AND NOT EXISTS (SELECT 1 FROM agent_runs r2 WHERE r2."sessionId" = r."sessionId" AND r2.id <> r.id AND ((r2."createdAt" > r."createdAt" AND r2.status IN ('running','queued','completed')) OR (r2."createdAt" <= r."createdAt" AND (r2.status IN ('running','queued') OR (r2."finishedAt" IS NOT NULL AND r2."finishedAt" > r."createdAt"))))))::int AS n
      UNION ALL SELECT 'interrupted_runs_24h', (SELECT COUNT(*) FROM agent_runs WHERE status='interrupted' AND "updatedAt" > now() - interval '24 hours')::int
      UNION ALL SELECT 'zero_tool_finals_4h', (SELECT COUNT(*) FROM loop_metrics WHERE kind IN ('zero_tool_final','zero_tool_gate') AND "createdAt" > now() - interval '4 hours')::int
      UNION ALL SELECT 'deploy_interrupts_24h', (SELECT COUNT(*) FROM (SELECT "sessionId" FROM loop_metrics WHERE kind='chat_run_interrupted' AND meta->>'reason'='deploy' AND "createdAt" > now() - interval '24 hours' AND "sessionId" IS NOT NULL GROUP BY "sessionId" HAVING COUNT(*) >= 2) t)::int
      UNION ALL SELECT 'hook_pending_stale_15m_now', (SELECT COALESCE(SUM(g.stale),0)::int FROM (SELECT h."targetChatId", COUNT(*) FILTER (WHERE e."createdAt" < now() - interval '15 minutes') AS stale, CASE WHEN MIN(e."createdAt") > now() - interval '15 minutes' THEN 'ok' WHEN EXISTS (SELECT 1 FROM loop_metrics wp WHERE wp.kind='wake_parked' AND wp.meta->>'reason'='triage' AND wp."sessionId" = h."targetChatId" AND wp."createdAt" > now() - interval '35 minutes' AND wp."createdAt" >= MIN(e."createdAt") - interval '1 minute') AND MAX(e."retryAt") > now() THEN 'parked:triage' WHEN MAX(e."updatedAt") > now() - interval '5 minutes' THEN 'busy:park' WHEN EXISTS (SELECT 1 FROM agent_runs r WHERE r."sessionId" = h."targetChatId" AND r.status = 'running' AND r."heartbeatAt" > now() - interval '5 minutes') THEN 'busy:target' WHEN MAX(e."retryAt") > now() THEN 'scheduled:future' WHEN BOOL_OR(EXTRACT(EPOCH FROM (now() - h."lastFiredAt")) < h."debounceSec") THEN 'debounce' ELSE 'ESCALATE' END AS verdict FROM hook_events e JOIN event_hooks h ON h.id = e."hookId" WHERE e.status IN ('pending','delivering') GROUP BY h."targetChatId") g WHERE g.verdict = 'ESCALATE')
      UNION ALL SELECT 'hook_failed_4h', (SELECT COUNT(*) FROM hook_events WHERE status LIKE 'failed%' AND status NOT IN ('failed:source_gone','failed:target_gone') AND "createdAt" > now() - interval '4 hours')::int
      UNION ALL SELECT 'crosscheck_failed_24h', (SELECT COUNT(*) FROM loop_metrics m LEFT JOIN crossmodel_chats c ON c.id = m."sessionId" WHERE m.kind='crosscheck_late_reconcile' AND m."createdAt" > now() - interval '24 hours' AND m.meta->>'outcome' IN ('reconcile_failed','timeout') AND c.id IS NOT NULL AND c.title NOT LIKE 'e2e suite%' AND (SELECT COUNT(*) FROM loop_metrics m7 WHERE m7.kind='crosscheck_late_reconcile' AND m7.meta->>'outcome'='reconcile_failed' AND m7."sessionId" = m."sessionId" AND m7."createdAt" > now() - interval '7 days') > 1)::int
      UNION ALL SELECT 'infra_alert_ci_red_24h', (SELECT COUNT(*) FROM loop_metrics m WHERE m.kind='infra_alert' AND m.meta->>'kind'='deploy' AND m.meta->>'ciVerdict' = 'failure' AND m."createdAt" > now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM loop_metrics s WHERE s.kind='deploy_wave_success' AND (s.meta->>'at')::timestamptz > m."createdAt") AND now() - m."createdAt" > interval '6 hours')::int
      UNION ALL SELECT 'schedules_trouble_now', (SELECT COUNT(*) FROM coding_schedules WHERE enabled AND ("busySkips" >= 10 OR "lastStatus" LIKE 'error%' OR "nextRunAt" < now() - interval '20 minutes'))::int
      UNION ALL SELECT 'auth_escalate_4h', (SELECT COUNT(*) FROM (SELECT meta->>'emailHash' AS eh FROM loop_metrics WHERE kind='auth_login_failed' AND "createdAt" > now() - interval '4 hours' AND COALESCE(meta->>'emailHash','') <> '0034506974bc51de' GROUP BY 1 HAVING COUNT(DISTINCT COALESCE(NULLIF(meta->>'clientIpHash',''), meta->>'ipHash','(none)')) >= 3 OR COUNT(*) > 30) t)::int
      UNION ALL SELECT 'journal_fanout_4h', (SELECT COUNT(DISTINCT j."chatId") FROM run_journal_entries j LEFT JOIN agent_runs r ON r.id = j."runId" WHERE j."createdAt" > now() - interval '4 hours' AND array_length(j.failures, 1) > 0 AND ((j."runId" IS NOT NULL AND r.id IS NULL) OR (r.status IN ('failed','cancelled','interrupted') AND NOT EXISTS (SELECT 1 FROM agent_runs r2 WHERE r2."sessionId" = j."chatId" AND r2.id <> j."runId" AND r2."createdAt" > j."createdAt" AND r2.status IN ('running','queued','completed')) AND NOT EXISTS (SELECT 1 FROM agent_runs r3 WHERE r3."sessionId" = j."chatId" AND r3.id <> j."runId" AND r3."createdAt" <= j."createdAt" AND (r3.status IN ('running','queued') OR (r3."finishedAt" IS NOT NULL AND r3."finishedAt" > j."createdAt"))))))::int
      UNION ALL SELECT 'memory_parse_error_4h', (SELECT COUNT(*) FROM (SELECT meta->>'source' AS s FROM loop_metrics WHERE kind='memory_extraction' AND "createdAt" > now() - interval '4 hours' GROUP BY 1 HAVING COUNT(*) >= 10 AND COUNT(*) FILTER (WHERE meta->>'outcome' = 'parse_error') * 10 > COUNT(*)) t)::int
      UNION ALL SELECT 'merge_gate_failure_dangling_24h', (SELECT COUNT(*) FROM loop_metrics m WHERE m.kind='merge_gate_failure' AND m."createdAt" > now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM loop_metrics s WHERE s.kind='merge_success' AND s."createdAt" > m."createdAt" AND s.meta->>'pullNumber' = m.meta->>'pullNumber' AND s.meta->>'repo' = m.meta->>'repo') AND NOT EXISTS (SELECT 1 FROM loop_metrics t WHERE t.kind IN ('merge_gate_failure','merge_success') AND t."sessionId" = m."sessionId" AND t."createdAt" > m."createdAt" AND (t.meta->>'repo', t.meta->>'pullNumber') <> (m.meta->>'repo', m.meta->>'pullNumber')) AND now() - m."createdAt" > interval '6 hours')::int
    ) counts JOIN LATERAL (SELECT CASE WHEN cond = 'journal_fanout_4h' AND n >= 2 THEN 'ESCALATE' WHEN cond = 'journal_fanout_4h' THEN 'ok' WHEN n > 0 THEN 'ESCALATE' ELSE 'ok' END AS verdict) v ON true ORDER BY cond`);
    const rows = conditions || [];
    const escalates = rows.filter((c) => c.verdict === 'ESCALATE');
    // F161 BAKE (2026-10-18): ESCALATE rows sort FIRST — the F153 byte-budget
    // trimmer drops TAIL rows, and an alphabetically-tail escalated condition
    // was cut from f161's live audit (merge_gate_failure_dangling_24h: the
    // _trimmed ledger read kept 11 / dropped 3), so the overall said ESCALATE
    // while the row naming WHY was gone — the firing had to hand-run a box
    // probe to identify an escalation the audit had already computed. With
    // escalated rows at the head, any tail trim can only ever drop quiet rows.
    rows.sort((a, b) => (a.verdict === 'ESCALATE' ? 0 : 1) - (b.verdict === 'ESCALATE' ? 0 : 1) || String(a.cond).localeCompare(String(b.cond)));
    return {
      overall: { verdict: escalates.length ? 'ESCALATE' : 'ok', escalate_n: escalates.length, escalated: escalates.map((c) => c.cond) },
      conditions: rows,
    };
  });
  // ── defect_rollup liveness companions (same bars, one more pass each) ──────
  // Retention + compaction have graded ladders (not must-be-zero), so their
  // rollup rows repeat the ESCALATE rung of their detail sections here.
  await sec('defect_rollup_graded', async () => ({
    retention_4h: await q(`SELECT COUNT(*)::int AS ticks, MAX("createdAt") AS last_tick, EXISTS (SELECT 1 FROM agent_events WHERE "createdAt" < now() - interval '30 days') AS backlog, CASE WHEN COUNT(*) = 0 AND EXISTS (SELECT 1 FROM agent_events WHERE "createdAt" < now() - interval '30 days') THEN 'off_or_stuck' WHEN MAX("createdAt") < now() - interval '10 minutes' AND EXISTS (SELECT 1 FROM agent_events WHERE "createdAt" < now() - interval '30 days') THEN 'stalled' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='agent_events_retention' AND "createdAt" > now() - interval '4 hours'`),
    compaction_4h: await q(`SELECT COUNT(*)::int AS n, SUM(CASE WHEN (meta->>'summarizerOk')::boolean THEN 1 ELSE 0 END)::int AS summarizer_ok, CASE WHEN COUNT(*) = 0 THEN 'ok' WHEN SUM(CASE WHEN (meta->>'summarizerOk')::boolean THEN 1 ELSE 0 END) * 20 < COUNT(*) * 19 THEN 'ESCALATE' ELSE 'ok' END AS verdict FROM loop_metrics WHERE kind='context_compaction' AND "createdAt" > now() - interval '4 hours'`),
  }));
  // ── F153 FIX (2026-10-17): rollup-first order + byte-budget trim + end sentinel ──
  // The box transport (docker exec stream through SSM, parked by run-on-box.sh)
  // silently truncates the probe's stdout at ~64 KiB: f152's audit was 61,413 B
  // (complete); f153's crossed the ceiling and the box-side parked file was
  // 65,537 B — cut mid-JSON, losing defect_rollup + defect_rollup_graded, the
  // firing's own verdict sections. Three guards, all probe-side:
  //  (1) EMIT the two rollup sections FIRST so even a truncated read still
  //      carries the overall verdict;
  //  (2) TRIM the largest array sections (tail rows dropped, head kept) until
  //      the payload is under BUDGET bytes — what was dropped is recorded in
  //      out._trimmed so a read never mistakes a cut section for a quiet one;
  //  (3) print an __AUDIT_END__ sentinel (+ byte count) so any reader can tell
  //      a complete read from a truncated one WITHOUT parsing.
  const BUDGET = 60000; // bytes — stays under the observed ~64 KiB transport ceiling
  const KEEP_MIN = 6;   // preferred floor for trimmed array sections (gentle passes)
  // Load-bearing small sections are never trimmed — their rows are the firing's
  // verdicts and their real-world size is a few rows (jwt 2, box_health 4).
  const NEVER_TRIM = new Set(['jwt_spike_watch_4h', 'box_health', 'backup_fleet', 'auth_login_failures_4h', 'auth_login_failures_by_email_4h', 'schedules_trouble', 'schedules_enabled']);
  const { defect_rollup, defect_rollup_graded, ...rest } = out;
  const finalOut = { defect_rollup, defect_rollup_graded, ...rest };
  // sizeOf MUST match the emitted serialization (indent 1): measuring compact
  // bytes while emitting pretty ones makes ratio>=1 look 'under budget' with a
  // 60-90 KB pretty payload (f153 bake 2: loop broke, sentinel cut at 65,537).
  const sizeOf = (v) => Buffer.byteLength(JSON.stringify(v, BIG, 1));
  // Arrays live BOTH as top-level section values AND nested inside object
  // sections (defect_rollup_graded.retention_4h, citation_retry_outcomes_7d.daily,
  // the i8/i9/i10/steer_* check objects) — trimming only the top level leaves
  // the nested majority of a fat payload uncut (f153 local test: 738 KB).
  const collectInto = (topKey) => {
    const acc = [];
    const v = finalOut[topKey];
    if (Array.isArray(v)) acc.push({ parent: finalOut, prop: topKey, arr: v });
    else if (v && typeof v === 'object') {
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 5) return;
        for (const [prop, val] of Object.entries(o)) {
          // F161 BAKE: never collect arrays under an 'overall' verdict object —
          // defect_rollup.overall.escalated NAMES the escalated conditions, so
          // letting the ratio cut it erases the audit's own escalation names
          // exactly when the escalated ROWS are pinned to survive at the head.
          if (prop === 'overall') continue;
          if (Array.isArray(val)) acc.push({ parent: o, prop, arr: val });
          else walk(val, depth + 1);
        }
      };
      walk(v, 0);
    }
    return acc;
  };
  const sectionRows = (topKey) => collectInto(topKey).reduce((s, x) => s + x.arr.length, 0);
  const trimmableKeys = Object.keys(finalOut).filter((k) => !NEVER_TRIM.has(k));
  const origLen = {};
  for (const k of trimmableKeys) { const n = sectionRows(k); if (n > KEEP_MIN) origLen[k] = n; }
  let json = JSON.stringify(finalOut, BIG, 1);
  // Proportional trim: every pass gives the trimmable arrays a share of the
  // budget proportional to their current size, so a slightly-over audit loses
  // only a few tail rows while a pathological one is cut hard. Gentle passes
  // keep KEEP_MIN rows per array; once gentle stalls the floor drops to 1.
  let floor = KEEP_MIN;
  for (let pass = 0; Buffer.byteLength(json) > BUDGET && pass < 16; pass++) {
    const slots = [];
    for (const k of trimmableKeys) for (const s of collectInto(k)) if (s.arr.length > floor) slots.push(s);
    if (!slots.length) { if (floor === 1) break; floor = 1; continue; }
    const total = sizeOf(finalOut);
    const arrayBytes = slots.reduce((s, x) => s + sizeOf(x.arr), 0);
    const ratio = Math.max(0, BUDGET - (total - arrayBytes)) / arrayBytes;
    let changed = false;
    for (const s of slots) {
      const keep = Math.max(floor, Math.floor(s.arr.length * ratio));
      if (keep < s.arr.length) { s.parent[s.prop] = s.arr.slice(0, keep); s.arr = s.parent[s.prop]; changed = true; }
    }
    if (changed) json = JSON.stringify(finalOut, BIG, 1);
    else if (floor === 1) break; else floor = 1;
  }
  const trimmed = {};
  for (const [k, n] of Object.entries(origLen)) {
    const now = sectionRows(k);
    if (now < n) trimmed[k] = { kept: now, dropped: n - now };
  }
  if (Object.keys(trimmed).length) { finalOut._trimmed = trimmed; json = JSON.stringify(finalOut, BIG, 1); }
  process.stderr.write(`audit_bytes=${Buffer.byteLength(json)} trimmed=${Object.keys(trimmed).join(',') || '-'}\n`);
  console.log(json);
  console.log(`__AUDIT_END__ bytes=${Buffer.byteLength(json)}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message?.slice(0, 300)); process.exit(1); });

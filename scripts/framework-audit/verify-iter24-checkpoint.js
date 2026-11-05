/**
 * verify-iter24-checkpoint.js — FO firing 35 proving probe (iter 24, commit 148eece8).
 *
 * Proves in ONE read-only pass:
 *  1. iter-24 is LIVE in the running container's dist: FUTURE_INTENT_RE carries
 *     `checkpoints?` (the deadline/ticks? precedent — noun only, "checkpointed"/
 *     "checked"/bare "check" still convict) and the strike path itself is intact
 *     ('future-clock strike' logger still present).
 *  2. ZERO checkpoint-class future-clock strikes on supervisor notes AFTER the
 *     148eece8 box flip (wave 36327487363, completed 2026-09-27T15:17:08Z), while
 *     any OTHER post-flip clock strikes still convict (the lane is alive, not muted).
 *  3. The firing-34 residual is real and sized: "supervisor turn facts timed out"
 *     rows since 14:00Z (firing 34 caught 2 on cf4fba36 at 14:32:16Z/14:39:14Z
 *     AFTER the iter-23 index flip proved fast at 14:29Z) — plus the root-cause
 *     evidence: decision_gate fan-out at the strike instants (±30s), the Prisma
 *     pool picture now, and a LIVE per-leg EXPLAIN ANALYZE of every
 *     computeSupervisorTurnNoopFacts leg for the noisiest chat (the Fleet
 *     Supervisor), including the lanesRunning count over the REAL scope IN-list.
 *
 * Read-only: SELECT / EXPLAIN ANALYZE over framework tables + grep of /app/dist.
 * EXPLAIN ANALYZE executes the SELECT it plans — no writes anywhere.
 */
const { execSync } = require('child_process');
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }

const FLIP = '2026-09-27T15:17:08Z'; // wave 36327487363 (148eece8) completed — boxes on the fix from here

(async () => {
  // ── 1. iter-24 live in dist ──────────────────────────────────────────────
  await sec('iter24_dist', () => {
    const dist = '/app/dist/modules/crossmodel/platform/action-verifier.js';
    const grep = (pat) => { try { return execSync(`grep -o -- ${JSON.stringify(pat)} ${dist} | wc -l`).toString().trim(); } catch { return 'ERR'; } };
    return {
      checkpoints_alt: grep('checkpoints?'),          // the iter-24 noun (expect >=1)
      deadline_alt: grep('deadline'),                  // sibling precedent (sanity)
      strike_logger: grep('future-clock strike'),      // conviction path intact (expect >=1)
      dist_mtime: execSync(`stat -c %y ${dist}`).toString().trim().slice(0, 19),
    };
  });

  // ── 2. checkpoint-class strikes: 24h by hour + every row since 12:00Z ────
  await sec('checkpoint_strikes_24h_hourly', () => q(
    `SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM loop_metrics
     WHERE kind='guard_strike' AND meta ? 'clockHits' AND (meta->'clockHits')::text ILIKE '%checkpoint%'
     AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1 DESC LIMIT 24`));
  await sec('checkpoint_strikes_since_12Z', () => q(
    `SELECT LEFT("sessionId"::text,8) AS sess, "createdAt", LEFT((meta->'clockHits')::text, 240) AS clockhits
     FROM loop_metrics WHERE kind='guard_strike' AND meta ? 'clockHits'
     AND (meta->'clockHits')::text ILIKE '%checkpoint%' AND "createdAt" > '2026-09-27T12:00:00Z'
     ORDER BY "createdAt" DESC LIMIT 10`));
  // The proving slice: ANY clock-hit strike after the flip — expect ZERO rows naming
  // checkpoint as the striking token; any other token listed here is the lane still convicting.
  await sec('post_flip_clock_strikes', () => q(
    `SELECT LEFT("sessionId"::text,8) AS sess, "createdAt", LEFT((meta->'clockHits')::text, 240) AS clockhits
     FROM loop_metrics WHERE kind='guard_strike' AND meta ? 'clockHits' AND "createdAt" > '${FLIP}'
     ORDER BY "createdAt" DESC LIMIT 12`));
  await sec('errlog_clock_strikes_hourly', () => q(
    `SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs
     WHERE message ILIKE '%future-clock strike%' AND "createdAt" > now() - interval '12 hours'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 12`));

  // ── 3. supervisor-turn-noop facts timeouts: the firing-34 residual ───────
  // FIXED firing 36: app_error_logs has NO sessionId column (this section 42703'd
  // live in firing 35 — schema.prisma model AppErrorLog = id/level/message/stack/
  // context/source/createdAt only). The chat id is IN the message text
  // ("supervisor-turn-noop: <8-hex> failed open (…)" — supervisor-turn-noop.ts:810);
  // substring it out. msg widened to 200 chars so the iter-25 ` [leg:ms …]` tail
  // (the stall diagnostic — the ABSENT leg names the stall) survives the cut.
  await sec('turn_noop_timeouts_since_14Z', () => q(
    `SELECT "id"::text,
            substring(message from 'supervisor-turn-noop: ([0-9a-f]{8})') AS chat,
            "createdAt", LEFT(message, 200) AS msg
     FROM app_error_logs WHERE message ILIKE '%supervisor turn facts timed out%'
     AND "createdAt" > '2026-09-27T14:00:00Z' ORDER BY "createdAt" DESC LIMIT 12`));
  await sec('turn_noop_timeouts_24h_hourly', () => q(
    `SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs
     WHERE message ILIKE '%supervisor turn facts timed out%' AND "createdAt" > now() - interval '24 hours'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 24`));
  // Fan-out at the two strike instants (±30s): decision-gate rows fired in the same
  // window — the pool-contention hypothesis says several purposes ran at once.
  for (const [label, t] of [['fanout_1432', '2026-09-27T14:32:16.387Z'], ['fanout_1439', '2026-09-27T14:39:14.906Z']]) {
    await sec(label, () => q(
      `SELECT LEFT("sessionId"::text,8) AS chat, "createdAt", meta->>'purpose' AS purpose
       FROM loop_metrics WHERE kind='decision_gate' AND "createdAt" BETWEEN ('${t}'::timestamptz - interval '30 seconds')
       AND ('${t}'::timestamptz + interval '30 seconds') ORDER BY "createdAt" LIMIT 20`));
  }
  await sec('decision_gate_4h_volume', () => q(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT "sessionId")::int AS chats FROM loop_metrics
     WHERE kind='decision_gate' AND "createdAt" > now() - interval '4 hours'`));

  // ── 4. pool picture now ──────────────────────────────────────────────────
  await sec('pg_pool_now', () => q(
    `SELECT state, LEFT(COALESCE(application_name,''),24) AS app, COUNT(*)::int AS n,
            MAX(EXTRACT(EPOCH FROM (now()-query_start)))::int AS oldest_s
     FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12`));
  await sec('pg_max_conn', () => q(`SELECT setting::int AS max_connections FROM pg_settings WHERE name='max_connections'`));

  // ── 5. LIVE per-leg timing of computeSupervisorTurnNoopFacts (noisiest chat) ──
  // Legs mirrored 1:1 from platform/supervisor-turn-noop.ts computeSupervisorTurnNoopFacts().
  await sec('leg_timings', async () => {
    const fleet = await q(`SELECT id::text AS id, "userId"::text AS uid FROM crossmodel_chats WHERE id::text LIKE 'c0e22e36%' LIMIT 1`);
    if (!fleet.length) return { ERR: 'fleet supervisor chat not found' };
    const id = fleet[0].id; const uid = fleet[0].uid;
    const ea = async (name, sql) => {
      const plan = (await q(`EXPLAIN (ANALYZE, FORMAT TEXT) ${sql}`)).map((r) => Object.values(r)[0]).join('\n');
      const m = plan.match(/Execution Time: ([\d.]+) ms/);
      const node = (plan.match(/^(?: -> )?(.*?)$/m) || [])[1] || plan.split('\n')[0];
      const firstNode = (plan.split('\n').find((l) => /Scan|Result/i.test(l)) || '').replace(/\s+/g, ' ').slice(0, 110);
      return { leg: name, ms: m ? Number(m[1]) : null, node: firstNode };
    };
    const legs = [];
    legs.push(await ea('L1_metrics_7d_400rows',
      `SELECT kind, "createdAt" FROM loop_metrics WHERE "sessionId"='${id}' AND kind IN ('supervisor_noop','supervisor_action','supervisor_note') AND "createdAt" >= now() - interval '7 days' ORDER BY "createdAt" DESC LIMIT 400`));
    legs.push(await ea('L2_notes_3',
      `SELECT content, "createdAt" FROM crossmodel_messages WHERE "chatId"='${id}' AND role='assistant' ORDER BY "createdAt" DESC LIMIT 3`));
    legs.push(await ea('L3_hooks',
      `SELECT id FROM event_hooks WHERE "targetChatId"='${id}' AND enabled=true`));
    legs.push(await ea('L4_owner_asks',
      `SELECT COUNT(*) FROM owner_questions WHERE "userId"='${uid}' AND status='open'`));
    legs.push(await ea('L5_pending_user_rows',
      `SELECT COUNT(*) FROM pending_chat_messages WHERE "chatId"='${id}' AND source='user'`));
    const scope = await q(`SELECT id::text AS id FROM crossmodel_chats WHERE id <> '${id}' AND "archivedAt" IS NULL AND "userId"='${uid}' LIMIT 2000`);
    legs.push({ leg: 'L6_scope_size', ms: null, node: `scope chats = ${scope.length}` });
    legs.push(await ea('L7_directives',
      `SELECT state FROM supervisor_states WHERE "chatId"='${id}'`));
    legs.push(await ea('L8_pending_hook_events',
      `SELECT COUNT(*) FROM hook_events WHERE "hookId" IN (SELECT id FROM event_hooks WHERE "targetChatId"='${id}' AND enabled=true) AND status='pending'`));
    const inList = scope.map((r) => `'${r.id}'`).join(',');
    legs.push(await ea('L9_lanes_running_count',
      `SELECT COUNT(*) FROM agent_runs WHERE "sessionId" IN (${inList}) AND status='running'`));
    legs.push({ leg: 'L9_in_list_size', ms: null, node: `IN list = ${scope.length} ids` });
    return legs;
  });

  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message?.slice(0, 300)); process.exit(1); });

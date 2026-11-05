// Ticket 4565991a E2E probe (2026-09-27, post-deploy d770bf18) — READ-ONLY.
// (1) Live-code check: does the DEPLOYED backend dist carry the new stamps?
//     (run from /app inside the container — reads its own dist files)
// (2) Near-term owner-subscribed firings: enabled schedules with
//     ownerSubscribed/promptSetBy-user, their chat's coding-ness, next fire.
const fs = require('fs');
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }

(async () => {
  // (1) live-code check — the executor + controller + schedule service dists
  await sec('live_code_stamps', () => {
    const targets = [
      '/app/dist/modules/crossmodel/coding/run-executor.js',
      '/app/dist/modules/crossmodel/coding/coding-stream.controller.js',
      '/app/dist/modules/crossmodel/coding/schedule.service.js',
      '/app/dist/modules/crossmodel/coding/run-state.js',
    ];
    const found = [];
    for (const f of targets) {
      try {
        const src = fs.readFileSync(f, 'utf8');
        found.push({
          file: f.split('/').pop(),
          scheduleOwnerArmed: (src.match(/scheduleOwnerArmed/g) || []).length,
          owner_digest_kind: src.includes("'owner_digest'") || src.includes('"owner_digest"'),
        });
      } catch (e) { found.push({ file: f.split('/').pop(), ERR: String(e.message).slice(0, 80) }); }
    }
    return found;
  });

  // (2) near-term owner-subscribed firings (next 6h), coding vs plain
  await sec('owner_subscribed_firings_6h', () => q(
    `SELECT LEFT(s.id::text,8) AS sched, LEFT(s."sessionId"::text,8) AS chat,
            (c.coding_state_id IS NOT NULL) AS is_coding,
            s.kind, s."promptSetBy", s."ownerSubscribed", s."nextRunAt",
            ROUND(EXTRACT(EPOCH FROM (s."nextRunAt" - now()))/60)::int AS in_min
     FROM coding_schedules s
     LEFT JOIN crossmodel_chats c ON c.id = s."sessionId"
     WHERE s.enabled
       AND (s."ownerSubscribed" = true OR s."promptSetBy" = 'user')
       AND s."nextRunAt" < now() + interval '6 hours'
     ORDER BY s."nextRunAt" ASC LIMIT 15`));

  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('PROBE FAIL', e); process.exit(1); });

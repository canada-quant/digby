/**
 * verify-iter38-absorbed-billing.js — FO firing 38 proving probe.
 *
 * Proves in ONE read-only pass (post-wave):
 *  1. The ABSORBED-billing owner ticket is live in the running container's
 *     dist: the sticky lead-failover path (agent.ts, FO firing 38, 2026-09-28)
 *     files the deduped owner-action ticket when a healthy fallback absorbs a
 *     billing suspension — the 2026-08-25 run-death ticket never fired on that
 *     path, so the Moonshot kimi-k3 suspension streamed 17 warns + seat_fallback
 *     rows over 4 h with ZERO owner notification.
 *  2. Live since the flip: seat_fallback rows reason=billing (the ongoing
 *     toll) + any feedback ticket rows carrying the outage title (title dedup
 *     collapses repeats; occurrences = ongoing).
 *  3. The Moonshot suspension warn rate (watch until the owner recharges).
 *  4. iter-37 carried forward: the newest turn-noop strike still carries its
 *     leg tail, and the sync-db-secret script greps now resolve in-container
 *     (/repo mount) — the firing-37 probe's section-2 ERR was a probe artifact.
 *
 * Read-only: SELECTs + greps. No writes anywhere.
 */
const { execSync } = require('child_process');
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }

const FLIP = process.env.ITER38_FLIP || '2026-09-28T04:00:00Z'; // set to the wave-complete time on the opening check

(async () => {
  // ── 1. absorbed-billing ticket live in dist ──────────────────────────────
  await sec('iter38_dist', () => {
    const dist = '/app/dist/modules/crossmodel/coding/agent.js';
    const grep = (pat) => { try { return execSync(`grep -o -- ${JSON.stringify(pat)} ${dist} | wc -l`).toString().trim(); } catch { return 'ERR'; } };
    return {
      absorbed_ticket: grep('provider_billing_absorbed'),   // the filing context class (expect >=1)
      kill_switch: grep('LEAD_BILLING_TICKET_DISABLED'),    // the switch (expect >=1)
      dist_mtime: execSync(`stat -c %y ${dist}`).toString().trim().slice(0, 19),
    };
  });

  // ── 2. live since the flip: toll + tickets ───────────────────────────────
  await sec('seat_fallback_billing_since_flip', () => q(
    `SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM loop_metrics
     WHERE kind = 'seat_fallback' AND meta->>'reason' = 'billing' AND "createdAt" > '${FLIP}'`));
  // Firing 39 fix: the ticket table is user_feature_requests (Prisma model
  // UserFeatureRequest @@map) — firing 38 shipped "feedback_tickets", which
  // ERRed (relation does not exist) instead of proving on the opening check.
  await sec('billing_outage_tickets', () => q(
    `SELECT LEFT(title, 90) AS title, status, priority, source,
            context->>'class' AS ctx_class, context->>'occurrences' AS occurrences,
            "createdAt", "updatedAt"
     FROM user_feature_requests
     WHERE title LIKE 'PROVIDER BILLING OUTAGE%' ORDER BY "createdAt" DESC LIMIT 5`));

  // ── 3. Moonshot suspension warn rate (watch until the owner recharges) ───
  await sec('moonshot_billing_by_hour_12h', () => q(
    `SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs
     WHERE message LIKE '%lead seat Moonshot direct (kimi-k3) rejected the turn%'
       AND "createdAt" > now() - interval '12 hours'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 12`));

  // ── 4. iter-37 carried forward ───────────────────────────────────────────
  await sec('newest_noop_strike', () => q(
    `SELECT LEFT(message, 320) AS msg, "createdAt" FROM app_error_logs
     WHERE message LIKE 'supervisor-turn-noop%'
     ORDER BY "createdAt" DESC LIMIT 1`));
  await sec('syncdb_script_greps', () => {
    const candidates = ['/opt/crossmodel/scripts/deploy/sync-db-secret.sh', '/repo/scripts/deploy/sync-db-secret.sh'];
    const sh = candidates.find((p) => { try { require('fs').accessSync(p); return true; } catch { return false; } });
    if (!sh) return { missing: true };
    const grep = (pat) => { try { return execSync(`grep -c -- ${JSON.stringify(pat)} ${sh}`).toString().trim(); } catch { return 'ERR'; } };
    return { script_path: sh, in_sync_probe: grep('IN_SYNC=1'), rejected_split: grep('REJECTED:'), unavailable_split: grep('UNAVAILABLE') };
  });

  console.log(JSON.stringify(out, BIG, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('PROBE_FAIL', e.message); await prisma.$disconnect(); process.exit(1); });

/**
 * verify-iter37-legstall-syncdb.js — FO firing 37 proving probe.
 *
 * Proves in ONE read-only pass (post-wave):
 *  1. The leg-stall NAMING fix is live in the running container's dist: the
 *     in-flight sentinel renders a `stalled:` clause in the fail-open warn
 *     (computeSupervisorTurnNoopFacts banks -1 at leg START; legTimingNote
 *     names never-settled legs — firing 35's tail could not distinguish
 *     "stalled" from "banked fast and sliced out by the 6-leg cap").
 *  2. The sync-db-secret deploy guard reorder is live ON THE BOX: the
 *     rsynced script carries IN_SYNC= (idempotence probe BEFORE the
 *     live-auth guard) and the REJECTED/UNAVAILABLE split — the chronic
 *     "refusing to stage" warning (3x per wave on every wave, firing 37
 *     root-caused: psql container gets Connection refused to RDS = check
 *     UNAVAILABLE, while MODE=verify parity PASSES and the app serves fine)
 *     becomes a quiet no-op on already-synced boxes. The deploy-time stdout
 *     itself is visible only in the wave's Actions log — read it there on the
 *     next firing's opening check.
 *  3. Supervisor-turn-noop strikes since the flip carry the leg evidence
 *     (stalled: clause or banked tail) — and their hourly rate.
 *  4. iter-25 stays green: zero litellm BadRequestError rows since the
 *     b085607ea flip (carried forward from verify-iter25).
 *
 * Read-only: SELECTs over framework tables + grep of /app/dist and the
 * rsynced scripts tree. No writes anywhere.
 */
const { execSync } = require('child_process');
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }

const FLIP = process.env.ITER37_FLIP || '2026-09-28T00:00:00Z'; // set to the wave-complete time on the opening check

(async () => {
  // ── 1. leg-stall naming live in dist ─────────────────────────────────────
  await sec('iter37_dist', () => {
    const dist = '/app/dist/modules/crossmodel/platform/supervisor-turn-noop.js';
    const grep = (pat) => { try { return execSync(`grep -o -- ${JSON.stringify(pat)} ${dist} | wc -l`).toString().trim(); } catch { return 'ERR'; } };
    return {
      stalled_clause: grep('stalled:'),        // the firing-37 clause (expect >=1)
      timeout_prefix: grep('supervisor turn facts timed out'), // greppable class unchanged
      dist_mtime: execSync(`stat -c %y ${dist}`).toString().trim().slice(0, 19),
    };
  });

  // ── 2. sync-db-secret reorder live on the box (rsynced scripts tree) ────
  await sec('syncdb_script_on_box', () => {
    // FO firing 38: prodq.sh runs INSIDE the backend container, where the
    // rsynced host tree /opt/crossmodel is mounted read-only at /repo
    // (docker-compose.prod.yml). Both paths are tried so the section works
    // from either side; 'missing' means neither resolved.
    const candidates = ['/opt/crossmodel/scripts/deploy/sync-db-secret.sh', '/repo/scripts/deploy/sync-db-secret.sh'];
    const sh = candidates.find((p) => { try { require('fs').accessSync(p); return true; } catch { return false; } });
    if (!sh) return { missing: 'sync-db-secret.sh not found at /opt/crossmodel or /repo', in_sync_probe: 'ERR', rejected_split: 'ERR', unavailable_split: 'ERR' };
    const grep = (pat) => { try { return execSync(`grep -c -- ${JSON.stringify(pat)} ${sh}`).toString().trim(); } catch { return 'ERR'; } };
    return {
      script_path: sh,
      in_sync_probe: grep('IN_SYNC=1'),        // idempotence probe hoisted (expect >=1)
      rejected_split: grep('REJECTED:'),       // auth-failure class named (expect >=1)
      unavailable_split: grep('UNAVAILABLE'),  // unavailability class named (expect >=1)
    };
  });

  // ── 3. turn-noop strikes since the flip carry leg evidence ───────────────
  await sec('noop_strikes_since_flip', () => q(
    `SELECT LEFT(message, 320) AS msg FROM app_error_logs
     WHERE message LIKE 'supervisor-turn-noop%' AND "createdAt" > '${FLIP}'
     ORDER BY "createdAt" DESC LIMIT 6`));
  await sec('noop_hourly_24h', () => q(
    `SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n FROM app_error_logs
     WHERE message LIKE 'supervisor-turn-noop%' AND "createdAt" > now() - interval '24 hours'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 24`));

  // ── 4. iter-25 carried forward: zero 400-class rows since its flip ──────
  await sec('badrequest_since_iter25_flip', () => q(
    `SELECT COUNT(*)::int AS n FROM app_error_logs
     WHERE message LIKE '%BadRequestError%' AND "createdAt" > '2026-09-27T19:46:04Z'`));

  console.log(JSON.stringify(out, BIG, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('PROBE_FAIL', e.message); await prisma.$disconnect(); process.exit(1); });

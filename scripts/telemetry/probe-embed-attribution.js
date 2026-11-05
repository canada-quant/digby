/**
 * probe-embed-attribution.js — goal 4e432dff, KPI probe. READ-ONLY.
 *
 * The KPI: kpi:embed_unattributed_failures_24h, bar 0, at_most (barDirection
 * 'at_most'), unit rows. Value = failure rows on the embed surfaces, over the
 * trailing 24 h, that cannot name BOTH the flow that attempted the call
 * (meta.bucket) and the side/leg it ended on.
 *
 * THE RULE IS THE EMITTERS' OWN. It is not re-derived here: the same predicate
 * (`embedAttributionComplete`) is used in backend/src/modules/crossmodel/
 * memory/embed-failure.ts, and the population rules mirror
 * `queryEmbedAttribution` in platform/loop-metrics.service.ts exactly. This
 * script exists as a separate read because the KPI value must be receipted
 * from a run_command, and because Prisma's tagged template cannot express the
 * JSON predicates as cheaply as raw SQL.
 *
 * WHY THE BUILD SPLIT IS THE POINT (supervisor steer 2026-11-02 19:33Z):
 * a zero on a build that cannot yet emit the dimension is NOT zero failures.
 * Rows written before the fix are unattributable at read time — 86 of the 88
 * in the 2026-11-02 window are UNRECOVERABLE on box-c@5d6c8954. So this
 * reports the number TWICE:
 *   - `unattributed24h`      : the whole window (the honest KPI value — it
 *                              cannot be zero until the window rolls past the
 *                              pre-attribution build);
 *   - `unattributedPostFix`  : only rows the FORWARD build wrote (meta.proc's
 *                              @sha is on or after the fix sha). THIS is the
 *                              adoption number, and it is what must be 0.
 * `byProc` names each emitting box sha, so the premise note can name the build
 * that produced the reading.
 *
 * Run:  scripts/telemetry/probe.sh -s <this file>
 */
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ssl: /sslmode=disable/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false },
});
const p = new PrismaClient({ adapter });

/** Mirrors EMBED_BUCKETS minus the `unknown` sentinel (which is NOT attribution). */
const KNOWN_BUCKETS = new Set(['store', 'query', 'backfill', 'ingest', 'user_facts']);

/** The gatewayless assertion a transport writes when it owns a hard-coded URL
 *  (see EMBED_GATEWAYLESS_LANES in memory/embed-failure.ts). */
const GWLESS_DIRECT = 'direct';
const TYPED_ABORTS = new Set(['caller_timeout', 'provider_error', 'parse_failure', 'network']);

/**
 * THE RULE — identical to embedAttributionComplete():
 * a known bucket AND (a leg OR a typed caller-side/network abort OR a
 * PROVEN-gatewayless lane with a typed abort).
 *
 * A caller-side abort has no response, so no leg can exist at any layer;
 * requiring one there would make the bar unreachable by construction. The same
 * structural argument extends to a `provider_error` on a lane with no LiteLLM
 * hop in front (supervisor ruling 2026-11-04) — no `x-litellm-*` header can
 * exist there either.
 *
 * WHAT KEEPS THAT HONEST: the exemption requires `gwless:'direct'`, a POSITIVE
 * fact written by the transport that owns the URL — never the mere ABSENCE of a
 * leg, which would equally describe a GATEWAYED lane whose gateway failed to
 * emit headers. That second shape is precisely the defect this KPI exists to
 * catch, so it must keep counting as unattributed.
 */
function attributed(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (!KNOWN_BUCKETS.has(meta.bucket)) return false;
  if (typeof meta.leg === 'string' && meta.leg.trim()) return true;
  const abort = typeof meta.abort === 'string' ? meta.abort : null;
  if (abort === 'caller_timeout' || abort === 'network') return true;
  return meta.gwless === GWLESS_DIRECT && TYPED_ABORTS.has(abort);
}

/**
 * IS THIS ROW FROM THE ATTRIBUTING BUILD? — answered by the ROW ITSELF.
 *
 * A sha comparison cannot answer this: process tags are per-box and the shas
 * are not ordered strings, so `sha >= FIX_SHA` is meaningless. The reliable
 * discriminator is `bucket`, the NEW dimension this change introduced.
 *
 * NOT `abort`: commit 9b7452db11 (ticket b5f4d5e2) shipped per-attempt
 * `abort`/`leg` on rag_embed_call rows BEFORE this fix, so a row carrying
 * `abort` alone is still a PRE-attribution row — it names the side but not the
 * flow, which is exactly the gap this goal closes. Measured 2026-11-02: 83
 * rows in the 24 h window carried `abort` and zero carried `bucket`.
 *
 * This is self-verifying in the direction that matters: with the fix merged but
 * not yet deployed, postFixFailures is 0 and fixDeployedEvidence is FALSE, which
 * reads honestly as "no evidence yet" rather than as a pass. The KPI value
 * (unattributed24h, whole window) never depends on this split.
 */
function hasDimension(meta) {
  return !!(meta && typeof meta === 'object' && typeof meta.bucket === 'string' && meta.bucket !== '');
}

(async () => {
  const since = new Date(Date.now() - 24 * 3600e3);
  const rows = await p.$queryRawUnsafe(
    `SELECT "kind", "meta", "createdAt"
       FROM "loop_metrics"
      WHERE "createdAt" >= $1
        AND "kind" IN ('rag_embed_call','unified_memory_embed_failed','memory_embed_backfill')`,
    since,
  );

  let unattributed24h = 0;
  let unattributedPostFix = 0;
  let totalFailures = 0;
  let postFixFailures = 0;
  let rollups = 0;
  let successes = 0;
  // --- CARVE-OUT OBSERVABILITY (weekly guard, supervisor order 2026-11-04) ---
  // The gwless carve-out can only fire on a `provider_error` that arrived on a
  // PROVEN-gatewayless lane. Counting carriers over the whole scan answers
  // "is the transport writing the dimension at all?"; the provider_error split
  // answers "has the carve-out ever had the opportunity to fire?". Without
  // these two numbers a 0 is indistinguishable from an age-out coincidence.
  let gwlessCarriers = 0;
  let providerErrorFailures = 0;
  let providerErrorWithGwless = 0;
  const providerErrorShapes = [];
  const byProc = {};
  const byBucket = {};
  const bySurface = {};
  const byAbort = {};
  const unattributedSurfaces = {};
  const postFixProcs = new Set();

  for (const row of rows) {
    let meta = row.meta;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    meta = meta || {};

    // Counted over EVERY scanned row — rollups and successes included. The
    // question is whether the transport WRITES the dimension, which does not
    // depend on whether a given call failed. (Kept at this position so the
    // number stays comparable to the 8,216 measured 2026-11-04T17:20Z.)
    if (meta.gwless === GWLESS_DIRECT) gwlessCarriers++;

    // Population rules (same as queryEmbedAttribution):
    //  - an embed CALL roll-up is not a failure of its own → excluded;
    //  - a success is not a failure → excluded;
    //  - the repair tick is an ATTEMPT attribution → per-surface only, never
    //    in the numerator (a healthy cron must not hold the bar red).
    if (row.kind === 'rag_embed_call') {
      if (meta.batchCount !== undefined && meta.batchCount !== null) { rollups++; continue; }
      const ok = String(meta.ok ?? meta.success ?? '').toLowerCase();
      if (ok === 'true' || ok === '1') { successes++; continue; }
      if (!(ok === 'false' || ok === '0')) { /* unlabeled attempt: count as a failure row */ }
    }

    const surface = row.kind;
    bySurface[surface] = (bySurface[surface] || 0) + 1;
    const proc = typeof meta.proc === 'string' ? meta.proc : '(none)';
    byProc[proc] = (byProc[proc] || 0) + 1;
    const b = typeof meta.bucket === 'string' && meta.bucket ? meta.bucket : '(absent)';
    byBucket[b] = (byBucket[b] || 0) + 1;
    const a = typeof meta.abort === 'string' && meta.abort ? meta.abort : '(absent)';
    byAbort[a] = (byAbort[a] || 0) + 1;

    if (surface === 'memory_embed_backfill') continue; // attribution, not a failure

    totalFailures++;
    // --- CARVE-OUT OPPORTUNITY ---
    // A provider_error is the ONLY abort the gwless carve-out can exempt. If
    // this stays 0 the carve-out has never had an opportunity to fire, and a
    // KPI of 0 is an age-out coincidence rather than evidence the rule works.
    const ab = typeof meta.abort === 'string' ? meta.abort : null;
    if (ab === 'provider_error') {
      providerErrorFailures++;
      if (meta.gwless === GWLESS_DIRECT) providerErrorWithGwless++;
      if (providerErrorShapes.length < 10) {
        providerErrorShapes.push({
          at: new Date(row.createdAt).toISOString(),
          surface,
          bucket: meta.bucket ?? null,
          leg: meta.leg ?? null,
          gwless: meta.gwless ?? null,
          proc,
          attributed: attributed(meta),
        });
      }
    }

    // "Post-fix" is answered by the ROW, not by a sha: a row written by the
    // attributing build carries the dimension; a pre-attribution row cannot.
    // (A sha string comparison would be meaningless — these are per-box short
    // shas, not an ordered timeline.)
    const isPostFix = hasDimension(meta);
    if (isPostFix) { postFixFailures++; postFixProcs.add(proc); }

    if (!attributed(meta)) {
      unattributed24h++;
      unattributedSurfaces[surface] = (unattributedSurfaces[surface] || 0) + 1;
      if (isPostFix) unattributedPostFix++;
    }
  }

  console.log('RESULT:' + JSON.stringify({
    probe: 'kpi:embed_unattributed_failures_24h',
    windowHours: 24,
    // THE KPI VALUE — the whole trailing window.
    unattributed24h,
    totalFailures,
    // ADOPTION — rows that already carry the dimension. This is the number that
    // must be 0, and it is only meaningful together with postFixFailures: a
    // postFix population of 0 means "the fix is not deployed yet / no evidence",
    // NOT "zero unattributed".
    unattributedPostFix,
    postFixFailures,
    // Was the attributing build emitting at all during this window?
    fixDeployedEvidence: postFixFailures > 0,
    postFixProcs: [...postFixProcs],
    // --- CARVE-OUT OBSERVABILITY (the weekly guard's two questions) ---
    // 1. Is the transport writing the dimension at all? (positive fact)
    gwlessCarriers,
    // 2. Has the carve-out ever had an opportunity to fire? A provider_error on
    //    a proven-gatewayless lane is the ONLY row the carve-out can exempt.
    //    `providerErrorWithGwless > 0` with that row still attributed === the
    //    positive proof that the rule works, which a bare 0 can never give.
    providerErrorFailures,
    providerErrorWithGwless,
    carveOutOpportunity: providerErrorWithGwless > 0,
    providerErrorShapes,
    // Diagnostics (never the KPI value).
    excludedRollups: rollups,
    excludedSuccesses: successes,
    rowsExamined: rows.length,
    bySurface,
    unattributedSurfaces,
    byBucket,
    byAbort,
    byProc,
    generatedAt: new Date().toISOString(),
  }));
  await p.$disconnect();
})().catch((e) => { console.log('ERR', String(e.message).split('\n').pop()); process.exit(1); });
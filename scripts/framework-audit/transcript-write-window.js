#!/usr/bin/env node
// ⚠ RETIRED 2026-11-04 (MERGE-1 step 10): `coding_messages` WAS DROPPED.
// Migration 20261104150000_drop_coding_messages finished 2026-11-04T15:58:58.936Z and
// the deployed build 99114c0c has no such relation (to_regclass -> null). Every SQL
// statement below names that table, so running this now can only fail with
// `42P01 relation "coding_messages" does not exist`. That failure is EXPECTED, not a
// fault. This file is kept ONLY as the historical record of the pre-drop proof; it is
// not runnable and must not be repaired to point elsewhere. For the post-drop end state
// see docs/MERGE1_MIGRATION_PLAN.md -> "POST-DROP CONFIRMATION".
/**
 * transcript-write-window.js — READ-ONLY proof that the merged-only default is live.
 *
 * MERGE-1 (todo 2fd4416a). After `transcriptWritePlan()` was flipped to
 * `{primary:'merged', mirror:null}` (commit 6bff8539, deployed 2026-11-04), the legacy
 * `coding_messages` table should stop receiving rows entirely under the default
 * configuration, while `crossmodel_messages` keeps growing with real traffic.
 *
 * WHY COUNT ALONE IS NOT A PROOF. "legacy count unchanged" is equally consistent with
 * (a) the flip working and (b) no transcript write having happened at all — a quiet
 * window looks identical to a fixed writer. So this probe reports BOTH sides plus the
 * newest timestamp and per-minute recency on each:
 *
 *   VERDICT 'merged-only-window'  merged advanced AND legacy did not.
 *   VERDICT 'legacy-still-writing' legacy advanced — the flip did NOT reach this process
 *                                 (wrong build, or a box still on the old colour without
 *                                 the new default). This is the failure this probe exists
 *                                 to catch, and it must never read as a pass.
 *   VERDICT 'no-traffic'          neither advanced — INCONCLUSIVE, not a pass. Re-run
 *                                 across a busier interval.
 *
 * Run it twice and diff: pass `--since-legacy N --since-merged M` with the counts from
 * the first run to have it compare and emit the verdict itself.
 *
 * Usage (keyless, via SSM — see prodq.sh):
 *   scripts/framework-audit/run-on-box.sh C \
 *     'bash /opt/crossmodel/scripts/framework-audit/prodq.sh transcript-write-window.js'
 *   ... --since-legacy 43897 --since-merged 111563   (t1; prints the verdict)
 *
 * Writes nothing. Credentials are the container's own DATABASE_URL.
 */
const prisma = require('/app/dist/config/database').default;

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : null;
}

async function side(table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n,
            MAX("createdAt") AS newest,
            COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '15 minutes')::int AS last15m,
            COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '2 hours')::int AS last2h
       FROM "${table}"`
  );
  const r = rows[0] || {};
  return {
    rows: Number(r.n || 0),
    newest: r.newest ? new Date(r.newest).toISOString() : null,
    last15m: Number(r.last15m || 0),
    last2h: Number(r.last2h || 0),
  };
}

(async () => {
  const out = {
    probe: 'transcript-write-window',
    at: new Date().toISOString(),
    // The writer's own view: what the DEPLOYED build resolves for this process.
    writerMode: {
      TRANSCRIPT_WRITE: process.env.TRANSCRIPT_WRITE ?? '<unset>',
      TRANSCRIPT_DUAL_WRITE: process.env.TRANSCRIPT_DUAL_WRITE ?? '<unset>',
      TRANSCRIPT_READ: process.env.TRANSCRIPT_READ ?? '<unset>',
    },
    legacy: await side('coding_messages'),
    merged: await side('crossmodel_messages'),
  };

  // Resolve the plan the deployed code would actually take, so the receipt carries the
  // code's decision and not just an env echo.
  //
  // MERGE-1 step 9 (2026-11-04) DELETED `transcript-source.ts` along with the whole
  // write/read seam, so on a post-step-9 build this require is expected to fail with
  // MODULE_NOT_FOUND. That is not an error condition for this probe — it is the
  // strongest possible statement of the same fact: there is no longer any switch that
  // could route a write to the legacy table. Report it as such instead of as a failure,
  // so a future reader does not mistake a healthy post-DROP box for a broken probe.
  try {
    const { transcriptWritePlan } = require('/app/dist/modules/crossmodel/coding/transcript-source');
    out.writerPlan = transcriptWritePlan();
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    out.writerPlan = /MODULE_NOT_FOUND|Cannot find module/.test(msg)
      ? { seam: 'removed', note: 'transcript-source.js is absent from this build — the write seam was deleted, so no switch can route a write to the legacy table' }
      : { error: msg };
  }

  const sinceLegacy = argOf('--since-legacy');
  const sinceMerged = argOf('--since-merged');
  if (sinceLegacy !== null && sinceMerged !== null) {
    const dLegacy = out.legacy.rows - sinceLegacy;
    const dMerged = out.merged.rows - sinceMerged;
    out.delta = { legacy: dLegacy, merged: dMerged };
    if (dMerged > 0 && dLegacy === 0) out.VERDICT = 'merged-only-window';
    else if (dLegacy > 0) out.VERDICT = 'legacy-still-writing';
    else out.VERDICT = 'no-traffic';
    out.VERDICT_NOTE =
      out.VERDICT === 'merged-only-window'
        ? 'merged advanced while legacy stayed flat — the merged-only default is live on this build'
        : out.VERDICT === 'legacy-still-writing'
          ? `legacy advanced by ${dLegacy} rows — the deployed build still wrote coding_messages; do NOT treat the window as proven`
          : 'neither table advanced — INCONCLUSIVE (no transcript writes in the interval), not a pass';
  } else {
    out.NOTE = 'baseline read — re-run with --since-legacy and --since-merged to get a verdict';
  }

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(JSON.stringify({ probe: 'transcript-write-window', error: String(e && e.message ? e.message : e) }));
  process.exit(1);
});
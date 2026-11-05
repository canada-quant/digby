#!/usr/bin/env node
/**
 * lane-retire-preview.js — READ-ONLY (lane lifecycle C1, 2026-10-21).
 *
 * The pre-deploy check for the R6-acts change: runs the SAME discovery, lane
 * walk and retire verdicts the worker's session-topology-outcomes cron now acts
 * on (`/app/dist/.../platform/lane-retire` collectRetireCandidates — the
 * coding-lanes-only walk by id, cursor untouched — + previewLaneRetire; on a
 * dist without collectRetireCandidates, session-topology buildLaneIndex +
 * retireCandidates as before) and
 * PRINTS, per project, every R6 candidate with its verdict (eligible, or the
 * first skip reason), its machine-spawn proof (p1 delegation ledger / p2 ticket
 * link / p3 supervisor parent / p4 first-message origin) and its idle days —
 * plus totals by reason and by proof. It NEVER writes: no archive, no metric
 * row, no store row (previewLaneRetire is the pass's own read half). A partial
 * lane page is reported (`partialPages`) and its lanes skipped, exactly as the
 * cron does.
 *
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh lane-retire-preview.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh lane-retire-preview.js --project <id-prefix>
 *
 * Run it on the box whose container carries the NEW dist (the deploy wave's
 * first box, before the cron's first acting pass) — on an old dist the
 * lane-retire module is absent and the script says so.
 *
 * Titles are clipped to 60 chars with long token-like runs masked; no message
 * text is read. Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 * Testable offline: `module.exports.run({ prisma, topology, laneRetire, argv, now })`
 * (backend/src/scripts/lane-retire-preview.test.ts).
 */
'use strict';

function parseArgs(argv) {
  const out = { project: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--project') out.project = String(argv[++i] || '');
    else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const clipTitle = (t) => String(t || '').replace(/[A-Za-z0-9_\-]{24,}/g, '<tok>').slice(0, 60);

function countBy(rows, keyOf) {
  const counts = {};
  for (const r of rows) {
    const k = keyOf(r);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

async function run({ prisma, topology, laneRetire, argv, print, now } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    if (print) console.log('usage: lane-retire-preview.js [--project <id-prefix>]');
    return { help: true };
  }
  const at = now || new Date();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const client = prisma || require('/app/dist/config/database').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const topo = topology || require('/app/dist/modules/crossmodel/platform/session-topology');
  let lr = laneRetire;
  if (!lr) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      lr = require('/app/dist/modules/crossmodel/platform/lane-retire');
    } catch (err) {
      const report = { script: 'lane-retire-preview', at: at.toISOString(), error: `lane-retire module not in this dist (${err && err.message ? err.message : err}) — run on a box with the new build` };
      if (print) console.log(JSON.stringify(report, null, 2));
      return report;
    }
  }
  const recent = await client.crossModelChat.findMany({
    where: { archivedAt: null, projectId: { not: null }, codingState: { isNot: null }, updatedAt: { gte: new Date(at.getTime() - lr.LANE_RETIRE_PROJECT_LOOKBACK_MS) } },
    select: { projectId: true, userId: true }, distinct: ['projectId'], orderBy: { updatedAt: 'desc' }, take: lr.LANE_RETIRE_MAX_PROJECTS,
  });
  const projects = [];
  const all = [];
  for (const p of recent) {
    if (!p.projectId || (opts.project && !String(p.projectId).startsWith(opts.project))) continue;
    let cands;
    let walk = null;
    if (typeof lr.collectRetireCandidates === 'function') {
      // The cron's own walk; persistCursor:false leaves the worker's resume point alone.
      walk = await lr.collectRetireCandidates(p.projectId, p.userId, at, { persistCursor: false });
      cands = walk.candidates.map((c) => c.lane);
      if (!cands.length && !walk.partialPages) continue;
      if (!cands.length) { projects.push({ projectId: p.projectId, candidates: 0, partial: true, partialPages: walk.partialPages, pages: walk.pages, truncated: walk.truncated, verdicts: [] }); continue; }
    } else {
      const index = await topo.buildLaneIndex(p.projectId, p.userId, { now: at });
      const laneById = new Map(index.lanes.map((l) => [l.laneId, l]));
      cands = topo.retireCandidates(index.lanes, { now: at }).map((c) => laneById.get(c.laneId)).filter(Boolean);
      if (!cands.length) continue;
      if (index.partial) { projects.push({ projectId: p.projectId, candidates: cands.length, partial: true, verdicts: [] }); continue; }
    }
    const verdicts = await lr.previewLaneRetire(cands.map((lane) => ({ lane, projectId: p.projectId, userId: p.userId })), at);
    all.push(...verdicts);
    projects.push({
      projectId: p.projectId, candidates: cands.length, partial: walk ? walk.partialPages > 0 : false,
      ...(walk ? { partialPages: walk.partialPages, pages: walk.pages, truncated: walk.truncated } : {}),
      verdicts: verdicts.map((v) => ({ laneId: v.laneId.slice(0, 8), title: clipTitle(v.title), eligible: v.eligible, reason: v.reason, proof: v.proof, idleDays: v.idleDays, parent: v.parentChatId ? v.parentChatId.slice(0, 8) : null })),
    });
  }
  const eligible = all.filter((v) => v.eligible).length;
  const report = {
    script: 'lane-retire-preview', at: at.toISOString(), readOnly: true,
    projectsScanned: recent.length, projectsWithCandidates: projects.length, candidates: all.length,
    eligible, wouldArchiveFirstPass: Math.min(eligible, lr.LANE_RETIRE_MAX_PER_PASS),
    byReason: countBy(all, (v) => v.reason),
    byProof: countBy(all.filter((v) => v.proof), (v) => v.proof),
    projects,
  };
  if (print) console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  return report;
}

module.exports = { run, parseArgs, clipTitle };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument/.test(String(err && err.message));
      console.error(`lane-retire-preview: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}

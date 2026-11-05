#!/usr/bin/env node
/**
 * reenable-paused-spawn-hooks.js — ONE-SHOT WRITE (audit 2026-10-08 W1-1).
 *
 * The 15-min supervisor heal re-ran pauseProjectSupervisor on every paused
 * project supervisor and disabled the hooks a SPAWN had wired on it — the
 * `system:child-result-hook` per child (the 10-06 T5-1 paused-supervisor
 * result hook) and the chat's own `system:direct-wake` self-hook — 3–14 min
 * after creation, so lane completions woke nobody (One Piece: hooks 7ad7880d,
 * 688c661a, 0a26067d, 0d49b520; AGX / LiteLLM children on 10-06). The runtime
 * fix stops the pause touching them; this script re-enables the ones a
 * `project_supervisor.pause` audit row disabled since --since (default
 * 2026-10-06T00:00:00Z).
 *
 * A hook is re-enabled only when ALL hold:
 *   - it is listed in a pause row's metadata.hookIds since --since, is still
 *     disabled, and its createdVia is system:child-result-hook | system:direct-wake;
 *   - its target chat still exists, is not archived and is still a supervisor
 *     chat (isProjectSupervisor);
 *   - child-result hooks: the source (child) chat exists and is not archived,
 *     and the target's project-scope hook is NOT enabled (supervision still
 *     paused) — or the child lives outside the supervisor's project (the
 *     project hook never covers it). With supervision live the project hook
 *     delivers the child's events, and a re-enabled direct hook would deliver
 *     every completion TWICE (resumeWhatPauseDisabled disables those).
 * Everything else is listed with a skip reason.
 *
 * DRY RUN BY DEFAULT (prints the candidates + skip reasons; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh reenable-paused-spawn-hooks.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh reenable-paused-spawn-hooks.js --apply
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh reenable-paused-spawn-hooks.js --revert           # dry-run of the revert
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh reenable-paused-spawn-hooks.js --revert --apply   # disable again exactly what --apply enabled
 * Options: --since <ISO>, --limit N, --run <id>.
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. This file is an
 * owner-directed write one-shot in the backfill-ticket-status-done.js mould —
 * every write sits behind `--apply`. Each re-enable is guarded
 * (`WHERE id = ? AND enabled = false`) and audited (Activity
 * `hook.reenable_after_pause_fix`, metadata {hookIds, run}) — the revert reads
 * those rows back.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs
 * it from /app): `require('/app/dist/config/database')` is the backend's own
 * Prisma client. Testable offline: `module.exports.run({ prisma, argv })`
 * (backend/src/scripts/reenable-paused-spawn-hooks.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const DEFAULT_SINCE = '2026-10-06T00:00:00Z';
const SPAWN_ORIGINS = ['system:child-result-hook', 'system:direct-wake'];
const AUDIT_ACTION = 'hook.reenable_after_pause_fix';
const PAUSE_SCAN = 5000;

function parseArgs(argv) {
  const out = { apply: false, revert: false, since: DEFAULT_SINCE, limit: null, run: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--revert') out.revert = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--since') out.since = String(argv[++i] || '');
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a === '--run') out.run = String(argv[++i] || '');
    else if (a.startsWith('--run=')) out.run = a.slice('--run='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(new Date(out.since).getTime())) throw new Error('--since must be an ISO timestamp');
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit < 0)) throw new Error('--limit must be a non-negative number');
  return out;
}

const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * The disabled spawn-wired hooks a pause row since `since` named. Starts from
 * event_hooks (small) and reads each owner's pause rows through the
 * activities (userId, createdAt) index — never an unindexed action scan.
 */
async function pausedSpawnHooks(prisma, since) {
  const hooks = await prisma.eventHook.findMany({
    where: { enabled: false, createdVia: { in: SPAWN_ORIGINS } },
    select: { id: true, userId: true, sourceChatId: true, targetChatId: true, createdVia: true, createdAt: true },
  });
  const userIds = [...new Set(hooks.map((h) => h.userId).filter(Boolean))];
  const pausedAtByHook = new Map();
  let pauseRows = 0;
  for (const userId of userIds) {
    const rows = await prisma.activity.findMany({
      where: { userId, action: 'project_supervisor.pause', createdAt: { gte: since } },
      select: { createdAt: true, metadata: true },
      orderBy: { createdAt: 'asc' },
      take: PAUSE_SCAN,
    });
    pauseRows += rows.length;
    for (const r of rows) {
      const ids = Array.isArray(asObj(r.metadata).hookIds) ? asObj(r.metadata).hookIds : [];
      for (const id of ids) pausedAtByHook.set(String(id), r.createdAt);
    }
  }
  const named = hooks.filter((h) => pausedAtByHook.has(h.id)).map((h) => ({ ...h, pausedAt: pausedAtByHook.get(h.id) }));
  return { pauseRows, disabledSpawnHooks: hooks.length, named };
}

/** Classify every candidate hook: { ..., verdict: 'reenable' | 'skip', reason }. */
async function classify(prisma, hooks) {
  if (!hooks.length) return [];
  const chatIds = [...new Set(hooks.flatMap((h) => [h.sourceChatId, h.targetChatId]).filter(Boolean))];
  const chats = chatIds.length
    ? await prisma.crossModelChat.findMany({
        where: { id: { in: chatIds } },
        select: { id: true, archivedAt: true, projectId: true, isProjectSupervisor: true, isSupervisor: true },
      })
    : [];
  const chatById = new Map(chats.map((c) => [c.id, c]));
  const out = [];
  for (const h of hooks) {
    const target = chatById.get(h.targetChatId);
    const base = { id: h.id, userId: h.userId, createdVia: h.createdVia, sourceChatId: h.sourceChatId, targetChatId: h.targetChatId, pausedAt: h.pausedAt };
    if (!target) { out.push({ ...base, verdict: 'skip', reason: 'target_missing' }); continue; }
    if (target.archivedAt) { out.push({ ...base, verdict: 'skip', reason: 'target_archived' }); continue; }
    if (!target.isProjectSupervisor && !target.isSupervisor) { out.push({ ...base, verdict: 'skip', reason: 'target_not_supervisor' }); continue; }
    if (h.createdVia === 'system:direct-wake') { out.push({ ...base, verdict: 'reenable', reason: 'direct_wake_plumbing' }); continue; }
    const source = chatById.get(h.sourceChatId);
    if (!source) { out.push({ ...base, verdict: 'skip', reason: 'child_missing' }); continue; }
    if (source.archivedAt) { out.push({ ...base, verdict: 'skip', reason: 'child_archived' }); continue; }
    const outOfProject = !!target.projectId && !!source.projectId && source.projectId !== target.projectId;
    if (!outOfProject && target.projectId) {
      const projectHook = await prisma.eventHook.findFirst({
        where: { sourceChatId: null, targetChatId: target.id, projectId: target.projectId, enabled: true },
        select: { id: true },
      });
      if (projectHook) { out.push({ ...base, verdict: 'skip', reason: 'supervision_live_project_hook_covers' }); continue; }
    }
    out.push({ ...base, verdict: 'reenable', reason: outOfProject ? 'child_out_of_project' : 'supervision_paused' });
  }
  return out;
}

async function applyForward(prisma, rows, { run }) {
  let reenabled = 0;
  let skippedChanged = 0;
  const done = [];
  for (const r of rows) {
    const res = await prisma.eventHook.updateMany({ where: { id: r.id, enabled: false }, data: { enabled: true } });
    if (res.count > 0) { reenabled += res.count; done.push(r); } else skippedChanged += 1;
  }
  // One audit row per target chat (owner-attributable; the revert reads them).
  const byTarget = new Map();
  for (const r of done) {
    const entry = byTarget.get(r.targetChatId) || { userId: r.userId, hookIds: [] };
    entry.hookIds.push(r.id);
    byTarget.set(r.targetChatId, entry);
  }
  for (const [targetChatId, { userId, hookIds }] of byTarget) {
    await prisma.activity.create({
      data: {
        userId,
        action: AUDIT_ACTION,
        resource: 'platform',
        metadata: { chatId: targetChatId, hookIds, run, reason: 'audit 2026-10-08 W1-1: re-enable spawn-wired hooks the paused-supervisor heal disabled' },
      },
    });
  }
  return { reenabled, skippedChanged };
}

/** Hook ids a forward --apply re-enabled (its audit rows), read per owner through the (userId, createdAt) index. */
async function selectApplied(prisma, run, since) {
  const owners = await prisma.eventHook.findMany({
    where: { enabled: true, createdVia: { in: SPAWN_ORIGINS } },
    select: { userId: true },
  });
  const ids = [];
  for (const userId of [...new Set(owners.map((o) => o.userId).filter(Boolean))]) {
    const rows = await prisma.activity.findMany({
      where: { userId, action: AUDIT_ACTION, createdAt: { gte: since } },
      select: { metadata: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: PAUSE_SCAN,
    });
    for (const r of rows) {
      const m = asObj(r.metadata);
      if (run && m.run !== run) continue;
      if (Array.isArray(m.hookIds)) ids.push(...m.hookIds.map(String));
    }
  }
  return [...new Set(ids)];
}

async function applyRevert(prisma, ids) {
  let disabled = 0;
  let skippedChanged = 0;
  for (const id of ids) {
    const res = await prisma.eventHook.updateMany({ where: { id, enabled: true }, data: { enabled: false } });
    if (res.count > 0) disabled += res.count; else skippedChanged += 1;
  }
  return { disabled, skippedChanged };
}

function countBy(rows, keyOf) {
  const counts = {};
  for (const r of rows) {
    const k = keyOf(r);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

async function run({ prisma, argv, print } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    if (print) console.log('usage: reenable-paused-spawn-hooks.js [--apply] [--revert] [--since ISO] [--limit N] [--run <id>]');
    return { help: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const client = prisma || require('/app/dist/config/database').default;
  const runId = opts.run || `spawn-hooks-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const report = { script: 'reenable-paused-spawn-hooks', run: runId, at: new Date().toISOString(), action: opts.revert ? 'revert' : 'forward', apply: opts.apply, dryRun: !opts.apply };
  if (!opts.revert) {
    const since = new Date(opts.since);
    report.since = since.toISOString();
    const { pauseRows, disabledSpawnHooks, named } = await pausedSpawnHooks(client, since);
    report.pauseRows = pauseRows;
    report.disabledSpawnHooks = disabledSpawnHooks;
    report.namedByAPause = named.length;
    const classified = await classify(client, named);
    let toEnable = classified.filter((c) => c.verdict === 'reenable');
    if (opts.limit !== null) toEnable = toEnable.slice(0, opts.limit);
    report.candidates = classified.length;
    report.byReason = countBy(classified, (c) => `${c.verdict}:${c.reason}`);
    report.rows = classified.map((c) => ({ id: c.id, createdVia: c.createdVia, source: c.sourceChatId, target: c.targetChatId, verdict: c.verdict, reason: c.reason }));
    if (opts.apply) Object.assign(report, await applyForward(client, toEnable, { run: runId }));
    else report.wouldReenable = toEnable.length;
  } else {
    const ids = await selectApplied(client, opts.run, new Date(opts.since));
    report.appliedHookIds = ids.length;
    if (opts.apply) Object.assign(report, await applyRevert(client, opts.limit !== null ? ids.slice(0, opts.limit) : ids));
    else report.wouldDisable = ids.length;
  }
  if (print) console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  return report;
}

module.exports = { run, parseArgs, pausedSpawnHooks, classify, applyForward, applyRevert, selectApplied, SPAWN_ORIGINS, AUDIT_ACTION, DEFAULT_SINCE };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument|--limit must|--since must/.test(String(err && err.message));
      console.error(`reenable-paused-spawn-hooks: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}

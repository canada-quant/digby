#!/usr/bin/env node
/**
 * pause-hooks-archived-targets.js — ONE-SHOT WRITE (audit 2026-10-08 W3-5).
 *
 * 192 ENABLED event hooks targeted ARCHIVED chats on 2026-10-08: the 2026-10-06
 * T3-12 archive pause covered only a chat's OUTGOING hooks, and the delivery-time
 * retired-target pause exempts every `system:*` hook (child-result wakes,
 * todo_wake self-hooks). The runtime now pauses the hooks that TARGET a chat when
 * it is archived (platform/hooks.service pauseHooksForArchivedSource); this script
 * applies the same to chats archived BEFORE that shipped.
 *
 * Each paused hook id is merged into the chat's archive-paused record — the SAME
 * context-store row the runtime writes (store namespacePath
 * `hooks:archive-paused:<chatId>`, key `ids`, value `{ids, at}`) — so restoring
 * the chat (archive_chat archived:false / the Restore button / the coding session
 * API) re-arms exactly them. A run record (`hooks:archive-target-backfill`, key =
 * the run id) lists every hook the run paused so `--revert` can undo it.
 *
 * DRY RUN BY DEFAULT (lists what it would pause; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh pause-hooks-archived-targets.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh pause-hooks-archived-targets.js --apply
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh pause-hooks-archived-targets.js --revert --run <id>           # dry-run of the revert
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh pause-hooks-archived-targets.js --revert --run <id> --apply   # re-enable what that run paused
 * Options: --limit N (cap the hooks touched), --run <id> (stamp; default a timestamp).
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. This file is an
 * owner-directed write one-shot in the backfill-ticket-status-done.js mould —
 * every write sits behind `--apply`. Each hook's update is guarded
 * (`WHERE id = ? AND enabled = true`), so a hook somebody touched between the
 * read and the write is left alone and counted under `skippedChanged`.
 *
 * Testable offline: `module.exports.run({ prisma, argv })` takes a mocked client
 * (backend/src/scripts/pause-hooks-archived-targets.test.ts).
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const PAUSED_NS = (chatId) => `hooks:archive-paused:${chatId}`;
const PAUSED_KEY = 'ids';
const RUN_NS = 'hooks:archive-target-backfill';
const HOOK_SCAN = 20000; // bound the enabled-hook scan (prod ~ low thousands)

function parseArgs(argv) {
  const out = { apply: false, revert: false, limit: null, run: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--revert') out.revert = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a === '--run') out.run = String(argv[++i] || '');
    else if (a.startsWith('--run=')) out.run = a.slice('--run='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit < 0)) throw new Error('--limit must be a non-negative number');
  if (out.revert && !out.run) throw new Error('--revert needs --run <id> (the run whose pauses to undo)');
  return out;
}

function countBy(rows, keyOf) {
  const counts = {};
  for (const r of rows) {
    const k = keyOf(r);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/** Enabled hooks whose TARGET chat is archived (oldest hook first). */
async function selectCandidates(prisma, limit) {
  const hooks = await prisma.eventHook.findMany({
    where: { enabled: true },
    select: { id: true, userId: true, sourceChatId: true, targetChatId: true, createdVia: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: HOOK_SCAN,
  });
  const targetIds = [...new Set(hooks.map((h) => h.targetChatId).filter(Boolean))];
  if (!targetIds.length) return [];
  const archived = await prisma.crossModelChat.findMany({
    where: { id: { in: targetIds }, archivedAt: { not: null } },
    select: { id: true, userId: true, archivedAt: true },
  });
  const archivedById = new Map(archived.map((c) => [c.id, c]));
  // Only the chat OWNER's hooks (the runtime pause is owner-scoped the same way).
  let out = hooks.filter((h) => {
    const c = archivedById.get(h.targetChatId);
    return c && c.userId === h.userId;
  }).map((h) => ({ ...h, targetArchivedAt: archivedById.get(h.targetChatId).archivedAt }));
  if (limit !== null && limit !== undefined) out = out.slice(0, limit);
  return out;
}

async function rememberPaused(prisma, chatId, ids, at) {
  const where = { namespacePath_key: { namespacePath: PAUSED_NS(chatId), key: PAUSED_KEY } };
  const prev = await prisma.contextStoreEntry.findUnique({ where }).catch(() => null);
  const prevIds = prev && prev.value && Array.isArray(prev.value.ids) ? prev.value.ids.map(String) : [];
  const merged = [...new Set([...prevIds, ...ids])];
  await prisma.contextStoreEntry.upsert({
    where,
    create: { namespacePath: PAUSED_NS(chatId), key: PAUSED_KEY, value: { ids: merged, at } },
    update: { value: { ids: merged, at }, updatedAt: new Date() },
  });
}

async function applyForward(prisma, rows, { run }) {
  const at = new Date().toISOString();
  let paused = 0;
  let skippedChanged = 0;
  const pausedRows = [];
  for (const h of rows) {
    const res = await prisma.eventHook.updateMany({ where: { id: h.id, enabled: true }, data: { enabled: false } });
    if (res.count > 0) { paused += res.count; pausedRows.push(h); } else skippedChanged += 1;
  }
  const byChat = new Map();
  for (const h of pausedRows) byChat.set(h.targetChatId, [...(byChat.get(h.targetChatId) || []), h.id]);
  for (const [chatId, ids] of byChat) await rememberPaused(prisma, chatId, ids, at);
  await prisma.contextStoreEntry.upsert({
    where: { namespacePath_key: { namespacePath: RUN_NS, key: run } },
    create: { namespacePath: RUN_NS, key: run, value: { hookIds: pausedRows.map((h) => h.id), chats: [...byChat.keys()], at } },
    update: { value: { hookIds: pausedRows.map((h) => h.id), chats: [...byChat.keys()], at }, updatedAt: new Date() },
  });
  return { paused, skippedChanged, chats: byChat.size };
}

async function applyRevert(prisma, hookIds) {
  let restored = 0;
  let skippedChanged = 0;
  for (const id of hookIds) {
    const res = await prisma.eventHook.updateMany({ where: { id, enabled: false }, data: { enabled: true } });
    if (res.count > 0) restored += res.count; else skippedChanged += 1;
  }
  return { restored, skippedChanged };
}

async function run({ prisma, argv, print } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    if (print) console.log('usage: pause-hooks-archived-targets.js [--apply] [--limit N] [--run <id>] | --revert --run <id> [--apply]');
    return { help: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const client = prisma || require('/app/dist/config/database').default;
  const runId = opts.run || `archived-target-hooks-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const report = { script: 'pause-hooks-archived-targets', run: runId, at: new Date().toISOString(), action: opts.revert ? 'revert' : 'forward', apply: opts.apply, dryRun: !opts.apply };
  if (!opts.revert) {
    const rows = await selectCandidates(client, opts.limit);
    report.candidates = rows.length;
    report.chats = new Set(rows.map((r) => r.targetChatId)).size;
    report.byCreatedVia = countBy(rows, (r) => String(r.createdVia || 'user'));
    report.rows = rows.slice(0, 300).map((r) => ({ id: r.id, targetChatId: r.targetChatId, sourceChatId: r.sourceChatId, createdVia: r.createdVia || null, targetArchivedAt: r.targetArchivedAt }));
    if (opts.apply) Object.assign(report, await applyForward(client, rows, { run: runId }));
    else report.wouldPause = rows.length;
  } else {
    const rec = await client.contextStoreEntry.findUnique({ where: { namespacePath_key: { namespacePath: RUN_NS, key: opts.run } } });
    const hookIds = rec && rec.value && Array.isArray(rec.value.hookIds) ? rec.value.hookIds.map(String) : [];
    report.recordedHooks = hookIds.length;
    if (opts.apply) {
      Object.assign(report, await applyRevert(client, hookIds));
      await client.contextStoreEntry.deleteMany({ where: { namespacePath: RUN_NS, key: opts.run } }).catch(() => {});
    } else report.wouldRestore = hookIds.length;
  }
  if (print) console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  return report;
}

module.exports = { run, parseArgs, selectCandidates, applyForward, applyRevert, PAUSED_NS, PAUSED_KEY, RUN_NS };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument|--limit must|--revert needs/.test(String(err && err.message));
      console.error(`pause-hooks-archived-targets: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}

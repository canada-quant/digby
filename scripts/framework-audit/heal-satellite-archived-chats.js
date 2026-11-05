#!/usr/bin/env node
/**
 * heal-satellite-archived-chats.js — ONE-SHOT WRITE (lane lifecycle C3, 2026-10-21).
 *
 * Archiving a coding session through the SESSION API (PATCH
 * /coding/sessions/:id {archived:true}) flipped only the chat_coding_state
 * satellite to 'archived' and deliberately never stamped
 * crossmodel_chats.archivedAt — so the chat stayed in the sidebar for good, and
 * every reaper skips a satellite that is already 'archived'. The runtime now
 * stamps the chat through archiveChat (coding.controller updateSession,
 * SESSION_API_ARCHIVE_STAMP_DISABLED); this script stamps the chats archived
 * that way BEFORE it shipped. Prod probe LLC1021 (2026-10-21) expects five:
 * b60a48b8, ca00a9a3, 43601767, 69b499e2, bcd9855c.
 *
 * Selection: a chat whose satellite status is 'archived', whose archivedAt is
 * NULL, that is not a Fleet / Project Supervisor and holds NO enabled schedule
 * (archiveChat's own rule — a cadence firing into a hidden chat is the surprise
 * it refuses). The write is a guarded stamp (`WHERE id = ? AND archivedAt IS
 * NULL`), not archiveChat: the satellite is already archived and the session
 * API already paused its machine work, so only the missing stamp is applied.
 * Each healed chat keeps a marker in the context store — namespacePath
 * `<chatId>:satellite-archive-heal`, key `previous`, value
 * `{ previousArchivedAt: null, healedAt, run }` — so `--revert` clears exactly
 * the stamps this script wrote (a chat archived again since then is left alone).
 *
 * DRY RUN BY DEFAULT (lists what it would stamp; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh heal-satellite-archived-chats.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh heal-satellite-archived-chats.js --apply
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh heal-satellite-archived-chats.js --revert           # dry-run of the revert
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh heal-satellite-archived-chats.js --revert --apply   # clear the healed stamps
 * Options: --limit N (cap the chats touched), --run <id> (stamp; default a timestamp).
 *
 * NOTE on prodq.sh: its header says probes stay read-only. This file is an
 * owner-directed write one-shot in the backfill-chat-mode-auto.js mould — every
 * write sits behind `--apply`.
 *
 * Testable offline: `module.exports.run({ prisma, argv })` takes a mocked client
 * (backend/src/scripts/heal-satellite-archived-chats.test.ts).
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const NS_SUFFIX = ':satellite-archive-heal';
const STORE_KEY = 'previous';
const SCAN_CAP = 5000;
const nsFor = (chatId) => `${chatId}${NS_SUFFIX}`;
const chatIdOf = (namespacePath) => (typeof namespacePath === 'string' && namespacePath.endsWith(NS_SUFFIX) ? namespacePath.slice(0, -NS_SUFFIX.length) : null);

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
  return out;
}

/** Satellite-archived, unstamped, non-supervisor chats with no enabled schedule (oldest update first). */
async function selectCandidates(prisma, limit) {
  const rows = await prisma.crossModelChat.findMany({
    where: {
      archivedAt: null,
      isSupervisor: false,
      isProjectSupervisor: false,
      codingState: { is: { status: 'archived' } },
      chatSchedules: { none: { enabled: true } },
    },
    select: { id: true, userId: true, projectId: true, title: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
    take: limit !== null && limit !== undefined ? Math.min(limit, SCAN_CAP) : SCAN_CAP,
  });
  return rows;
}

async function applyForward(prisma, rows, { run }) {
  const healedAt = new Date();
  let healed = 0;
  let skippedChanged = 0;
  const ids = [];
  for (const r of rows) {
    // The marker FIRST, so a crash between the two never leaves a stamp --revert cannot find.
    await prisma.contextStoreEntry.upsert({
      where: { namespacePath_key: { namespacePath: nsFor(r.id), key: STORE_KEY } },
      create: { namespacePath: nsFor(r.id), key: STORE_KEY, value: { previousArchivedAt: null, healedAt: healedAt.toISOString(), run } },
      update: { value: { previousArchivedAt: null, healedAt: healedAt.toISOString(), run }, updatedAt: new Date() },
    });
    const res = await prisma.crossModelChat.updateMany({ where: { id: r.id, archivedAt: null }, data: { archivedAt: healedAt } });
    if (res.count > 0) { healed += res.count; ids.push(r.id); }
    else {
      skippedChanged += 1;
      await prisma.contextStoreEntry.deleteMany({ where: { namespacePath: nsFor(r.id), key: STORE_KEY } }).catch(() => {});
    }
  }
  return { healed, skippedChanged, healedIds: ids, healedAt: healedAt.toISOString() };
}

async function listMarkers(prisma) {
  return prisma.contextStoreEntry.findMany({
    where: { key: STORE_KEY, namespacePath: { endsWith: NS_SUFFIX } },
    select: { namespacePath: true, value: true },
    orderBy: { namespacePath: 'asc' },
    take: SCAN_CAP,
  });
}

async function applyRevert(prisma, markers) {
  let restored = 0;
  let skippedChanged = 0;
  for (const m of markers) {
    const chatId = chatIdOf(m.namespacePath);
    const healedAt = m.value && typeof m.value.healedAt === 'string' ? new Date(m.value.healedAt) : null;
    if (!chatId || !healedAt || Number.isNaN(healedAt.getTime())) { skippedChanged += 1; continue; }
    // Only the stamp THIS script wrote — a chat archived again since keeps its newer stamp.
    const res = await prisma.crossModelChat.updateMany({ where: { id: chatId, archivedAt: healedAt }, data: { archivedAt: null } });
    if (res.count > 0) restored += res.count; else skippedChanged += 1;
    await prisma.contextStoreEntry.deleteMany({ where: { namespacePath: m.namespacePath, key: STORE_KEY } });
  }
  return { restored, skippedChanged };
}

async function run({ prisma, argv, print } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    if (print) console.log('usage: heal-satellite-archived-chats.js [--apply] [--limit N] [--run <id>] | --revert [--apply]');
    return { help: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const client = prisma || require('/app/dist/config/database').default;
  const runId = opts.run || `satellite-archive-heal-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const report = { script: 'heal-satellite-archived-chats', run: runId, at: new Date().toISOString(), action: opts.revert ? 'revert' : 'forward', apply: opts.apply, dryRun: !opts.apply };
  if (!opts.revert) {
    const rows = await selectCandidates(client, opts.limit);
    report.candidates = rows.length;
    report.rows = rows.slice(0, 300).map((r) => ({ id: r.id, projectId: r.projectId || null, title: String(r.title || '').slice(0, 60), updatedAt: r.updatedAt }));
    if (opts.apply) Object.assign(report, await applyForward(client, rows, { run: runId }));
    else report.wouldHeal = rows.length;
  } else {
    const markers = await listMarkers(client);
    report.markers = markers.length;
    report.chats = markers.map((m) => chatIdOf(m.namespacePath)).filter(Boolean);
    if (opts.apply) Object.assign(report, await applyRevert(client, markers));
    else report.wouldRestore = markers.length;
  }
  if (print) console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  return report;
}

module.exports = { run, parseArgs, selectCandidates, applyForward, applyRevert, listMarkers, NS_SUFFIX, STORE_KEY };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument|--limit must/.test(String(err && err.message));
      console.error(`heal-satellite-archived-chats: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}

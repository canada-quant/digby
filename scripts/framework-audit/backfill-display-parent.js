#!/usr/bin/env node
/**
 * backfill-display-parent.js — ONE-SHOT WRITE (lane lifecycle, 2026-10-21, branch
 * lanefix/nesting; prod probe LLC1021: FLAT_SHOULD_NEST=8).
 *
 * Stamps `crossmodel_chats.displayParentChatId` = the folder's Project Supervisor on
 * EXISTING machine-spawned lanes, the same value platform.service startCodingSession
 * now stamps on every new agent-origin spawn (platform/display-parent.ts). It is a
 * DISPLAY-ONLY sidebar hint — nothing but the sidebar reads it — so the ticket lanes
 * ("ticket <id8>: …"), family lanes ("family av-mishap: …") and Fleet-spawned lanes that
 * render flat in their folder today nest under that folder's supervisor row.
 *
 * Candidates: unarchived chats WITH a coding state, in a folder (projectId set), not a
 * supervisor themselves, displayParentChatId still NULL, whose folder has an unarchived
 * Project Supervisor of the SAME owner (oldest one), and whose parentChatId is not
 * already that supervisor. The standing engineering lane (env PLATFORM_ENGINEER_CHAT_ID
 * — the R&D stream the old ticket drain fed) is never a candidate: it was not
 * machine-spawned, and every ticket it ever held would otherwise "prove" it.
 *
 * A candidate is stamped ONLY with MACHINE-SPAWN PROOF — the same four rules the
 * runtime lane-retire pass uses (keep them identical):
 *   p1_delegation        a delegation_tasks row with childChatId = the chat AND
 *                        (kind 'ticket' OR (kind 'session' AND origin 'machine'))
 *                        — the ledger exists only since 2026-10-08;
 *   p2_ticket            a user_feature_requests row whose context.dispatchedTo is the
 *                        chat, or whose context.previousLanes contains it (fresh lanes,
 *                        family lanes, legacy batch sessions);
 *   p3_supervisor_parent parentChatId points at an isSupervisor / isProjectSupervisor chat;
 *   p4_first_message     the chat's FIRST role='user' message carries metadata.origin in
 *                        {agent, webhook, schedule, hook, machine} (missing / 'user' = human);
 *                        a 'webhook' first message is not proof while the chat carries a
 *                        ChatWebhook row (the owner armed it).
 * NOT proof: titleSource (the UI's createSession stamps 'spawn-param' too) and a platform
 * REST / API-key spawn (no promptOrigin — its first message reads 'user'). Owner
 * workspace chats therefore stay flat.
 *
 * Each write leaves the chat's updatedAt ALONE: the guarded update is raw SQL that sets
 * only displayParentChatId, so Prisma's @updatedAt never fires and no stale value is
 * written back (the idle archivers, the sidebar's recency order and the /chats/changes
 * delta read it — a sidebar hint must neither make 50 idle lanes look fresh NOR rewind
 * a lane that was bumped while the proof queries ran; review fix 2026-10-21: the first
 * cut wrote back the updatedAt read at SELECT time). The previous value is kept in the
 * context store (the "store" table, memory/context-store.ts conventions):
 *     namespacePath `<chatId>:display-parent-backfill`, key `previous`
 *     value { previous: null, ps, proof, run, at }
 * written FIRST, in the same transaction as the guarded update
 * (`WHERE displayParentChatId IS NULL` — a row stamped meanwhile is counted under
 * `skippedChanged`, never overwritten). `--revert` clears ONLY marked rows that still
 * carry the recorded supervisor, then drops their markers.
 *
 * DRY RUN BY DEFAULT (prints the selection; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-display-parent.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-display-parent.js --apply
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-display-parent.js --revert           # dry-run of the revert
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-display-parent.js --revert --apply   # clear + drop the markers
 * Options: --limit N (cap the rows written this invocation; re-run to continue),
 *          --run <id> (stamp; default a timestamp).
 *
 * NOTE on prodq.sh: its header says probes stay read-only. This file is an owner-directed
 * write one-shot like backfill-chat-mode-auto.js; every write sits behind `--apply`.
 * Under DISPLAY_PARENT_NESTING_DISABLED=1 the stamped values are simply not read.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it from
 * /app): `require('/app/dist/config/database')` is the backend's own Prisma client.
 * Testable offline: `module.exports.run({ prisma, argv, env })` takes a mocked client
 * (backend/src/scripts/backfill-display-parent.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const NS_SUFFIX = ':display-parent-backfill';
const STORE_KEY = 'previous';
const MACHINE_ORIGINS = new Set(['agent', 'webhook', 'schedule', 'hook', 'machine']);
const PROOFS = ['p1_delegation', 'p2_ticket', 'p3_supervisor_parent', 'p4_first_message'];
const UNPROVEN_SAMPLE = 100;

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

const id8 = (id) => String(id || '').slice(0, 8);
const nsFor = (chatId) => `${chatId}${NS_SUFFIX}`;
const chatIdOf = (namespacePath) => (typeof namespacePath === 'string' && namespacePath.endsWith(NS_SUFFIX) ? namespacePath.slice(0, -NS_SUFFIX.length) : null);
const supKey = (projectId, userId) => `${projectId}|${userId}`;

/** (projectId|userId) → the OLDEST unarchived Project Supervisor chat id (resolveProjectSupervisorChatId's rule). */
async function loadSupervisors(prisma) {
  const rows = await prisma.crossModelChat.findMany({
    where: { isProjectSupervisor: true, archivedAt: null, projectId: { not: null } },
    select: { id: true, projectId: true, userId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const map = new Map();
  for (const r of rows) {
    const k = supKey(r.projectId, r.userId);
    if (!map.has(k)) map.set(k, r.id);
  }
  return map;
}

/** Lanes that would nest under their folder supervisor (before the machine-spawn proof). */
async function selectCandidates(prisma, supervisors, env) {
  const projectIds = [...new Set([...supervisors.keys()].map((k) => k.split('|')[0]))];
  if (projectIds.length === 0) return { rows: [], standingLaneExcluded: null };
  const rows = await prisma.crossModelChat.findMany({
    where: {
      archivedAt: null,
      projectId: { in: projectIds },
      isSupervisor: false,
      isProjectSupervisor: false,
      displayParentChatId: null,
      codingState: { isNot: null },
    },
    select: { id: true, userId: true, projectId: true, parentChatId: true },
    orderBy: { createdAt: 'asc' },
  });
  const standing = String((env || process.env).PLATFORM_ENGINEER_CHAT_ID || '').trim();
  let standingLaneExcluded = null;
  const out = [];
  for (const r of rows) {
    if (standing && r.id === standing) { standingLaneExcluded = id8(r.id); continue; }
    const ps = supervisors.get(supKey(r.projectId, r.userId));
    if (!ps || ps === r.id || r.parentChatId === ps) continue;
    out.push({ ...r, ps });
  }
  return { rows: out, standingLaneExcluded };
}

/**
 * The guarded stamp: sets ONLY displayParentChatId on a row that still has none. Raw
 * SQL on purpose — a Prisma update fires @updatedAt (or, given an explicit value,
 * writes back a stale one); this never touches updatedAt. Resolves to the row count.
 */
function stampSql(prisma, chatId, ps) {
  return prisma.$executeRaw`UPDATE "crossmodel_chats" SET "displayParentChatId" = ${ps} WHERE "id" = ${chatId} AND "displayParentChatId" IS NULL`;
}

/** The guarded revert: clears ONLY a row still carrying the supervisor we wrote; updatedAt untouched. */
function clearSql(prisma, chatId, ps) {
  return prisma.$executeRaw`UPDATE "crossmodel_chats" SET "displayParentChatId" = NULL WHERE "id" = ${chatId} AND "displayParentChatId" = ${ps}`;
}

/** chatId → the FIRST proof that holds (p1 → p4 order), for the rows that have one. */
async function proveMachineSpawn(prisma, rows) {
  const proofs = new Map();
  if (rows.length === 0) return proofs;
  const ids = rows.map((r) => r.id);
  const idSet = new Set(ids);

  // p1 — the delegation ledger (since 2026-10-08).
  const tasks = await prisma.delegationTask.findMany({
    where: { childChatId: { in: ids }, OR: [{ kind: 'ticket' }, { kind: 'session', origin: 'machine' }] },
    select: { childChatId: true },
  });
  for (const t of tasks) if (t.childChatId && !proofs.has(t.childChatId)) proofs.set(t.childChatId, 'p1_delegation');

  // p2 — a ticket's lane link (dispatchedTo / previousLanes). Ticket volume is small
  // (≈1.5k rows); the JSON paths are read in JS rather than per-candidate queries.
  const tickets = await prisma.userFeatureRequest.findMany({ select: { context: true } });
  for (const t of tickets) {
    const ctx = t && t.context && typeof t.context === 'object' ? t.context : null;
    if (!ctx) continue;
    const linked = [ctx.dispatchedTo, ...(Array.isArray(ctx.previousLanes) ? ctx.previousLanes : [])];
    for (const l of linked) {
      const lane = typeof l === 'string' ? l : null;
      if (lane && idSet.has(lane) && !proofs.has(lane)) proofs.set(lane, 'p2_ticket');
    }
  }

  // p3 — the parent is a supervisor (Fleet or Project).
  const parentIds = [...new Set(rows.filter((r) => r.parentChatId && !proofs.has(r.id)).map((r) => r.parentChatId))];
  if (parentIds.length) {
    const parents = await prisma.crossModelChat.findMany({
      where: { id: { in: parentIds } },
      select: { id: true, isSupervisor: true, isProjectSupervisor: true },
    });
    const sup = new Set(parents.filter((p) => p.isSupervisor || p.isProjectSupervisor).map((p) => p.id));
    for (const r of rows) if (!proofs.has(r.id) && r.parentChatId && sup.has(r.parentChatId)) proofs.set(r.id, 'p3_supervisor_parent');
  }

  // p4 — the first user-role message was machine-authored. A 'webhook' first
  // message is NOT proof while the chat carries a ChatWebhook row: the owner
  // armed that webhook (lane-family-facts proveMachineSpawned, second review
  // fixer 2026-10-21 — keep the two identical).
  const viaWebhook = [];
  for (const r of rows) {
    if (proofs.has(r.id)) continue;
    const first = await prisma.crossModelMessage.findFirst({
      where: { chatId: r.id, role: 'user' },
      orderBy: { createdAt: 'asc' },
      select: { metadata: true },
    });
    const origin = first && first.metadata && typeof first.metadata === 'object' ? first.metadata.origin : null;
    if (origin === 'webhook') viaWebhook.push(r.id);
    else if (typeof origin === 'string' && MACHINE_ORIGINS.has(origin)) proofs.set(r.id, 'p4_first_message');
  }
  if (viaWebhook.length) {
    const owned = await prisma.chatWebhook.findMany({ where: { chatId: { in: viaWebhook } }, select: { chatId: true } });
    const ownerArmed = new Set(owned.map((w) => w.chatId));
    for (const id of viaWebhook) if (!ownerArmed.has(id)) proofs.set(id, 'p4_first_message');
  }
  return proofs;
}

function summarize(rows) {
  const byProof = Object.fromEntries(PROOFS.map((p) => [p, 0]));
  const byProject = {};
  for (const r of rows) {
    byProof[r.proof] = (byProof[r.proof] || 0) + 1;
    const k = id8(r.projectId);
    if (!byProject[k]) byProject[k] = { ps: id8(r.ps), n: 0, ids: [] };
    byProject[k].n += 1;
    byProject[k].ids.push(`${id8(r.id)}:${r.proof}`);
  }
  return { byProof, byProject };
}

async function applyForward(prisma, rows, opts) {
  const at = new Date().toISOString();
  let updated = 0;
  let skippedChanged = 0;
  for (const r of rows) {
    const value = { previous: null, ps: r.ps, proof: r.proof, run: opts.run, at };
    // The marker FIRST (a crash between the two never loses the record), then the
    // guarded raw update that never touches updatedAt — one transaction per row.
    const [, count] = await prisma.$transaction([
      prisma.contextStoreEntry.upsert({
        where: { namespacePath_key: { namespacePath: nsFor(r.id), key: STORE_KEY } },
        create: { namespacePath: nsFor(r.id), key: STORE_KEY, value },
        update: { value, updatedAt: new Date() },
      }),
      stampSql(prisma, r.id, r.ps),
    ]);
    if (Number(count) === 1) updated += 1;
    else {
      skippedChanged += 1;
      // The row was stamped meanwhile (or vanished) — the marker must not claim it.
      await prisma.contextStoreEntry.deleteMany({ where: { namespacePath: nsFor(r.id), key: STORE_KEY } });
    }
  }
  return { updated, skippedChanged };
}

/** Every marker the backfill wrote (the revert set). */
async function selectBackfilled(prisma, limit) {
  return prisma.contextStoreEntry.findMany({
    where: { key: STORE_KEY, namespacePath: { endsWith: NS_SUFFIX } },
    select: { namespacePath: true, value: true },
    orderBy: { namespacePath: 'asc' },
    ...(limit !== null && limit !== undefined ? { take: limit } : {}),
  });
}

async function applyRevert(prisma, markers) {
  let restored = 0;
  let skippedChanged = 0;
  let chatGone = 0;
  for (const m of markers) {
    const chatId = chatIdOf(m.namespacePath);
    const ps = m.value && typeof m.value.ps === 'string' ? m.value.ps : null;
    if (!chatId || !ps) { skippedChanged += 1; continue; }
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (!chat) {
      // Nothing left to restore — drop the marker so the revert set converges.
      await prisma.contextStoreEntry.deleteMany({ where: { namespacePath: m.namespacePath, key: STORE_KEY } });
      chatGone += 1;
      continue;
    }
    // Clear ONLY a row still carrying the supervisor we wrote; updatedAt untouched.
    const count = await clearSql(prisma, chatId, ps);
    if (Number(count) === 1) {
      await prisma.contextStoreEntry.deleteMany({ where: { namespacePath: m.namespacePath, key: STORE_KEY } });
      restored += 1;
    } else {
      skippedChanged += 1;
    }
  }
  return { restored, skippedChanged, chatGone };
}

/**
 * The whole one-shot. `prisma` is injectable (tests); `argv` defaults to the
 * process's; `env` (tests) defaults to process.env. Returns the report object it
 * also prints when `print` is true.
 */
async function run({ prisma, argv, print = false, env } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    const usage = 'usage: backfill-display-parent.js [--apply] [--revert] [--limit N] [--run <id>]';
    if (print) console.log(usage);
    return { usage };
  }
  const client = prisma || require('/app/dist/config/database').default;
  const runId = opts.run || `display-parent-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const report = { script: 'backfill-display-parent', run: runId, at: new Date().toISOString(), action: opts.revert ? 'revert' : 'forward', apply: opts.apply, dryRun: !opts.apply };
  if (!opts.revert) {
    const supervisors = await loadSupervisors(client);
    report.supervisors = supervisors.size;
    const { rows, standingLaneExcluded } = await selectCandidates(client, supervisors, env);
    report.standingLaneExcluded = standingLaneExcluded;
    report.candidates = rows.length;
    const proofs = await proveMachineSpawn(client, rows);
    const proven = rows.filter((r) => proofs.has(r.id)).map((r) => ({ ...r, proof: proofs.get(r.id) }));
    const unproven = rows.filter((r) => !proofs.has(r.id));
    report.proven = proven.length;
    report.unproven = unproven.length;
    report.unprovenIds = unproven.slice(0, UNPROVEN_SAMPLE).map((r) => id8(r.id));
    const selected = opts.limit !== null ? proven.slice(0, opts.limit) : proven;
    Object.assign(report, summarize(selected));
    if (opts.apply) Object.assign(report, await applyForward(client, selected, { run: runId }));
    else report.wouldUpdate = selected.length;
  } else {
    const markers = await selectBackfilled(client, opts.limit);
    report.backfilledRows = markers.length;
    report.ids = markers.map((m) => id8(chatIdOf(m.namespacePath)));
    if (opts.apply) Object.assign(report, await applyRevert(client, markers));
    else report.wouldRestore = markers.length;
  }
  if (print) console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  return report;
}

module.exports = { run, parseArgs, loadSupervisors, selectCandidates, proveMachineSpawn, stampSql, clearSql, applyForward, selectBackfilled, applyRevert, nsFor, chatIdOf, NS_SUFFIX, STORE_KEY, MACHINE_ORIGINS, PROOFS };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument|--limit must/.test(String(err && err.message));
      console.error(`backfill-display-parent: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}

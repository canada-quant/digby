#!/usr/bin/env node
/**
 * backfill-ticket-status-done.js — ONE-SHOT WRITE (backlog audit T8, 2026-09-28).
 *
 * Folds every `user_feature_requests` row sitting in a LEGACY closed status
 * ('resolved' by default — the six rows the audit found; any spelling in
 * feedback/ticket-status.ts LEGACY_CLOSED_TICKET_STATUSES via --from) to the
 * canonical 'done', and PRESERVES the previous value on the row's own context
 * (`context.statusBackfill = { previous, at, run }`) so `--revert` restores it
 * byte-for-byte. The adminNote is untouched (it already carries the closure
 * evidence for these rows). The runtime already READS a legacy spelling as
 * 'done' (ticket-status.ts normalizeTicketStatus) — this script is a CLEANUP,
 * not a prerequisite.
 *
 * DRY RUN BY DEFAULT (prints the rows it would fold; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-ticket-status-done.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-ticket-status-done.js --apply
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-ticket-status-done.js --revert           # dry-run of the revert
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-ticket-status-done.js --revert --apply   # restore the previous status + drop the marker
 * Options: --from <status[,status]> (default: resolved; 'legacy' = every legacy closed spelling),
 *          --limit N (cap the rows touched this invocation), --run <id> (stamp; default a timestamp).
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. This file is an
 * owner-directed write one-shot in the backfill-chat-mode-auto.js mould — every
 * write sits behind `--apply`; without it the script is a read-only probe. Each
 * row's update is guarded (`WHERE id = ? AND status = <the status we read>`), so
 * a row that moved between the read and the write is left alone and counted
 * under `skippedChanged`.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it
 * from /app): `require('/app/dist/config/database')` is the backend's own Prisma
 * client. Testable offline: `module.exports.run({ prisma, argv })` takes a mocked
 * client (backend/src/scripts/backfill-ticket-status-done.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const TARGET_STATUS = 'done';
const DEFAULT_FROM = ['resolved'];
/** Mirrors feedback/ticket-status.ts LEGACY_CLOSED_TICKET_STATUSES (kept literal: this file runs standalone inside the container). */
const LEGACY_CLOSED = ['resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix'];
const MARKER_KEY = 'statusBackfill';
const REVERT_SCAN = 5000; // bound the done-row scan on revert (the table is ~1.1k rows)

function parseArgs(argv) {
  const out = { apply: false, revert: false, from: DEFAULT_FROM.slice(), limit: null, run: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--revert') out.revert = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--from') out.from = parseFrom(argv[++i]);
    else if (a.startsWith('--from=')) out.from = parseFrom(a.slice('--from='.length));
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a === '--run') out.run = String(argv[++i] || '');
    else if (a.startsWith('--run=')) out.run = a.slice('--run='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit < 0)) throw new Error('--limit must be a non-negative number');
  return out;
}

function parseFrom(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('--from needs a status list');
  if (text === 'legacy') return LEGACY_CLOSED.slice();
  const list = text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const s of list) {
    if (s === TARGET_STATUS) throw new Error(`--from cannot name the target status '${TARGET_STATUS}'`);
    if (!LEGACY_CLOSED.includes(s)) throw new Error(`--from '${s}' is not a legacy closed status (${LEGACY_CLOSED.join(', ')})`);
  }
  return list;
}

const asContext = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function countBy(rows, keyOf) {
  const counts = {};
  for (const r of rows) {
    const k = keyOf(r);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/** Every row in one of the legacy closed statuses (oldest first). */
async function selectCandidates(prisma, from, limit) {
  return prisma.userFeatureRequest.findMany({
    where: { status: { in: from } },
    select: { id: true, status: true, source: true, title: true, context: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    ...(limit !== null && limit !== undefined ? { take: limit } : {}),
  });
}

/** Rows this script folded (status 'done' carrying the marker), oldest first. */
async function selectBackfilled(prisma, limit) {
  const rows = await prisma.userFeatureRequest.findMany({
    where: { status: TARGET_STATUS },
    select: { id: true, status: true, context: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: REVERT_SCAN,
  });
  const marked = rows.filter((r) => {
    const m = asContext(r.context)[MARKER_KEY];
    return m && typeof m === 'object' && typeof m.previous === 'string';
  });
  return limit !== null && limit !== undefined ? marked.slice(0, limit) : marked;
}

async function applyForward(prisma, rows, { run }) {
  let updated = 0;
  let skippedChanged = 0;
  const at = new Date().toISOString();
  for (const row of rows) {
    const ctx = asContext(row.context);
    const res = await prisma.userFeatureRequest.updateMany({
      where: { id: row.id, status: row.status }, // guard: the status we read
      data: { status: TARGET_STATUS, context: { ...ctx, [MARKER_KEY]: { previous: row.status, at, run } } },
    });
    if (res.count > 0) updated += res.count; else skippedChanged += 1;
  }
  return { updated, skippedChanged };
}

async function applyRevert(prisma, rows) {
  let restored = 0;
  let skippedChanged = 0;
  for (const row of rows) {
    const ctx = asContext(row.context);
    const marker = ctx[MARKER_KEY];
    const { [MARKER_KEY]: _dropped, ...rest } = ctx;
    const res = await prisma.userFeatureRequest.updateMany({
      where: { id: row.id, status: TARGET_STATUS }, // guard: still the folded value
      data: { status: marker.previous, context: rest },
    });
    if (res.count > 0) restored += res.count; else skippedChanged += 1;
  }
  return { restored, skippedChanged };
}

async function run({ prisma, argv, print } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    if (print) console.log('usage: backfill-ticket-status-done.js [--apply] [--revert] [--from resolved,closed|legacy] [--limit N] [--run <id>]');
    return { help: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const client = prisma || require('/app/dist/config/database').default;
  const runId = opts.run || `ticket-status-done-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const report = { script: 'backfill-ticket-status-done', run: runId, at: new Date().toISOString(), action: opts.revert ? 'revert' : 'forward', apply: opts.apply, dryRun: !opts.apply };
  if (!opts.revert) {
    report.from = opts.from;
    const rows = await selectCandidates(client, opts.from, opts.limit);
    report.candidates = rows.length;
    report.byPreviousStatus = countBy(rows, (r) => String(r.status));
    report.bySource = countBy(rows, (r) => String(r.source));
    report.rows = rows.map((r) => ({ id: r.id, status: r.status, source: r.source, title: String(r.title || '').slice(0, 80), createdAt: r.createdAt }));
    if (opts.apply) Object.assign(report, await applyForward(client, rows, { run: runId }));
    else report.wouldUpdate = rows.length;
  } else {
    const rows = await selectBackfilled(client, opts.limit);
    report.backfilledRows = rows.length;
    report.byPreviousStatus = countBy(rows, (r) => String(asContext(r.context)[MARKER_KEY].previous));
    if (opts.apply) Object.assign(report, await applyRevert(client, rows));
    else report.wouldRestore = rows.length;
  }
  if (print) console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  return report;
}

module.exports = { run, parseArgs, parseFrom, selectCandidates, selectBackfilled, applyForward, applyRevert, TARGET_STATUS, DEFAULT_FROM, LEGACY_CLOSED, MARKER_KEY };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument|--limit must|--from/.test(String(err && err.message));
      console.error(`backfill-ticket-status-done: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}

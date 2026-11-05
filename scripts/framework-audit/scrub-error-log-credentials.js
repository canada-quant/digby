#!/usr/bin/env node
/**
 * scrub-error-log-credentials.js — ONE-SHOT WRITE (backlog audit T7,
 * 2026-09-28): mask URL-embedded credentials (`https://x-access-token:<token>@…`,
 * `//user:pass@host`) in ALREADY-STORED app_error_logs rows through the shared
 * `utils/redact-credentials` helper — the same function the git() wrapper and
 * the logger format run today for every NEW record.
 *
 * WHY: `coding/workspace.service.ts ensureRepoMirror` logged a failed
 * `git remote set-url origin <authed url>` with execFile's full argv echo, so
 * the GitHub OAuth user token (long-lived — github/token-manager: no expiry)
 * sat in 11 app_error_logs rows (message column; the stack / context columns
 * can carry the same text). The runtime fix stops new rows; this cleans the
 * old ones. Nothing else is touched.
 *
 * WHAT IT SCANS (never prints a credential — row ids, columns, masked spans only):
 *   app_error_logs.message / .stack / .context (string leaves)
 *   selected by a Postgres regex on the userinfo shape (`//<userinfo>@`) so the
 *   scan is index-free but bounded: --since <ISO> (default: all time), --limit N (default 5000)
 *
 * DRY RUN BY DEFAULT (prints the hit list; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh scrub-error-log-credentials.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh scrub-error-log-credentials.js --show-masked
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh scrub-error-log-credentials.js --apply
 * Options: --since <ISO>   only rows created at/after that instant
 *          --limit N       cap the candidate rows (default 5000)
 *          --id <prefix>   only that row (≥ 8 chars)
 *          --show-masked   each hit lists its masked spans (first 3 + `***` + last 2)
 *
 * WRITE GUARDS: each update is `WHERE id = ? AND message = <the value we read>`
 * (a row rewritten between read and write is left alone and counted under
 * `skippedChanged` — re-run). Every other column is untouched.
 *
 * NO "previous value" store row, deliberately: the previous value IS the
 * credential. The owner revokes / re-issues the token.
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. Like the other
 * one-shots this is a deliberate owner-directed exception — every write sits
 * behind `--apply`; without it the script is a read-only probe.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it
 * from /app): `require('/app/dist/config/database')` is the backend's Prisma
 * client and `require('/app/dist/utils/redact-credentials')` the shared mask.
 * Testable offline: `module.exports.run({ prisma, argv, redact, hasCredentials })`
 * (backend/src/scripts/scrub-error-log-credentials.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

/** The same userinfo shape utils/redact-credentials masks, as a Postgres regex. */
// Postgres ARE: the `(?!\*\*\*@)` lookahead excludes the mask itself, so an
// already-scrubbed row is never a candidate again (the runtime regex has the
// same guard — idempotent on both sides).
const USERINFO_SQL_RE = "//(?!\\*\\*\\*@)[^/@[:space:]'\"`]+@";

function parseArgs(argv) {
  const out = { apply: false, since: null, limit: 5000, id: null, showMasked: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--show-masked') out.showMasked = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--since') out.since = String(argv[++i] || '');
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a === '--id') out.id = String(argv[++i] || '');
    else if (a.startsWith('--id=')) out.id = a.slice('--id='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.since !== null && Number.isNaN(Date.parse(out.since))) throw new Error('--since needs an ISO timestamp');
  if (!Number.isInteger(out.limit) || out.limit < 1) throw new Error('--limit needs a positive integer');
  if (out.id !== null && out.id.length < 8) throw new Error('--id needs the full id or a prefix of at least 8 characters');
  return out;
}

/** first 3 + `***` + last 2 (≤ 8 chars ⇒ `***` alone): reviewable, never the secret. */
function maskSpan(value) {
  const v = String(value ?? '');
  if (v.length <= 8) return '***';
  return `${v.slice(0, 3)}***${v.slice(-2)}`;
}

/** The userinfo spans in `text` (masked) — for --show-masked. */
function maskedSpans(field, text) {
  const out = [];
  const re = /\/\/(?!\*\*\*@)([^/@\s'"`]+)@/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) out.push(`${field}: url userinfo ${maskSpan(m[1])}`);
  return out;
}

/** Redact every string leaf of a JSON value. Returns { value, changed }; input not mutated. */
function redactJsonDeep(value, redact, hasCredentials) {
  let changed = false;
  const walk = (v, depth) => {
    if (typeof v === 'string') {
      if (!hasCredentials(v)) return v;
      const next = redact(v);
      if (next !== v) changed = true;
      return next;
    }
    if (depth >= 16 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, depth + 1);
    return o;
  };
  const next = walk(value, 0);
  return { value: changed ? next : value, changed };
}

function collectMaskedDeep(field, value) {
  const out = [];
  const walk = (v, depth) => {
    if (typeof v === 'string') { out.push(...maskedSpans(field, v)); return; }
    if (depth >= 16 || v === null || typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return out;
}

/** Candidate rows: a Postgres regex over message / stack / context::text. */
async function loadCandidates(prisma, args) {
  const conds = [`("message" ~ $1 OR "stack" ~ $1 OR "context"::text ~ $1)`];
  const params = [USERINFO_SQL_RE];
  if (args.since) { params.push(new Date(args.since)); conds.push(`"createdAt" >= $${params.length}`); }
  if (args.id) { params.push(`${args.id}%`); conds.push(`"id"::text LIKE $${params.length}`); }
  params.push(args.limit);
  const sql = `SELECT "id", "message", "stack", "context", "createdAt" FROM app_error_logs WHERE ${conds.join(' AND ')} ORDER BY "createdAt" ASC LIMIT $${params.length}`;
  return prisma.$queryRawUnsafe(sql, ...params);
}

async function run({ prisma, argv = [], redact, hasCredentials, now = () => new Date() }) {
  const args = parseArgs(argv);
  if (args.help) return { usage: 'scrub-error-log-credentials.js [--apply] [--show-masked] [--since ISO] [--limit N] [--id prefix]' };
  const startedAt = now().toISOString();
  const result = {
    apply: args.apply, startedAt, showMasked: args.showMasked, since: args.since, limit: args.limit,
    errorLogs: { candidates: 0, rowsWithHits: 0, updated: 0, skippedChanged: 0, hits: [] },
  };
  const rows = await loadCandidates(prisma, args);
  for (const row of rows) {
    result.errorLogs.candidates += 1;
    const data = {};
    const fields = [];
    const masked = [];
    for (const f of ['message', 'stack']) {
      if (typeof row[f] !== 'string' || !row[f] || !hasCredentials(row[f])) continue;
      const next = redact(row[f]);
      if (next === row[f]) continue;
      if (args.showMasked) masked.push(...maskedSpans(f, row[f]));
      data[f] = next;
      fields.push(f);
    }
    if (row.context !== null && row.context !== undefined) {
      const r = redactJsonDeep(row.context, redact, hasCredentials);
      if (r.changed) {
        if (args.showMasked) masked.push(...collectMaskedDeep('context', row.context));
        data.context = r.value;
        fields.push('context');
      }
    }
    if (!fields.length) continue;
    result.errorLogs.rowsWithHits += 1;
    result.errorLogs.hits.push({
      id: row.id,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      fields,
      ...(args.showMasked ? { masked } : {}),
    });
    if (!args.apply) continue;
    const w = await prisma.appErrorLog.updateMany({ where: { id: row.id, message: row.message }, data });
    if (w && w.count === 1) result.errorLogs.updated += 1;
    else result.errorLogs.skippedChanged += 1;
  }
  result.finishedAt = now().toISOString();
  return result;
}

module.exports = { run, parseArgs, maskSpan, maskedSpans, redactJsonDeep, USERINFO_SQL_RE };

if (require.main === module) {
  (async () => {
    let argv;
    try { argv = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(2); }
    if (argv.help) { console.log(JSON.stringify(await run({ prisma: null, argv: ['--help'], redact: (t) => t, hasCredentials: () => false }))); process.exit(0); }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prisma = require('/app/dist/config/database').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redactUrlCredentials, hasUrlCredentials } = require('/app/dist/utils/redact-credentials');
    try {
      const out = await run({ prisma, argv: process.argv.slice(2), redact: redactUrlCredentials, hasCredentials: hasUrlCredentials });
      console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
      process.exit(0);
    } catch (e) {
      console.error(String(e && e.stack ? e.stack : e));
      process.exit(1);
    } finally {
      try { await prisma.$disconnect(); } catch { /* ignore */ }
    }
  })();
}

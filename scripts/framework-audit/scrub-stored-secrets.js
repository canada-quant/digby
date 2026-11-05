#!/usr/bin/env node
/**
 * scrub-stored-secrets.js — ONE-SHOT WRITE (secret-scrubbing audit finding D4,
 * 2026-09-27): rewrite ALREADY-STORED supervisor directives and owner-question
 * answers through the shared credential redaction (secret-scan.ts
 * redactSecrets — the same function the inbound persist paths run today).
 *
 * WHY: a pasted Z.ai `id.secret` key in a lane message (msg 19ebc0c7) rode a
 * get_chat_messages read into supervisor directive 384f859b and PERSISTED —
 * the pattern list had no Z.ai shape when the directive was captured, so the
 * capture-time scrub let it through. The runtime fix (Z.ai + generic
 * assignment shapes; chat-read redaction on machine runs) stops NEW copies;
 * this one-shot cleans the rows that already exist. Nothing else is touched.
 *
 * WHAT IT SCANS (never prints a secret — pattern NAMES and row ids only):
 *   supervisor_states.state  → directives[].text / .evidence, archived[].text / .evidence
 *   store [chatId,'supervisor-archive'] → the COLD archive's closed directives (.text / .evidence;
 *                              review 2026-10-23 — rows older than the newest 20 closed ones live
 *                              here, not in supervisor_states); on --apply each rewritten row's
 *                              'archive <id> …' search-mirror rows (digby_memory + its archive
 *                              table) are deleted too — the app re-mirrors the redacted row
 *   owner_questions.answer   (and .context — lane-authored, re-rendered into wakes)
 *
 * DRY RUN BY DEFAULT (prints the hit list; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh scrub-stored-secrets.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh scrub-stored-secrets.js --apply
 * Options: --chat <id>       only that supervisor chat's state doc
 *          --directive <id>  only that directive id (prefix ok, ≥8 chars) — implies the supervisor scan only
 *          --question <id>   only that owner question (prefix ok)
 *          --no-questions / --no-supervisor   skip a table
 *          --show-masked     (review fix) each hit also lists `masked`: the matched
 *                            substrings as first 3 + `***` + last 2 chars (a value
 *                            under 16 chars is `***` alone) — enough for the owner to tell a
 *                            real key from a false positive BEFORE --apply, never the
 *                            secret. Review the dry run with this flag, then narrow the
 *                            --apply with --directive / --question if a hit looks wrong.
 *
 * WRITE GUARDS: each supervisor_states update is `WHERE chatId = ? AND updatedAt = <the
 * value we read>` (a doc the app rewrote between read and write is left alone and
 * counted under `skippedChanged` — re-run); each cold-archive row update is
 * `WHERE namespacePath = ? AND key = ? AND updatedAt = <read>`; each owner_questions update is
 * `WHERE id = ? AND answer = <the value we read>` (same idea). The rewrite keeps
 * every other field byte-for-byte: only the matched substrings become
 * "[REDACTED: looked like a credential]" (label kept for the assignment shape).
 *
 * NO "previous value" store row, deliberately (review 2026-09-27 asked for the
 * backfill-chat-mode-auto precedent): the previous value IS the credential —
 * copying it into the context store would re-persist the secret in the same
 * database this one-shot exists to clean, one table over, with no expiry. The
 * revert path is the owner: the masked dry run shows what will change, the
 * filters scope the apply, and a wrongly-scrubbed owner directive is retyped
 * (it is the owner's own sentence; the replacement note names where it was).
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. Like
 * backfill-chat-mode-auto.js this file is a deliberate owner-directed exception —
 * every write sits behind `--apply`; without it the script is a read-only probe.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it
 * from /app): `require('/app/dist/config/database')` is the backend's Prisma client
 * and `require('/app/dist/modules/crossmodel/platform/secret-scan')` the shared
 * redaction. Testable offline: `module.exports.run({ prisma, argv, redact })`
 * (backend/src/scripts/scrub-stored-secrets.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

function parseArgs(argv) {
  const out = { apply: false, chat: null, directive: null, question: null, questions: true, supervisor: true, help: false, showMasked: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--show-masked') out.showMasked = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--chat') out.chat = String(argv[++i] || '');
    else if (a.startsWith('--chat=')) out.chat = a.slice('--chat='.length);
    else if (a === '--directive') out.directive = String(argv[++i] || '');
    else if (a.startsWith('--directive=')) out.directive = a.slice('--directive='.length);
    else if (a === '--question') out.question = String(argv[++i] || '');
    else if (a.startsWith('--question=')) out.question = a.slice('--question='.length);
    else if (a === '--no-questions') out.questions = false;
    else if (a === '--no-supervisor') out.supervisor = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.directive) out.questions = false;
  if (out.question) out.supervisor = false;
  for (const k of ['directive', 'question']) {
    if (out[k] !== null && out[k].length < 8) throw new Error(`--${k} needs the full id or a prefix of at least 8 characters`);
  }
  return out;
}

const idMatches = (id, wanted) => !wanted || String(id || '') === wanted || String(id || '').startsWith(wanted);

/** first 3 + `***` + last 2 (< 16 chars ⇒ `***` alone): reviewable, never the secret. */
function maskSpan(value) {
  const v = String(value ?? '');
  // audit 2026-10-06 T2-4: short human passwords (8-15 chars) now redact too — first 3 + last 2 of a
  // 9-char password is most of it, so anything under 16 chars masks fully.
  if (v.length < 16) return '***';
  return `${v.slice(0, 3)}***${v.slice(-2)}`;
}

/** `masked` entries for one field: `<field>: <pattern> <masked>` per span. */
function maskedFor(spans, field, text) {
  if (typeof spans !== 'function') return [];
  try {
    return spans(text).map((s) => `${field}: ${s.name} ${maskSpan(s.value)}`);
  } catch {
    return [];
  }
}

/**
 * Rewrite one supervisor-state doc. Returns { doc, changed, hits[] } where
 * hits = [{ section, id, fields, patterns, masked? }] — never the text itself
 * (`masked` only with opts.spans, the --show-masked reviewer).
 */
function scrubSupervisorDoc(doc, redact, opts = {}) {
  const next = { ...(doc && typeof doc === 'object' ? doc : {}) };
  const hits = [];
  let changed = false;
  for (const section of ['directives', 'archived']) {
    const rows = Array.isArray(next[section]) ? next[section] : null;
    if (!rows) continue;
    next[section] = rows.map((row) => {
      if (!row || typeof row !== 'object') return row;
      if (!idMatches(row.id, opts.directive)) return row;
      const fields = [];
      const patterns = new Set();
      const masked = [];
      const copy = { ...row };
      for (const f of ['text', 'evidence']) {
        if (typeof copy[f] !== 'string' || !copy[f]) continue;
        const r = redact(copy[f]);
        if (r.hits.length && r.text !== copy[f]) {
          masked.push(...maskedFor(opts.spans, f, copy[f]));
          copy[f] = r.text;
          fields.push(f);
          for (const h of r.hits) patterns.add(h);
        }
      }
      if (!fields.length) return row;
      changed = true;
      hits.push({ section, id: row.id ?? null, fields, patterns: Array.from(patterns), ...(opts.spans ? { masked } : {}) });
      return copy;
    });
  }
  return { doc: next, changed, hits };
}

/** The cold archive's context-store namespace kind (supervisor-state.service coldArchiveNamespace / context-store SUPERVISOR_ARCHIVE_STORE_KIND). */
const COLD_ARCHIVE_KIND = 'supervisor-archive';

/**
 * Delete the search-mirror rows of one cold directive — digby_memory and its
 * archive table — by the 'archive <id24> ' ref prefix (starts_with: no LIKE
 * wildcards). Returns rows deleted; a missing archive table counts 0.
 */
async function deleteColdMirrorRows(prisma, chatId, directiveId) {
  if (!prisma || typeof prisma.$executeRawUnsafe !== 'function') return 0;
  const prefix = `archive ${String(directiveId).slice(0, 24)} `;
  let n = 0;
  for (const table of ['digby_memory', 'digby_memory_archive']) {
    try {
      const r = await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE scope_type = 'chat' AND scope_id = $1 AND source = 'supervisor_state' AND starts_with(ref, $2)`, chatId, prefix);
      n += typeof r === 'number' ? r : 0;
    } catch { /* the archive table may not exist on this instance */ }
  }
  return n;
}

async function run({ prisma, argv = [], redact, spans = null, now = () => new Date() }) {
  const args = parseArgs(argv);
  if (args.help) return { usage: 'scrub-stored-secrets.js [--apply] [--show-masked] [--chat id] [--directive id] [--question id] [--no-questions] [--no-supervisor]' };
  const startedAt = now().toISOString();
  // --show-masked needs the span finder; without one the flag is a no-op
  // (reported so the reviewer knows the dry run is names-only).
  const spanFinder = args.showMasked && typeof spans === 'function' ? spans : null;
  const result = {
    apply: args.apply, startedAt, showMasked: !!spanFinder,
    supervisorStates: { scanned: 0, rowsWithHits: 0, updated: 0, skippedChanged: 0, hits: [] },
    coldArchive: { scanned: 0, rowsWithHits: 0, updated: 0, skippedChanged: 0, mirrorRowsDeleted: 0, hits: [] },
    ownerQuestions: { scanned: 0, rowsWithHits: 0, updated: 0, skippedChanged: 0, hits: [] },
  };

  if (args.supervisor) {
    const rows = await prisma.supervisorState.findMany({
      where: args.chat ? { chatId: args.chat } : {},
      select: { chatId: true, state: true, updatedAt: true },
      orderBy: { chatId: 'asc' },
    });
    for (const row of rows) {
      result.supervisorStates.scanned += 1;
      const { doc, changed, hits } = scrubSupervisorDoc(row.state, redact, { directive: args.directive, spans: spanFinder });
      if (!changed) continue;
      result.supervisorStates.rowsWithHits += 1;
      result.supervisorStates.hits.push({ chatId: row.chatId, directives: hits });
      if (!args.apply) continue;
      const w = await prisma.supervisorState.updateMany({ where: { chatId: row.chatId, updatedAt: row.updatedAt }, data: { state: doc } });
      if (w && w.count === 1) result.supervisorStates.updated += 1;
      else result.supervisorStates.skippedChanged += 1;
    }
  }

  // Review 2026-10-23: the supervisor ledger's COLD archive — closed directives
  // older than the newest 20 live in the context store ([chatId,
  // 'supervisor-archive'], one row per directive, up to 180 per chat), not in
  // supervisor_states, and each is mirrored for search as an 'archive <id24> …'
  // row of digby_memory (chat scope, source 'supervisor_state'). Same
  // redaction, same guards; a rewritten row's mirror rows (hot + archived
  // copies) are deleted so recall stops returning the old text — the app's
  // next cold reconcile re-mirrors the redacted row (its content-addressed
  // ref changed).
  if (args.supervisor && prisma && prisma.contextStoreEntry && typeof prisma.contextStoreEntry.findMany === 'function') {
    const where = args.chat ? { namespacePath: `${args.chat}:${COLD_ARCHIVE_KIND}` } : { namespacePath: { endsWith: `:${COLD_ARCHIVE_KIND}` } };
    const rows = await prisma.contextStoreEntry.findMany({
      where,
      select: { namespacePath: true, key: true, value: true, updatedAt: true },
      orderBy: [{ namespacePath: 'asc' }, { key: 'asc' }],
    });
    for (const row of rows) {
      result.coldArchive.scanned += 1;
      const chatId = String(row.namespacePath || '').slice(0, -(COLD_ARCHIVE_KIND.length + 1));
      const { doc, changed, hits } = scrubSupervisorDoc({ archived: [row.value] }, redact, { directive: args.directive, spans: spanFinder });
      if (!changed) continue;
      result.coldArchive.rowsWithHits += 1;
      for (const h of hits) result.coldArchive.hits.push({ chatId, id: h.id, fields: h.fields, patterns: h.patterns, ...(spanFinder ? { masked: h.masked } : {}) });
      if (!args.apply) continue;
      const w = await prisma.contextStoreEntry.updateMany({
        where: { namespacePath: row.namespacePath, key: row.key, updatedAt: row.updatedAt },
        data: { value: doc.archived[0], updatedAt: now() },
      });
      if (!(w && w.count === 1)) { result.coldArchive.skippedChanged += 1; continue; }
      result.coldArchive.updated += 1;
      result.coldArchive.mirrorRowsDeleted += await deleteColdMirrorRows(prisma, chatId, String(row.value && row.value.id ? row.value.id : row.key));
    }
  }

  if (args.questions) {
    const rows = await prisma.ownerQuestion.findMany({
      where: args.question ? { id: { startsWith: args.question } } : {},
      select: { id: true, answer: true, context: true },
      orderBy: { id: 'asc' },
    });
    for (const row of rows) {
      result.ownerQuestions.scanned += 1;
      const data = {};
      const fields = [];
      const patterns = new Set();
      const masked = [];
      for (const f of ['answer', 'context']) {
        if (typeof row[f] !== 'string' || !row[f]) continue;
        const r = redact(row[f]);
        if (r.hits.length && r.text !== row[f]) {
          masked.push(...maskedFor(spanFinder, f, row[f]));
          data[f] = r.text;
          fields.push(f);
          for (const h of r.hits) patterns.add(h);
        }
      }
      if (!fields.length) continue;
      result.ownerQuestions.rowsWithHits += 1;
      result.ownerQuestions.hits.push({ id: row.id, fields, patterns: Array.from(patterns), ...(spanFinder ? { masked } : {}) });
      if (!args.apply) continue;
      const guard = { id: row.id };
      for (const f of fields) guard[f] = row[f];
      const w = await prisma.ownerQuestion.updateMany({ where: guard, data });
      if (w && w.count === 1) result.ownerQuestions.updated += 1;
      else result.ownerQuestions.skippedChanged += 1;
    }
  }

  result.finishedAt = now().toISOString();
  return result;
}

module.exports = { run, parseArgs, scrubSupervisorDoc, maskSpan };

if (require.main === module) {
  (async () => {
    let argv;
    try { argv = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(2); }
    if (argv.help) { console.log(JSON.stringify(await run({ prisma: null, argv: ['--help'], redact: (t) => ({ text: t, hits: [] }) }))); process.exit(0); }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prisma = require('/app/dist/config/database').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redactSecrets, findSecretSpans } = require('/app/dist/modules/crossmodel/platform/secret-scan');
    try {
      const out = await run({ prisma, argv: process.argv.slice(2), redact: redactSecrets, spans: typeof findSecretSpans === 'function' ? findSecretSpans : null });
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

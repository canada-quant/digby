#!/usr/bin/env node
/**
 * scrub-chat-secrets.js — ONE-SHOT WRITE (audit 2026-10-06 T2-4): rewrite the
 * ALREADY-STORED copies of owner-pasted credentials through the shared
 * credential redaction (secret-scan.ts redactSecrets — the function every
 * inbound / outbound / chat-read seam runs today, now including the
 * password / passphrase / plain-English shapes of T2-1).
 *
 * WHY: the 2026-10-06 audit found owner passwords, a 10-word passphrase and a
 * provider key in plaintext across transcripts, supervisor directives, hook
 * wake payloads and run events (schooltime F1, others F4, litellm F4). The
 * runtime fix stops NEW copies (T2-1 shapes, T2-2 outbound scrub, T2-3
 * store_secret); this one-shot cleans the rows that already exist. The older
 * scrubbers stay: scrub-stored-secrets.js (directives / owner answers,
 * account-wide) and redact-owner-question-answer.js (one question + its chat).
 *
 * WHAT IT SCANS (never prints a secret — row ids, field names, pattern NAMES;
 * masked spans only with --show-masked):
 *   crossmodel_messages   content, parts (every string leaf), metadata
 *                         (the ONLY transcript table — MERGE-1 dropped
 *                         coding_messages on 2026-11-04; its rows are mirrored
 *                         here, so one scan covers both histories)
 *   owner_questions       answer, context           (chatId or forChatId in --chat)
 *   supervisor_states     state (every string leaf: directives / archived / notes / …)
 *   store [chatId,'supervisor-archive']  the ledger's COLD archive (closed directives older than
 *                         the newest 20 — review 2026-10-23); --apply also deletes a rewritten
 *                         row's 'archive <id> …' search-mirror rows (the app re-mirrors it redacted)
 *   hook_events           payload (every string leaf) (payload.sourceChatId in --chat, or a hook TARGETING it)
 *   pending_chat_messages content
 *   agent_events          payload — ONLY for runs of the --chat chats (agent_runs.sessionId)
 *
 * SCOPE (one is REQUIRED — a full-table scan of every transcript is never the default):
 *   --chat <id>      repeatable (also --chat=<id>; comma lists ok)
 *   --since <ISO>    createdAt ≥ since (supervisor_states: updatedAt ≥ since)
 * Options: --apply          write (default is a dry run that writes nothing)
 *          --show-masked    each hit lists `masked` spans: first 3 + `***` + last 2
 *                           (< 16 chars ⇒ `***`) — never the secret
 *          --tables a,b     only these tables (keys of the result: crossmodelMessages,
 *                           codingMessages, ownerQuestions, supervisorStates, supervisorColdArchive, hookEvents,
 *                           pendingChatMessages, agentEvents)
 *          --batch <n>      page size (default 500)
 *
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh scrub-chat-secrets.js --chat <id> --show-masked
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh scrub-chat-secrets.js --chat <id> --apply
 *
 * WRITE GUARDS (a row the app rewrote between read and write is left alone and
 * counted under `skippedChanged` — re-run): messages / hook events / supervisor
 * states `WHERE id = ? AND updatedAt = <read value>`; owner questions and
 * pending messages `WHERE id = ? AND <field> = <read value>`; agent events are
 * append-only (never updated by the app) — `WHERE id = ? AND type = <read>`.
 * Only matched substrings change ("[REDACTED: looked like a credential]",
 * label kept); every other field and JSON key survives byte-for-byte.
 *
 * NO "previous value" store row (same rule as scrub-stored-secrets.js): the
 * previous value IS the credential. The owner rotates it.
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. Like the other
 * one-shots this is a deliberate owner-directed exception — every write sits
 * behind `--apply`; without it the script is a read-only probe.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs
 * it from /app): `require('/app/dist/config/database')` is the backend's
 * Prisma client and `require('/app/dist/modules/crossmodel/platform/secret-scan')`
 * the shared redaction. Testable offline: `module.exports.run({ prisma, argv,
 * redact, spans })` (backend/src/scripts/scrub-chat-secrets.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const TABLES = ['crossmodelMessages', 'ownerQuestions', 'supervisorStates', 'supervisorColdArchive', 'hookEvents', 'pendingChatMessages', 'agentEvents'];
/** Hit rows listed per table (counts are always exact). */
const MAX_LISTED_HITS = 500;

function parseArgs(argv) {
  const out = { apply: false, chats: [], since: null, showMasked: false, tables: TABLES.slice(), batch: 500, help: false };
  const addChats = (v) => { for (const c of String(v || '').split(',').map((s) => s.trim()).filter(Boolean)) out.chats.push(c); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--show-masked') out.showMasked = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--chat') addChats(argv[++i]);
    else if (a.startsWith('--chat=')) addChats(a.slice('--chat='.length));
    else if (a === '--since') out.since = String(argv[++i] || '');
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a === '--tables') out.tables = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--tables=')) out.tables = a.slice('--tables='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--batch') out.batch = Number(argv[++i]);
    else if (a.startsWith('--batch=')) out.batch = Number(a.slice('--batch='.length));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.help) return out;
  out.chats = Array.from(new Set(out.chats));
  for (const c of out.chats) if (c.length < 8) throw new Error(`--chat needs a full chat id (got "${c}")`);
  if (out.since !== null) {
    const d = new Date(out.since);
    if (!out.since || Number.isNaN(d.getTime())) throw new Error(`--since needs an ISO date/time (got "${out.since}")`);
    out.since = d;
  }
  if (!out.chats.length && !out.since) throw new Error('pass --chat <id> (repeatable) and/or --since <ISO> — a full-table scan is never the default');
  for (const t of out.tables) if (!TABLES.includes(t)) throw new Error(`unknown table "${t}" (known: ${TABLES.join(', ')})`);
  if (!Number.isInteger(out.batch) || out.batch < 1 || out.batch > 5000) throw new Error('--batch must be an integer 1-5000');
  return out;
}

/** first 3 + `***` + last 2 (< 16 chars ⇒ `***` alone): reviewable, never the secret. */
function maskSpan(value) {
  const v = String(value ?? '');
  // audit 2026-10-06 T2-4: short human passwords (8-15 chars) now redact too — first 3 + last 2 of a
  // 9-char password is most of it, so anything under 16 chars masks fully.
  if (v.length < 16) return '***';
  return `${v.slice(0, 3)}***${v.slice(-2)}`;
}

/**
 * Redact one string. Returns { text, changed, hits[], masked[] } — masked only
 * when a span finder is given (`<field>: <pattern> <masked>`).
 */
function scrubString(value, redact, spans, field) {
  const r = redact(value);
  if (!r || !r.hits || !r.hits.length || r.text === value) return { text: value, changed: false, hits: [], masked: [] };
  let masked = [];
  if (typeof spans === 'function') {
    try { masked = spans(value).map((s) => `${field}: ${s.name} ${maskSpan(s.value)}`); } catch { masked = []; }
  }
  return { text: r.text, changed: true, hits: r.hits, masked };
}

/**
 * Redact every string leaf of a JSON value (plain objects / arrays, depth ≤ 24).
 * Returns { value, changed, hits[], masked[], keys[] } — `keys` are the
 * top-level keys whose subtree changed (for the report). Input not mutated.
 */
function scrubJsonDeep(value, redact, spans, field) {
  const hits = new Set();
  const masked = [];
  const keys = new Set();
  let changed = false;
  const walk = (v, depth, topKey) => {
    if (typeof v === 'string') {
      const r = scrubString(v, redact, spans, topKey ? `${field}.${topKey}` : field);
      if (!r.changed) return v;
      changed = true;
      for (const h of r.hits) hits.add(h);
      masked.push(...r.masked);
      if (topKey) keys.add(topKey);
      return r.text;
    }
    if (depth >= 24 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, topKey));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, depth + 1, depth === 0 ? k : topKey);
    return o;
  };
  const next = walk(value, 0, null);
  return { value: changed ? next : value, changed, hits: Array.from(hits), masked, keys: Array.from(keys) };
}

function emptyTable() {
  return { scanned: 0, rowsWithHits: 0, updated: 0, skippedChanged: 0, hits: [], hitsTruncated: 0 };
}

function pushHit(t, hit) {
  t.rowsWithHits += 1;
  if (t.hits.length < MAX_LISTED_HITS) t.hits.push(hit);
  else t.hitsTruncated += 1;
}

/** Page through a model by ascending id (string uuid or BigInt), `where` ANDed with id > last. */
async function* pages(model, where, select, batch) {
  let last = null;
  for (;;) {
    const rows = await model.findMany({
      where: last === null ? where : { AND: [where, { id: { gt: last } }] },
      select,
      orderBy: { id: 'asc' },
      take: batch,
    });
    if (!rows || !rows.length) return;
    yield rows;
    last = rows[rows.length - 1].id;
    if (rows.length < batch) return;
  }
}

async function run({ prisma, argv = [], redact, spans = null, now = () => new Date() }) {
  const args = parseArgs(argv);
  if (args.help) return { usage: 'scrub-chat-secrets.js (--chat <id> … | --since <ISO>) [--apply] [--show-masked] [--tables a,b] [--batch n]' };
  const startedAt = now().toISOString();
  const spanFinder = args.showMasked && typeof spans === 'function' ? spans : null;
  const want = new Set(args.tables);
  const chats = args.chats;
  const since = args.since;
  const created = since ? { createdAt: { gte: since } } : {};
  const result = {
    apply: args.apply, startedAt, showMasked: !!spanFinder,
    filters: { chats, since: since ? since.toISOString() : null, tables: args.tables },
  };
  for (const t of TABLES) if (want.has(t)) result[t] = emptyTable();

  // ── transcripts: crossmodel_messages (the ONLY transcript table since MERGE-1) ──
  for (const [key, model] of [['crossmodelMessages', prisma.crossModelMessage]]) {
    if (!want.has(key)) continue;
    const t = result[key];
    const where = { ...(chats.length ? { chatId: { in: chats } } : {}), ...created };
    for await (const rows of pages(model, where, { id: true, chatId: true, content: true, parts: true, metadata: true, updatedAt: true }, args.batch)) {
      for (const row of rows) {
        t.scanned += 1;
        const data = {};
        const fields = [];
        const patterns = new Set();
        const masked = [];
        if (typeof row.content === 'string' && row.content) {
          const r = scrubString(row.content, redact, spanFinder, 'content');
          if (r.changed) { data.content = r.text; fields.push('content'); r.hits.forEach((h) => patterns.add(h)); masked.push(...r.masked); }
        }
        for (const f of ['parts', 'metadata']) {
          if (row[f] === null || row[f] === undefined) continue;
          const r = scrubJsonDeep(row[f], redact, spanFinder, f);
          if (r.changed) { data[f] = r.value; fields.push(f); r.hits.forEach((h) => patterns.add(h)); masked.push(...r.masked); }
        }
        if (!fields.length) continue;
        pushHit(t, { id: row.id, chatId: row.chatId, fields, patterns: Array.from(patterns), ...(spanFinder ? { masked } : {}) });
        if (!args.apply) continue;
        const w = await model.updateMany({ where: { id: row.id, updatedAt: row.updatedAt ?? null }, data });
        if (w && w.count === 1) t.updated += 1; else t.skippedChanged += 1;
      }
    }
  }

  // ── owner_questions ────────────────────────────────────────────────────────
  if (want.has('ownerQuestions')) {
    const t = result.ownerQuestions;
    const where = { ...(chats.length ? { OR: [{ chatId: { in: chats } }, { forChatId: { in: chats } }] } : {}), ...created };
    for await (const rows of pages(prisma.ownerQuestion, where, { id: true, chatId: true, answer: true, context: true }, args.batch)) {
      for (const row of rows) {
        t.scanned += 1;
        const data = {};
        const fields = [];
        const patterns = new Set();
        const masked = [];
        for (const f of ['answer', 'context']) {
          if (typeof row[f] !== 'string' || !row[f]) continue;
          const r = scrubString(row[f], redact, spanFinder, f);
          if (r.changed) { data[f] = r.text; fields.push(f); r.hits.forEach((h) => patterns.add(h)); masked.push(...r.masked); }
        }
        if (!fields.length) continue;
        pushHit(t, { id: row.id, chatId: row.chatId, fields, patterns: Array.from(patterns), ...(spanFinder ? { masked } : {}) });
        if (!args.apply) continue;
        const guard = { id: row.id };
        for (const f of fields) guard[f] = row[f];
        const w = await prisma.ownerQuestion.updateMany({ where: guard, data });
        if (w && w.count === 1) t.updated += 1; else t.skippedChanged += 1;
      }
    }
  }

  // ── supervisor_states (one doc per supervisor chat) ────────────────────────
  if (want.has('supervisorStates')) {
    const t = result.supervisorStates;
    const where = { ...(chats.length ? { chatId: { in: chats } } : {}), ...(since ? { updatedAt: { gte: since } } : {}) };
    for await (const rows of pages(prisma.supervisorState, where, { id: true, chatId: true, state: true, updatedAt: true }, args.batch)) {
      for (const row of rows) {
        t.scanned += 1;
        const r = scrubJsonDeep(row.state, redact, spanFinder, 'state');
        if (!r.changed) continue;
        pushHit(t, { id: row.id, chatId: row.chatId, fields: r.keys.length ? r.keys.map((k) => `state.${k}`) : ['state'], patterns: r.hits, ...(spanFinder ? { masked: r.masked } : {}) });
        if (!args.apply) continue;
        const w = await prisma.supervisorState.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { state: r.value } });
        if (w && w.count === 1) t.updated += 1; else t.skippedChanged += 1;
      }
    }
  }

  // ── the supervisor ledger's COLD archive (review 2026-10-23) ───────────────
  // Closed directives older than the newest 20 live in the context store
  // ([chatId,'supervisor-archive'], one row per directive), NOT in
  // supervisor_states — the scan above never reached them — and each is
  // mirrored for search as an 'archive <id24> …' digby_memory row. A
  // rewritten row's mirror rows are deleted; the app re-mirrors the redacted row.
  if (want.has('supervisorColdArchive')) {
    const t = result.supervisorColdArchive;
    t.mirrorRowsDeleted = 0;
    if (!prisma.contextStoreEntry || typeof prisma.contextStoreEntry.findMany !== 'function') {
      t.skipped = 'no context-store client';
    } else {
      const kind = 'supervisor-archive';
      const where = chats.length
        ? { namespacePath: { in: chats.map((c) => `${c}:${kind}`) } }
        : { namespacePath: { endsWith: `:${kind}` }, ...(since ? { updatedAt: { gte: since } } : {}) };
      const rows = await prisma.contextStoreEntry.findMany({ where, select: { namespacePath: true, key: true, value: true, updatedAt: true }, orderBy: [{ namespacePath: 'asc' }, { key: 'asc' }] });
      for (const row of rows || []) {
        t.scanned += 1;
        const r = scrubJsonDeep(row.value, redact, spanFinder, 'value');
        if (!r.changed) continue;
        const chatId = String(row.namespacePath || '').slice(0, -(kind.length + 1));
        pushHit(t, { chatId, key: row.key, fields: r.keys.length ? r.keys.map((k) => `value.${k}`) : ['value'], patterns: r.hits, ...(spanFinder ? { masked: r.masked } : {}) });
        if (!args.apply) continue;
        const w = await prisma.contextStoreEntry.updateMany({ where: { namespacePath: row.namespacePath, key: row.key, updatedAt: row.updatedAt }, data: { value: r.value, updatedAt: now() } });
        if (!(w && w.count === 1)) { t.skippedChanged += 1; continue; }
        t.updated += 1;
        const prefix = `archive ${String((row.value && row.value.id) || row.key).slice(0, 24)} `;
        for (const table of ['digby_memory', 'digby_memory_archive']) {
          try {
            const n = await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE scope_type = 'chat' AND scope_id = $1 AND source = 'supervisor_state' AND starts_with(ref, $2)`, chatId, prefix);
            t.mirrorRowsDeleted += typeof n === 'number' ? n : 0;
          } catch { /* the archive table may not exist on this instance */ }
        }
      }
    }
  }

  // ── hook_events (wake payloads carry the source's final-answer summary) ────
  if (want.has('hookEvents')) {
    const t = result.hookEvents;
    let where = { ...created };
    if (chats.length) {
      const hooks = await prisma.eventHook.findMany({ where: { targetChatId: { in: chats } }, select: { id: true } });
      const hookIds = (hooks || []).map((h) => h.id);
      where = {
        ...created,
        OR: [
          ...(hookIds.length ? [{ hookId: { in: hookIds } }] : []),
          ...chats.map((c) => ({ payload: { path: ['sourceChatId'], equals: c } })),
        ],
      };
    }
    for await (const rows of pages(prisma.hookEvent, where, { id: true, hookId: true, payload: true, updatedAt: true }, args.batch)) {
      for (const row of rows) {
        t.scanned += 1;
        const r = scrubJsonDeep(row.payload, redact, spanFinder, 'payload');
        if (!r.changed) continue;
        pushHit(t, { id: row.id, hookId: row.hookId, fields: r.keys.length ? r.keys.map((k) => `payload.${k}`) : ['payload'], patterns: r.hits, ...(spanFinder ? { masked: r.masked } : {}) });
        if (!args.apply) continue;
        const w = await prisma.hookEvent.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { payload: r.value } });
        if (w && w.count === 1) t.updated += 1; else t.skippedChanged += 1;
      }
    }
  }

  // ── pending_chat_messages (the busy-chat queue) ────────────────────────────
  if (want.has('pendingChatMessages')) {
    const t = result.pendingChatMessages;
    const where = { ...(chats.length ? { chatId: { in: chats } } : {}), ...created };
    for await (const rows of pages(prisma.pendingChatMessage, where, { id: true, chatId: true, content: true }, args.batch)) {
      for (const row of rows) {
        t.scanned += 1;
        if (typeof row.content !== 'string' || !row.content) continue;
        const r = scrubString(row.content, redact, spanFinder, 'content');
        if (!r.changed) continue;
        pushHit(t, { id: row.id, chatId: row.chatId, fields: ['content'], patterns: r.hits, ...(spanFinder ? { masked: r.masked } : {}) });
        if (!args.apply) continue;
        const w = await prisma.pendingChatMessage.updateMany({ where: { id: row.id, content: row.content }, data: { content: r.text } });
        if (w && w.count === 1) t.updated += 1; else t.skippedChanged += 1;
      }
    }
  }

  // ── agent_events of the --chat chats' runs (tool_call args, complete events) ─
  if (want.has('agentEvents')) {
    const t = result.agentEvents;
    if (!chats.length) {
      t.skipped = 'needs --chat (agent events are scanned only for the named chats\' runs)';
    } else {
      const runs = await prisma.agentRun.findMany({ where: { sessionId: { in: chats } }, select: { id: true, sessionId: true } });
      const runIds = (runs || []).map((r) => r.id);
      t.runs = runIds.length;
      if (runIds.length) {
        const where = { runId: { in: runIds }, ...created };
        for await (const rows of pages(prisma.agentEvent, where, { id: true, runId: true, seq: true, type: true, payload: true }, args.batch)) {
          for (const row of rows) {
            t.scanned += 1;
            const r = scrubJsonDeep(row.payload, redact, spanFinder, 'payload');
            if (!r.changed) continue;
            pushHit(t, { id: String(row.id), runId: row.runId, seq: row.seq, type: row.type, fields: r.keys.length ? r.keys.map((k) => `payload.${k}`) : ['payload'], patterns: r.hits, ...(spanFinder ? { masked: r.masked } : {}) });
            if (!args.apply) continue;
            const w = await prisma.agentEvent.updateMany({ where: { id: row.id, type: row.type }, data: { payload: r.value } });
            if (w && w.count === 1) t.updated += 1; else t.skippedChanged += 1;
          }
        }
      }
    }
  }

  result.finishedAt = now().toISOString();
  return result;
}

module.exports = { run, parseArgs, maskSpan, scrubString, scrubJsonDeep, TABLES };

if (require.main === module) {
  (async () => {
    let parsed;
    try { parsed = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(2); }
    if (parsed.help) { console.log(JSON.stringify(await run({ prisma: null, argv: ['--help'], redact: (x) => ({ text: x, hits: [] }) }))); process.exit(0); }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prisma = require('/app/dist/config/database').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redactSecrets, findSecretSpans } = require('/app/dist/modules/crossmodel/platform/secret-scan');
    try {
      const out = await run({ prisma, argv: process.argv.slice(2), redact: redactSecrets, spans: typeof findSecretSpans === 'function' ? findSecretSpans : null });
      // Flush before exit: console.log + process.exit cut a piped report at 64 KB (2026-10-06 first run).
      process.stdout.write(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 1) + '\n', () => process.exit(0));
    } catch (e) {
      console.error(String(e && e.stack ? e.stack : e));
      process.exit(1);
    } finally {
      try { await prisma.$disconnect(); } catch { /* ignore */ }
    }
  })();
}

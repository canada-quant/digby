#!/usr/bin/env node
/**
 * redact-owner-question-answer.js — ONE-SHOT WRITE (backlog audit T6,
 * 2026-09-28): scrub ONE owner question's stored answer (+ context) — and,
 * with --chat-messages, the transcript rows of the chat the question was
 * filed from — through the shared credential redaction (secret-scan.ts
 * redactSecrets, the function the inbound persist paths run today).
 *
 * WHY: an owner pasted a Gmail app password into an owner_questions answer.
 * The capture-time scrub ran, but the pattern set had no app-password shape,
 * so the value persisted in the row AND rode the wake into the lane's
 * transcript (4 user/assistant rows). The runtime fix (the context-gated
 * app-password shape in secret-scan.ts) stops NEW copies; this one-shot
 * cleans the rows that already exist. The general scrub
 * (scrub-stored-secrets.js) walks every row but never touches transcripts —
 * this one is question-scoped on purpose so the apply is small and reviewable.
 *
 * WHAT IT SCANS (never prints a secret — pattern NAMES, row ids, masked spans only):
 *   owner_questions.answer / .context            for --question <id>
 *   crossmodel_messages.content / .parts (string leaves)  for that question's chatId  (--chat-messages)
 *
 * DRY RUN BY DEFAULT (prints the hit list; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh redact-owner-question-answer.js --question oq_8cce9d18
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh redact-owner-question-answer.js --question oq_8cce9d18 --chat-messages
 *   … --apply   writes (guarded: WHERE id = ? AND <field> = <the value we read>; a row that
 *               moved between read and write is counted under `skippedChanged` — re-run)
 * Options: --question <id>   REQUIRED (full id or a prefix of ≥ 8 chars; must resolve to exactly one row)
 *          --chat-messages   also scan/rewrite the chat's crossmodel_messages rows
 *          --show-masked     each hit lists the matched spans as first 3 + `***` + last 2
 *                            (< 16 chars ⇒ `***`) — enough to tell a real credential from a
 *                            false positive BEFORE --apply, never the secret
 *
 * NO "previous value" store row, deliberately (same rule as scrub-stored-secrets.js):
 * the previous value IS the credential. The owner rotates it; the note text the
 * rewrite leaves behind names where it was.
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. Like the other
 * one-shots this is a deliberate owner-directed exception — every write sits
 * behind `--apply`; without it the script is a read-only probe.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it
 * from /app). Testable offline: `module.exports.run({ prisma, argv, redact, spans })`
 * (backend/src/scripts/redact-owner-question-answer.test.ts).
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

function parseArgs(argv) {
  const out = { apply: false, question: null, chatMessages: false, showMasked: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--chat-messages') out.chatMessages = true;
    else if (a === '--show-masked') out.showMasked = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--question') out.question = String(argv[++i] || '');
    else if (a.startsWith('--question=')) out.question = a.slice('--question='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.help) {
    if (!out.question) throw new Error('--question <id> is required');
    if (out.question.length < 8) throw new Error('--question needs the full id or a prefix of at least 8 characters');
  }
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

function maskedFor(spans, field, text) {
  if (typeof spans !== 'function') return [];
  try {
    return spans(text).map((s) => `${field}: ${s.name} ${maskSpan(s.value)}`);
  } catch {
    return [];
  }
}

/**
 * Redact every string leaf of a JSON value (plain objects / arrays, depth ≤ 16).
 * Returns { value, changed, hits[] }; the input is not mutated.
 */
function redactJsonDeep(value, redact) {
  const hits = new Set();
  let changed = false;
  const walk = (v, depth) => {
    if (typeof v === 'string') {
      const r = redact(v);
      if (r.hits.length && r.text !== v) { changed = true; for (const h of r.hits) hits.add(h); return r.text; }
      return v;
    }
    if (depth >= 16 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, depth + 1);
    return o;
  };
  const next = walk(value, 0);
  return { value: changed ? next : value, changed, hits: Array.from(hits) };
}

function collectSpansDeep(spans, field, value) {
  if (typeof spans !== 'function') return [];
  const out = [];
  const walk = (v, depth) => {
    if (typeof v === 'string') { out.push(...maskedFor(spans, field, v)); return; }
    if (depth >= 16 || v === null || typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return out;
}

async function run({ prisma, argv = [], redact, spans = null, now = () => new Date() }) {
  const args = parseArgs(argv);
  if (args.help) return { usage: 'redact-owner-question-answer.js --question <id> [--apply] [--chat-messages] [--show-masked]' };
  const startedAt = now().toISOString();
  const spanFinder = args.showMasked && typeof spans === 'function' ? spans : null;
  const result = {
    apply: args.apply, startedAt, showMasked: !!spanFinder, question: null,
    ownerQuestion: { found: 0, fields: [], patterns: [], masked: undefined, updated: 0, skippedChanged: 0 },
    chatMessages: { scanned: 0, rowsWithHits: 0, updated: 0, skippedChanged: 0, hits: [] },
  };
  if (!spanFinder) delete result.ownerQuestion.masked;

  const rows = await prisma.ownerQuestion.findMany({
    where: { id: { startsWith: args.question } },
    select: { id: true, chatId: true, answer: true, context: true },
  });
  if (rows.length !== 1) {
    throw new Error(`--question ${args.question} resolves to ${rows.length} rows (need exactly 1)`);
  }
  const row = rows[0];
  result.question = row.id;
  result.ownerQuestion.found = 1;
  {
    const data = {};
    const patterns = new Set();
    const masked = [];
    for (const f of ['answer', 'context']) {
      if (typeof row[f] !== 'string' || !row[f]) continue;
      const r = redact(row[f]);
      if (r.hits.length && r.text !== row[f]) {
        masked.push(...maskedFor(spanFinder, f, row[f]));
        data[f] = r.text;
        result.ownerQuestion.fields.push(f);
        for (const h of r.hits) patterns.add(h);
      }
    }
    result.ownerQuestion.patterns = Array.from(patterns);
    if (spanFinder) result.ownerQuestion.masked = masked;
    if (result.ownerQuestion.fields.length && args.apply) {
      const guard = { id: row.id };
      for (const f of result.ownerQuestion.fields) guard[f] = row[f];
      const w = await prisma.ownerQuestion.updateMany({ where: guard, data });
      if (w && w.count === 1) result.ownerQuestion.updated += 1;
      else result.ownerQuestion.skippedChanged += 1;
    }
  }

  if (args.chatMessages && row.chatId) {
    const msgs = await prisma.crossModelMessage.findMany({
      where: { chatId: row.chatId },
      select: { id: true, role: true, content: true, parts: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const m of msgs) {
      result.chatMessages.scanned += 1;
      const data = {};
      const fields = [];
      const patterns = new Set();
      const masked = [];
      if (typeof m.content === 'string' && m.content) {
        const r = redact(m.content);
        if (r.hits.length && r.text !== m.content) {
          masked.push(...maskedFor(spanFinder, 'content', m.content));
          data.content = r.text;
          fields.push('content');
          for (const h of r.hits) patterns.add(h);
        }
      }
      if (m.parts !== null && m.parts !== undefined) {
        const r = redactJsonDeep(m.parts, redact);
        if (r.changed) {
          masked.push(...collectSpansDeep(spanFinder, 'parts', m.parts));
          data.parts = r.value;
          fields.push('parts');
          for (const h of r.hits) patterns.add(h);
        }
      }
      if (!fields.length) continue;
      result.chatMessages.rowsWithHits += 1;
      result.chatMessages.hits.push({ id: m.id, role: m.role, fields, patterns: Array.from(patterns), ...(spanFinder ? { masked } : {}) });
      if (!args.apply) continue;
      // Guard on the CONTENT we read (parts is JSON — Prisma cannot equality-filter it
      // portably, so a parts-only hit is guarded by content alone; the rewrite of
      // parts is idempotent — a re-run finds nothing left to redact).
      const guard = { id: m.id, ...(typeof m.content === 'string' ? { content: m.content } : {}) };
      const w = await prisma.crossModelMessage.updateMany({ where: guard, data });
      if (w && w.count === 1) result.chatMessages.updated += 1;
      else result.chatMessages.skippedChanged += 1;
    }
  }

  result.finishedAt = now().toISOString();
  return result;
}

module.exports = { run, parseArgs, maskSpan, redactJsonDeep };

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

// verify-568d3652-journal-metrics.js — third witness pass for ticket 568d3652:
// (1) run_journal_entries for the sweep chat around the 22:45:49Z breaker trip;
// (2) loop_metrics rows in the window (breaker kind?) with meta;
// (3) the 22:42Z wake message CONTENT (not just parts);
// (4) all messages in the chat 22:35–23:59 to see what persisted of the sweep turn.
const prisma = require('/app/dist/config/database').default;

(async () => {
  const CHAT = 'c0e22e36-1c74-4295-8049-9b48335c6c37';
  const jr = await prisma.runJournalEntry.findMany({
    where: { chatId: CHAT, createdAt: { gte: new Date('2026-09-30T22:30:00Z'), lte: new Date('2026-10-01T00:00:00Z') } },
    orderBy: { createdAt: 'asc' },
  }).catch((e) => { console.log('JR_FAIL', e.message); return []; });
  console.log('JOURNAL_ROWS', jr.length);
  for (const j of jr) console.log('JR', JSON.stringify({ id: j.id, runId: j.runId, trigger: j.triggerKind, goal: j.goal, outcome: j.outcome, failures: j.failures, observations: j.observations, at: j.createdAt }));

  const msgs = await prisma.crossModelMessage.findMany({
    where: { chatId: CHAT, createdAt: { gte: new Date('2026-09-30T22:35:00Z'), lte: new Date('2026-09-30T23:59:00Z') } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, createdAt: true, content: true, parts: true },
  }).catch((e) => { console.log('MSG_FAIL', e.message); return []; });
  console.log('MSGS', msgs.length);
  for (const m of msgs) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const p = m.parts ? JSON.stringify(m.parts) : '';
    console.log('MSG', m.id.slice(0, 8), m.role, m.createdAt, 'content_len', (c || '').length, 'parts_len', p.length);
    if ((c || '').length) console.log('  CONTENT_SNIP', (c || '').slice(0, 1500));
    if (p.length > 2) {
      const hits = (p.match(/get_run_receipts/g) || []).length;
      console.log('  PARTS_grr_hits', hits);
      if (hits) { let i = -1; while ((i = p.indexOf('get_run_receipts', i + 1)) !== -1) console.log('  PARTS_SNIP', p.slice(Math.max(0, i - 300), i + 500)); }
      else console.log('  PARTS_SNIP', p.slice(0, 1200));
    }
  }

  // loop_metrics in window: find the breaker rows and their meta
  const lm = await prisma.$queryRaw`
    SELECT id, kind, chat_id, created_at, meta FROM loop_metrics
    WHERE created_at BETWEEN '2026-09-30T22:40:00Z' AND '2026-09-30T23:00:00Z'
    ORDER BY created_at ASC LIMIT 40
  `.catch((e) => { console.log('LM_FAIL', e.message); return []; });
  console.log('LOOP_METRICS', lm.length);
  for (const r of lm) console.log('LM', JSON.stringify({ id: String(r.id), kind: r.kind, chat: r.chat_id, at: r.created_at, meta: r.meta ? JSON.stringify(r.meta).slice(0, 900) : null }));

  // breaker table? check what exists for tool streaks
  const ev = await prisma.$queryRaw`
    SELECT id, level, message, created_at FROM app_error_logs
    WHERE created_at BETWEEN '2026-09-30T22:40:00Z' AND '2026-09-30T23:00:00Z'
      AND (message ILIKE '%get_run_receipts%' OR message ILIKE '%streak%')
    ORDER BY created_at ASC LIMIT 20
  `.catch((e) => { console.log('EV_FAIL', e.message); return []; });
  console.log('ERR_ROWS', ev.length);
  for (const r of ev) console.log('ERR', JSON.stringify({ id: String(r.id), level: r.level, msg: (r.message || '').slice(0, 600), at: r.created_at }));
})().catch((e) => { console.error('PROBE_FAIL', e && e.message); process.exit(1); });

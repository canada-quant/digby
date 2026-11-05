// verify-568d3652-grr-receipts.js — find the ACTUAL failing get_run_receipts calls via
// run_tool_receipts in the breaker window (ticket 568d3652), map to their runs/sessions,
// then adjudicate the chatId args. READ-ONLY.
const prisma = require('/app/dist/config/database').default;

(async () => {
  const receipts = await prisma.runToolReceipt.findMany({
    where: {
      tool: 'get_run_receipts',
      createdAt: { gte: new Date('2026-09-30T22:30:00Z'), lte: new Date('2026-09-30T23:10:00Z') },
    },
    orderBy: { createdAt: 'asc' },
  }).catch((e) => { console.log('RECEIPTS_Q_FAIL', e.message); return []; });
  console.log('RECEIPTS_COUNT', receipts.length);
  for (const r of receipts) {
    console.log('RCPT', JSON.stringify({ id: r.id, runId: r.runId, ok: r.ok, tool: r.tool, ids: r.ids, createdAt: r.createdAt, error: r.error, inputHash: (r.inputHash || '').slice(0, 16) }));
  }

  const runIds = [...new Set(receipts.map((r) => r.runId).filter(Boolean))];
  for (const rid of runIds) {
    const run = await prisma.agentRun.findUnique({ where: { id: rid }, select: { id: true, sessionId: true, status: true, createdAt: true, startedAt: true, finishedAt: true } }).catch(() => null);
    console.log('RUN', JSON.stringify(run));
    if (!run) continue;
    const chat = run.sessionId ? await prisma.crossModelChat.findUnique({ where: { id: run.sessionId }, select: { id: true, title: true, userId: true } }).catch(() => null) : null;
    console.log('RUN_CHAT', JSON.stringify(chat));
    const evs = await prisma.agentEvent.findMany({
      where: { runId: rid },
      orderBy: { seq: 'asc' },
      select: { seq: true, type: true, createdAt: true, payload: true },
    }).catch(() => []);
    const types = {};
    for (const e of evs) types[e.type] = (types[e.type] || 0) + 1;
    console.log('RUN_EVENTS_TYPES', rid, JSON.stringify(types));
    for (const e of evs) {
      const s = JSON.stringify(e.payload || {});
      if (s.includes('get_run_receipts')) {
        const i = s.indexOf('get_run_receipts');
        console.log('GRR_EV', rid, 'seq', e.seq, 'type', e.type, 'SNIP', s.slice(Math.max(0, i - 200), i + 500));
      }
    }
  }

  // What did the caller actually pass? agent_events tool_call payloads carry args.
  // Fallback: the receipts' inputHash is a hash — args live in events; if events were
  // trimmed, read the sweep chat messages around the window for tool-call parts.
  const sweepChat = 'c0e22e36-1c74-4295-8049-9b48335c6c37';
  const msgs = await prisma.crossModelMessage.findMany({
    where: { chatId: sweepChat, createdAt: { gte: new Date('2026-09-30T22:30:00Z'), lte: new Date('2026-09-30T22:50:00Z') } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, createdAt: true, parts: true },
  }).catch(() => []);
  console.log('SWEEP_MSGS_IN_WINDOW', msgs.length);
  for (const m of msgs) {
    const s = JSON.stringify(m.parts || {});
    const hits = (s.match(/get_run_receipts/g) || []).length;
    console.log('MSG', m.id.slice(0, 8), m.role, m.createdAt, 'len', s.length, 'grr_hits', hits);
    if (hits) {
      let i = -1;
      while ((i = s.indexOf('get_run_receipts', i + 1)) !== -1) {
        console.log('  SNIP', s.slice(Math.max(0, i - 250), i + 400));
      }
    }
  }
})().catch((e) => { console.error('PROBE_FAIL', e && e.message); process.exit(1); });

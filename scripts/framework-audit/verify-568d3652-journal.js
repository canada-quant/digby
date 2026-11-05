// verify-568d3652-journal.js — the sweep run's journal (run_journal_entries may outlive
// agent_runs) + retention check. READ-ONLY. Ticket 568d3652.
const prisma = require('/app/dist/config/database').default;
const SESSION = 'c0e22e36-1c74-4295-8049-9b48335c6c37';

(async () => {
  // 1) Any agent_runs rows at all for this session (any time)?
  const all = await prisma.agentRun.findMany({
    where: { sessionId: SESSION },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdAt: true, startedAt: true, finishedAt: true, error: true },
    take: 10,
  });
  console.log('RUNS_ANY_TIME', all.length);
  for (const r of all) console.log('RUN', JSON.stringify({ id: r.id, status: r.status, createdAt: r.createdAt, err: (r.error || '').slice(0, 120) }));

  // 2) Journal entries for this chat around the breaker window.
  const jr = await prisma.runJournalEntry.findMany({
    where: { chatId: SESSION, createdAt: { gte: new Date('2026-09-30T21:30:00Z'), lte: new Date('2026-10-01T01:00:00Z') } },
    orderBy: { createdAt: 'asc' },
  });
  console.log('JOURNAL_ROWS', jr.length);
  for (const j of jr) {
    console.log('JR', JSON.stringify({
      id: j.id, runId: j.runId, trigger: j.triggerKind, at: j.createdAt,
      goal: (j.goal || '').slice(0, 160),
      outcome: (j.outcome || '').slice(0, 400),
      failures: (j.failures || []).slice(0, 6),
      obs: (j.observations || '').slice(0, 300),
    }));
  }

  // 3) The exact failure string anywhere in this chat's journals (any time).
  const allj = await prisma.runJournalEntry.findMany({
    where: { chatId: SESSION },
    orderBy: { createdAt: 'desc' },
    select: { id: true, runId: true, createdAt: true, failures: true, outcome: true, goal: true },
    take: 200,
  });
  let hits = 0;
  for (const j of allj) {
    const s = JSON.stringify(j);
    if (s.includes('No chat you can read matches') || s.includes('get_run_receipts')) {
      hits++;
      const i = s.indexOf('No chat you can read matches') >= 0 ? s.indexOf('No chat you can read matches') : s.indexOf('get_run_receipts');
      console.log('NEEDLE_HIT', j.id, j.createdAt, 'RUN', j.runId, 'SNIP', s.slice(Math.max(0, i - 300), i + 400));
    }
  }
  console.log('NEEDLE_HITS', hits, 'of', allj.length, 'journal rows scanned');

  // 4) Retention: oldest surviving agent_runs row (global) — is pruning active?
  const oldest = await prisma.agentRun.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true } });
  console.log('OLDEST_RUN_ROW', JSON.stringify(oldest));
})().catch((e) => { console.error('PROBE_FAIL', e && e.message); process.exit(1); });

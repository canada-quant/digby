// verify-568d3652-args.js — extract the ACTUAL tool_call args from the Fleet Supervisor
// sweep chat (a PLAIN chat — no agent_runs rows) whose get_run_receipts calls returned
// not_found 3× and tripped the breaker (dispatchedAt 2026-09-30T22:47:58Z).
// READ-ONLY. Ticket 568d3652.
const prisma = require('/app/dist/config/database').default;
const CHAT = 'c0e22e36-1c74-4295-8049-9b48335c6c37';

(async () => {
  // 1) Messages in the breaker window (and a little before for context).
  const msgs = await prisma.crossModelMessage.findMany({
    where: { chatId: CHAT, createdAt: { gte: new Date('2026-09-30T21:00:00Z'), lte: new Date('2026-10-01T00:30:00Z') } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, createdAt: true, parts: true },
  });
  console.log('MSGS_IN_WINDOW', msgs.length);

  // 2) Every tool_call named get_run_receipts + its exact args, and the tool_result
  //    that followed (match by name, order of appearance).
  let grrCalls = 0;
  for (const m of msgs) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p && p.type === 'tool_call') {
        const nm = String(p.name || '');
        if (nm === 'get_run_receipts') {
          grrCalls++;
          console.log('GRR_CALL', JSON.stringify({ msg: m.id.slice(0, 8), at: m.createdAt, idx: i, args: p.args ?? p.arguments ?? null }));
          // the nearest following tool_result with the same name
          for (let j = i + 1; j < Math.min(parts.length, i + 4); j++) {
            if (parts[j] && parts[j].type === 'tool_result') {
              if (String(parts[j].name || '') === 'get_run_receipts' || String(parts[j].toolName || '') === 'get_run_receipts') {
                console.log('GRR_RESULT', JSON.stringify({ msg: m.id.slice(0, 8), idx: j, res: String(parts[j].result ?? parts[j].content ?? '').slice(0, 300) }));
                break;
              }
            }
          }
        } else {
          // log all other tool calls for call-shape context
          console.log('OTHER_CALL', JSON.stringify({ msg: m.id.slice(0, 8), at: m.createdAt, idx: i, name: nm, args: JSON.stringify(p.args ?? p.arguments ?? null).slice(0, 200) }));
        }
      }
    }
  }
  console.log('GRR_TOTAL', grrCalls);
})().catch((e) => { console.error('PROBE_FAIL', e && e.message); process.exit(1); });

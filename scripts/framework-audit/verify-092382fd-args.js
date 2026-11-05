// verify-092382fd-args.js — extract the ACTUAL get_run_receipts tool_call args from the
// "Constant framework R&D — hunt shortfalls" coding lane (chat b92ef13f, run 71807dd3)
// whose 3× not_found refusals tripped the derail breaker (filed 2026-10-04T02:04:17Z).
// READ-ONLY. Ticket 092382fd. Pattern reused from verify-568d3652-args.js (PR #1213).
const prisma = require('/app/dist/config/database').default;
const CHAT = 'b92ef13f-c3f8-487e-8267-767e56543150';
const RUN = '71807dd3-3a4d-4e14-bc51-f9bf4229e1ab';

(async () => {
  // 0) The lane chat itself + its owner (the account the streak ran under).
  const laneChat = await prisma.crossModelChat.findUnique({ where: { id: CHAT }, select: { id: true, userId: true, title: true } });
  console.log('LANE_CHAT', JSON.stringify(laneChat));

  // 1) Messages in the breaker window (run started ~00:28Z, breaker filed 02:04:17Z).
  const msgs = await prisma.crossModelMessage.findMany({
    where: { chatId: CHAT, createdAt: { gte: new Date('2026-10-04T00:20:00Z'), lte: new Date('2026-10-04T02:10:00Z') } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, createdAt: true, parts: true },
  });
  console.log('MSGS_IN_WINDOW', msgs.length);

  // 2) Every tool_call named get_run_receipts + exact args + the following tool_result.
  let grrCalls = 0; const argIds = new Set();
  for (const m of msgs) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || p.type !== 'tool_call') continue;
      const nm = String(p.name || '');
      if (nm === 'get_run_receipts') {
        grrCalls++;
        const args = p.args ?? p.arguments ?? null;
        console.log('GRR_CALL', JSON.stringify({ msg: m.id.slice(0, 8), at: m.createdAt, idx: i, args: JSON.stringify(args).slice(0, 400) }));
        const cid = args && (args.chatId || args.chatid);
        if (cid) argIds.add(String(cid));
        for (let j = i + 1; j < Math.min(parts.length, i + 4); j++) {
          if (parts[j] && parts[j].type === 'tool_result' && (String(parts[j].name || '') === 'get_run_receipts' || String(parts[j].toolName || '') === 'get_run_receipts')) {
            console.log('GRR_RESULT', JSON.stringify({ idx: j, res: String(parts[j].result ?? parts[j].content ?? '').slice(0, 260) }));
            break;
          }
        }
      } else if (nm === 'get_chat_messages' || nm === 'get_chat_status' || nm === 'resolve_id') {
        console.log('SIBLING_CALL', JSON.stringify({ msg: m.id.slice(0, 8), name: nm, args: JSON.stringify(p.args ?? p.arguments ?? null).slice(0, 260) }));
      }
    }
  }
  console.log('GRR_TOTAL', grrCalls);

  // 3) Resolve every chatId the run actually passed: does it exist, whose is it?
  for (const id of argIds) {
    const row = await prisma.crossModelChat.findUnique({ where: { id }, select: { id: true, userId: true, title: true } });
    console.log('ARG_ID_RESOLVE', JSON.stringify({ asked: String(id).slice(0, 64), row }));
  }

  // 4) The cross-account chat the lane was reconstructing (ticket dffdb141 context) —
  //    full id + owner, to compare with the lane's owner.
  try {
    const peer = await prisma.crossModelChat.findFirst({ where: { id: { startsWith: '5146aa95' } }, select: { id: true, userId: true, title: true } });
    console.log('PEER_5146aa95', JSON.stringify(peer));
  } catch (e) { console.log('PEER_LOOKUP_FAIL', String(e && e.message).slice(0, 120)); }

  // 5) The run row itself (the streak's run) — AgentRun keys by sessionId.
  try {
    const run = await prisma.agentRun.findUnique({ where: { id: RUN }, select: { id: true, sessionId: true, status: true, startedAt: true, finishedAt: true } });
    console.log('RUN_ROW', JSON.stringify(run));
  } catch (e) { console.log('RUN_LOOKUP_FAIL', String(e && e.message).slice(0, 120)); }
})().catch((e) => { console.error('PROBE_FAIL', e && e.message); process.exit(1); });

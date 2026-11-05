// verify-568d3652-grr-args.js — extract the exact get_run_receipts chatId args from the
// Fleet Supervisor sweep session c0e22e36 around 2026-09-30T22:4xZ (ticket 568d3652,
// 3× not_found streak), and adjudicate: did the arg point at a real, readable chat?
//
// READ-ONLY. Runs inside the live backend container via prodq.sh.
const prisma = require('/app/dist/config/database').default;

const SESSION = 'c0e22e36-1c74-4295-8049-9b48335c6c37';
const FROM = new Date('2026-09-30T22:00:00Z');
const TO = new Date('2026-10-01T00:30:00Z');

function findGrrCalls(node, out, path) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((v, i) => findGrrCalls(v, out, `${path}[${i}]`)); return; }
  const name = node.name || node.tool || node.toolName || node.tool_name;
  if (typeof name === 'string' && name === 'get_run_receipts') {
    const args = node.arguments || node.args || node.input || node.parameters || null;
    out.push({ path, kind: node.type || node.kind || null, args });
  }
  for (const k of Object.keys(node)) {
    if (k === 'name' || k === 'tool' || k === 'toolName' || k === 'tool_name') continue;
    findGrrCalls(node[k], out, `${path}.${k}`);
  }
}

(async () => {
  const runs = await prisma.agentRun.findMany({
    where: { sessionId: SESSION, createdAt: { gte: FROM, lte: TO } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, createdAt: true, startedAt: true, finishedAt: true, error: true },
  });
  console.log('RUNS', JSON.stringify(runs));

  const calls = [];
  for (const r of runs) {
    const evs = await prisma.agentEvent.findMany({
      where: { runId: r.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, type: true, payload: true, createdAt: true },
    }).catch(() => []);
    const types = {};
    for (const e of evs) types[e.type] = (types[e.type] || 0) + 1;
    console.log('RUN', r.id, 'EVENT_TYPES', JSON.stringify(types));
    for (const e of evs) {
      const found = [];
      findGrrCalls(e.payload, found, `ev:${e.seq}`);
      for (const f of found) calls.push({ runId: r.id, at: e.createdAt, type: e.type, ...f });
      // also raw string sniff for args near the tool name
      const s = JSON.stringify(e.payload);
      if (s && s.includes('get_run_receipts') && !found.length) {
        const i = s.indexOf('get_run_receipts');
        calls.push({ runId: r.id, at: e.createdAt, type: e.type, raw: s.slice(Math.max(0, i - 120), i + 300) });
      }
    }
  }
  console.log('GRR_CALLS_FROM_EVENTS', JSON.stringify(calls, null, 1).slice(0, 6000));

  // Same window, the chat's persisted message parts (assistant tool-call parts).
  const msgs = await prisma.crossModelMessage.findMany({
    where: { chatId: SESSION, createdAt: { gte: FROM, lte: TO } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, parts: true, createdAt: true },
  }).catch(() => []);
  const mCalls = [];
  for (const m of msgs) {
    const found = [];
    findGrrCalls(m.parts, found, `msg:${m.id.slice(0, 8)}`);
    for (const f of found) mCalls.push({ at: m.createdAt, role: m.role, ...f });
    const s = m.parts ? JSON.stringify(m.parts) : '';
    if (s && s.includes('get_run_receipts') && !found.length) {
      const i = s.indexOf('get_run_receipts');
      mCalls.push({ at: m.createdAt, role: m.role, raw: s.slice(Math.max(0, i - 120), i + 300) });
    }
  }
  console.log('GRR_CALLS_FROM_PARTS', JSON.stringify(mCalls, null, 1).slice(0, 6000));

  // Adjudicate: for each distinct chatId arg, does the chat exist + who owns it?
  const argIds = [...new Set([...calls, ...mCalls]
    .map((c) => c.args && typeof c.args.chatId === 'string' ? c.args.chatId : null)
    .filter(Boolean))];
  console.log('ARG_CHAT_IDS', JSON.stringify(argIds));
  const owner = await prisma.crossModelChat.findUnique({ where: { id: SESSION }, select: { userId: true, title: true } });
  console.log('SESSION_OWNER', JSON.stringify(owner));
  for (const a of argIds) {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: a }, select: { id: true, userId: true, title: true, archivedAt: true } }).catch(() => null);
    let prefixMatch = null;
    if (!chat && a.length < 36) {
      prefixMatch = await prisma.crossModelChat.findMany({
        where: { id: { startsWith: a } }, select: { id: true, userId: true, title: true }, take: 5,
      }).catch(() => []);
    }
    console.log('ARG', a, 'EXACT_CHAT', JSON.stringify(chat), 'PREFIX_MATCHES', JSON.stringify(prefixMatch));
  }
})().catch((e) => { console.error('PROBE_FAIL', e && e.message); process.exit(1); });

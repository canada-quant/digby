#!/usr/bin/env node
/**
 * freeze-trajectory-case.js — freeze ONE real incident into a trajectory-eval
 * case draft (build 2026-10-08 E; backend/src/modules/crossmodel/evals/trajectory).
 *
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh freeze-trajectory-case.js <assistantMessageId|8-char prefix> [--id <case-id>] [--history N] [--tz <IANA zone>]
 *
 * Prints a case JSON (status "draft") to stdout: the triggering message and up
 * to N earlier rows as the frozen INPUT, every tool call the incident run made
 * as a FIXTURE (its args as the matcher, its stored result as the output), and
 * the run itself as the INCIDENT recording (each call one turn, the delivered
 * answer last). Default graders: ids_grounded, call_ids_grounded,
 * final_nonempty, and one claim_requires_call per first-person action verb the
 * answer uses. Save it as cases/<id>.json, tighten the graders to the
 * incident's own failure, add a reference recording, set status "active".
 *
 * READ-ONLY (two SELECTs through the backend's own Prisma client). Writes
 * nothing anywhere; the output is the only product. Exit 0 ok; 1 not found /
 * error; 2 usage.
 */
'use strict';

const MAX_MESSAGE_CHARS = 20000;
const MAX_HISTORY_CHARS = 4000;
const MAX_OUTPUT_CHARS = 6000;
const ACTION_VERBS = [
  ['sent|messaged|pinged|told|asked', ['send_chat_message', 'send_to_instance', 'notify_user']],
  ['steered|steering', ['send_chat_message']],
  ['dispatched|spawned|started (?:a |the )?(?:lane|session)', ['start_coding_session', 'send_chat_message']],
  ['filed', ['file_feedback', 'flag_owner_question']],
  ['scheduled|armed|re-?armed', ['schedule_message', 'update_schedule', 'resume_schedule']],
  ['cancell?ed|paused', ['cancel_schedule', 'pause_schedule', 'update_schedule', 'stop_run']],
  ['merged|pushed', ['merge_pull_request', 'git_push']],
  ['read back|re-?read|just checked|verified', ['get_chat_status', 'get_chat_messages', 'get_project', 'list_schedules', 'get_run_receipts', 'list_owner_questions', 'goal_list', 'todo_list']],
];

function parseArgs(argv) {
  const out = { message: null, id: null, history: 4, tz: 'UTC' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--id') out.id = argv[++i];
    else if (a === '--history') out.history = Math.max(0, Math.min(12, Number(argv[++i]) || 0));
    else if (a === '--tz') out.tz = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!out.message) out.message = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.help && !/^[0-9a-f-]{8,36}$/i.test(out.message || '')) throw new Error('usage: freeze-trajectory-case.js <assistantMessageId|8-char prefix> [--id <case-id>] [--history N] [--tz <zone>]');
  return out;
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)}… [clipped ${t.length - n} chars]` : t;
}

/** Short string args become the fixture matcher (long free text never matches exactly twice). */
function matcherOf(args) {
  const m = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length <= 80) m[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') m[k] = v;
  }
  return Object.keys(m).length ? m : undefined;
}

function roleOf(chat) {
  if (chat.isSupervisor) return 'fleet_supervisor';
  if (chat.isProjectSupervisor) return 'project_supervisor';
  return 'chat';
}

function triggerOf(row, role) {
  const md = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const origin = md.origin || (md.authorId ? 'user' : null);
  if (origin && origin !== 'user') return 'machine_wake';
  if (/^\[MACHINE-TRIGGERED RUN/.test(String(row && row.content || ''))) return 'machine_wake';
  return role === 'chat' ? 'user_turn' : 'owner_turn';
}

function seatOf(meta) {
  const md = meta && typeof meta === 'object' ? meta : {};
  const lead = md.depth && md.depth.team && Array.isArray(md.depth.team.members) ? md.depth.team.members.find((m) => m && m.role === 'lead') : null;
  return (lead && lead.model) || (md.models && md.models.digby && md.models.digby.modelUsed) || undefined;
}

/** Pure: build the case draft from the rows (tested without a DB). */
function buildCase({ answer, trigger, history, chat, project, opts }) {
  const role = roleOf(chat);
  const prefix = String(answer.id).slice(0, 8);
  const parts = Array.isArray(answer.parts) ? answer.parts : [];
  const fixtures = [];
  const turns = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (!p || p.type !== 'tool_call' || !p.name) continue;
    let args = p.args;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    args = args && typeof args === 'object' ? args : {};
    const result = parts.slice(i + 1).find((r) => r && r.type === 'tool_result' && (r.name === p.name) && (!p.id || !r.id || r.id === p.id));
    const fx = { tool: p.name, output: clip(result ? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result)) : 'No result recorded.', MAX_OUTPUT_CHARS) };
    const m = matcherOf(args);
    if (m) fx.args = m;
    fixtures.push(fx);
    turns.push({ toolCalls: [{ name: p.name, args }] });
  }
  turns.push({ content: String(answer.content || '') || '(empty answer)' });
  const text = String(answer.content || '');
  const graders = [
    { id: 'ids-seen', kind: 'ids_grounded', why: 'Every id the reader sees must be one the run saw (TODO: keep if relevant).' },
    { id: 'call-ids-seen', kind: 'call_ids_grounded', why: 'Every id passed to a tool must be one the run saw (TODO: keep if relevant).' },
    { id: 'answered', kind: 'final_nonempty', why: 'The run delivers an answer.' },
  ];
  ACTION_VERBS.forEach(([verbs, tools], i) => {
    const pattern = `\\bI(?:'ve| have)? (?:just )?(?:${verbs})\\b`;
    if (new RegExp(pattern, 'i').test(text)) {
      graders.push({ id: `claim-${i + 1}`, kind: 'claim_requires_call', why: `TODO: the answer claims "${verbs}" — tighten to the incident's exact claim and the call that would back it.`, pattern, anyOf: [{ tool: tools }] });
    }
  });
  const nowIso = new Date(trigger ? trigger.createdAt : answer.createdAt).toISOString();
  return {
    id: opts.id || `incident-${prefix}`,
    title: `TODO — one line: what went wrong in msg ${prefix}`,
    status: 'draft',
    incident: {
      date: nowIso.slice(0, 10),
      source: `frozen from msg ${prefix} (chat ${String(chat.id).slice(0, 8)}) by scripts/framework-audit/freeze-trajectory-case.js`,
      refs: [`chat ${String(chat.id).slice(0, 8)}`, `msg ${prefix}`],
      summary: 'TODO — what the run did, what was true, why it mattered (two or three sentences, the incident\'s own numbers).',
    },
    role,
    trigger: trigger ? triggerOf(trigger, role) : 'machine_wake',
    ...(seatOf(answer.metadata) ? { seat: { model: seatOf(answer.metadata) } } : {}),
    input: {
      now: nowIso,
      timezone: opts.tz || 'UTC',
      chatId: chat.id,
      ...(chat.title ? { chatTitle: String(chat.title).slice(0, 120) } : {}),
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      ...(history.length ? { history: history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: clip(h.content, MAX_HISTORY_CHARS) })) } : {}),
      message: clip(trigger ? trigger.content : '(no triggering message found)', MAX_MESSAGE_CHARS) || '(empty)',
    },
    fixtures,
    harness: { maxSteps: Math.max(4, Math.min(24, turns.length + 2)) },
    graders,
    recordings: [{ id: 'incident', kind: 'incident', expect: 'fail', ...(seatOf(answer.metadata) ? { model: seatOf(answer.metadata) } : {}), note: `msg ${prefix} as stored`, turns }],
  };
}

async function run(opts = {}) {
  const argv = opts.argv || process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.help) return { help: true };
  const prisma = opts.prisma || require('/app/dist/config/database').default;
  const key = parsed.message.toLowerCase();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id::text AS id, "chatId"::text AS "chatId", role, content, metadata, parts, "createdAt" FROM crossmodel_messages WHERE id::text LIKE $1 AND role = 'assistant' ORDER BY "createdAt" DESC LIMIT 2`,
    `${key}%`,
  );
  if (!rows || !rows.length) throw new Error(`no assistant message matches ${parsed.message}`);
  if (rows.length > 1) throw new Error(`prefix ${parsed.message} is ambiguous — pass more characters`);
  const answer = rows[0];
  const before = await prisma.$queryRawUnsafe(
    `SELECT id::text AS id, role, content, metadata, "createdAt" FROM crossmodel_messages WHERE "chatId"::text = $1 AND "createdAt" < $2 ORDER BY "createdAt" DESC LIMIT $3`,
    answer.chatId, answer.createdAt, parsed.history + 6,
  );
  const trigger = (before || []).find((r) => r.role === 'user') || null;
  const history = (before || []).filter((r) => r !== trigger && trigger && new Date(r.createdAt) < new Date(trigger.createdAt)).slice(0, parsed.history).reverse();
  const chats = await prisma.$queryRawUnsafe(
    `SELECT c.id::text AS id, c.title, c."isSupervisor", c."isProjectSupervisor", c."projectId"::text AS "projectId", p.name AS "projectName" FROM crossmodel_chats c LEFT JOIN crossmodel_projects p ON p.id = c."projectId" WHERE c.id::text = $1`,
    answer.chatId,
  );
  const chat = (chats && chats[0]) || { id: answer.chatId };
  const project = chat.projectId ? { id: chat.projectId, name: chat.projectName || 'Project' } : null;
  return buildCase({ answer, trigger, history, chat, project, opts: parsed });
}

module.exports = { run, buildCase, parseArgs, matcherOf };

if (require.main === module) {
  run()
    .then((c) => { if (c && c.help) console.log('usage: freeze-trajectory-case.js <assistantMessageId|8-char prefix> [--id <case-id>] [--history N] [--tz <zone>]'); else process.stdout.write(`${JSON.stringify(c, null, 2)}\n`); process.exit(0); })
    .catch((err) => { console.error(`freeze-trajectory-case: ${err && err.message ? err.message : err}`); process.exit(/usage|unknown argument/.test(String(err && err.message)) ? 2 : 1); });
}

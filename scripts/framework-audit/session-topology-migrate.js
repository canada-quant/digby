#!/usr/bin/env node
/**
 * session-topology-migrate.js — ONE-SHOT WRITE (SESSION_TITLES_TOPOLOGY design §C,
 * 2026-09-27): bind charters + retitle existing coding lanes to the harness
 * title contract, and write the per-project DEDUPE / RETIRE report.
 *
 * DRY RUN BY DEFAULT (prints what would change; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh session-topology-migrate.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh session-topology-migrate.js --apply
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh session-topology-migrate.js --revert           # dry-run of the revert
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh session-topology-migrate.js --revert --apply   # restore titles + charters, drop the store rows
 * Options: --limit N (cap the lanes touched), --project <id> (one project), --run <id>, --overlap 0.6.
 *
 * WHAT IT DOES (per non-archived, non-supervisor coding chat):
 *   (1) bind the charter — charterGoalId = the goal of its OPEN assigned todos
 *       (majority), else the project goal that best matches its latest plan
 *       goal / title by R1's word overlap (≥ --overlap, default 0.6), else null;
 *       charterTodoId = its single open assigned todo when there is exactly one;
 *   (2) retitle — a lane with a charter and titleSource null / 'spawn-param' /
 *       'llm' renders "<goal ≤6 words> · <step>" (spawn-param keeps its goal
 *       half; the step half = the newest ok mutating receipt's verb, else the
 *       idle age); a lane WITHOUT a charter keeps its title and gets
 *       titleSource 'llm' when null;
 *   (3) a lane a HUMAN renamed (an Activity `chat.rename` row without pin:false)
 *       is never touched — it gets titlePinned=true instead;
 *   (4) the report — per project: groups of live lanes sharing a charter goal
 *       or ≥ overlap on their goal words (runs / last receipt each), R4
 *       candidates (≥ 20 runs and ZERO mutating receipts), R6 candidates (no
 *       charter, no enabled schedule, no mutating receipt for > 6 h) — printed
 *       always and, under --apply, written to the store at
 *       ['instance','session-topology'] / report-<projectId> for the
 *       supervisor's topology_check to read. The script NEVER archives.
 * Every touched lane's previous {title, titleSource, charterGoalId,
 * charterTodoId, titlePinned} is kept in the store (`<chatId>:title-migration`
 * / `previous`) so `--revert` restores it byte-for-byte.
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs it
 * from /app): `require('/app/dist/config/database')` is the backend's Prisma
 * client and `/app/dist/modules/crossmodel/platform/session-{titles,topology}`
 * supply the renderer / word match. Testable offline:
 * `module.exports.run({ prisma, argv, lib })` takes a mocked client + the TS
 * helpers (backend/src/scripts/session-topology-migrate.test.ts).
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. This file is a
 * deliberate exception — an owner-directed write one-shot — and every write sits
 * behind `--apply`; without it the script is a read-only probe like the others.
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const NS_SUFFIX = ':title-migration';
const STORE_KEY = 'previous';
const REPORT_NS = 'instance:session-topology';
const PLAN_NS_SUFFIX = ':coding-plan';
const PLAN_KEY = 'plan';
const OPEN_TODO = ['pending', 'in_progress', 'blocked'];
const DEFAULT_OVERLAP = 0.6;
const R4_MIN_RUNS = 20;
const R6_IDLE_MS = 6 * 3600 * 1000;
const RUNS_WINDOW_MS = 14 * 24 * 3600 * 1000;

function parseArgs(argv) {
  const out = { apply: false, revert: false, limit: null, run: null, project: null, overlap: DEFAULT_OVERLAP, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--revert') out.revert = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a === '--run') out.run = String(argv[++i] || '');
    else if (a.startsWith('--run=')) out.run = a.slice('--run='.length);
    else if (a === '--project') out.project = String(argv[++i] || '');
    else if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a === '--overlap') out.overlap = Number(argv[++i]);
    else if (a.startsWith('--overlap=')) out.overlap = Number(a.slice('--overlap='.length));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.limit !== null && (!Number.isFinite(out.limit) || out.limit < 0)) throw new Error('--limit must be a non-negative number');
  if (!Number.isFinite(out.overlap) || out.overlap <= 0 || out.overlap > 1) throw new Error('--overlap must be in (0, 1]');
  return out;
}

function defaultLib() {
  const candidates = ['/app/dist/modules/crossmodel/platform', require('path').resolve(process.cwd(), 'dist', 'modules', 'crossmodel', 'platform')];
  let lastErr = null;
  for (const base of candidates) {
    try {
      const titles = require(`${base}/session-titles`);
      const topology = require(`${base}/session-topology`);
      const names = require(`${base}/platform-tool-names`);
      return { renderSessionTitle: titles.renderSessionTitle, splitSessionTitle: titles.splitSessionTitle, clipWords: titles.clipWords, stepFromReceipt: titles.stepFromReceipt, stepFromRunState: titles.stepFromRunState, normalizeGoalWords: topology.normalizeGoalWords, jaccard: topology.jaccard, mutatingTools: [...names.PLATFORM_MUTATING_TOOLS, 'open_pull_request', 'merge_pull_request', 'run_command'] };
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('session-titles / session-topology dist modules not found');
}

const nsFor = (chatId) => `${chatId}${NS_SUFFIX}`;
const chatIdOf = (namespacePath) => (namespacePath.endsWith(NS_SUFFIX) ? namespacePath.slice(0, -NS_SUFFIX.length) : null);
const majority = (values) => {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null; let n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
};

async function selectLanes(client, opts) {
  const where = { archivedAt: null, isSupervisor: false, isProjectSupervisor: false, codingState: { isNot: null }, ...(opts.project ? { projectId: opts.project } : {}) };
  const rows = await client.crossModelChat.findMany({
    where, select: { id: true, title: true, projectId: true, userId: true, charterGoalId: true, charterTodoId: true, titlePinned: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: 'asc' }, ...(opts.limit !== null && opts.limit !== undefined ? { take: opts.limit } : {}),
  });
  return rows.filter((r) => r.projectId);
}

async function loadFacts(client, lanes, lib, now) {
  const ids = lanes.map((l) => l.id);
  const projectIds = [...new Set(lanes.map((l) => l.projectId))];
  const [states, todos, goals, schedules, receipts, runs, renames, plans] = await Promise.all([
    client.chatCodingState.findMany({ where: { id: { in: ids } }, select: { id: true, titleSource: true } }),
    client.projectTodo.findMany({ where: { assigneeChatId: { in: ids }, status: { in: OPEN_TODO } }, select: { id: true, goalId: true, assigneeChatId: true } }),
    client.projectGoal.findMany({ where: { projectId: { in: projectIds }, status: { in: ['active', 'blocked'] } }, select: { id: true, projectId: true, title: true } }),
    client.chatSchedule.findMany({ where: { sessionId: { in: ids }, enabled: true }, select: { sessionId: true } }),
    client.runToolReceipt.findMany({ where: { chatId: { in: ids }, ok: true, tool: { in: lib.mutatingTools } }, orderBy: { createdAt: 'desc' }, distinct: ['chatId'], select: { chatId: true, tool: true, ids: true, createdAt: true } }),
    client.agentRun.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids }, createdAt: { gte: new Date(now.getTime() - RUNS_WINDOW_MS) } }, _count: { _all: true } }),
    client.activity.findMany({ where: { action: 'chat.rename' }, select: { metadata: true }, take: 5000 }),
    client.contextStoreEntry.findMany({ where: { namespacePath: { in: ids.map((id) => `${id}${PLAN_NS_SUFFIX}`) }, key: PLAN_KEY }, select: { namespacePath: true, value: true } }),
  ]);
  const by = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const humanRenamed = new Set();
  for (const r of renames) { const m = r && r.metadata && typeof r.metadata === 'object' ? r.metadata : {}; if (m.chatId && m.pin !== false) humanRenamed.add(String(m.chatId)); }
  const planGoal = new Map();
  for (const p of plans) { const g = p.value && typeof p.value === 'object' ? p.value.goal : null; if (typeof g === 'string' && g.trim()) planGoal.set(p.namespacePath.slice(0, -PLAN_NS_SUFFIX.length), g.trim()); }
  return {
    stateBy: new Map(states.map((s) => [s.id, s])), todosBy: by(todos, 'assigneeChatId'), goalsBy: by(goals, 'projectId'),
    scheduled: new Set(schedules.map((s) => s.sessionId)), receiptBy: new Map(receipts.map((r) => [r.chatId, r])),
    runsBy: new Map(runs.map((r) => [r.sessionId, Number(r._count && r._count._all || 0)])), humanRenamed, planGoal,
  };
}

/** Pure: the charter + title decision for one lane. */
function planLane(lane, facts, lib, opts, now) {
  const state = facts.stateBy.get(lane.id) || { titleSource: null };
  const todos = facts.todosBy.get(lane.id) || [];
  const goals = facts.goalsBy.get(lane.projectId) || [];
  let charterGoalId = lane.charterGoalId || majority(todos.map((t) => t.goalId));
  let charterSource = lane.charterGoalId ? 'existing' : charterGoalId ? 'todos' : null;
  if (!charterGoalId) {
    const words = lib.normalizeGoalWords(`${facts.planGoal.get(lane.id) || ''} ${lane.title}`);
    let best = null; let bestScore = 0;
    for (const g of goals) { const s = lib.jaccard(words, lib.normalizeGoalWords(g.title)); if (s > bestScore) { best = g; bestScore = s; } }
    if (best && bestScore >= opts.overlap) { charterGoalId = best.id; charterSource = `overlap:${bestScore.toFixed(2)}`; }
  }
  const charterTodoId = lane.charterTodoId || (todos.length === 1 ? todos[0].id : null);
  const goal = charterGoalId ? goals.find((g) => g.id === charterGoalId) : null;
  const pinned = lane.titlePinned || facts.humanRenamed.has(lane.id);
  const receipt = facts.receiptBy.get(lane.id) || null;
  const step = (receipt && lib.stepFromReceipt(receipt)) || lib.stepFromRunState({ lastActivityAt: lane.updatedAt }, now);
  let newTitle = lane.title; let newTitleSource = state.titleSource; let action = 'keep';
  if (pinned) { action = lane.titlePinned ? 'keep:pinned' : 'pin'; }
  else if (charterGoalId && (state.titleSource == null || state.titleSource === 'spawn-param' || state.titleSource === 'llm')) {
    const goalHalf = state.titleSource === 'spawn-param' ? lib.splitSessionTitle(lane.title).goal : (goal ? lib.clipWords(goal.title) : lib.splitSessionTitle(lane.title).goal);
    newTitle = lib.renderSessionTitle({ goal: goalHalf, step });
    newTitleSource = state.titleSource === 'spawn-param' ? 'spawn-param' : 'harness';
    action = newTitle === lane.title ? 'keep:same' : 'retitle';
  } else if (!charterGoalId && state.titleSource == null) { newTitleSource = 'llm'; action = 'stamp:llm'; }
  return {
    chatId: lane.id, projectId: lane.projectId, action, charterGoalId, charterTodoId, charterSource, pinned,
    from: { title: lane.title, titleSource: state.titleSource, charterGoalId: lane.charterGoalId, charterTodoId: lane.charterTodoId, titlePinned: lane.titlePinned },
    to: { title: newTitle, titleSource: newTitleSource, charterGoalId, charterTodoId, titlePinned: pinned },
    runs14d: facts.runsBy.get(lane.id) || 0, scheduled: facts.scheduled.has(lane.id), lastReceiptAt: receipt ? receipt.createdAt : null, openTodos: todos.length,
    goalWords: lib.normalizeGoalWords(`${goal ? goal.title : ''} ${facts.planGoal.get(lane.id) || ''} ${lane.title}`),
  };
}

/** Pure: the dedupe / R4 / R6 report per project. */
function buildReport(plans, lib, opts, now) {
  const byProject = new Map();
  for (const p of plans) { if (!byProject.has(p.projectId)) byProject.set(p.projectId, []); byProject.get(p.projectId).push(p); }
  const out = {};
  for (const [projectId, lanes] of byProject) {
    const groups = [];
    const seen = new Set();
    for (let i = 0; i < lanes.length; i++) {
      if (seen.has(lanes[i].chatId)) continue;
      const g = [lanes[i]];
      for (let j = i + 1; j < lanes.length; j++) {
        if (seen.has(lanes[j].chatId)) continue;
        const sameGoal = lanes[i].charterGoalId && lanes[i].charterGoalId === lanes[j].charterGoalId;
        const overlap = lib.jaccard(lanes[i].goalWords, lanes[j].goalWords);
        if (sameGoal || overlap >= opts.overlap) { g.push(lanes[j]); seen.add(lanes[j].chatId); }
      }
      if (g.length > 1) { seen.add(lanes[i].chatId); groups.push({ goalId: lanes[i].charterGoalId, lanes: g.map((l) => ({ chatId: l.chatId, title: l.to.title, runs14d: l.runs14d, lastReceiptAt: l.lastReceiptAt, openTodos: l.openTodos })) }); }
    }
    const r4 = lanes.filter((l) => l.runs14d >= R4_MIN_RUNS && !l.lastReceiptAt).map((l) => ({ chatId: l.chatId, title: l.to.title, runs14d: l.runs14d }));
    const r6 = lanes.filter((l) => !l.charterGoalId && !l.scheduled && l.openTodos === 0 && (!l.lastReceiptAt || now.getTime() - new Date(l.lastReceiptAt).getTime() > R6_IDLE_MS)).map((l) => ({ chatId: l.chatId, title: l.to.title, lastReceiptAt: l.lastReceiptAt }));
    out[projectId] = { lanes: lanes.length, duplicateGroups: groups, r4Candidates: r4, r6Candidates: r6 };
  }
  return out;
}

async function applyForward(client, plans, report, runId) {
  let updated = 0; let pinned = 0; let stamped = 0;
  for (const p of plans) {
    if (p.action === 'keep' || p.action === 'keep:pinned' || p.action === 'keep:same') {
      // a charter bind alone (no title change) still needs the columns
      if (p.charterGoalId !== p.from.charterGoalId || p.charterTodoId !== p.from.charterTodoId) {
        await client.contextStoreEntry.upsert({ where: { namespacePath_key: { namespacePath: nsFor(p.chatId), key: STORE_KEY } }, create: { namespacePath: nsFor(p.chatId), key: STORE_KEY, value: { ...p.from, at: new Date().toISOString(), run: runId } }, update: { value: { ...p.from, at: new Date().toISOString(), run: runId } } });
        await client.crossModelChat.update({ where: { id: p.chatId }, data: { charterGoalId: p.charterGoalId, charterTodoId: p.charterTodoId } });
        updated++;
      }
      continue;
    }
    await client.contextStoreEntry.upsert({ where: { namespacePath_key: { namespacePath: nsFor(p.chatId), key: STORE_KEY } }, create: { namespacePath: nsFor(p.chatId), key: STORE_KEY, value: { ...p.from, at: new Date().toISOString(), run: runId } }, update: { value: { ...p.from, at: new Date().toISOString(), run: runId } } });
    if (p.action === 'pin') {
      await client.crossModelChat.update({ where: { id: p.chatId }, data: { titlePinned: true, charterGoalId: p.charterGoalId, charterTodoId: p.charterTodoId } });
      await client.chatCodingState.update({ where: { id: p.chatId }, data: { titleSource: 'user' } });
      pinned++;
    } else if (p.action === 'retitle') {
      await client.crossModelChat.update({ where: { id: p.chatId }, data: { title: p.to.title, titleStep: lib_split(p.to.title), charterGoalId: p.charterGoalId, charterTodoId: p.charterTodoId } });
      await client.chatCodingState.update({ where: { id: p.chatId }, data: { title: p.to.title, titleSource: p.to.titleSource } });
      updated++;
    } else if (p.action === 'stamp:llm') {
      await client.chatCodingState.update({ where: { id: p.chatId }, data: { titleSource: 'llm' } });
      stamped++;
    }
  }
  for (const [projectId, r] of Object.entries(report)) {
    await client.contextStoreEntry.upsert({ where: { namespacePath_key: { namespacePath: REPORT_NS, key: `report-${projectId}` } }, create: { namespacePath: REPORT_NS, key: `report-${projectId}`, value: { ...r, at: new Date().toISOString(), run: runId } }, update: { value: { ...r, at: new Date().toISOString(), run: runId } } });
  }
  return { updated, pinned, stamped, reportsWritten: Object.keys(report).length };
}
// the step half of a rendered title (last " · ")
function lib_split(title) { const i = String(title).lastIndexOf(' · '); return i > 0 ? String(title).slice(i + 3) : null; }

async function selectBackfilled(client, limit) {
  const rows = await client.contextStoreEntry.findMany({ where: { namespacePath: { endsWith: NS_SUFFIX }, key: STORE_KEY }, select: { namespacePath: true, value: true }, ...(limit !== null && limit !== undefined ? { take: limit } : {}) });
  return rows.map((r) => ({ chatId: chatIdOf(r.namespacePath), value: r.value })).filter((r) => r.chatId);
}

async function applyRevert(client, rows) {
  let restored = 0;
  for (const r of rows) {
    const v = r.value || {};
    await client.crossModelChat.update({ where: { id: r.chatId }, data: { title: v.title, titleStep: null, charterGoalId: v.charterGoalId || null, charterTodoId: v.charterTodoId || null, titlePinned: !!v.titlePinned } });
    await client.chatCodingState.update({ where: { id: r.chatId }, data: { title: v.title, titleSource: v.titleSource || null } }).catch(() => {});
    await client.contextStoreEntry.delete({ where: { namespacePath_key: { namespacePath: nsFor(r.chatId), key: STORE_KEY } } });
    restored++;
  }
  return { restored };
}

async function run({ prisma, argv, lib, print = false, now = new Date() } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) { console.log('usage: session-topology-migrate.js [--apply] [--revert] [--limit N] [--project id] [--run id] [--overlap 0.6]'); return { help: true }; }
  const client = prisma || require('/app/dist/config/database').default;
  const helpers = lib || defaultLib();
  const runId = opts.run || `title-migration-${now.toISOString().replace(/[:.]/g, '-')}`;
  const report = { script: 'session-topology-migrate', run: runId, at: now.toISOString(), action: opts.revert ? 'revert' : 'forward', apply: opts.apply, dryRun: !opts.apply };
  if (!opts.revert) {
    const lanes = await selectLanes(client, opts);
    const facts = await loadFacts(client, lanes, helpers, now);
    const plans = lanes.map((l) => planLane(l, facts, helpers, opts, now));
    const topology = buildReport(plans, helpers, opts, now);
    report.lanes = lanes.length;
    report.byAction = plans.reduce((m, p) => { m[p.action] = (m[p.action] || 0) + 1; return m; }, {});
    report.charterBound = plans.filter((p) => p.charterGoalId && !p.from.charterGoalId).length;
    report.changes = plans.filter((p) => p.action !== 'keep' && p.action !== 'keep:pinned').map((p) => ({ chatId: p.chatId, action: p.action, charterGoalId: p.charterGoalId, charterSource: p.charterSource, from: p.from.title, to: p.to.title }));
    report.topology = topology;
    if (opts.apply) Object.assign(report, await applyForward(client, plans, topology, runId));
    else report.wouldUpdate = plans.filter((p) => p.action === 'retitle' || p.action === 'pin' || p.action === 'stamp:llm' || p.charterGoalId !== p.from.charterGoalId).length;
  } else {
    const rows = await selectBackfilled(client, opts.limit);
    report.backfilledRows = rows.length;
    if (opts.apply) Object.assign(report, await applyRevert(client, rows));
    else report.wouldRestore = rows.length;
  }
  if (print) console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  return report;
}

module.exports = { run, parseArgs, selectLanes, loadFacts, planLane, buildReport, applyForward, selectBackfilled, applyRevert, nsFor, chatIdOf, NS_SUFFIX, STORE_KEY, REPORT_NS, DEFAULT_OVERLAP, R4_MIN_RUNS, R6_IDLE_MS };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument|--limit must|--overlap must/.test(String(err && err.message));
      console.error(`session-topology-migrate: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}

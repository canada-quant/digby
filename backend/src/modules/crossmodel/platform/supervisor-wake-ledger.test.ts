/**
 * supervisor-wake-ledger.ts — audit 2026-10-08 W6: the high-water mark, the
 * ledger diff reads, the three gate entry points (hook / sweep / drain), the
 * agreement + outcome rows and the drain ack. Prisma, the context store and
 * the supervisor state doc are mocked; the rule itself is the real one.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' }, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
const mockStore = new Map<string, any>();
const mockStorePut = jest.fn(async (ns: string[], key: string, value: any) => { mockStore.set(`${ns.join('/')}|${key}`, value); });
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => mockStore.get(`${ns.join('/')}|${key}`) ?? null),
  storePut: (...a: any[]) => mockStorePut(...(a as [string[], string, any])),
}));
const mockGetState = jest.fn(async (): Promise<any> => ({ directives: [] }));
jest.mock('./supervisor-state.service', () => ({ __esModule: true, getSupervisorState: () => mockGetState() }));
const mockDeletePending = jest.fn(async () => {});
jest.mock('../chat-agent/message-queue.service', () => ({ __esModule: true, deletePending: (...a: any[]) => (mockDeletePending as any)(...a) }));

const SUP = 'sup-41bd202a';
const NOW_ISO = '2026-10-08T16:15:00.000Z';
const LANE_DRIVE = '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5';

type Rows = Record<string, any[]>;
let rows: Rows;
let rawRows: { messages: any[]; prevSummaries: any[]; prevBodies: any[]; laneRuns: any[]; transcript: any[] };
const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where }: any) => rows.chats.find((c) => c.id === where.id) ?? null),
    findMany: jest.fn(async ({ where }: any) => {
      if (where?.id?.in) return rows.chats.filter((c) => where.id.in.includes(c.id));
      return rows.chats.filter((c) => c.id !== SUP && !c.isSupervisor && !c.isProjectSupervisor || (c.id !== SUP && c.scope))
        // review 2026-10-23: the scope read must leave ghost chats out (and a userId filter, when given, binds).
        .filter((c) => (where?.ghostMode === false ? c.ghostMode !== true : true) && (where?.userId ? c.userId === where.userId : true));
    }),
    update: jest.fn(async () => ({})),
  },
  // SUP-WAKE-TIERS: the lane self-driving read asks for live runs only (status in queued / running, no OR).
  agentRun: { findMany: jest.fn(async ({ where }: any) => (where?.OR ? rows.runs : where?.status?.in ? rows.liveRuns : rows.runs)) },
  runToolReceipt: { findMany: jest.fn(async () => rows.receipts) },
  activity: { findMany: jest.fn(async () => rows.activities) },
  ownerQuestion: { findMany: jest.fn(async () => rows.asks) },
  userFeatureRequest: { findMany: jest.fn(async () => rows.tickets) },
  chatSchedule: {
    findMany: jest.fn(async ({ where }: any) => (where?.enabled ? rows.armed : rows.stopped)),
    count: jest.fn(async () => rows.fired.length),
  },
  eventHook: { findMany: jest.fn(async () => rows.hooks) },
  hookEvent: { findMany: jest.fn(async () => rows.skipped) },
  projectTodo: {
    findMany: jest.fn(async ({ where }: any) => {
      if (where?.goalId?.in) return rows.goalOpen; // tiers: open todos left in a done todo's goal
      // LANE-IDLE-WAKE stalled-lanes reads (one per status, scoped to the scope chats); an unstamped row is in_progress.
      if (where?.userId && where?.assigneeChatId?.in) {
        return rows.inProgress.filter((t: any) => (t.status ?? 'in_progress') === where.status && where.assigneeChatId.in.includes(t.assigneeChatId));
      }
      if (where?.assigneeChatId?.in) return rows.laneTodos; // lane self-driving: actionable assigned todos
      if (where?.id?.in) return [...rows.todoEntities, ...rows.depTargets].filter((r) => where.id.in.includes(r.id));
      return rows.inProgress;
    }),
  },
  todoDependency: { findMany: jest.fn(async () => rows.deps) },
  projectGoal: { findMany: jest.fn(async () => rows.goalEntities) },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  $queryRawUnsafe: jest.fn(async (sql: string, ...params: any[]) => {
    // The owner / agent message read. A row given as `content` is read the way Postgres would: LEFT(content, N) AS head,
    // char_length(content) > N AS cut, N taken from the SQL (a row given as `head` is returned as is).
    const left = /LEFT\(content, (\d+)\) AS head/.exec(sql);
    if (left) {
      const n = Number(left[1]);
      // The read is "chatId = ANY($1)": only the chats the query names answer.
      const ids: string[] | null = Array.isArray(params[0]) ? params[0] : null;
      return rawRows.messages.filter((r: any) => !ids || !r.chatId || ids.includes(r.chatId))
        .map((r: any) => (typeof r.content === 'string' ? { ...r, head: r.content.slice(0, n), cut: r.content.length > n } : r));
    }
    if (sql.includes('FROM hook_events')) return rawRows.prevSummaries;
    if (sql.includes("metadata->>'origin' = 'agent'")) return rawRows.prevBodies;
    if (sql.includes('FROM agent_runs')) return rawRows.laneRuns;
    if (sql.includes('LIMIT 40')) return rawRows.transcript;
    return [];
  }),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  ackMaterialGateDrain, buildWakeLedgerBlock, classifyUserRow, clampHighWaterMark, clearWakeLedgerCache, closeStashesForGateSkip, computeWakeLedgerDiff,
  jevVerdictFromStash, ledgerSafeHead, materialGateForDrain, materialGateForHook, materialGateForSweep, onSupervisorRunFinalized, readPsCoveredProjects, readWakeHighWaterMark,
  recordMaterialGateAgreement, recordWakeHighWaterMark, transcriptHighWaterMark,
} from './supervisor-wake-ledger';
import { emptyWakeLedgerDiff, renderWakeLedgerDiff } from './wake-material-rule';

const DIGEST = (body: string) => `RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0 ANSWER_MSG_ID: 79e8f434-3657-4b43-bbd8-0245c83cd1ce — the persisted final answer of this run (the row this digest quotes). Coding run completed. Final answer: ${body}`;
const DRIVE_1514 = DIGEST('No audio yet, 08:14 AM PDT (15:14Z) — `drive_search` (Personal, "Zoey Rome week audio m4a mp3 wav") → "No files found matching"; harness clock 2026-10-08T15:14:31Z; successor firing 59 of 500, daily 21/48.');
const DRIVE_1614 = DIGEST('No audio yet, 09:14 AM PDT (16:14Z) — `drive_search` (Personal, "Zoey Rome week audio m4a mp3 wav") → "No files found matching"; harness clock 2026-10-08T16:14:47Z; successor firing 60 of 500, daily 22/48.');

function quiet(): void {
  rows = {
    chats: [
      { id: SUP, userId: 'u1', projectId: 'p1', isSupervisor: false, isProjectSupervisor: true },
      { id: LANE_DRIVE, title: 'Drive watch', projectId: 'p1', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' },
      { id: 'lane-rec', title: 'Hue recorder', projectId: 'p1', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' },
    ],
    runs: [], receipts: [], activities: [], asks: [], tickets: [], stopped: [], fired: [], armed: [], hooks: [{ id: 'h1' }], skipped: [],
    inProgress: [], todoEntities: [], goalEntities: [],
    liveRuns: [], laneTodos: [], deps: [], depTargets: [], goalOpen: [],
  };
  rawRows = { messages: [], prevSummaries: [], prevBodies: [], laneRuns: [], transcript: [] };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(NOW_ISO), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST = '1';
  delete process.env.SUPERVISOR_MATERIAL_GATE_SHADOW;
  delete process.env.SUPERVISOR_MATERIAL_GATE_DISABLED;
  mockStore.clear(); mockStorePut.mockClear(); mockRecordLoopMetric.mockReset(); mockDeletePending.mockClear();
  mockPrisma.crossModelMessage.create.mockClear();
  mockGetState.mockResolvedValue({ directives: [] });
  clearWakeLedgerCache();
  quiet();
  // The supervisor's last completed wake started one hour ago.
  mockStore.set(`wake-ledger/${SUP}|hwm`, { at: '2026-10-08T15:15:00.000Z' });
});
afterEach(() => { jest.useRealTimers(); delete process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST; });

const gateRow = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r?.kind === 'supervisor_material_gate');

describe('high-water mark', () => {
  it('store first; else the newest machine-wake turn anchored to its prompt row (harness rows skipped); else now − 24 h; clamped', async () => {
    expect((await readWakeHighWaterMark(SUP, new Date(NOW_ISO))).at.toISOString()).toBe('2026-10-08T15:15:00.000Z');
    mockStore.clear();
    rawRows.transcript = [
      { role: 'assistant', createdAt: new Date('2026-10-08T16:00:00Z'), origin: 'project_status', kind: 'project_status' },
      { role: 'assistant', createdAt: new Date('2026-10-08T15:58:00Z'), origin: null, kind: 'owner_briefing' },
      { role: 'assistant', createdAt: new Date('2026-10-08T15:40:00Z'), origin: 'hook', kind: null },
      { role: 'user', createdAt: new Date('2026-10-08T15:37:00Z'), origin: 'hook', kind: null },
    ];
    expect(await readWakeHighWaterMark(SUP, new Date(NOW_ISO))).toEqual({ at: new Date('2026-10-08T15:37:00Z'), source: 'transcript' });
    rawRows.transcript = [{ role: 'assistant', createdAt: new Date('2026-10-08T15:40:00Z'), origin: 'user', kind: null }];
    expect(await readWakeHighWaterMark(SUP, new Date(NOW_ISO))).toEqual({ at: new Date('2026-10-07T16:15:00.000Z'), source: 'default' });
    expect(clampHighWaterMark(new Date('2026-09-01T00:00:00Z'), new Date(NOW_ISO)).toISOString()).toBe('2026-10-07T16:15:00.000Z');
    expect(transcriptHighWaterMark([])).toBeNull();
  });

  it('recordWakeHighWaterMark is monotonic', async () => {
    await recordWakeHighWaterMark(SUP, new Date('2026-10-08T15:00:00Z'));
    expect(mockStorePut).not.toHaveBeenCalled();
    await recordWakeHighWaterMark(SUP, new Date('2026-10-08T16:10:00Z'));
    expect(mockStore.get(`wake-ledger/${SUP}|hwm`)).toMatchObject({ at: '2026-10-08T16:10:00.000Z' });
  });

  it('classifyUserRow: owner-typed vs agent vs machine', () => {
    expect(classifyUserRow('record all 4 cameras', null)).toBe('owner');
    expect(classifyUserRow('record all 4 cameras', 'user')).toBe('owner');
    expect(classifyUserRow('[MACHINE-TRIGGERED RUN — …', null)).toBe('machine');
    expect(classifyUserRow('lane report', 'agent')).toBe('agent');
    expect(classifyUserRow('anything', 'schedule')).toBe('machine');
  });
});

describe('computeWakeLedgerDiff', () => {
  it('reads every section in the project scope; drops the supervisor\'s own writes and other projects; flags a stalled lane', async () => {
    const since = new Date('2026-10-08T15:15:00Z');
    rows.runs = [
      { sessionId: 'lane-rec', status: 'completed', startedAt: new Date('2026-10-08T15:20:00Z'), finishedAt: new Date('2026-10-08T15:52:00Z'), error: null },
      { sessionId: LANE_DRIVE, status: 'failed', startedAt: new Date('2026-10-08T16:00:00Z'), finishedAt: new Date('2026-10-08T16:05:00Z'), error: 'provider content filter' },
      { sessionId: 'lane-rec', status: 'running', startedAt: new Date('2026-10-08T16:10:00Z'), finishedAt: null, error: null },
    ];
    rows.receipts = [
      { chatId: 'lane-rec', tool: 'open_pull_request', ids: { prNumber: 23 }, createdAt: new Date('2026-10-08T15:50:00Z') },
      { chatId: 'lane-rec', tool: 'git_push', ids: { sha: '2b7bc8aa4627abcd' }, createdAt: new Date('2026-10-08T15:49:00Z') },
    ];
    rows.activities = [
      { action: 'todo.update', metadata: { todoId: 't-done', fromStatus: 'in_progress', toStatus: 'done', actingChatId: 'lane-rec' }, createdAt: new Date('2026-10-08T15:52:00Z') },
      { action: 'todo.update', metadata: { todoId: 't-self', fromStatus: 'pending', toStatus: 'blocked', actingChatId: SUP }, createdAt: new Date('2026-10-08T15:30:00Z') },
      { action: 'todo.update', metadata: { todoId: 't-flip', fromStatus: 'pending', toStatus: 'in_progress', actingChatId: 'lane-rec' }, createdAt: new Date('2026-10-08T15:21:00Z') },
      { action: 'todo.update', metadata: { todoId: 't-other', fromStatus: 'in_progress', toStatus: 'done', actingChatId: 'x' }, createdAt: new Date('2026-10-08T15:22:00Z') },
    ];
    rows.todoEntities = [
      { id: 't-done', title: 'Hue decrypt-by-play capture', projectId: 'p1' },
      { id: 't-self', title: 'self', projectId: 'p1' },
      { id: 't-flip', title: 'flip', projectId: 'p1' },
      { id: 't-other', title: 'other project', projectId: 'p2' },
    ];
    rawRows.messages = [
      { chatId: SUP, createdAt: new Date('2026-10-08T15:47:53Z'), origin: 'user', source: null, head: 'also make sure to keep a tidy workspace' },
      { chatId: SUP, createdAt: new Date('2026-10-08T15:46:00Z'), origin: 'agent', source: 'lane-rec', head: '[AGENT-SENT MESSAGE — from chat "Hue recorder" (lane-rec)] Early-window health check' },
      { chatId: SUP, createdAt: new Date('2026-10-08T15:45:00Z'), origin: 'hook', source: null, head: '[MACHINE-TRIGGERED RUN — …' },
      { chatId: 'lane-rec', createdAt: new Date('2026-10-08T15:30:00Z'), origin: null, source: null, head: 'record 30 minutes per camera' },
    ];
    rows.asks = [{ id: 'oq_43f99a5c', chatId: SUP, status: 'answered', question: 'Use the backyard camera?', answeredBy: 'owner', resolvedAt: new Date('2026-10-08T15:58:00Z') }];
    rows.tickets = [{ id: 'tk-1', title: 'Drive watch empty', status: 'open', source: 'agent', createdAt: new Date('2026-10-08T15:30:00Z'), updatedAt: new Date('2026-10-08T15:30:00Z'), context: { filedBy: 'lane-rec' } }];
    rows.stopped = [{ id: 'sch-1', sessionId: LANE_DRIVE, kind: 'once', lastStatus: 'cancelled', disabledAt: new Date('2026-10-08T15:40:00Z') }];
    rows.fired = [1, 2, 3];
    mockGetState.mockResolvedValue({ directives: [{ id: 'd1', origin: 'owner', at: '2026-10-08T15:48:00Z', status: 'open' }, { id: 'd0', origin: 'owner', at: '2026-10-08T10:00:00Z', status: 'open' }] });
    rows.skipped = [{ payload: { sourceChatId: LANE_DRIVE } }, { payload: { sourceChatId: LANE_DRIVE } }];
    rows.inProgress = [{ id: 't-stall', title: 'Events DB', assigneeChatId: LANE_DRIVE }];
    rawRows.laneRuns = [{ sessionId: LANE_DRIVE, lastFinished: new Date('2026-10-08T15:00:00Z'), live: false }];

    const d = (await computeWakeLedgerDiff(SUP, since, new Date(NOW_ISO)))!;
    expect(d.scope).toBe('project');
    expect(d.runsFinished).toEqual([{ chatId: 'lane-rec', title: 'Hue recorder', status: 'completed', at: '2026-10-08T15:52:00.000Z' }]);
    expect(d.runsFailed).toMatchObject([{ chatId: LANE_DRIVE, error: 'provider content filter' }]);
    expect(d.runsRunning).toBe(1);
    expect(d.runsStarted).toBe(3);
    expect(d.artifacts.map((a) => `${a.tool}:${a.ref}`)).toEqual(['open_pull_request:#23', 'git_push:2b7bc8aa']);
    expect(d.statusChanges).toEqual([expect.objectContaining({ kind: 'todo', id: 't-done', from: 'in_progress', to: 'done', byChatId: 'lane-rec' })]);
    expect(d.otherLedgerChanges).toBe(1); // the in_progress flip; the self write and the other project are dropped
    expect(d.ownerMessages.map((m) => `${m.self ? 'self' : m.chatId}:${m.head}`)).toEqual(['self:also make sure to keep a tidy workspace', 'lane-rec:record 30 minutes per camera']);
    expect(d.agentMessages).toEqual([expect.objectContaining({ fromChatId: 'lane-rec', head: 'Early-window health check' })]);
    expect(d.ownerAnswers).toMatchObject([{ id: 'oq_43f99a5c', status: 'answered' }]);
    expect(d.tickets).toMatchObject([{ id: 'tk-1', isNew: true }]);
    expect(d.schedulesStopped).toMatchObject([{ id: 'sch-1', status: 'cancelled' }]);
    expect(d.schedulesFired).toBe(3);
    expect(d.directivesOpened).toBe(1);
    expect(d.stalledLanes).toEqual([{ chatId: LANE_DRIVE, title: 'Drive watch', todoId: 't-stall', todoTitle: 'Events DB', idleMin: 75 }]);
    expect(d.gateSkips).toEqual([{ sourceChatId: LANE_DRIVE, title: 'Drive watch', n: 2 }]);
  });

  it('a non-supervisor chat yields null; a failing section is simply empty', async () => {
    rows.chats[0] = { ...rows.chats[0], isProjectSupervisor: false };
    expect(await computeWakeLedgerDiff(SUP, new Date('2026-10-08T15:15:00Z'))).toBeNull();
    quiet();
    mockPrisma.activity.findMany.mockRejectedValueOnce(new Error('boom'));
    const d = (await computeWakeLedgerDiff(SUP, new Date('2026-10-08T15:15:00Z'), new Date(NOW_ISO)))!;
    expect(d.statusChanges).toEqual([]);
  });
});

describe('materialGateForHook', () => {
  const driveRow = (summary: string) => ({ eventType: 'run_completed', payload: { sourceChatId: LANE_DRIVE, summary } });

  it('REPLAY 2026-10-08: an hourly Drive "No audio yet" digest identical to the last delivered one ⇒ skip (act), counted with reasons []', async () => {
    rawRows.prevSummaries = [{ src: LANE_DRIVE, summary: DRIVE_1514 }];
    const r = await materialGateForHook({ targetChatId: SUP, rows: [driveRow(DRIVE_1614)], alarm: false, isAlarmRow: () => false });
    expect(r).toMatchObject({ mode: 'act', skip: true, verdict: { material: false, reasons: [], sinceMin: 60 }, hwmSource: 'store' });
    expect(gateRow()).toMatchObject({ kind: 'supervisor_material_gate', sessionId: SUP, value: 0, meta: { origin: 'hook', mode: 'act', material: false, skipped: true, reasons: [] } });
  });

  it('a new report, an alarm row, an owner message delivers; shadow mode records but never skips; the kill switch is off', async () => {
    expect((await materialGateForHook({ targetChatId: SUP, rows: [driveRow(DRIVE_1614)], alarm: false })).skip).toBe(false); // no previous delivery
    rawRows.prevSummaries = [{ src: LANE_DRIVE, summary: DRIVE_1514 }];
    expect((await materialGateForHook({ targetChatId: SUP, rows: [driveRow(DRIVE_1614)], alarm: true })).verdict?.reasons).toEqual(['alarm']);
    process.env.SUPERVISOR_MATERIAL_GATE_SHADOW = '1';
    const s = await materialGateForHook({ targetChatId: SUP, rows: [driveRow(DRIVE_1614)], alarm: false });
    expect(s).toMatchObject({ mode: 'shadow', skip: false, verdict: { material: false } });
    process.env.SUPERVISOR_MATERIAL_GATE_DISABLED = '1';
    expect(await materialGateForHook({ targetChatId: SUP, rows: [driveRow(DRIVE_1614)], alarm: false })).toMatchObject({ mode: 'off', skip: false, verdict: null });
  });

  it('a non-supervisor target is never gated; an error fails OPEN', async () => {
    expect(await materialGateForHook({ targetChatId: LANE_DRIVE, rows: [driveRow(DRIVE_1614)], alarm: false })).toMatchObject({ mode: 'off', skip: false });
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect((await materialGateForHook({ targetChatId: SUP, rows: [driveRow(DRIVE_1614)], alarm: false })).skip).toBe(false);
  });

  it('the heartbeat floor delivers a duplicate once the last wake is ≥ 4 h old', async () => {
    mockStore.set(`wake-ledger/${SUP}|hwm`, { at: '2026-10-08T12:00:00.000Z' });
    rawRows.prevSummaries = [{ src: LANE_DRIVE, summary: DRIVE_1514 }];
    expect((await materialGateForHook({ targetChatId: SUP, rows: [driveRow(DRIVE_1614)], alarm: false })).verdict).toMatchObject({ material: true, heartbeat: true, reasons: ['heartbeat'] });
  });
});

describe('materialGateForSweep / materialGateForDrain', () => {
  it('a sweep with nothing moved is skipped; a stalled lane delivers it', async () => {
    expect((await materialGateForSweep({ chatId: SUP })).skip).toBe(true);
    clearWakeLedgerCache();
    rows.inProgress = [{ id: 't-stall', title: 'Events DB', assigneeChatId: LANE_DRIVE }];
    rawRows.laneRuns = [{ sessionId: LANE_DRIVE, lastFinished: new Date('2026-10-08T14:00:00Z'), live: false }];
    expect((await materialGateForSweep({ chatId: SUP })).verdict?.reasons).toEqual(['stall']);
  });

  it('drain: a near-duplicate report from a project lane is acked; a message from outside the scope is a peer message', async () => {
    rawRows.prevBodies = [{ src: 'lane-rec', body: '[AGENT-SENT MESSAGE — from chat "Hue recorder" (lane-rec)] Watch firing 3/24 — cameras still offline, todo stays BLOCKED (external).' }];
    const same = '[AGENT-SENT MESSAGE — from chat "Hue recorder" (lane-rec)] Watch firing 4/24 — cameras still offline, todo stays BLOCKED (external).';
    expect(await materialGateForDrain({ chatId: SUP, rows: [{ content: same }], sourceChatIds: ['lane-rec'] })).toMatchObject({ skip: true, verdict: { reasons: [] } });
    rows.chats.push({ id: 'fleet-sup', projectId: null, isSupervisor: true, isProjectSupervisor: false });
    expect((await materialGateForDrain({ chatId: SUP, rows: [{ content: 'Steer your recorder lane.' }], sourceChatIds: ['fleet-sup'] })).verdict?.reasons).toEqual(['peer_message']);
  });
});

describe('agreement, outcome, ack, stash close', () => {
  it('jevVerdictFromStash reads the act question of each purpose', () => {
    expect(jevVerdictFromStash({ purpose: 'wake_triage', answers: { needs_turn_now: { type: 'noul', noul: 0.04 } } })).toEqual({ purpose: 'wake_triage', question: 'needs_turn_now', p: 0.04, quiet: true });
    expect(jevVerdictFromStash({ purpose: 'drain_triage', answers: { disposition: { type: 'choice', choice: 'act_now' } } })).toMatchObject({ choice: 'act_now', quiet: false });
    expect(jevVerdictFromStash({ purpose: 'supervisor_turn_noop', answers: {} })).toMatchObject({ question: 'will_act', quiet: null });
    expect(jevVerdictFromStash(null)).toBeNull();
  });

  it('recordMaterialGateAgreement writes ONE row with every Jev purpose (stash + siblings) and agree = (quiet === ¬material)', () => {
    recordMaterialGateAgreement(
      { origin: 'sweep', chatId: SUP, mode: 'act', skip: true, verdict: { material: false, reasons: [], heartbeat: false, sinceMin: 60, floorHours: 4 } },
      [{ purpose: 'sweep_triage', answers: { needs_turn_now: { type: 'noul', noul: 0.6 } }, also: [{ purpose: 'supervisor_turn_noop', answers: { will_act: { type: 'noul', noul: 0.1 } } }] }, null],
    );
    const row = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'supervisor_material_gate_agreement');
    expect(row).toMatchObject({ value: 1, meta: { origin: 'sweep', material: false, skipped: true, jev: [{ purpose: 'sweep_triage', quiet: false, agree: false }, { purpose: 'supervisor_turn_noop', quiet: true, agree: true }] } });
  });

  it('onSupervisorRunFinalized advances the mark after a completed machine wake and labels the pending verdict with the run\'s REAL actions', async () => {
    rawRows.prevSummaries = [];
    await materialGateForHook({ targetChatId: SUP, rows: [{ eventType: 'run_completed', payload: { sourceChatId: LANE_DRIVE, summary: DRIVE_1614 } }], alarm: false });
    await onSupervisorRunFinalized({
      chatId: SUP, machineWake: true, failed: false, wakeLedgerAt: '2026-10-08T16:15:00.000Z', runStartedAt: Date.parse(NOW_ISO) - 30_000,
      parts: [{ type: 'tool_call', name: 'archive_chat', args: {} }, { type: 'tool_call', name: 'send_chat_message', args: { chatId: 'lane-rec' } }],
    });
    expect(mockStore.get(`wake-ledger/${SUP}|hwm`)).toMatchObject({ at: '2026-10-08T16:15:00.000Z' });
    const out = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'supervisor_material_gate_outcome');
    expect(out).toMatchObject({ value: 1, meta: { origin: 'hook', material: true, wouldSkip: false, acted: true, actions: ['send_chat_message'] } });
    // An owner turn (not a machine wake) never moves the mark.
    await onSupervisorRunFinalized({ chatId: SUP, machineWake: false, failed: false, runStartedAt: Date.parse(NOW_ISO) + 600_000, parts: [] });
    expect(mockStore.get(`wake-ledger/${SUP}|hwm`)).toMatchObject({ at: '2026-10-08T16:15:00.000Z' });
  });

  it('ackMaterialGateDrain persists the bodies + a harness ack row and deletes the pending rows', async () => {
    const ok = await ackMaterialGateDrain({ chatId: SUP, rows: [{ id: 'p1', content: 'report A' }, { id: 'p2', content: 'report B' }], sourceChatIds: ['lane-rec', 'lane-rec'], verdict: null });
    expect(ok).toBe(true);
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data);
    expect(writes[0]).toMatchObject({ chatId: SUP, role: 'user', metadata: { origin: 'agent', sourceChatId: 'lane-rec', ackOnly: true, materialGate: true, batch: 2 } });
    expect(writes[0].content).toMatch(/^\[MATERIAL GATE — 2 queued agent message\(s\) from lane-rec/);
    expect(writes[0].content).toContain('report A');
    expect(writes[1]).toMatchObject({ role: 'assistant', metadata: { origin: 'material-gate-ack', kind: 'material_gate_ack' } });
    expect(mockDeletePending).toHaveBeenCalledTimes(2);
  });

  it('closeStashesForGateSkip writes one unlabelled outcome per stash and sibling', async () => {
    const { stashDecision } = await import('./decision-gate');
    const sibling = stashDecision({ id: 'tn-1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9, answers: { will_act: { type: 'noul', noul: 0.1 } } }, 'supervisor_turn_noop')!;
    const primary = { ...stashDecision({ id: 'st-1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9, answers: { needs_turn_now: { type: 'noul', noul: 0.2 } } }, 'sweep_triage')!, also: [sibling] };
    mockRecordLoopMetric.mockReset();
    await closeStashesForGateSkip([primary, null], SUP, 'sweep');
    const outcomes = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.meta?.phase === 'outcome');
    expect(outcomes.map((r) => `${r.meta.purpose}:${r.meta.question}:${r.meta.actual}`).sort()).toEqual(['supervisor_turn_noop:will_act:null', 'sweep_triage:needs_turn_now:null']);
    expect(outcomes[0].meta.note).toBe('not started: material gate skip (sweep)');
  });
});

// ── SUP-WAKE-TIERS + ALARM-CAUSE-AWARE (supervisor SOTA 2026-10-20) ─────────

describe('SUP-WAKE-TIERS — the progress hold (evaluate)', () => {
  const report = (summary: string, src = LANE_DRIVE) => ({ eventType: 'run_completed', payload: { sourceChatId: src, summary } });
  afterEach(() => {
    for (const k of ['SUPERVISOR_MATERIAL_TIERS_DISABLED', 'SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE', 'SUPERVISOR_PROGRESS_HEARTBEAT_HOURS', 'HOOK_ALARM_CAUSE_AWARE_DISABLED']) delete process.env[k];
    jest.restoreAllMocks();
  });
  beforeEach(() => { process.env.SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE = '0'; }); // deterministic: no control draw unless a test asks

  it('a NEW report (progress) whose lane has a live run is HELD: skip, skipReason progress_self_driving, tier meta on the gate row', async () => {
    rows.liveRuns = [{ sessionId: LANE_DRIVE, status: 'queued' }];
    const r = await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false, isAlarmRow: () => false });
    expect(r).toMatchObject({ mode: 'act', skip: true, skipReason: 'progress_self_driving', verdict: { material: true, reasons: ['new_report'], tier: 'progress' }, tiers: { wouldSkip: true, why: 'self_driving', sourceLanes: 1, selfDriving: true, control: false } });
    expect(gateRow()).toMatchObject({ value: 1, meta: { material: true, skipped: true, tier: 'progress', decisionReasons: [], tierWhy: 'self_driving', tierWouldSkip: true, skipReason: 'progress_self_driving', control: false } });
  });

  it('self-driving via a schedule armed within 30 min; an assigned todo ALONE never drives an idle lane (review fix 2026-10-20)', async () => {
    rows.armed = [{ sessionId: LANE_DRIVE }];
    expect((await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false })).skipReason).toBe('progress_self_driving');
    clearWakeLedgerCache(); rows.armed = [];
    // The lane finished, holds an in_progress todo and a dependency-free pending one — nothing queued, nothing armed.
    rows.laneTodos = [{ id: 'todo-now', status: 'in_progress', assigneeChatId: LANE_DRIVE }, { id: 'todo-next', status: 'pending', assigneeChatId: LANE_DRIVE }];
    const idle = await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false });
    expect(idle).toMatchObject({ skip: false, tiers: { why: 'not_self_driving', selfDriving: false } });
  });

  it('review fix 2026-10-20: a source lane the diff lists as STALLED delivers without a lane read', async () => {
    rows.liveRuns = [{ sessionId: LANE_DRIVE, status: 'queued' }]; // a racing queued row must not hide the stall the diff saw
    rows.inProgress = [{ id: 't-stall', title: 'Events DB', assigneeChatId: LANE_DRIVE }];
    rawRows.laneRuns = [{ sessionId: LANE_DRIVE, lastFinished: new Date('2026-10-08T14:00:00Z'), live: false }];
    mockPrisma.agentRun.findMany.mockClear();
    const r = await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false });
    expect(r).toMatchObject({ skip: false, verdict: { tier: 'progress' }, tiers: { wouldSkip: false, why: 'stalled_lane', selfDriving: null } });
    expect(mockPrisma.agentRun.findMany.mock.calls.some((c: any[]) => !c[0]?.where?.OR)).toBe(false);
  });

  it('review fix 2026-10-20: a run summary that asks / names a blocker is DECISION (lane_ask) — never held, even from a lane with a live run', async () => {
    rows.liveRuns = [{ sessionId: LANE_DRIVE, status: 'queued' }];
    const ask = DIGEST('Step 3 done; blocked on the Drive OAuth scope — need a decision before I widen it.');
    const r = await materialGateForHook({ targetChatId: SUP, rows: [report(ask)], alarm: false });
    expect(r).toMatchObject({ skip: false, verdict: { reasons: ['lane_ask'], tier: 'decision', decisionReasons: ['lane_ask'] }, tiers: { why: 'not_progress' } });
  });

  it('a lane NOT driving itself delivers the progress wake (the outcome row labels it)', async () => {
    const r = await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false });
    expect(r).toMatchObject({ skip: false, tiers: { wouldSkip: false, why: 'not_self_driving', selfDriving: false } });
    expect(r.skipReason).toBeUndefined();
  });

  it('DECISION reasons are never gated, even when every lane drives itself', async () => {
    rows.liveRuns = [{ sessionId: LANE_DRIVE, status: 'running' }];
    rawRows.messages = [{ chatId: SUP, createdAt: new Date('2026-10-08T16:00:00Z'), origin: 'user', source: null, head: 'pause the recorder' }];
    const r = await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false });
    expect(r).toMatchObject({ skip: false, verdict: { tier: 'decision', decisionReasons: ['owner_message'] }, tiers: { why: 'not_progress', selfDriving: null } });
  });

  it('the progress heartbeat (8 h) delivers; a lookup error delivers (fail-open)', async () => {
    rows.liveRuns = [{ sessionId: LANE_DRIVE, status: 'running' }];
    mockStore.set(`wake-ledger/${SUP}|hwm`, { at: '2026-10-08T07:00:00.000Z' }); // 9 h 15 min ago
    expect(await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false })).toMatchObject({ skip: false, verdict: { tier: 'progress' }, tiers: { why: 'progress_heartbeat' } });
    clearWakeLedgerCache();
    mockStore.set(`wake-ledger/${SUP}|hwm`, { at: '2026-10-08T15:15:00.000Z' });
    mockPrisma.agentRun.findMany.mockImplementation(async ({ where }: any) => { if (!where?.OR) throw new Error('db down'); return rows.runs; });
    expect(await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false })).toMatchObject({ skip: false, tiers: { why: 'lookup_failed', selfDriving: null } });
    mockPrisma.agentRun.findMany.mockImplementation(async ({ where }: any) => (where?.OR ? rows.runs : where?.status?.in ? rows.liveRuns : rows.runs));
  });

  it('1 in N would-be skips delivers as a CONTROL; the run finalize labels it control:true on supervisor_material_gate_outcome', async () => {
    process.env.SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE = '10';
    jest.spyOn(Math, 'random').mockReturnValue(0.01);
    rows.liveRuns = [{ sessionId: LANE_DRIVE, status: 'queued' }];
    const r = await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false });
    expect(r).toMatchObject({ skip: false, tiers: { wouldSkip: true, control: true } });
    expect(gateRow()?.meta).toMatchObject({ skipped: false, tierWouldSkip: true, control: true });
    await onSupervisorRunFinalized({ chatId: SUP, machineWake: true, failed: false, wakeLedgerAt: NOW_ISO, runStartedAt: Date.parse(NOW_ISO) - 30_000, parts: [] });
    const out = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x.kind === 'supervisor_material_gate_outcome');
    expect(out).toMatchObject({ value: 0, meta: { origin: 'hook', material: true, wouldSkip: false, acted: false, tier: 'progress', tierWouldSkip: true, tierWhy: 'self_driving', control: true } });
  });

  it('shadow mode records the would-skip but delivers (no control draw)', async () => {
    process.env.SUPERVISOR_MATERIAL_GATE_SHADOW = '1';
    process.env.SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE = '1';
    rows.liveRuns = [{ sessionId: LANE_DRIVE, status: 'queued' }];
    expect(await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false })).toMatchObject({ mode: 'shadow', skip: false, tiers: { wouldSkip: true, control: false } });
  });

  it('SUPERVISOR_MATERIAL_TIERS_DISABLED=1: the untiered gate byte-for-byte — delivers, no tier keys on the gate row', async () => {
    process.env.SUPERVISOR_MATERIAL_TIERS_DISABLED = '1';
    rows.liveRuns = [{ sessionId: LANE_DRIVE, status: 'queued' }];
    mockPrisma.agentRun.findMany.mockClear();
    const r = await materialGateForHook({ targetChatId: SUP, rows: [report(DRIVE_1614)], alarm: false });
    expect(r).toMatchObject({ skip: false, verdict: { material: true, reasons: ['new_report'] } });
    expect(r.tiers).toBeUndefined();
    // Review fix 2026-10-20: the verdict object itself carries no tier keys under the switch.
    expect(Object.keys(r.verdict!).sort()).toEqual(['floorHours', 'heartbeat', 'material', 'reasons', 'sinceMin']);
    expect(Object.keys(gateRow()!.meta).sort()).toEqual([
      'agentMessages', 'artifacts', 'floorHours', 'gateSkips', 'hwmSource', 'material', 'mode', 'origin', 'otherLedger', 'ownerAnswers', 'ownerMessages',
      'reasons', 'runsFailed', 'runsFinished', 'schedulesStopped', 'sinceMin', 'skipped', 'stalled', 'statusChanges', 'tickets',
    ]);
    expect(mockPrisma.agentRun.findMany.mock.calls.some((c: any[]) => !c[0]?.where?.OR)).toBe(false); // no lane read at all
  });

  it('a sweep made material only by a PR from a self-driving lane is held; the drain acks a progress-only lane report with the progress wording', async () => {
    rows.receipts = [{ chatId: 'lane-rec', tool: 'open_pull_request', ids: { prNumber: 23 }, createdAt: new Date('2026-10-08T15:50:00Z') }];
    rows.liveRuns = [{ sessionId: 'lane-rec', status: 'running' }];
    expect(await materialGateForSweep({ chatId: SUP })).toMatchObject({ skip: true, skipReason: 'progress_self_driving', verdict: { reasons: ['artifact'] } });
    clearWakeLedgerCache(); rows.receipts = [];
    const dr = await materialGateForDrain({ chatId: SUP, rows: [{ content: '[AGENT-SENT MESSAGE — from chat "Hue recorder" (lane-rec)] Window 3 recorded, 4 files uploaded.' }], sourceChatIds: ['lane-rec'] });
    expect(dr).toMatchObject({ skip: true, skipReason: 'progress_self_driving', verdict: { reasons: ['lane_report'] } });
    expect(await ackMaterialGateDrain({ chatId: SUP, rows: [{ id: 'p1', content: 'Window 3 recorded' }], sourceChatIds: ['lane-rec'], verdict: dr.verdict, skipReason: dr.skipReason })).toBe(true);
    const writes = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data);
    expect(writes[0].content).toMatch(/^\[MATERIAL GATE — 1 queued agent message\(s\) from lane-rec were progress from lanes still driving themselves/);
    expect(writes[0].metadata).toMatchObject({ ackOnly: true, skipReason: 'progress_self_driving' });
    expect(writes[1]).toMatchObject({ content: expect.stringContaining('progress only'), metadata: { kind: 'material_gate_ack', skipReason: 'progress_self_driving' } });
  });

  it('review fix 2026-10-20: a lane QUESTION in the drain is DECISION (lane_ask) — delivered as a turn, never acked, even while the lane runs', async () => {
    rows.liveRuns = [{ sessionId: 'lane-rec', status: 'running' }];
    rows.armed = [{ sessionId: 'lane-rec' }];
    const q = '[AGENT-SENT MESSAGE — from chat "Hue recorder" (lane-rec)] Two options for the migration: A drops the column, B keeps it — which one? I\'ll hold until you answer.';
    const dr = await materialGateForDrain({ chatId: SUP, rows: [{ content: q }], sourceChatIds: ['lane-rec'] });
    expect(dr).toMatchObject({ skip: false, verdict: { reasons: ['lane_ask'], tier: 'decision' }, tiers: { why: 'not_progress' } });
    expect(dr.skipReason).toBeUndefined();
  });
});

describe('SUP-WAKE-TIERS + ALARM-CAUSE-AWARE — the diff', () => {
  afterEach(() => { delete process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED; delete process.env.SUPERVISOR_MATERIAL_TIERS_DISABLED; });
  const since = new Date('2026-10-08T15:15:00Z');

  it('a provider-transient failure whose resume took over is listed resumeQueued (not lane_failed); without a later run, or under the kill switch, it is a plain failure', async () => {
    const killed = { id: 'r1', sessionId: LANE_DRIVE, status: 'failed', startedAt: new Date('2026-10-08T15:30:00Z'), finishedAt: new Date('2026-10-08T15:40:00Z'), error: 'model provider killed the run (transient failure, HTTP 429): rate limited', createdAt: new Date('2026-10-08T15:29:00Z') };
    const resume = { id: 'r2', sessionId: LANE_DRIVE, status: 'queued', startedAt: null, finishedAt: null, error: null, createdAt: new Date('2026-10-08T15:39:50Z') };
    rows.runs = [killed, resume];
    let d = (await computeWakeLedgerDiff(SUP, since, new Date(NOW_ISO)))!;
    expect(d.runsFailed).toEqual([expect.objectContaining({ chatId: LANE_DRIVE, resumeQueued: true })]);
    expect((await materialGateForSweep({ chatId: SUP })).verdict?.reasons).not.toContain('lane_failed');
    clearWakeLedgerCache(); rows.runs = [killed];
    d = (await computeWakeLedgerDiff(SUP, since, new Date(NOW_ISO)))!;
    expect(d.runsFailed[0].resumeQueued).toBeUndefined();
    clearWakeLedgerCache(); rows.runs = [killed, resume];
    process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED = '1';
    d = (await computeWakeLedgerDiff(SUP, since, new Date(NOW_ISO)))!;
    expect(d.runsFailed[0].resumeQueued).toBeUndefined();
  });

  it('a lane-made todo → done carries goalOpenTodos (the open successors left in its goal); tiers off ⇒ no read', async () => {
    rows.activities = [{ action: 'todo.update', metadata: { todoId: 't-done', fromStatus: 'in_progress', toStatus: 'done', actingChatId: 'lane-rec' }, createdAt: new Date('2026-10-08T15:52:00Z') }];
    rows.todoEntities = [{ id: 't-done', title: 'Capture window 3', projectId: 'p1', goalId: 'g1' }];
    rows.goalOpen = [{ goalId: 'g1' }, { goalId: 'g1' }];
    let d = (await computeWakeLedgerDiff(SUP, since, new Date(NOW_ISO)))!;
    expect(d.statusChanges).toEqual([expect.objectContaining({ id: 't-done', to: 'done', goalOpenTodos: 2 })]);
    clearWakeLedgerCache(); rows.goalOpen = [];
    d = (await computeWakeLedgerDiff(SUP, since, new Date(NOW_ISO)))!;
    expect(d.statusChanges[0].goalOpenTodos).toBe(0);
    clearWakeLedgerCache();
    process.env.SUPERVISOR_MATERIAL_TIERS_DISABLED = '1';
    d = (await computeWakeLedgerDiff(SUP, since, new Date(NOW_ISO)))!;
    expect(d.statusChanges[0].goalOpenTodos).toBeUndefined();
  });

  it('the gate-skip transparency line reads BOTH skip statuses', async () => {
    rows.skipped = [{ payload: { sourceChatId: LANE_DRIVE } }];
    const d = (await computeWakeLedgerDiff(SUP, since, new Date(NOW_ISO)))!;
    expect(d.gateSkips).toEqual([{ sourceChatId: LANE_DRIVE, title: 'Drive watch', n: 1 }]);
    const where = mockPrisma.hookEvent.findMany.mock.calls.map((c: any[]) => c[0]?.where).find((w: any) => w?.status);
    expect(where.status).toEqual({ in: ['skipped:no_material_change', 'skipped:progress_self_driving'] });
  });

  it('materialGateForHook: a run_failed a chat STOPPED is a quiet row — no reason of its own; with the kill switch it is an event again', async () => {
    const stopped = { eventType: 'run_failed', payload: { sourceChatId: LANE_DRIVE, summary: 'Coding run cancelled before completion.', cause: 'cancelled', cancelledBy: 'fleet-1' } };
    const isAlarmRow = (row: any) => !row?.payload?.cancelledBy || process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED === '1';
    expect(await materialGateForHook({ targetChatId: SUP, rows: [stopped], alarm: false, isAlarmRow })).toMatchObject({ skip: true, skipReason: 'no_material_change', verdict: { material: false, reasons: [] } });
    clearWakeLedgerCache();
    process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED = '1';
    expect((await materialGateForHook({ targetChatId: SUP, rows: [stopped], alarm: false, isAlarmRow })).verdict?.reasons).toEqual(['alarm']);
  });
});

describe('FLEET-PS-FIRST — the fleet diff leaves PS-covered projects\' progress to their supervisors', () => {
  const FLEET = 'fleet-sup-1';
  const since = new Date('2026-10-08T15:15:00Z');
  const savedProject = mockPrisma.crossModelProject;
  const hooksImpl = mockPrisma.eventHook.findMany.getMockImplementation();
  beforeEach(() => {
    rows.chats = [
      { id: FLEET, userId: 'u1', projectId: null, isSupervisor: true, isProjectSupervisor: false },
      { id: 'lane-p1', title: 'Covered lane', projectId: 'p1', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' },
      { id: 'lane-p2', title: 'Plain lane', projectId: 'p2', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' },
    ];
    rows.runs = [
      { sessionId: 'lane-p1', status: 'completed', startedAt: new Date('2026-10-08T15:20:00Z'), finishedAt: new Date('2026-10-08T15:50:00Z'), error: null },
      { sessionId: 'lane-p1', status: 'failed', startedAt: new Date('2026-10-08T15:55:00Z'), finishedAt: new Date('2026-10-08T16:00:00Z'), error: 'OOM' },
      { sessionId: 'lane-p2', status: 'completed', startedAt: new Date('2026-10-08T15:25:00Z'), finishedAt: new Date('2026-10-08T15:45:00Z'), error: null },
    ];
    rows.receipts = [
      { chatId: 'lane-p1', tool: 'open_pull_request', ids: { prNumber: 41 }, createdAt: new Date('2026-10-08T15:49:00Z') },
      { chatId: 'lane-p2', tool: 'open_pull_request', ids: { prNumber: 42 }, createdAt: new Date('2026-10-08T15:44:00Z') },
    ];
    rows.activities = [
      { action: 'todo.update', metadata: { todoId: 't-p1', fromStatus: 'in_progress', toStatus: 'done', actingChatId: 'lane-p1' }, createdAt: new Date('2026-10-08T15:50:00Z') },
      { action: 'todo.update', metadata: { todoId: 't-p2', fromStatus: 'in_progress', toStatus: 'done', actingChatId: 'lane-p2' }, createdAt: new Date('2026-10-08T15:45:00Z') },
      { action: 'todo.update', metadata: { todoId: 't-p1b', fromStatus: 'pending', toStatus: 'in_progress', actingChatId: 'lane-p1' }, createdAt: new Date('2026-10-08T15:21:00Z') },
    ];
    rows.todoEntities = [
      { id: 't-p1', title: 'covered close', projectId: 'p1', goalId: 'g1' },
      { id: 't-p2', title: 'plain close', projectId: 'p2', goalId: 'g2' },
      { id: 't-p1b', title: 'covered flip', projectId: 'p1', goalId: 'g1' },
    ];
    rows.goalOpen = [{ goalId: 'g1' }, { goalId: 'g2' }]; // work left in both goals ⇒ both closes are progress-tier
    mockPrisma.eventHook.findMany.mockImplementation(async ({ where }: any) => (where?.projectId ? [{ projectId: 'p1' }] : rows.hooks));
    mockPrisma.crossModelProject = { findMany: jest.fn(async ({ where }: any) => (where.id.in.includes('p1') ? [{ id: 'p1' }] : [])) };
    delete process.env.FLEET_DIFF_PS_COVERED_EXCLUDE_DISABLED;
  });
  afterEach(() => {
    mockPrisma.crossModelProject = savedProject;
    mockPrisma.eventHook.findMany.mockImplementation(hooksImpl);
    delete process.env.FLEET_DIFF_PS_COVERED_EXCLUDE_DISABLED;
  });

  it('runs finished, PRs, progress-tier closes and immaterial rows of the covered project are counted in ONE line; failures stay', async () => {
    const d = (await computeWakeLedgerDiff(FLEET, since, new Date(NOW_ISO)))!;
    expect(d.scope).toBe('fleet');
    expect(d.runsFinished.map((r) => r.chatId)).toEqual(['lane-p2']);
    expect(d.runsFailed.map((r) => r.chatId)).toEqual(['lane-p1']); // a failure is never left to anyone
    expect(d.artifacts.map((a) => a.ref)).toEqual(['#42']);
    expect(d.statusChanges.map((c) => c.id)).toEqual(['t-p2']);
    expect(d.otherLedgerChanges).toBe(0);
    expect(d.runsStarted).toBe(1); // lane-p2 only
    expect(d.psCovered).toEqual({ projects: 1, lanes: 1, runsFinished: 1, artifacts: 1, prs: 1, todosDone: 1, other: 1, alarmsDelayed: true });
    const fired = mockPrisma.chatSchedule.count.mock.calls.map((c: any[]) => c[0].where.sessionId.in);
    expect(fired[fired.length - 1]).toEqual(['lane-p2']);
    expect(renderWakeLedgerDiff(d)).toContain('Progress in 1 project(s) with their own project supervisor (1 chat(s)) is left to those supervisors and omitted here: 1 run(s) finished · 1 PR(s) · 1 todo(s) done · 1 other ledger row(s). Their alarms reach you only as a delayed [PS ESCALATION]');
  });

  it('the kill switch restores the full fleet diff', async () => {
    process.env.FLEET_DIFF_PS_COVERED_EXCLUDE_DISABLED = '1';
    const d = (await computeWakeLedgerDiff(FLEET, since, new Date(NOW_ISO)))!;
    expect(d.runsFinished.map((r) => r.chatId).sort()).toEqual(['lane-p1', 'lane-p2']);
    expect(d.artifacts).toHaveLength(2);
    expect(d.psCovered).toBeUndefined();
    expect(renderWakeLedgerDiff(d)).not.toContain('with their own project supervisor');
  });

  it('readPsCoveredProjects: the project toggle, an enabled run_completed project hook and the PS switch; any error ⇒ empty', async () => {
    expect([...(await readPsCoveredProjects('u1'))]).toEqual(['p1']);
    expect(mockPrisma.eventHook.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { userId: 'u1', sourceChatId: null, projectId: { not: null }, enabled: true, eventTypes: { has: 'run_completed' } } }));
    mockPrisma.eventHook.findMany.mockRejectedValueOnce(new Error('db down'));
    expect((await readPsCoveredProjects('u1')).size).toBe(0);
  });
});

// ── LANE-IDLE-WAKE (2026-10-20): the widened stall signal ────────────────────
describe('computeWakeLedgerDiff — LANE-IDLE-WAKE widened stalledLanes', () => {
  const since = new Date('2026-10-08T15:15:00Z');
  const now = new Date(NOW_ISO);
  const min = (m: number) => new Date(now.getTime() - m * 60_000);
  afterEach(() => { delete process.env.LANE_IDLE_WAKE_DISABLED; });
  beforeEach(() => { mockPrisma.projectTodo.findMany.mockClear(); mockPrisma.chatSchedule.findMany.mockClear(); mockPrisma.crossModelChat.findMany.mockClear(); });
  const arrange = () => {
    rows.chats.push({ id: 'lane-new', title: 'New lane', projectId: 'p1', isSupervisor: false, isProjectSupervisor: false, userId: 'u1' });
    rows.inProgress = [
      { id: 't-pend', title: 'Backfill', assigneeChatId: LANE_DRIVE, status: 'pending', updatedAt: min(200) },
      { id: 't-wait', title: 'Waits on schema', assigneeChatId: 'lane-rec', status: 'pending', updatedAt: min(200) },
      { id: 't-new', title: 'Schema', assigneeChatId: 'lane-new', status: 'in_progress', updatedAt: min(45) },
    ];
    rows.deps = [{ todoId: 't-wait', dependsOnTodoId: 'dep-open' }];
    rows.depTargets = [{ id: 'dep-open', status: 'in_progress' }];
    rawRows.laneRuns = [{ sessionId: LANE_DRIVE, lastFinished: min(90), live: false }];
  };

  const todoReads = () => mockPrisma.projectTodo.findMany.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a?.where?.userId && a?.where?.assigneeChatId?.in);
  const inFuture = (m: number) => new Date(now.getTime() + m * 60_000);

  it('dependency-free PENDING work stalls a lane; a pending todo waiting on an open dependency does not; a coding lane that never ran is stalled from its todo', async () => {
    arrange();
    const d = (await computeWakeLedgerDiff(SUP, since, now))!;
    expect(d.stalledLanes).toEqual([
      { chatId: 'lane-new', title: 'New lane', todoId: 't-new', todoTitle: 'Schema', idleMin: 45, neverStarted: true },
      { chatId: LANE_DRIVE, title: 'Drive watch', todoId: 't-pend', todoTitle: 'Backfill', idleMin: 90, todoStatus: 'pending' },
    ]);
    const armedQuery = mockPrisma.chatSchedule.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.enabled);
    expect(armedQuery.where).toEqual({ sessionId: { in: expect.any(Array) }, enabled: true });
    expect(armedQuery.select).toEqual({ sessionId: true, nextRunAt: true, kind: true, intervalSec: true });
    const codingRead = mockPrisma.crossModelChat.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.codingState);
    expect(codingRead.where).toEqual({ id: { in: ['lane-new'] }, codingState: { isNot: null } });
  });

  it('review fix: TWO todo reads scoped to the scope chats, in_progress first, each with its own cap — a pending backlog never crowds out an in_progress stall; a hit cap names "stalled lanes"', async () => {
    arrange();
    const d = (await computeWakeLedgerDiff(SUP, since, now))!;
    const reads = todoReads();
    expect(reads.map((r: any) => r.where.status)).toEqual(['in_progress', 'pending']);
    for (const r of reads) {
      expect(r.where.assigneeChatId.in).toEqual(expect.arrayContaining([LANE_DRIVE, 'lane-rec', 'lane-new']));
      expect(r.where.assigneeChatId.in).not.toContain(SUP);
      expect(r.orderBy).toEqual({ updatedAt: 'asc' });
      expect(r.take).toBe(100);
    }
    expect(d.truncated ?? []).not.toContain('stalled lanes');
    // 100+ pending rows on the page: the in_progress stall is still seen, and the bound is named.
    clearWakeLedgerCache();
    rows.inProgress = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `t-back${i}`, title: 'Backlog', assigneeChatId: 'lane-rec', status: 'pending', updatedAt: min(300) })),
      { id: 't-new', title: 'Schema', assigneeChatId: 'lane-new', status: 'in_progress', updatedAt: min(45) },
    ];
    rows.deps = rows.inProgress.filter((t: any) => t.status === 'pending').map((t: any) => ({ todoId: t.id, dependsOnTodoId: 'dep-open' }));
    const d2 = (await computeWakeLedgerDiff(SUP, since, now))!;
    expect(d2.stalledLanes.map((s) => s.todoId)).toEqual(['t-new']);
    expect(d2.truncated).toContain('stalled lanes');
  });

  it('only a schedule that ARMS the lane counts: due within 2 h, or a recurring row within 1.5× its interval; a one-shot tomorrow does not (same rule as the lane-idle wake)', async () => {
    arrange();
    rows.armed = [
      { sessionId: LANE_DRIVE, nextRunAt: inFuture(20 * 60), kind: 'recurring', intervalSec: 86_400 }, // daily cadence ⇒ armed
      { sessionId: 'lane-new', nextRunAt: inFuture(20 * 60), kind: 'once', intervalSec: null }, // a check armed for tomorrow ⇒ not armed
    ];
    expect((await computeWakeLedgerDiff(SUP, since, now))!.stalledLanes.map((s) => s.chatId)).toEqual(['lane-new']);
    clearWakeLedgerCache();
    rows.armed = [{ sessionId: LANE_DRIVE, nextRunAt: inFuture(50), kind: 'recurring', intervalSec: 3600 }, { sessionId: 'lane-new', nextRunAt: inFuture(100), kind: 'once', intervalSec: null }];
    expect((await computeWakeLedgerDiff(SUP, since, now))!.stalledLanes).toEqual([]);
  });

  it('LANE_IDLE_WAKE_DISABLED=1 restores the in_progress-only, any-schedule, run-row-required shape', async () => {
    process.env.LANE_IDLE_WAKE_DISABLED = '1';
    arrange();
    rows.inProgress = rows.inProgress.filter((t: any) => t.status === 'in_progress');
    const d = (await computeWakeLedgerDiff(SUP, since, now))!;
    expect(d.stalledLanes).toEqual([]); // lane-new never ran ⇒ not seen (pre-change)
    const todoQuery = mockPrisma.projectTodo.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.assigneeChatId?.not === null);
    expect(todoQuery.where.status).toBe('in_progress');
    expect(todoReads()).toEqual([]);
    const armedQuery = mockPrisma.chatSchedule.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.enabled);
    expect(armedQuery.where.nextRunAt).toBeUndefined();
    expect(armedQuery.select).toEqual({ sessionId: true });
  });
});

describe('owner-turn surface (FS context map 2026-10-22, gap #3) — the diff on an OWNER turn never moves the mark', () => {
  it('same rows under [SINCE YOUR LAST NOTE — harness diff], its own metric kind, no store write; the owner turn\'s finalize leaves the mark', async () => {
    rawRows.messages = [{ chatId: SUP, createdAt: new Date('2026-10-08T15:47:00Z'), origin: null, source: null, head: 'record all 4 cameras for 30 min' }];
    const wake = await buildWakeLedgerBlock(SUP, new Date(NOW_ISO));
    clearWakeLedgerCache();
    mockRecordLoopMetric.mockClear();
    const owner = await buildWakeLedgerBlock(SUP, new Date(NOW_ISO), { ownerTurn: true });
    expect(owner!.block.startsWith('[SINCE YOUR LAST NOTE — harness diff 2026-10-08T15:15Z → 2026-10-08T16:15Z (60 min, since your last completed wake)')).toBe(true);
    expect(owner!.block).toContain('record all 4 cameras for 30 min');
    expect(owner!.block).not.toContain('[SINCE YOUR LAST WAKE');
    expect(owner!.block.split('\n').slice(1)).toEqual(wake!.block.split('\n').slice(1));
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]?.kind)).toEqual(['supervisor_owner_ledger_diff']);
    expect(mockStorePut).not.toHaveBeenCalled();
    // The chat-agent hands an owner turn's finalize machineWake:false and no wakeLedgerAt.
    await onSupervisorRunFinalized({ chatId: SUP, machineWake: false, failed: false, wakeLedgerAt: null, runStartedAt: Date.now(), parts: [] });
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockStore.get(`wake-ledger/${SUP}|hwm`)).toEqual({ at: '2026-10-08T15:15:00.000Z' });
    // …so the next machine wake still reads every event the owner turn saw.
    clearWakeLedgerCache();
    const next = await buildWakeLedgerBlock(SUP, new Date(NOW_ISO));
    expect(next!.since).toBe('2026-10-08T15:15:00.000Z');
    expect(next!.block).toContain('record all 4 cameras for 30 min');
  });
});

describe('review 2026-10-23 (privacy) — a ghost chat and another user\'s chat never reach the project supervisor\'s diff (both surfaces)', () => {
  const surfaces = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const opts of [{}, { ownerTurn: true }]) {
      clearWakeLedgerCache();
      out.push((await buildWakeLedgerBlock(SUP, new Date(NOW_ISO), opts))?.block ?? '');
    }
    return out;
  };

  it('a ghost chat in the folder: no title, no head, no wake trigger; a member\'s chat in a shared folder: no typed words in the owner\'s supervisor', async () => {
    rows.chats.push(
      { id: 'ghost-ch', title: 'my private divorce question', projectId: 'p1', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', ghostMode: true },
      { id: 'member-ch', title: 'member lane', projectId: 'p1', isSupervisor: false, isProjectSupervisor: false, userId: 'u2' },
    );
    rawRows.messages = [
      { chatId: 'ghost-ch', createdAt: new Date('2026-10-08T16:00:00Z'), origin: null, source: null, head: 'my private divorce question: how do I hide assets from my spouse' },
      { chatId: 'member-ch', createdAt: new Date('2026-10-08T15:58:00Z'), origin: null, source: null, head: 'MEMBER_TYPED my salary is 140k' },
      { chatId: 'lane-rec', createdAt: new Date('2026-10-08T15:50:00Z'), origin: null, source: null, head: 'record 30 minutes per camera' },
    ];
    const d = (await computeWakeLedgerDiff(SUP, new Date('2026-10-08T15:15:00Z'), new Date(NOW_ISO)))!;
    const scopeWhere = mockPrisma.crossModelChat.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.id?.not === SUP)?.where;
    expect(scopeWhere).toMatchObject({ ghostMode: false });
    expect(d.ownerMessages.map((m) => m.chatId)).toEqual(['lane-rec']);
    for (const block of await surfaces()) {
      expect(block).not.toContain('divorce');
      expect(block).not.toContain('ghost-ch');
      expect(block).not.toContain('MEMBER_TYPED');
      expect(block).toContain('record 30 minutes per camera');
    }
  });
});

describe('round-3 review (H item 1) — the ledger diff never carries a credential an owner or agent message pasted (both surfaces)', () => {
  const KEY = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAB7CD0EF3GH6';
  /** A Z.ai-shaped key: a fragment of it (the hex half without the `.` + 16) matches no pattern — the clip-edge case. */
  const ZAI = '0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp';
  const msgAt = (m: number) => new Date(Date.parse('2026-10-08T15:15:00Z') + m * 60_000);
  const surfaces = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const opts of [{}, { ownerTurn: true }]) {
      clearWakeLedgerCache();
      out.push((await buildWakeLedgerBlock(SUP, new Date(NOW_ISO), opts))!.block);
    }
    return out;
  };

  it('owner heads (this chat + a lane) and agent heads are redacted BEFORE the 120 / 100-char clip — a key straddling the clip is redacted whole', async () => {
    rawRows.messages = [
      { chatId: SUP, createdAt: msgAt(30), origin: 'user', source: null, head: `MARK_OWN use ${KEY} for the gateway` },
      // 99 chars of collapsed "w w …" then the key: the 120-char clip cuts it after its first 19 chars.
      { chatId: 'lane-rec', createdAt: msgAt(20), origin: null, source: null, head: `${'w '.repeat(50)}${ZAI} MARK_LANE` },
      { chatId: SUP, createdAt: msgAt(10), origin: 'agent', source: 'lane-rec', head: `[AGENT-SENT MESSAGE — from chat "Hue recorder" (lane-rec)] MARK_AGENT relaying ${KEY} as asked` },
    ];
    for (const block of await surfaces()) {
      expect(block).toContain('MARK_OWN');
      expect(block).toContain('MARK_AGENT');
      expect(block).not.toContain('sk-proj');
      expect(block).not.toContain('0123456789abcdef');
      expect(block).toContain('[REDACTED: looked like a credential]');
    }
  });

  it('a credential the 400-char head cuts is redacted WHOLE (the read is wider than the head) — one token or several; a whole 400-char head keeps its last word', async () => {
    // Each owner message is a short head + whitespace + a credential that straddles char 400; collapsed, the
    // whitespace brings what is left of it inside the 120-char render.
    rawRows.messages = [
      // 2 + 360 newlines + the Z.ai key: char 400 falls after "…abcdef.AbCde".
      { chatId: SUP, createdAt: msgAt(30), origin: 'user', source: null, content: `ok${'\n'.repeat(360)}${ZAI} MARK_TAIL_1` },
      // Re-review (2026-10-23): a SEVERAL-token credential — the context-gated spaced Gmail app password. Char 400 falls
      // inside "mnop": dropping the cut token left "abcd efgh ijkl", which no longer matches the 16-letter shape.
      { chatId: SUP, createdAt: msgAt(25), origin: 'user', source: null, content: `x${'\n'.repeat(362)}gmail app password: abcd efgh ijkl mnop` },
      // …and a message longer than the whole read: the wider read still redacts the key that straddles char 400.
      { chatId: SUP, createdAt: msgAt(22), origin: 'user', source: null, content: `y${'\n'.repeat(380)}smtp secret qwer tyui opas dfgh ${'z'.repeat(2000)}` },
      { chatId: SUP, createdAt: msgAt(20), origin: 'user', source: null, content: `MARK_WHOLE${' '.repeat(382)}lastword` },
    ];
    for (const block of await surfaces()) {
      expect(block).not.toContain('0123456789abcdef');
      expect(block).not.toContain('AbCde');
      expect(block).not.toMatch(/abcd|efgh|ijkl|mnop/);
      expect(block).not.toMatch(/qwer|tyui|opas|dfgh/);
      expect(block).toContain('gmail app password: [REDACTED');
      expect(block).toContain('lastword');
    }
    const sql = mockPrisma.$queryRawUnsafe.mock.calls.map((c: any[]) => String(c[0])).find((q: string) => /AS head/.test(q))!;
    expect(sql).toMatch(/LEFT\(content, 912\) AS head/);
    expect(sql).toMatch(/char_length\(content\) > 912 AS cut/);
  });

  it('ledgerSafeHead: redacts the read window, then cuts at 400 on a token boundary (a cut token is dropped whole; a redaction note is kept whole)', () => {
    const app = `x${'\n'.repeat(362)}gmail app password: abcd efgh ijkl mnop`;
    const out = ledgerSafeHead(app, false);
    expect(out).not.toMatch(/abcd|efgh|ijkl|mnop/);
    expect(out).toContain('gmail app password: [REDACTED: looked like a credential] …');
    // A read the SQL cut: its last token may be a partial credential and nothing past it was read — it is dropped.
    expect(ledgerSafeHead(`short head then a cut sk-proj-Ab3dEf`, true)).toBe('short head then a cut …');
    // A token that straddles char 400 is dropped, never shown in part.
    const straddle = `${'a '.repeat(198)}TOKEN_STRADDLING_THE_EDGE tail`;
    expect(ledgerSafeHead(straddle, false)).toBe(`${'a '.repeat(198).trimEnd()} …`);
    // Whole and short: unchanged.
    expect(ledgerSafeHead('plain owner note', false)).toBe('plain owner note');
  });

  it('renderWakeLedgerDiff itself redacts before it clips (a diff built by any caller)', () => {
    const d = { ...emptyWakeLedgerDiff(SUP, new Date('2026-10-08T15:15:00Z'), new Date(NOW_ISO), 'project', 'p1') };
    d.ownerMessages = [{ chatId: SUP, at: '2026-10-08T15:40:00.000Z', head: `${'w '.repeat(50)}${ZAI} tail`, self: true }];
    d.agentMessages = [{ fromChatId: 'lane-rec', at: '2026-10-08T15:41:00.000Z', head: `${'v '.repeat(40)}${ZAI} tail` }];
    for (const ownerTurn of [false, true]) {
      const text = renderWakeLedgerDiff(d, { floorHours: 4, ownerTurn });
      expect(text).not.toContain('0123456789abcdef');
      expect(text).toContain('[REDACTED');
    }
  });
});

/**
 * intervention-outcomes pins (supervisor SOTA round 2, 2026-10-20 —
 * INTERVENTION-OUTCOMES). Pure: the receipt → lane-intervention collapse (the
 * live-run flag, the `answer` kind, no-op receipts dropped), the conservative
 * AND symmetric label (progressed / repeated / ran_no_artifact / no_run / null
 * with a reason — the in-flight, truncation and confound rules treat a window
 * with and without an artifact the same way), repeat + artifact attribution,
 * the lever-yield tally and the ≤ 1,200-char block. DB (mocked prisma): the
 * finalize capture writes one row per coding lane (never a supervisor, never a
 * missing chat), the cron reads only the runs that can matter, resolves an
 * artifact's run by id, labels due rows once per horizon, retries a failed
 * read and records pairs that age out unlabelled, the wake block waits for a
 * week of observation, and both kill switches silence their part.
 */
const mockPrisma: any = {
  loopMetric: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  agentRun: { findMany: jest.fn(async () => []) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []) },
};
const mockRecordLoopMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { SUPERVISOR_INTERVENTION: 'supervisor_intervention', SUPERVISOR_INTERVENTION_OUTCOME: 'supervisor_intervention_outcome' },
}));
// The wake ledger's user-row classifier (same rule: agent / machine origin, else a harness-shaped head, else owner).
jest.mock('./supervisor-wake-ledger', () => ({
  __esModule: true,
  classifyUserRow: (content: string, origin: string | null | undefined) =>
    origin === 'agent' ? 'agent' : origin && origin !== 'user' ? 'machine' : /^\s*\[(MACHINE-TRIGGERED RUN|AGENT-SENT MESSAGE)/i.test(content) ? 'machine' : 'owner',
}));

import {
  activeRunSplit, aggregateLeverYield, attributeArtifacts, buildInterventionOutcomesBlock, confoundWindowEnd, interventionCandidatesFromReceipts,
  judgeInterventionOutcome, leverActsOnLiveRun, receiptIsNoop, recordSupervisorInterventions, renderInterventionOutcomesBlock, repeatFacts,
  runInterventionOutcomesOnce, tentativeInterventionOutcome,
  BLOCK_MAX_CHARS, INTERVENTION_BLOCK_HEADER, MAX_INTERVENTIONS_PER_TURN, MAX_RUNS_PER_WINDOW, OUTCOMES_BATCH, REPEAT_MIN_GAP_MS,
  type InterventionOutcomeFacts, type InterventionRow, type OutcomeRowLite,
} from './intervention-outcomes';

const NOW = new Date('2026-10-20T12:00:00Z');
const H = 3600_000;
const SUP = 'sup-chat-0001';
const LANE = 'lane-chat-0001';

const facts = (o: Partial<InterventionOutcomeFacts> = {}): InterventionOutcomeFacts => ({
  targetFound: true, firstArtifactAt: null, artifacts: 0, inFlightArtifacts: 0, runs: 0, inFlightRuns: 0, runsTruncated: false,
  firstRepeatAt: null, confounded: null, archivedInWindow: false, ...o,
});
/** The two-step owner read: metadata rows first, then the text of the untagged ids. */
const routeMessages = (rows: Array<{ id: string; content: string; metadata: unknown }>) => {
  mockPrisma.crossModelMessage.findMany.mockImplementation(async (q: any) => (q?.where?.id ? rows.filter((r) => q.where.id.in.includes(r.id)) : rows));
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED;
  delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_BLOCK_DISABLED;
  process.env.SUPERVISOR_INTERVENTION_OUTCOMES_IN_TEST = '1';
  mockPrisma.loopMetric.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.loopMetric.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.crossModelChat.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.agentRun.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.runToolReceipt.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.crossModelMessage.findMany.mockReset().mockResolvedValue([]);
});
afterAll(() => { delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_IN_TEST; });

describe('interventionCandidatesFromReceipts (pure)', () => {
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
  it('keeps ok lever receipts aimed at another chat, one per lane — the strongest kind, every tool, the FIRST receipt id and time', () => {
    const out = interventionCandidatesFromReceipts([
      { id: 'r1', tool: 'send_chat_message', ok: true, ids: { chatId: LANE }, runId: 'chat-t1', createdAt: at(0) },
      { id: 'r2', tool: 'start_coding_session', ok: true, ids: { sessionId: 'lane-new' }, runId: 'chat-t1', createdAt: at(1) },
      { id: 'r3', tool: 'schedule_message', ok: true, ids: { scheduleId: 's1', chatId: LANE }, runId: 'chat-t1', createdAt: at(2) },
      { id: 'r4', tool: 'dispatch_platform_task', ok: true, ids: { laneChatId: 'lane-dispatch' }, runId: 'chat-t1', createdAt: at(3) },
    ], SUP, NOW);
    expect(out).toEqual([
      { targetChatId: LANE, kind: 'steer', tools: ['send_chat_message', 'schedule_message'], receiptId: 'r1', turnId: 'chat-t1', at: at(0).toISOString(), liveRun: false },
      { targetChatId: 'lane-new', kind: 'spawn', tools: ['start_coding_session'], receiptId: 'r2', turnId: 'chat-t1', at: at(1).toISOString(), liveRun: false },
      { targetChatId: 'lane-dispatch', kind: 'spawn', tools: ['dispatch_platform_task'], receiptId: 'r4', turnId: 'chat-t1', at: at(3).toISOString(), liveRun: false },
    ]);
  });
  it('a later stronger lever on the same lane upgrades the kind (answer → schedule → steer → spawn never downgrades); a live lever marks the row liveRun', () => {
    const out = interventionCandidatesFromReceipts([
      { id: 'a', tool: 'update_schedule', ok: true, ids: { scheduleId: 's', chatId: LANE }, createdAt: at(0) },
      { id: 'b', tool: 'answer_chat_question', ok: true, ids: { chatId: LANE, questionId: 'q' }, createdAt: at(1) },
      { id: 'c', tool: 'resume_schedule', ok: true, ids: { scheduleId: 's', chatId: LANE }, createdAt: at(2) },
    ], SUP, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'schedule', receiptId: 'a', liveRun: true, tools: ['update_schedule', 'answer_chat_question', 'resume_schedule'] });
    const steered = interventionCandidatesFromReceipts([
      { id: 'a', tool: 'approve_request', ok: true, ids: { chatId: LANE, approvalId: 'p' }, createdAt: at(0) },
      { id: 'b', tool: 'send_chat_message', ok: true, ids: { chatId: LANE, delivery: 'steer' }, createdAt: at(1) },
    ], SUP, NOW);
    expect(steered[0]).toMatchObject({ kind: 'steer', receiptId: 'a', liveRun: true });
  });
  it('a turn that only answered the lane\'s own question / request is the `answer` lever, acting on the live run', () => {
    expect(interventionCandidatesFromReceipts([
      { id: 'a', tool: 'answer_chat_question', ok: true, ids: { chatId: LANE, questionId: 'q' }, createdAt: at(0) },
      { id: 'b', tool: 'approve_request', ok: true, ids: { chatId: LANE, approvalId: 'p' }, createdAt: at(1) },
    ], SUP, NOW)).toEqual([{ targetChatId: LANE, kind: 'answer', tools: ['answer_chat_question', 'approve_request'], receiptId: 'a', turnId: null, at: at(0).toISOString(), liveRun: true }]);
  });
  it('leverActsOnLiveRun: answers / approvals always; a send only when the envelope says it was steered into the active run', () => {
    expect(leverActsOnLiveRun('answer_chat_question', { chatId: LANE })).toBe(true);
    expect(leverActsOnLiveRun('approve_request', { chatId: LANE })).toBe(true);
    expect(leverActsOnLiveRun('send_chat_message', { chatId: LANE, delivery: 'steer' })).toBe(true);
    expect(leverActsOnLiveRun('send_chat_message', { chatId: LANE })).toBe(false); // started a new run
    expect(leverActsOnLiveRun('send_chat_message', { chatId: LANE, position: '1' })).toBe(false); // queued behind the run
    expect(leverActsOnLiveRun('schedule_message', { chatId: LANE })).toBe(false);
    expect(leverActsOnLiveRun('start_coding_session', { sessionId: LANE })).toBe(false);
  });
  it('a no-op receipt (delivered "already", changed false) is not an intervention; a head without the flag still counts', () => {
    expect(receiptIsNoop('{ "ok": true, "tool": "answer_chat_question", "ids": { "chatId": "x", "questionId": "q" }, "delivered": "already", "message": "…"')).toBe(true);
    expect(receiptIsNoop('{ "ok": true, "tool": "resume_schedule", "ids": { "scheduleId": "s" }, "chatId": "x", "changed": false')).toBe(true);
    expect(receiptIsNoop('{ "ok": true, "tool": "answer_chat_question", "ids": { "chatId": "x" }, "delivered": "live"')).toBe(false);
    expect(receiptIsNoop(undefined)).toBe(false);
    expect(interventionCandidatesFromReceipts([
      { id: 'a', tool: 'answer_chat_question', ok: true, ids: { chatId: LANE, questionId: 'q' }, resultHead: '{ "ok": true, "delivered": "already" }', createdAt: at(0) },
      { id: 'b', tool: 'approve_request', ok: true, ids: { chatId: 'lane-2', approvalId: 'p' }, resultHead: '{ "ok": true, "decision": "allow", "delivered": "live" }', createdAt: at(1) },
    ], SUP, NOW).map((c) => c.targetChatId)).toEqual(['lane-2']);
  });
  it('drops refused / staged receipts, self-targets (an own wake, a self-send), halt levers, non-levers and receipts without a lane id', () => {
    expect(interventionCandidatesFromReceipts([
      { id: 'x1', tool: 'send_chat_message', ok: false, ids: { chatId: LANE } },
      { id: 'x2', tool: 'send_chat_message', ok: true, ids: { chatId: LANE, staged: true } },
      { id: 'x3', tool: 'schedule_message', ok: true, ids: { chatId: SUP } },
      { id: 'x4', tool: 'stop_run', ok: true, ids: { chatId: LANE } },
      { id: 'x5', tool: 'pause_schedule', ok: true, ids: { scheduleId: 's', chatId: LANE } },
      { id: 'x6', tool: 'goal_update', ok: true, ids: { goalId: 'g' } },
      { id: 'x7', tool: 'resume_schedule', ok: true, ids: { scheduleId: 's' } }, // a moot resume carries no chatId
      null, 'junk',
    ], SUP, NOW)).toEqual([]);
    expect(interventionCandidatesFromReceipts(undefined, SUP)).toEqual([]);
  });
  it('caps one turn at MAX_INTERVENTIONS_PER_TURN lanes', () => {
    const many = Array.from({ length: MAX_INTERVENTIONS_PER_TURN + 5 }, (_, i) => ({ id: `r${i}`, tool: 'send_chat_message', ok: true, ids: { chatId: `lane-${i}` } }));
    expect(interventionCandidatesFromReceipts(many, SUP, NOW)).toHaveLength(MAX_INTERVENTIONS_PER_TURN);
  });
});

describe('judgeInterventionOutcome (pure, conservative)', () => {
  it('progressed needs an attributable artifact before any repeat and nobody else acting first', () => {
    expect(judgeInterventionOutcome(facts({ firstArtifactAt: 100, artifacts: 1, runs: 1 }))).toEqual({ outcome: 'progressed', reason: null });
    expect(judgeInterventionOutcome(facts({ firstArtifactAt: 100, firstRepeatAt: 200 }))).toEqual({ outcome: 'progressed', reason: null });
    expect(judgeInterventionOutcome(facts({ firstArtifactAt: 100, confounded: 'owner' }))).toEqual({ outcome: null, reason: 'owner_confounded' });
    expect(judgeInterventionOutcome(facts({ firstArtifactAt: 100, confounded: 'other_supervisor' }))).toEqual({ outcome: null, reason: 'other_supervisor_confounded' });
  });
  it('a repeat before any attributable artifact is "repeated" (later progress belongs to the repeat)', () => {
    expect(judgeInterventionOutcome(facts({ firstRepeatAt: 100, runs: 2 }))).toEqual({ outcome: 'repeated', reason: null });
    expect(judgeInterventionOutcome(facts({ firstRepeatAt: 100, firstArtifactAt: 200 }))).toEqual({ outcome: 'repeated', reason: null });
  });
  it('artifacts only from work already in flight, a gone lane, or an archived lane are ambiguous (null + reason)', () => {
    expect(judgeInterventionOutcome(facts({ targetFound: false }))).toEqual({ outcome: null, reason: 'target_missing' });
    expect(judgeInterventionOutcome(facts({ inFlightArtifacts: 2, runs: 1 }))).toEqual({ outcome: null, reason: 'in_flight_run' });
    expect(judgeInterventionOutcome(facts({ archivedInWindow: true, runs: 1 }))).toEqual({ outcome: null, reason: 'target_archived' });
  });
  it('otherwise ran_no_artifact when an attributable run ran, no_run when nothing ran', () => {
    expect(judgeInterventionOutcome(facts({ runs: 3 }))).toEqual({ outcome: 'ran_no_artifact', reason: null });
    expect(judgeInterventionOutcome(facts())).toEqual({ outcome: 'no_run', reason: null });
  });
  it('SYMMETRIC in-flight rule: a window whose only run was already in flight (the lever did not act on it) is null with or without an artifact', () => {
    expect(judgeInterventionOutcome(facts({ inFlightRuns: 1, inFlightArtifacts: 1 }))).toEqual({ outcome: null, reason: 'in_flight_run' });
    expect(judgeInterventionOutcome(facts({ inFlightRuns: 1 }))).toEqual({ outcome: null, reason: 'in_flight_run' });
    // an attributable run that ran empty beside it is still a negative
    expect(judgeInterventionOutcome(facts({ inFlightRuns: 1, runs: 1 }))).toEqual({ outcome: 'ran_no_artifact', reason: null });
  });
  it('a truncated run read never yields "no attributable run" — but an attributable run it did return still proves the lane ran', () => {
    expect(judgeInterventionOutcome(facts({ runsTruncated: true }))).toEqual({ outcome: null, reason: 'run_window_truncated' });
    expect(judgeInterventionOutcome(facts({ runsTruncated: true, inFlightRuns: 100 }))).toEqual({ outcome: null, reason: 'run_window_truncated' });
    expect(judgeInterventionOutcome(facts({ runsTruncated: true, runs: 40 }))).toEqual({ outcome: 'ran_no_artifact', reason: null });
    expect(judgeInterventionOutcome(facts({ runsTruncated: true, firstArtifactAt: 5, artifacts: 1 }))).toEqual({ outcome: 'progressed', reason: null });
  });
  it('SYMMETRIC confounds: the owner / another supervisor acting nulls EVERY label it would have given — negative ones included', () => {
    expect(judgeInterventionOutcome(facts({ runs: 2, confounded: 'owner' }))).toEqual({ outcome: null, reason: 'owner_confounded' });
    expect(judgeInterventionOutcome(facts({ confounded: 'other_supervisor' }))).toEqual({ outcome: null, reason: 'other_supervisor_confounded' });
    expect(judgeInterventionOutcome(facts({ firstRepeatAt: 100, confounded: 'owner' }))).toEqual({ outcome: null, reason: 'owner_confounded' });
    // an already-null label keeps its own reason
    expect(judgeInterventionOutcome(facts({ inFlightRuns: 1, confounded: 'owner' }))).toEqual({ outcome: null, reason: 'in_flight_run' });
    expect(tentativeInterventionOutcome(facts({ runs: 2, confounded: 'owner' }))).toEqual({ outcome: 'ran_no_artifact', reason: null });
  });
  it('confoundWindowEnd: up to the first artifact, up to the repeat, else the whole window (inclusive end)', () => {
    expect(confoundWindowEnd('progressed', { firstArtifactAt: 50, firstRepeatAt: null }, 1000)).toBe(50);
    expect(confoundWindowEnd('repeated', { firstArtifactAt: null, firstRepeatAt: 70 }, 1000)).toBe(70);
    expect(confoundWindowEnd('ran_no_artifact', { firstArtifactAt: null, firstRepeatAt: null }, 1000)).toBe(1001);
    expect(confoundWindowEnd('no_run', { firstArtifactAt: null, firstRepeatAt: null }, 1000)).toBe(1001);
  });
});

describe('repeatFacts / attributeArtifacts / activeRunSplit (pure)', () => {
  const ir = (o: Partial<InterventionRow> & Pick<InterventionRow, 'key' | 'at'>): InterventionRow => ({ supervisorChatId: SUP, targetChatId: LANE, turnId: null, kind: 'steer', liveRun: false, ...o });
  const self = ir({ key: 'k0', at: 1_000_000, turnId: 't0' });
  it('a repeat is a LATER turn of the same supervisor on the same lane, ≥ 5 min later, inside the window; another supervisor is a confound', () => {
    const end = self.at + 24 * H;
    const r = repeatFacts(self, [
      self,
      ir({ key: 'k1', at: self.at + 60_000, turnId: 't0' }), // same turn
      ir({ key: 'k2', at: self.at + REPEAT_MIN_GAP_MS - 1, turnId: 't1' }), // too close
      ir({ key: 'k3', at: self.at + 2 * H, turnId: 't2' }),
      ir({ key: 'k4', at: self.at + H, turnId: 't3' }),
      ir({ key: 'k5', at: end + 1, turnId: 't4' }), // past the window
      ir({ key: 'k6', supervisorChatId: 'other-sup', at: self.at + 30 * 60_000, turnId: 'u1' }),
      ir({ key: 'k7', targetChatId: 'lane-other', at: self.at + H, turnId: 't5' }),
      ir({ key: 'k8', at: self.at - H, turnId: 't6' }), // earlier
    ], end);
    expect(r).toEqual({ firstRepeatAt: self.at + H, otherSupervisorAts: [self.at + 30 * 60_000] });
  });
  it('answering the lane\'s own question / request later is never a repeat of the earlier lever (another supervisor\'s answer is still a confound)', () => {
    const end = self.at + 24 * H;
    expect(repeatFacts(self, [
      ir({ key: 'a1', at: self.at + H, turnId: 't1', kind: 'answer', liveRun: true }),
      ir({ key: 'a2', supervisorChatId: 'other-sup', at: self.at + 2 * H, turnId: 'u1', kind: 'answer', liveRun: true }),
      ir({ key: 's1', at: self.at + 3 * H, turnId: 't2', kind: 'schedule' }),
    ], end)).toEqual({ firstRepeatAt: self.at + 3 * H, otherSupervisorAts: [self.at + 2 * H] });
  });
  it('an artifact counts only when its run started at/after the intervention (5 s slack); an in-flight or unresolvable run is ambiguous', () => {
    const at = 10 * H;
    const runs = [
      { id: 'before', createdAt: new Date(at - H), startedAt: new Date(at - H) },
      { id: 'after', createdAt: new Date(at + 60_000), startedAt: new Date(at + 120_000) },
      { id: 'skew', createdAt: new Date(at - 3_000), startedAt: null },
    ];
    const artifacts = [
      { runId: 'before', createdAt: new Date(at + 10_000) },
      { runId: null, createdAt: new Date(at + 20_000) },
      { runId: 'gone', createdAt: new Date(at + 30_000) },
      { runId: 'after', createdAt: new Date(at + 3 * H) },
      { runId: 'skew', createdAt: new Date(at + 2 * H) },
    ];
    expect(attributeArtifacts(at, artifacts, runs)).toEqual({ firstArtifactAt: at + 2 * H, attributable: 2, inFlight: 3 });
    // a live-run lever (a steer into it, an answer it waited on) owns the run it acted on; unresolvable runs stay ambiguous
    expect(attributeArtifacts(at, artifacts, runs, true)).toEqual({ firstArtifactAt: at + 10_000, attributable: 3, inFlight: 2 });
  });
  it('a run is active in the window when it started by the end and did not finish before the intervention — split like its artifacts', () => {
    const at = 10 * H; const end = at + 6 * H;
    const runs = [
      { startedAt: new Date(at - 2 * H), finishedAt: new Date(at - H) }, // done before
      { startedAt: new Date(at - H), finishedAt: null }, // in flight
      { startedAt: new Date(at + H), finishedAt: new Date(at + 2 * H) },
      { startedAt: new Date(end + 1), finishedAt: null }, // after the window
      { startedAt: null, finishedAt: null }, // never claimed
    ];
    expect(activeRunSplit(at, end, runs)).toEqual({ attributable: 1, inFlight: 1 });
    expect(activeRunSplit(at, end, runs, true)).toEqual({ attributable: 2, inFlight: 0 });
  });
});

describe('recordSupervisorInterventions (finalize capture)', () => {
  const receipts = [
    { id: 'r1', tool: 'send_chat_message', ok: true, ids: { chatId: LANE }, runId: 'chat-t1', createdAt: NOW },
    { id: 'r2', tool: 'send_chat_message', ok: true, ids: { chatId: 'fleet-sup' }, runId: 'chat-t1', createdAt: NOW },
    { id: 'r3', tool: 'send_chat_message', ok: true, ids: { chatId: 'plain-chat' }, runId: 'chat-t1', createdAt: NOW },
    { id: 'r4', tool: 'start_coding_session', ok: true, ids: { sessionId: 'gone-chat' }, runId: 'chat-t1', createdAt: NOW },
  ];
  it('writes one supervisor_intervention row per CODING lane — never a supervisor chat, a plain chat or a missing chat', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: LANE, projectId: 'proj-1', charterGoalId: 'goal-1', charterTodoId: 'todo-1', isSupervisor: false, isProjectSupervisor: false, codingState: { id: LANE } },
      { id: 'fleet-sup', projectId: null, charterGoalId: null, charterTodoId: null, isSupervisor: true, isProjectSupervisor: false, codingState: null },
      { id: 'plain-chat', projectId: 'proj-1', charterGoalId: null, charterTodoId: null, isSupervisor: false, isProjectSupervisor: false, codingState: null },
    ]);
    await expect(recordSupervisorInterventions({ supervisorChatId: SUP, receipts, machineWake: true, supervisorTier: 'project' })).resolves.toBe(1);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [LANE, 'fleet-sup', 'plain-chat', 'gone-chat'] } } }));
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'supervisor_intervention', sessionId: SUP, value: 1,
      meta: { supervisorChatId: SUP, targetChatId: LANE, goalId: 'goal-1', todoId: 'todo-1', projectId: 'proj-1', kind: 'steer', tools: ['send_chat_message'], receiptId: 'r1', turnId: 'chat-t1', at: NOW.toISOString(), liveRun: false, origin: 'machine', tier: 'project' },
    });
  });
  it('the kill switch, the test guard, an empty turn and a DB error write nothing and never throw', async () => {
    process.env.SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED = '1';
    await expect(recordSupervisorInterventions({ supervisorChatId: SUP, receipts, machineWake: true })).resolves.toBe(0);
    delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED;
    delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_IN_TEST;
    await expect(recordSupervisorInterventions({ supervisorChatId: SUP, receipts, machineWake: true })).resolves.toBe(0);
    process.env.SUPERVISOR_INTERVENTION_OUTCOMES_IN_TEST = '1';
    await expect(recordSupervisorInterventions({ supervisorChatId: SUP, receipts: [], machineWake: false })).resolves.toBe(0);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    mockPrisma.crossModelChat.findMany.mockRejectedValue(new Error('db down'));
    await expect(recordSupervisorInterventions({ supervisorChatId: SUP, receipts, machineWake: false })).resolves.toBe(0);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

describe('runInterventionOutcomesOnce (the labelling cron)', () => {
  const interventionRow = (id: string, atMs: number, meta: Record<string, unknown> = {}) => ({
    id, sessionId: SUP, createdAt: new Date(atMs + 30_000),
    meta: { supervisorChatId: SUP, targetChatId: LANE, goalId: 'goal-1', projectId: 'proj-1', kind: 'steer', tools: ['send_chat_message'], receiptId: `rc-${id}`, turnId: `turn-${id}`, at: new Date(atMs).toISOString(), origin: 'machine', ...meta },
  });
  const routeLoopMetrics = (interventions: any[], labelled: any[] = []) => {
    mockPrisma.loopMetric.findMany.mockImplementation(async (q: any) => (q?.where?.kind === 'supervisor_intervention' ? interventions : labelled));
  };
  const outcomeCalls = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((x) => x.kind === 'supervisor_intervention_outcome');

  it('labels a 30 h-old steer at BOTH horizons: progressed when a run started after it minted a PR, with no repeat and nobody else acting', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('i1', at)]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ id: 'run-a', createdAt: new Date(at + 60_000), startedAt: new Date(at + 90_000), finishedAt: new Date(at + H) }]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ runId: 'run-a', createdAt: new Date(at + 40 * 60_000) }]);
    const summary = await runInterventionOutcomesOnce(NOW);
    expect(summary).toMatch(/^intervention-outcomes: 2 labelled \(0 ambiguous\), 0 retry, 0 queued over 1 due$/);
    const rows = outcomeCalls();
    expect(rows.map((r) => r.meta.horizonH)).toEqual([6, 24]);
    for (const r of rows) {
      expect(r).toMatchObject({ sessionId: SUP, value: 1, meta: expect.objectContaining({ interventionKey: 'i1', targetChatId: LANE, kind: 'steer', goalId: 'goal-1', receiptId: 'rc-i1', liveRun: false, outcome: 'progressed', reason: null, artifacts: 1, runs: 1, inFlightRuns: 0, runsTruncated: false, confounded: null }) });
    }
    // the artifact window starts AT the receipt's own time, not the row's finalize time
    expect(mockPrisma.runToolReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ chatId: LANE, ok: true, createdAt: { gt: new Date(at), lte: new Date(at + 6 * H) } }) }));
    // the run read takes only runs that can matter — never the lane's runs that finished before the lever was pulled
    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: LANE, createdAt: { gte: new Date(at - 24 * H), lte: new Date(at + 6 * H) }, OR: [{ finishedAt: null }, { finishedAt: { gte: new Date(at) } }] },
      orderBy: { createdAt: 'asc' }, take: MAX_RUNS_PER_WINDOW,
    }));
  });

  it('skips a horizon already labelled and a row not yet due; a 10 h-old row gets only its +6 h label', async () => {
    const old = NOW.getTime() - 30 * H; const young = NOW.getTime() - 10 * H; const fresh = NOW.getTime() - H;
    routeLoopMetrics(
      [interventionRow('old', old), interventionRow('young', young, { targetChatId: 'lane-y' }), interventionRow('fresh', fresh, { targetChatId: 'lane-f' })],
      [{ meta: { interventionKey: 'old', horizonH: 6 } }, { meta: { interventionKey: 'old', horizonH: 24 } }],
    );
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'lane-y', archivedAt: null }]);
    await runInterventionOutcomesOnce(NOW);
    const rows = outcomeCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ interventionKey: 'young', horizonH: 6, outcome: 'no_run' });
  });

  it('a later turn of the same supervisor on the same lane before any artifact labels the first intervention "repeated"', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('first', at), interventionRow('again', at + 2 * H)], [
      { meta: { interventionKey: 'again', horizonH: 6 } }, { meta: { interventionKey: 'again', horizonH: 24 } },
    ]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ id: 'run-1', createdAt: new Date(at + H), startedAt: new Date(at + H), finishedAt: new Date(at + 1.5 * H) }]);
    await runInterventionOutcomesOnce(NOW);
    const rows = outcomeCalls();
    expect(rows.map((r) => [r.meta.interventionKey, r.meta.horizonH, r.meta.outcome, r.value])).toEqual([['first', 6, 'repeated', 0], ['first', 24, 'repeated', 0]]);
    expect(rows[0].meta.firstRepeatAt).toBe(new Date(at + 2 * H).toISOString());
  });

  it('the owner typing on the lane before the artifact leaves the label null (owner_confounded); an agent / machine row does not', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('i1', at)], [{ meta: { interventionKey: 'i1', horizonH: 6 } }]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ id: 'run-a', createdAt: new Date(at + H), startedAt: new Date(at + H), finishedAt: null }]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ runId: 'run-a', createdAt: new Date(at + 3 * H) }]);
    routeMessages([
      { id: 'm1', content: '[AGENT-SENT MESSAGE from sup] push the fix', metadata: { origin: 'agent' } },
      { id: 'm2', content: 'please just open the PR', metadata: {} },
    ]);
    await runInterventionOutcomesOnce(NOW);
    const rows = outcomeCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ horizonH: 24, outcome: null, reason: 'owner_confounded', confounded: 'owner' });
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: LANE, role: 'user', createdAt: { gt: new Date(at), lt: new Date(at + 3 * H) } }, select: { id: true, metadata: true } }));
    // only the UNTAGGED row's text is read — the agent row is settled by its origin
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['m2'] } } }));

    mockRecordLoopMetric.mockClear();
    routeMessages([{ id: 'm1', content: '[AGENT-SENT MESSAGE from sup] push the fix', metadata: { origin: 'agent' } }]);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: 'progressed', confounded: null });
  });

  // ── review fixes (r2): symmetric in-flight, bounded run read, symmetric confounds, label loss ──
  const inFlightRun = (at: number, o: Record<string, unknown> = {}) => ({ id: 'run-live', createdAt: new Date(at - 10 * 60_000), startedAt: new Date(at - 10 * 60_000), finishedAt: new Date(at + 20 * 60_000), ...o });
  const labelOnly24 = (key: string) => [{ meta: { interventionKey: key, horizonH: 6 } }];

  it('a steer delivered INTO the live run owns that run: progressed when it produces, ran_no_artifact when it does not (symmetric)', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('i1', at, { liveRun: true })], labelOnly24('i1'));
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([inFlightRun(at)]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ runId: 'run-live', createdAt: new Date(at + 15 * 60_000) }]);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: 'progressed', liveRun: true, artifacts: 1, inFlightArtifacts: 0, runs: 1, inFlightRuns: 0 });

    mockRecordLoopMetric.mockClear();
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: 'ran_no_artifact', reason: null, runs: 1, inFlightRuns: 0 });
  });

  it('a lever that did NOT act on the in-flight run (a schedule) is null / in_flight_run with AND without that run\'s artifact', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('i1', at, { kind: 'schedule', tools: ['schedule_message'] })], labelOnly24('i1'));
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([inFlightRun(at)]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ runId: 'run-live', createdAt: new Date(at + 15 * 60_000) }]);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: null, reason: 'in_flight_run', inFlightArtifacts: 1, inFlightRuns: 1, runs: 0 });

    mockRecordLoopMetric.mockClear();
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: null, reason: 'in_flight_run', inFlightArtifacts: 0, inFlightRuns: 1, runs: 0 });
    // a null label is never confound-checked (no owner read)
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('an artifact whose run the window read did not return is resolved by id — progressed, never filed as in flight', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('i1', at)], labelOnly24('i1'));
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    const late = { id: 'run-late', createdAt: new Date(at + 10 * H), startedAt: new Date(at + 10 * H), finishedAt: new Date(at + 11 * H) };
    mockPrisma.agentRun.findMany.mockImplementation(async (q: any) => (q?.where?.id ? [late] : []));
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ runId: 'run-late', createdAt: new Date(at + 10.5 * H) }]);
    await runInterventionOutcomesOnce(NOW);
    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['run-late'] } } }));
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: 'progressed', artifacts: 1, inFlightArtifacts: 0 });
  });

  it(`a run read that fills MAX_RUNS_PER_WINDOW is truncated: null / run_window_truncated unless it already shows an attributable run`, async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('i1', at, { kind: 'schedule', tools: ['update_schedule'] })], labelOnly24('i1'));
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    // a busy lane: the cap is full of runs still unfinished at the intervention (queued + in flight), none started by the lever
    const stuck = Array.from({ length: MAX_RUNS_PER_WINDOW }, (_, i) => (i === 0 ? inFlightRun(at, { finishedAt: null }) : { id: `q-${i}`, createdAt: new Date(at - H + i), startedAt: null, finishedAt: null }));
    mockPrisma.agentRun.findMany.mockResolvedValue(stuck);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: null, reason: 'run_window_truncated', runsTruncated: true, runs: 0, inFlightRuns: 1 });

    mockRecordLoopMetric.mockClear();
    const busy = Array.from({ length: MAX_RUNS_PER_WINDOW }, (_, i) => ({ id: `r-${i}`, createdAt: new Date(at + i * 10 * 60_000), startedAt: new Date(at + i * 10 * 60_000 + 1000), finishedAt: new Date(at + i * 10 * 60_000 + 5 * 60_000) }));
    mockPrisma.agentRun.findMany.mockResolvedValue(busy);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: 'ran_no_artifact', runsTruncated: true });
  });

  it('the owner typing ANYWHERE in the window nulls a negative label too (owner_confounded) — the read covers the whole window', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('i1', at)], labelOnly24('i1'));
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ id: 'run-a', createdAt: new Date(at + H), startedAt: new Date(at + H), finishedAt: new Date(at + 2 * H) }]);
    routeMessages([{ id: 'm1', content: 'stop, try the other approach', metadata: null }]);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls()[0].meta).toMatchObject({ outcome: null, reason: 'owner_confounded', runs: 1 });
    expect(mockPrisma.crossModelMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: LANE, role: 'user', createdAt: { gt: new Date(at), lt: new Date(at + 24 * H + 1) } } }));
  });

  it('another supervisor acting on the lane inside the window nulls a no_run / repeated label too', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([
      interventionRow('i1', at),
      interventionRow('o1', at + 3 * H, { supervisorChatId: 'other-sup' }),
    ], [...labelOnly24('i1'), { meta: { interventionKey: 'o1', horizonH: 6 } }, { meta: { interventionKey: 'o1', horizonH: 24 } }]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls().map((r) => [r.meta.interventionKey, r.meta.outcome, r.meta.reason])).toEqual([['i1', null, 'other_supervisor_confounded']]);

    // before the repeat → confounded; after the repeat → the repeat label stands
    mockRecordLoopMetric.mockClear();
    routeLoopMetrics([
      interventionRow('i1', at),
      interventionRow('again', at + 2 * H),
      interventionRow('o1', at + 3 * H, { supervisorChatId: 'other-sup' }),
    ], [...labelOnly24('i1'), ...['again', 'o1'].flatMap((k) => [{ meta: { interventionKey: k, horizonH: 6 } }, { meta: { interventionKey: k, horizonH: 24 } }])]);
    await runInterventionOutcomesOnce(NOW);
    expect(outcomeCalls().map((r) => [r.meta.interventionKey, r.meta.outcome])).toEqual([['i1', 'repeated']]);
  });

  it('pairs past the batch that would age out before the next pass are written as null / label_expired and reported — never lost silently', async () => {
    const at = NOW.getTime() - 53.5 * H; // its +6 h pair leaves the 48 h slack in 30 min; its +24 h pair is fine
    const many = Array.from({ length: OUTCOMES_BATCH + 10 }, (_, i) => interventionRow(`e${String(i).padStart(3, '0')}`, at));
    routeLoopMetrics(many);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]); // target_missing — no reads per label
    const summary = await runInterventionOutcomesOnce(NOW);
    const rows = outcomeCalls();
    const expired = rows.filter((r) => r.meta.reason === 'label_expired');
    expect(expired).toHaveLength(10);
    expect(expired.every((r) => r.meta.horizonH === 6 && r.meta.outcome === null && r.value === 0 && r.meta.runs === undefined)).toBe(true);
    // the batch took the pairs nearest to ageing out first: every +6 h pair is labelled or recorded, the +24 h ones wait
    expect(rows.filter((r) => r.meta.reason === 'target_missing').every((r) => r.meta.horizonH === 6)).toBe(true);
    expect(summary).toMatch(/150 labelled \(150 ambiguous\), 0 retry, 10 expired, 160 queued over 160 due/);
  });

  it('a lane that no longer exists is null (target_missing); a failed read writes nothing and is retried next pass', async () => {
    const at = NOW.getTime() - 30 * H;
    routeLoopMetrics([interventionRow('i1', at), interventionRow('i2', at, { targetChatId: 'lane-2' })], [
      { meta: { interventionKey: 'i1', horizonH: 6 } }, { meta: { interventionKey: 'i2', horizonH: 6 } },
    ]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'lane-2', archivedAt: null }]);
    mockPrisma.agentRun.findMany.mockRejectedValue(new Error('timeout'));
    const summary = await runInterventionOutcomesOnce(NOW);
    expect(summary).toMatch(/1 labelled \(1 ambiguous\), 1 retry/);
    expect(outcomeCalls().map((r) => [r.meta.interventionKey, r.meta.outcome, r.meta.reason])).toEqual([['i1', null, 'target_missing']]);
  });

  it('an unreadable dedupe set fails the pass instead of labelling every row a second time', async () => {
    const at = NOW.getTime() - 30 * H;
    mockPrisma.loopMetric.findMany.mockImplementation(async (q: any) => {
      if (q?.where?.kind === 'supervisor_intervention') return [interventionRow('i1', at)];
      throw new Error('statement timeout');
    });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, archivedAt: null }]);
    await expect(runInterventionOutcomesOnce(NOW)).resolves.toMatch(/pass failed \(non-fatal\): statement timeout/);
    expect(outcomeCalls()).toEqual([]);
  });

  it('nothing to do / disabled / a failed scan return a summary and never throw', async () => {
    await expect(runInterventionOutcomesOnce(NOW)).resolves.toBe('no interventions to label');
    process.env.SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED = '1';
    await expect(runInterventionOutcomesOnce(NOW)).resolves.toBe('disabled');
    delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED;
    mockPrisma.loopMetric.findMany.mockRejectedValue(new Error('db down'));
    await expect(runInterventionOutcomesOnce(NOW)).resolves.toMatch(/pass failed \(non-fatal\): db down/);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

describe('aggregateLeverYield + renderInterventionOutcomesBlock (pure)', () => {
  const row = (key: string, lane: string, kind: string, outcome: OutcomeRowLite['outcome']): OutcomeRowLite => ({ interventionKey: key, targetChatId: lane, kind, outcome });
  const rows: OutcomeRowLite[] = [
    row('a', 'lane-aaaa-1111', 'steer', 'progressed'),
    row('b', 'lane-aaaa-1111', 'steer', 'ran_no_artifact'),
    row('c', 'lane-aaaa-1111', 'steer', 'repeated'),
    row('d', 'lane-bbbb-2222', 'spawn', 'progressed'),
    row('e', 'lane-bbbb-2222', 'schedule', 'no_run'),
    row('f', 'lane-cccc-3333', 'steer', null),
    row('a', 'lane-aaaa-1111', 'steer', 'progressed'), // duplicate label row — counted once
  ];
  it('tallies per lever and per lane, deduped by intervention', () => {
    const y = aggregateLeverYield(rows);
    expect(y.total).toEqual({ n: 6, progressed: 2, ran_no_artifact: 1, no_run: 1, repeated: 1, unlabelled: 1 });
    expect(y.byKind.get('steer')).toEqual({ n: 4, progressed: 1, ran_no_artifact: 1, no_run: 0, repeated: 1, unlabelled: 1 });
    expect(y.byLane.get('lane-bbbb-2222')?.get('spawn')?.progressed).toBe(1);
  });
  it('renders header, totals, yield per lever and one line per lane (most interventions first) — evidence, not orders', () => {
    const block = renderInterventionOutcomesBlock(aggregateLeverYield(rows), new Map([['lane-aaaa-1111', 'Fix the deploy watch'], ['lane-bbbb-2222', 'Bench v2']]));
    expect(block.split('\n')).toEqual([
      INTERVENTION_BLOCK_HEADER,
      'Totals: 6 intervention(s) — 2 progressed · 1 ran, no artifact · 1 no run · 1 repeated · 1 unlabelled; progressed 40% of labelled.',
      'By lever: steer 4 → 33% progressed | spawn 1 → 100% progressed | schedule 1 → 0% progressed',
      '- Fix the deploy watch (lane-aaa): steer 3 → 1 progressed · 1 ran, no artifact · 1 repeated',
      '- Bench v2 (lane-bbb): spawn 1 → 1 progressed | schedule 1 → 1 no run',
      '- lane-ccc: steer 1 → 1 unlabelled',
    ]);
    expect(block).toMatch(/never an order/);
    expect(block.length).toBeLessThanOrEqual(BLOCK_MAX_CHARS);
  });
  it('renders nothing under BLOCK_MIN_LABELLED labelled rows, and clips to the char budget with a "more lanes" line', () => {
    expect(renderInterventionOutcomesBlock(aggregateLeverYield([row('a', 'l1', 'steer', 'progressed'), row('b', 'l1', 'steer', null), row('c', 'l2', 'steer', 'no_run')]), new Map())).toBe('');
    const many = Array.from({ length: 40 }, (_, i) => row(`k${i}`, `lane-${String(i).padStart(4, '0')}-xxxx`, 'steer', i % 2 ? 'progressed' : 'ran_no_artifact'));
    const titles = new Map(many.map((r) => [r.targetChatId, `A fairly long lane title number ${r.targetChatId} for clipping`]));
    const block = renderInterventionOutcomesBlock(aggregateLeverYield(many), titles);
    expect(block.length).toBeLessThanOrEqual(BLOCK_MAX_CHARS);
    expect(block).toMatch(/\n… \d+ more lane\(s\)$/);
  });
});

describe('buildInterventionOutcomesBlock (the wake seam)', () => {
  const labelRow = (key: string, lane: string, outcome: string | null, horizonH = 24) => ({ meta: { interventionKey: key, horizonH, targetChatId: lane, kind: 'steer', outcome } });
  it('waits for a week of observation of THIS supervisor, then renders its +24 h labels with lane titles', async () => {
    await expect(buildInterventionOutcomesBlock(SUP, NOW)).resolves.toBe('');
    expect(mockPrisma.loopMetric.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: 'supervisor_intervention', sessionId: SUP, createdAt: { lte: new Date(NOW.getTime() - 7 * 24 * H) } } }));
    expect(mockPrisma.loopMetric.findMany).not.toHaveBeenCalled();

    mockPrisma.loopMetric.findFirst.mockResolvedValue({ id: 'oldest' });
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      labelRow('a', LANE, 'progressed'), labelRow('b', LANE, 'repeated'), labelRow('c', LANE, 'no_run'),
      labelRow('d', LANE, 'progressed', 6), // the +6 h label never feeds the block
    ]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, title: 'Ship the bench' }]);
    const block = await buildInterventionOutcomesBlock(SUP, NOW);
    expect(block.startsWith('[INTERVENTION OUTCOMES — 7d]')).toBe(true);
    expect(block).toMatch(/Totals: 3 intervention\(s\) — 1 progressed · 1 no run · 1 repeated; progressed 33% of labelled\./);
    expect(block).toMatch(/- Ship the bench \(lane-cha\): steer 3 → /);
    expect(mockPrisma.loopMetric.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: 'supervisor_intervention_outcome', sessionId: SUP, createdAt: { gte: new Date(NOW.getTime() - 7 * 24 * H) } } }));
  });
  it('the block switch, the main switch, the test guard and a read error all yield no block', async () => {
    mockPrisma.loopMetric.findFirst.mockResolvedValue({ id: 'oldest' });
    mockPrisma.loopMetric.findMany.mockResolvedValue([labelRow('a', LANE, 'progressed'), labelRow('b', LANE, 'progressed'), labelRow('c', LANE, 'no_run')]);
    process.env.SUPERVISOR_INTERVENTION_OUTCOMES_BLOCK_DISABLED = '1';
    await expect(buildInterventionOutcomesBlock(SUP, NOW)).resolves.toBe('');
    delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_BLOCK_DISABLED;
    process.env.SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED = '1';
    await expect(buildInterventionOutcomesBlock(SUP, NOW)).resolves.toBe('');
    delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED;
    delete process.env.SUPERVISOR_INTERVENTION_OUTCOMES_IN_TEST;
    await expect(buildInterventionOutcomesBlock(SUP, NOW)).resolves.toBe('');
    process.env.SUPERVISOR_INTERVENTION_OUTCOMES_IN_TEST = '1';
    expect(mockPrisma.loopMetric.findFirst).not.toHaveBeenCalled();
    mockPrisma.loopMetric.findFirst.mockRejectedValue(new Error('db down'));
    await expect(buildInterventionOutcomesBlock(SUP, NOW)).resolves.toBe('');
  });
});

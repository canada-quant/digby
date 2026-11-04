/**
 * Review 2026-09-13 issue 11: supervisor-first triage — the platform-tool
 * half (platform-tools.ts): the new answer_owner_question tool and the
 * triage-aware list_owner_questions / flag_owner_question envelopes.
 *
 * Pins:
 *   - name-set membership: answer_owner_question is a MUTATING platform tool
 *     (in coding MUTATING_TOOLS, in CHAT_PROFILE_PLATFORM_TOOLS), NOT read,
 *     NOT ask-only, NOT consequential (no confirmation staged, autonomy never
 *     consulted) — the supervisor's unattended wakes must run it;
 *   - scope: a SUPERVISOR chat (isSupervisorChat) answers as 'supervisor' and
 *     records owner_question_supervisor_answered; a machine lane (not
 *     supervisor, no user turn) gets a plain refusal and the service is never
 *     called; a user-present turn on any chat answers as 'owner';
 *   - result envelopes: ok / not_found / not_open / invalid;
 *   - list_owner_questions passes includeTriaged:true and renders the
 *     triaged marker + triageNote; flag_owner_question echoes triage.
 *
 * Scaffolding mirrors platform-tools.fleet.test.ts (do not modify that file).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tools.ts transitively imports plan.service → context-store → DB/env (process.exit).
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));


// ── Service layer under the tools (mocked at the boundary) ───────────────────
const svc = {
  listChats: jest.fn(), createChat: jest.fn(), getChatStatus: jest.fn(), getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(), renameChat: jest.fn(), archiveChat: jest.fn(), moveChat: jest.fn(),
  deleteChat: jest.fn(), createProject: jest.fn(), updateProject: jest.fn(),
  deleteProject: jest.fn(), moveFolder: jest.fn(), startCodingSession: jest.fn(), scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(), cancelSchedule: jest.fn(),
  resolveOwnedChatIdPrefix: jest.fn(async (_u: string, raw: string) => raw),
  setChatMode: jest.fn(async ({ chatId, mode }: any) => ({ id: chatId, mode: mode === 'auto' ? 'thinking' : mode })),
  getProject: jest.fn(async ({ projectId }: any) => (projectId === 'proj-1' ? { id: 'proj-1', name: 'P', spendCapUsdPerDay: 25 } : (() => { throw Object.assign(new Error('Project not found or no access'), { statusCode: 404 }); })())),
  setChatScheduleEnabled: jest.fn(async () => ({ schedule: { id: 'sch-1', nextRunAt: '2026-09-25T00:00:00Z', lastStatus: 'active' }, changed: true })),
};
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));
// 1769c8d1: get_spend (chat scope) resolves the LANE spend cap through
// spend-cap.service — mock it at the boundary (the real module statically
// imports config/redis → config/env, which this graph does not stub).
const mockLaneSpendCap = jest.fn(async (..._a: any[]): Promise<any> => ({ spendCapUsdPerDay: null, spendCapSource: null }));
jest.mock('../coding/spend-cap.service', () => ({
  __esModule: true,
  getLaneSpendCap: (...a: any[]) => mockLaneSpendCap(...a),
}));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
const mockConfirmations = createPendingConfirmationTable();
// Chats owned by u1: c-own (coding), p-own (plain); c-other belongs to u2.
const chats: Record<string, any> = {
  'c-own': { id: 'c-own', userId: 'u1', codingState: { id: 'cs' } },
  'p-own': { id: 'p-own', userId: 'u1', codingState: null },
  'c-other': { id: 'c-other', userId: 'u2', codingState: { id: 'cs2' } },
};
const dbMock = {
  pendingConfirmation: mockConfirmations.api,
  crossModelChat: { findUnique: jest.fn(async ({ where }: any) => chats[where.id] ?? null) },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  codingSchedule: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'sch-1' ? { id: 'sch-1', sessionId: 'c-own', userId: 'u1' } : null)) },
  agentRun: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'run-1' ? { id: 'run-1', sessionId: 'c-own' } : null)) },
  $queryRawUnsafe: jest.fn(async (sql: string) => {
    // WI-J (2026-09-25): the recent-runs read (chat scope, LIMIT 5) and the
    // multi-model count on the spend aggregate.
    if (sql.includes('LIMIT 5')) return [
      { run_id: 'run-1', usd: 0.5, models: ['kimi-k3', 'deepseek-flash'], at: new Date('2026-09-25T10:00:00.000Z') },
      { run_id: null, usd: 0.25, models: ['kimi-k3'], at: new Date('2026-09-25T09:00:00.000Z') },
    ];
    // GOAL-PRIORITY-SPEND (2026-10-20): the goal scope's stamped-vs-charter split.
    if (sql.includes('AS stamped')) return [{ stamped: 2 }];
    if (sql.includes("kind = 'run_spend'")) return [{ usd: 1.2345, runs: 3, multi_model_runs: 1 }];
    return [{ model: 'glm-5.3', tokens_in: 1000, tokens_out: 200 }];
  }),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: dbMock }));
// GOAL-PRIORITY-SPEND (2026-10-20): get_spend scope 'goal' resolves the goal through goals.service getGoal
// (read access + prefix resolution) — mocked at the boundary; nothing else in this file touches goals.
const mockGetGoal = jest.fn(async ({ goalId }: any): Promise<any> => {
  if (String(goalId).startsWith('g-own')) return { id: 'g-own-0001', projectId: 'proj-1' };
  throw Object.assign(new Error('Goal not found'), { statusCode: 404 });
});
jest.mock('./goals.service', () => ({ __esModule: true, getGoal: (a: any) => mockGetGoal(a) }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(), listFeedbackTickets: jest.fn(), updateFeedbackTicket: jest.fn(), isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// A stored MANUAL grant covering the five control tools — the gate executes
// directly (the supervisor-seat shape). Tests that want the machine gate to
// STAGE flip the grant to null.
const ALL_CONTROL = ['stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule'];
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', ...ALL_CONTROL] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async (): Promise<any> => ({ chatId: 'sup-1', allowedTools: ALL_CONTROL, source: 'manual' })),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));
const supStateSvc = { isSupervisorChat: jest.fn(async (): Promise<boolean> => false), applyStateUpdate: jest.fn(async () => ({ applied: [], errors: [] })) };
jest.mock('./supervisor-state.service', () => ({ __esModule: true, ...supStateSvc }));
const oq = {
  answerOwnerQuestion: jest.fn(async () => 'ok'),
  listOwnerQuestionsForUser: jest.fn(async () => ({ rows: [], unmatchedIds: [] })),
  flagOwnerQuestion: jest.fn(async () => ({ kind: 'created', question: { id: 'oq_plain' } })),
  resolveOwnerQuestionsForChatAnswer: jest.fn(async () => {}),
};
jest.mock('./owner-questions', () => ({ __esModule: true, ...oq }));
const metrics = { recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: { MACHINE_SCHEDULE_MUTATION: 'machine_schedule_mutation', CONFIRMATION_STAGED: 'confirmation_staged' } };
jest.mock('./loop-metrics.service', () => ({ __esModule: true, ...metrics }));

// ── The coding/chat-agent modules the executors dynamic-import ──────────────
const runState = { getActiveRunForSession: jest.fn(async (): Promise<any> => ({ id: 'run-9', status: 'running' })) };
jest.mock('../coding/run-state', () => ({ __esModule: true, ...runState }));
const lock = {
  requestRunCancel: jest.fn(async () => {}),
  getQuestionPendingSession: jest.fn(async (): Promise<string | null> => null),
  publishQuestionResolution: jest.fn(async () => {}),
  getApprovalPendingSession: jest.fn(async (): Promise<string | null> => null),
  publishApprovalResolution: jest.fn(async () => {}),
};
jest.mock('../coding/session-run-lock', () => ({ __esModule: true, ...lock }));
const durable = {
  loadDurablePending: jest.fn(async (): Promise<any> => null),
  markDurableResolved: jest.fn(async () => {}),
  currentIdForFingerprint: jest.fn(async (): Promise<string | null> => null),
};
jest.mock('../coding/pending-durable', () => ({ __esModule: true, ...durable }));
const qreg = { questionSession: jest.fn((): string | null => null), resolveAnswer: jest.fn(() => true), resolvePendingForSession: jest.fn(() => 0) };
jest.mock('../coding/question-registry', () => ({ __esModule: true, ...qreg }));
const live = { isRunActive: jest.fn(() => false), cancelRun: jest.fn() };
jest.mock('../coding/live-runs', () => ({ __esModule: true, ...live }));
jest.mock('../chat-agent/chat-agent.service', () => ({ __esModule: true, chatRunKey: (id: string) => `chat:${id}` }));
const busy = { hasRemoteChatRun: jest.fn(async () => false), requestChatRunStop: jest.fn(async () => true) };
jest.mock('../chat-agent/chat-busy', () => ({ __esModule: true, ...busy }));
const sessions: Record<string, any> = { 'c-own': { id: 'c-own', model: 'glm-5.3', modelSource: null, permissionMode: 'plan', status: 'ready' } };
const codingData = {
  getSessionForUser: jest.fn(async (id: string, _u: string) => sessions[id] ?? null),
  updateSessionState: jest.fn(async () => {}),
  resolveOneCodingPick: jest.fn(async (pick: string) => (['glm-5.3', 'deepseek-flash', 'kimi-k3'].includes(pick) ? pick : null)),
};
jest.mock('../coding/coding-data.service', () => ({ __esModule: true, ...codingData }));
const sched = { resolveScheduleIdForUser: jest.fn(async (_u: string, id: string) => (id.startsWith('sch-1') ? 'sch-1' : null)) };
jest.mock('../coding/schedule.service', () => ({ __esModule: true, ...sched }));

import { PLATFORM_TOOL_SCHEMA, PLATFORM_MUTATING_TOOLS, PLATFORM_READ_TOOLS, executePlatformTool } from './platform-tools';
import { MUTATING_TOOLS, ToolContext } from '../coding/tools';
import { SESSION_TOOL_NAMES } from './session-tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'sup-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}
const run = async (name: string, args: any, ctx = makeCtx()) => JSON.parse(await executePlatformTool(ctx, name, args));

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  sessions['c-own'] = { id: 'c-own', model: 'glm-5.3', modelSource: null, permissionMode: 'plan', status: 'ready' };
  supStateSvc.isSupervisorChat.mockResolvedValue(false);
});

describe('session tools registration (capability gap audit T2)', () => {
  it('three mutating settings tools + one read; none consequential', () => {
    const names = PLATFORM_TOOL_SCHEMA.map((t: any) => t.function.name);
    for (const t of SESSION_TOOL_NAMES) expect(names).toContain(t);
    for (const t of ['set_session_model', 'set_chat_mode', 'set_session_permission_mode']) { expect(PLATFORM_MUTATING_TOOLS).toContain(t); expect(MUTATING_TOOLS.has(t)).toBe(true); }
    expect(PLATFORM_READ_TOOLS).toContain('get_spend'); expect(MUTATING_TOOLS.has('get_spend')).toBe(false);
  });
  it('none is consequential: a machine run with NO grant executes directly (no confirmation card)', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-x' }), 'set_chat_mode', { mode: 'thinking' });
    expect(out).not.toContain('needsConfirmation');
    expect(JSON.parse(out)).toMatchObject({ ok: true });
  });
});

describe('set_session_model', () => {
  it('validates the pick, writes model + modelSource explicit, applies next run', async () => {
    const out = await run('set_session_model', { chatId: 'c-own', model: 'deepseek-flash' });
    expect(out).toMatchObject({ ok: true, model: 'deepseek-flash', previousModel: 'glm-5.3', modelSource: 'explicit' });
    expect(codingData.updateSessionState).toHaveBeenCalledWith('c-own', { model: 'deepseek-flash', modelSource: 'explicit' });
  });
  it('an invalid pick / a plain chat / a foreign chat are refused with reasons, nothing written', async () => {
    expect(await run('set_session_model', { chatId: 'c-own', model: 'gpt-9' })).toMatchObject({ ok: false, reason: 'invalid_model' });
    expect(await run('set_session_model', { chatId: 'p-own', model: 'glm-5.3' })).toMatchObject({ ok: false, reason: 'not_coding' });
    expect(await run('set_session_model', { chatId: 'c-other', model: 'glm-5.3' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(codingData.updateSessionState).not.toHaveBeenCalled();
  });
});

describe('set_chat_mode', () => {
  it('defaults to THIS chat, delegates to platform.setChatMode, relays refusals', async () => {
    expect(await run('set_chat_mode', { mode: 'deep_research' })).toMatchObject({ ok: true, ids: { chatId: 'sup-1' }, mode: 'deep_research' });
    expect(svc.setChatMode).toHaveBeenCalledWith({ userId: 'u1', chatId: 'sup-1', mode: 'deep_research' });
    expect(await run('set_chat_mode', { chatId: 'p-own', mode: 'bogus' })).toMatchObject({ ok: false, reason: 'invalid' });
    svc.setChatMode.mockRejectedValueOnce(Object.assign(new Error('Chat not found'), { statusCode: 404 }));
    expect(await run('set_chat_mode', { chatId: 'nope', mode: 'thinking' })).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('WI-O #4c: leadModel rides through to setChatMode on a HUMAN turn (mode optional; null clears; neither → invalid; a refused pick relays the service message)', async () => {
    const human = makeCtx({ userTurnAt: new Date() });
    svc.setChatMode.mockImplementationOnce(async ({ chatId, leadModel }: any) => ({ id: chatId, mode: 'thinking', leadModel }));
    expect(await run('set_chat_mode', { chatId: 'p-own', leadModel: 'deepseek-flash' }, human)).toMatchObject({ ok: true, ids: { chatId: 'p-own' }, leadModel: 'deepseek-flash', message: expect.stringContaining('deepseek-flash') });
    expect(svc.setChatMode).toHaveBeenLastCalledWith({ userId: 'u1', chatId: 'p-own', leadModel: 'deepseek-flash' });

    expect(await run('set_chat_mode', { chatId: 'p-own', mode: 'thinking', leadModel: null }, human)).toMatchObject({ ok: true, mode: 'thinking', leadModel: null, message: expect.stringContaining('cleared') });
    expect(svc.setChatMode).toHaveBeenLastCalledWith({ userId: 'u1', chatId: 'p-own', mode: 'thinking', leadModel: null });
    expect(await run('set_chat_mode', { chatId: 'p-own', leadModel: '' }, human)).toMatchObject({ ok: true, leadModel: null });
    expect(svc.setChatMode).toHaveBeenLastCalledWith({ userId: 'u1', chatId: 'p-own', leadModel: null });

    expect(await run('set_chat_mode', { chatId: 'p-own' }, human)).toMatchObject({ ok: false, reason: 'invalid' });

    svc.setChatMode.mockRejectedValueOnce(Object.assign(new Error('"gpt-9" is not a lead model this instance offers: use a built-in (kimi-k3 / glm-5.3 / deepseek-flash / qwen3.6-27b) or an enabled "<label>:<modelId>" endpoint model flagged [coding].'), { statusCode: 400 }));
    expect(await run('set_chat_mode', { chatId: 'p-own', leadModel: 'gpt-9' }, human)).toMatchObject({ ok: false, reason: 'refused', message: expect.stringContaining('not a lead model') });
  });

  // Seats govern sessions (2026-09-28): a lead-model pick is a HUMAN decision — a machine turn
  // (no user anchor, or a machine-classified run with one) may never point a plain chat away
  // from the admin's Digby seat. Clearing (null / '') stays allowed from any turn; the mode
  // half is untouched.
  it('a leadModel pick from a MACHINE turn is refused (no_user_turn) and the service is never called; clearing and mode-only still pass', async () => {
    expect(await run('set_chat_mode', { chatId: 'p-own', leadModel: 'deepseek-flash' })).toMatchObject({ ok: false, reason: 'no_user_turn', message: expect.stringContaining('live user turn') });
    expect(await run('set_chat_mode', { chatId: 'p-own', leadModel: 'deepseek-flash' }, makeCtx({ userTurnAt: new Date(), machineTriggered: true } as any))).toMatchObject({ ok: false, reason: 'no_user_turn' });
    expect(svc.setChatMode).not.toHaveBeenCalled();
    expect(await run('set_chat_mode', { chatId: 'p-own', leadModel: null })).toMatchObject({ ok: true, leadModel: null });
    expect(await run('set_chat_mode', { chatId: 'p-own', mode: 'thinking' })).toMatchObject({ ok: true, mode: 'thinking' });
    expect(svc.setChatMode).toHaveBeenCalledTimes(2);
  });
});

describe('set_session_permission_mode', () => {
  it('narrowing always applies; a machine run widening a non-child, non-supervisor target is refused', async () => {
    sessions['c-own'].permissionMode = 'auto';
    expect(await run('set_session_permission_mode', { chatId: 'c-own', permissionMode: 'ask' })).toMatchObject({ ok: true, previous: 'auto', permissionMode: 'ask' });
    sessions['c-own'].permissionMode = 'plan';
    expect(await run('set_session_permission_mode', { chatId: 'c-own', permissionMode: 'auto' })).toMatchObject({ ok: false, reason: 'widening_refused' });
  });
  it('widening is allowed for an own first-degree child, for a supervisor seat, and on a user-anchored turn', async () => {
    chats['c-own'].parentChatId = 'sup-1';
    expect(await run('set_session_permission_mode', { chatId: 'c-own', permissionMode: 'auto' })).toMatchObject({ ok: true, permissionMode: 'auto' });
    delete chats['c-own'].parentChatId;
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    expect(await run('set_session_permission_mode', { chatId: 'c-own', permissionMode: 'auto' })).toMatchObject({ ok: true });
    supStateSvc.isSupervisorChat.mockResolvedValue(false);
    expect(await run('set_session_permission_mode', { chatId: 'c-own', permissionMode: 'auto' }, makeCtx({ userTurnAt: new Date() }))).toMatchObject({ ok: true });
    expect(await run('set_session_permission_mode', { chatId: 'c-own', permissionMode: 'plan' })).toMatchObject({ ok: true, changed: false });
  });
});

describe('get_spend', () => {
  it("scope 'goal' (GOAL-PRIORITY-SPEND): stamped meta.goalId rows + unstamped rows of chats chartered to the goal, with the split; switch / missing / unknown goal refuse", async () => {
    dbMock.$queryRawUnsafe.mockClear();
    const goal = await run('get_spend', { scope: 'goal', goalId: 'g-own' });
    expect(goal).toMatchObject({ ok: true, scope: 'goal', ids: { goalId: 'g-own-0001', projectId: 'proj-1' }, usd: 1.2345, runs: 3, attribution: { stampedRuns: 2, charterFallbackRuns: 1 } });
    const [sql, , ids, projectIds] = (dbMock.$queryRawUnsafe.mock.calls[0] as any[]);
    expect(sql).toContain("lm.meta->>'goalId' = ANY($2::text[])");
    expect(sql).toContain('gsc."charterGoalId" = ANY($2::text[])');
    // Review fix: the charter fallback is scoped to the goal's project (indexed) and stops at a goal rebind.
    expect(sql).toContain('gsc."projectId" = ANY($3::text[])');
    expect(sql).toContain("gsr.kind = 'charter_rebind'");
    expect(ids).toEqual(['g-own-0001']);
    expect(projectIds).toEqual(['proj-1']);
    expect((goal as any).attribution.goalNote).toMatch(/UNSTAMPED rows of any producer/);
    expect(await run('get_spend', { scope: 'goal' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('get_spend', { scope: 'goal', goalId: 'nope0000' })).toMatchObject({ ok: false, reason: 'not_found' });
    process.env.GOAL_SPEND_ATTRIBUTION_DISABLED = '1';
    try {
      expect(await run('get_spend', { scope: 'goal', goalId: 'g-own' })).toMatchObject({ ok: false, reason: 'disabled' });
    } finally {
      delete process.env.GOAL_SPEND_ATTRIBUTION_DISABLED;
    }
  });

  it('chat scope defaults to this chat; project scope carries the cap; run scope checks ownership; hours are bounded', async () => {
    chats['sup-1'] = { id: 'sup-1', userId: 'u1', codingState: null };
    const chat = await run('get_spend', { scope: 'chat' });
    expect(chat).toMatchObject({ ok: true, scope: 'chat', ids: { chatId: 'sup-1' }, usd: 1.2345, runs: 3, windowHours: 24, estimated: true, byModel: { 'glm-5.3': { tokensIn: 1000, tokensOut: 200 } } });
    const proj = await run('get_spend', { scope: 'project', projectId: 'proj-1', hours: 500 });
    expect(proj).toMatchObject({ ok: true, scope: 'project', windowHours: 168, cap: { spendCapUsdPerDay: 25 } });
    expect(await run('get_spend', { scope: 'project', projectId: 'proj-x' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('get_spend', { scope: 'run', runId: 'run-1' })).toMatchObject({ ok: true, ids: { runId: 'run-1', chatId: 'c-own' } });
    expect(await run('get_spend', { scope: 'run', runId: 'run-9' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('get_spend', { scope: 'account' })).toMatchObject({ ok: true, scope: 'account' });
    delete chats['sup-1'];
  });

  // 1769c8d1 + owner 2026-09-27 (no hidden cost caps): chat scope exposes the
  // ONE cap the sweeper enforces — the user-set PROJECT cap, or null. No cap
  // set ⇒ an explicit null cap (checked, none set); absent only when the
  // resolver itself failed (fail-open). The project scope carries NO
  // fleetDailyBudgetUsd any more (the env breaker is deleted).
  it('chat scope exposes the governing PROJECT spend cap and its source; explicit null when none is set (REGRESSION PIN: no cap when no project cap)', async () => {
    chats['sup-1'] = { id: 'sup-1', userId: 'u1', codingState: null };
    try {
      const none = await run('get_spend', { scope: 'chat' });
      expect(none).toMatchObject({ ok: true, scope: 'chat' });
      expect(none.cap).toEqual({ spendCapUsdPerDay: null, spendCapSource: null });
      const proj = await run('get_spend', { scope: 'project', projectId: 'proj-1' });
      expect(proj.cap).toEqual({ spendCapUsdPerDay: 25 });
      expect(proj.cap).not.toHaveProperty('fleetDailyBudgetUsd');
      mockLaneSpendCap.mockResolvedValueOnce({ spendCapUsdPerDay: 25, spendCapSource: 'project', projectId: 'proj-1' });
      const capped = await run('get_spend', { scope: 'chat' });
      expect(capped).toMatchObject({ ok: true, scope: 'chat', cap: { spendCapUsdPerDay: 25, spendCapSource: 'project' } });
      expect(mockLaneSpendCap).toHaveBeenCalledWith('sup-1');
      // A resolver failure is fail-open: no cap field, tool still succeeds.
      mockLaneSpendCap.mockRejectedValueOnce(new Error('store down'));
      const hiccup = await run('get_spend', { scope: 'chat' });
      expect(hiccup).toMatchObject({ ok: true, scope: 'chat' });
      expect(hiccup.cap).toBeUndefined();
    } finally {
      delete chats['sup-1'];
    }
  });

  it('attribution + recentRuns (WI-J, 2026-09-25): chat scope lists the 5 most recent run_spend rows; doubleChecker follows the multi-model run count; other scopes carry attribution only', async () => {
    chats['sup-1'] = { id: 'sup-1', userId: 'u1', codingState: null };
    try {
      const chat = await run('get_spend', { scope: 'chat' });
      expect(chat).toMatchObject({ ok: true, attribution: { lead: true, doubleChecker: true, multiModelRuns: 1 } });
      expect(chat.recentRuns).toEqual([
        { runId: 'run-1', usd: 0.5, models: ['kimi-k3', 'deepseek-flash'], at: '2026-09-25T10:00:00.000Z' },
        { runId: null, usd: 0.25, models: ['kimi-k3'], at: '2026-09-25T09:00:00.000Z' },
      ]);
      expect(chat.note).toContain('doubleChecker');
      // multi_model_runs (review 2026-09-25): jsonb_array_length only ever runs
      // on an array — CASE WHEN, never AND short-circuiting (Postgres does not
      // guarantee sub-expression order; a non-array meta.models would 500).
      const spendSql = dbMock.$queryRawUnsafe.mock.calls.map((c: any[]) => String(c[0])).find((s: string) => s.includes('multi_model_runs'))!;
      expect(spendSql).toContain("CASE WHEN jsonb_typeof(lm.meta->'models') = 'array' THEN jsonb_array_length(lm.meta->'models') ELSE 0 END");
      expect(spendSql).not.toMatch(/= 'array' AND jsonb_array_length/);
      const recentSql = dbMock.$queryRawUnsafe.mock.calls.map((c: any[]) => String(c[0])).find((s: string) => s.includes('LIMIT 5'))!;
      expect(recentSql).toContain(`lm."sessionId" = $2`);
      expect(recentSql).toContain('ORDER BY lm."createdAt" DESC');
      const account = await run('get_spend', { scope: 'account' });
      expect(account).toMatchObject({ ok: true, attribution: { lead: true, doubleChecker: true } });
      expect(account.recentRuns).toBeUndefined();
      // No multi-model rows in the window → doubleChecker:false (honest under-report signal).
      dbMock.$queryRawUnsafe.mockImplementationOnce(async () => [{ usd: 0.1, runs: 2, multi_model_runs: 0 }]);
      const single = await run('get_spend', { scope: 'account' });
      expect(single.attribution).toEqual({ lead: true, doubleChecker: false, multiModelRuns: 0 });
    } finally {
      delete chats['sup-1'];
    }
  });
});

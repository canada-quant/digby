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
// fleet-telemetry → infra-watch → config/redis → env (exits the suite without this mock)
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn() } }));
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
// 1769c8d1: get_chat_autonomy resolves the LANE spend cap through
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
  agentRun: {
    findUnique: jest.fn(async ({ where }: any) => (where.id === 'run-1' ? { id: 'run-1', sessionId: 'c-own' } : null)),
    // Honors where.id when present (ticket 568d3652 replay): a runId-narrowed
    // query for an unknown run must see [] — the not_found surface below.
    findMany: jest.fn(async ({ where }: any) => ((where.sessionId === 'c-own' && (!where.id || where.id === 'run-1')) ? [{ id: 'run-1', status: 'completed', attempts: 1, currentStep: 12, error: null, createdAt: new Date(), startedAt: new Date(), finishedAt: new Date() }] : [])),
  },
  // Ticket e225aad8: honors where.runId (chat-turn fallback read) and the
  // chatTurns discovery where.chatId + OR[null / notIn] shape, plus orderBy
  // direction (the discovery read is desc-then-reversed). Default rows (no
  // runId filter) are the run-1 set the older pins below assert on.
  runToolReceipt: { findMany: jest.fn(async ({ where, orderBy }: any) => {
    const rows = [
      { id: 'f5b42fe6-1111-4000-8000-000000000000', runId: 'run-1', tool: 'open_pull_request', ok: true, ids: { prNumber: 42 }, createdAt: new Date('2026-10-18T01:00:00Z') },
      { id: 't1a00001-1111-4000-8000-000000000000', runId: 'chat-turn-1', tool: 'run_command', ok: true, ids: {}, createdAt: new Date('2026-10-18T02:00:00Z') },
      { id: 't1a00002-1111-4000-8000-000000000000', runId: 'chat-turn-1', tool: 'get_chat_status', ok: true, ids: { chatId: 'lane-9' }, createdAt: new Date('2026-10-18T02:00:05Z') },
      { id: 't1b00001-1111-4000-8000-000000000000', runId: 'chat-turn-2', tool: 'update_supervisor_state', ok: true, ids: { supervisor_state: 'supervisor_state' }, createdAt: new Date('2026-10-18T03:00:00Z') },
    ];
    let out = rows;
    if (where?.runId && typeof where.runId === 'string') out = rows.filter((r) => r.runId === where.runId);
    else if (where?.OR && where.chatId) out = rows.filter((r) => r.runId !== 'run-1');
    if (orderBy?.createdAt === 'desc') out = [...out].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return out;
  }) },
  // E5 run_context_fill: the fill rows recordRunSpend minted — surfaced on each
  // run in get_run_receipts.
  loopMetric: {
    findMany: jest.fn(async ({ where }: any) => (where?.kind === 'run_context_fill'
      ? [{ runId: 'run-1', value: 250_000, meta: { model: 'glm-5.3', peakPromptTokens: 250_000, windowTokens: 1_000_000, fillRatio: 0.25 }, createdAt: new Date() }]
      : [])),
  },
  ownerQuestion: {
    findUnique: jest.fn(async ({ where }: any) => (where.id === 'oq_1' ? { id: 'oq_1', userId: 'u1', chatId: 'lane-x', status: 'open' } : null)),
    findMany: jest.fn(async () => []),
  },
  $queryRawUnsafe: jest.fn(async (sql: string) => (sql.includes("kind = 'run_spend'") ? [{ usd: 1.2345, runs: 3 }] : [{ model: 'glm-5.3', tokens_in: 1000, tokens_out: 200 }])),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: dbMock }));

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
  dismissOwnerQuestion: jest.fn(async () => 'ok' as const),
  answerOwnerQuestion: jest.fn(async () => 'ok'),
  listOwnerQuestionsForUser: jest.fn(async () => ({ rows: [], unmatchedIds: [] })),
  flagOwnerQuestion: jest.fn(async () => ({ kind: 'created', question: { id: 'oq_plain' } })),
  resolveOwnerQuestionsForChatAnswer: jest.fn(async () => {}),
  // OWNER-DISMISS-RAILS (2026-10-20): the supervisor-seat rails — ok by default.
  checkSupervisorDismissRails: jest.fn(async (): Promise<any> => ({ ok: true })),
};
jest.mock('./owner-questions', () => ({ __esModule: true, ...oq }));
const metrics = { recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: { MACHINE_SCHEDULE_MUTATION: 'machine_schedule_mutation', CONFIRMATION_STAGED: 'confirmation_staged', INFRA_ACTION: 'infra_action' } };
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
const rolesSvc = {
  listModelRoles: jest.fn(async () => [{ key: 'supervisor', model: 'kimi-k3', servable: true, fallback: null }]),
  listProviderKeyStatus: jest.fn(() => [{ envKey: 'MOONSHOT_API_KEY', present: true }]),
  listFixedChains: jest.fn(() => []),
  normalizeRoleKey: jest.fn((k: string) => (['supervisor', 'utility', 'coding_default'].includes(k) ? k : null)),
  updateModelRoles: jest.fn(async (_p: any, _u: any, o: any) => [{ key: 'supervisor', model: 'kimi-k3', servable: true, fallback: o?.fallbacks?.supervisor || null }]),
  testModelRole: jest.fn(async (..._a: any[]): Promise<any> => ({ ok: true, target: 'built-in default (kimi-k3)', latencyMs: 812, detail: 'streamed chat completion → first token' })),
};
jest.mock('../model-endpoints/model-roles.service', () => ({ __esModule: true, ...rolesSvc }));
const cmSvc = {
  getChatAccess: jest.fn(async (id: string) => (id === 'c-own' || id === 'shared-1' ? { access: id === 'c-own' ? 'owner' : 'read', exists: true } : { access: 'none', exists: false })),
  searchChatsAndMessages: jest.fn(async () => ({ results: [{ chatId: 'c-own', chatTitle: 'A', snippet: 'hit', messageRole: 'assistant', matchedAt: 'x', projectId: 'proj-1' }, { chatId: 'p-own', chatTitle: 'B', snippet: 'hit2', messageRole: null, matchedAt: 'y', projectId: null }] })),
};
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: cmSvc }));
const pcRows: Record<string, any> = { 'cf_1': { id: 'cf_1', userId: 'u1', chatId: 'lane-x', tool: 'send_chat_message', summary: 'steer y', status: 'pending' } };
const pc = {
  getPendingConfirmation: jest.fn(async (id: string) => pcRows[id] ?? null),
  resolvePendingConfirmation: jest.fn(async (id: string) => pcRows[id]?.status === 'pending' ? ((pcRows[id].status = 'cancelled'), true) : false),
  listPendingConfirmationsForUser: jest.fn(async () => Object.values(pcRows).filter((r) => r.status === 'pending')),
};
jest.mock('./pending-confirmations', () => ({ __esModule: true, ...pc }));
const sched = { resolveScheduleIdForUser: jest.fn(async (_u: string, id: string) => (id.startsWith('sch-1') ? 'sch-1' : null)) };
jest.mock('../coding/schedule.service', () => ({ __esModule: true, ...sched }));
// infra_action's service (dynamic import) — WI-Q pins the two new kinds' dispatch.
const infra = { runInfraAction: jest.fn(async (r: any) => ({ ok: true, kind: r.kind, dryRun: r.kind === 'prune_build_cache', executed: r.kind === 'propose_volume_growth' })) };
jest.mock('../fleet/infra-actions.service', () => ({ __esModule: true, ...infra }));

import { PLATFORM_TOOL_SCHEMA, PLATFORM_MUTATING_TOOLS, PLATFORM_READ_TOOLS, executePlatformTool } from './platform-tools';
import { MUTATING_TOOLS, ASK_ONLY_TOOLS, ToolContext } from '../coding/tools';
import { OPS_TOOL_NAMES, RUN_RECEIPTS_NOTE, CHAT_TURNS_DISCOVERY } from './ops-tools';
import { TELEMETRY_VIEWS, clampTelemetryArgs } from '../fleet/fleet-telemetry';

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
  supStateSvc.isSupervisorChat.mockResolvedValue(false);
  fb.isAdminUser.mockResolvedValue(false);
  pcRows['cf_1'].status = 'pending';
});

describe('ops tools registration (capability gap audit T3a)', () => {
  it('reads join PLATFORM_READ_TOOLS, mutations join MUTATING_TOOLS, set_model_role_fallback is ask-only; telemetry has the three new views', () => {
    const names = PLATFORM_TOOL_SCHEMA.map((t: any) => t.function.name);
    for (const t of OPS_TOOL_NAMES) expect(names).toContain(t);
    for (const t of ['get_model_roles', 'get_run_receipts', 'get_chat_autonomy', 'search_chats', 'list_pending_confirmations']) { expect(PLATFORM_READ_TOOLS).toContain(t); expect(MUTATING_TOOLS.has(t)).toBe(false); }
    for (const t of ['set_model_role_fallback', 'dismiss_owner_question', 'cancel_confirmation']) { expect(PLATFORM_MUTATING_TOOLS).toContain(t); expect(MUTATING_TOOLS.has(t)).toBe(true); }
    expect(ASK_ONLY_TOOLS.has('set_model_role_fallback')).toBe(true);
    for (const v of ['errors', 'jobHealth', 'costs']) expect(TELEMETRY_VIEWS).toContain(v);
    expect(clampTelemetryArgs({ view: 'errors', level: 'error', search: 'ENOENT' })).toMatchObject({ view: 'errors', level: 'error', search: 'ENOENT' });
  });
});

describe('infra_action — prune_build_cache / propose_volume_growth (WI-Q 2026-09-25)', () => {
  it('the tool schema enum carries both kinds + the volumePath/volumeId params', () => {
    const tool: any = PLATFORM_TOOL_SCHEMA.find((t: any) => t.function.name === 'infra_action');
    expect(tool.function.parameters.properties.kind.enum).toEqual(expect.arrayContaining(['prune_build_cache', 'propose_volume_growth']));
    expect(tool.function.parameters.properties.volumePath).toBeDefined();
    expect(tool.function.parameters.properties.volumeId).toBeDefined();
    expect(tool.function.description).toContain('prune_build_cache');
    expect(tool.function.description).toContain('OWNER SPEND');
  });

  it('HOST-level kinds are scoped (review fix 2026-09-25): a plain user chat gets a refusal receipt (NOT_EXECUTED phrase), a supervisor chat or an admin user executes, INFRA_HOST_ACTIONS_ANY_USER=1 lifts the scope; dev-container kinds stay open', async () => {
    metrics.recordLoopMetric.mockClear();
    for (const kind of ['prune_build_cache', 'propose_volume_growth']) {
      const denied = await run('infra_action', { kind, reason: 'disk 88%' });
      expect(denied).toMatchObject({ ok: false, kind, executed: false, refused: expect.stringMatching(/is restricted to admin users/) });
      // Live check 2026-09-25: the scope refusal returned before the service's
      // noteAction, so the promised "receipt on EVERY call" was missing — the
      // refusal now mints its own infra_action row (executed:false, target 'scope').
      await new Promise((r) => setImmediate(r));
      expect(metrics.recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'infra_action', sessionId: 'sup-1', meta: expect.objectContaining({ action: kind, target: 'scope', executed: false, dryRun: false, refused: expect.stringContaining('restricted to admin users') }) }));
    }
    expect(infra.runInfraAction).not.toHaveBeenCalled();
    // a plain lane keeps its OWN-container kinds
    expect(await run('infra_action', { kind: 'env_probe', reason: 'am I red?' })).toMatchObject({ ok: true, kind: 'env_probe' });
    expect(infra.runInfraAction).toHaveBeenCalledTimes(1);
    // supervisor chat → executes
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    expect(await run('infra_action', { kind: 'prune_build_cache', reason: 'disk 88%' })).toMatchObject({ ok: true, kind: 'prune_build_cache', dryRun: true });
    expect(supStateSvc.isSupervisorChat).toHaveBeenCalledWith('sup-1');
    // admin user on a non-supervisor chat → executes
    supStateSvc.isSupervisorChat.mockResolvedValue(false);
    fb.isAdminUser.mockResolvedValue(true);
    expect(await run('infra_action', { kind: 'propose_volume_growth', reason: 'still 88%' })).toMatchObject({ ok: true, kind: 'propose_volume_growth', executed: true });
    // kill switch lifts the scope for a plain user
    fb.isAdminUser.mockResolvedValue(false);
    process.env.INFRA_HOST_ACTIONS_ANY_USER = '1';
    try {
      expect(await run('infra_action', { kind: 'prune_build_cache', reason: 'disk 88%' })).toMatchObject({ ok: true, kind: 'prune_build_cache' });
    } finally { delete process.env.INFRA_HOST_ACTIONS_ANY_USER; }
  });

  it('prune_build_cache dispatches to the service with the reason (dry-run receipt passes through); propose_volume_growth forwards volumePath + a valid volumeId only', async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(true); // host-level kinds: supervisor seat
    expect(await run('infra_action', { kind: 'prune_build_cache', reason: 'disk 88%' })).toMatchObject({ ok: true, kind: 'prune_build_cache', dryRun: true });
    expect(infra.runInfraAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prune_build_cache', userId: 'u1', reason: 'disk 88%', sessionId: 'sup-1' }));
    expect(await run('infra_action', { kind: 'propose_volume_growth', volumePath: '/', volumeId: 'vol-0123456789abcdef0', reason: 'still 88%' })).toMatchObject({ ok: true, kind: 'propose_volume_growth', executed: true });
    expect(infra.runInfraAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'propose_volume_growth', volumePath: '/', volumeId: 'vol-0123456789abcdef0' }));
    await run('infra_action', { kind: 'propose_volume_growth', volumeId: 'not-a-volume; rm -rf /' });
    expect(infra.runInfraAction.mock.calls.at(-1)![0]).not.toHaveProperty('volumeId');
    expect(await run('infra_action', { kind: 'nuke' })).toMatchObject({ ok: false, refused: expect.stringContaining('prune_build_cache | propose_volume_growth') });
  });
});

describe('get_model_roles / set_model_role_fallback', () => {
  it('admin-gated; the fallback write goes through updateModelRoles with the seat key', async () => {
    expect(await executePlatformTool(makeCtx(), 'get_model_roles', {})).toContain('restricted to admin');
    fb.isAdminUser.mockResolvedValue(true);
    expect(await run('get_model_roles', {})).toMatchObject({ ok: true, roles: [expect.objectContaining({ key: 'supervisor' })], providerKeys: expect.any(Array) });
    expect(await run('set_model_role_fallback', { role: 'supervisor', fallback: 'deepseek-flash' }, makeCtx({ userTurnAt: new Date() }))).toMatchObject({ ok: true, role: 'supervisor', fallback: 'deepseek-flash' });
    // ownerConfirmed (review fixer 2026-09-27): the tool is ASK-ONLY, so every
    // execution rode a human approval — the seat-governance refusal yields to it.
    expect(rolesSvc.updateModelRoles).toHaveBeenCalledWith({}, 'u1', { fallbacks: { supervisor: 'deepseek-flash' }, ownerConfirmed: true });
    expect(await run('set_model_role_fallback', { role: 'nope', fallback: '' }, makeCtx({ userTurnAt: new Date() }))).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('test_model_role (WI-M 2026-09-25 — the POST /admin/model-roles/test twin)', () => {
  it('is a READ tool (never mutating), registered in the schema, and a receipt tool', async () => {
    const { RECEIPT_TOOLS } = await import('../coding/run-receipts');
    const { PLATFORM_OBSERVE_TOOLS } = await import('../coding/evidence-tools');
    expect(PLATFORM_TOOL_SCHEMA.map((t: any) => t.function.name)).toContain('test_model_role');
    expect(PLATFORM_READ_TOOLS).toContain('test_model_role');
    expect(MUTATING_TOOLS.has('test_model_role')).toBe(false);
    expect(ASK_ONLY_TOOLS.has('test_model_role')).toBe(false);
    expect(RECEIPT_TOOLS.has('test_model_role')).toBe(true);
    expect(PLATFORM_OBSERVE_TOOLS.has('test_model_role')).toBe(true);
  });

  it('non-admin gets the same "restricted to admin users" refusal shape as get_model_roles; the service is never called', async () => {
    const raw = await executePlatformTool(makeCtx(), 'test_model_role', { role: 'supervisor' });
    expect(raw).toMatch(/^test_model_role is restricted to admin users/);
    expect(rolesSvc.testModelRole).not.toHaveBeenCalled();
    // run-receipts treats the prose refusal as NOT executed (ok:false) — same as get_model_roles
    const { extractReceipt } = await import('../coding/run-receipts');
    expect(extractReceipt('test_model_role', { role: 'supervisor' }, raw, new Date())?.ok).toBe(false);
  });

  it('admin: testModelRole ok → {ok:true, role, model, latencyMs, callShape} receipt; candidate + fallback pass through unsaved', async () => {
    fb.isAdminUser.mockResolvedValue(true);
    const r = await run('test_model_role', { role: 'supervisor' });
    expect(r).toMatchObject({ ok: true, tool: 'test_model_role', role: 'supervisor', model: 'built-in default (kimi-k3)', latencyMs: 812, callShape: 'streamed chat completion → first token' });
    expect(r.message).toContain('supervisor answered in 812 ms');
    expect(rolesSvc.testModelRole).toHaveBeenCalledWith('supervisor', undefined, undefined);
    expect(rolesSvc.updateModelRoles).not.toHaveBeenCalled();

    await run('test_model_role', { role: 'utility', candidate: 'deepseek-flash', fallback: true });
    expect(rolesSvc.testModelRole).toHaveBeenLastCalledWith('utility', 'deepseek-flash', { fallback: true });
    const { extractReceipt } = await import('../coding/run-receipts');
    expect(extractReceipt('test_model_role', { role: 'supervisor' }, JSON.stringify(r), new Date())).toMatchObject({ tool: 'test_model_role', ok: true });
  });

  it('admin: a failed probe reads ok:false with the scrubbed error; a thrown probe reads ok:false reason error; unknown seat → invalid', async () => {
    fb.isAdminUser.mockResolvedValue(true);
    rolesSvc.testModelRole.mockResolvedValueOnce({ ok: false, target: 'my-ollama:qwen3:32b', latencyMs: 20_000, error: 'Timed out after 20s' });
    const failed = await run('test_model_role', { role: 'supervisor', candidate: 'my-ollama:qwen3:32b' });
    expect(failed).toMatchObject({ ok: false, role: 'supervisor', model: 'my-ollama:qwen3:32b', latencyMs: 20_000, error: 'Timed out after 20s', candidate: 'my-ollama:qwen3:32b' });
    expect(failed.message).toContain('probe FAILED');

    rolesSvc.testModelRole.mockRejectedValueOnce(Object.assign(new Error('Unknown model "nope"'), { statusCode: 400 }));
    expect(await run('test_model_role', { role: 'supervisor', candidate: 'nope' })).toMatchObject({ ok: false, reason: 'invalid', error: 'Unknown model "nope"' });
    rolesSvc.testModelRole.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await run('test_model_role', { role: 'supervisor' })).toMatchObject({ ok: false, reason: 'error', error: 'ECONNRESET' });

    expect(await run('test_model_role', { role: 'not-a-seat' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('test_model_role', {})).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('get_run_receipts / get_chat_autonomy / search_chats', () => {
  it('receipts: owner or member reads runs + receipts; foreign → not_found', async () => {
    const out = await run('get_run_receipts', { chatId: 'c-own' });
    expect(out).toMatchObject({ ok: true, ids: { chatId: 'c-own' }, runs: [expect.objectContaining({ id: 'run-1', receipts: [expect.objectContaining({ tool: 'open_pull_request', ids: { prNumber: 42 } })] })] });
    // Live check 2026-09-25: chatTurns is ALWAYS present (an empty array when no
    // chat-turn receipts exist) — REST/tool consumers read the {runs, chatTurns} shape.
    expect(Array.isArray(out.chatTurns)).toBe(true);
    expect(await run('get_run_receipts', { chatId: 'c-other' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
  // Ticket 568d3652 replay (no-defect verdict, 2026-10-02): the adjudicated
  // incident was a lane repeatedly calling get_run_receipts with a chatId it
  // could not read; every call correctly returned not_found — the designed
  // no-existence-leak surface. This pins the full refusal trio so a future
  // refactor cannot silently widen access or mangle the reasons.
  it('receipts: the 568d3652 refusal surfaces — empty chatId → invalid; unreadable chatId → not_found (no existence leak); unknown runId on a readable chat → not_found', async () => {
    // 1. Empty chatId never reaches the DB — invalid, not not_found.
    expect(await run('get_run_receipts', { chatId: '' })).toMatchObject({ ok: false, reason: 'invalid', message: 'chatId is required.' });
    expect(await run('get_run_receipts', { chatId: '   ' })).toMatchObject({ ok: false, reason: 'invalid' });
    // 2. A chatId the caller cannot read (the incident's exact call shape:
    //    sweep passed an id outside its read scope). not_found, with the
    //    no-leak wording — never 'forbidden', never a chat title.
    const unreadable = await run('get_run_receipts', { chatId: 'c-unreadable' });
    expect(unreadable).toMatchObject({ ok: false, reason: 'not_found', message: 'No chat you can read matches that id.' });
    expect(JSON.stringify(unreadable)).not.toContain('forbidden');
    // 3. A readable chat but an unknown runId — not_found again (the mock's
    //    agentRun.findMany honors where.id; unknown ids resolve to []).
    expect(await run('get_run_receipts', { chatId: 'c-own', runId: 'run-does-not-exist' })).toMatchObject({ ok: false, reason: 'not_found', message: 'No run with that id on that chat.' });
    // And a mismatched runId must not leak the readable chat's runs either.
    expect((await run('get_run_receipts', { chatId: 'c-own', runId: 'run-does-not-exist' })).runs ?? []).toHaveLength(0);
  });
  it('receipts: every row prints the receipt `id` (8-char prefix) — the receiptId a kpi: premise cites; the note says so (fixer follow-up 2026-09-27, finding 1)', async () => {
    const out = await run('get_run_receipts', { chatId: 'c-own' });
    const row = out.runs[0].receipts[0];
    expect(row.id).toBe('f5b42fe6');
    expect(dbMock.runToolReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ id: true }) }));
    // the contract's round-trip: what is printed is what the register accepts
    const { normalizeReceiptId } = await import('./kpi-of-record');
    expect(normalizeReceiptId(row.id)).toBe('f5b42fe6');
    expect(out.note).toContain('`id` on each receipt row is the receipt id');
    expect(out.note).toContain('goal_premise_set');
    // a row without an id (legacy mock shape) still renders, id-less
    dbMock.runToolReceipt.findMany.mockResolvedValueOnce([{ runId: 'run-1', tool: 'run_command', ok: true, ids: {}, createdAt: new Date() }] as any);
    const legacy = await run('get_run_receipts', { chatId: 'c-own' });
    expect(legacy.runs[0].receipts[0]).toEqual(expect.objectContaining({ tool: 'run_command' }));
    expect(legacy.runs[0].receipts[0].id).toBeUndefined();
  });
  it('receipts: the note is pinned — a staged row is point-in-time, the owner-card execution mints a NEW row, and the reader is sent to list_pending_confirmations (WI-K + review 2026-09-25)', async () => {
    const out = await run('get_run_receipts', { chatId: 'c-own' });
    expect(out.note).toBe(RUN_RECEIPTS_NOTE);
    expect(out.note).toContain('ids.staged is true');
    expect(out.note).toContain('point-in-time record and is never updated');
    expect(out.note).toContain('mints a NEW row');
    expect(out.note).toContain('ids.ownerConfirmed=true');
    expect(out.note).toContain('list_pending_confirmations');
    // The retracted claim: the card path does NOT re-run the tool through the loop.
    expect(out.note).not.toContain('only when the owner confirms and the tool re-runs');
  });
  // ── Ticket e225aad8: chat/supervisor turns — ONE chatTurns entry PER TURN ──
  it('receipts (e225aad8): chat turns group ONE chatTurns entry per telemetry runId (chat-<uuid>), each with its own receipts — no more single fused null bucket', async () => {
    const out = await run('get_run_receipts', { chatId: 'c-own' });
    // The mock rows carry two distinct chat-turn ids (chat-turn-1, chat-turn-2)
    // plus the durable run-1 row. The discovery read (OR: runId null / notIn
    // known agent runs) excludes run-1's rows; the two turns must surface as
    // TWO separate chatTurns entries, oldest-first.
    expect(out.chatTurns).toHaveLength(2);
    expect(out.chatTurns[0]).toMatchObject({ runId: 'chat-turn-1' });
    expect(out.chatTurns[0].receipts.map((r: any) => r.tool)).toEqual(['run_command', 'get_chat_status']);
    expect(out.chatTurns[1]).toMatchObject({ runId: 'chat-turn-2' });
    expect(out.chatTurns[1].receipts.map((r: any) => r.tool)).toEqual(['update_supervisor_state']);
    // The discovery read is bounded by CHAT_TURNS_DISCOVERY (not the old 200).
    const discovery = dbMock.runToolReceipt.findMany.mock.calls.map((c: any[]) => c[0]).find((q: any) => q?.where?.OR && q.where.chatId);
    expect(discovery).toBeTruthy();
    expect(dbMock.runToolReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: CHAT_TURNS_DISCOVERY, orderBy: { createdAt: 'desc' } }));
  });
  it('receipts (e225aad8): legacy null-runId rows still group under the null bucket — the pre-fix shape stays readable', async () => {
    const real = dbMock.runToolReceipt.findMany.getMockImplementation()!;
    dbMock.runToolReceipt.findMany.mockImplementation(async () => [{ id: 'legacy-0001-1111-4000-8000-000000000000', runId: null, tool: 'pause_schedule', ok: true, ids: {}, createdAt: new Date('2026-10-18T04:00:00Z') }] as any);
    try {
      const out = await run('get_run_receipts', { chatId: 'c-own' });
      expect(out.chatTurns).toEqual([{ runId: null, receipts: [expect.objectContaining({ tool: 'pause_schedule' })] }]);
    } finally {
      dbMock.runToolReceipt.findMany.mockImplementation(real);
    }
  });
  it('receipts (e225aad8): a runId that names a chat TURN id returns that turn\'s receipts as one chatTurns entry instead of 404', async () => {
    const out = await run('get_run_receipts', { chatId: 'c-own', runId: 'chat-turn-1' });
    expect(out).toMatchObject({ ok: true, ids: { chatId: 'c-own' } });
    expect(out.runs).toEqual([]);
    expect(out.chatTurns).toHaveLength(1);
    expect(out.chatTurns[0]).toMatchObject({ runId: 'chat-turn-1' });
    expect(out.chatTurns[0].receipts.map((r: any) => r.tool)).toEqual(['run_command', 'get_chat_status']);
  });
  it('receipts (e225aad8): a runId with no agent_runs row AND no receipt rows keeps the not_found contract', async () => {
    expect(await run('get_run_receipts', { chatId: 'c-own', runId: 'run-does-not-exist' })).toMatchObject({ ok: false, reason: 'not_found', message: 'No run with that id on that chat.' });
  });
  it('receipts: E5 contextFill rides each run — peak prompt tokens per model vs its window, from the run_context_fill loop_metrics rows', async () => {
    const out = await run('get_run_receipts', { chatId: 'c-own' });
    expect(out.runs[0]).toMatchObject({
      id: 'run-1',
      contextFill: [expect.objectContaining({ model: 'glm-5.3', peakPromptTokens: 250_000, windowTokens: 1_000_000, fillRatio: 0.25 })],
    });
    // runId-narrowed reads surface the fill too (one run, one fill list).
    const one = await run('get_run_receipts', { chatId: 'c-own', runId: 'run-1' });
    expect(one.runs[0].contextFill).toHaveLength(1);
  });
  // Secret-scrubbing D4 (2026-09-27): a machine-run read of receipts is
  // redacted (ids / error carry lane-authored strings). FAKE fixture only.
  const FAKE_ZAI = '0123456789abcdef0123456789abcdef' + '.AbCdEfGhIjKlMnOp';
  const REDACTED = '[REDACTED: looked like a credential]';
  it('receipts: a MACHINE run (the fixture ctx has no userTurnAt) gets credential-shaped strings redacted, the envelope stays valid JSON and opens with the notice; a user-present turn reads verbatim', async () => {
    dbMock.runToolReceipt.findMany.mockResolvedValue([{ id: 'r-d4-1', runId: 'run-1', tool: 'run_command', ok: true, ids: { note: `ran with ZAI_API_KEY=${FAKE_ZAI}`, prNumber: 7 } as any, createdAt: new Date() }]);
    try {
      const out = await run('get_run_receipts', { chatId: 'c-own' });
      expect(JSON.stringify(out)).not.toContain(FAKE_ZAI);
      expect(out.runs[0].receipts[0].ids).toEqual({ note: `ran with ZAI_API_KEY=${REDACTED}`, prNumber: 7 });
      expect(out.ok).toBe(true);
      expect(out.note).toBe(RUN_RECEIPTS_NOTE);
      expect(Array.isArray(out.chatTurns)).toBe(true);
      expect(out.secretRedactionNotice).toContain('CREDENTIALS REDACTED');
      expect(out.secretRedactionNotice).toContain('Z.ai API key');
      expect(Object.keys(out)[0]).toBe('secretRedactionNotice');
      expect(metrics.recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat_read_secret_redacted', meta: expect.objectContaining({ tool: 'get_run_receipts', chatId: 'c-own', hits: ['Z.ai API key'], machine: true }) }));
      // User-present turn: verbatim, no notice.
      const human = await run('get_run_receipts', { chatId: 'c-own' }, makeCtx({ userTurnAt: new Date() }));
      expect(human.runs[0].receipts[0].ids.note).toContain(FAKE_ZAI);
      expect(human.secretRedactionNotice).toBeUndefined();
    } finally {
      dbMock.runToolReceipt.findMany.mockResolvedValue([{ id: 'r-d4-2', runId: 'run-1', tool: 'open_pull_request', ok: true, ids: { prNumber: 42 }, createdAt: new Date() }]);
    }
  });
  // Review fix: the redaction runs per STRING LEAF of the envelope object —
  // a regex over the serialized JSON consumed the backslash of an escaped
  // quote and handed the model malformed JSON with no notice.
  it('receipts: a value carrying a quote and a newline is redacted per field — the envelope still parses and opens with the notice', async () => {
    dbMock.runToolReceipt.findMany.mockResolvedValue([{ id: 'r-d4-3', runId: 'run-1', tool: 'run_command', ok: false, ids: { note: `token=AbCdEfGhIjKlMnOpQrStUv12"tail" x\nNext line ${FAKE_ZAI}`, detail: `failed with api_key=${'x'.repeat(24)}\n"quoted"`, prNumber: 7 } as any, createdAt: new Date() }]);
    try {
      const out = await run('get_run_receipts', { chatId: 'c-own' }); // run() JSON.parses — malformed JSON would throw here
      expect(Object.keys(out)[0]).toBe('secretRedactionNotice');
      expect(out.runs[0].receipts[0].ids).toEqual({ note: `token=${REDACTED}"tail" x\nNext line ${REDACTED}`, detail: `failed with api_key=${REDACTED}\n"quoted"`, prNumber: 7 });
      expect(JSON.stringify(out)).not.toContain(FAKE_ZAI);
      expect(JSON.stringify(out)).not.toContain('AbCdEfGhIjKlMnOpQrStUv12');
    } finally {
      dbMock.runToolReceipt.findMany.mockResolvedValue([{ id: 'r-d4-4', runId: 'run-1', tool: 'open_pull_request', ok: true, ids: { prNumber: 42 }, createdAt: new Date() }]);
    }
  });
  // Review fix: origin-aware machine classification — an agent-origin wake
  // whose sending run was user-anchored carries userTurnAt but is a machine run.
  it('receipts: ctx.machineTriggered=true redacts even when a userTurnAt anchor rode along', async () => {
    dbMock.runToolReceipt.findMany.mockResolvedValue([{ id: 'r-d4-5', runId: 'run-1', tool: 'run_command', ok: true, ids: { note: `key ${FAKE_ZAI}` } as any, createdAt: new Date() }]);
    try {
      const out = await run('get_run_receipts', { chatId: 'c-own' }, makeCtx({ userTurnAt: new Date(), machineTriggered: true }));
      expect(out.runs[0].receipts[0].ids.note).toBe(`key ${REDACTED}`);
      expect(out.secretRedactionNotice).toContain('CREDENTIALS REDACTED');
      expect(metrics.recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat_read_secret_redacted', meta: expect.objectContaining({ tool: 'get_run_receipts', machine: true }) }));
    } finally {
      dbMock.runToolReceipt.findMany.mockResolvedValue([{ id: 'r-d4-6', runId: 'run-1', tool: 'open_pull_request', ok: true, ids: { prNumber: 42 }, createdAt: new Date() }]);
    }
  });
  it('search: snippets are redacted on a machine run (a pasted key rides a 90-char window like a body); user-present verbatim', async () => {
    cmSvc.searchChatsAndMessages.mockResolvedValueOnce({ results: [{ chatId: 'c-own', chatTitle: 'A', snippet: `…bench key ${FAKE_ZAI} use it…`, messageRole: 'user', matchedAt: 'x', projectId: 'proj-1' }] });
    const machine = await run('search_chats', { q: 'bench' });
    expect(machine.results[0].snippet).toBe(`…bench key ${REDACTED} use it…`);
    expect(machine.secretRedactionNotice).toContain('Z.ai API key');
    expect(machine).toMatchObject({ ok: true, count: 1, query: 'bench' });
    cmSvc.searchChatsAndMessages.mockResolvedValueOnce({ results: [{ chatId: 'c-own', chatTitle: 'A', snippet: `…bench key ${FAKE_ZAI} use it…`, messageRole: 'user', matchedAt: 'x', projectId: 'proj-1' }] });
    const human = await run('search_chats', { q: 'bench' }, makeCtx({ userTurnAt: new Date() }));
    expect(human.results[0].snippet).toContain(FAKE_ZAI);
    expect(human.secretRedactionNotice).toBeUndefined();
  });
  it('autonomy: defaults to this chat, owner-scoped', async () => {
    chats['sup-1'] = { id: 'sup-1', userId: 'u1', codingState: null };
    autonomySvc.getChatAutonomy.mockResolvedValueOnce({ chatId: 'sup-1', allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' });
    expect(await run('get_chat_autonomy', {})).toMatchObject({ ok: true, ids: { chatId: 'sup-1' }, autonomy: { allowedTools: ['send_chat_message'] } });
    expect(await run('get_chat_autonomy', { chatId: 'c-other' })).toMatchObject({ ok: false, reason: 'not_found' });
    delete chats['sup-1'];
  });
  // 1769c8d1 + owner 2026-09-27 (no hidden cost caps): the governing spend cap
  // rides the read (spendCap + the message line) — the user-set PROJECT cap or
  // null. Same presence contract as get_spend's cap: present-with-nulls =
  // checked, none set; ABSENT = the read failed.
  it('autonomy — surfaces the PROJECT spend cap + source when set; explicit null when none (REGRESSION PIN: no cap when no project cap); absent on resolver failure', async () => {
    chats['sup-1'] = { id: 'sup-1', userId: 'u1', codingState: null };
    try {
      const none = await run('get_chat_autonomy', {});
      expect(none).toMatchObject({ ok: true, ids: { chatId: 'sup-1' }, spendCap: { spendCapUsdPerDay: null, spendCapSource: null } });
      expect(none.message).not.toContain('spend cap');
      mockLaneSpendCap.mockResolvedValueOnce({ spendCapUsdPerDay: 25, spendCapSource: 'project', projectId: 'proj-1' });
      const capped = await run('get_chat_autonomy', {});
      expect(capped).toMatchObject({ ok: true, spendCap: { spendCapUsdPerDay: 25, spendCapSource: 'project' } });
      expect(capped.message).toContain('spend cap $25/day (project)');
      expect(mockLaneSpendCap).toHaveBeenCalledWith('sup-1');
      mockLaneSpendCap.mockRejectedValueOnce(new Error('store down'));
      const hiccup = await run('get_chat_autonomy', {});
      expect(hiccup).toMatchObject({ ok: true, ids: { chatId: 'sup-1' } });
      expect(hiccup.spendCap).toBeUndefined();
    } finally {
      delete chats['sup-1'];
    }
  });
  it('search: ≥2 chars, projectId filter, limit', async () => {
    expect(await run('search_chats', { q: 'x' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('search_chats', { q: 'hit', projectId: 'proj-1' })).toMatchObject({ ok: true, count: 1, results: [expect.objectContaining({ chatId: 'c-own' })] });
    // audit 2026-10-08 W1-3: archived chats are searched by default.
    expect(cmSvc.searchChatsAndMessages).toHaveBeenCalledWith('u1', 'hit', { includeArchived: true });
  });
  it('audit 2026-10-08 W1-3: includeArchived defaults true (archivedHits counted); false opts out and the envelope says so; the kill switch restores the old default', async () => {
    cmSvc.searchChatsAndMessages.mockResolvedValueOnce({ results: [{ chatId: '7b595cbd-1', chatTitle: 'Maxing GPU on', snippet: '128k + 2 lanes', messageRole: 'user', matchedAt: 'x', projectId: 'p', archived: true } as any] });
    expect(await run('search_chats', { q: '128k' })).toMatchObject({ ok: true, includeArchived: true, archivedHits: 1, results: [expect.objectContaining({ archived: true })] });
    const off = await run('search_chats', { q: '128k', includeArchived: false });
    expect(off).toMatchObject({ ok: true, includeArchived: false });
    expect(off.scope).toContain('archived chats EXCLUDED');
    expect(cmSvc.searchChatsAndMessages).toHaveBeenLastCalledWith('u1', '128k', { includeArchived: false });
    process.env.SEARCH_CHATS_INCLUDE_ARCHIVED_DISABLED = '1';
    try {
      await run('search_chats', { q: '128k' });
      expect(cmSvc.searchChatsAndMessages).toHaveBeenLastCalledWith('u1', '128k', { includeArchived: false });
      await run('search_chats', { q: '128k', includeArchived: true });
      expect(cmSvc.searchChatsAndMessages).toHaveBeenLastCalledWith('u1', '128k', { includeArchived: true });
    } finally { delete process.env.SEARCH_CHATS_INCLUDE_ARCHIVED_DISABLED; }
  });
});

describe('dismiss_owner_question / cancel_confirmation / list_pending_confirmations', () => {
  it('dismiss: machine lane that did not file it → scope; filing chat, supervisor seat, user-present → ok', async () => {
    expect(await run('dismiss_owner_question', { questionId: 'oq_1' }, makeCtx({ sessionId: 'lane-z' }))).toMatchObject({ ok: false, reason: 'scope' });
    expect(await run('dismiss_owner_question', { questionId: 'oq_1' }, makeCtx({ sessionId: 'lane-x' }))).toMatchObject({ ok: true, questionId: 'oq_1', dismissedBy: 'agent' });
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    expect(await run('dismiss_owner_question', { questionId: 'oq_1', reason: 'moot' })).toMatchObject({ ok: true, dismissedBy: 'supervisor' });
    supStateSvc.isSupervisorChat.mockResolvedValue(false);
    expect(await run('dismiss_owner_question', { questionId: 'oq_1' }, makeCtx({ sessionId: 'lane-z', userTurnAt: new Date() }))).toMatchObject({ ok: true, dismissedBy: 'owner' });
    // abca56ce: the actor rides the service call (attribution), and the tool
    // result names who dismissed — never a hardcoded "the owner".
    expect(oq.dismissOwnerQuestion).toHaveBeenCalledWith('oq_1', 'u1', { dismissedBy: 'owner', reason: undefined });
  });
  // OWNER-DISMISS-RAILS (2026-10-20): a SUPERVISOR seat on a machine turn passes the
  // rails (owner-only class / owner engaged / project scope) before anything is dismissed.
  describe('owner-dismiss rails (supervisor seat, machine turn)', () => {
    afterEach(() => { delete process.env.OWNER_DISMISS_RAILS_DISABLED; delete chats['ps-apollo']; });

    it('a rails refusal is returned verbatim and nothing is dismissed', async () => {
      supStateSvc.isSupervisorChat.mockResolvedValue(true);
      oq.checkSupervisorDismissRails.mockResolvedValueOnce({ ok: false, reason: 'owner_only_class', detail: 'credentials' });
      const r = await run('dismiss_owner_question', { questionId: 'oq_1', reason: 'moot' });
      expect(r).toMatchObject({ ok: false, reason: 'owner_only_class', detail: 'credentials', questionId: 'oq_1' });
      expect(r.message).toMatch(/^REFUSED — owner-only class/);
      expect(oq.dismissOwnerQuestion).not.toHaveBeenCalled();
      expect(oq.checkSupervisorDismissRails).toHaveBeenCalledWith(expect.objectContaining({ id: 'oq_1', chatId: 'lane-x' }), { role: 'fleet', projectId: null });
    });

    it('a PROJECT supervisor seat is checked with its project and narrated as the project supervisor', async () => {
      chats['ps-apollo'] = { id: 'ps-apollo', userId: 'u1', isProjectSupervisor: true, isSupervisor: false, projectId: 'p-apollo' };
      supStateSvc.isSupervisorChat.mockResolvedValue(true);
      const r = await run('dismiss_owner_question', { questionId: 'oq_1', reason: 'moot' }, makeCtx({ sessionId: 'ps-apollo' }));
      expect(r).toMatchObject({ ok: true, dismissedBy: 'supervisor' });
      expect(r.message).toContain('as the project supervisor (standing directives)');
      expect(oq.checkSupervisorDismissRails).toHaveBeenCalledWith(expect.any(Object), { role: 'project', projectId: 'p-apollo' });
      expect(oq.dismissOwnerQuestion).toHaveBeenCalledWith('oq_1', 'u1', { dismissedBy: 'supervisor', reason: 'moot', supervisorRole: 'project' });
    });

    it('the owner (user-present) and the filing chat never run the rails; the kill switch skips them for a supervisor', async () => {
      await run('dismiss_owner_question', { questionId: 'oq_1' }, makeCtx({ sessionId: 'lane-z', userTurnAt: new Date() }));
      await run('dismiss_owner_question', { questionId: 'oq_1' }, makeCtx({ sessionId: 'lane-x' }));
      expect(oq.checkSupervisorDismissRails).not.toHaveBeenCalled();
      process.env.OWNER_DISMISS_RAILS_DISABLED = '1';
      supStateSvc.isSupervisorChat.mockResolvedValue(true);
      const r = await run('dismiss_owner_question', { questionId: 'oq_1', reason: 'moot' });
      expect(r).toMatchObject({ ok: true, dismissedBy: 'supervisor' });
      expect(r.message).toContain('as the Fleet Supervisor (standing directives)');
      expect(oq.checkSupervisorDismissRails).not.toHaveBeenCalled();
      expect(oq.dismissOwnerQuestion).toHaveBeenLastCalledWith('oq_1', 'u1', { dismissedBy: 'supervisor', reason: 'moot' });
    });
  });

  it('cancel: staging chat / supervisor / user-present may cancel; already resolved reported; list shows pending only', async () => {
    expect(await run('list_pending_confirmations', {})).toMatchObject({ ok: true, count: 1, cards: [expect.objectContaining({ id: 'cf_1', tool: 'send_chat_message' })] });
    expect(await run('cancel_confirmation', { confirmationId: 'cf_1' }, makeCtx({ sessionId: 'lane-z' }))).toMatchObject({ ok: false, reason: 'scope' });
    expect(await run('cancel_confirmation', { confirmationId: 'cf_1' }, makeCtx({ sessionId: 'lane-x' }))).toMatchObject({ ok: true, cancelledTool: 'send_chat_message' });
    expect(await run('cancel_confirmation', { confirmationId: 'cf_1' }, makeCtx({ sessionId: 'lane-x' }))).toMatchObject({ ok: false, reason: 'already_resolved' });
    expect(await run('cancel_confirmation', { confirmationId: 'cf_9' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('list_pending_confirmations', {})).toMatchObject({ ok: true, count: 0 });
  });
});

describe('list_chats filters + hook_subscribe projectId (T3a pass-throughs)', () => {
  it('list_chats forwards archived / mode / status', async () => {
    svc.listChats.mockResolvedValue({ chats: [], total: 0 });
    await executePlatformTool(makeCtx(), 'list_chats', { archived: true, mode: 'thinking', status: 'ready' });
    expect(svc.listChats).toHaveBeenCalledWith(expect.objectContaining({ archived: true, mode: 'thinking', status: 'ready' }));
  });
});

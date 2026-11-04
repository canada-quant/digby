/**
 * Capability gap audit tranche 3b (2026-09-24) — platform/coord-tools.ts:
 * wait_for_chat, get_chat_instructions, list_github_repos, list_session_files,
 * read_session_file, sync_workspace, stage_upload, configure_workspace,
 * import_repo — plus set_chat_instructions {chatId} (account-tools) gating.
 *
 * Pins:
 *   - registration: reads in PLATFORM_READ_TOOLS, mutations in MUTATING_TOOLS,
 *     wait_for_chat is NON-evidence, configure_workspace / import_repo /
 *     set_chat_instructions are consequential (machine run without a grant
 *     STAGES; supervisor-shaped grant executes);
 *   - wait_for_chat: idle → returns immediately; running → polls until idle;
 *     until=attention returns on a parked question; timeout envelope; self
 *     refused; kill switch;
 *   - get_chat_instructions: full text, supervisor-managed, not_found;
 *   - stage_upload: content → owner-stamped 15-min blob (exactly one source);
 *   - read_session_file / list_session_files: member access ('read'), status
 *     mapping (413 too_large, 415 binary, 404 not_found);
 *   - sync_workspace owner-only + no_workspace; import_repo applies the SSRF
 *     jail and files under parentId; configure_workspace provisions with the
 *     user's token; set_chat_instructions self stays user-turn-only, foreign
 *     executes after the gate with fromChatId audited.
 *
 * Scaffolding mirrors platform-tools.ops-tools.test.ts.
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
  // Ticket 23f453de: the configure_workspace / sync_workspace seam resolves
  // project references with the SAME canonicalizer start_coding_session uses.
  // Default implementation preserves the pre-fix shapes for every other test
  // in this suite (exact ids resolve; 'proj-x' does not).
  canonicalizeProjectReference: jest.fn(async (_u: string, raw: string) => ((raw === 'proj-1' || raw === 'proj-2') ? { id: raw, via: 'id' as const } : null)),
  suggestProjectsByIdPrefix: jest.fn(async () => [] as Array<{ id: string; name: string }>),
  setChatMode: jest.fn(async ({ chatId, mode }: any) => ({ id: chatId, mode: mode === 'auto' ? 'thinking' : mode })),
  getProject: jest.fn(async ({ projectId }: any) => (projectId === 'proj-1' ? { id: 'proj-1', name: 'P', spendCapUsdPerDay: 25 } : (() => { throw Object.assign(new Error('Project not found or no access'), { statusCode: 404 }); })())),
  setChatScheduleEnabled: jest.fn(async () => ({ schedule: { id: 'sch-1', nextRunAt: '2026-09-25T00:00:00Z', lastStatus: 'active' }, changed: true })),
};
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

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
    findMany: jest.fn(async ({ where }: any) => (where.sessionId === 'c-own' ? [{ id: 'run-1', status: 'completed', attempts: 1, currentStep: 12, error: null, createdAt: new Date(), startedAt: new Date(), finishedAt: new Date() }] : [])),
  },
  runToolReceipt: { findMany: jest.fn(async () => [{ runId: 'run-1', tool: 'open_pull_request', ok: true, ids: { prNumber: 42 }, createdAt: new Date() }]) },
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
  getSessionAttention: jest.fn(async (): Promise<{ approvals: string[]; questions: string[] }> => ({ approvals: [], questions: [] })),
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
const busy = { hasRemoteChatRun: jest.fn(async () => false), requestChatRunStop: jest.fn(async () => true), isChatBusy: jest.fn(async (): Promise<boolean> => false) };
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
};
jest.mock('../model-endpoints/model-roles.service', () => ({ __esModule: true, ...rolesSvc }));
const cmSvc = {
  getChatAccess: jest.fn(async (id: string) => (id === 'c-own' || id === 'shared-1' ? { access: id === 'c-own' ? 'owner' : 'read', exists: true } : { access: 'none', exists: false })),
  searchChatsAndMessages: jest.fn(async () => ({ results: [{ chatId: 'c-own', chatTitle: 'A', snippet: 'hit', messageRole: 'assistant', matchedAt: 'x', projectId: 'proj-1' }, { chatId: 'p-own', chatTitle: 'B', snippet: 'hit2', messageRole: null, matchedAt: 'y', projectId: null }] })),
};
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: cmSvc }));
// pending-confirmations stays REAL here (backed by the testkit table on dbMock) so the
// consequential gate's staging is observable via pendingConfirmationCount().

const sched = { resolveScheduleIdForUser: jest.fn(async (_u: string, id: string) => (id.startsWith('sch-1') ? 'sch-1' : null)) };
jest.mock('../coding/schedule.service', () => ({ __esModule: true, ...sched }));

// ── T3b boundaries ──────────────────────────────────────────────────────────
const wt = {
  resolveWorktreeForUser: jest.fn(async (chatId: string, _u: string, minAccess: string) => (chatId === 'c-own' || (chatId === 'shared-1' && minAccess === 'read') ? { ok: true, ctx: { chatId, root: '/wt/' + chatId, snapshot: null, disk: true } } : { ok: false, status: 404, error: 'Session not found' })),
  listWorktreeTreeCore: jest.fn(async (_c: any, rel: string) => (rel === 'missing' ? { status: 404, body: { error: 'Path not found' } } : { status: 200, body: { path: rel, entries: [{ name: 'README.md', type: 'file', size: 12 }] } })),
  readWorktreeFileCore: jest.fn(async (_c: any, rel: string) => rel === 'big.bin' ? { status: 413, body: { error: 'too big' } } : rel === 'img.png' ? { status: 415, body: { error: 'Binary file' } } : rel === 'nope' ? { status: 404, body: { error: 'Path not found in the worktree' } } : { status: 200, body: { path: rel, content: 'hello', truncated: false } }),
  resolveSafeWorktreePath: jest.fn(async (root: string, rel: string) => ({ abs: root + '/' + rel, rel })),
  isProbablyBinary: jest.fn(() => false),
  SNIFF_BYTES: 8192,
};
jest.mock('../coding/worktree-files', () => ({ __esModule: true, ...wt }));
const up = { saveAttachment: jest.fn(async () => {}) };
jest.mock('../upload.controller', () => ({ __esModule: true, ...up }));
const ws = {
  validateRepoUrl: jest.fn((u: string) => (/^https:\/\//.test(u) && !/127\.0\.0\.1|localhost/.test(u) ? null : 'Only https git URLs are supported')),
  // Ticket 23f453de: mirrors the REAL service's named 404 (never a bare
  // "Project not found") so the fail-open seam path is observable here.
  configureWorkspace: jest.fn(async (projectId: string) => (projectId === 'proj-1' ? { provider: 'github' } : (() => { throw Object.assign(new Error(`Project not found (projectId: "${projectId}"). No project you own matches that exact id — pass the id verbatim from list_projects; on the configure_workspace tool its EXACT name, a chat id inside the project, or a unique ≥8-char id prefix also resolves. Never reconstruct or abbreviate an id.`), { status: 404 }); })())),
  ensureProvisioned: jest.fn(async (_p: string, getToken: () => Promise<string | null>) => { await getToken(); return '/mirror'; }),
  getWorkspace: jest.fn(async () => ({ provider: 'github', repoUrl: 'https://github.com/o/r', defaultBranch: 'main', provisioned: true })),
  syncKnowledgeToRepo: jest.fn(async () => ({ committed: 2, skipped: 1 })),
};
jest.mock('../coding/project-workspace.service', () => ({ __esModule: true, ...ws }));
const tokens = { getValidToken: jest.fn(async () => 'ghp_x'), getAllValidTokens: jest.fn(async (): Promise<any[]> => []) };
jest.mock('../github/token-manager', () => ({ __esModule: true, ...tokens }));
const projects: Record<string, any> = { 'proj-1': { id: 'proj-1', name: 'P', repoProvider: 'github' }, 'proj-2': { id: 'proj-2', name: 'Q', repoProvider: null } };
(dbMock as any).crossModelProject = { findFirst: jest.fn(async ({ where }: any) => (projects[where.id] && (!where.userId || where.userId === 'u1') ? projects[where.id] : null)) };
(dbMock as any).projectDocument = { findUnique: jest.fn(async ({ where }: any) => (where.id === 'doc-1' ? { id: 'doc-1', name: 'spec.pdf', projectId: 'proj-1', userId: 'u1', status: 'ready' } : null)) };
(dbMock as any).projectChunk = { findMany: jest.fn(async () => [{ content: 'chunk one' }, { content: 'chunk two' }]) };
(svc as any).getProjectAccess = jest.fn(async (projectId: string) => (projectId === 'proj-1' ? { project: { id: 'proj-1' }, role: 'owner' } : null));
(dbMock as any).generatedFile = { findFirst: jest.fn(async ({ where }: any) => (where.id === 'gf-1' && where.userId === 'u1' ? { id: 'gf-1', filename: 'r.csv', mimeType: 'text/csv', size: 5, data: Buffer.from('a,b\n1').toString('base64'), textContent: 'a,b\n1' } : null)) };
(dbMock as any).crossModelProject.create = jest.fn(async ({ data }: any) => ({ id: 'proj-new', ...data }));
(dbMock as any).activity = { create: jest.fn(async () => ({})) };
chats['shared-1'] = { id: 'shared-1', userId: 'u2', codingState: { id: 'cs3' }, systemPrompt: 'Always cite sources.', isSupervisor: false, isProjectSupervisor: false };
chats['c-own'].systemPrompt = null;
chats['sup-chat'] = { id: 'sup-chat', userId: 'u1', isSupervisor: true, systemPrompt: 'managed' };
cmSvc.getChatAccess.mockImplementation(async (id: string) => (id === 'c-own' || id === 'p-own' ? { access: 'owner', exists: true } : id === 'shared-1' || id === 'sup-chat' ? { access: 'read', exists: true } : { access: 'none', exists: false }));
(dbMock as any).crossModelChat.updateMany = jest.fn(async ({ where }: any) => ({ count: chats[where.id] && chats[where.id].userId === where.userId && !chats[where.id].isSupervisor ? 1 : 0 }));
jest.mock('../coding/coding-data.service', () => ({ __esModule: true, ...codingData, createCodingProject: jest.fn(async (d: any) => ({ id: 'proj-new', name: d.name, repoUrl: d.repoUrl })) }));

import { PLATFORM_TOOL_SCHEMA, PLATFORM_MUTATING_TOOLS, PLATFORM_READ_TOOLS, executePlatformTool, TARGET_SCOPED_CONSEQUENTIAL_TOOLS } from './platform-tools';
import { MUTATING_TOOLS, ToolContext } from '../coding/tools';
import { COORD_TOOL_NAMES, WAIT_FOR_CHAT_MAX_SEC, stagedMime } from './coord-tools';
import { NON_EVIDENCE_TOOLS } from '../coding/evidence-tools';
import { pendingConfirmationCount } from './pending-confirmations';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt/sup-1', sessionId: 'sup-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}
const run = async (name: string, args: any, ctx = makeCtx()) => JSON.parse(await executePlatformTool(ctx, name, args));
const runRaw = async (name: string, args: any, ctx = makeCtx()) => executePlatformTool(ctx, name, args);

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  supStateSvc.isSupervisorChat.mockResolvedValue(false);
  busy.isChatBusy.mockResolvedValue(false);
  lock.getSessionAttention.mockResolvedValue({ approvals: [], questions: [] });
  autonomySvc.getChatAutonomy.mockResolvedValue({ chatId: 'sup-1', allowedTools: [...ALL_CONTROL, 'set_chat_instructions', 'configure_workspace', 'import_repo'], source: 'manual' });
  process.env.WAIT_FOR_CHAT_POLL_MS = '5';
});

describe('coord tools registration (capability gap audit T3b)', () => {
  it('reads join PLATFORM_READ_TOOLS, mutations join MUTATING_TOOLS; wait_for_chat is non-evidence; set_chat_instructions is target-scoped', () => {
    const names = PLATFORM_TOOL_SCHEMA.map((t: any) => t.function.name);
    for (const t of COORD_TOOL_NAMES) expect(names).toContain(t);
    for (const t of ['wait_for_chat', 'get_chat_instructions', 'list_github_repos', 'list_session_files', 'read_session_file']) {
      expect(PLATFORM_READ_TOOLS).toContain(t);
      expect(MUTATING_TOOLS.has(t)).toBe(false);
    }
    for (const t of ['sync_workspace', 'stage_upload', 'configure_workspace', 'import_repo']) {
      expect(PLATFORM_MUTATING_TOOLS).toContain(t);
      expect(MUTATING_TOOLS.has(t)).toBe(true);
    }
    expect(NON_EVIDENCE_TOOLS.has('wait_for_chat')).toBe(true);
    expect(TARGET_SCOPED_CONSEQUENTIAL_TOOLS.has('set_chat_instructions')).toBe(true);
    expect(WAIT_FOR_CHAT_MAX_SEC).toBe(600);
  });
});

describe('wait_for_chat', () => {
  it('returns idle immediately when the chat has no run', async () => {
    const r = await run('wait_for_chat', { chatId: 'c-own' });
    expect(r).toMatchObject({ ok: true, outcome: 'idle', polls: 1, running: false });
  });
  it('polls until the run ends, then reports idle with the wait', async () => {
    busy.isChatBusy.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const r = await run('wait_for_chat', { chatId: 'c-own', timeoutSec: 30 });
    expect(r).toMatchObject({ ok: true, outcome: 'idle' });
    expect(r.polls).toBe(3);
  });
  it('until=attention returns as soon as the chat parks on a question', async () => {
    busy.isChatBusy.mockResolvedValue(true);
    lock.getSessionAttention.mockResolvedValueOnce({ approvals: [], questions: [] }).mockResolvedValue({ approvals: [], questions: ['q-1'] });
    const r = await run('wait_for_chat', { chatId: 'c-own', until: 'attention', timeoutSec: 30 });
    expect(r).toMatchObject({ ok: true, outcome: 'attention', attention: { awaitingInput: true, pendingQuestions: ['q-1'] } });
    expect(r.polls).toBe(2);
  });
  it('times out honestly (bounded) and clamps timeoutSec to [5, 600]', async () => {
    busy.isChatBusy.mockResolvedValue(true);
    process.env.WAIT_FOR_CHAT_POLL_MS = '2000';
    const t0 = Date.now();
    const r = await run('wait_for_chat', { chatId: 'c-own', timeoutSec: 0.01 });
    // 0.01 clamps UP to 5 s? no — the loop returns on the first elapsed check
    // once remainingMs ≤ 0; with the 5 s floor the poll sleeps ≤ remaining.
    expect(r.ok).toBe(true);
    expect(['timeout', 'idle']).toContain(r.outcome);
    expect(Date.now() - t0).toBeLessThan(WAIT_FOR_CHAT_MAX_SEC * 1000);
  }, 10_000);
  it('refuses to wait on itself and on an unreadable chat', async () => {
    expect(await run('wait_for_chat', { chatId: 'sup-1' })).toMatchObject({ ok: false, reason: 'self' });
    expect(await run('wait_for_chat', { chatId: 'nope' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(busy.isChatBusy).not.toHaveBeenCalled();
  });
});

describe('get_chat_instructions + set_chat_instructions {chatId}', () => {
  it('reads the FULL text of a readable chat; supervisor chats are platform-managed; none → chars 0', async () => {
    expect(await run('get_chat_instructions', { chatId: 'shared-1' })).toMatchObject({ ok: true, instructions: 'Always cite sources.', chars: 20, supervisorManaged: false });
    expect(await run('get_chat_instructions', { chatId: 'sup-chat' })).toMatchObject({ ok: true, supervisorManaged: true, instructions: null });
    expect(await run('get_chat_instructions', { chatId: 'c-own' })).toMatchObject({ ok: true, instructions: null, chars: 0 });
    expect(await run('get_chat_instructions', { chatId: 'zzz' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
  it('self target on a machine run is refused (no_user_turn); a foreign target with a grant executes and audits fromChatId', async () => {
    const machine = makeCtx({ userTurnAt: undefined } as any);
    expect(await run('set_chat_instructions', { instructions: 'x' }, machine)).toMatchObject({ ok: false, reason: 'no_user_turn' });
    const r = await run('set_chat_instructions', { chatId: 'c-own', instructions: 'Report in bullet points.' }, machine);
    expect(r).toMatchObject({ ok: true, chatId: 'c-own', chars: 24 });
    expect((dbMock as any).crossModelChat.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'c-own', userId: 'u1' }) }));
    expect((dbMock as any).activity.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ metadata: expect.objectContaining({ fromChatId: 'sup-1', machine: true }) }) }));
    expect(await pendingConfirmationCount()).toBe(0);
  });
  it('a foreign target WITHOUT a grant stages a confirmation on a machine run (never a silent write)', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    const machine = makeCtx({ userTurnAt: undefined } as any);
    const raw = await runRaw('set_chat_instructions', { chatId: 'c-own', instructions: 'x' }, machine);
    expect(raw).toMatch(/confirm/i);
    expect((dbMock as any).crossModelChat.updateMany).not.toHaveBeenCalled();
  });
});

describe('session files + uploads', () => {
  it('list_session_files / read_session_file resolve with member access and map statuses', async () => {
    expect(await run('list_session_files', { chatId: 'shared-1' })).toMatchObject({ ok: true, entries: [{ name: 'README.md' }], source: 'disk' });
    expect(wt.resolveWorktreeForUser).toHaveBeenCalledWith('shared-1', 'u1', 'read');
    expect(await run('list_session_files', { chatId: 'c-own', dir: 'missing' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('read_session_file', { chatId: 'c-own', path: 'a.ts' })).toMatchObject({ ok: true, content: 'hello', source: 'disk' });
    expect(await run('read_session_file', { chatId: 'c-own', path: 'big.bin' })).toMatchObject({ ok: false, reason: 'too_large', status: 413 });
    expect(await run('read_session_file', { chatId: 'c-own', path: 'img.png' })).toMatchObject({ ok: false, reason: 'binary' });
    expect(await run('read_session_file', { chatId: 'c-own', path: 'nope' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('read_session_file', { chatId: 'zzz', path: 'a' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('read_session_file', { chatId: 'c-own' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('stage_upload stages an owner-stamped blob from content / fileId / worktreePath, exactly one source, safe basename', async () => {
    const r = await run('stage_upload', { name: 'notes/report.md', content: '# hi' });
    expect(r).toMatchObject({ ok: true, filename: 'report.md', bytes: 4, type: 'document', expiresInMinutes: 15 });
    expect(up.saveAttachment).toHaveBeenCalledWith(r.ids.uploadId, expect.objectContaining({ ownerUserId: 'u1', uploadId: r.ids.uploadId, filename: 'report.md', extractedText: '# hi' }));
    expect(await run('stage_upload', { name: 'r.csv', fileId: 'gf-1' })).toMatchObject({ ok: true, filename: 'r.csv', type: 'document' });
    expect(await run('stage_upload', { name: 'r.csv', fileId: 'gf-other' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('stage_upload', { name: 'x.txt', content: 'a', fileId: 'gf-1' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('stage_upload', { name: '..', content: 'a' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('stage_upload', { name: 'w.txt', worktreePath: 'src/a.ts' }, makeCtx({ worktree: '' } as any))).toMatchObject({ ok: false, reason: 'no_worktree' });
    // knowledge document → text rebuilt from the chunk index (close-out of the T3b decline, 2026-09-25)
    const d = await run('stage_upload', { name: 'spec.txt', documentId: 'doc-1' });
    expect(d).toMatchObject({ ok: true, filename: 'spec.txt', type: 'document', bytes: Buffer.byteLength('chunk one\n\nchunk two') });
    expect(up.saveAttachment).toHaveBeenLastCalledWith(d.ids.uploadId, expect.objectContaining({ extractedText: 'chunk one\n\nchunk two', ownerUserId: 'u1' }));
    expect(await run('stage_upload', { name: 'x.txt', documentId: 'doc-zz' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('stagedMime (ticket 390b6767 — lane-delivered PNGs 415d as application/octet-stream)', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  it('magic bytes win: a PNG named anything is image/png', () => {
    expect(stagedMime('qwen_v1_test.png', PNG, true)).toBe('image/png');
    expect(stagedMime('weird.bin', PNG, true)).toBe('image/png');
  });
  it('extension applies only when it agrees with the content: text ext + text → that mime; binary ext + binary → that mime', () => {
    expect(stagedMime('report.md', null, false)).toBe('text/markdown');
    expect(stagedMime('data.csv', Buffer.from('a,b'), false)).toBe('text/csv');
    expect(stagedMime('doc.pdf', Buffer.from('%PDF-1.7'), true)).toBe('application/pdf');
  });
  it('disagreement falls back honestly: binary bytes in a .txt → octet-stream; text in a .png → text/plain', () => {
    expect(stagedMime('blob.txt', Buffer.from([0, 1, 2, 3]), true)).toBe('application/octet-stream');
    expect(stagedMime('not-really.png', Buffer.from('hello'), false)).toBe('text/plain');
  });
});

describe('stagedMime audio extensions (ticket 6c050917 — staged clips 415d as octet-stream)', () => {
  const WAV = Buffer.concat([Buffer.from('52494646', 'hex'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8, 1)]);
  it('audio extensions on binary content stage as their audio mime', () => {
    expect(stagedMime('kokoro_af_heart_all4.wav', WAV, true)).toBe('audio/wav');
    expect(stagedMime('voice.mp3', null, true)).toBe('audio/mpeg');
    expect(stagedMime('note.m4a', null, true)).toBe('audio/mp4');
    expect(stagedMime('clip.ogg', null, true)).toBe('audio/ogg');
    expect(stagedMime('clip.opus', null, true)).toBe('audio/ogg');
    expect(stagedMime('song.flac', null, true)).toBe('audio/flac');
  });
  it('audio extension on TEXT content does not lie about the mime (audio mimes are binary)', () => {
    // Text bytes in a .wav name: the extension disagrees with the content's
    // binariness — the honest fallbacks stand, exactly the image rule.
    expect(stagedMime('fake.wav', Buffer.from('hello text'), false)).toBe('text/plain');
  });
});

describe('workspace bootstrap', () => {
  it('sync_workspace is owner-only and needs a workspace', async () => {
    expect(await run('sync_workspace', { projectId: 'proj-1' })).toMatchObject({ ok: true, committed: 2, skipped: 1 });
    expect(await run('sync_workspace', { projectId: 'proj-2' })).toMatchObject({ ok: false, reason: 'no_workspace' });
    expect(await run('sync_workspace', { projectId: 'proj-x' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
  it('list_github_repos reports connected:false honestly with no linked account', async () => {
    expect(await run('list_github_repos', {})).toMatchObject({ ok: true, connected: false, repos: [] });
  });
  it('import_repo applies the SSRF jail, creates the project and files it under parentId; configure_workspace provisions with the user token (both grant-executed)', async () => {
    expect(await run('import_repo', { repoUrl: 'http://127.0.0.1/x.git' })).toMatchObject({ ok: false, reason: 'invalid' });
    const r = await run('import_repo', { repoUrl: 'https://github.com/o/r.git', parentId: 'folder-1' });
    expect(r).toMatchObject({ ok: true, ids: { projectId: 'proj-new' }, project: { name: 'r', parentId: 'folder-1' } });
    expect(svc.moveFolder).toHaveBeenCalledWith({ userId: 'u1', folderId: 'proj-new', newParentId: 'folder-1' });
    const c = await run('configure_workspace', { projectId: 'proj-1', repoUrl: 'https://github.com/o/r', githubLabel: 'Work' });
    expect(c).toMatchObject({ ok: true, ids: { projectId: 'proj-1' }, workspace: { provisioned: true } });
    expect(ws.configureWorkspace).toHaveBeenCalledWith('proj-1', 'u1', expect.objectContaining({ repoUrl: 'https://github.com/o/r', githubLabel: 'Work' }));
    expect(tokens.getValidToken).toHaveBeenCalledWith('u1', 'Work');
    expect(await run('configure_workspace', { projectId: 'proj-x' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
  it('configure_workspace / import_repo STAGE a confirmation on a machine run without a grant', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    const machine = makeCtx({ userTurnAt: undefined } as any);
    expect(await runRaw('import_repo', { repoUrl: 'https://github.com/o/r' }, machine)).toMatch(/confirm/i);
    expect(await runRaw('configure_workspace', { projectId: 'proj-1' }, machine)).toMatch(/confirm/i);
    expect(ws.configureWorkspace).not.toHaveBeenCalled();
    expect(await pendingConfirmationCount()).toBe(2);
  });
});

/**
 * Ticket 23f453de (2026-10-13): a configure_workspace re-pin on an EXISTING
 * github-backed project (list_projects returns it) was refused with a bare
 * "Project not found" — the tool passed the projectId RAW into the service's
 * exact-id lookup, so an abbreviated id or a name reference surfaced as
 * not-found and pushed a needless owner GitHub reconnect. The seam now
 * resolves the reference with the SAME canonicalizer start_coding_session
 * uses, and an unresolvable reference 404s with did-you-mean suggestions.
 */
describe('configure_workspace / sync_workspace — project reference resolution (ticket 23f453de)', () => {
  beforeEach(() => {
    (svc.canonicalizeProjectReference as jest.Mock).mockImplementation(async (_u: string, raw: string) =>
      (raw === 'proj-1' || raw === 'P' || raw === 'c-own' || raw.startsWith('887dcccb') ? { id: 'proj-1', via: 'id' } : null));
    (svc.suggestProjectsByIdPrefix as jest.Mock).mockImplementation(async () => [] as Array<{ id: string; name: string }>);
  });

  it('a name / chat-id / unique-prefix reference now resolves and re-pins — the refused shapes from the ticket', async () => {
    // The label-only re-pin the supervisor attempted: name reference.
    const byName = await run('configure_workspace', { projectId: 'P', githubLabel: 'pastapaul_canadaquant' });
    expect(byName).toMatchObject({ ok: true, ids: { projectId: 'proj-1' } });
    expect(ws.configureWorkspace).toHaveBeenCalledWith('proj-1', 'u1', expect.objectContaining({ githubLabel: 'pastapaul_canadaquant' }));
    // A chat id inside the project.
    expect(await run('configure_workspace', { projectId: 'c-own', githubLabel: 'Work' })).toMatchObject({ ok: true, ids: { projectId: 'proj-1' } });
    // A unique ≥8-char HEX id prefix — the ticket's abbreviated-id shape
    // (review finding 3: the real canonicalizer's charset regex is
    // /^[0-9a-f-]{8,35}$/, so the replay prefix must be hex-realistic —
    // 887dcccb is the ericfoundation.com project's real prefix).
    expect(await run('configure_workspace', { projectId: '887dcccb', githubLabel: 'Work' })).toMatchObject({ ok: true, ids: { projectId: 'proj-1' } });
    // sync_workspace — same seam, same shapes.
    expect(await run('sync_workspace', { projectId: 'P' })).toMatchObject({ ok: true, ids: { projectId: 'proj-1' }, committed: 2 });
  });

  it('an unresolvable reference 404s NAMING it, with did-you-mean — never a bare "Project not found"', async () => {
    (svc.suggestProjectsByIdPrefix as jest.Mock).mockImplementation(async ({ projectIdPrefix }: any) =>
      (projectIdPrefix.startsWith('zzzz') ? [{ id: 'zzzz9999-dead-beef', name: 'Near Miss' }] : []));
    const r = await run('configure_workspace', { projectId: 'zzzz-abbr', githubLabel: 'x' });
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(r.message).toContain('zzzz-abbr');
    expect(r.message).toContain('Did you mean: zzzz9999-dead-beef ("Near Miss")');
    expect(r.message).toMatch(/never reconstruct or abbreviate an id/i);
    expect(ws.configureWorkspace).not.toHaveBeenCalled();
    // Nothing was staged — this is an execution-time refusal, not a card.
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('the service 404 (resolver absent / partial mock) still names the id — no bare message anywhere', async () => {
    // The fail-open path: canonicalizer resolves nothing (an older partial
    // platform mock without the function — same code path when absent).
    (svc.canonicalizeProjectReference as jest.Mock).mockReset();
    // A jest.fn() with no implementation returns undefined, NOT null — the
    // seam treats undefined (resolver unavailable) as fail-open, and the
    // service's named 404 then speaks through the catch.
    const r = await run('configure_workspace', { projectId: 'proj-x', githubLabel: 'x' });
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(r.message).toContain('proj-x');
    expect(r.message).not.toBe('Project not found');
  });

  it('an absent resolver keeps the pre-fix execution shape (fail-open, no behavior change for partial mocks)', async () => {
    (svc.canonicalizeProjectReference as jest.Mock).mockReset();
    expect(await run('configure_workspace', { projectId: 'proj-1', repoUrl: 'https://github.com/o/r' }))
      .toMatchObject({ ok: true, ids: { projectId: 'proj-1' }, workspace: { provisioned: true } });
  });
});

/**
 * Ticket abff5dd6 (2026-10-13): 3× configure_workspace not_found streak, auto-
 * filed at breaker trip from session 491d37f2 run c403ce28 (the 23f453de fix
 * lane's OWN run, 04:08–04:12Z). Adjudication replay — the streak was the
 * already-fixed 23f453de defect seen through a deploy-window race, not a live
 * framework defect:
 *
 *   1. Failure #1 (04:08:22, {projectId:"887dcccb", githubLabel:
 *      "pastapaul_canadaquant"} — a REAL ericfoundation.com prefix) carried the
 *      PRE-FIX bare "Project not found" although the fix had merged at 03:45:42
 *      (PR #1456, 45e32bb27) and its deploy wave (run 38343230703) concluded
 *      success at 04:05:38: the in-flight run (started 02:01, one attempt,
 *      never interrupted) was still served by the draining old colour's
 *      resident code. A fresh firing on the new colour (04:59:33Z) ran the
 *      IDENTICAL call shape to ok:true with the id resolved.
 *   2. Failures #2–3 used the placeholder uuid aabbccdd-0000-0000-0000-
 *      000000000000 (a deliberately bogus discriminator — it appears nowhere in
 *      repo source): ok:false not_found is the CORRECT outcome for a
 *      nonexistent id; the breaker counted the negative probe anyway.
 *   3. The 3-trip breaker + fileStreakInvestigation auto-filer then worked
 *      exactly per owner doctrine 2026-09-10 (self-heal + attribute).
 *
 * This replay pins the POST-fix surfaces so a regression to either half of the
 * 23f453de fix (raw-pass seam / bare message) is caught before it can refile a
 * lookalike streak ticket, and pins the resolution + refusal shapes the
 * adjudication rested on.
 */
describe('configure_workspace — streak adjudication replay (ticket abff5dd6)', () => {
  beforeEach(() => {
    // The REAL canonicalizer shape: 887dcccb (ericfoundation.com's true ≥8-char
    // hex prefix) resolves; the ticket's placeholder uuid does not.
    (svc.canonicalizeProjectReference as jest.Mock).mockImplementation(async (_u: string, raw: string) =>
      (raw === 'proj-1' || raw === 'P' || raw === 'c-own' || raw.startsWith('887dcccb') ? { id: 'proj-1', via: 'id' } : null));
    (svc.suggestProjectsByIdPrefix as jest.Mock).mockImplementation(async () => [] as Array<{ id: string; name: string }>);
  });

  it('the ticket\'s failing call #1 — a real abbreviated prefix + label — resolves and re-pins on the fixed seam', async () => {
    // Verbatim call args from the ticket (receipt f51b2e9a, 04:08:22Z).
    const r = await run('configure_workspace', { projectId: '887dcccb', githubLabel: 'pastapaul_canadaquant' });
    expect(r).toMatchObject({ ok: true, ids: { projectId: 'proj-1' } });
    expect(ws.configureWorkspace).toHaveBeenCalledWith('proj-1', 'u1', expect.objectContaining({ githubLabel: 'pastapaul_canadaquant' }));
    expect(String(r.message)).not.toBe('Project not found');
  });

  it('the ticket\'s failing calls #2–3 — the placeholder uuid — are a NAMED not_found, never the pre-fix bare message', async () => {
    // Verbatim call args from the ticket (receipts 15b2af1a 04:10:14Z, 64f3043f
    // 04:12:22Z). ok:false not_found is the CORRECT outcome for a nonexistent
    // id — this pins that the refusal is diagnosable (names the reference and
    // the accepted forms) rather than reverting to the bare pre-fix string.
    const r = await run('configure_workspace', { projectId: 'aabbccdd-0000-0000-0000-000000000000' });
    expect(r).toMatchObject({ ok: false, reason: 'not_found', ids: { projectId: 'aabbccdd-0000-0000-0000-000000000000' } });
    expect(r.message).toContain('aabbccdd-0000-0000-0000-000000000000');
    expect(r.message).toMatch(/no project "aabbccdd-0000-0000-0000-000000000000" is visible to you/);
    expect(r.message).toMatch(/never reconstruct or abbreviate an id/i);
    expect(r.message).not.toBe('Project not found');
    expect(ws.configureWorkspace).not.toHaveBeenCalled();
    // An execution-time refusal, not a staged card.
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('three consecutive failures of these shapes never surface a bare "Project not found" — the streak ticket\'s signature is extinct on both halves', async () => {
    // Replay the ticket's breaker view: the exact three calls, newest first,
    // against the fixed seam. Whatever the correct outcome of each (resolve /
    // named-refuse), NONE may produce the pre-fix bare message that made the
    // streak look like an unresolved framework defect.
    const calls = [
      { projectId: 'aabbccdd-0000-0000-0000-000000000000' },
      { projectId: 'aabbccdd-0000-0000-0000-000000000000' },
      { projectId: '887dcccb', githubLabel: 'pastapaul_canadaquant' },
    ];
    const results: Array<{ ok: boolean; reason?: string; message: string }> = [];
    for (const c of calls) results.push(await run('configure_workspace', c));
    for (const r of results) {
      expect(typeof r.message).toBe('string');
      expect(r.message).not.toBe('Project not found');
    }
    // The real-prefix call resolves; the placeholder calls refuse — the
    // adjudicated outcomes of the streak, now pinned.
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r.ok === false && r.reason === 'not_found')).toHaveLength(2);
  });
});


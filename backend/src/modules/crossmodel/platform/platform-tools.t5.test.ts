/**
 * Capability gap audit tranche 5 (2026-09-24) — reuses the T4 scaffold — platform/housekeeping-tools.ts + platform/fleet-ops-tools.ts:
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
  configureWorkspace: jest.fn(async (projectId: string) => (projectId === 'proj-1' ? { provider: 'github' } : (() => { throw Object.assign(new Error('Project not found'), { status: 404 }); })())),
  ensureProvisioned: jest.fn(async (_p: string, getToken: () => Promise<string | null>) => { await getToken(); return '/mirror'; }),
  getWorkspace: jest.fn(async () => ({ provider: 'github', repoUrl: 'https://github.com/o/r', defaultBranch: 'main', provisioned: true })),
  syncKnowledgeToRepo: jest.fn(async () => ({ committed: 2, skipped: 1 })),
};
jest.mock('../coding/project-workspace.service', () => ({ __esModule: true, ...ws }));
const tokens = { getValidToken: jest.fn(async () => 'ghp_x'), getAllValidTokens: jest.fn(async (): Promise<any[]> => []) };
jest.mock('../github/token-manager', () => ({ __esModule: true, ...tokens }));
const projects: Record<string, any> = { 'proj-1': { id: 'proj-1', name: 'P', repoProvider: 'github' }, 'proj-2': { id: 'proj-2', name: 'Q', repoProvider: null } };
(dbMock as any).crossModelProject = { findFirst: jest.fn(async ({ where }: any) => (projects[where.id] && (!where.userId || where.userId === 'u1') ? projects[where.id] : null)) };
(dbMock as any).generatedFile = { findFirst: jest.fn(async ({ where }: any) => (where.id === 'gf-1' && where.userId === 'u1' ? { id: 'gf-1', filename: 'r.csv', mimeType: 'text/csv', size: 5, data: Buffer.from('a,b\n1').toString('base64'), textContent: 'a,b\n1' } : null)) };
(dbMock as any).crossModelProject.create = jest.fn(async ({ data }: any) => ({ id: 'proj-new', ...data }));
(dbMock as any).activity = { create: jest.fn(async () => ({})) };
chats['shared-1'] = { id: 'shared-1', userId: 'u2', codingState: { id: 'cs3' }, systemPrompt: 'Always cite sources.', isSupervisor: false, isProjectSupervisor: false };
chats['c-own'].systemPrompt = null;
chats['sup-chat'] = { id: 'sup-chat', userId: 'u1', isSupervisor: true, systemPrompt: 'managed' };
cmSvc.getChatAccess.mockImplementation(async (id: string) => (id === 'c-own' || id === 'p-own' ? { access: 'owner', exists: true } : id === 'shared-1' || id === 'sup-chat' ? { access: 'read', exists: true } : { access: 'none', exists: false }));
(dbMock as any).crossModelChat.updateMany = jest.fn(async ({ where }: any) => ({ count: chats[where.id] && chats[where.id].userId === where.userId && !chats[where.id].isSupervisor ? 1 : 0 }));
jest.mock('../coding/coding-data.service', () => ({ __esModule: true, ...codingData, createCodingProject: jest.fn(async (d: any) => ({ id: 'proj-new', name: d.name, repoUrl: d.repoUrl })) }));


// ── T4 boundaries ───────────────────────────────────────────────────────────
const ingest = { extractTextFromBuffer: jest.fn(async (b: Buffer) => b.toString('utf8')), processDocument: jest.fn(async () => {}) };
jest.mock('../ingestion.service', () => ({ __esModule: true, ...ingest }));
jest.mock('../documents.controller', () => ({ __esModule: true, describeImageForKnowledgeBase: jest.fn(async () => 'an image of a cat') }));
const upCtl = { saveAttachment: jest.fn(async () => {}), loadAttachment: jest.fn(async (id: string) => (id === 'up-1' ? { type: 'document', filename: 'notes.txt', mimeType: 'text/plain', base64: Buffer.from('hello world notes').toString('base64'), extractedText: 'hello world notes', ownerUserId: 'u1' } : id === 'up-foreign' ? { type: 'document', filename: 'x', base64: 'eA==', ownerUserId: 'u2' } : null)) };
jest.mock('../upload.controller', () => ({ __esModule: true, ...upCtl }));
const redisMock = { incr: jest.fn(async () => 1), decr: jest.fn(async () => 0), expire: jest.fn(async () => 1), get: jest.fn(), set: jest.fn() };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: redisMock }));
const instSvc = { listInstances: jest.fn(async () => [{ id: 'inst-1', name: 'edge-a', status: 'active', online: true, lastSeenAt: 'x', protocolVersion: 1 }]) };
jest.mock('../instances/instances.service', () => ({ __esModule: true, ...instSvc }));
const fleetSvc = {
  ackDigestItem: jest.fn(async (_u: string, i: any) => ({ success: true, key: i.key, snoozeUntil: i.snoozeHours ? '2026-09-25T00:00:00.000Z' : null })),
  unackDigestItem: jest.fn(async () => ({ success: true })),
  getFleetOverview: jest.fn(async () => ({ counts: { chats: 3 }, projects: [], sessions: [], schedules: [], hooks: [] })),
  getFleetPulse: jest.fn(async () => ({ generatedAt: 'x', shipping: null, queue: null, guard: { catches24h: 0 } })),
  getFleetLog: jest.fn(async () => ({ messages: [], hasMore: false })),
  getProjectDigests: jest.fn(async () => ({ digests: [] })),
};
jest.mock('../fleet/fleet.service', () => ({ __esModule: true, ...fleetSvc }));
const sessionDiff = { sessionDiffForUser: jest.fn(async (id: string) => (id === 'c-own' ? { branch: 'digby/x', status: ' M a.ts\n?? b.ts\n', diffStat: ' a.ts | 2 +-\n', source: 'disk' } : id === 'shared-1' ? { branch: 'main', status: '', diffStat: '', source: 'unavailable' } : null)) };
jest.mock('../coding/session-diff', () => ({ __esModule: true, ...sessionDiff }));
const webhookSvc = { getWebhook: jest.fn(async (chatId: string) => (chatId === 'c-own' ? { chatId, isActive: true, label: 'ci', tokenPrefix: 'dgw_ab12cd34', lastUsedAt: null, createdAt: 'x' } : null)), revokeWebhook: jest.fn(async (chatId: string) => chatId === 'c-own') };
jest.mock('../webhook.service', () => ({ __esModule: true, ...webhookSvc }));
const infra = { runInfraAction: jest.fn(async (r: any) => ({ ok: true, kind: r.kind, dryRun: true, executed: false })) };
jest.mock('../fleet/infra-actions.service', () => ({ __esModule: true, ...infra }));
jest.mock('../model-endpoints/model-endpoints.service', () => ({ __esModule: true, resolveRegistryModel: jest.fn(async (spec: string) => (spec === 'lab:qwen' ? { coding: true } : null)) }));

const projRows: Record<string, any> = { 'proj-1': { id: 'proj-1', name: 'P' } };
(dbMock as any).crossModelProject = { findFirst: jest.fn(async ({ where }: any) => (projRows[where.id] && (!where.userId || where.userId === 'u1') ? projRows[where.id] : null)) };
(dbMock as any).projectDocument = {
  findUnique: jest.fn(async ({ where }: any) => (where.id === 'doc-1' ? { id: 'doc-1', userId: 'u1', projectId: 'proj-1', name: 'old.pdf' } : where.id === 'doc-other' ? { id: 'doc-other', userId: 'u2', projectId: 'proj-1', name: 'x' } : null)),
  delete: jest.fn(async () => ({})),
  count: jest.fn(async () => 3),
  create: jest.fn(async ({ data }: any) => ({ id: 'doc-new', ...data })),
};
(dbMock as any).generatedFile = { findFirst: jest.fn(async ({ where }: any) => (where.id === 'gf-1' && where.userId === 'u1' ? { filename: 'report.csv', mimeType: 'text/csv', size: 9, data: Buffer.from('a,b\n1,2\n').toString('base64'), textContent: null } : null)) };
(dbMock as any).canvasDocument = {
  create: jest.fn(async ({ data }: any) => ({ id: 'cv-new', title: data.title, type: data.type, version: 1 })),
  findFirst: jest.fn(async ({ where }: any) => (where.id === 'cv-1' && where.userId === 'u1' ? { id: 'cv-1', title: 'Plan' } : null)),
  delete: jest.fn(async () => ({})),
};
(dbMock as any).canvasShareLink = { upsert: jest.fn(async () => ({ shareToken: 'a'.repeat(40) })), updateMany: jest.fn(async () => ({ count: 1 })) };
(dbMock as any).userPreferences = { findUnique: jest.fn(async () => ({ modelSet: 'open_source', codingModel: 'glm-5.2', codingPermissionMode: 'plan', devContainerEnabled: false })), upsert: jest.fn(async ({ update }: any) => ({ codingModel: update.codingModel ?? 'glm-5.3', codingPermissionMode: update.codingPermissionMode ?? 'plan', devContainerEnabled: update.devContainerEnabled ?? false })) };
(dbMock as any).activity = { create: jest.fn(async () => ({})) };
(dbMock as any).crossModelChat.findFirst = jest.fn(async ({ where }: any) => (chats[where.id] && chats[where.id].userId === where.userId ? chats[where.id] : null));
(dbMock as any).crossModelChat.findMany = jest.fn(async ({ where }: any) => Object.values(chats).filter((c: any) => c.userId === where.userId && c.id.startsWith(where.id.startsWith)).map((c: any) => ({ id: c.id, title: c.title ?? null })));
(dbMock as any).codingSchedule.findFirst = jest.fn(async () => null);
(dbMock as any).codingSchedule.findMany = jest.fn(async () => []);
(dbMock as any).projectGoal = { findMany: jest.fn(async () => []) };
(dbMock as any).projectTodo = { findMany: jest.fn(async () => []) };
(dbMock as any).eventHook = { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) };
(dbMock as any).userFeatureRequest = { findMany: jest.fn(async () => []) };
(dbMock as any).ownerQuestion.findFirst = jest.fn(async () => null);
(dbMock as any).connectedInstance = { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) };
chats['c-own2'] = { id: 'c-own2', userId: 'u1', title: 'Second' };
chats['sup-1'] = { id: 'sup-1', userId: 'u1', title: 'Supervisor lane' };
(svc as any).archiveProject = jest.fn(async ({ projectId, archived }: any) => (projectId === 'proj-1' ? { id: projectId, archived } : projectId === 'proj-busy' ? (() => { throw Object.assign(new Error('Cannot archive: 1 coding session(s) running'), { statusCode: 409 }); })() : (() => { throw Object.assign(new Error('Project not found or not owner'), { statusCode: 404 }); })()));
(svc as any).getProjectAccess = jest.fn(async (projectId: string) => (projectId === 'proj-1' ? { project: projRows['proj-1'], role: 'owner' } : projectId === 'proj-view' ? { project: { id: 'proj-view' }, role: 'viewer' } : null));


// ── T5 boundaries ───────────────────────────────────────────────────────────
const ctxSvc = { getUserMemory: jest.fn(async () => ({ name: 'Paul', likes: 'coffee' })), updateMemoryFact: jest.fn(async () => {}) };
jest.mock('../context.service', () => ({ __esModule: true, default: ctxSvc }));
jest.mock('../integrations/moonshot.integration', () => ({ __esModule: true, default: { consolidateMemory: jest.fn(async () => ({ Name: 'Paul C', likes: 'espresso' })) } }));
(cmSvc as any).listChats = jest.fn(async () => ({ chats: [{ title: 'A' }, { title: 'B' }] }));
const memGraph = { startUserMemoryRebuild: jest.fn(async () => ({ started: true, total: 12 })), getUserMemoryRebuildStatus: jest.fn(async () => ({ status: { startedAt: 'x', finishedAt: null, total: 12, processed: 4, factsBefore: 2, factsAfter: null }, running: true, facts: 2 })) };
jest.mock('../langgraph/memory.graph', () => ({ __esModule: true, ...memGraph }));
jest.mock('../chat-agent/chat-gate', () => ({ __esModule: true, chatReadAccessGranted: ({ access, exists }: any) => exists && access !== 'none' }));
jest.mock('../text-extract', () => ({ __esModule: true, extractPlainText: (b: Buffer) => b.toString('utf8'), extractPdfUploadText: async () => 'pdf text', extractDocxText: async () => 'docx', extractXlsxText: async () => 'a,b' }));
(dbMock as any).generatedFile.findFirst = jest.fn(async ({ where }: any) => (where.id === 'gf-1' && where.userId === 'u1' ? { id: 'gf-1', filename: 'r.csv', size: 9 } : null));
(dbMock as any).generatedFile.delete = jest.fn(async () => ({}));
const chatFiles: Record<string, any> = {
  'cf-1': { id: 'cf-1', chatId: 'c-own', userId: 'u1', filename: 'notes.txt', mimeType: 'text/plain; charset=utf-8', sizeBytes: 11, data: Buffer.from('hello notes'), createdAt: new Date() },
  'cf-2': { id: 'cf-2', chatId: 'shared-1', userId: 'u2', filename: 'pic.png', mimeType: 'image/png', sizeBytes: 3, data: Buffer.from('abc'), createdAt: new Date() },
};
(dbMock as any).chatFile = {
  findMany: jest.fn(async ({ where }: any) => Object.values(chatFiles).filter((f: any) => f.chatId === where.chatId)),
  findUnique: jest.fn(async ({ where }: any) => chatFiles[where.id] ?? null),
  delete: jest.fn(async () => ({})),
};
const projRows2: Record<string, any> = { 'proj-1': { id: 'proj-1', name: 'P', userId: 'u1', shareToken: null }, 'proj-other': { id: 'proj-other', name: 'Q', userId: 'u2', shareToken: null } };
(dbMock as any).crossModelProject.findUnique = jest.fn(async ({ where }: any) => projRows2[where.id] ?? null);
(dbMock as any).crossModelProject.update = jest.fn(async ({ where, data }: any) => ({ ...projRows2[where.id], ...data }));
(dbMock as any).projectMember = { findUnique: jest.fn(async () => null), upsert: jest.fn(async ({ create }: any) => create), deleteMany: jest.fn(async () => ({ count: 1 })) };
(dbMock as any).user = { findUnique: jest.fn(async ({ where }: any) => (where.email === 'ann@example.com' ? { id: 'u-ann' } : null)), findFirst: jest.fn(async () => null) };
(dbMock as any).userFeatureRequest = {
  findMany: jest.fn(async ({ where }: any) => (where.userId === 'u1' ? [{ id: 't-1', type: 'bug_report', title: 'Mine', status: 'open', priority: 1, source: 'user', createdAt: new Date(), updatedAt: new Date() }] : [])),
  findFirst: jest.fn(async ({ where }: any) => (where.id === 't-1' && where.userId === 'u1' ? { id: 't-1', title: 'Mine', status: 'open', adminNote: null } : null)),
  update: jest.fn(async ({ data }: any) => ({ id: 't-1', status: data.status })),
};
const telemetry = { fleetTelemetry: jest.fn(async (a: any) => ({ ok: true, view: a.view, repo: a.repo })), OWN_ACCOUNT_VIEWS: new Set(['collab', 'cards', 'overview', 'pulse', 'log', 'digests']), TELEMETRY_VIEWS: ['deploy'] };
jest.mock('../fleet/fleet-telemetry', () => ({ __esModule: true, ...telemetry }));

import { PLATFORM_TOOL_SCHEMA, PLATFORM_MUTATING_TOOLS, PLATFORM_READ_TOOLS, executePlatformTool } from './platform-tools';
import { MUTATING_TOOLS, ASK_ONLY_TOOLS, ToolContext } from '../coding/tools';
import { SELF_SERVICE_TOOL_NAMES } from './self-service-tools';
import { pendingConfirmationCount } from './pending-confirmations';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt/sup-1', sessionId: 'sup-1', userId: 'u1', permissionMode: 'auto', userTurnAt: new Date(), projectId: 'proj-1',
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
  fb.isAdminUser.mockResolvedValue(false);
  autonomySvc.getChatAutonomy.mockResolvedValue({ chatId: 'sup-1', allowedTools: [...ALL_CONTROL, 'share_project', 'add_project_member', 'remove_project_member'], source: 'manual' });
});

describe('T5 registration', () => {
  it('reads / mutations / ask-only; the three sharing tools are consequential + never autonomous', () => {
    const names = PLATFORM_TOOL_SCHEMA.map((t: any) => t.function.name);
    for (const t of SELF_SERVICE_TOOL_NAMES) expect(names).toContain(t);
    for (const t of ['memory_rebuild_status', 'list_chat_uploads', 'read_chat_upload']) { expect(PLATFORM_READ_TOOLS).toContain(t); expect(MUTATING_TOOLS.has(t)).toBe(false); }
    for (const t of ['consolidate_memory', 'rebuild_memory', 'share_project', 'add_project_member', 'remove_project_member', 'resolve_feedback', 'delete_document', 'delete_chat_upload']) { expect(PLATFORM_MUTATING_TOOLS).toContain(t); expect(MUTATING_TOOLS.has(t)).toBe(true); }
    for (const t of ['delete_document', 'delete_chat_upload']) expect(ASK_ONLY_TOOLS.has(t)).toBe(true);
  });
});

describe('memory jobs', () => {
  it('consolidate_memory + rebuild_memory need a live user turn; status is a plain read', async () => {
    const machine = makeCtx({ userTurnAt: undefined } as any);
    expect(await run('consolidate_memory', {}, machine)).toMatchObject({ ok: false, reason: 'no_user_turn' });
    expect(await run('rebuild_memory', {}, machine)).toMatchObject({ ok: false, reason: 'no_user_turn' });
    expect(await run('consolidate_memory', {})).toMatchObject({ ok: true, consolidated: 2 });
    expect(ctxSvc.updateMemoryFact).toHaveBeenCalledWith('u1', 'name', 'Paul C');
    expect(await run('rebuild_memory', {})).toMatchObject({ ok: true, started: true, total: 12 });
    memGraph.startUserMemoryRebuild.mockResolvedValueOnce({ started: false, reason: 'already_running', total: 0 } as any);
    expect(await run('rebuild_memory', {})).toMatchObject({ ok: false, reason: 'already_running' });
    expect(await run('memory_rebuild_status', {}, machine)).toMatchObject({ ok: true, running: true, facts: 2 });
  });
});

describe('files', () => {
  it('delete_document is owner-only; chat uploads list/read/delete respect chat access and the uploader rule', async () => {
    expect(await run('delete_document', { fileId: 'gf-1' })).toMatchObject({ ok: true, ids: { fileId: 'gf-1' } });
    expect(await run('delete_document', { fileId: 'gf-x' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('list_chat_uploads', { chatId: 'c-own' })).toMatchObject({ ok: true, count: 1, files: [{ chatFileId: 'cf-1', mine: true }] });
    expect(await run('list_chat_uploads', { chatId: 'zzz' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('read_chat_upload', { chatFileId: 'cf-1', offset: 6, limit: 3 })).toMatchObject({ ok: true, text: 'not', totalChars: 11, truncated: true });
    expect(await run('read_chat_upload', { chatFileId: 'cf-2' })).toMatchObject({ ok: false, reason: 'no_text' });
    expect(await run('read_chat_upload', { chatFileId: 'cf-1', limit: 0 })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('delete_chat_upload', { chatFileId: 'cf-2' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('delete_chat_upload', { chatFileId: 'cf-1' })).toMatchObject({ ok: true });
  });
});

describe('project sharing + membership (never autonomous)', () => {
  it('share_project stages a card even with a grant in auto mode, executes on the confirmed re-call; owner-only', async () => {
    const reg = await run('share_project', { projectId: 'proj-1', enable: true });
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect(await pendingConfirmationCount()).toBe(1);
    const done = await run('share_project', { confirmationId: reg.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000) } as any));
    expect(done).toMatchObject({ ok: true, shared: true });
    expect(done.shareUrl).toMatch(/\/shared\/project\/[0-9a-f]{40}$/);
    const reg2 = await run('share_project', { projectId: 'proj-other', enable: true });
    const done2 = await run('share_project', { confirmationId: reg2.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000) } as any));
    expect(done2).toMatchObject({ ok: false, reason: 'not_found' });
  });
  it('add_project_member resolves the invitee by email and upserts the role; remove_project_member honours owner/self rules', async () => {
    const reg = await run('add_project_member', { projectId: 'proj-1', email: 'Ann@Example.com', role: 'editor' });
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    const done = await run('add_project_member', { confirmationId: reg.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000) } as any));
    expect(done).toMatchObject({ ok: true, ids: { memberUserId: 'u-ann' }, role: 'editor' });
    const regNo = await run('add_project_member', { projectId: 'proj-1', email: 'nobody@example.com' });
    expect(await run('add_project_member', { confirmationId: regNo.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000) } as any))).toMatchObject({ ok: false, reason: 'no_such_user' });
    const regRm = await run('remove_project_member', { projectId: 'proj-other', userId: 'u-x' });
    expect(await run('remove_project_member', { confirmationId: regRm.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000) } as any))).toMatchObject({ ok: false, reason: 'forbidden' });
  });
});

describe('tickets + deploy view', () => {
  it('list_feedback shows a non-admin their OWN tickets; resolve_feedback self-closes; deploy+repo opens to any signed-in caller', async () => {
    const own = await run('list_feedback', {});
    expect(own).toMatchObject({ scope: 'own', count: 1, tickets: [{ id: 't-1' }] });
    expect(await run('resolve_feedback', { id: 't-1' })).toMatchObject({ ok: true, status: 'done' });
    expect(await run('resolve_feedback', { id: 't-9' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await runRaw('get_fleet_telemetry', { view: 'deploy' })).toMatch(/restricted to admin users/);
    expect(await run('get_fleet_telemetry', { view: 'deploy', repo: 'canada-quant/example-repo' })).toMatchObject({ ok: true, view: 'deploy', repo: 'canada-quant/example-repo' });
    expect(telemetry.fleetTelemetry).toHaveBeenCalledWith(expect.objectContaining({ repo: 'canada-quant/example-repo' }), expect.objectContaining({ userId: 'u1', role: 'USER' }));
    expect(await runRaw('get_fleet_telemetry', { view: 'boxes', repo: 'canada-quant/example-repo' })).toMatch(/restricted to admin users/);
  });
});

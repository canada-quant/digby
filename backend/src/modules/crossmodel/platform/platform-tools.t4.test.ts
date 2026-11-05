/**
 * Capability gap audit tranche 4a/4b (2026-09-24) — reuses the T3b scaffold — platform/housekeeping-tools.ts + platform/fleet-ops-tools.ts:
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
  chatSchedule: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'sch-1' ? { id: 'sch-1', sessionId: 'c-own', userId: 'u1' } : null)) },
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
const webhookSvc = { getWebhook: jest.fn(async (chatId: string) => (chatId === 'c-own' ? { chatId, isActive: true, label: 'ci', tokenPrefix: 'dgw_ab12cd34', lastUsedAt: null, createdAt: 'x' } : null)), revokeWebhook: jest.fn(async (chatId: string) => chatId === 'c-own'), createOrRotateWebhook: jest.fn(async ({ chatId, label }: any) => ({ record: { chatId, tokenPrefix: 'dgw_new12345', label: label ?? null, isActive: true }, plaintextToken: 'dgw_new12345' + 'f'.repeat(40) })) };
jest.mock('../webhook.service', () => ({ __esModule: true, ...webhookSvc }));
// Ticket 2eef354e (delegated webhook delivery): the vault the minted token is
// stored under — mocked at the boundary like the webhook service above.
const credsSvc = {
  ENV_KEY_RE: /^[A-Z][A-Z0-9_]{1,63}$/,
  DENIED_ENV_KEYS: new Set(['PATH', 'HOME', 'GITHUB_TOKEN']),
  normalizeLabel: jest.fn((raw: string) => String(raw || '').trim().toUpperCase()),
  upsertCredential: jest.fn(async (userId: string, _provider: string, envKey: string, value: string) => ({ id: 'cred-1', envKey, injectedKey: envKey, preview: '••••2345', readable: true })),
};
jest.mock('../coding/credentials.service', () => ({ __esModule: true, ...credsSvc }));
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
(dbMock as any).chatSchedule.findFirst = jest.fn(async () => null);
(dbMock as any).chatSchedule.findMany = jest.fn(async () => []);
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

import { PLATFORM_TOOL_SCHEMA, PLATFORM_MUTATING_TOOLS, PLATFORM_READ_TOOLS, executePlatformTool } from './platform-tools';
import { MUTATING_TOOLS, ASK_ONLY_TOOLS, ToolContext } from '../coding/tools';
import { HOUSEKEEPING_TOOL_NAMES } from './housekeeping-tools';
import { FLEET_OPS_TOOL_NAMES } from './fleet-ops-tools';
import { TELEMETRY_VIEWS, OWN_ACCOUNT_VIEWS } from '../fleet/fleet-telemetry';
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
  autonomySvc.getChatAutonomy.mockResolvedValue({ chatId: 'sup-1', allowedTools: [...ALL_CONTROL, 'share_canvas'], source: 'manual' });
});

describe('T4 registration', () => {
  it('reads/mutations/ask-only sets; share_canvas consequential; telemetry gained the four own-account views', () => {
    const names = PLATFORM_TOOL_SCHEMA.map((t: any) => t.function.name);
    for (const t of [...HOUSEKEEPING_TOOL_NAMES, ...FLEET_OPS_TOOL_NAMES]) expect(names).toContain(t);
    for (const t of ['get_preferences', 'list_instances', 'get_session_diff', 'resolve_id', 'get_chat_webhook']) { expect(PLATFORM_READ_TOOLS).toContain(t); expect(MUTATING_TOOLS.has(t)).toBe(false); }
    for (const t of ['add_knowledge_file', 'create_canvas', 'share_canvas', 'revoke_canvas_share', 'archive_project', 'set_preferences', 'ack_digest_item', 'unack_digest_item', 'revoke_chat_webhook', 'remove_knowledge_document', 'delete_canvas']) { expect(PLATFORM_MUTATING_TOOLS).toContain(t); expect(MUTATING_TOOLS.has(t)).toBe(true); }
    for (const t of ['remove_knowledge_document', 'delete_canvas']) expect(ASK_ONLY_TOOLS.has(t)).toBe(true);
    for (const v of ['overview', 'pulse', 'log', 'digests']) { expect(TELEMETRY_VIEWS).toContain(v); expect(OWN_ACCOUNT_VIEWS.has(v)).toBe(true); }
  });
});

describe('feeds (RETIRED, ticket 43c24152)', () => {
  it('set_feed / refresh_feed / delete_feed are gone from the mutating + ask-only registries', () => {
    for (const t of ['set_feed', 'refresh_feed', 'delete_feed']) {
      expect(PLATFORM_MUTATING_TOOLS).not.toContain(t);
      expect(MUTATING_TOOLS.has(t)).toBe(false);
    }
    expect(ASK_ONLY_TOOLS.has('delete_feed')).toBe(false);
  });
});

describe('knowledge base', () => {
  it('remove_knowledge_document is uploader-only and cascades via delete', async () => {
    expect(await run('remove_knowledge_document', { documentId: 'doc-1' })).toMatchObject({ ok: true, ids: { documentId: 'doc-1', projectId: 'proj-1' } });
    expect((dbMock as any).projectDocument.delete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
    expect(await run('remove_knowledge_document', { documentId: 'doc-other' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
  it('add_knowledge_file ingests a generated file or a staged upload under the knowledge caps; viewers and foreign uploads refused', async () => {
    const r = await run('add_knowledge_file', { fileId: 'gf-1' });
    expect(r).toMatchObject({ ok: true, ids: { documentId: 'doc-new', projectId: 'proj-1' }, name: 'report.csv', status: 'processing' });
    expect(ingest.extractTextFromBuffer).toHaveBeenCalled();
    expect((dbMock as any).projectDocument.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ projectId: 'proj-1', userId: 'u1', source: 'knowledge' }) }));
    expect(await run('add_knowledge_file', { uploadId: 'up-1', name: 'My notes' })).toMatchObject({ ok: true, name: 'My notes', charCount: 17 });
    expect(await run('add_knowledge_file', { uploadId: 'up-foreign' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('add_knowledge_file', { fileId: 'gf-1', uploadId: 'up-1' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('add_knowledge_file', { fileId: 'gf-1', projectId: 'proj-view' })).toMatchObject({ ok: false, reason: 'forbidden' });
    redisMock.incr.mockResolvedValueOnce(11);
    expect(await run('add_knowledge_file', { fileId: 'gf-1' })).toMatchObject({ ok: false, reason: 'rate_limited', scope: 'chat_hourly' });
  });
});

describe('canvases', () => {
  it('create_canvas validates type and chat ownership; delete_canvas + revoke_canvas_share are owner-scoped', async () => {
    expect(await run('create_canvas', { title: 'Plan', type: 'document', content: '# plan' })).toMatchObject({ ok: true, ids: { canvasId: 'cv-new', chatId: 'sup-1' } });
    expect(await run('create_canvas', { title: 'x', type: 'video', content: 'c' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('create_canvas', { title: 'x', content: 'c', chatId: 'c-other' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('delete_canvas', { canvasId: 'cv-1' })).toMatchObject({ ok: true });
    expect(await run('delete_canvas', { canvasId: 'cv-zz' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('revoke_canvas_share', { canvasId: 'cv-1' })).toMatchObject({ ok: true, revoked: true });
  });
  it('share_canvas is NEVER autonomous: it stages a card even with a grant in auto mode, and executes on the confirmed re-call', async () => {
    const reg = await run('share_canvas', { canvasId: 'cv-1' });
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect(typeof reg.confirmationId).toBe('string');
    expect((dbMock as any).canvasShareLink.upsert).not.toHaveBeenCalled();
    expect(await pendingConfirmationCount()).toBe(1);
    const done = await run('share_canvas', { confirmationId: reg.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000) } as any));
    expect(done).toMatchObject({ ok: true, ids: { canvasId: 'cv-1' } });
    expect(done.url).toMatch(/\/api\/crossmodel\/shared\/canvas\/a{40}$/);
  });
});

describe('project archive + preferences', () => {
  it('archive_project maps 409 → busy and 404 → not_found; restore passes archived:false', async () => {
    expect(await run('archive_project', { projectId: 'proj-1', archived: true })).toMatchObject({ ok: true, archived: true });
    expect(await run('archive_project', { projectId: 'proj-1', archived: false })).toMatchObject({ ok: true, archived: false });
    expect(await run('archive_project', { projectId: 'proj-busy', archived: true })).toMatchObject({ ok: false, reason: 'busy' });
    expect(await run('archive_project', { projectId: 'proj-x', archived: true })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await run('archive_project', { projectId: 'proj-1' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('get_preferences aliases legacy ids; set_preferences needs a live user turn and validates', async () => {
    expect(await run('get_preferences', {})).toMatchObject({ ok: true, preferences: { codingModel: 'glm-5.3', codingPermissionMode: 'plan' } });
    expect(await run('set_preferences', { codingPermissionMode: 'ask' }, makeCtx({ userTurnAt: undefined } as any))).toMatchObject({ ok: false, reason: 'no_user_turn' });
    expect(await run('set_preferences', { codingModel: 'gpt-9' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run('set_preferences', { codingModel: 'lab:qwen', codingPermissionMode: 'ask' })).toMatchObject({ ok: true, preferences: { codingModel: 'lab:qwen', codingPermissionMode: 'ask' } });
    expect((dbMock as any).userPreferences.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { codingModel: 'lab:qwen', codingPermissionMode: 'ask' } }));
  });
});

describe('fleet / ops', () => {
  it('list_instances is admin-gated; digest ack/unack; get_session_diff maps sources; webhook status never carries a token; revoke', async () => {
    expect(await runRaw('list_instances', {})).toMatch(/restricted to admin users/);
    fb.isAdminUser.mockResolvedValue(true);
    expect(await run('list_instances', {})).toMatchObject({ ok: true, count: 1, instances: [{ id: 'inst-1', online: true }] });
    expect(await run('ack_digest_item', { key: 'proj-1:blocked', snoozeHours: 4 })).toMatchObject({ ok: true, snoozeUntil: '2026-09-25T00:00:00.000Z' });
    expect(await run('unack_digest_item', { key: 'proj-1:blocked' })).toMatchObject({ ok: true });
    expect(await run('get_session_diff', { chatId: 'c-own' })).toMatchObject({ ok: true, branch: 'digby/x', changedFiles: 2, source: 'disk' });
    expect(await run('get_session_diff', { chatId: 'shared-1' })).toMatchObject({ ok: true, source: 'unavailable', changedFiles: null });
    expect(await run('get_session_diff', { chatId: 'nope' })).toMatchObject({ ok: false, reason: 'not_found' });
    const wh = await run('get_chat_webhook', { chatId: 'c-own' });
    expect(wh).toMatchObject({ ok: true, exists: true, isActive: true, tokenPrefix: 'dgw_ab12cd34' });
    expect(JSON.stringify(wh)).not.toMatch(/dgw_[0-9a-f]{20,}/);
    expect(await run('get_chat_webhook', { chatId: 'c-own2' })).toMatchObject({ ok: true, exists: false });
    expect(await run('revoke_chat_webhook', { chatId: 'c-own' })).toMatchObject({ ok: true, revoked: true });
    expect(await run('revoke_chat_webhook', { chatId: 'c-other' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
  it('resolve_id resolves an own-account chat prefix and reports ambiguity/nothing honestly', async () => {
    expect(await run('resolve_id', { id: 'c-own2xxx', family: 'chat' })).toMatchObject({ ok: true, matches: [], candidates: [] });
    expect(await run('resolve_id', { id: 'c-own2', family: 'chat' })).toMatchObject({ ok: false, reason: 'too_short' });
    (dbMock as any).crossModelChat.findMany.mockImplementationOnce(async () => [{ id: 'c-own2-abcdef', title: 'Second' }]);
    const r = await run('resolve_id', { id: 'c-own2-ab', family: 'chat' });
    expect(r).toMatchObject({ ok: true, resolved: { family: 'chat', id: 'c-own2-abcdef' } });
    expect(await run('resolve_id', { id: 'zzzzzzzz', family: 'bogus' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('infra_action accepts dev_container_restart; get_fleet_telemetry own-account views open to a supervisor seat, refused elsewhere', async () => {
    expect(await run('infra_action', { kind: 'dev_container_restart', reason: 'wedged' })).toMatchObject({ ok: true, kind: 'dev_container_restart', dryRun: true });
    expect(infra.runInfraAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dev_container_restart', userId: 'u1' }));
    expect(await runRaw('get_fleet_telemetry', { view: 'overview' })).toMatch(/restricted to admin users/);
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    expect(await run('get_fleet_telemetry', { view: 'overview' })).toMatchObject({ ok: true, view: 'overview', counts: { chats: 3 } });
    expect(fleetSvc.getFleetOverview).toHaveBeenCalledWith('u1');
    expect(await run('get_fleet_telemetry', { view: 'digests' })).toMatchObject({ ok: true, view: 'digests', digests: [] });
    expect(await run('get_fleet_telemetry', { view: 'pulse' })).toMatchObject({ ok: true, view: 'pulse' });
    expect(fleetSvc.getFleetPulse).toHaveBeenCalledWith('u1', 'USER');
    expect(await runRaw('get_fleet_telemetry', { view: 'boxes' })).toMatch(/restricted to admin users/);
  });
});

describe('create_chat_webhook (#32 close-out + ticket 2eef354e: delegated delivery)', () => {
  it('stages a card when the grant does not NAME it; the OWNER-BROWSER confirm returns the token once; the model re-call never sees it', async () => {
    // A manual grant exists but does not include create_chat_webhook — the card
    // is the default (owner ruling oq_d45410a4: only an EXPLICIT naming is card-free).
    autonomySvc.getChatAutonomy.mockResolvedValue({ chatId: 'sup-1', allowedTools: [...ALL_CONTROL], source: 'manual' });
    const reg = await run('create_chat_webhook', { chatId: 'c-own2', label: 'ci' });
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
    // the REST confirm endpoint executes with ownerBrowser:true → secret shown once
    const owner = await run('create_chat_webhook', { confirmationId: reg.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000), ownerBrowser: true } as any));
    expect(owner).toMatchObject({ ok: true, ids: { chatId: 'c-own2' }, tokenPrefix: 'dgw_new12345', secret: { value: expect.stringMatching(/^dgw_new12345f{40}$/) } });
  });
  it('ticket 2eef354e — a no-envKey model re-call confirm (no ownerBrowser) REFUSES instead of minting a token nobody can see', async () => {
    const reg = await run('create_chat_webhook', { chatId: 'c-own2', rotate: true });
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
    const model = await run('create_chat_webhook', { confirmationId: reg.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000) } as any));
    expect(model).toMatchObject({ ok: false, reason: 'undeliverable' });
    expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
    expect(JSON.stringify(model)).not.toMatch(/f{40}/);
  });
  it('ticket 2eef354e — envKey delivery: owner-browser confirm stores the token in the encrypted vault, model re-call confirm does too, and neither output carries the token', async () => {
    // owner confirms the card in the app
    const reg = await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' });
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect((reg as any).summary).toContain('$CI_WAKE_TOKEN');
    const owner = await run('create_chat_webhook', { confirmationId: reg.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000), ownerBrowser: true } as any));
    expect(owner).toMatchObject({ ok: true, ids: { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' }, tokenPrefix: 'dgw_new12345' });
    expect(credsSvc.upsertCredential).toHaveBeenCalledWith('u1', 'custom', 'CI_WAKE_TOKEN', 'dgw_new12345' + 'f'.repeat(40));
    expect(owner.secret).toBeUndefined();
    expect(JSON.stringify(owner)).not.toMatch(/f{40}/);
    // owner confirms by MESSAGE (model re-call) — same vault delivery, no dead end
    const reg2 = await run('create_chat_webhook', { chatId: 'c-own2', rotate: true, envKey: 'ci_wake_token' });
    expect(reg2).toMatchObject({ ok: false, needsConfirmation: true });
    const model = await run('create_chat_webhook', { confirmationId: reg2.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000) } as any));
    expect(model).toMatchObject({ ok: true, ids: { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' }, tokenPrefix: 'dgw_new12345' });
    expect(credsSvc.upsertCredential).toHaveBeenLastCalledWith('u1', 'custom', 'CI_WAKE_TOKEN', 'dgw_new12345' + 'f'.repeat(40));
    expect(model.secret).toBeUndefined();
    expect(JSON.stringify(model)).not.toMatch(/f{40}/);
    expect((model as any).message).toContain('$CI_WAKE_TOKEN');
  });
  it('ticket 2eef354e — invalid and reserved envKey names are refused at STAGE time (nothing staged, nothing minted)', async () => {
    expect(await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'not-valid name' })).toMatchObject({ ok: false, reason: 'invalid_env_key' });
    expect(await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'GITHUB_TOKEN' })).toMatchObject({ ok: false, reason: 'reserved_env_key' });
    expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
    expect(await pendingConfirmationCount()).toBe(0);
  });
  it('ticket 2eef354e — a vault-store failure after the mint is honest: refused, prefix shown, token never echoed, rotation named as recovery', async () => {
    credsSvc.upsertCredential.mockRejectedValueOnce(new Error('vault unavailable'));
    const reg = await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' });
    const r = await run('create_chat_webhook', { confirmationId: reg.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000), ownerBrowser: true } as any));
    expect(r).toMatchObject({ ok: false, reason: 'vault_store_failed', tokenPrefix: 'dgw_new12345' });
    expect(JSON.stringify(r)).not.toMatch(/f{40}/);
    expect((r as any).message).toContain('rotate:true');
  });
  it('an existing webhook is left alone without rotate:true', async () => {
    const reg = await run('create_chat_webhook', { chatId: 'c-own' });
    const r = await run('create_chat_webhook', { confirmationId: reg.confirmationId }, makeCtx({ userTurnAt: new Date(Date.now() + 60_000), ownerBrowser: true } as any));
    expect(r).toMatchObject({ ok: false, reason: 'exists', tokenPrefix: 'dgw_ab12cd34' });
    expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
  });

  // ── Owner ruling oq_d45410a4 (ticket d53eed71): "Make it autonomy-grantable —
  //    card-free only where you explicitly granted it". Both halves are pinned:
  //    an EXPLICIT grant is card-free, and every MODE-DERIVED authority is not.
  describe('explicit-grant-only (oq_d45410a4 / d53eed71)', () => {
    it('an EXPLICIT manual grant NAMING it executes card-free (no card, mints directly)', async () => {
      autonomySvc.getChatAutonomy.mockResolvedValue({ chatId: 'sup-1', allowedTools: ['create_chat_webhook'], source: 'manual' });
      const r = await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' });
      expect(r).toMatchObject({ ok: true, ids: { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' }, tokenPrefix: 'dgw_new12345' });
      expect(r.needsConfirmation).toBeUndefined();
      expect(webhookSvc.createOrRotateWebhook).toHaveBeenCalledTimes(1);
      // the token is vaulted, never echoed to the model
      expect(credsSvc.upsertCredential).toHaveBeenCalledWith('u1', 'custom', 'CI_WAKE_TOKEN', 'dgw_new12345' + 'f'.repeat(40));
      expect(JSON.stringify(r)).not.toMatch(/f{40}/);
      expect(await pendingConfirmationCount()).toBe(0);
      expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith(expect.objectContaining({ tool: 'create_chat_webhook', note: expect.stringContaining('oq_d45410a4') }));
    });

    it('an agent_mode_auto row naming it still STAGES — mode-derived authority is not an owner grant', async () => {
      // This is the exact state both offending lanes were in: Auto mode
      // materializes the full grantable set, and create_chat_webhook must never
      // be reachable that way (it is absent from AUTONOMY_GRANTABLE_TOOLS, so a
      // real row cannot even contain it — a hand-crafted one must not bypass).
      autonomySvc.getChatAutonomy.mockResolvedValue({ chatId: 'sup-1', allowedTools: ['create_chat_webhook'], source: 'agent_mode_auto' });
      const reg = await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' });
      expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
      expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
      expect(credsSvc.upsertCredential).not.toHaveBeenCalled();
    });

    it('a machine_delegated (supervisor) row naming it still STAGES — a granter cannot launder its own authority into an owner grant', async () => {
      autonomySvc.getChatAutonomy.mockResolvedValue({ chatId: 'sup-1', allowedTools: ['create_chat_webhook'], source: 'machine_delegated' });
      const reg = await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' });
      expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
      expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
    });

    it('an AUTO-mode coding run with NO row still STAGES — the db747817 auto-mode waiver does not reach this tool', async () => {
      autonomySvc.getChatAutonomy.mockResolvedValue(null);
      const reg = await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' }, makeCtx({ agentSurface: 'coding', permissionMode: 'auto', allowedTools: undefined } as any));
      expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
      expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
    });

    it('an unreadable grant row FAILS CLOSED into staging', async () => {
      autonomySvc.getChatAutonomy.mockRejectedValue(new Error('db down'));
      const reg = await run('create_chat_webhook', { chatId: 'c-own2', envKey: 'CI_WAKE_TOKEN' });
      expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
      expect(webhookSvc.createOrRotateWebhook).not.toHaveBeenCalled();
    });
  });
});

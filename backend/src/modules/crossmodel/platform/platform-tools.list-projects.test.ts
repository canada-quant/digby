/**
 * REPLAY — ticket 3521595b: "Newly created project (glm5.3) never appears in
 * fleet project-listing tools".
 *
 * Root cause: the agent-facing platform toolset had NO project-listing tool.
 * Fleet runs discovered projects only INCIDENTALLY — goal_list/todo_list rows
 * (a project with zero goals yields zero rows) and list_chats rows (a project
 * with zero chats yields zero rows) — so a newly created, still-EMPTY project
 * was invisible and its id unenumerable (the UI was fine: REST GET /projects
 * → platform.service.getFolderTree lists folders directly; the ticket's own
 * workaround — "post one message in the project" — only worked because it
 * created a chat, making the project surface in list_chats).
 *
 * Fix: a read-only `list_projects` platform tool wrapping
 * platform.service.getFolderTree (the same source the UI tree uses), returning
 * owned + shared projects INCLUDING empty ones, with ids + hierarchy markers.
 *
 * Pins:
 *   - registration: read-tool set membership (never mutating/gated), schema
 *     registration with no required args, and CHAT_PROFILE_PLATFORM_TOOLS
 *     pickup with no extra wiring;
 *   - the replay itself: a 0-chat / 0-goal project IS enumerated, with its id;
 *   - row shaping: systemPrompt is stripped (get_project reads one project in
 *     full), owned rows carry role 'owner', shared rows carry memberRole +
 *     ownerName;
 *   - the empty account says so in words (no bare JSON), and the 100-row
 *     FLEET_LIST_CAP marks truncated payloads.
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

// The service layer under the tools — fully mocked (platform-tools.ts imports
// platform.service statically; only getFolderTree is exercised here).
const svc = {
  listChats: jest.fn(),
  createChat: jest.fn(),
  getChatStatus: jest.fn(),
  getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(),
  renameChat: jest.fn(),
  archiveChat: jest.fn(),
  moveChat: jest.fn(),
  deleteChat: jest.fn(),
  createProject: jest.fn(),
  getProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  moveFolder: jest.fn(),
  startCodingSession: jest.fn(),
  scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(),
  cancelSchedule: jest.fn(),
  getFolderTree: jest.fn(),
};
// agent-auth pulls config/database + utils/jwt → config/env, which calls
// process.exit(1) without env vars — mirror the constant (see platform-tools.test.ts).
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read',
    'chats:write',
    'folders:read',
    'folders:write',
    'schedules:write',
    'code:run',
  ] as const,
}));

jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// config/database for the DB-persisted confirmation registry (pending-confirmations.ts).
const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { pendingConfirmation: mockConfirmations.api } }));

// The feedback service under the feedback tools — fully mocked. FEEDBACK_TYPES
// is read at MODULE SCOPE by the tool schema, so mirror the real constant.
const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// autonomy.service under the consequential gate — fully mocked. list_projects
// must NEVER consult it (it is a plain read tool); the mock lets us pin that.
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async (): Promise<any> => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

import {
  PLATFORM_TOOL_SCHEMA, PLATFORM_TOOL_NAMES, PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS, executePlatformTool,
} from './platform-tools';
import { MUTATING_TOOLS, ToolContext } from '../coding/tools';
import { CHAT_PROFILE_PLATFORM_TOOLS } from '../coding/agent-profiles';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return ctx;
}

/** A freshly created project: zero chats, zero documents, zero goals — the
 * exact shape that was invisible to every fleet tool before this fix. */
const EMPTY_NEW_PROJECT = {
  id: 'p-empty-glm53', name: 'glm5.3', description: null,
  emoji: '📁', color: 'violet', isPublic: false, isUserSpace: false,
  repoUrl: null, repoProvider: null, workspaceAt: null,
  parentId: null, depth: 0, path: 'p-empty-glm53',
  chatCount: 0, documentCount: 0, memberCount: 0,
  createdAt: '2026-09-08T03:00:00.000Z', updatedAt: '2026-09-08T03:00:00.000Z',
};
const BUSY_PROJECT = {
  id: 'p-busy', name: 'crossmodel', description: 'platform repo',
  emoji: '🛠', color: 'blue', isPublic: false, isUserSpace: false,
  repoUrl: 'https://github.com/x/y', repoProvider: 'github', workspaceAt: '2026-08-01T00:00:00.000Z',
  parentId: null, depth: 0, path: 'p-busy',
  chatCount: 41, documentCount: 3, memberCount: 1,
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
  systemPrompt: 'x'.repeat(5000), // must NOT leak into list rows
};
const SHARED_PROJECT = {
  id: 'p-shared', name: 'shared-with-me', description: null,
  emoji: '📁', color: 'green', repoUrl: null, repoProvider: null, workspaceAt: null,
  parentId: 'p-empty-glm53', depth: 1, path: 'p-empty-glm53/p-shared',
  chatCount: 2, documentCount: 0,
  ownerName: 'Owner Name', memberRole: 'viewer',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  autonomySvc.getChatAutonomy.mockResolvedValue(null);
  svc.getFolderTree.mockResolvedValue({ owned: [BUSY_PROJECT, EMPTY_NEW_PROJECT], shared: [SHARED_PROJECT] });
});

describe('list_projects registration (ticket 3521595b)', () => {
  it('is a READ tool: PLATFORM_READ_TOOLS, never mutating, never permission-gated', () => {
    expect(PLATFORM_READ_TOOLS).toContain('list_projects');
    expect(PLATFORM_MUTATING_TOOLS).not.toContain('list_projects');
    expect(MUTATING_TOOLS.has('list_projects')).toBe(false);
    expect(PLATFORM_TOOL_NAMES).toContain('list_projects');
  });

  it('is in PLATFORM_TOOL_SCHEMA with NO required args and CHAT_PROFILE pickup with no extra wiring', () => {
    const entry = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'list_projects');
    expect(entry).toBeDefined();
    expect((entry!.function.parameters as any).required).toBeUndefined();
    expect(CHAT_PROFILE_PLATFORM_TOOLS).toContain('list_projects');
  });

  it('description teaches the empty-project gap the other fleet tools cannot see', () => {
    const entry = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'list_projects');
    expect(entry!.function.description).toMatch(/EMPTY project/);
    // Layered prompts 2026-09-27: the ticket id left the model-facing text (a
    // `// provenance:` comment on the schema line carries it).
    expect(entry!.function.description).not.toMatch(/3521595b/);
    expect(entry!.function.description).toMatch(/goal_list/);
    expect(entry!.function.description).toMatch(/list_chats/);
  });
});

describe('list_projects dispatch (ticket 3521595b replay)', () => {
  it('REPLAY: a newly created EMPTY project (0 chats, 0 goals) IS enumerated, with its id', async () => {
    const out = await executePlatformTool(makeCtx(), 'list_projects', {});
    expect(svc.getFolderTree).toHaveBeenCalledWith({ userId: 'u1' });
    const payload = JSON.parse(out);
    const ownedIds = payload.owned.map((p: any) => p.id);
    // Before the fix this project was unreachable by every fleet tool — it had
    // no chats (list_chats) and no goals (goal_list). It must be listed now.
    expect(ownedIds).toContain('p-empty-glm53');
    expect(ownedIds).toContain('p-busy');
    const empty = payload.owned.find((p: any) => p.id === 'p-empty-glm53');
    expect(empty.name).toBe('glm5.3');
    expect(empty.chatCount).toBe(0);
    expect(empty.role).toBe('owner');
  });

  it('strips systemPrompt from rows and tags shared projects with memberRole + ownerName', async () => {
    const out = await executePlatformTool(makeCtx(), 'list_projects', {});
    const payload = JSON.parse(out);
    expect(out).not.toContain('x'.repeat(200)); // BUSY_PROJECT.systemPrompt stays out
    for (const row of [...payload.owned, ...payload.shared]) {
      expect(row.systemPrompt).toBeUndefined();
    }
    expect(payload.shared).toHaveLength(1);
    expect(payload.shared[0]).toMatchObject({ id: 'p-shared', role: 'viewer', ownerName: 'Owner Name' });
  });

  it('executes directly in a MACHINE-triggered run (no userTurnAt) — read tools are never gated', async () => {
    const out = await executePlatformTool(makeCtx({ userTurnAt: undefined }), 'list_projects', {});
    expect(JSON.parse(out).owned.map((p: any) => p.id)).toContain('p-empty-glm53');
    expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
  });

  it('an account with no projects says so in words (no bare JSON)', async () => {
    svc.getFolderTree.mockResolvedValue({ owned: [], shared: [] });
    const out = await executePlatformTool(makeCtx(), 'list_projects', {});
    expect(out).toMatch(/No projects found/);
  });

  it('caps each side at 100 rows and marks truncated payloads', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ ...EMPTY_NEW_PROJECT, id: `p-${i}`, name: `proj-${i}` }));
    svc.getFolderTree.mockResolvedValue({ owned: many, shared: [] });
    const out = await executePlatformTool(makeCtx(), 'list_projects', {});
    const payload = JSON.parse(out);
    expect(payload.owned).toHaveLength(100);
    expect(payload.truncated).toBe(true);
    expect(payload.cap).toBe(100);
  });
});

/**
 * Platform unification (P1) — platform tools: schema registration, service
 * mapping, and permission gating (auto/plan/ask + ask-only destructive ops)
 * through executeCodingTool, with the platform.service layer mocked.
 *
 * Security hardening: the CONSEQUENTIAL tools (schedule_message, cancel_schedule,
 * send_chat_message, start_coding_session) never execute on their first in-loop
 * call — they register a user-turn-anchored pending confirmation and only a
 * re-call carrying the confirmationId from a NEW real user turn executes
 * (platform/pending-confirmations.ts). These tests pin that protocol through
 * executePlatformTool (prompt injection can register but NEVER confirm).
 */

import { createHash } from 'crypto';
import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

/** In-memory pendingConfirmation table — the DB-backed confirmation registry. */
const mockConfirmations = createPendingConfirmationTable();
/** In-memory ownerQuestion table — the "Needs owner" inbox store (ticket 7705fec2). */
const mockOwnerQuestions = createOwnerQuestionTable();

/** Ticket 973d7f80: minimal project/todo/goal stores backing the cross-member
 *  second chance in listOwnerQuestionsForUser (only the caller-unmatched-id
 *  path reads these; all pre-existing suites leave them empty). */
const mockShared: { todos: any[]; goals: any[]; projects: any[] } = { todos: [], goals: [], projects: [] };
const sharedMatch = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (v === null) return row[k] == null;
    if (k === 'OR') return (v as any[]).some((c) => sharedMatch(row, c));
    if (v && typeof v === 'object' && 'startsWith' in v) return String(row[k] ?? '').startsWith(v.startsWith);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
const sharedPick = (row: any, select: any) => {
  if (!select) return row;
  const out: any = {};
  for (const k of Object.keys(select)) if (select[k] === true) out[k] = row[k];
  return out;
};
const sharedTable = (rows: () => any[]) => ({
  findUnique: async ({ where, select }: any) => { const r = rows().find((x) => sharedMatch(x, where)) ?? null; return r ? sharedPick(r, select) : null; },
  findFirst: async ({ where, select }: any = {}) => { const r = rows().find((x) => sharedMatch(x, where)) ?? null; return r ? sharedPick(r, select) : null; },
  findMany: async (args: any = {}) => rows().filter((x) => sharedMatch(x, args.where)),
});

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    ownerQuestion: mockOwnerQuestions.api,
    crossModelMessage: mockOwnerQuestions.crossModelMessage,
    crossModelChat: mockOwnerQuestions.crossModelChat,
    telegramLink: { findUnique: async () => null },
    // Ticket 973d7f80: read by the shared-project second chance only.
    projectTodo: sharedTable(() => mockShared.todos),
    projectGoal: sharedTable(() => mockShared.goals),
    crossModelProject: {
      findUnique: async ({ where }: any) => mockShared.projects.find((p) => p.id === where.id) ?? null,
    },
    projectMember: { findMany: async () => [] },
  },
}));

// ticket 4ab93d8d: flagOwnerQuestion now fire-and-forget imports
// ../telegram/telegram.service for the owner DM push — the real module pulls
// config/redis → config/env (process.exit in workers), so mock the boundary.
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: async () => {},
}));

beforeEach(() => { mockConfirmations.reset(); mockOwnerQuestions.reset(); mockShared.todos.length = 0; mockShared.goals.length = 0; mockShared.projects.length = 0; });

// Ticket 973d7f80: the second chance dynamically imports goals.service, whose
// static edge middleware/error-handler → config/env process.exit(1)s in jest
// (this file never loaded goals.service before). Mock the boundary — nothing
// here could rely on the real AppError: the real module was never importable.
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// Same edge one module deeper (ticket 973d7f80): premise-register → config/redis
// → config/env — mock the redis boundary too.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

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

// The service layer under the tools — fully mocked; mapping is what we pin.
const svc = {
  listChats: jest.fn(),
  createChat: jest.fn(),
  getChatStatus: jest.fn(),
  getChatMessages: jest.fn(),
  getChatMessage: jest.fn(), // audit 2026-10-08 W2-6
  sendChatMessage: jest.fn(),
  suggestChatsByIdPrefix: jest.fn(),
  getOwnChatDeletion: jest.fn(),
  renameChat: jest.fn(),
  archiveChat: jest.fn(),
  moveChat: jest.fn(),
  deleteChat: jest.fn(),
  convertChatToCoding: jest.fn(),
  createProject: jest.fn(),
  getProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  moveFolder: jest.fn(),
  startCodingSession: jest.fn(),
  // Staging-time validation seam (feedback 2026-08-16): default = the target
  // resolves as a directly workspace-backed project; tests override per-case.
  resolveCodingSessionTarget: jest.fn(async (): Promise<CodingSessionTarget> => ({
    ok: true,
    project: {
      id: 'p1', userId: 'u1', name: 'Project P', repoUrl: 'https://github.com/a/b',
      defaultBranch: 'main', provider: 'github', githubLabel: null, folderId: null,
      createdAt: new Date(), updatedAt: new Date(),
    },
    projectId: 'p1',
    source: 'direct',
  })),
  suggestProjectsByIdPrefix: jest.fn(async () => [] as Array<{ id: string; name: string }>),
  scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(),
  cancelSchedule: jest.fn(),
  updateSchedule: jest.fn(),
  deafLaneWarning: jest.fn(async (): Promise<string | null> => null),
};
// agent-auth pulls config/database + utils/jwt → config/env, which calls
// process.exit(1) without env vars and kills the whole jest worker at import
// time. platform.validation only needs the AGENT_TOKEN_SCOPES constant —
// mirror it exactly (source of truth: src/middleware/agent-auth.ts).
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

// The feedback service under the feedback tools — fully mocked (the real one
// pulls config/database → config/env → process.exit at import). FEEDBACK_TYPES
// is read at MODULE SCOPE by the tool schema, so mirror the real constant.
const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  shortenFilingTitle: jest.fn((title: string) => ({ title: title.trim(), shortened: title.trim().length > 140, originalTitle: title.trim() })),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));
// get_fleet_telemetry (2026-09-18) hands off to fleet/fleet-telemetry via a dynamic
// import — mocked whole so this suite stays hermetic (the real module pulls
// prisma + the infra-watch GitHub fetchers).
const mockFleetTelemetry: jest.Mock = jest.fn(async () => ({ ok: true }));
jest.mock('../fleet/fleet-telemetry', () => ({ __esModule: true, fleetTelemetry: (...a: any[]) => mockFleetTelemetry(...a) }));

// supervisor-state.service — the get_fleet_telemetry SUPERVISOR EXCEPTION
// (feedback b426a848) dynamic-imports isSupervisorChat to recognize a
// supervisor-class seat (fleet OR project supervisor). Mocked so the seat is
// per-test controllable and the suite stays hermetic (the real module pulls
// prisma; default = not a supervisor seat).
const supState = { isSupervisorChat: jest.fn(async () => false), applyStateUpdate: jest.fn() };
jest.mock('./supervisor-state.service', () => ({ __esModule: true, ...supState }));

// The verified-close evidence gate behind update_feedback's machine-close path
// (audit #7) — mocked at the module boundary (the real one pulls
// config/database → config/env → process.exit at import; it is unit-tested in
// feedback/closure-evidence.test.ts). Reached via DYNAMIC import.
const closureEvidence = {
  verifyMachineCloseEvidence: jest.fn(async (): Promise<any> => ({ ok: true, auditNote: '[machine-close evidence: test]', verified: ['commitSha'] })),
};
jest.mock('../feedback/closure-evidence', () => ({ __esModule: true, ...closureEvidence }));

// fix-state — the merged ∧ deployed proof the done-bar gate runs (6665fff6).
// Default fixLive:true so the pre-6665fff6 close tests keep their meaning;
// the done-bar suite (platform-tools.done-bar.6665fff6.test.ts) pins the
// refusals.
const fixState = {
  parseClosureEvidenceNote: jest.fn(() => ({ commitSha: 'abc1234' })),
  resolveFixStateFromEvidence: jest.fn(async () => ({ fixLive: true, reason: 'commit abc1234 is an ancestor of origin/main ∧ deploy run 42 concluded success' })),
};
jest.mock('../feedback/fix-state', () => ({ __esModule: true, ...fixState }));

// autonomy.service (fleet supervisor) under the consequential gate — mocked
// (the real one pulls config/database + middleware/error-handler → config/env →
// process.exit at import). No grant by default → the bypass never fires here
// and every existing test exercises the unchanged pending flow. The autonomy
// bypass itself is pinned in platform-tools.autonomy.test.ts.
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async (): Promise<any> => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
  // Staging-time doomed-action check for update_schedule / cancel_schedule
  // (autonomy loop #10): the default RESOLVES so every pre-existing
  // cancel/update staging test stages as before; the refusal has its own tests.
  resolveOwnedScheduleTarget: jest.fn(async (): Promise<{ sessionId: string } | null> => ({ sessionId: 'c1' })),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// upload.controller behind send_chat_message's uploadIds seam (dynamic import
// in the tool handler) — mocked: the real module pulls config/redis →
// config/env (process.exit at import). Default loadAttachment = expired (null);
// per-test mockResolvedValueOnce chains stage the blobs. combineAttachments
// keeps its real contract's single-attachment behavior (first file primary).
// chat-gate is deliberately NOT mocked: it is pure (chat-images only) and the
// REAL mapAttachmentForAgent pins the attachment-mapping integration.
const uploadCtl = {
  loadAttachment: jest.fn(async (): Promise<any> => null),
  combineAttachments: jest.fn((atts: any[]) => atts[0]),
};
jest.mock('../upload.controller', () => ({ __esModule: true, ...uploadCtl }));

// ─── ticket 97c06f46 additions ──────────────────────────────────────────────
// The svc mock above already stubs getChatStatus / getOwnChatDeletion /
// suggestChatsByIdPrefix. This suite drives the REAL chatNotFoundRecovery
// through the get_chat_status 404 path with a FAITHFUL getChatExistenceTruth
// stand-in (admin gate + existence read from the two tables below; the REAL
// export's admin gate is unit-pinned in platform.service.97c06f46.test.ts).
const users97: Array<{ id: string; role: string }> = [];
const chats97: Array<{ id: string; archivedAt: Date | null }> = [];
(svc.getChatStatus as jest.Mock).mockImplementation(async ({ chatId }: any) => {
  throw Object.assign(new Error('Chat not found'), { statusCode: 404 });
});
(svc as any).resolveOwnedChatIdPrefix = jest.fn(async (_u: string, id: string) => id);
(svc as any).getChatExistenceTruth = async (opts: { userId: string; chatId: string }) => {
  const u = users97.find((x) => x.id === opts.userId);
  if (!u || String(u.role).toUpperCase() !== 'ADMIN') return null;
  const c = chats97.find((x) => x.id === opts.chatId) ?? null;
  return { exists: !!c, archivedAt: c?.archivedAt ?? null };
};

import { executePlatformTool } from './platform-tools';
import type { CodingSessionTarget } from './platform.service';
import type { ToolContext } from '../coding/tools';

function makeCtx97(userId: string): ToolContext {
  return { sessionId: 'agent-chat-1', userId, workToolDirect: false } as unknown as ToolContext;
}

const LANE_97 = 'eebace78-9ef3-4852-9982-4fd85498d5ec';

beforeEach(() => { users97.length = 0; chats97.length = 0; });

describe('97c06f46 — admin existence truth in the chat-not-found recovery', () => {
  it('an ADMIN probing a LIVE chat it cannot see is told EXISTS-but-not-visible, never deleted', async () => {
    users97.push({ id: 'sup-f4350445', role: 'ADMIN' });
    chats97.push({ id: LANE_97, archivedAt: null });
    const out = await executePlatformTool(makeCtx97('sup-f4350445'), 'get_chat_status', { chatId: LANE_97 });
    expect(String(out)).toContain('EXISTS but is not visible to you');
    expect(String(out)).toContain('an access result, not a deletion result');
    expect(String(out)).toContain('Do NOT treat this id as deleted');
  });

  it('an ADMIN probing an ARCHIVED chat is told exists-but-ARCHIVED (archive ≠ delete)', async () => {
    users97.push({ id: 'sup-f4350445', role: 'ADMIN' });
    chats97.push({ id: 'fbdc568d-0000-0000-0000-000000000000', archivedAt: new Date('2026-10-17T17:55:18.000Z') });
    const out = await executePlatformTool(makeCtx97('sup-f4350445'), 'get_chat_status', { chatId: 'fbdc568d-0000-0000-0000-000000000000' });
    expect(String(out)).toContain('ARCHIVED');
    expect(String(out)).toContain('not deleted');
  });

  it('an ADMIN probing a chat that genuinely does not exist is told it is safe to treat as gone', async () => {
    users97.push({ id: 'sup-f4350445', role: 'ADMIN' });
    const out = await executePlatformTool(makeCtx97('sup-f4350445'), 'get_chat_status', { chatId: '00000000-0000-0000-0000-000000000000' });
    expect(String(out)).toContain('existence checked directly');
    expect(String(out)).toContain('no chat with this id exists');
  });

  it('a NON-admin caller keeps the generic no-leak branch (no existence truth)', async () => {
    users97.push({ id: 'plain-user', role: 'USER' });
    chats97.push({ id: LANE_97, archivedAt: null }); // the chat EXISTS — must not leak
    const out = await executePlatformTool(makeCtx97('plain-user'), 'get_chat_status', { chatId: LANE_97 });
    expect(String(out)).not.toContain('EXISTS but is not visible');
    expect(String(out)).not.toContain('ARCHIVED');
    expect(String(out)).toContain('Chat not found'); // the generic branch shape survives
  });
});


/**
 * Replay pin — ticket 0c9f2420 (mishap, auto-filed at breaker trip
 * 2026-09-21T01:00:38Z; session 539d8432-551e-47a7-9a65-4835d6a33a01, run
 * 1255636b-9765-4404-9c48-fb5629f646f2 — the SAME derail run as ticket
 * 099bd00a: the decoder lock MIGRATED update_document → update_schedule
 * while every narration named get_fleet_telemetry — the lock-migration
 * pattern of the c35162ee class).
 *
 * THE INCIDENT: THREE update_schedule emissions carried the bare placeholder
 * id "none"; every one drew the doomed-action staging refusal (autonomy loop
 * #10, shipped 2026-09-20 08:25:55Z as 7eeedf6c6 — ~16.5h before this
 * incident) INLINE, byte-identical ×3, and ZERO owner confirmation cards
 * were staged — live production confirmation that the card-staging
 * preflight works (folded into the supervisor's owner-click-cost
 * verification, sched 05d906c8).
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the
 * documented kimi-k3 placeholder-emission wrong-tool derail class
 * (f839cede/aff1c189/ec9d7424 → c35162ee → 54121353/83297404 → d50a6300 →
 * afac4aee+769d7278 → 099bd00a). The filed texts diff byte-clean against
 * the current refusal in platform-tools.ts; the containment
 * (resolveOwnedScheduleTarget → null ⇒ failure-shaped refusal, NO card) is
 * exactly the designed seam. NO platform code change.
 *
 * WHY A DEDICATED FILE (feedback/closure-evidence.ts): the machine-close
 * gate checks the INSTANCE'S local checkout FIRST and only falls back to
 * origin/main on a LOCAL MISS — a citation appended to a pre-existing test
 * file (platform-tools.test.ts, merged as #931) is invisible while the
 * instance lags main, so the close is refused replay_test_unciting. A NEW
 * file is a local miss on a stale instance → the origin/main fallback
 * verifies it. The behavior pins live here; the earlier append was moved
 * into this file to keep one home.
 *
 * ⚠ UPDATED 2026-09-23 (ticket cc7004a7): the constraint above is FIXED at
 * the cause — the gate now consults origin/main on a local CITATION miss
 * too (not just a file miss), so appended citations verify on a stale
 * checkout. This file remains a valid close-gate key; the new-file
 * workaround is no longer required. See closure-evidence.cc7004a7.test.ts.
 *
 * Mock scaffold mirrors platform-tools.test.ts (same module under test).
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

/** In-memory pendingConfirmation table — the DB-backed confirmation registry. */
const mockConfirmations = createPendingConfirmationTable();
/** In-memory ownerQuestion table — the "Needs owner" inbox store. */
const mockOwnerQuestions = createOwnerQuestionTable();

/** Minimal project/todo/goal stores backing the cross-member second chance
 *  in listOwnerQuestionsForUser (only the caller-unmatched-id path reads
 *  these; this suite leaves them empty). */
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
    projectTodo: sharedTable(() => mockShared.todos),
    projectGoal: sharedTable(() => mockShared.goals),
    crossModelProject: {
      findUnique: async ({ where }: any) => mockShared.projects.find((p) => p.id === where.id) ?? null,
    },
    projectMember: { findMany: async () => [] },
  },
}));

// flagOwnerQuestion fire-and-forget imports ../telegram/telegram.service for
// the owner DM push — the real module pulls config/redis → config/env
// (process.exit in workers), so mock the boundary.
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: async () => {},
}));

beforeEach(() => { mockConfirmations.reset(); mockOwnerQuestions.reset(); mockShared.todos.length = 0; mockShared.goals.length = 0; mockShared.projects.length = 0; });

// The second chance dynamically imports goals.service, whose static edge
// middleware/error-handler → config/env process.exit(1)s in jest. Mock the
// boundary.
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// Same edge one module deeper: premise-register → config/redis → config/env
// — mock the redis boundary too.
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
  waitForProcessOutput: jest.fn(async () => ({ matched: false, exited: true, output: '' })),
  readProcessOutput: jest.fn(async () => ({ chunk: '', nextOffset: 0, status: 'exited' })),
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
  resolveCodingSessionTarget: jest.fn(async (): Promise<any> => ({ ok: false })),
  suggestProjectsByIdPrefix: jest.fn(async () => [] as Array<{ id: string; name: string }>),
  scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(),
  cancelSchedule: jest.fn(),
  updateSchedule: jest.fn(async (): Promise<any> => ({ ok: true, schedule: { id: 'sched-real-1', sessionId: 'sess-1', kind: 'recurring', enabled: true, intervalSec: 2700, nextRunAt: new Date('2026-09-21T09:00:00Z') } })),
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
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));
// get_fleet_telemetry hands off to fleet/fleet-telemetry via a dynamic
// import — mocked whole so this suite stays hermetic.
const mockFleetTelemetry: jest.Mock = jest.fn(async () => ({ ok: true }));
jest.mock('../fleet/fleet-telemetry', () => ({ __esModule: true, fleetTelemetry: (...a: any[]) => mockFleetTelemetry(...a) }));

// supervisor-state.service — the get_fleet_telemetry SUPERVISOR EXCEPTION
// dynamic-imports isSupervisorChat. Mocked so the suite stays hermetic.
const supState = { isSupervisorChat: jest.fn(async () => false), applyStateUpdate: jest.fn() };
jest.mock('./supervisor-state.service', () => ({ __esModule: true, ...supState }));

// The verified-close evidence gate behind update_feedback's machine-close
// path — mocked at the module boundary (the real one pulls config/database →
// config/env → process.exit at import). Reached via DYNAMIC import.
const closureEvidence = {
  verifyMachineCloseEvidence: jest.fn(async (): Promise<any> => ({ ok: true, auditNote: '[machine-close evidence: test]', verified: ['commitSha'] })),
};
jest.mock('../feedback/closure-evidence', () => ({ __esModule: true, ...closureEvidence }));

// autonomy.service (fleet supervisor) under the consequential gate — mocked
// (the real one pulls config/database + middleware/error-handler → config/env
// → process.exit at import). No grant by default → the bypass never fires
// here. The staging-time doomed-action check for update_schedule /
// cancel_schedule (autonomy loop #10) resolves per-test.
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async () => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
  resolveOwnedScheduleTarget: jest.fn(async (): Promise<{ sessionId: string } | null> => ({ sessionId: 'c1' })),
  // Loop #16 self-correction seams — default: nothing to substitute, no candidates (the byte-exact refusal stays).
  resolveScheduleForCaller: jest.fn(async (): Promise<any> => ({ kind: 'none', passed: 'none', candidates: [] })),
  describeCallerSchedules: jest.fn((c: any[]) => `THIS chat's schedules — pass one of these full ids: ${c.map((x) => x.id).join('; ')}.`),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// upload.controller behind send_chat_message's uploadIds seam (dynamic import
// in the tool handler) — mocked: the real module pulls config/redis →
// config/env (process.exit at import).
const uploadCtl = {
  loadAttachment: jest.fn(async (): Promise<any> => null),
  combineAttachments: jest.fn((atts: any[]) => atts[0]),
};
jest.mock('../upload.controller', () => ({ __esModule: true, ...uploadCtl }));

import { executePlatformTool } from './platform-tools';
import type { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}, approvals: Array<'allow' | 'always' | 'deny'> = []) {
  const requested: Array<{ tool: string; args: any }> = [];
  const ctx = {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    // Fixtures simulate a REAL USER TURN (userTurnAt set on every user path) —
    // pass userTurnAt: undefined in overrides to simulate a machine-triggered run.
    userTurnAt: new Date(),
    requestApproval: async (tool: string, args: any) => { requested.push({ tool, args }); return approvals.shift() ?? 'allow'; },
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return { ctx, requested };
}

describe('ticket 0c9f2420 — machine-lane update_schedule id "none" streak: byte-exact doomed-action refusal, ZERO card staged (model-side adjudication replay)', () => {
  /** The ticket's three filed failure texts are byte-identical (newest
   *  first) — the verbatim string each of the three emissions drew. */
  const TICKET_TEXT =
    'Tool update_schedule failed: no schedule with id "none" exists for this owner (an id is the full id from list_schedules / schedule_get / schedule_message, or a unique prefix of at least 8 characters). Copy a real id from list_schedules — never invent, truncate below 8 characters, or placeholder an id. No confirmation card was staged — nothing is waiting on the owner.';

  it('BYTE-EXACT ×3: the incident streak from a MACHINE lane — every emission draws the identical current refusal and NO confirmation row ever stages', async () => {
    autonomySvc.resolveOwnedScheduleTarget.mockResolvedValue(null); // every emission in the streak
    const { ctx } = makeCtx({ userTurnAt: undefined }); // machine-triggered run — the incident's posture
    for (let i = 0; i < 3; i += 1) {
      const out = await executePlatformTool(ctx, 'update_schedule', { id: 'none', intervalMinutes: 45 });
      expect(out).toBe(TICKET_TEXT); // full-string equality — byte-exact, not a regex
    }
    expect(mockConfirmations.rows).toHaveLength(0); // the owner-click-cost acceptance: zero cards across the whole streak
    expect(autonomySvc.resolveOwnedScheduleTarget).toHaveBeenCalledTimes(3);
    expect(autonomySvc.resolveOwnedScheduleTarget).toHaveBeenCalledWith('u1', 'none');
    expect(svc.cancelSchedule).not.toHaveBeenCalled(); // nothing executed
  });

  it('the refusal is turn-type-agnostic: a USER-turn call with the same placeholder id draws the identical text and stages no card', async () => {
    autonomySvc.resolveOwnedScheduleTarget.mockResolvedValueOnce(null);
    const { ctx } = makeCtx(); // userTurnAt set — a real user turn
    const out = await executePlatformTool(ctx, 'update_schedule', { id: 'none', prompt: 'x' });
    expect(out).toBe(TICKET_TEXT);
    expect(mockConfirmations.rows).toHaveLength(0);
  });
});

describe('schedule-id SELF-CORRECTION (autonomy loop #16, 2026-09-21): a placeholder id is applied to this chat\'s only enabled machine schedule, or the refusal names the real ones', () => {
  beforeEach(() => {
    autonomySvc.resolveOwnedScheduleTarget.mockResolvedValue(null);
    autonomySvc.resolveScheduleForCaller.mockReset().mockResolvedValue({ kind: 'none', passed: 'none', candidates: [] });
    svc.updateSchedule.mockClear();
    autonomySvc.auditAutonomousExecution.mockClear();
  });

  it('SUBSTITUTED: update_schedule("none") from a machine lane executes against the resolved id, the result carries a [SCHEDULE ID NOTE], no card, audited', async () => {
    autonomySvc.resolveScheduleForCaller.mockResolvedValueOnce({ kind: 'substituted', id: 'sched-real-1', passed: 'none' });
    const { ctx } = makeCtx({ userTurnAt: undefined });
    const out = await executePlatformTool(ctx, 'update_schedule', { id: 'none', intervalMinutes: 45 });
    expect(autonomySvc.resolveScheduleForCaller).toHaveBeenCalledWith('u1', 'sess-1', 'none', 'update_schedule');
    expect(svc.updateSchedule).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', id: 'sched-real-1', intervalSec: 2700, promptSetBy: 'machine' }));
    const env = JSON.parse(String(out)); // success envelope — the note rides the message
    expect(env).toMatchObject({ ok: true, tool: 'update_schedule', ids: { scheduleId: 'sched-real-1', chatId: 'sess-1' } });
    expect(env.message).toContain('[SCHEDULE ID NOTE] Your id "none" does not exist');
    expect(env.message).toContain('Updated schedule sched-real-1');
    expect(mockConfirmations.rows).toHaveLength(0);
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith(expect.objectContaining({ tool: 'update_schedule', note: expect.stringContaining('substituted') }));
  });

  it('LISTED: no substitution possible → the byte-exact refusal followed by this chat\'s real schedules; nothing executes, no card', async () => {
    autonomySvc.resolveScheduleForCaller.mockResolvedValueOnce({
      kind: 'none', passed: 'none',
      candidates: [{ id: 'sched-real-1', kind: 'recurring', enabled: true, intervalSec: 1800, nextRunAt: new Date('2026-09-21T08:11:00Z'), lastStatus: 'skipped:busy', promptSetBy: 'user' }],
    });
    const { ctx } = makeCtx({ userTurnAt: undefined });
    const out = String(await executePlatformTool(ctx, 'update_schedule', { id: 'none', intervalMinutes: 45 }));
    expect(out.startsWith('Tool update_schedule failed: no schedule with id "none" exists for this owner')).toBe(true);
    expect(out.endsWith(" THIS chat's schedules — pass one of these full ids: sched-real-1.")).toBe(true);
    expect(svc.updateSchedule).not.toHaveBeenCalled();
    expect(mockConfirmations.rows).toHaveLength(0);
  });

  it('cancel_schedule consults the resolver with its own tool name (the helper never substitutes for cancel) and keeps the bare refusal', async () => {
    const { ctx } = makeCtx({ userTurnAt: undefined });
    const out = String(await executePlatformTool(ctx, 'cancel_schedule', { id: 'none' }));
    expect(autonomySvc.resolveScheduleForCaller).toHaveBeenCalledWith('u1', 'sess-1', 'none', 'cancel_schedule');
    expect(out.startsWith('Tool cancel_schedule failed: no schedule with id "none" exists for this owner')).toBe(true);
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
    expect(mockConfirmations.rows).toHaveLength(0);
  });
});

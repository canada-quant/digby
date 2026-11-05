/**
 * Replay pin — tickets a152e770 + 47d006d0 (mishaps, auto-filed at breaker
 * trips 2026-09-21T07:21:10Z / 07:26:28Z; session
 * ddd26be0-723d-4745-8bb5-be3ff4752d52, run 0e81392f-d04d-4dfb-b91f-fb2a5431c8b9
 * — the tt-rd "node-a Qwen3.8 Speed Mission Successor" lane's firing-105 derail.
 * Harness end-note 07:20:23Z: "repeated wrong-tool derailment (3 episodes;
 * intended tool appears to be run_command)"; the derail-rescue continuation
 * named "looping tool(s): update_feedback, update_schedule" and confirmed the
 * intended run_command call never executed).
 *
 * THE INCIDENT — the EMPTY-ID variant of the placeholder-emission derail
 * class: the decoder lock walked TWO platform tools in one run and every
 * emission carried an EMPTY id (the lane's reasoning named run_command
 * throughout). THREE update_feedback({ id: '' }) emissions each drew the
 * machine-gate's ticket_not_found envelope with "ticketId": "" (the d2c2744b
 * truth-variant message — the mutation path at platform-tools.ts:3696 was
 * never reached), and THREE update_schedule({ id: '' }) emissions each drew
 * the doomed-action staging refusal (autonomy loop #10) rendering the empty
 * raw id as "(empty)" — ZERO owner confirmation cards staged across the
 * whole run.
 *
 * VERDICT (the tickets' mandated investigation): MODEL BEHAVIOR, both legs —
 * the documented placeholder-emission wrong-tool derail class
 * (f839cede/aff1c189/ec9d7424 → c35162ee → 54121353/83297404 → d50a6300 →
 * afac4aee+769d7278 → 099bd00a/0c9f2420 → 155488ff+cea13871 →
 * 89ddfcfe/60f64ebb/1867d6d5), empty-string variant. The empty id is
 * model-authored: a framework garble would carry the intended call's REAL
 * args (the f839cede rule — the reasoning named run_command, whose real arg
 * is a command string, not an empty id). tool-preflight.ts deliberately
 * leaves empty strings ungated ("Empty strings are left to the tool's own
 * validation — they are a missing param, not an invention"), and the tools'
 * own validations refused CORRECTLY at every layer:
 *   update_feedback: schema (no minLength — by design) → ticket-18086326
 *     machine-mutation gate → the REAL closure-evidence.ts:266 verdict
 *     (prisma miss; the ≥8-char prefix fallback at :249 is skipped for an
 *     empty id) → byte-exact envelope at platform-tools.ts:3683/3685.
 *   update_schedule: staging-time doomed-action rule
 *     (platform-tools.ts:2125-2135): resolveOwnedScheduleTarget('') → null ⇒
 *     failure-shaped refusal, shown = raw || '(empty)', NO card.
 * The breaker then counted, tripped, terminated the run at the second
 * distinct tool (agent.ts derailTripCounts), filed one ticket per tool, and
 * the rescue continuation fired with the correct re-grounding brief. NO
 * platform code change.
 *
 * COVERAGE NOTE (why this file adds pins): the empty-string id was an
 * UNPINNED seam — update_feedback had NO tool-layer empty-id test (existing
 * coverage is service-layer 400 for '', or 'nonexistent'/'nope' ids), and
 * the schedule family's "(empty)" rendering was covered only for
 * cancel_schedule by REGEX (platform-tools.test.ts:1887-1901). The
 * closure-evidence module is deliberately NOT mocked here: the real
 * verifyMachineCloseEvidence produces the verdict under test against the
 * mocked prisma userFeatureRequest table.
 *
 * WHY A DEDICATED FILE (feedback/closure-evidence.ts): the machine-close
 * gate checks the INSTANCE'S local checkout FIRST and only falls back to
 * origin/main on a LOCAL MISS — a citation appended to a pre-existing test
 * file is invisible while the instance lags main (refused
 * replay_test_unciting, observed on the 0c9f2420 close). A NEW file is a
 * local miss on a stale instance ⇒ the origin/main fallback verifies it.
 *
 * ⚠ UPDATED 2026-09-23 (ticket cc7004a7): the constraint above is FIXED at
 * the cause — the gate now consults origin/main on a local CITATION miss
 * too, so appended citations verify on a stale checkout. New-file pins
 * remain valid close-gate keys; the workaround is no longer required. See
 * closure-evidence.cc7004a7.test.ts for the replay.
 *
 * Mock scaffold mirrors platform-tools.0c9f2420.test.ts (same module under
 * test), minus the closure-evidence mock.
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
    // The REAL closure-evidence verifier's table (verifyMachineCloseEvidence
    // reads prisma.userFeatureRequest — findUnique by id, then the ≥8-char
    // startsWith prefix fallback). Always empty here: every id misses, so
    // the not-found verdict path is the one under test.
    userFeatureRequest: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
    },
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

beforeEach(() => {
  jest.clearAllMocks(); // call counts reset; declared mockResolvedValue defaults survive
  mockConfirmations.reset(); mockOwnerQuestions.reset();
  mockShared.todos.length = 0; mockShared.goals.length = 0; mockShared.projects.length = 0;
});

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
  updateFeedbackTicket: jest.fn(), // asserted NEVER called — the gate refuses first
  // Mirrors the real service's empty-key short-circuit
  // (feedback.service.ts: `const key = id.trim(); if (!key) return { ok:false, reason:'not_found' }`).
  getFeedbackTicketById: jest.fn(async (): Promise<any> => ({ ok: false, reason: 'not_found' })),
  isAdminUser: jest.fn(async () => true), // the incident lane was admin — past the platform-tools.ts:3625 check
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

// ../feedback/closure-evidence is DELIBERATELY NOT mocked (contrast
// platform-tools.0c9f2420.test.ts): the real verifyMachineCloseEvidence is
// the code under test for the a152e770 leg — it loads cleanly in jest (its
// only imports are fs, path, the mocked prisma, and the mocked logger) and
// its ticket_not_found verdict message is pinned byte-exact below.

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

describe('ticket a152e770 — machine-lane update_feedback EMPTY-STRING id streak: byte-exact ticket_not_found envelope, mutation never reached (model-side adjudication replay)', () => {
  /** The ticket's filed failure texts are byte-identical — the verbatim
   *  envelope each emission drew, recomposed here from the CURRENT source
   *  (platform-tools.ts:3683 wrapper + closure-evidence.ts:266 verdict +
   *  platform-tools.ts:3685's JSON.stringify(…, null, 1)). */
  const UF_MESSAGE =
    'This machine-triggered run may NOT mutate feedback ticket : Feedback ticket "" not found — nothing was closed. Copy the exact id from list_feedback. If this id was fabricated or mistyped, re-derive a real one from list_feedback/get_feedback or your dispatch brief before retrying; nothing was mutated. If the ticket needs triage you cannot evidence, record a file_feedback sighting instead.';
  const UF_JSON = JSON.stringify({ ok: false, tool: 'triage_ticket', reason: 'ticket_not_found', ticketId: '', message: UF_MESSAGE }, null, 1); // tool = model-facing spelling (tool-scope.ts, 2026-09-22)

  it('BYTE-EXACT ×3: the incident streak — update_feedback({ id: "" }) draws the identical envelope through the REAL closure-evidence verdict and NEVER reaches updateFeedbackTicket', async () => {
    const { ctx } = makeCtx({ userTurnAt: undefined }); // machine-triggered run — the incident's posture
    for (let i = 0; i < 3; i += 1) {
      const out = await executePlatformTool(ctx, 'update_feedback', { id: '', status: 'in_progress', adminNote: 'triage note' });
      expect(out).toBe(UF_JSON); // full-string equality — byte-exact, not a regex
    }
    // The gate's dispatch-binding lookup saw the empty id every time…
    expect(fb.getFeedbackTicketById).toHaveBeenCalledTimes(3);
    expect(fb.getFeedbackTicketById).toHaveBeenCalledWith('');
    // …and the mutation path (platform-tools.ts:3696) was never reached.
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('discriminator: an unknown but well-formed uuid echoes its OWN bytes (wrapper slices to 8, verdict carries the full id) — the "" in the incident envelope is the model-authored input, not a formatter artifact', async () => {
    const { ctx } = makeCtx({ userTurnAt: undefined });
    const id = 'deadbeef-dead-4ead-8ead-deadbeefdead';
    const out = await executePlatformTool(ctx, 'update_feedback', { id, status: 'in_progress', adminNote: 'x' });
    const expected = JSON.stringify({
      ok: false, tool: 'triage_ticket', reason: 'ticket_not_found', ticketId: id,
      message: `This machine-triggered run may NOT mutate feedback ticket deadbeef: Feedback ticket "${id}" not found — nothing was closed. Copy the exact id from list_feedback. If this id was fabricated or mistyped, re-derive a real one from list_feedback/get_feedback or your dispatch brief before retrying; nothing was mutated. If the ticket needs triage you cannot evidence, record a file_feedback sighting instead.`,
    }, null, 1);
    expect(out).toBe(expected);
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('ticket 47d006d0 — machine-lane update_schedule EMPTY id streak: byte-exact doomed-action refusal, ZERO card staged (model-side adjudication replay)', () => {
  /** The ticket's three filed failure texts are byte-identical — the
   *  verbatim string each emission drew (platform-tools.ts:2133 with
   *  shown = ''.slice(0, 40) || '(empty)'). */
  const US_TEXT =
    'Tool update_schedule failed: no schedule with id "(empty)" exists for this owner (an id is the full id from list_schedules / schedule_get / schedule_message, or a unique prefix of at least 8 characters). Copy a real id from list_schedules — never invent, truncate below 8 characters, or placeholder an id. No confirmation card was staged — nothing is waiting on the owner.';

  it('BYTE-EXACT ×3: the incident streak — update_schedule({ id: "" }) draws the identical refusal INLINE and stages ZERO owner confirmation rows', async () => {
    autonomySvc.resolveOwnedScheduleTarget.mockResolvedValue(null); // every emission in the streak
    const { ctx } = makeCtx({ userTurnAt: undefined }); // machine-triggered run — the incident's posture
    for (let i = 0; i < 3; i += 1) {
      const out = await executePlatformTool(ctx, 'update_schedule', { id: '', intervalMinutes: 45 });
      expect(out).toBe(US_TEXT); // full-string equality — byte-exact, not a regex
    }
    expect(mockConfirmations.rows).toHaveLength(0); // zero cards across the whole streak
    expect(autonomySvc.resolveOwnedScheduleTarget).toHaveBeenCalledTimes(3);
    expect(autonomySvc.resolveOwnedScheduleTarget).toHaveBeenCalledWith('u1', '');
  });

  it('the omitted-id shape renders identically — String(args?.id ?? "").trim() maps missing ≡ empty to the same "(empty)" refusal (the incident arg shape is unknowable; both produce the filed text)', async () => {
    autonomySvc.resolveOwnedScheduleTarget.mockResolvedValue(null);
    const { ctx } = makeCtx({ userTurnAt: undefined });
    const out = await executePlatformTool(ctx, 'update_schedule', { intervalMinutes: 45 });
    expect(out).toBe(US_TEXT);
    expect(mockConfirmations.rows).toHaveLength(0);
  });
});

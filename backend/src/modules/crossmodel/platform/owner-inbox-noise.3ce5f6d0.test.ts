/**
 * Replay pin — ticket 3ce5f6d0 (2026-09-10 owner-inbox noise incident).
 *
 * The owner, reviewing his inbox: "are these stale as well?" — three of five
 * cards were noise the framework could have resolved itself. This suite
 * replays the three shapes end-to-end at service level:
 *
 *   A) cf_10407 — MOOT CONFIRMATION: a machine lane staged cancel_schedule
 *      for a once-kind backstop that FIRED (self-disabled) while the card
 *      awaited the owner; the card then sat 4h asking to confirm a cancel of
 *      an already-disabled schedule. FIX: a pending confirmation whose target
 *      is ALREADY in the requested end state auto-resolves as 'moot' WITH a
 *      receipt — checked at listing time, in the consume path (the lane sees
 *      a 'moot' result), and on the REST confirm path.
 *   B) cf_241dc — LOW-VALUE CONFIRMATION: a machine lane cancelling its OWN
 *      backstop schedule was forced onto the owner. FIX: a machine-triggered
 *      run (no userTurnAt — it can never confirm) cancelling a schedule on
 *      its OWN chat executes WITHOUT a card only when the prompt is PROVABLY
 *      machine-authored (promptSetBy === 'machine' — NULL/'system'/'user'
 *      all stage) and it is not the chat's LAST enabled schedule; every
 *      other shape still stages.
 *   C) oq_9ffc4f5a + oq_dfe04aab — RESUME CARDS FOR A FINISHED LANE: the
 *      kernel lane's goal was done and the lane had cancelled its own
 *      renewal after its last completed run, yet the stopped-schedule alert
 *      filed TWO 'Resume the stopped schedule …?' cards (a finished lane
 *      looks identical to a dead one). FIX: suppress when (i) every goal the
 *      chat served is done/archived or (ii) the lane machine-cancelled its
 *      own renewal inside its last completed run, and never more than ONE
 *      open stopped-schedule card per chat.
 *
 * Scaffolding mirrors platform-tools.autonomy.test.ts (service layer +
 * autonomy.service + feedback.service mocked; the REAL confirmation registry
 * runs against the in-memory testkit table) plus the stopped-schedule-alert
 * suite's prisma/owner-questions boundaries.
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
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

// The service layer under the tools — fully mocked; the gate behavior is what we pin.
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
  deafLaneWarning: jest.fn(async () => null),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  AUTONOMY_SOURCE_MANUAL: 'manual',
  AUTONOMY_SOURCE_AGENT_MODE: 'agent_mode_auto',
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
  autoModeTargetAllows: jest.fn(async () => true),
  implicitParentAutonomyAllows: jest.fn(async () => false),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// The stopped-schedule alert's owner-questions boundary (dynamic import).
const mockFlagOwnerQuestion = jest.fn();
const mockHasOpenStoppedScheduleDecisionForChat = jest.fn(async (..._a: any[]) => false);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
  hasOpenStoppedScheduleDecisionForChat: (...a: any[]) => mockHasOpenStoppedScheduleDecisionForChat(...a),
  stoppedScheduleMarker: (id: string) => `[stopped-schedule:${id}]`,
}));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// config/database — the REAL confirmation registry runs against the in-memory
// testkit table; the other tables serve the moot checker + the alert module.
const mockConfirmations = createPendingConfirmationTable();
const mockScheduleFindFirst = jest.fn();
const mockScheduleFindUnique = jest.fn();
const mockScheduleFindMany = jest.fn();
const mockScheduleCount = jest.fn();
const mockMessageCreate = jest.fn(async (..._a: any[]) => ({}));
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockChatFindUnique = jest.fn();
const mockGoalFindMany = jest.fn();
const mockTodoFindMany = jest.fn();
const mockTodoCount = jest.fn();
const mockRunCount = jest.fn();
const mockRunFindFirst = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    chatSchedule: {
      findFirst: (...a: any[]) => mockScheduleFindFirst(...a),
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      findMany: (...a: any[]) => mockScheduleFindMany(...a),
      count: (...a: any[]) => mockScheduleCount(...a),
    },
    crossModelMessage: { create: (...a: any[]) => mockMessageCreate(...a) },
    crossModelChat: { update: (...a: any[]) => mockChatUpdate(...a), findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    projectGoal: { findMany: (...a: any[]) => mockGoalFindMany(...a) },
    projectTodo: { findMany: (...a: any[]) => mockTodoFindMany(...a), count: (...a: any[]) => mockTodoCount(...a) },
    agentRun: { count: (...a: any[]) => mockRunCount(...a), findFirst: (...a: any[]) => mockRunFindFirst(...a) },
  },
}));

import { executePlatformTool } from './platform-tools';
import { ToolContext } from '../coding/tools';
import {
  consumePendingConfirmation,
  getPendingConfirmation,
  listPendingConfirmationsForUser,
  registerPendingConfirmation,
} from './pending-confirmations';
import { maybeFileStoppedScheduleDecision, SELF_STOP_GRACE_MS } from '../coding/stopped-schedule-alert';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'lane-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

/** Minimal UserScheduleView-shaped row (the gate reads id/sessionId/enabled/promptSetBy). */
const scheduleView = (over: Partial<Record<string, any>> = {}) => ({
  id: 'sched-1', kind: 'recurring', prompt: 'p', intervalSec: 4500,
  nextRunAt: new Date(Date.now() + 3600_000).toISOString(), enabled: true,
  runsCount: 4, maxRuns: 6, expiresAt: null, lastFiredAt: null, lastStatus: 'started',
  promptSetBy: 'machine', busySkips: 0, dailyFiresUsed: null, dailyCapLimit: 48,
  capWindowResetsAt: null, sessionId: 'lane-1',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  autonomySvc.getChatAutonomy.mockResolvedValue(null); // default: no grant
  svc.listSchedules.mockResolvedValue([]);             // default: nothing resolvable → staging (fail-closed)
  svc.cancelSchedule.mockResolvedValue(true);
  // Alert defaults: a provably-dead lane on a project — suppression is per-test.
  mockScheduleFindUnique.mockResolvedValue(stoppedScheduleRow());
  mockScheduleCount.mockResolvedValue(0);   // no enabled successor
  mockRunCount.mockResolvedValue(0);        // no trailing-6h runs
  mockRunFindFirst.mockResolvedValue(null); // no completed run (self-stop check falls through)
  mockChatFindUnique.mockResolvedValue({ title: 'Kernel lane', userId: 'u1', projectId: 'proj-kernel' });
  mockTodoFindMany.mockResolvedValue([]);   // no todos assigned to the chat (served-goals check falls through)
  mockTodoCount.mockResolvedValue(1);
  mockGoalFindMany.mockImplementation(async ({ where }: any) => {
    if (where?.id?.in) return []; // served-goals lookup: none assigned
    return [{ id: 'g-other', title: 'Another lane’s active goal', status: 'active', blockedReason: null }];
  });
  mockHasOpenStoppedScheduleDecisionForChat.mockResolvedValue(false);
  mockFlagOwnerQuestion.mockResolvedValue({ kind: 'created', question: { id: 'oq_new' } });
});

/* ── A) cf_10407 — moot confirmation auto-resolve ──────────────────────────── */

const SCHEDULE_DISABLED = { id: '8cb73364-aaaa-bbbb-cccc-dddddddddddd', userId: 'u1', enabled: false, disabledAt: new Date('2026-09-10T15:02:00Z') };

describe('A) moot confirmation (cf_10407 replay)', () => {
  const stageCancel = () => registerPendingConfirmation({
    sessionId: 'lane-1', userId: 'u1', tool: 'cancel_schedule',
    args: { id: SCHEDULE_DISABLED.id }, summary: `Cancel (disable) schedule ${SCHEDULE_DISABLED.id}.`,
  });

  it('resolves WITHOUT an owner click at listing time — the card leaves the inbox WITH a moot receipt + a lane note', async () => {
    const { confirmationId } = await stageCancel();
    mockScheduleFindFirst.mockResolvedValue(SCHEDULE_DISABLED); // the backstop fired + self-disabled

    const listed = await listPendingConfirmationsForUser('u1');

    expect(listed).toEqual([]); // no card for the owner
    const row = await getPendingConfirmation(confirmationId);
    expect(row!.status).toBe('moot');
    expect(row!.result).toMatchObject({ moot: true, reason: expect.stringContaining('already disabled') });
    expect(row!.resolvedAt).not.toBeNull();
    // The lane sees the resolution in its transcript (the owner-inbox note convention).
    expect(mockMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'lane-1', role: 'assistant',
        content: expect.stringContaining('MOOT'),
        metadata: { origin: 'owner-inbox' },
      }),
    });
  });

  it('the lane sees a MOOT result on the consume path (a re-call with confirmationId never executes)', async () => {
    const { confirmationId } = await stageCancel();
    mockScheduleFindFirst.mockResolvedValue(SCHEDULE_DISABLED);
    const row = await getPendingConfirmation(confirmationId);

    const check = await consumePendingConfirmation({
      confirmationId, sessionId: 'lane-1', tool: 'cancel_schedule',
      userTurnAt: new Date(row!.createdAt.getTime() + 1000),
    });

    expect(check).toEqual({ ok: false, reason: 'moot', detail: expect.stringContaining('already disabled') });
    expect((await getPendingConfirmation(confirmationId))!.status).toBe('moot');
  });

  it('a schedule that no longer exists is moot too (nothing to cancel)', async () => {
    const { confirmationId } = await stageCancel();
    mockScheduleFindFirst.mockResolvedValue(null); // row GC'd
    mockScheduleFindMany.mockResolvedValue([]);    // no prefix candidates either

    const check = await consumePendingConfirmation({
      confirmationId, sessionId: 'lane-1', tool: 'cancel_schedule',
      userTurnAt: new Date(Date.now() + 1000),
    });

    expect(check).toEqual({ ok: false, reason: 'moot', detail: expect.stringContaining('no longer exists') });
  });

  it('NEVER moots a live target: an ENABLED schedule stays pending and a later user-turn confirm executes it', async () => {
    const { confirmationId } = await stageCancel();
    mockScheduleFindFirst.mockResolvedValue({ ...SCHEDULE_DISABLED, enabled: true, disabledAt: null });

    expect((await listPendingConfirmationsForUser('u1')).map((r: any) => r.id)).toEqual([confirmationId]);

    const row = await getPendingConfirmation(confirmationId);
    const check = await consumePendingConfirmation({
      confirmationId, sessionId: 'lane-1', tool: 'cancel_schedule',
      userTurnAt: new Date(row!.createdAt.getTime() + 1000),
    });
    expect(check).toEqual({ ok: true, args: { id: SCHEDULE_DISABLED.id } });
    expect((await getPendingConfirmation(confirmationId))!.status).toBe('consumed');
  });
});

/* ── B) cf_241dc — low-value machine self-cancel executes without a card ───── */

describe('B) machine self-cancel policy (cf_241dc replay)', () => {
  const OWN = '290ebe13-1111-2222-3333-444444444444';
  const OTHER_ENABLED = 'eeeeeeee-5555-6666-7777-888888888888';

  // Gate flip 2026-09-11 (owner: full steam): by DEFAULT a machine run's
  // own-scope schedule mutation executes on every surface before this policy
  // is consulted (platform-tools gate, autoModeTargetAllows scope) — so the
  // case-B pins below describe the OPT-IN staging path (MACHINE_SCHEDULE_
  // CONFIRM_GATE=1), where the 3ce5f6d0 self-cancel exception still applies.
  beforeEach(() => { process.env.MACHINE_SCHEDULE_CONFIRM_GATE = '1'; });
  afterEach(() => { delete process.env.MACHINE_SCHEDULE_CONFIRM_GATE; });

  it('DEFAULT (gate flip 2026-09-11): with the confirm gate off, even an owner-set prompt on the lane\'s own chat cancels without a card', async () => {
    delete process.env.MACHINE_SCHEDULE_CONFIRM_GATE;
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-1', enabled: true, promptSetBy: 'user' }),
    ]);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'cancel_schedule', { id: OWN });
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.cancelSchedule).toHaveBeenCalledWith({ userId: 'u1', id: OWN, initiator: 'machine', actorChatId: 'lane-1' }); // audit 2026-10-06 T4-2
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'lane-1', tool: 'cancel_schedule', note: expect.stringContaining('machine schedule self-management'),
    }));
  });

  it('EXECUTES without a confirmation card: own chat, machine-authored prompt (promptSetBy=machine), another enabled schedule keeps the lane alive', async () => {
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-1', enabled: true, promptSetBy: 'machine' }),
      scheduleView({ id: OTHER_ENABLED, sessionId: 'lane-1', enabled: true }),
    ]);
    const ctx = makeCtx({ sessionId: 'lane-1' }); // NO userTurnAt — machine-triggered firing

    const out = await executePlatformTool(ctx, 'cancel_schedule', { id: OWN });

    expect(out).not.toMatch(/needsConfirmation/);
    expect(out).toContain(`Cancelled schedule ${OWN}.`);
    expect(svc.cancelSchedule).toHaveBeenCalledWith({ userId: 'u1', id: OWN, initiator: 'machine', actorChatId: 'lane-1' }); // audit 2026-10-06 T4-2
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'lane-1', tool: 'cancel_schedule', note: expect.stringContaining('3ce5f6d0'),
    }));
  });

  it('STAGES when the prompt is owner-set (promptSetBy=user) — the owner decides on their own cadence', async () => {
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-1', enabled: true, promptSetBy: 'user' }),
      scheduleView({ id: OTHER_ENABLED, sessionId: 'lane-1', enabled: true }),
    ]);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'cancel_schedule', { id: OWN });
    expect(out).toMatch(/needsConfirmation/);
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });

  it('STAGES for a legacy NULL promptSetBy row (adversarial B1: pre-2026-08-30 authorship is UNKNOWN — doubt stages)', async () => {
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-1', enabled: true, promptSetBy: null }),
      scheduleView({ id: OTHER_ENABLED, sessionId: 'lane-1', enabled: true }),
    ]);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'cancel_schedule', { id: OWN });
    expect(out).toMatch(/needsConfirmation/);
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });

  it('STAGES for a harness-stamped (promptSetBy=system) row (adversarial B1: renewal successors/defers/keeper keep the card)', async () => {
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-1', enabled: true, promptSetBy: 'system' }),
      scheduleView({ id: OTHER_ENABLED, sessionId: 'lane-1', enabled: true }),
    ]);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'cancel_schedule', { id: OWN });
    expect(out).toMatch(/needsConfirmation/);
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });

  it('STAGES when the cancel would silence the chat’s LAST enabled schedule (deaf-lane risk keeps the card)', async () => {
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-1', enabled: true, promptSetBy: 'machine' }),
      scheduleView({ id: OTHER_ENABLED, sessionId: 'lane-1', enabled: false }), // terminal — does not keep the lane alive
    ]);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'cancel_schedule', { id: OWN });
    expect(out).toMatch(/needsConfirmation/);
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });

  it('STAGES for a schedule on ANOTHER chat (only the lane’s OWN schedules bypass)', async () => {
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-OTHER', enabled: true, promptSetBy: 'machine' }),
      scheduleView({ id: OTHER_ENABLED, sessionId: 'lane-OTHER', enabled: true }),
    ]);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'cancel_schedule', { id: OWN });
    expect(out).toMatch(/needsConfirmation/);
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });

  it('a USER-ANCHORED run cancelling its OWN chat\'s row executes at once (requested work on a human turn — work-tools.ts), never via this machine-only bypass', async () => {
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-1', enabled: true, promptSetBy: 'machine' }),
      scheduleView({ id: OTHER_ENABLED, sessionId: 'lane-1', enabled: true }),
    ]);
    const out = await executePlatformTool(
      makeCtx({ sessionId: 'lane-1', userTurnAt: new Date() } as any),
      'cancel_schedule', { id: OWN },
    );
    expect(JSON.parse(out)).toMatchObject({ ok: true, tool: 'cancel_schedule' });
    // The direct path executes the MODEL's own choice — the owner never saw a
    // card — so the cancel stamps initiator 'machine' (the delayed dead-lane
    // owner-decision check applies); 'owner' is the confirmed re-call's stamp.
    expect(svc.cancelSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: OWN, initiator: 'machine' }));
  });

  it('STAGES on a Dig-deeper rung of a USER-ANCHORED run (the machine self-cancel bypass is machine-only — a real user turn confirms through the normal path)', async () => {
    svc.listSchedules.mockResolvedValue([
      scheduleView({ id: OWN, sessionId: 'lane-1', enabled: true, promptSetBy: 'machine' }),
      scheduleView({ id: OTHER_ENABLED, sessionId: 'lane-1', enabled: true }),
    ]);
    const out = await executePlatformTool(
      makeCtx({ sessionId: 'lane-1', userTurnAt: new Date(), escalation: true } as any),
      'cancel_schedule', { id: OWN },
    );
    expect(out).toMatch(/needsConfirmation/);
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });
});

/* ── C) oq_9ffc4f5a + oq_dfe04aab — resume cards for a finished lane ───────── */

const STOPPED_ID = '488904f7-9999-8888-7777-666666666666';
const stoppedScheduleRow = (over: Partial<Record<string, any>> = {}) => ({
  id: STOPPED_ID, sessionId: 'lane-kernel', userId: 'u1', prompt: 'hourly kernel sweep',
  kind: 'recurring', intervalSec: 3600, nextRunAt: new Date(), enabled: false,
  runsCount: 12, maxRuns: 12, expiresAt: new Date(Date.now() + 86400_000),
  lastFiredAt: new Date(Date.now() - 7 * 3600_000), lastStatus: 'started',
  createdAt: new Date(Date.now() - 30 * 86400_000),
  cancelledBy: null, disabledAt: null,
  ...over,
});

describe('C) finished-lane suppression (kernel-lane replay)', () => {
  // Gate flip 2026-09-11 (owner: full steam): the resume card is observe-only
  // by default (stopped-schedule-alert.test.ts pins that); these replay
  // contracts cover the CARD path, so they run under the opt-in.
  beforeEach(() => { process.env.STOPPED_SCHEDULE_CARDS = '1'; });
  afterEach(() => { delete process.env.STOPPED_SCHEDULE_CARDS; });

  it('(i) files NO card when every goal the chat served is done/archived — even with other ACTIVE project goals', async () => {
    mockChatFindUnique.mockResolvedValue({ title: 'Kernel Optimization for GLM-5.3 W4A16', userId: 'u1', projectId: 'proj-kernel' });
    mockTodoFindMany.mockResolvedValue([{ goalId: '1f8c42a8' }]); // todos the lane was assigned
    mockGoalFindMany.mockImplementation(async ({ where }: any) => {
      if (where?.id?.in) return [{ status: 'done' }]; // the lane's goal 1f8c42a8 — done 2026-09-09
      return [{ id: 'g-other', title: 'Another lane’s active goal', status: 'active', blockedReason: null }];
    });

    await expect(maybeFileStoppedScheduleDecision(STOPPED_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'finished_lane' });
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('(ii) files NO card when the lane cancelled its own renewal inside its last completed run (a deliberate self-stop)', async () => {
    const finishedAt = new Date(Date.now() - 7 * 3600_000);
    const createdAt = new Date(finishedAt.getTime() - 40 * 60_000);
    mockScheduleFindUnique.mockResolvedValue(stoppedScheduleRow({
      cancelledBy: 'machine', disabledAt: new Date(finishedAt.getTime() + 2 * 60_000), // cancel landed right at run end
    }));
    mockRunFindFirst.mockResolvedValue({ createdAt, finishedAt });

    await expect(maybeFileStoppedScheduleDecision(STOPPED_ID, 'cancelled'))
      .resolves.toEqual({ filed: false, reason: 'self_stopped' });
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('a genuinely DEAD lane still files exactly one card (negative control — the alert is not gutted)', async () => {
    await expect(maybeFileStoppedScheduleDecision(STOPPED_ID, 'max_runs'))
      .resolves.toEqual({ filed: true, questionId: 'oq_new' });
    expect(mockFlagOwnerQuestion).toHaveBeenCalledTimes(1);
    expect(mockFlagOwnerQuestion.mock.calls[0][0].question).toBe('Resume the stopped schedule 488904f7 on "Kernel lane"?');
  });

  it('an old completed run LONG before the cancel does NOT count as a self-stop (the grace window is honest)', async () => {
    const disabledAt = new Date(Date.now() - 7 * 3600_000);
    mockScheduleFindUnique.mockResolvedValue(stoppedScheduleRow({ cancelledBy: 'machine', disabledAt }));
    mockRunFindFirst.mockResolvedValue({
      createdAt: new Date(disabledAt.getTime() - 26 * 3600_000),
      finishedAt: new Date(disabledAt.getTime() - 25 * 3600_000), // 25h earlier — way outside SELF_STOP_GRACE_MS
    });
    expect(SELF_STOP_GRACE_MS).toBe(15 * 60 * 1000);

    await expect(maybeFileStoppedScheduleDecision(STOPPED_ID, 'cancelled'))
      .resolves.toEqual({ filed: true, questionId: 'oq_new' });
    expect(mockFlagOwnerQuestion).toHaveBeenCalledTimes(1);
  });

  it('per-CHAT dedupe: a second stopped link of the same lane files no second card (the 19:07Z double)', async () => {
    mockHasOpenStoppedScheduleDecisionForChat.mockResolvedValue(true); // oq_9ffc4f5a already open on this chat

    await expect(maybeFileStoppedScheduleDecision(STOPPED_ID, 'max_runs'))
      .resolves.toEqual({ filed: false, reason: 'already_open' });
    expect(mockHasOpenStoppedScheduleDecisionForChat).toHaveBeenCalledWith('lane-kernel');
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });
});

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
  deleteChat: jest.fn(), createProject: jest.fn(), getProject: jest.fn(), updateProject: jest.fn(),
  deleteProject: jest.fn(), moveFolder: jest.fn(), startCodingSession: jest.fn(), scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(), cancelSchedule: jest.fn(),
  resolveOwnedChatIdPrefix: jest.fn(async (_u: string, raw: string) => raw),
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
// The sch-1 row. The default carries NO `enabled` column (the pre-WI-J shape):
// control-tools' ownedScheduleState returns null for it, so the moot
// short-circuit and the currentState enrichment stay inert for the older
// cases. The WI-J cases set a full row (enabled + nextRunAt) per test.
let scheduleRow: Record<string, unknown> = { id: 'sch-1', sessionId: 'c-own', userId: 'u1' };
const dbMock = {
  pendingConfirmation: mockConfirmations.api,
  crossModelChat: { findUnique: jest.fn(async ({ where }: any) => chats[where.id] ?? null) },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  codingSchedule: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'sch-1' ? { ...scheduleRow } : null)) },
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
const supStateSvc = { isSupervisorChat: jest.fn(async () => false), applyStateUpdate: jest.fn(async () => ({ applied: [], errors: [] })) };
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
// STOP MEANS STOP (2026-09-29): stop_run cancels queued harness continuations first.
const contGuard = { cancelQueuedContinuations: jest.fn(async (): Promise<string[]> => []) };
jest.mock('../coding/continuation-guard', () => ({ __esModule: true, ...contGuard }));
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
const sched = { resolveScheduleIdForUser: jest.fn(async (_u: string, id: string) => (id.startsWith('sch-1') ? 'sch-1' : null)) };
jest.mock('../coding/schedule.service', () => ({ __esModule: true, ...sched }));

import {
  PLATFORM_TOOL_SCHEMA, PLATFORM_MUTATING_TOOLS, executePlatformTool, TARGET_SCOPED_CONSEQUENTIAL_TOOLS,
} from './platform-tools';
import { MUTATING_TOOLS, ToolContext } from '../coding/tools';
import { CONTROL_TOOL_NAMES, agentAnswerStamp } from './control-tools';
import { PLATFORM_ASK_ONLY_TOOLS } from './platform-tool-names';

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
  autonomySvc.getChatAutonomy.mockResolvedValue({ chatId: 'sup-1', allowedTools: ALL_CONTROL, source: 'manual' });
  runState.getActiveRunForSession.mockResolvedValue({ id: 'run-9', status: 'running' });
  lock.getQuestionPendingSession.mockResolvedValue(null);
  lock.getApprovalPendingSession.mockResolvedValue(null);
  durable.loadDurablePending.mockResolvedValue(null);
  qreg.questionSession.mockReturnValue(null);
  live.isRunActive.mockReturnValue(false);
  busy.hasRemoteChatRun.mockResolvedValue(false);
  svc.setChatScheduleEnabled.mockResolvedValue({ schedule: { id: 'sch-1', nextRunAt: '2026-09-25T00:00:00Z', lastStatus: 'active' }, changed: true });
  scheduleRow = { id: 'sch-1', sessionId: 'c-own', userId: 'u1' };
});

describe('control tools registration (capability gap audit P0)', () => {
  it('all five are in the schema, PLATFORM_MUTATING_TOOLS, coding MUTATING_TOOLS and the target-scoped set', () => {
    const names = PLATFORM_TOOL_SCHEMA.map((t: any) => t.function.name);
    for (const t of CONTROL_TOOL_NAMES) {
      expect(names).toContain(t);
      expect(PLATFORM_MUTATING_TOOLS).toContain(t);
      expect(MUTATING_TOOLS.has(t)).toBe(true);
      expect(TARGET_SCOPED_CONSEQUENTIAL_TOOLS.has(t)).toBe(true);
    }
    expect(PLATFORM_ASK_ONLY_TOOLS).not.toContain('approve_request');
  });

  it('a machine run WITHOUT a grant stages a confirmation instead of executing', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-x' }), 'stop_run', { chatId: 'c-own' });
    expect(out).toContain('needsConfirmation');
    expect(lock.requestRunCancel).not.toHaveBeenCalled();
  });
});

describe('stop_run idle short-circuit (peer verification 2026-09-25: no card for an idle target)', () => {
  it('an idle coding target answers stopping:false BEFORE the consequential gate — nothing staged even with no grant', async () => {
    // No grant → the gate WOULD stage; the probe must answer first (a queued
    // Once-value would leak into the next test, so the grant is swapped and restored).
    const grant = autonomySvc.getChatAutonomy.getMockImplementation();
    autonomySvc.getChatAutonomy.mockImplementation(async () => null as any);
    runState.getActiveRunForSession.mockResolvedValueOnce(null);
    try {
      const out = await run('stop_run', { chatId: 'c-own' });
      expect(out).toMatchObject({ ok: true, tool: 'stop_run', stopping: false, ids: { chatId: 'c-own' } });
      expect(out.needsConfirmation).toBeUndefined();
      expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
    } finally {
      autonomySvc.getChatAutonomy.mockImplementation(grant as any);
    }
  });
});

describe('stop_run', () => {
  it('coding session with an active run → requestRunCancel + transcript note + stopping:true with the run id', async () => {
    const out = await run('stop_run', { chatId: 'c-own', reason: 'looping' });
    expect(out).toMatchObject({ ok: true, tool: 'stop_run', stopping: true, ids: { chatId: 'c-own', runId: 'run-9' } });
    // ALARM-CAUSE-AWARE (2026-10-20): the requester + the run it targets ride the cancel (cancel-actor:<runId>).
    expect(lock.requestRunCancel).toHaveBeenCalledWith('c-own', { runId: 'run-9', actorChatId: 'sup-1' });
    expect(dbMock.crossModelMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ chatId: 'c-own', content: expect.stringContaining('looping') }) }));
  });
  it('(stop means stop) queued continuations are cancelled BEFORE the active-run read — an idle lane reports them', async () => {
    contGuard.cancelQueuedContinuations.mockResolvedValueOnce(['c1']);
    // The idle short-circuit sees the QUEUED continuation (a queued row is active);
    // after the cancel the executor's read finds nothing left to stop.
    runState.getActiveRunForSession
      .mockResolvedValueOnce({ id: 'c1', status: 'queued' })
      .mockResolvedValueOnce(null);
    const out = await run('stop_run', { chatId: 'c-own' });
    expect(contGuard.cancelQueuedContinuations).toHaveBeenCalledWith('c-own', expect.stringContaining('stop_run'));
    expect(out).toMatchObject({ ok: true, stopping: false, cancelledContinuations: 1 });
    expect(out.message).toMatch(/1 queued continuation run\(s\) were cancelled/);
    expect(lock.requestRunCancel).not.toHaveBeenCalled();
  });
  it('coding session idle → stopping:false, nothing cancelled', async () => {
    runState.getActiveRunForSession.mockResolvedValue(null);
    const out = await run('stop_run', { chatId: 'c-own' });
    expect(out).toMatchObject({ ok: true, stopping: false });
    expect(lock.requestRunCancel).not.toHaveBeenCalled();
  });
  it('plain chat: local run → cancelRun + pending questions released; remote run → stop flag; idle → stopping:false', async () => {
    live.isRunActive.mockReturnValue(true);
    expect(await run('stop_run', { chatId: 'p-own' })).toMatchObject({ ok: true, stopping: true });
    expect(live.cancelRun).toHaveBeenCalledWith('chat:p-own');
    expect(qreg.resolvePendingForSession).toHaveBeenCalledWith('p-own');
    live.isRunActive.mockReturnValue(false); busy.hasRemoteChatRun.mockResolvedValue(true);
    expect(await run('stop_run', { chatId: 'p-own' })).toMatchObject({ ok: true, stopping: true });
    expect(busy.requestChatRunStop).toHaveBeenCalledWith('p-own');
    busy.hasRemoteChatRun.mockResolvedValue(false);
    expect(await run('stop_run', { chatId: 'p-own' })).toMatchObject({ ok: true, stopping: false });
  });
  it("another user's chat → not_found (no existence leak, nothing cancelled)", async () => {
    expect(await run('stop_run', { chatId: 'c-other' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(lock.requestRunCancel).not.toHaveBeenCalled();
  });
});

describe('answer_chat_question', () => {
  it('live wait → publishes the STAMPED answer (never the owner\'s words) and closes matching owner questions', async () => {
    lock.getQuestionPendingSession.mockResolvedValue('c-own');
    const out = await run('answer_chat_question', { chatId: 'c-own', questionId: 'q1', answer: 'yes, proceed' });
    expect(out).toMatchObject({ ok: true, delivered: 'live', ids: { chatId: 'c-own', questionId: 'q1' } });
    const delivered = String((lock.publishQuestionResolution.mock.calls as any[])[0][2]);
    expect(delivered.startsWith(agentAnswerStamp('sup-1', undefined))).toBe(true);
    expect(delivered).toContain('unattended machine run');
    expect(delivered.endsWith('yes, proceed')).toBe(true);
    expect(oq.resolveOwnerQuestionsForChatAnswer).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c-own', userId: 'u1' }));
  });
  it('a question pending on a DIFFERENT chat → wrong_chat; unknown → unknown_or_expired', async () => {
    lock.getQuestionPendingSession.mockResolvedValue('c-other');
    expect(await run('answer_chat_question', { chatId: 'c-own', questionId: 'q2', answer: 'x' })).toMatchObject({ ok: false, reason: 'wrong_chat' });
    lock.getQuestionPendingSession.mockResolvedValue(null);
    expect(await run('answer_chat_question', { chatId: 'c-own', questionId: 'q3', answer: 'x' })).toMatchObject({ ok: false, reason: 'unknown_or_expired' });
  });
  it('plain chat, run in THIS process → the local registry resolves it', async () => {
    qreg.questionSession.mockReturnValue('p-own');
    expect(await run('answer_chat_question', { chatId: 'p-own', questionId: 'q4', answer: 'go' })).toMatchObject({ ok: true, delivered: 'live' });
    expect(qreg.resolveAnswer).toHaveBeenCalledWith('q4', expect.stringContaining('go'));
  });
  it('durable fallback: pending record → recorded + published to the fingerprint\'s current id', async () => {
    durable.loadDurablePending.mockResolvedValue({ id: 'q5', kind: 'question', sessionId: 'c-own', fingerprint: 'fp', status: 'pending', detail: '', createdAt: 1 });
    durable.currentIdForFingerprint.mockResolvedValue('q5b');
    expect(await run('answer_chat_question', { chatId: 'c-own', questionId: 'q5', answer: 'ok' })).toMatchObject({ ok: true, delivered: 'recorded', ids: { questionId: 'q5b' } });
    expect(durable.markDurableResolved).toHaveBeenCalledWith('question', 'q5', 'answered', expect.any(String));
    expect(lock.publishQuestionResolution).toHaveBeenCalledWith('c-own', 'q5b', expect.any(String));
  });
});

describe('approve_request', () => {
  it("machine run may NOT decide an ask-only (destructive) request or one whose tool is unreadable → human_only", async () => {
    durable.loadDurablePending.mockResolvedValue({ id: 'a1', kind: 'approval', sessionId: 'c-own', fingerprint: null, status: 'pending', detail: 'Allow delete_project?', tool: 'delete_project', createdAt: 1 });
    lock.getApprovalPendingSession.mockResolvedValue('c-own');
    expect(await run('approve_request', { chatId: 'c-own', approvalId: 'a1', decision: 'allow' })).toMatchObject({ ok: false, reason: 'human_only', pendingTool: 'delete_project' });
    durable.loadDurablePending.mockResolvedValue(null); // tool unreadable
    expect(await run('approve_request', { chatId: 'c-own', approvalId: 'a2', decision: 'allow' })).toMatchObject({ ok: false, reason: 'human_only' });
    expect(lock.publishApprovalResolution).not.toHaveBeenCalled();
  });
  it('user-anchored run may decide a destructive request (it acts as the user)', async () => {
    durable.loadDurablePending.mockResolvedValue({ id: 'a1', kind: 'approval', sessionId: 'c-own', fingerprint: null, status: 'pending', detail: '', tool: 'delete_project', createdAt: 1 });
    lock.getApprovalPendingSession.mockResolvedValue('c-own');
    const out = await run('approve_request', { chatId: 'c-own', approvalId: 'a1', decision: 'deny' }, makeCtx({ userTurnAt: new Date() }));
    expect(out).toMatchObject({ ok: true, decision: 'deny', delivered: 'live' });
    expect(lock.publishApprovalResolution).toHaveBeenCalledWith('c-own', 'a1', 'deny');
  });
  it('machine run allows a non-destructive tool request; "always" is refused', async () => {
    durable.loadDurablePending.mockResolvedValue({ id: 'a3', kind: 'approval', sessionId: 'c-own', fingerprint: null, status: 'pending', detail: '', tool: 'run_command', createdAt: 1 });
    lock.getApprovalPendingSession.mockResolvedValue('c-own');
    expect(await run('approve_request', { chatId: 'c-own', approvalId: 'a3', decision: 'allow' })).toMatchObject({ ok: true, decision: 'allow', pendingTool: 'run_command' });
    expect(await run('approve_request', { chatId: 'c-own', approvalId: 'a3', decision: 'always' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('pause_schedule / resume_schedule', () => {
  it('pause → setChatScheduleEnabled(enabled:false) on the schedule\'s chat; resume → enabled:true; prefix ids resolve', async () => {
    expect(await run('pause_schedule', { id: 'sch-1' })).toMatchObject({ ok: true, enabled: false, changed: true, ids: { scheduleId: 'sch-1', chatId: 'c-own' } });
    expect(svc.setChatScheduleEnabled).toHaveBeenCalledWith({ userId: 'u1', chatId: 'c-own', scheduleId: 'sch-1', enabled: false, actorChatId: 'sup-1' }); // audit 2026-10-06 T4-2
    expect(await run('resume_schedule', { id: 'sch-1xxx' })).toMatchObject({ ok: true, enabled: true });
    expect(svc.setChatScheduleEnabled).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });
  it('a service refusal (409) is relayed honestly; unknown id → not_found', async () => {
    const err: any = new Error('Schedule already completed its runs — it cannot resume; create a new schedule instead.'); err.statusCode = 409;
    svc.setChatScheduleEnabled.mockRejectedValue(err);
    expect(await run('resume_schedule', { id: 'sch-1' })).toMatchObject({ ok: false, reason: 'refused', message: expect.stringContaining('cannot resume') });
    expect(await run('pause_schedule', { id: 'nope' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('staged control-tool cards say what is still true (WI-J, 2026-09-25)', () => {
  const NEXT = new Date('2026-09-26T10:00:00.000Z');
  const enabledRow = () => { scheduleRow = { id: 'sch-1', sessionId: 'c-own', userId: 'u1', enabled: true, nextRunAt: NEXT, lastStatus: 'started' }; };
  const pausedRow = () => { scheduleRow = { id: 'sch-1', sessionId: 'c-own', userId: 'u1', enabled: false, nextRunAt: NEXT, lastStatus: 'started' }; };

  it('staging pause_schedule on an ENABLED schedule → needsConfirmation with currentState {enabled:true, nextRunAt} and a "stays ENABLED" summary; the note leads the instructions; nothing executed', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    enabledRow();
    const out = await run('pause_schedule', { id: 'sch-1' }, makeCtx({ sessionId: 'lane-x' }));
    expect(out).toMatchObject({ ok: false, needsConfirmation: true, currentState: { scheduleId: 'sch-1', chatId: 'c-own', enabled: true, nextRunAt: NEXT.toISOString(), lastStatus: 'started' } });
    expect(out.summary).toContain('stays ENABLED');
    expect(out.summary).toContain('sch-1');
    expect(out.instructions.startsWith('Nothing has changed yet: schedule sch-1 remains ENABLED and will fire at 2026-09-26T10:00:00.000Z until the card is confirmed.')).toBe(true);
    expect(svc.setChatScheduleEnabled).not.toHaveBeenCalled();
    // The card the owner sees carries the same honest summary.
    const cards = mockConfirmations.rows;
    expect(cards).toHaveLength(1);
    expect(cards[0].summary).toContain('stays ENABLED');
  });

  it('staging resume_schedule on a PAUSED schedule → currentState.enabled:false and a "stays PAUSED" note', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    pausedRow();
    const out = await run('resume_schedule', { id: 'sch-1' }, makeCtx({ sessionId: 'lane-x' }));
    expect(out).toMatchObject({ ok: false, needsConfirmation: true, currentState: { enabled: false } });
    expect(out.summary).toContain('stays PAUSED');
    expect(out.instructions).toContain('remains PAUSED (enabled:false)');
  });

  it('pause_schedule on an ALREADY-PAUSED schedule answers the executor\'s no-op envelope BEFORE the gate — no card, no service call, even without a grant', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    pausedRow();
    const out = await run('pause_schedule', { id: 'sch-1' }, makeCtx({ sessionId: 'lane-x' }));
    expect(out).toMatchObject({ ok: true, tool: 'pause_schedule', changed: false, enabled: false, ids: { scheduleId: 'sch-1' }, chatId: 'c-own' });
    // A no-op never names the lane in ids (review 2026-09-25): pause_schedule
    // is a receipt tool and follow-through counts any ok receipt whose ids
    // carry the lane id as "acted toward the lane".
    expect(out.ids.chatId).toBeUndefined();
    expect(out.needsConfirmation).toBeUndefined();
    expect(out.message).toContain('already paused');
    expect(mockConfirmations.rows).toHaveLength(0);
    expect(svc.setChatScheduleEnabled).not.toHaveBeenCalled();
    // resume on an already-enabled row: the same moot answer, naming the next firing.
    enabledRow();
    const r = await run('resume_schedule', { id: 'sch-1' }, makeCtx({ sessionId: 'lane-x' }));
    expect(r).toMatchObject({ ok: true, changed: false, enabled: true, nextRunAt: NEXT.toISOString(), ids: { scheduleId: 'sch-1' } });
    expect(r.ids.chatId).toBeUndefined();
    expect(mockConfirmations.rows).toHaveLength(0);
  });

  it('the EXECUTED path follows the same rule: changed:true names the lane in ids, changed:false does not', async () => {
    enabledRow();
    const changed = await run('pause_schedule', { id: 'sch-1' });
    expect(changed).toMatchObject({ ok: true, changed: true, ids: { scheduleId: 'sch-1', chatId: 'c-own' } });
    svc.setChatScheduleEnabled.mockResolvedValue({ schedule: { id: 'sch-1', nextRunAt: '2026-09-25T00:00:00Z', lastStatus: 'active' }, changed: false });
    const noop = await run('pause_schedule', { id: 'sch-1' });
    expect(noop).toMatchObject({ ok: true, changed: false, ids: { scheduleId: 'sch-1' }, chatId: 'c-own' });
    expect(noop.ids.chatId).toBeUndefined();
  });

  it('a confirmationId re-call is never short-circuited (the confirm path must consume its card) and a granted caller still executes a real toggle', async () => {
    enabledRow();
    // Granted (default beforeEach grant) + state differs → executes normally.
    expect(await run('pause_schedule', { id: 'sch-1' })).toMatchObject({ ok: true, changed: true, enabled: false });
    expect(svc.setChatScheduleEnabled).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    // Granted + already enabled + confirmationId present → the gate path (which
    // answers the unknown-confirmation prose), not the moot answer.
    const raw = await executePlatformTool(makeCtx(), 'resume_schedule', { id: 'sch-1', confirmationId: 'cf_unknown' });
    expect(raw).toContain('Confirmation "cf_unknown" is unknown');
    expect(raw).not.toContain('already enabled');
  });

  it('staging stop_run on an ACTIVE coding target carries currentState {running:true, runId} and the "STILL EXECUTING" note', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    const out = await run('stop_run', { chatId: 'c-own', reason: 'looping' }, makeCtx({ sessionId: 'lane-x' }));
    expect(out).toMatchObject({ ok: false, needsConfirmation: true, currentState: { chatId: 'c-own', running: true, runId: 'run-9' } });
    expect(out.summary).toContain('keeps running until this is confirmed');
    expect(out.instructions).toContain('is STILL EXECUTING until the card is confirmed');
    expect(lock.requestRunCancel).not.toHaveBeenCalled();
  });

  it('stop_run race: the target goes idle between the idle short-circuit and the gate → currentState.running:false with the "shows no active run right now" note', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    runState.getActiveRunForSession
      .mockResolvedValueOnce({ id: 'run-9', status: 'running' }) // stopRunIdleShortCircuit: active → no short-circuit
      .mockResolvedValueOnce(null);                             // describeControlTargetState: finished meanwhile
    const out = await run('stop_run', { chatId: 'c-own' }, makeCtx({ sessionId: 'lane-x' }));
    expect(out).toMatchObject({ ok: false, needsConfirmation: true, currentState: { chatId: 'c-own', running: false } });
    expect(out.currentState.runId).toBeUndefined();
    expect(out.instructions.startsWith('Nothing has changed yet: chat c-own shows no active run right now — confirming this card will stop whatever is running at that moment, if anything.')).toBe(true);
    expect(lock.requestRunCancel).not.toHaveBeenCalled();
  });

  it('an unreadable target (unknown id) degrades to the pre-change envelope — no currentState, still staged', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    const out = await run('pause_schedule', { id: 'zzzzzzzz' }, makeCtx({ sessionId: 'lane-x' }));
    expect(out).toMatchObject({ ok: false, needsConfirmation: true });
    expect(out.currentState).toBeUndefined();
  });
});

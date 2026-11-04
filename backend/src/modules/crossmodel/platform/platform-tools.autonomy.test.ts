/**
 * Fleet supervisor (slice A) — the autonomy bypass in the consequential-tool
 * gate (platform-tools.ts), with the service layer + autonomy.service mocked.
 *
 * Pins:
 *   - a MACHINE-triggered run (no ctx.userTurnAt) executes a consequential tool
 *     WITHOUT a confirmation when its chat's ChatAutonomy allowlist names it
 *     (and writes the autonomous-execution audit);
 *   - a USER-ANCHORED run with a matching grant ALSO executes without a
 *     confirmation (owner directive 2026-08-07, feedback f71b97d2/a631cfb3:
 *     an explicit owner grant means "this chat may do these things
 *     autonomously" in every run type);
 *   - without a matching grant the SAME call falls through to the existing
 *     register-pending flow (needsConfirmation JSON) unchanged — in BOTH run
 *     types;
 *   - set_chat_autonomy is NEVER autonomously executable (explicit bypass
 *     exclusion in every run type — nothing can escalate a chat's autonomy
 *     except a new-user-message-anchored confirmation) — EXCEPT an
 *     authority-non-widening SELF-request (ticket 9341e862), pinned in the
 *     'subset auto-approve' describe at the bottom of this file.
 *
 * Scaffolding mirrors platform-tools.test.ts (do not modify that file).
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
  updateSchedule: jest.fn(),
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

// autonomy.service under the gate — fully mocked (the real one pulls prisma +
// crossmodel.service chains). AUTONOMY_GRANTABLE_TOOLS is read at MODULE SCOPE
// by the set_chat_autonomy schema enum — mirror it exactly.
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  AUTONOMY_SOURCE_MANUAL: 'manual',
  AUTONOMY_SOURCE_AGENT_MODE: 'agent_mode_auto',
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
  // G19 target-scope helper (bounded auto-mode bypass) — the gate consults it
  // for chat-TARGETED tools; unit-level truth tables live in
  // platform-tools.g19-target-scope.test.ts (real autonomy.service).
  autoModeTargetAllows: jest.fn(async () => true),
  // 9341e862 subset self-grant verdict — default 'beyond' = the pre-change
  // behavior (every set_chat_autonomy stages); per-test overrides pin the new
  // branches. Re-pinned in beforeEach (clearAllMocks keeps implementations).
  selfGrantSubsetVerdict: jest.fn(async (): Promise<any> => ({ kind: 'beyond' })),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// Loop metrics (gate flip 2026-09-11): the gate records `machine_schedule_mutation`
// on every machine own-scope schedule execution and `confirmation_staged` on
// every staging — platform-tools reaches the module via DYNAMIC import, so a
// module mock captures both. Real kinds table, spied recorder.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// config/database for the DB-persisted confirmation registry (pending-confirmations.ts):
// the registry lazy-imports it at CALL time; the gate tests below run it for real
// against this in-memory table.
const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { pendingConfirmation: mockConfirmations.api } }));

import { PLATFORM_TOOL_SCHEMA, executePlatformTool } from './platform-tools';
import { MUTATING_TOOLS, ToolContext } from '../coding/tools';
import { pendingConfirmationCount } from './pending-confirmations';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  autonomySvc.getChatAutonomy.mockResolvedValue(null); // default: no grant
  autonomySvc.autoModeTargetAllows.mockResolvedValue(true); // default: target in lane scope
  autonomySvc.selfGrantSubsetVerdict.mockResolvedValue({ kind: 'beyond' }); // default: set_chat_autonomy stages (pre-9341e862 behavior)
});

describe('set_chat_autonomy registration', () => {
  it('is in the platform tool schema and joins MUTATING_TOOLS', () => {
    const entry = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'set_chat_autonomy');
    expect(entry).toBeDefined();
    expect(entry!.function.parameters.required).toEqual(['chatId', 'allowedTools']);
    expect(MUTATING_TOOLS.has('set_chat_autonomy')).toBe(true);
  });
});

describe('autonomy bypass (machine-triggered runs)', () => {
  it('EXECUTES a consequential tool without a confirmation when the chat grant names it', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48 });
    svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'c1', mode: 'single_thinking' });
    const ctx = makeCtx(); // NO userTurnAt — schedule firing / hook wake
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'hello from the supervisor' });
    expect(out).toMatch(/queued/i);
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.sendChatMessage).toHaveBeenCalledWith({
      userId: 'u1', chatId: 'c1', content: 'hello from the supervisor',
      // Fleet origin marking: an autonomy-bypassed machine send is AGENT traffic —
      // and NO userTurnAt key (the machine run carries no user anchor).
      origin: { kind: 'agent', sourceChatId: 'sess-1' },
    });
    expect(autonomySvc.getChatAutonomy).toHaveBeenCalledWith('sess-1');
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith({ chatId: 'sess-1', tool: 'send_chat_message', userId: 'u1' });
    expect(await pendingConfirmationCount()).toBe(0); // bypass registered no pending
  });

  it('falls through to the pending flow when the chat has NO grant', async () => {
    const ctx = makeCtx(); // machine-triggered, no grant
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'hello' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
    expect(autonomySvc.auditAutonomousExecution).not.toHaveBeenCalled();
  });

  it('falls through when the grant does NOT name the called tool', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['schedule_message'], scheduleCap: 48 });
    const ctx = makeCtx();
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'hello' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
  });

  it('falls through (fail-closed) when the autonomy lookup errors', async () => {
    autonomySvc.getChatAutonomy.mockRejectedValue(new Error('db down'));
    const ctx = makeCtx();
    // send_chat_message: NOT one of the machine schedule self-management tools
    // (gate flip 2026-09-11), so a failed grant lookup still lands on staging.
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'hello' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
    // …and every staging is now counted (confirmation_staged).
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'confirmation_staged', sessionId: 'sess-1',
      meta: expect.objectContaining({ tool: 'send_chat_message', machine: true }),
    }));
  });

  // Agent-mode auto-grant (owner 2026-09-07): flipping a coding chat to Auto
  // MATERIALIZES a ChatAutonomy row (source 'agent_mode_auto') — the gate's
  // stored-grant path honors it, so a scheduled/hook-triggered run in an
  // auto-mode chat executes consequential tools with NO confirmation card.
  // Since G19 (2026-09-09) the row carries the SAME lane-scope bound as the
  // mode waiver it materializes: chat-TARGETED tools execute only when the
  // target is the lane's own chat or a first-degree child. The default run cap
  // (48) rides the row and stays enforced by schedule.service/hooks.service.
  it('a MACHINE-triggered run executes without a card on an AUTO-GRANTED row (source agent_mode_auto) when the target is in lane scope', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({
      allowedTools: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'],
      scheduleCap: 48,
      source: 'agent_mode_auto',
    });
    autonomySvc.autoModeTargetAllows.mockResolvedValue(true); // c1 = the lane's own child
    svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'c1', mode: 'single_thinking' });
    // Worker-subagent ctx (allowedTools set): the ctx-level db747817 bypass does
    // NOT apply, so this exercises the STORED-grant path end-to-end — before the
    // auto-grant existed, this exact call staged a confirmation card.
    const ctx = makeCtx({ agentSurface: 'coding', allowedTools: new Set(['send_chat_message']) } as any); // no userTurnAt — schedule firing
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'scheduled follow-up' });
    expect(out).toMatch(/queued/i);
    expect(out).not.toMatch(/needsConfirmation/);
    expect(autonomySvc.getChatAutonomy).toHaveBeenCalledWith('sess-1');
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith({ chatId: 'sess-1', tool: 'send_chat_message', userId: 'u1' });
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('G19: an AUTO-GRANTED row (agent_mode_auto) does NOT cover an out-of-lane-scope target — the call stages a confirmation', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({
      allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'agent_mode_auto',
    });
    autonomySvc.autoModeTargetAllows.mockResolvedValue(false); // unrelated owned chat / supervisor
    const ctx = makeCtx({ agentSurface: 'coding', allowedTools: new Set(['send_chat_message']) } as any);
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'unrelated-1', content: 'injected steer attempt' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
    expect(autonomySvc.auditAutonomousExecution).not.toHaveBeenCalled();
  });

  it('G19: a MANUAL grant keeps its full cross-chat reach (the supervisor steering pattern) — the scope helper is never consulted', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({
      allowedTools: ['send_chat_message'], scheduleCap: 120, source: 'manual',
    });
    svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'w2', mode: 'single_thinking' });
    const ctx = makeCtx(); // machine-triggered chat-surface run (fleet supervisor wake)
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'w2', content: 'Status on your goal?' });
    expect(out).toMatch(/queued/i);
    expect(out).not.toMatch(/needsConfirmation/);
    expect(autonomySvc.autoModeTargetAllows).not.toHaveBeenCalled();
  });

  it('a real USER turn WITH a matching grant ALSO bypasses the confirmation (owner directive 2026-08-07)', async () => {
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48 });
    svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'c1', mode: 'single_thinking' });
    const ctx = makeCtx({ userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'hello' });
    expect(out).toMatch(/queued/i);
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', chatId: 'c1', content: 'hello' }));
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith({ chatId: 'sess-1', tool: 'send_chat_message', userId: 'u1' });
    expect(await pendingConfirmationCount()).toBe(0); // bypass registered no pending
  });

  it('a real USER turn WITHOUT a grant keeps the confirmation protocol (unchanged)', async () => {
    const ctx = makeCtx({ userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'hello' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
    // The confirmation re-call from a NEW user turn still executes (existing protocol intact).
    svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'c1', mode: 'single_thinking' });
    const ok = await executePlatformTool(
      makeCtx({ userTurnAt: new Date(Date.now() + 60_000) }),
      'send_chat_message',
      { chatId: 'c1', content: 'hello', confirmationId: JSON.parse(out).confirmationId },
    );
    expect(ok).toMatch(/queued/i);
    expect(svc.sendChatMessage).toHaveBeenCalledTimes(1);
  });
});

// ── Gate flip 2026-09-11 (owner: full steam): machine schedule self-management
// (schedule_message / update_schedule / cancel_schedule) on an OWN-SCOPE target
// EXECUTES on every surface — chat lanes included — instead of staging a card
// nobody can answer on a machine run. Scope = autonomy.service
// autoModeTargetAllows (mocked here; truth tables in the g19 suite): foreign
// owner + send_to_instance still refuse. Opt-in MACHINE_SCHEDULE_CONFIRM_GATE=1
// restores the staging.
describe('machine schedule self-management (gate flip 2026-09-11)', () => {
  afterEach(() => {
    delete process.env.MACHINE_SCHEDULE_CONFIRM_GATE;
  });

  it('a CHAT-surface machine run with NO grant cancels an own-scope schedule: executes + audit note + machine_schedule_mutation metric', async () => {
    svc.cancelSchedule.mockResolvedValue(true);
    const ctx = makeCtx({ agentSurface: 'chat' } as any); // fleet-supervisor wake — no userTurnAt, no grant
    const out = await executePlatformTool(ctx, 'cancel_schedule', { id: '8accf96b' });
    expect(out).not.toMatch(/needsConfirmation/);
    expect(out).toContain('Cancelled schedule 8accf96b');
    expect(svc.cancelSchedule).toHaveBeenCalledWith({ userId: 'u1', id: '8accf96b', initiator: 'machine', actorChatId: 'sess-1' }); // audit 2026-10-06 T4-2
    expect(autonomySvc.autoModeTargetAllows).toHaveBeenCalledWith({
      callerChatId: 'sess-1', userId: 'u1', tool: 'cancel_schedule', args: { id: '8accf96b' },
    });
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'sess-1', tool: 'cancel_schedule', note: expect.stringContaining('machine schedule self-management'),
    }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'machine_schedule_mutation', sessionId: 'sess-1',
      meta: expect.objectContaining({ tool: 'cancel_schedule', surface: 'chat' }),
    }));
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('schedule_message (no chatId → own chat) and update_schedule from a sparse machine ctx execute too', async () => {
    svc.scheduleChatRun.mockResolvedValue({
      id: 'sch-new', sessionId: 'sess-1', kind: 'recurring', intervalSec: 3600,
      nextRunAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    svc.updateSchedule.mockResolvedValue({ ok: true, schedule: { id: 'sch-1', sessionId: 'sess-1', intervalSec: 1800, nextRunAt: 'soon' } });
    svc.listSchedules.mockResolvedValue([]);
    const a = await executePlatformTool(makeCtx(), 'schedule_message', { prompt: 'nightly check', intervalMinutes: 60 });
    expect(a).not.toMatch(/needsConfirmation/);
    expect(svc.scheduleChatRun).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'sess-1' }));
    const b = await executePlatformTool(makeCtx(), 'update_schedule', { id: 'sch-1', intervalMinutes: 30 });
    expect(b).not.toMatch(/needsConfirmation/);
    expect(svc.updateSchedule).toHaveBeenCalled();
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('an OUT-OF-SCOPE target (foreign owner — autoModeTargetAllows false) still STAGES: the trust boundary is unchanged', async () => {
    autonomySvc.autoModeTargetAllows.mockResolvedValue(false);
    const out = await executePlatformTool(makeCtx(), 'cancel_schedule', { id: 'sch-foreign' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
    expect(autonomySvc.auditAutonomousExecution).not.toHaveBeenCalled();
  });

  it('a scope-helper failure fails CLOSED into staging', async () => {
    autonomySvc.autoModeTargetAllows.mockRejectedValue(new Error('db down'));
    const out = await executePlatformTool(makeCtx(), 'cancel_schedule', { id: 'sch-1' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });

  it('send_chat_message is NOT covered (chat-surface machine sends without a grant keep staging)', async () => {
    const out = await executePlatformTool(makeCtx(), 'send_chat_message', { chatId: 'c1', content: 'hi' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
  });

  it('opt-in MACHINE_SCHEDULE_CONFIRM_GATE=1 restores the staging (and counts it)', async () => {
    process.env.MACHINE_SCHEDULE_CONFIRM_GATE = '1';
    svc.listSchedules.mockResolvedValue([]); // the 3ce5f6d0 self-cancel exception needs a resolvable machine-authored row — none here
    const out = await executePlatformTool(makeCtx(), 'cancel_schedule', { id: 'sch-1' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'machine_schedule_mutation' }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'confirmation_staged', meta: expect.objectContaining({ tool: 'cancel_schedule', machine: true }),
    }));
  });

  it('a USER-anchored run without a grant is untouched by the flip (still stages — the user confirms through the normal path)', async () => {
    const out = await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'cancel_schedule', { id: 'sch-1' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.cancelSchedule).not.toHaveBeenCalled();
  });
});

describe('set_chat_autonomy is NEVER autonomously executable', () => {
  it('a machine-triggered run gets the pending flow even if a (bogus) grant names it', async () => {
    // Defensive: the gate excludes set_chat_autonomy from the bypass EXPLICITLY,
    // so even a row naming it (impossible via setChatAutonomy validation) does
    // not let a machine-triggered run grant autonomy.
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['set_chat_autonomy'], scheduleCap: 48 });
    const ctx = makeCtx(); // no userTurnAt
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'c2', allowedTools: ['send_chat_message'] });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled();
    expect(autonomySvc.auditAutonomousExecution).not.toHaveBeenCalled();
  });

  it('a machine-triggered run can never CONFIRM a set_chat_autonomy pending (no_user_turn)', async () => {
    const ctx = makeCtx();
    const args = { chatId: 'c2', allowedTools: ['send_chat_message'] };
    const first = await executePlatformTool(ctx, 'set_chat_autonomy', args);
    const { confirmationId } = JSON.parse(first);
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', { ...args, confirmationId });
    expect(out).toMatch(/not started by a real user message/);
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled();
  });

  it('executes from a NEW real user turn and returns the grant summary', async () => {
    const ctx = makeCtx({ userTurnAt: new Date() });
    const args = { chatId: 'c2', allowedTools: ['send_chat_message', 'schedule_message'], scheduleCap: 96 };
    const first = await executePlatformTool(ctx, 'set_chat_autonomy', args);
    const reg = JSON.parse(first);
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect(reg.summary).toMatch(/Grant chat c2 autonomy/);

    autonomySvc.setChatAutonomy.mockResolvedValue({ granted: true, chatId: 'c2', allowedTools: args.allowedTools, scheduleCap: 96 });
    const ok = await executePlatformTool(
      makeCtx({ userTurnAt: new Date(Date.now() + 60_000) }),
      'set_chat_autonomy',
      { ...args, confirmationId: reg.confirmationId },
    );
    expect(autonomySvc.setChatAutonomy).toHaveBeenCalledWith({
      userId: 'u1', chatId: 'c2', allowedTools: ['send_chat_message', 'schedule_message'], scheduleCap: 96,
    });
    expect(ok).toMatch(/Autonomy granted for chat c2/);
    expect(ok).toMatch(/send_chat_message, schedule_message/);
    expect(ok).toMatch(/96\/day/);
  });

  it('an empty allowedTools array REVOKES and says so', async () => {
    const ctx = makeCtx({ userTurnAt: new Date() });
    const args = { chatId: 'c2', allowedTools: [] as string[] };
    const first = await executePlatformTool(ctx, 'set_chat_autonomy', args);
    const reg = JSON.parse(first);
    expect(reg.summary).toMatch(/Revoke ALL autonomy/);

    autonomySvc.setChatAutonomy.mockResolvedValue({ granted: false, chatId: 'c2', allowedTools: [], scheduleCap: null });
    const ok = await executePlatformTool(
      makeCtx({ userTurnAt: new Date(Date.now() + 60_000) }),
      'set_chat_autonomy',
      { ...args, confirmationId: reg.confirmationId },
    );
    expect(autonomySvc.setChatAutonomy).toHaveBeenCalledWith({ userId: 'u1', chatId: 'c2', allowedTools: [] });
    expect(ok).toMatch(/Autonomy revoked for chat c2/);
  });
});


// ── Owner decision 2026-08-22 (ticket db747817): AUTO-mode CODING sessions run
// fully autonomously — consequential platform tools execute with no grant and
// no confirmation. Scope pins: explicit agentSurface 'coding' only (sparse ctx
// fails CLOSED), orchestrator only (workers carry allowedTools), plan/ask modes
// still stage, chat surface still stages, set_chat_autonomy NEVER bypasses.
// G19 (remediation 2026-09-09) bounds the waiver to THE LANE'S OWN WORK: for
// chat-TARGETED tools the target must be the lane's own chat or a first-degree
// child (autonomy.service autoModeTargetAllows — mocked here; real truth tables
// in platform-tools.g19-target-scope.test.ts). Out-of-scope targets stage.
describe('auto-mode coding sessions: full autonomy for the lane\'s own work (db747817 + G19)', () => {
  it("EXECUTES with no grant when agentSurface='coding' and permissionMode='auto' and the target is in lane scope", async () => {
    svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'c1', mode: 'single_thinking' });
    const ctx = makeCtx({ agentSurface: 'coding' } as any); // no grant mocked (default null)
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'lane follow-up message' });
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.sendChatMessage).toHaveBeenCalled();
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith({ chatId: 'sess-1', tool: 'send_chat_message', userId: 'u1' });
    expect(await pendingConfirmationCount()).toBe(0);
    // the grant lookup is skipped entirely — the mode itself is the authority
    expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
    // …but the G19 target scope WAS consulted with the real call identity
    expect(autonomySvc.autoModeTargetAllows).toHaveBeenCalledWith({
      callerChatId: 'sess-1', userId: 'u1', tool: 'send_chat_message',
      args: { chatId: 'c1', content: 'lane follow-up message' },
    });
  });

  it('G19: an OUT-OF-SCOPE target (unrelated owned chat / supervisor) stages a confirmation instead of executing', async () => {
    autonomySvc.autoModeTargetAllows.mockResolvedValue(false);
    const ctx = makeCtx({ agentSurface: 'coding' } as any);
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'sup-1', content: 'injected: reprioritize everything' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
    // The stored-grant path was still consulted (a MANUAL grant could cover it).
    expect(autonomySvc.getChatAutonomy).toHaveBeenCalledWith('sess-1');
  });

  it('G19: a NON-chat-targeted tool (start_coding_session) keeps the unbounded waiver — the scope helper is never consulted', async () => {
    svc.startCodingSession.mockResolvedValue({
      id: 'sess-new', title: 'Child task', projectId: 'p1',
      branch: 'digby/session-new', baseBranch: 'main', model: 'glm-5.3', permissionMode: 'auto',
    });
    const ctx = makeCtx({ agentSurface: 'coding' } as any);
    const out = await executePlatformTool(ctx, 'start_coding_session', { projectId: 'p1', title: 'Child task' });
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.startCodingSession).toHaveBeenCalled();
    expect(autonomySvc.autoModeTargetAllows).not.toHaveBeenCalled();
  });

  it('chat surface still stages (hardcoded auto must not waive the user-turn anchor)', async () => {
    const ctx = makeCtx({ agentSurface: 'chat' } as any);
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'x' });
    expect(out).toMatch(/needsConfirmation/);
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
  });

  it('a sparse ctx without agentSurface fails CLOSED to the confirm path', async () => {
    const ctx = makeCtx(); // no agentSurface
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'x' });
    expect(out).toMatch(/needsConfirmation/);
  });

  it('plan-mode coding sessions still stage', async () => {
    const ctx = makeCtx({ agentSurface: 'coding', permissionMode: 'plan' } as any);
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'x' });
    expect(out).toMatch(/needsConfirmation/);
  });

  it('worker subagents (allowedTools set) never get the bypass', async () => {
    const ctx = makeCtx({ agentSurface: 'coding', allowedTools: new Set(['send_chat_message']) } as any);
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'c1', content: 'x' });
    expect(out).toMatch(/needsConfirmation/);
  });

  it('a set_chat_autonomy self-request BEYOND the mode template still stages, even in an auto coding session', async () => {
    // Helper default: 'beyond' (a cap raise to 96 is a real widening — 9341e862 keeps the card).
    const ctx = makeCtx({ agentSurface: 'coding' } as any);
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'sess-1', allowedTools: ['send_chat_message'], scheduleCap: 96 });
    expect(out).toMatch(/needsConfirmation/);
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled();
  });
});

describe('set_chat_autonomy subset auto-approve (ticket 9341e862)', () => {
  it('an auto-mode coding self-request WITHIN the template returns the already-covered no-op — no card, no write', async () => {
    autonomySvc.selfGrantSubsetVerdict.mockResolvedValue({ kind: 'mode_covered', effectiveCap: 48 });
    const ctx = makeCtx({ agentSurface: 'coding' } as any);
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', {
      chatId: 'sess-1',
      allowedTools: ['send_chat_message', 'schedule_message', 'cancel_schedule', 'update_schedule'],
      scheduleCap: 48,
    });
    expect(out).toMatch(/Autonomy ALREADY ACTIVE for chat sess-1/);
    expect(out).not.toMatch(/needsConfirmation/);
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled(); // nothing written — the row would detach from the Agent-mode lifecycle
    expect(autonomySvc.selfGrantSubsetVerdict).toHaveBeenCalledWith(expect.objectContaining({ callerChatId: 'sess-1', modeAuthority: true }));
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'sess-1', tool: 'set_chat_autonomy', userId: 'u1', note: expect.stringMatching(/9341e862/),
    }));
    await expect(pendingConfirmationCount()).resolves.toBe(0);
  });

  it('modeAuthority is FALSE for a chat-surface run (the helper judges from the stored grant there)', async () => {
    const ctx = makeCtx({ agentSurface: 'chat' } as any);
    await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'sess-1', allowedTools: ['send_chat_message'] });
    expect(autonomySvc.selfGrantSubsetVerdict).toHaveBeenCalledWith(expect.objectContaining({ callerChatId: 'sess-1', modeAuthority: false }));
  });

  it('modeAuthority is FALSE for a worker subagent (allowedTools set), even on the coding surface', async () => {
    const ctx = makeCtx({ agentSurface: 'coding', allowedTools: new Set(['send_chat_message']) } as any);
    await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'sess-1', allowedTools: ['send_chat_message'] });
    expect(autonomySvc.selfGrantSubsetVerdict).toHaveBeenCalledWith(expect.objectContaining({ modeAuthority: false }));
  });

  it('a within_grant self-request EXECUTES via the dispatcher in a MACHINE run — no card', async () => {
    autonomySvc.selfGrantSubsetVerdict.mockResolvedValue({ kind: 'within_grant' });
    autonomySvc.setChatAutonomy.mockResolvedValue({ granted: true, chatId: 'sess-1', allowedTools: ['send_chat_message'], scheduleCap: 48 });
    const ctx = makeCtx(); // no userTurnAt — schedule firing
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'sess-1', allowedTools: ['send_chat_message'] });
    expect(autonomySvc.setChatAutonomy).toHaveBeenCalledWith({ userId: 'u1', chatId: 'sess-1', allowedTools: ['send_chat_message'] });
    expect(out).toMatch(/Autonomy granted for chat sess-1/);
    expect(out).not.toMatch(/needsConfirmation/);
    expect(autonomySvc.auditAutonomousExecution).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'sess-1', tool: 'set_chat_autonomy', note: expect.stringMatching(/9341e862/),
    }));
    await expect(pendingConfirmationCount()).resolves.toBe(0);
  });

  it('a within_grant self-request also EXECUTES card-free in a USER-ANCHORED run (self-revoke)', async () => {
    autonomySvc.selfGrantSubsetVerdict.mockResolvedValue({ kind: 'within_grant' });
    autonomySvc.setChatAutonomy.mockResolvedValue({ granted: false, chatId: 'sess-1', allowedTools: [], scheduleCap: null });
    const ctx = makeCtx({ userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'sess-1', allowedTools: [] });
    expect(autonomySvc.setChatAutonomy).toHaveBeenCalledWith({ userId: 'u1', chatId: 'sess-1', allowedTools: [] });
    expect(out).toMatch(/Autonomy revoked for chat sess-1/);
    await expect(pendingConfirmationCount()).resolves.toBe(0);
  });

  it('a helper that resolves garbage/undefined falls through to staging (fail-closed for older partial mocks)', async () => {
    autonomySvc.selfGrantSubsetVerdict.mockResolvedValue(undefined as any);
    const ctx = makeCtx({ agentSurface: 'coding' } as any);
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'sess-1', allowedTools: ['send_chat_message'] });
    expect(out).toMatch(/needsConfirmation/);
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled();
  });

  it('a helper that THROWS falls through to staging (fail-closed on any uncertainty)', async () => {
    autonomySvc.selfGrantSubsetVerdict.mockRejectedValue(new Error('db down'));
    const ctx = makeCtx({ agentSurface: 'coding' } as any);
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: 'sess-1', allowedTools: ['send_chat_message'] });
    expect(out).toMatch(/needsConfirmation/);
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled();
  });
});
